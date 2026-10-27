/* The native runner's event core (native-runner phase N1): abi.ts's
 * `evPoll` queue, the host's wait between `_loop` calls, and three of the
 * event sources — `sigCall` (signal subscriptions), `watchCall` (fs.watch
 * over inotify) and `stdinCall` (fd 0's reads). The child, net, TLS and
 * fetch units (wn_cp.c, wn_net.c, wn_tls.c, wn_fetch.c) queue their events
 * here and register their descriptors with the same poller.
 *
 * THE LOOP. wn_main.c runs abi.ts's host side of the event-module contract
 * on a REAL clock: `due = _loop(now)`; while due >= 0 the host waits —
 * epoll_wait with a timeout to `due` (none when due is +Infinity; zero when
 * an event is already queued) — handles what became ready (reading,
 * reaping, accepting: each source turns its OS facts into records), and
 * calls `_loop` again. One epoll round is one host loop iteration: the net
 * events it observed form one module poll phase (abi.ts evPoll: "ONE HOST
 * ITERATION, ONE POLL PHASE"); a later round's net events wait for the
 * module's next one. The host never spins: a wait with nothing to deliver
 * and no deadline blocks in epoll_wait, and a wait no source can end (the
 * module answered +Infinity with nothing open) is the runner's loud error.
 *
 * Every Node behaviour stays in the module; what is here is libuv's level
 * — uv_signal_start/stop, uv_fs_event_start/stop (libuv's inotify mask and
 * its event mapping, transcribed), uv_read_start/stop on fd 0. */
#define _GNU_SOURCE
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <math.h>
#include <pthread.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/epoll.h>
#include <sys/eventfd.h>
#include <sys/inotify.h>
#include <sys/stat.h>
#include <unistd.h>

#include "wn_host.h"

_Noreturn void wn_host_fail(const char *what) {
  fprintf(stderr, "native runner: %s\n", what);
  exit(70);
}

/* ── buffers and runs ─────────────────────────────────────────────────── */
void wn_buf_put(WnBuf *b, const void *s, size_t n) {
  if (b->n + n > b->cap) {
    size_t c = b->cap ? b->cap : 256;
    while (c < b->n + n) c *= 2;
    b->p = realloc(b->p, c);
    if (!b->p) abort();
    b->cap = c;
  }
  if (n) memcpy(b->p + b->n, s, n);
  b->n += n;
}
void wn_buf_u32(WnBuf *b, uint32_t v) { wn_buf_put(b, &v, 4); }
static void buf_pad4(WnBuf *b) {
  static const uint8_t z[4];
  if (b->n & 3) wn_buf_put(b, z, 4 - (b->n & 3));
}
void wn_buf_run16(WnBuf *b, const uint16_t *u, size_t n) {
  wn_buf_u32(b, (uint32_t)n);
  wn_buf_put(b, u, n * 2);
  buf_pad4(b);
}
void wn_buf_run8(WnBuf *b, const char *s, size_t n) {
  size_t len = wn_utf8_to_16((const uint8_t *)s, n, NULL);
  uint16_t *u = malloc(len * 2 + 2);
  if (!u) abort();
  wn_utf8_to_16((const uint8_t *)s, n, u);
  wn_buf_run16(b, u, len);
  free(u);
}
void wn_buf_blob(WnBuf *b, const void *p, size_t n) {
  wn_buf_u32(b, (uint32_t)n);
  wn_buf_put(b, p, n);
  buf_pad4(b);
}
void wn_buf_free(WnBuf *b) {
  free(b->p);
  b->p = NULL;
  b->n = b->cap = 0;
}
char *wn_read_run(uint32_t *off, size_t *outlen) {
  uint32_t n = wn_rd32(*off);
  char *s = wn_utf16_to_8(*off + 4, n, outlen);
  *off += 4 + ((2 * n + 3) & ~3u);
  return s;
}

/* ── the queue ────────────────────────────────────────────────────────── */
static WnEv *q_head, *q_tail;
static uint64_t host_gen;       /* the host iteration a net event was seen in */
static int64_t poll_gen = -1;   /* the iteration this poll phase admits */
static int net_this_round;

WnEv *wn_ev_new(uint32_t source, uint32_t handle, uint32_t kind, int32_t a, int32_t b, const void *p, uint32_t n) {
  WnEv *e = malloc(sizeof *e + n);
  if (!e) abort();
  e->next = NULL;
  e->source = source;
  e->handle = handle;
  e->kind = kind;
  e->a = a;
  e->b = b;
  e->gen = 0;
  e->len = n;
  if (n) memcpy(e->data, p, n);
  return e;
}

static WnEv *scope_last;
static int scope_open;
static void scope_mark(WnEv *e) {
  if (!scope_open || e->source != WN_SRC_CHILD) return;
  uint32_t k = e->kind & 0xff;
  if (k != 1 && k != 4 && k != 5 && k != 6) return;
  if (scope_last) scope_last->kind |= 0x100;
  scope_last = e;
}
void wn_ev_scope_begin(void) {
  scope_open = 1;
  scope_last = NULL;
}
void wn_ev_scope_end(void) {
  scope_open = 0;
  scope_last = NULL;
}

static void q_append(WnEv *e) {
  e->next = NULL;
  if (q_tail) q_tail->next = e;
  else q_head = e;
  q_tail = e;
}
void wn_ev_push(WnEv *e) {
  if (e->source == WN_SRC_NET) {
    e->gen = host_gen;
    net_this_round = 1;
  }
  scope_mark(e);
  q_append(e);
}
void wn_ev_requeue_next(WnEv *e) {
  scope_mark(e);
  e->gen = host_gen + 1;
  q_append(e);
}
/* staged: data (one host tick drain's emissions), late (the 'end's that
 * drain queues behind them), solo (I/O-callback events, each its own
 * scope) */
static WnEv *st_list[3], *st_tails[3];
static void st_put(int k, WnEv *e) {
  e->next = NULL;
  if (st_tails[k]) st_tails[k]->next = e;
  else st_list[k] = e;
  st_tails[k] = e;
}
void wn_ev_stage(WnEv *e) { st_put(0, e); }
void wn_ev_stage_late(WnEv *e) { st_put(1, e); }
void wn_ev_stage_solo(WnEv *e) { st_put(2, e); }
static void unstage(void) {
  for (int k = 0; k < 3; k++) {
    if (k == 0) wn_ev_scope_begin();
    if (k == 2) wn_ev_scope_end();
    while (st_list[k]) {
      WnEv *e = st_list[k];
      st_list[k] = e->next;
      if (e->source == WN_SRC_NET) e->gen = host_gen;
      scope_mark(e);
      q_append(e);
    }
    st_tails[k] = NULL;
  }
}
static void q_fix_tail(void) {
  q_tail = q_head;
  while (q_tail && q_tail->next) q_tail = q_tail->next;
}
void wn_ev_purge(WnEvPred pred, void *ctx) {
  WnEv **pp = &q_head;
  while (*pp) {
    if (pred(*pp, ctx)) {
      WnEv *d = *pp;
      *pp = d->next;
      free(d);
    } else
      pp = &(*pp)->next;
  }
  q_fix_tail();
  for (int k = 0; k < 3; k++) {
    pp = &st_list[k];
    while (*pp) {
      if (pred(*pp, ctx)) {
        WnEv *d = *pp;
        *pp = d->next;
        free(d);
      } else
        pp = &(*pp)->next;
    }
    st_tails[k] = st_list[k];
    while (st_tails[k] && st_tails[k]->next) st_tails[k] = st_tails[k]->next;
  }
}

WnEv *wn_ev_take(WnEvPred pred, void *ctx) {
  WnEv *out = NULL, **ot = &out;
  WnEv **pp = &q_head;
  while (*pp) {
    if (pred(*pp, ctx)) {
      WnEv *d = *pp;
      *pp = d->next;
      d->next = NULL;
      *ot = d;
      ot = &d->next;
    } else
      pp = &(*pp)->next;
  }
  q_fix_tail();
  return out;
}

void wn_ev_begin_poll(void) {
  poll_gen = -1;
  for (WnEv *e = q_head; e; e = e->next)
    if (e->source == WN_SRC_NET) {
      poll_gen = (int64_t)e->gen;
      break;
    }
}

/* the units' delivery hooks: a record the module has read (a lookup's
 * answer ends the lookup; a child's last record ends its life) */
void (*wn_cp_delivered)(const WnEv *e);
void (*wn_net_delivered)(const WnEv *e);
void (*wn_fetch_delivered)(const WnEv *e);

/* abi.ts evPoll: the oldest queued event at ptr, its length; 0 when the
 * queue is empty (or its head belongs to a later host iteration); -(the
 * length needed) when cap is short, the event kept */
int32_t host_evPoll(int32_t ptr, int32_t cap) {
  WnEv *e = q_head;
  if (!e) return 0;
  if (e->source == WN_SRC_NET && (int64_t)e->gen > poll_gen) return 0;
  uint32_t need = 24 + e->len;
  if ((uint32_t)cap < need) return -(int32_t)need;
  uint32_t p = (uint32_t)ptr;
  wn_wr32(p, e->source);
  wn_wr32(p + 4, e->handle);
  wn_wr32(p + 8, e->kind);
  wn_wr32(p + 12, e->len);
  wn_wr32(p + 16, (uint32_t)e->a);
  wn_wr32(p + 20, (uint32_t)e->b);
  if (e->len) memcpy(w_hostmem + p + 24, e->data, e->len);
  q_head = e->next;
  if (!q_head) q_tail = NULL;
  if (e->source == WN_SRC_CHILD && wn_cp_delivered) wn_cp_delivered(e);
  else if (e->source == WN_SRC_NET && wn_net_delivered) wn_net_delivered(e);
  else if (e->source == WN_SRC_FETCH && wn_fetch_delivered) wn_fetch_delivered(e);
  free(e);
  return (int32_t)need;
}

/* ── the poller ───────────────────────────────────────────────────────── */
static int ep = -1;
static int sig_pipe[2];
static int ino_fd;
static int n_live; /* registered descriptors and holds: what can end a wait */
static int n_always;

static void ep_init(void) {
  if (ep >= 0) return;
  ep = epoll_create1(EPOLL_CLOEXEC);
  if (ep < 0) wn_host_fail("cannot create the event poller");
}

void wn_io_init(WnIo *io, int fd, WnIoFn cb, void *ctx) {
  memset(io, 0, sizeof *io);
  io->fd = fd;
  io->cb = cb;
  io->ctx = ctx;
}

/* the host's own descriptors (the signal pipe, inotify, the post queue)
 * never hold a wait open by themselves */
static WnIo *internal_ios[4];
static int is_internal(WnIo *io) {
  for (int i = 0; i < 4; i++)
    if (internal_ios[i] == io) return 1;
  return 0;
}

/* libuv's watcher queue: a descriptor's new interest reaches epoll at the
 * top of the NEXT poll, in the order it was asked for (uv__io_start only
 * queues; uv__io_poll applies the queue). The order is observable: a
 * descriptor that became ready before it was registered is reported
 * after one that was already registered (a client's connect completion
 * after the server's accept of it, as under Node). Removing an interest
 * takes effect at once (no event is delivered for it after). */
static WnIo **pend;
static int n_pend, cap_pend;

void wn_io_want(WnIo *io, uint32_t events) {
  ep_init();
  if (io->always) {
    int was = io->events != 0;
    io->events = events;
    if (was && !events) n_always--, n_live--;
    if (!was && events) n_always++, n_live++;
    return;
  }
  if (events == 0) {
    if (io->events != 0 && !is_internal(io)) n_live--;
    if (io->reg) epoll_ctl(ep, EPOLL_CTL_DEL, io->fd, NULL);
    io->reg = 0;
    io->events = 0;
    return;
  }
  if (io->events == 0 && !is_internal(io)) n_live++;
  if (events == io->events && io->reg && !io->pending) return;
  io->events = events;
  if (!io->pending) {
    if (n_pend == cap_pend) {
      cap_pend = cap_pend ? cap_pend * 2 : 32;
      pend = realloc(pend, sizeof *pend * (size_t)cap_pend);
      if (!pend) abort();
    }
    pend[n_pend++] = io;
    io->pending = 1;
  }
}

static void apply_pending(void) {
  for (int i = 0; i < n_pend; i++) {
    WnIo *io = pend[i];
    if (!io->pending) continue; /* closed since */
    io->pending = 0;
    if (io->events == 0 || io->always) continue;
    struct epoll_event ev = {.events = io->events, .data.ptr = io};
    if (io->reg) {
      if (epoll_ctl(ep, EPOLL_CTL_MOD, io->fd, &ev) != 0) wn_host_fail("epoll_ctl(MOD) failed");
    } else if (epoll_ctl(ep, EPOLL_CTL_ADD, io->fd, &ev) != 0) {
      if (errno != EPERM) wn_host_fail("epoll_ctl(ADD) failed");
      /* a regular file (or /dev/null): epoll cannot watch it; it is
       * always ready, as libuv treats it */
      io->always = 1;
      n_always++;
    } else
      io->reg = 1;
  }
  n_pend = 0;
}

void wn_io_close(WnIo *io) {
  wn_io_want(io, 0);
  if (io->pending) {
    /* drop it from the queue: the WnIo may be freed with its owner */
    for (int i = 0; i < n_pend; i++)
      if (pend[i] == io) pend[i] = pend[--n_pend], i--;
    io->pending = 0;
  }
  if (io->fd >= 0) close(io->fd);
  io->fd = -1;
}

/* ── posts from host threads ──────────────────────────────────────────── */
typedef struct Post {
  struct Post *next;
  void (*fn)(void *);
  void *ctx;
} Post;
static pthread_mutex_t post_mu = PTHREAD_MUTEX_INITIALIZER;
static Post *post_head, *post_tail;
static int post_fd = -1;
static WnIo post_io;
static int n_hold;

static void post_ready(WnIo *io, uint32_t evs) {
  (void)evs;
  uint64_t v;
  (void)!read(io->fd, &v, sizeof v);
  pthread_mutex_lock(&post_mu);
  Post *p = post_head;
  post_head = post_tail = NULL;
  pthread_mutex_unlock(&post_mu);
  while (p) {
    Post *n = p->next;
    p->fn(p->ctx);
    free(p);
    p = n;
  }
}
static void post_init(void) {
  if (post_fd >= 0) return;
  post_fd = eventfd(0, EFD_CLOEXEC | EFD_NONBLOCK);
  if (post_fd < 0) wn_host_fail("cannot create the host's wake descriptor");
  wn_io_init(&post_io, post_fd, post_ready, NULL);
  internal_ios[0] = &post_io;
  wn_io_want(&post_io, EPOLLIN);
}
void wn_ev_post(void (*fn)(void *), void *ctx) {
  Post *p = malloc(sizeof *p);
  if (!p) abort();
  p->next = NULL;
  p->fn = fn;
  p->ctx = ctx;
  pthread_mutex_lock(&post_mu);
  if (post_tail) post_tail->next = p;
  else post_head = p;
  post_tail = p;
  pthread_mutex_unlock(&post_mu);
  uint64_t one = 1;
  (void)!write(post_fd, &one, sizeof one);
}
void wn_ev_hold(int delta) {
  post_init();
  n_hold += delta;
  n_live += delta;
}

static void stdin_round(void);
static void sig_init(void);
void wn_ev_init(void) {
  ep_init();
  post_init();
  sig_init();
}
int wn_reserve_fd = -1; /* the net unit's EMFILE reserve (wn_net.c) */

/* WN_FD_AUDIT: the descriptors open at the program's normal end, beyond
 * 0-2 and the host's own (the poller, the wake descriptor, the signal
 * pipe, inotify), and what is still registered — on stderr, one line */
void wn_ev_audit(void) {
  int extra = 0;
  DIR *d = opendir("/proc/self/fd");
  if (d) {
    struct dirent *e;
    int dfd = dirfd(d);
    while ((e = readdir(d)) != NULL) {
      if (e->d_name[0] == '.') continue;
      int fd = atoi(e->d_name);
      if (fd <= 2 || fd == wn_reserve_fd || fd == dfd || fd == ep || fd == post_fd || fd == sig_pipe[0] || fd == sig_pipe[1] || fd == ino_fd) continue;
      extra++;
    }
    closedir(d);
  }
  char line[160];
  int n = snprintf(line, sizeof line, "wn-audit: fds %d live %d queued %d\n", extra, n_live, q_head != NULL);
  (void)!write(2, line, (size_t)n);
}

/* ── the wait ─────────────────────────────────────────────────────────── */
void wn_ev_wait(double due) {
  ep_init();
  unstage();
  net_this_round = 0;
  for (;;) {
    apply_pending();
    int timeout;
    if (q_head || n_always > 0) timeout = 0;
    else if (isinf(due)) {
      if (n_live <= 0) wn_host_fail("the module waits for an event no source can deliver");
      timeout = -1;
    } else {
      double d = due - host_now();
      timeout = d <= 0 ? 0 : d > 2e9 ? 2000000000 : (int)ceil(d);
    }
    struct epoll_event evs[64];
    int n = epoll_wait(ep, evs, 64, timeout);
    if (n < 0) {
      if (errno == EINTR) continue; /* a signal: its pipe is readable now */
      wn_host_fail("epoll_wait failed");
    }
    /* libuv's uv__io_poll runs the signal watcher after every other
     * descriptor of the round: a signal, and a child's exit (SIGCHLD
     * there; a pidfd here), come after the reads that arrived with it */
    for (int pass = 0; pass < 2; pass++)
      for (int i = 0; i < n; i++) {
        WnIo *io = evs[i].data.ptr;
        if (io->last != pass) continue;
        if (io->reg && io->events) io->cb(io, evs[i].events);
      }
    /* a descriptor epoll cannot watch (fd 0 a regular file): one read
     * per round */
    stdin_round();
    break;
  }
  if (net_this_round) host_gen++;
}

/* ── signals (abi.ts sigCall; libuv's uv_signal_start / stop) ─────────── */
static int sig_pipe[2] = {-1, -1};
static WnIo sig_io;
typedef struct {
  int signum;
  int live;
} SigSub;
static SigSub *subs;
static int n_subs;
static struct sigaction sig_old[65];
static int sig_count[65];

static void on_signal(int s) {
  int e = errno;
  uint8_t b = (uint8_t)s;
  (void)!write(sig_pipe[1], &b, 1);
  errno = e;
}
static void sig_ready(WnIo *io, uint32_t evs) {
  (void)evs;
  uint8_t buf[256];
  for (;;) {
    ssize_t r = read(io->fd, buf, sizeof buf);
    if (r <= 0) break;
    for (ssize_t i = 0; i < r; i++)
      for (int h = 0; h < n_subs; h++)
        if (subs[h].live && subs[h].signum == buf[i]) wn_ev_push(wn_ev_new(WN_SRC_SIG, (uint32_t)h + 1, 1, buf[i], 0, NULL, 0));
  }
}
static void sig_init(void) {
  if (sig_pipe[0] >= 0) return;
  if (pipe2(sig_pipe, O_CLOEXEC | O_NONBLOCK) != 0) wn_host_fail("cannot create the signal pipe");
  wn_io_init(&sig_io, sig_pipe[0], sig_ready, NULL);
  sig_io.last = 1;
  internal_ios[1] = &sig_io;
  wn_io_want(&sig_io, EPOLLIN);
}
static int is_sig_rec(const WnEv *e, void *ctx) { return e->source == WN_SRC_SIG && e->handle == (uint32_t)(uintptr_t)ctx; }

int32_t host_sigCall(int32_t op, int32_t x) {
  if (op == 1) {
    int s = x;
    if (s <= 0 || s >= 65) return -EINVAL;
    sig_init();
    if (sig_count[s] == 0) {
      struct sigaction sa;
      memset(&sa, 0, sizeof sa);
      sa.sa_handler = on_signal;
      sigfillset(&sa.sa_mask);
      sa.sa_flags = SA_RESTART;
      if (sigaction(s, &sa, &sig_old[s]) != 0) return -errno;
    }
    sig_count[s]++;
    subs = realloc(subs, sizeof *subs * (size_t)(n_subs + 1));
    if (!subs) abort();
    subs[n_subs].signum = s;
    subs[n_subs].live = 1;
    n_subs++;
    wn_ev_hold(1);
    return n_subs;
  }
  if (op == 2) {
    if (x < 1 || x > n_subs || !subs[x - 1].live) wn_host_fail("sigCall: STOP of a handle that is not a subscription");
    SigSub *r = &subs[x - 1];
    r->live = 0;
    if (--sig_count[r->signum] == 0) sigaction(r->signum, &sig_old[r->signum], NULL);
    wn_ev_purge(is_sig_rec, (void *)(uintptr_t)x);
    wn_ev_hold(-1);
    return 0;
  }
  wn_host_fail("sigCall: an op outside the contract");
}

/* ── fs.watch (abi.ts watchCall; libuv's inotify backend) ─────────────── */
static int ino_fd = -1;
static WnIo ino_io;
typedef struct {
  int wd;
  int live;
  char *path; /* as the program gave it (libuv's w->path) */
} Watch;
static Watch *watches;
static int n_watches;

static const char *base_r(const char *p) {
  const char *s = strrchr(p, '/');
  return s ? s + 1 : p;
}
static void ino_ready(WnIo *io, uint32_t evs) {
  (void)evs;
  char buf[4096] __attribute__((aligned(__alignof__(struct inotify_event))));
  for (;;) {
    ssize_t size = read(io->fd, buf, sizeof buf);
    if (size < 0) {
      if (errno == EINTR) continue;
      break;
    }
    if (size == 0) break;
    for (char *p = buf; p < buf + size;) {
      const struct inotify_event *e = (const struct inotify_event *)(void *)p;
      p += sizeof *e + e->len;
      int32_t events = 0;
      if (e->mask & (IN_ATTRIB | IN_MODIFY)) events |= 2; /* UV_CHANGE */
      if (e->mask & ~(uint32_t)(IN_ATTRIB | IN_MODIFY)) events |= 1; /* UV_RENAME */
      for (int h = 0; h < n_watches; h++) {
        if (!watches[h].live || watches[h].wd != e->wd) continue;
        const char *name = e->len ? e->name : base_r(watches[h].path);
        size_t nl = strlen(name);
        size_t units = wn_utf8_to_16((const uint8_t *)name, nl, NULL);
        uint16_t *u = malloc(units * 2 + 2);
        if (!u) abort();
        wn_utf8_to_16((const uint8_t *)name, nl, u);
        wn_ev_push(wn_ev_new(WN_SRC_WATCH, (uint32_t)h + 1, 1, events, 0, u, (uint32_t)units * 2));
        free(u);
      }
    }
  }
}
static int is_watch_rec(const WnEv *e, void *ctx) { return e->source == WN_SRC_WATCH && e->handle == (uint32_t)(uintptr_t)ctx; }

int32_t host_watchCall(int32_t op, int32_t ptr, int32_t len, int32_t h) {
  if (op == 1) {
    size_t n;
    char *path = wn_utf16_to_8((uint32_t)ptr, (uint32_t)len, &n);
    if (strlen(path) != n) wn_host_fail("a watch path holding U+0000 reached the host (the module must reject it, as Node does)");
    if (ino_fd < 0) {
      ino_fd = inotify_init1(IN_NONBLOCK | IN_CLOEXEC);
      if (ino_fd < 0) {
        int e = errno;
        free(path);
        return wn_fs_err(e);
      }
      wn_io_init(&ino_io, ino_fd, ino_ready, NULL);
      internal_ios[2] = &ino_io;
      wn_io_want(&ino_io, EPOLLIN);
    }
    uint32_t mask = IN_ATTRIB | IN_CREATE | IN_MODIFY | IN_DELETE | IN_DELETE_SELF | IN_MOVE_SELF | IN_MOVED_FROM | IN_MOVED_TO;
    int wd = inotify_add_watch(ino_fd, path, mask);
    if (wd < 0) {
      int e = errno;
      free(path);
      return wn_fs_err(e);
    }
    watches = realloc(watches, sizeof *watches * (size_t)(n_watches + 1));
    if (!watches) abort();
    watches[n_watches].wd = wd;
    watches[n_watches].live = 1;
    watches[n_watches].path = path;
    n_watches++;
    wn_ev_hold(1);
    return n_watches;
  }
  if (op == 2) {
    if (h < 1 || h > n_watches || !watches[h - 1].live) wn_host_fail("watchCall: STOP of a handle that is not a watch");
    Watch *w = &watches[h - 1];
    w->live = 0;
    int others = 0;
    for (int i = 0; i < n_watches; i++)
      if (watches[i].live && watches[i].wd == w->wd) others = 1;
    if (!others) inotify_rm_watch(ino_fd, w->wd);
    free(w->path);
    w->path = NULL;
    wn_ev_purge(is_watch_rec, (void *)(uintptr_t)h);
    wn_ev_hold(-1);
    return 0;
  }
  wn_host_fail("watchCall: an op outside the contract");
}

/* ── stdin (abi.ts stdinCall; uv_read_start / uv_read_stop on fd 0) ───── */
static WnIo in_io;
static int in_init, in_reading, in_eof;
static int in_flags = -1;
/* libuv opens a pipe or socket stdin non-blocking (uv_pipe_open); the
 * descriptor's description is shared with whoever else holds it, so its
 * flags go back as they were at exit (Node resets its stdio too) */
static void in_restore(void) {
  if (in_flags >= 0) fcntl(0, F_SETFL, in_flags);
}
static WnEv *in_held;

static void in_read_once(void) {
  static uint8_t buf[65536];
  ssize_t r;
  do r = read(0, buf, sizeof buf);
  while (r < 0 && errno == EINTR);
  if (r < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) return;
  if (r > 0) {
    wn_ev_push(wn_ev_new(WN_SRC_STDIN, 0, 1, 0, 0, buf, (uint32_t)r));
    return;
  }
  if (r == 0) wn_ev_push(wn_ev_new(WN_SRC_STDIN, 0, 2, 0, 0, NULL, 0));
  else wn_ev_push(wn_ev_new(WN_SRC_STDIN, 0, 3, -errno, 0, NULL, 0));
  in_eof = 1;
  wn_io_want(&in_io, 0);
}
static void in_ready(WnIo *io, uint32_t evs) {
  (void)io;
  (void)evs;
  if (in_reading && !in_eof) in_read_once();
}
static void stdin_round(void) {
  if (in_init && in_io.always && in_reading && !in_eof) in_read_once();
}
static int is_stdin_rec(const WnEv *e, void *ctx) {
  (void)ctx;
  return e->source == WN_SRC_STDIN;
}

int32_t host_stdinCall(int32_t op) {
  if (op == 1) {
    if (!in_init) {
      in_init = 1;
      wn_io_init(&in_io, 0, in_ready, NULL);
      struct stat st;
      int fl = fcntl(0, F_GETFL);
      if (fl >= 0 && fstat(0, &st) == 0 && (S_ISFIFO(st.st_mode) || S_ISSOCK(st.st_mode)) && !(fl & O_NONBLOCK)) {
        in_flags = fl;
        atexit(in_restore);
        fcntl(0, F_SETFL, fl | O_NONBLOCK);
      }
      if (fl < 0) {
        /* no fd 0 at all: Node reads /dev/null there — end of file */
        in_reading = 1;
        in_eof = 1;
        wn_ev_push(wn_ev_new(WN_SRC_STDIN, 0, 2, 0, 0, NULL, 0));
        return 0;
      }
    }
    if (in_reading) return 0;
    in_reading = 1;
    /* what READ_STOP held, back in order */
    while (in_held) {
      WnEv *e = in_held;
      in_held = e->next;
      wn_ev_push(e);
    }
    if (!in_eof) wn_io_want(&in_io, EPOLLIN);
    return 0;
  }
  if (op == 2) {
    if (!in_reading) return 0;
    in_reading = 0;
    if (!in_eof) wn_io_want(&in_io, 0);
    WnEv *t = wn_ev_take(is_stdin_rec, NULL);
    if (t) {
      WnEv **pp = &in_held;
      while (*pp) pp = &(*pp)->next;
      *pp = t;
    }
    return 0;
  }
  wn_host_fail("stdinCall: an op outside the contract");
}
