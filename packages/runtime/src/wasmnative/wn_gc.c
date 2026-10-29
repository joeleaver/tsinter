/* The native runner's garbage collector (native-runner phase N0).
 *
 * Non-moving mark-sweep over one virtual arena:
 *  - EXACT on the heap: an object's header names its canonical type, and
 *    the translation's type tables (w_types / w_refoffs, emitted by
 *    backend/wasm2c.ts) say which struct fields and which arrays hold
 *    references the collector must follow;
 *  - CONSERVATIVE on the C stack: the translated code keeps references in
 *    C locals, so every aligned word of the running thread's stack (and the
 *    callee-saved registers, spilled first) that points into a live object
 *    — its start, its inside, or one past its end — keeps that object;
 *  - roots also: the module's reference globals (w_gc_roots).
 * Collection happens inside an allocation once the bytes allocated since
 * the last collection pass a threshold (at least WN_GC_MIN_MB, at least the
 * live size after the last one), so a long-running program's heap stays
 * bounded by its live data, not by everything it ever allocated.
 *
 * Layout: the arena is 64 KiB blocks. A small object (<= 8 KiB) lives in a
 * block of one size class, with an allocation and a mark bitmap per block;
 * a large object owns a span of whole blocks. Free small slots thread a
 * free list; a block with nothing live goes back to the block pool, and the
 * pool's runs are coalesced after every sweep.
 *
 * Environment (diagnostics): WN_GC_STRESS=n collects every n allocations;
 * WN_GC_MIN_MB=n sets the minimum allocation between collections (default
 * 64); WN_GC_STATS=1 prints the collector's totals, and its pauses (timed
 * only then), to stderr at exit. */
#define _GNU_SOURCE
#include "wn_rt.h"

#include <stdio.h>
#include <stdlib.h>
#include <sys/mman.h>
#include <time.h>
#include <unistd.h>

#define BLK_SHIFT 16
#define BLK ((size_t)1 << BLK_SHIFT)
#define ARENA_BYTES ((size_t)64 << 30)
#define NBLK (ARENA_BYTES >> BLK_SHIFT)
#define MAX_SMALL 8192
#define WN_GC_MIN_DEFAULT ((size_t)64 << 20)

enum { K_FREE = 0, K_SMALL = 1, K_LARGE = 2, K_TAIL = 3 };

static const uint32_t SIZES[] = {16,   32,   48,   64,   80,   96,   112,  128,  160,  192,  224,  256,  320,  384,  448,  512,
                                 640,  768,  896,  1024, 1280, 1536, 1792, 2048, 2560, 3072, 3584, 4096, 5120, 6144, 7168, 8192};
#define NSC ((int)(sizeof SIZES / sizeof SIZES[0]))
static uint8_t sc_of[MAX_SMALL / 16 + 1];
/* a slot's index without a division: with R = floor(2^32 / s) + 1 for a
 * size class s, (off * R) >> 32 == floor(off / s) for every offset in a
 * 64 KiB block. R = 2^32/s + d with 0 < d <= 1, so off*R/2^32 = off/s + e
 * with 0 <= e = off*d/2^32 < 2^-16; off/s is an integer or at least 1/s >=
 * 2^-13 below the next one, so adding e never reaches it. (Also checked
 * exhaustively: all 32 classes, every offset below 65,536.) */
static uint64_t RECIP[NSC];
static inline uint32_t slot_of(uint32_t off, int c) { return (uint32_t)(((uint64_t)off * RECIP[c]) >> 32); }

static uint8_t *arena;
static size_t top; /* blocks handed out by the bump so far */
static uint8_t *bkind;
static uint8_t *bsc;
static uint8_t *bmark;   /* large objects' mark */
static uint8_t *bclean;  /* the block's pages are known zero (fresh, or given back) */
static uint32_t *bspan;  /* large head: blocks in the span; tail: its head */
static uint64_t **bbits; /* small: alloc bits, then mark bits */
static uint32_t *bnext;  /* per-class list of blocks with free slots */
static uint32_t avail[NSC];
static void *freelist[NSC];

/* the pool: runs of free blocks, rebuilt after each sweep */
typedef struct {
  uint32_t start, len;
} Run;
static Run *runs;
static size_t nruns, capruns;

static size_t gc_min = WN_GC_MIN_DEFAULT;
static size_t since, threshold = WN_GC_MIN_DEFAULT, live_bytes;
static size_t stress, stress_n;
static size_t stat_gcs, stat_alloc_bytes, stat_max_live, stat_small, stat_large, stat_large_req;
static int stat_on;
static double stat_pause_total, stat_pause_max; /* ms, timed only under WN_GC_STATS */

static uint8_t *stack_top;

void w_gc_set_stack_top(void *top_) { stack_top = (uint8_t *)top_; }

static _Noreturn void gc_oom(void) {
  static const char m[] = "native runner: out of memory\n";
  (void)!write(2, m, sizeof m - 1);
  w_trap(W_TRAP_OOM);
}

static void *reserve(size_t n) {
  void *p = mmap(NULL, n, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS | MAP_NORESERVE, -1, 0);
  if (p == MAP_FAILED) gc_oom();
  return p;
}

static void stats(void) {
  fprintf(stderr, "wn_gc: %zu collections, %zu bytes allocated (%zu small objects, %zu large: %zu bytes asked), max live %zu, heap blocks %zu, pause total %.3f ms, max %.3f ms\n", stat_gcs,
          stat_alloc_bytes, stat_small, stat_large, stat_large_req, stat_max_live, top, stat_pause_total, stat_pause_max);
}

static void gc_init(void) {
  arena = reserve(ARENA_BYTES);
  bkind = reserve(NBLK);
  bsc = reserve(NBLK);
  bmark = reserve(NBLK);
  bclean = reserve(NBLK);
  bspan = reserve(NBLK * sizeof(uint32_t));
  bbits = reserve(NBLK * sizeof(uint64_t *));
  bnext = reserve(NBLK * sizeof(uint32_t));
  for (int c = 0; c < NSC; c++) avail[c] = UINT32_MAX;
  for (int k = 0; k < NSC; k++) RECIP[k] = ((uint64_t)1 << 32) / SIZES[k] + 1;
  int c = 0;
  for (size_t s = 0; s <= MAX_SMALL / 16; s++) {
    while (SIZES[c] < s * 16) c++;
    sc_of[s] = (uint8_t)c;
  }
  const char *e = getenv("WN_GC_MIN_MB");
  if (e && *e) threshold = gc_min = (size_t)strtoull(e, NULL, 10) << 20;
  e = getenv("WN_GC_STRESS");
  if (e && *e) stress = (size_t)strtoull(e, NULL, 10);
  e = getenv("WN_GC_STATS");
  if (e && *e == '1') {
    stat_on = 1;
    atexit(stats);
  }
}

static inline uint32_t nslots(int c) { return (uint32_t)(BLK / SIZES[c]); }
static inline uint32_t nwords(int c) { return (nslots(c) + 63) / 64; }

/* n contiguous free blocks: first fit from the pool, else the bump */
static uint32_t take_blocks(uint32_t n, int *fresh) {
  for (size_t i = 0; i < nruns; i++) {
    if (runs[i].len >= n) {
      uint32_t b = runs[i].start;
      runs[i].start += n;
      runs[i].len -= n;
      *fresh = 0;
      return b;
    }
  }
  if (top + n > NBLK) gc_oom();
  uint32_t b = (uint32_t)top;
  top += n;
  memset(bclean + b, 1, n);
  *fresh = 1;
  return b;
}

static void collect(void);

static void new_small_block(int c) {
  int fresh;
  uint32_t b = take_blocks(1, &fresh);
  bkind[b] = K_SMALL;
  bsc[b] = (uint8_t)c;
  bclean[b] = 0;
  if (bbits[b] == NULL) {
    bbits[b] = calloc(2 * 64, sizeof(uint64_t)); /* 4096 slots at most: 64 words each */
    if (bbits[b] == NULL) gc_oom();
  } else
    memset(bbits[b], 0, 2 * 64 * sizeof(uint64_t));
  /* thread every slot onto the free list */
  uint8_t *base = arena + ((size_t)b << BLK_SHIFT);
  uint32_t n = nslots(c), sz = SIZES[c];
  void *head = freelist[c];
  for (uint32_t i = n; i-- > 0;) {
    void **slot = (void **)(void *)(base + (size_t)i * sz);
    *slot = head;
    head = slot;
  }
  freelist[c] = head;
}

/* a block from the class's list of swept blocks with free slots */
static int refill_from_avail(int c) {
  while (avail[c] != UINT32_MAX) {
    uint32_t b = avail[c];
    avail[c] = bnext[b];
    if (bkind[b] != K_SMALL || bsc[b] != c) continue;
    uint64_t *alloc = bbits[b];
    uint8_t *base = arena + ((size_t)b << BLK_SHIFT);
    uint32_t n = nslots(c), sz = SIZES[c];
    void *head = freelist[c];
    for (uint32_t i = n; i-- > 0;) {
      if (alloc[i >> 6] & ((uint64_t)1 << (i & 63))) continue;
      void **slot = (void **)(void *)(base + (size_t)i * sz);
      *slot = head;
      head = slot;
    }
    freelist[c] = head;
    if (head != NULL) return 1;
  }
  return 0;
}

static WObj *alloc_small(size_t bytes) {
  int c = sc_of[(bytes + 15) >> 4];
  void *p = freelist[c];
  if (W_UNLIKELY(p == NULL)) {
    if (!refill_from_avail(c)) new_small_block(c);
    p = freelist[c];
  }
  freelist[c] = *(void **)p;
  uint32_t sz = SIZES[c];
  memset(p, 0, sz);
  size_t b = ((uint8_t *)p - arena) >> BLK_SHIFT;
  uint32_t i = slot_of((uint32_t)((uint8_t *)p - arena - (b << BLK_SHIFT)), c);
  bbits[b][i >> 6] |= (uint64_t)1 << (i & 63);
  since += sz;
  stat_alloc_bytes += sz;
  stat_small++;
  return (WObj *)p;
}

static WObj *alloc_large(size_t bytes) {
  uint32_t n = (uint32_t)((bytes + BLK - 1) >> BLK_SHIFT);
  int fresh;
  uint32_t b = take_blocks(n, &fresh);
  bkind[b] = K_LARGE;
  bmark[b] = 0;
  bspan[b] = n;
  for (uint32_t k = 1; k < n; k++) {
    bkind[b + k] = K_TAIL;
    bspan[b + k] = b;
  }
  uint8_t *p = arena + ((size_t)b << BLK_SHIFT);
  /* zero what is not known zero: a block given back to the OS reads as
   * zero pages, so a big array whose tail the program never touches costs
   * no memory traffic at all */
  for (uint32_t k = 0; k < n; k++) {
    if (!bclean[b + k]) {
      size_t off = (size_t)k << BLK_SHIFT;
      memset(p + off, 0, bytes - off < BLK ? bytes - off : BLK);
    }
    bclean[b + k] = 0;
  }
  (void)fresh;
  since += bytes;
  stat_alloc_bytes += bytes;
  stat_large++;
  stat_large_req += bytes;
  return (WObj *)p;
}

WObj *w_gc_alloc(size_t bytes) {
  if (W_UNLIKELY(arena == NULL)) gc_init();
  if (W_UNLIKELY(since >= threshold) || (stress && ++stress_n % stress == 0)) collect();
  if (bytes < 8) bytes = 8;
  return bytes <= MAX_SMALL ? alloc_small(bytes) : alloc_large(bytes);
}

/* ── marking ─────────────────────────────────────────────────────────── */

static WObj **mstack;
static size_t msp, mcap;

static inline void push(WObj *o) {
  if (W_UNLIKELY(msp == mcap)) {
    mcap = mcap ? mcap * 2 : 4096;
    mstack = realloc(mstack, mcap * sizeof *mstack);
    if (mstack == NULL) gc_oom();
  }
  mstack[msp++] = o;
}

static inline int has_refs(WObj *o) {
  const WType *t = &w_types[W_TID(o)];
  return t->kind == 1 ? t->nrefs != 0 : (t->elemRef && W_LEN(o) != 0);
}

/* the object containing address a (or NULL), marked; pushed when it holds
 * references */
static void mark_addr(uintptr_t a) {
  if (a < (uintptr_t)arena || a >= (uintptr_t)arena + (top << BLK_SHIFT)) return;
  size_t b = (a - (uintptr_t)arena) >> BLK_SHIFT;
  uint8_t k = bkind[b];
  if (k == K_SMALL) {
    int c = bsc[b];
    uint32_t sz = SIZES[c];
    uintptr_t base = (uintptr_t)arena + (b << BLK_SHIFT);
    uint32_t i = slot_of((uint32_t)(a - base), c);
    if (i >= nslots(c)) return;
    uint64_t bit = (uint64_t)1 << (i & 63);
    uint64_t *alloc = bbits[b], *mark = alloc + 64;
    if (!(alloc[i >> 6] & bit) || (mark[i >> 6] & bit)) return;
    mark[i >> 6] |= bit;
    WObj *o = (WObj *)(base + (size_t)i * sz);
    live_bytes += sz;
    if (has_refs(o)) push(o);
    return;
  }
  if (k == K_TAIL) b = bspan[b];
  else if (k != K_LARGE) return;
  if (bmark[b]) return;
  bmark[b] = 1;
  WObj *o = (WObj *)(arena + (b << BLK_SHIFT));
  live_bytes += (size_t)bspan[b] << BLK_SHIFT;
  if (has_refs(o)) push(o);
}

static void drain(void) {
  while (msp > 0) {
    WObj *o = mstack[--msp];
    const WType *t = &w_types[W_TID(o)];
    if (t->kind == 1) {
      for (uint32_t k = 0; k < t->nrefs; k++) {
        WObj *c = W_FLD(o, WObj *, w_refoffs[t->refs + k]);
        if (c) mark_addr((uintptr_t)c);
      }
    } else {
      WObj **e = W_EL(o, WObj *);
      for (uint32_t k = 0, n = W_LEN(o); k < n; k++)
        if (e[k]) mark_addr((uintptr_t)e[k]);
    }
  }
}

__attribute__((noinline)) static void scan_stack(void) {
  volatile uintptr_t here = 0;
  uintptr_t lo = (uintptr_t)&here & ~(uintptr_t)7;
  uintptr_t hi = (uintptr_t)stack_top;
  for (uintptr_t p = lo; p + sizeof(uintptr_t) <= hi; p += sizeof(uintptr_t)) {
    uintptr_t w = *(volatile uintptr_t *)p;
    if (w >= (uintptr_t)arena && w <= (uintptr_t)arena + (top << BLK_SHIFT)) {
      mark_addr(w);
      mark_addr(w - 1); /* one past the end of an object keeps it too */
    }
  }
}

/* ── sweeping ────────────────────────────────────────────────────────── */

static void sweep(void) {
  for (int c = 0; c < NSC; c++) {
    freelist[c] = NULL;
    avail[c] = UINT32_MAX;
  }
  for (size_t b = 0; b < top; b++) {
    uint8_t k = bkind[b];
    if (k == K_SMALL) {
      int c = bsc[b];
      uint64_t *alloc = bbits[b], *mark = alloc + 64;
      uint32_t nw = nwords(c), live = 0;
      for (uint32_t w = 0; w < nw; w++) {
        alloc[w] = mark[w];
        live |= mark[w] != 0;
        mark[w] = 0;
      }
      if (!live) bkind[b] = K_FREE;
      else {
        bnext[b] = avail[c];
        avail[c] = (uint32_t)b;
      }
    } else if (k == K_LARGE) {
      if (bmark[b]) bmark[b] = 0;
      else {
        uint32_t n = bspan[b];
        for (uint32_t q = 0; q < n; q++) bkind[b + q] = K_FREE;
        /* give the pages back: they come back as zero pages */
        madvise(arena + (b << BLK_SHIFT), (size_t)n << BLK_SHIFT, MADV_DONTNEED);
        memset(bclean + b, 1, n);
        b += n - 1;
      }
    }
  }
  /* rebuild the pool's runs */
  nruns = 0;
  for (size_t b = 0; b < top;) {
    if (bkind[b] != K_FREE) {
      b++;
      continue;
    }
    size_t s = b;
    while (b < top && bkind[b] == K_FREE) b++;
    if (nruns == capruns) {
      capruns = capruns ? capruns * 2 : 64;
      runs = realloc(runs, capruns * sizeof *runs);
      if (runs == NULL) gc_oom();
    }
    runs[nruns++] = (Run){(uint32_t)s, (uint32_t)(b - s)};
  }
}

__attribute__((noinline)) static void collect_inner(void) {
  if (stack_top == NULL) {
    /* a collection that cannot see the stack would free live objects */
    static const char m[] = "native runner: collector has no stack bounds\n";
    (void)!write(2, m, sizeof m - 1);
    abort();
  }
  live_bytes = 0;
  for (uint32_t k = 0; k < w_gc_nroots; k++) {
    WObj *o = *w_gc_roots[k];
    if (o) mark_addr((uintptr_t)o);
  }
  drain();
  scan_stack();
  drain();
  sweep();
  stat_gcs++;
  if (live_bytes > stat_max_live) stat_max_live = live_bytes;
  since = 0;
  threshold = live_bytes > gc_min ? live_bytes : gc_min;
}

__attribute__((noinline)) static void collect(void) {
  /* spill every callee-saved register into this frame, so the stack scan
   * sees references the translated code holds only in registers */
  __builtin_unwind_init();
  struct timespec a, b;
  if (stat_on) clock_gettime(CLOCK_MONOTONIC, &a);
  collect_inner();
  if (stat_on) {
    clock_gettime(CLOCK_MONOTONIC, &b);
    double ms = (double)(b.tv_sec - a.tv_sec) * 1e3 + (double)(b.tv_nsec - a.tv_nsec) / 1e6;
    stat_pause_total += ms;
    if (ms > stat_pause_max) stat_pause_max = ms;
  }
}
