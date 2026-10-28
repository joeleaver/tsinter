/* The native runner's host, shared between its units (native-runner N1):
 * wn_host.c (process, clocks, fs, zones), wn_ev.c (the event core: the
 * evPoll queue, the loop's wait, signals, fs.watch, stdin), wn_cp.c
 * (child processes), wn_net.c (TCP, UDP, lookups), wn_tls.c (the TLS
 * engine over Node's own OpenSSL, wn_trust.c) and wn_fetch.c (fetch).
 *
 * THE HOST HOLDS NO GC REFERENCE: every value crossing abi.ts is a number
 * or bytes in the module's linear memory, and everything the host keeps
 * (children, sockets, watches, requests) sits behind a small integer
 * handle in a host table — the collector never needs to know about it. */
#ifndef WN_HOST_H
#define WN_HOST_H

#include <stddef.h>
#include <stdint.h>
#include <string.h>

extern uint8_t *w_hostmem;

double host_now(void);

/* UTF-8 → UTF-16 (each maximal ill-formed subpart one U+FFFD); with out
 * NULL, only the length in code units */
size_t wn_utf8_to_16(const uint8_t *s, size_t n, uint16_t *out);
/* `n` UTF-16 code units of module memory at ptr → malloc'd NUL-terminated
 * UTF-8 (a lone surrogate becomes U+FFFD) */
char *wn_utf16_to_8(uint32_t ptr, uint32_t n, size_t *outlen);
/* fsCall's errno carrier: -1..-14 the module's table, else -(256 + e) */
int32_t wn_fs_err(int e);
_Noreturn void wn_host_fail(const char *what);

/* little-endian access to module memory (every record is LE; the
 * offsets need not be aligned) */
static inline uint32_t wn_rd32(uint32_t p) {
  uint32_t v;
  memcpy(&v, w_hostmem + p, 4);
  return v;
}
static inline void wn_wr32(uint32_t p, uint32_t v) { memcpy(w_hostmem + p, &v, 4); }
static inline double wn_rdf64(uint32_t p) {
  double v;
  memcpy(&v, w_hostmem + p, 8);
  return v;
}
static inline void wn_wrf64(uint32_t p, double v) { memcpy(w_hostmem + p, &v, 8); }

/* ── a growable byte buffer (records, payloads) ───────────────────────── */
typedef struct {
  uint8_t *p;
  size_t n, cap;
} WnBuf;
void wn_buf_put(WnBuf *b, const void *s, size_t n);
void wn_buf_u32(WnBuf *b, uint32_t v);
/* a UTF-16 run (abi.ts): u32 code-unit count, the units, zero padding to 4 */
void wn_buf_run8(WnBuf *b, const char *utf8, size_t n);
void wn_buf_run16(WnBuf *b, const uint16_t *u, size_t n);
/* a blob: u32 byte count, the bytes, padding to 4 */
void wn_buf_blob(WnBuf *b, const void *p, size_t n);
void wn_buf_free(WnBuf *b);
/* reading a run from module memory at *off: malloc'd UTF-8, *off advanced */
char *wn_read_run(uint32_t *off, size_t *outlen);

/* ── the event queue (abi.ts evPoll) ──────────────────────────────────── */
enum { WN_SRC_CHILD = 1, WN_SRC_NET = 2, WN_SRC_SIG = 3, WN_SRC_WATCH = 4, WN_SRC_STDIN = 5, WN_SRC_FETCH = 6 };
typedef struct WnEv {
  struct WnEv *next;
  uint32_t source, handle, kind;
  int32_t a, b;
  uint64_t gen;
  uint32_t len;
  uint8_t data[];
} WnEv;
WnEv *wn_ev_new(uint32_t source, uint32_t handle, uint32_t kind, int32_t a, int32_t b, const void *p, uint32_t n);
/* queue an event now (a net event is stamped with the host iteration) */
void wn_ev_push(WnEv *e);
/* queue an event for the module's NEXT poll phase (what the reference
 * host's Node emits on a later tick than the import call that caused it) */
void wn_ev_stage(WnEv *e);
/* staged behind every wn_ev_stage'd event (an 'end' the drain queues) */
void wn_ev_stage_late(WnEv *e);
/* staged as an I/O callback's own event: never in a scope */
void wn_ev_stage_solo(WnEv *e);
/* a net event held across READ_STOP, re-queued for the next iteration */
void wn_ev_requeue_next(WnEv *e);
typedef int (*WnEvPred)(const WnEv *e, void *ctx);
void wn_ev_purge(WnEvPred pred, void *ctx);
/* remove and answer (a list, in order) every queued event pred matches */
WnEv *wn_ev_take(WnEvPred pred, void *ctx);
/* the host callback SCOPE (abi.ts evPoll's bit 8, children's events):
 * between begin and end, each EXIT/DATA/END/HELD queued marks the one
 * queued before it */
void wn_ev_scope_begin(void);
void wn_ev_scope_end(void);

/* ── the poller (epoll): readiness callbacks for the host's descriptors ─ */
typedef struct WnIo WnIo;
typedef void (*WnIoFn)(WnIo *io, uint32_t events);
struct WnIo {
  int fd;
  uint32_t events; /* EPOLLIN / EPOLLOUT wanted; 0 = not registered */
  WnIoFn cb;
  void *ctx;
  int always; /* a descriptor epoll cannot watch (a regular file): always ready */
  int reg;     /* registered with epoll */
  int pending; /* in the watcher queue, applied at the next wait */
  int last;    /* a signal's descriptor: handled after the round's I/O */
};
void wn_io_init(WnIo *io, int fd, WnIoFn cb, void *ctx);
/* set the wanted events (0 removes it from the poller) */
void wn_io_want(WnIo *io, uint32_t events);
void wn_io_close(WnIo *io);
/* work a host thread (a lookup, a request) finished: run fn(ctx) on the
 * program thread at the next wait */
void wn_ev_post(void (*fn)(void *), void *ctx);
/* a source that will deliver later without a descriptor (a thread's work
 * in flight) holds the loop's wait open */
void wn_ev_hold(int delta);

/* the driver's half (wn_main.c): wait for an event or the deadline, then
 * open the module's next poll phase */
void wn_ev_wait(double due);
void wn_ev_begin_poll(void);

/* the child-process unit's descriptor hygiene: every descriptor the host
 * opens is close-on-exec */

#endif
