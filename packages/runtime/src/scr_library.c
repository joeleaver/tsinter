/* Library mode support: the panic sink, the poisoned-library flag, the
 * outbound-result arena, the reset registry, and the sink-routing trap
 * funnel. Linked ONLY into library artifacts (every TU of a library archive
 * compiles with -DSCR_LIB); executable builds never contain this file —
 * their funnel expansion lives in scr_console.c and their session teardown
 * stays atexit-driven.
 *
 * The profile-NAMED symbols (init, sink registration, reset, collect) are
 * emitted in the program TU and delegate here, so this file stays
 * profile-agnostic and the program TU carries every profile-named symbol —
 * one place for the conformance symbol audit to look.
 *
 * State after a sink call: none is legal. The trap fired mid-operation with
 * no unwinding — heap, arena, and collector state are unspecified; the library
 * is POISONED. Every runtime-touching entry prologue aborts on the flag
 * (deterministic, never heap corruption); recovery is process restart. */
#include "scr_runtime.h"

#ifdef SCR_LIB

#include <stdio.h>
#include <stdlib.h>

/* ── sink registration + poison ───────────────────────────────────────── */

static ScrLibSinkFn scr_library_sink = NULL;
static void *scr_library_sink_ctx = NULL;
static bool scr_library_poisoned = false;

void scr_library_set_sink(ScrLibSinkFn fn, void *ctx) {
  /* Latest registration wins; re-registration is permitted before a trap.
   * Deliberately NOT poison-guarded: a pure store, touching no runtime
   * state — but a poisoned library's entries abort regardless of the sink. */
  scr_library_sink = fn;
  scr_library_sink_ctx = ctx;
}

/* ── the trap funnel, library expansion ───────────────────────────────────
 * Poison first (the sink may longjmp to a host frame below the entry — the
 * conforming survival pattern), then deliver exactly once, then abort:
 * before registration, or if the sink returns (the ruled host-contract
 * violation). The address is the funnel frame's return address — the trap
 * site — 0 where the toolchain cannot supply one.
 *
 * Delivery shape (the ratified structured trap-teaching encoding): a
 * message that already begins with the 0x01 marker — a facade-authored
 * structured throw riding the verbatim rule, or the wrapper's compile-
 * time-assembled SC4012 contract trap — is delivered byte-for-byte. Every
 * OTHER message is a trap the runtime DETECTED, and the funnel assembles
 * it here into 0x01 text 0x1F code 0x1F symbol [0x1F remediation]: the
 * baseline human line becomes field 0 unchanged (so plain-text hosts read
 * exactly what they always read), the code classifies the trap kind, the
 * symbol is the entry the trapping call came through (recorded by the
 * entry prologue below), and the remediation is the profile's for that
 * code when the program TU's overlay table declares one. */

#if defined(__GNUC__) || defined(__clang__)
#define SCR_TRAP_ADDR() ((uint64_t)(uintptr_t)__builtin_return_address(0))
#else
#define SCR_TRAP_ADDR() ((uint64_t)0)
#endif

/* The current-entry slot: every generated entry's prologue records its
 * external symbol before dispatching into core code. A single static slot
 * is sound — exactly one core is live per process (the one-live-core rule),
 * entries never nest, and a trap can only fire while an entry is on the
 * stack. NULL (never entered) renders as the empty symbol field. */
static const char *scr_library_entry_symbol = NULL;

/* Detected-trap classification: the runtime's trap sites self-classify
 * through their message conventions (the exact bytes the executable lane
 * prints), so the kind → code mapping keys on those prefixes. The codes are
 * the compiler registry's runtime family (diagnostics/diagnostic.ts —
 * documented beside SC4012); SC4019 is the family's residual for detected
 * traps outside the named kinds (environment failures, unsupported
 * operations, the RC audit). */
static const struct {
  const char *prefix;
  const char *code;
} scr_library_trap_kinds[] = {
  {"Uncaught ", "SC4013"},                  /* escaped exception at an entry */
  {"scriptc: RangeError: ", "SC4014"},      /* range trap */
  {"scriptc: TypeError: ", "SC4015"},       /* type trap */
  {"scriptc: SyntaxError: ", "SC4016"},     /* syntax trap (regex compile) */
  {"scriptc: out of memory", "SC4017"},     /* allocation failure */
  {"scriptc: internal error: ", "SC4018"},  /* internal invariant failure */
};

static const char *scr_library_trap_code(const char *msg, size_t len) {
  for (size_t i = 0; i < sizeof scr_library_trap_kinds / sizeof scr_library_trap_kinds[0]; i++) {
    size_t plen = strlen(scr_library_trap_kinds[i].prefix);
    if (len >= plen && memcmp(msg, scr_library_trap_kinds[i].prefix, plen) == 0) {
      return scr_library_trap_kinds[i].code;
    }
  }
  return "SC4019"; /* other detected trap */
}

#ifdef SCR_RC_AUDIT
/* #147 (delta-10): the per-entry live set's trap-path sweep and its
 * entry-prologue DROP — defined below, beside the live set's own data
 * structure; forward-declared here so the funnel and scr_library_entry
 * (which call them) can be read top-to-bottom with the arena they
 * follow. */
static void scr_library_live_sweep(void);
static void scr_library_live_drop(void);
#endif

static _Noreturn void scr_library_trap_deliver(const char *msg, size_t len, uint64_t addr) {
#ifdef SCR_RC_AUDIT
  /* #147 (delta-10, addendum FOLD 2 / R-1): a release_fn the sweep below
   * calls can itself scr_trap (an allocator OOM, directly or via a cycle
   * collection's own OOM — scr_cycle.c's scr_cyc_on_release), re-entering
   * this function mid-sweep. The guard below makes that safe: message
   * ASSEMBLY still runs BEFORE the sweep, so by the time the sweep could
   * ever trigger a nested call, the ORIGINAL trap's message is already
   * complete and captured in the statics below — the re-entrant branch
   * delivers exactly that, once, instead of corrupting an in-progress
   * assembly or losing the message entirely. GATED to SCR_RC_AUDIT: the
   * sweep is the ONLY thing that can re-enter this function (nothing else
   * in the assembly or sink-dispatch path below calls scr_trap), so a
   * non-audit build has no re-entrancy hazard to guard against and this
   * whole mechanism must not change ITS bytes (the byte-identity
   * instrument, delta-10 addendum FOLD 3 / N-2, is what caught this
   * originally being unconditional — corrected here before it landed). */
  static bool scr_library_delivering = false;
  static const uint8_t *scr_library_final_msg = NULL;
  static size_t scr_library_final_len = 0;
  if (scr_library_delivering) {
    if (scr_library_sink != NULL) {
      scr_library_sink(scr_library_sink_ctx, scr_library_final_msg, scr_library_final_len, addr);
    }
    abort();
  }
  scr_library_delivering = true;
#endif
  scr_library_poisoned = true;
  if (!(len > 0 && (uint8_t)msg[0] == 0x01)) {
    /* A detected trap: assemble the structured message. Static buffer —
     * no malloc on the failure path; text truncates before structure ever
     * would (codes and symbols are short; an oversized remediation drops
     * whole, never split). */
    static char buf[2048];
    const char *code = scr_library_trap_code(msg, len);
    const char *text = msg;
    size_t text_len = len;
    const char *rem = NULL;
    for (size_t i = 0; i < scr_library_trap_overlays_len; i++) {
      const char *const *t = &scr_library_trap_overlays[3 * i];
      if (strcmp(t[0], code) == 0) {
        if (t[1] != NULL) {
          text = t[1];
          text_len = strlen(t[1]);
        }
        rem = t[2];
        break;
      }
    }
    const char *sym = scr_library_entry_symbol != NULL ? scr_library_entry_symbol : "";
    size_t tail = 2 + strlen(code) + strlen(sym);
    if (rem != NULL) {
      if (tail + 1 + strlen(rem) > sizeof buf - 1) rem = NULL; /* drop whole, keep structure */
      else tail += 1 + strlen(rem);
    }
    size_t n = 0;
    buf[n++] = '\x01';
    size_t cap = sizeof buf - 1 - tail;
    if (text_len > cap) text_len = cap;
    for (size_t i = 0; i < text_len; i++) {
      /* The encoding reserves 0x01/0x1F; runtime messages never contain
       * them, but an escaped exception's rendered text embeds user bytes. */
      char c = text[i];
      buf[n++] = (c == '\x01' || c == '\x1f') ? ' ' : c;
    }
    buf[n++] = '\x1f';
    memcpy(buf + n, code, strlen(code));
    n += strlen(code);
    buf[n++] = '\x1f';
    memcpy(buf + n, sym, strlen(sym));
    n += strlen(sym);
    if (rem != NULL) {
      buf[n++] = '\x1f';
      memcpy(buf + n, rem, strlen(rem));
      n += strlen(rem);
    }
    msg = buf;
    len = n;
  }
#ifdef SCR_RC_AUDIT
  /* #147: capture the FINAL message before the sweep can run — msg/len are
   * this call's own parameters, invisible to a re-entrant frame, so a
   * static home is what the guard above reads. */
  scr_library_final_msg = (const uint8_t *)msg;
  scr_library_final_len = len;
  scr_library_live_sweep();
#endif
  if (scr_library_sink != NULL) {
    scr_library_sink(scr_library_sink_ctx, (const uint8_t *)msg, len, addr);
  }
  abort();
}

__attribute__((noinline)) _Noreturn void scr_trap(const char *msg) {
  scr_library_trap_deliver(msg, strlen(msg), SCR_TRAP_ADDR());
}

__attribute__((noinline)) _Noreturn void scr_trap_len(const char *msg, size_t len) {
  /* The length-delimited funnel entry: structured trap-teaching messages
   * and verbatim 0x01-led thrown messages are byte-counted, never
   * NUL-scanned (a thrown JS string may embed NUL). Same poison-deliver-
   * abort discipline as scr_trap. */
  scr_library_trap_deliver(msg, len, SCR_TRAP_ADDR());
}

__attribute__((noinline)) _Noreturn void scr_trap_fmt(const char *fmt, ...) {
  static char buf[512]; /* no malloc on the invariant-failure path */
  va_list ap;
  va_start(ap, fmt);
  int n = vsnprintf(buf, sizeof buf, fmt, ap);
  va_end(ap);
  size_t len = n < 0 ? 0 : (size_t)n >= sizeof buf ? sizeof buf - 1 : (size_t)n;
  scr_library_trap_deliver(buf, len, SCR_TRAP_ADDR());
}

/* ── entry prologues ──────────────────────────────────────────────────── */

void scr_library_entry(bool reset_arena, const char *entry_symbol) {
  /* Record the entry symbol FIRST so even a poisoned-abort's core dump
   * names the entry; a trap anywhere below (the arena reset's OOM
   * included) then reports the right symbol. */
  scr_library_entry_symbol = entry_symbol;
  /* A poisoned library's entries abort deterministically — never through the
   * sink again (it received its exactly-once message when the trap fired),
   * never into a heap whose invariants already failed. */
  if (scr_library_poisoned) abort();
  if (reset_arena) scr_library_arena_reset();
#ifdef SCR_RC_AUDIT
  /* #147 (delta-10): reaching this prologue means the PRIOR entry returned
   * normally — every reference the emitted frames held was released by
   * the compiler's own RC code — so the live set's own entries for that
   * entry are either already forgotten, or safely abandoned tracking
   * (DROP never releases; see design-147-v3.txt §(1)). Also retires any
   * STALE tracking of an outbound result that moved into the arena above
   * instead of taking a normal release ("DROP has a second job"). */
  scr_library_live_drop();
#endif
}

/* ── the outbound-result arena ────────────────────────────────────────────
 * Buffer-class results (string/bytes) MOVE in here; the host reads through
 * borrowed pointers until the arena resets (per-entry under the auto
 * posture, host-cycled when the profile declares a reset symbol; init and
 * collect always reset). */

typedef struct {
  void *v;
  bool is_str; /* ScrStr vs ScrBytes — picks the release */
} ScrCoreArenaEnt;

static ScrCoreArenaEnt *scr_library_arena = NULL;
static size_t scr_library_arena_n = 0, scr_library_arena_cap = 0;

static void scr_library_arena_keep(void *v, bool is_str) {
  if (scr_library_arena_n == scr_library_arena_cap) {
    scr_library_arena_cap = scr_library_arena_cap ? scr_library_arena_cap * 2 : 16;
    scr_library_arena = realloc(scr_library_arena, scr_library_arena_cap * sizeof *scr_library_arena);
    if (!scr_library_arena) scr_trap("scriptc: out of memory\n");
  }
  scr_library_arena[scr_library_arena_n].v = v;
  scr_library_arena[scr_library_arena_n].is_str = is_str;
  scr_library_arena_n++;
}

void scr_library_arena_reset(void) {
  for (size_t i = 0; i < scr_library_arena_n; i++) {
    if (scr_library_arena[i].is_str) scr_str_release((ScrStr *)scr_library_arena[i].v);
    else scr_bytes_release((ScrBytes *)scr_library_arena[i].v);
  }
  scr_library_arena_n = 0;
}

void scr_library_collect(void) {
  scr_library_arena_reset();
  scr_collect_cycles();
}

/* ── #147: the per-entry live set (delta-10; design-147-v3.txt + its
 * addendum) ───────────────────────────────────────────────────────────
 * A SEPARATE structure from the outbound arena above — the arena's MOVE
 * contract and its two callers (str_out/bytes_out) are untouched by this
 * board. This structure holds NO reference (no retain at insert); it
 * borrows, tracking every refcounted object a library entry constructs
 * so a trap that longjmps past the compiler's own emitted RC-release
 * code has something to release on the trapping entry's behalf.
 * Compiled ONLY under SCR_RC_AUDIT (the sanitize flavour, exactly where
 * the scr_live_* counters already live) — shipping/default library
 * builds contain none of this code (see the byte-identity instrument,
 * impl-b1/147-byteid-base.txt). */
#ifdef SCR_RC_AUDIT

typedef struct {
  void *v; /* NULL = tombstoned slot */
  void (*release)(void *);
} ScrLibLiveSlot;

typedef struct {
  void *key; /* NULL = empty, (void*)1 = tombstone */
  size_t slot; /* index into scr_library_live[] */
} ScrLibLiveHashEnt;

static ScrLibLiveSlot *scr_library_live = NULL; /* insertion order */
static size_t scr_library_live_n = 0, scr_library_live_cap = 0;
static size_t scr_library_live_tomb = 0; /* delta-11/N-2: dead (NULL) slots
                                             in scr_library_live[0..n) */
static ScrLibLiveHashEnt *scr_library_live_hash = NULL; /* open addressing */
static size_t scr_library_live_hcap = 0, scr_library_live_hlive = 0;
static bool scr_library_live_sweeping = false; /* delta-11/N-a: set only
   around scr_library_live_sweep's own walk; see the invariant comment
   beside that function and the assertion in scr_library_live_insert
   below, which together make the invariant self-enforcing rather than
   merely documented. */

#define SCR_LIB_LIVE_TOMBSTONE ((void *)1)

static size_t scr_library_live_hash_ptr(void *v, size_t cap) {
  /* Fibonacci hashing over the pointer bits — a plain multiplicative
   * spread; malloc addresses are not adversarial input here. The
   * entropy from the multiplication concentrates in the HIGH bits of
   * the 64-bit product (every high output bit depends on many input
   * bits via the carry chain; the low bits do not). delta-11/N-1
   * (rev-28, measured): same-size allocations from one allocator arena
   * differ by a constant, usually power-of-two, stride — for any
   * stride that is a multiple of 2^k, `stride * C mod 2^k == 0`
   * regardless of the odd multiplier C, so masking the LOW k bits of
   * the product (the original `& (cap - 1)` shape) sent 64 same-size
   * allocations into a table of 32 slots to ONE bucket. `cap` is
   * always a power of two (32, 64, 128, ...; scr_library_live_hash_
   * grow only ever doubles it), so __builtin_ctzll(cap) is exactly
   * log2(cap); shifting right by (64 - log2(cap)) keeps exactly the
   * top log2(cap) bits and discards the weak low ones entirely.
   * Reproduced and fixed: tools/hash-distribution-driver.c (the 64-
   * same-size-allocations shape; the old mask filled 1 of 32 buckets,
   * the new shift spreads across the table). delta-11/N-d: `cap` is
   * never 1 (scr_library_live_hash_grow's smallest value is 32, only
   * ever doubled thereafter) — what keeps `64 - __builtin_ctzll(cap)`
   * inside [1, 63] and the shift below well-defined; a cap of 1 would
   * make the shift 64, which C leaves undefined for a 64-bit operand. */
  uintptr_t p = (uintptr_t)v;
  uint64_t product = (uint64_t)p * 11400714819323198485ULL;
  int shift = 64 - __builtin_ctzll(cap);
  return (size_t)(product >> shift);
}

/* Grow the hash table (never shrinks) and re-insert every LIVE key —
 * tombstones are dropped by the rebuild, which is the usual amortised
 * way to keep a tombstone-using open-addressing table's probe sequences
 * short. */
static void scr_library_live_hash_grow(void) {
  size_t old_cap = scr_library_live_hcap;
  ScrLibLiveHashEnt *old = scr_library_live_hash;
  scr_library_live_hcap = old_cap ? old_cap * 2 : 32;
  scr_library_live_hash = calloc(scr_library_live_hcap, sizeof *scr_library_live_hash);
  if (!scr_library_live_hash) scr_trap("scriptc: out of memory\n");
  scr_library_live_hlive = 0;
  for (size_t i = 0; i < old_cap; i++) {
    if (old[i].key == NULL || old[i].key == SCR_LIB_LIVE_TOMBSTONE) continue;
    size_t mask = scr_library_live_hcap - 1;
    size_t h = scr_library_live_hash_ptr(old[i].key, scr_library_live_hcap) & mask;
    while (scr_library_live_hash[h].key != NULL) h = (h + 1) & mask;
    scr_library_live_hash[h].key = old[i].key;
    scr_library_live_hash[h].slot = old[i].slot;
    scr_library_live_hlive++;
  }
  free(old);
}

/* COMPACT: delta-11/N-2 (rev-28, measured: 400 alloc/free cycles inside
 * ONE entry — a loop building and releasing temporaries — left 400 dead
 * (NULL) slots in scr_library_live[], an unbounded-within-an-entry
 * footprint the sweep still walks past on every trap, since forget()
 * alone only tombstones the ordered slot without ever shrinking it).
 *
 * INVARIANT MAINTAINED: after a call to this function,
 * scr_library_live[0 .. scr_library_live_n) holds exactly the LIVE
 * (non-NULL) slots, contiguous from index 0, in their RELATIVE
 * insertion order; scr_library_live_tomb is 0; every hash entry's
 * `.slot` is kept in lockstep with the slot it now actually occupies —
 * fixed up IN THIS SAME PASS, so no caller (insert, forget, sweep) ever
 * observes a stale index, before or after. A hash entry whose key is not
 * found during fix-up is left alone rather than looping forever (mirrors
 * forget()'s own miss-is-safe shape); this cannot happen if the
 * insert/forget invariant already holds (every live ordered-array slot
 * has exactly one corresponding hash entry), so it is a defensive
 * no-op, not an expected path. */
static void scr_library_live_compact(void) {
  size_t write = 0;
  for (size_t i = 0; i < scr_library_live_n; i++) {
    if (scr_library_live[i].v == NULL) continue;
    if (write != i) {
      scr_library_live[write] = scr_library_live[i];
      if (scr_library_live_hcap > 0) {
        size_t mask = scr_library_live_hcap - 1;
        size_t h = scr_library_live_hash_ptr(scr_library_live[write].v, scr_library_live_hcap) & mask;
        while (scr_library_live_hash[h].key != NULL &&
               scr_library_live_hash[h].key != scr_library_live[write].v) {
          h = (h + 1) & mask;
        }
        if (scr_library_live_hash[h].key == scr_library_live[write].v) {
          scr_library_live_hash[h].slot = write;
        }
      }
    }
    write++;
  }
  scr_library_live_n = write;
  scr_library_live_tomb = 0;
}

/* INSERT: called at every construction site (nineteen — design-147-v3.txt
 * §(3)), immediately before the constructor's own successful return
 * (addendum FOLD 1 / N-1 — never at the allocation primitive: a
 * constructor that traps between allocating and finishing initialisation
 * must not leave a partially-initialised object in the set). No retain.
 * delta-11/N-2: compact FIRST when tombstones dominate (dead > live in
 * the ordered array) — the same threshold shape as the hash table's own
 * fill-ratio check just below, checked here so a long entry's dead slots
 * never accumulate past a 2x footprint before the next insert reclaims
 * them, and so a compact never wastes a grow the reclaimed space could
 * have avoided. delta-11/N-a: ASSERTS the sweep-stability invariant
 * stated beside scr_library_live_sweep — insert (and therefore compact,
 * which only insert ever calls) must never run WHILE a sweep is
 * walking scr_library_live[], or the sweep's own loop index would be
 * invalidated out from under it. This can only be reached if some
 * release_fn the sweep calls itself constructs and inserts a NEW
 * tracked object, which no release_fn in this runtime does (release
 * functions free; they do not allocate) — self-enforced here, not left
 * as a claim the code could silently stop matching. */
void scr_library_live_insert(void *v, void (*release)(void *)) {
  if (scr_library_live_sweeping) {
    scr_trap("scriptc: internal error: #147 live-set insert during sweep\n");
  }
  if (2 * scr_library_live_tomb > scr_library_live_n) {
    scr_library_live_compact();
  }
  if (scr_library_live_n == scr_library_live_cap) {
    scr_library_live_cap = scr_library_live_cap ? scr_library_live_cap * 2 : 16;
    scr_library_live = realloc(scr_library_live, scr_library_live_cap * sizeof *scr_library_live);
    if (!scr_library_live) scr_trap("scriptc: out of memory\n");
  }
  size_t slot = scr_library_live_n;
  scr_library_live[slot].v = v;
  scr_library_live[slot].release = release;
  scr_library_live_n++;

  if (scr_library_live_hcap == 0 || scr_library_live_hlive * 2 >= scr_library_live_hcap) {
    scr_library_live_hash_grow();
  }
  size_t mask = scr_library_live_hcap - 1;
  size_t h = scr_library_live_hash_ptr(v, scr_library_live_hcap) & mask;
  while (scr_library_live_hash[h].key != NULL && scr_library_live_hash[h].key != SCR_LIB_LIVE_TOMBSTONE) {
    h = (h + 1) & mask;
  }
  scr_library_live_hash[h].key = v;
  scr_library_live_hash[h].slot = slot;
  scr_library_live_hlive++;
}

/* FORGET: called at every free route (twenty-three — design-147-v3.txt
 * §(2)), immediately before the actual free (the identical hazard and
 * placement scr_str_release's own scr_sidx_purge call already guards:
 * "the address may be recycled by the next malloc"). A lookup miss is a
 * safe no-op — an object never registered (a constructor whose failure
 * path returns before INSERT, per N-1) or already forgotten. */
void scr_library_live_forget(void *v) {
  if (scr_library_live_hcap == 0) return;
  size_t mask = scr_library_live_hcap - 1;
  size_t h = scr_library_live_hash_ptr(v, scr_library_live_hcap) & mask;
  while (scr_library_live_hash[h].key != NULL) {
    if (scr_library_live_hash[h].key == v) {
      size_t slot = scr_library_live_hash[h].slot;
      scr_library_live[slot].v = NULL; /* tombstone the ordered slot first */
      scr_library_live_tomb++; /* delta-11/N-2: tracked for compaction */
      scr_library_live_hash[h].key = SCR_LIB_LIVE_TOMBSTONE;
      scr_library_live_hlive--;
      return;
    }
    h = (h + 1) & mask;
  }
}

/* DROP: the normal path, called from scr_library_entry's prologue every
 * entry. NO release calls — see design-147-v3.txt §(1)'s two-paragraph
 * argument ("DROP has a second job") for why this is sound both for
 * ordinary temporaries and for an outbound result's stale tracking. */
static void scr_library_live_drop(void) {
  scr_library_live_n = 0;
  scr_library_live_tomb = 0; /* delta-11/N-2: the ordered array is empty too */
  if (scr_library_live_hcap > 0) {
    memset(scr_library_live_hash, 0, scr_library_live_hcap * sizeof *scr_library_live_hash);
  }
  scr_library_live_hlive = 0;
}

/* SWEEP: the trap path only, called from scr_library_trap_deliver after
 * the poison and the message assembly, before the sink (design-147-v3.txt
 * §(4); the poison license in §(5) is why a hard, non-balancing free is
 * sound here and only here). For each pointer still in the set, call its
 * release_fn REPEATEDLY until FORGET removes it — self-terminating
 * (bounded by the object's own outstanding rc; every call decrements it
 * by exactly one, matching every other release call site in this
 * runtime) and correct for any outstanding count, not just one. Re-reads
 * the slot fresh each outer iteration so a container's release freeing
 * OTHER members mid-walk (including via a cycle collection firing
 * mid-sweep — its teardown calls each kind's own *_gc_free, which also
 * carries a FORGET) is tolerated whichever index direction it lands in.
 *
 * THE SWEEP-STABILITY INVARIANT (delta-11/N-a, self-enforced below, not
 * only documented): no release_fn constructs a tracked object, and
 * compaction runs only from scr_library_live_insert — so nothing that
 * can execute during this walk ever calls scr_library_live_compact(),
 * and the loop's own index `i` into scr_library_live[] stays stable
 * across every release() call, however many members a cascading release
 * frees or however many times a single slot's release() re-runs. The
 * static flag below is set for the exact duration of this function and
 * asserted false at the top of scr_library_live_insert — if that
 * assertion ever fires, some release_fn began constructing new tracked
 * objects, which would silently break the invariant this comment
 * states, and the assertion turns that into a named, diagnosable trap
 * instead of a corrupted sweep. */
static void scr_library_live_sweep(void) {
  scr_library_live_sweeping = true;
  for (size_t i = 0; i < scr_library_live_n; i++) {
    void *v = scr_library_live[i].v;
    if (v == NULL) continue;
    void (*release)(void *) = scr_library_live[i].release;
    while (scr_library_live[i].v != NULL) release(v);
  }
  scr_library_live_sweeping = false;
}

#endif /* SCR_RC_AUDIT */

/* ── marshalling helpers (both emissions call exactly these) ──────────── */

ScrStr *scr_library_str_in(const uint8_t *p, size_t len) {
  /* ptr may be NULL when len is 0 (the contract's empty-buffer form). */
  return scr_str_new(len == 0 ? "" : (const char *)p, len);
}

ScrBytes *scr_library_bytes_in(const uint8_t *p, size_t len, const char *trap_msg) {
  ScrBytes *b = scr_bytes_new(SCR_BYTES_U8, (double)len);
  if (b == NULL) {
    /* scr_bytes_new throws only for lengths past 2^53-1 — an impossible
     * host buffer; funnel the contract violation instead of a NULL deref.
     * The message is the wrapper's compiler-assembled structured
     * trap-teaching form (code SC4012, the trapping export's symbol, the
     * profile's teaching and remediation) — opaque bytes here. */
    scr_exc_clear();
    scr_trap(trap_msg);
  }
  if (len > 0 && p != NULL) memcpy(b->data, p, len);
  return b;
}

double scr_library_i64_in(int64_t v, const char *trap_msg) {
  /* The inbound declared-integer edge (ask 4): only |v| <= 2^53-1 rides
   * f64 exactly; past it, (double)v silently rounds — a coercion the
   * author never wrote, so the wrapper funnels the host-contract
   * violation instead (same story as an impossible bytes length; the
   * message is the compiler-assembled structured trap-teaching form). */
  if (v > 9007199254740991LL || v < -9007199254740991LL) scr_trap(trap_msg);
  return (double)v;
}

double scr_library_u64_in(uint64_t v, const char *trap_msg) {
  if (v > 9007199254740991ULL) scr_trap(trap_msg);
  return (double)v;
}

void scr_library_str_out(ScrStr *s, const uint8_t **out, size_t *out_len) {
  scr_library_arena_keep(s, true);
  *out = (const uint8_t *)s->data; /* NUL-terminated after len (ScrStr layout) */
  *out_len = s->len;
}

void scr_library_bytes_out(ScrBytes *b, const uint8_t **out, size_t *out_len) {
  scr_library_arena_keep(b, false);
  *out = b->data; /* elem is always u8 at the boundary (v1 bytes class) */
  *out_len = b->len;
}

/* ── the reset registry + session reset ─────────────────────────────────
 * Where an executable's always-linked units atexit() their lazy teardowns,
 * library builds register here (scr_atexit in scr_runtime.h): registered
 * once, drained on EVERY reset — re-registration guards in the units stay
 * satisfied because the entry persists. */

#define SCR_LIB_MAX_RESETS 32
static void (*scr_library_resets[SCR_LIB_MAX_RESETS])(void);
static size_t scr_library_nresets = 0;

void scr_library_register_reset(void (*fn)(void)) {
  for (size_t i = 0; i < scr_library_nresets; i++) {
    if (scr_library_resets[i] == fn) return;
  }
  if (scr_library_nresets == SCR_LIB_MAX_RESETS) {
    scr_trap("scriptc: internal error: library reset registry overflow\n");
  }
  scr_library_resets[scr_library_nresets++] = fn;
}

#ifdef SCR_RC_AUDIT
extern long scr_str_live_count(void);     /* scr_string.c */
extern long scr_arr_live_count(void);     /* scr_array.c */
extern long scr_map_live_count(void);     /* scr_map.c */
extern long scr_box_live_count(void);     /* scr_closure.c */
extern long scr_closure_live_count(void); /* scr_closure.c */
extern long scr_obj_live_count(void);     /* scr_object.c */
extern long scr_union_live_count(void);   /* scr_union.c */
extern long scr_dyn_live_count(void);     /* scr_json.c */
extern long scr_bytes_live_count(void);   /* scr_bytes.c */

/* The per-session heap-emptiness assertion (the audit flavor's determinism
 * seam): after a full reset the live counters must all read zero, or the
 * previous session leaked. A failure is a TRAP through the sink — the
 * executable audit's _Exit(99) stays exe-lane-only. */
static void scr_library_audit_zero(void) {
  long strings = scr_str_live_count(), arrays = scr_arr_live_count(),
       maps = scr_map_live_count(), boxes = scr_box_live_count(),
       closures = scr_closure_live_count(), objects = scr_obj_live_count(),
       unions = scr_union_live_count(), dyns = scr_dyn_live_count(),
       bytes = scr_bytes_live_count();
  if (strings != 0 || arrays != 0 || maps != 0 || boxes != 0 || closures != 0 ||
      objects != 0 || unions != 0 || dyns != 0 || bytes != 0) {
    scr_trap_fmt(
        "scriptc LIBRARY RC AUDIT FAILED: %ld heap string(s), %ld array(s), "
        "%ld map(s), %ld box(es), %ld closure(s), %ld object(s), "
        "%ld union(s), %ld dyn value(s), %ld bytes value(s) live across re-init\n",
        strings, arrays, maps, boxes, closures, objects, unions, dyns, bytes);
  }
}
#endif /* SCR_RC_AUDIT */

extern void scr_lib_session_cleanup(void); /* scr_lib.c: the interned process values */

void scr_library_reset(void) {
  /* Called by the generated init entry AFTER the program TU released and
   * zeroed its globals (run-once guards included) — the same order the
   * executable exit path runs: library cleanup → cycle collection → RC
   * audit. Everything here is re-runnable; the first call is a cheap
   * no-op pass. */
  scr_exc_clear();
  scr_library_arena_reset();
  for (size_t i = 0; i < scr_library_nresets; i++) scr_library_resets[i]();
  scr_lib_session_cleanup();
  scr_collect_cycles();
#ifdef SCR_RC_AUDIT
  scr_library_audit_zero();
#endif
}

#endif /* SCR_LIB */
