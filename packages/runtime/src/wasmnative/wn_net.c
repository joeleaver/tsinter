/* The native runner's network (native-runner phase N1): abi.ts's `netCall`
 * — TCP at the level of libuv's uv_tcp_*, lookups at uv_getaddrinfo's,
 * UDP at uv_udp_*'s — with its events (evPoll source 2) in wn_ev.c's
 * queue. Every Node behaviour is the module's (net.ts, dgram.ts); this is
 * libuv's OS layer, transcribed:
 *  - LISTEN: socket, SO_REUSEADDR, IPV6_V6ONLY set from the flag, bind —
 *    whose EADDRINUSE libuv defers to the listen (stage 2) — and listen;
 *    accepting is accept4 until EAGAIN, each connection an ACCEPT.
 *  - CONNECT: a non-blocking connect; EINPROGRESS (or ECONNREFUSED, which
 *    libuv delays) completes as a CONNECT event from SO_ERROR; any other
 *    errno is the synchronous failure.
 *  - reads: while the module reads (READ_START), up to 32 reads of 64 KiB
 *    per readiness (uv__read), each a DATA; end of file an EOF; an error a
 *    READ_ERROR. READ_STOP stops reading at once and holds what is queued.
 *  - writes: tried at once (uv_try_write's shape: 0 when all of it went),
 *    else the rest waits for POLLOUT and completes as a WRITE_DONE.
 *  - lookups: getaddrinfo on a thread (libuv's threadpool), its errors in
 *    libuv's UV_EAI_* numbering (Node's -3000 range).
 * One epoll round is one host iteration (wn_ev.c): its net events form one
 * module poll phase.
 *
 * A socket secured by tlsCall (wn_tls.c) keeps this unit's descriptor,
 * outbound buffer and read gating; the TLS unit plugs its ops in, so
 * reads decrypt and writes encrypt (WnTlsOps). */
#define _GNU_SOURCE
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <net/if.h>
#include <netdb.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/epoll.h>
#include <sys/socket.h>
#include <unistd.h>

#include "wn_host.h"
#include "wn_net.h"

extern void (*wn_net_delivered)(const WnEv *e);

enum { K_SERVER = 1, K_SOCKET, K_RESOLVE, K_UDP };
enum {
  EV_ACCEPT = 1,
  EV_CONNECT = 2,
  EV_DATA = 3,
  EV_EOF = 4,
  EV_READ_ERROR = 5,
  EV_WRITE_DONE = 6,
  EV_RESOLVE_DONE = 8,
  EV_ACCEPT_ERROR = 9,
  EV_UDP_MESSAGE = 20,
  EV_UDP_ERROR = 21
};

static WnSock **hs;
static uint32_t n_hs;

static WnSock *sock_new(int kind, int fd) {
  WnSock *s = calloc(1, sizeof *s);
  if (!s) abort();
  hs = realloc(hs, sizeof *hs * (n_hs + 1));
  if (!hs) abort();
  hs[n_hs++] = s;
  s->kind = kind;
  s->handle = n_hs;
  s->held_tail = &s->held;
  wn_io_init(&s->io, fd, NULL, s);
  return s;
}
static WnSock *sock_of(int32_t h) {
  if (h < 1 || (uint32_t)h > n_hs) return NULL;
  return hs[h - 1];
}
WnSock *wn_sock_get(int32_t h) {
  WnSock *s = sock_of(h);
  return s && s->kind == K_SOCKET ? s : NULL;
}

/* ── addresses ────────────────────────────────────────────────────────── */
/* a peer as ACCEPT's / CONNECT's payload carries it: u32 family, u32 port,
 * the address run */
static void addr_payload(WnBuf *b, const struct sockaddr_storage *ss) {
  char ip[INET6_ADDRSTRLEN] = "";
  uint32_t fam = 4, port = 0;
  if (ss->ss_family == AF_INET6) {
    const struct sockaddr_in6 *a = (const void *)ss;
    inet_ntop(AF_INET6, &a->sin6_addr, ip, sizeof ip);
    fam = 6;
    port = ntohs(a->sin6_port);
  } else if (ss->ss_family == AF_INET) {
    const struct sockaddr_in *a = (const void *)ss;
    inet_ntop(AF_INET, &a->sin_addr, ip, sizeof ip);
    port = ntohs(a->sin_port);
  }
  wn_buf_u32(b, fam);
  wn_buf_u32(b, port);
  wn_buf_run8(b, ip, strlen(ip));
}
/* the bound form a reply carries: u32 port, u32 family, the address run */
static void bound_reply(uint32_t ptr, int fd) {
  struct sockaddr_storage ss;
  socklen_t sl = sizeof ss;
  memset(&ss, 0, sizeof ss);
  getsockname(fd, (struct sockaddr *)&ss, &sl);
  WnBuf b = {0};
  addr_payload(&b, &ss);
  uint32_t fam, port;
  memcpy(&fam, b.p, 4);
  memcpy(&port, b.p + 4, 4);
  memcpy(b.p, &port, 4);
  memcpy(b.p + 4, &fam, 4);
  memcpy(w_hostmem + ptr, b.p, b.n);
  wn_buf_free(&b);
}
static int make_addr(const char *ip, uint32_t port, uint32_t family, struct sockaddr_storage *ss, socklen_t *sl) {
  memset(ss, 0, sizeof *ss);
  if (family == 6) {
    struct sockaddr_in6 *a = (void *)ss;
    a->sin6_family = AF_INET6;
    a->sin6_port = htons((uint16_t)port);
    /* a scope suffix ("fe80::1%lo") names the interface */
    char buf[INET6_ADDRSTRLEN + 32];
    snprintf(buf, sizeof buf, "%s", ip);
    char *pct = strchr(buf, '%');
    if (pct) {
      *pct = 0;
      a->sin6_scope_id = if_nametoindex(pct + 1);
      if (a->sin6_scope_id == 0) a->sin6_scope_id = (uint32_t)atoi(pct + 1);
    }
    if (inet_pton(AF_INET6, buf, &a->sin6_addr) != 1) return -EINVAL;
    *sl = sizeof *a;
    return 0;
  }
  struct sockaddr_in *a = (void *)ss;
  a->sin_family = AF_INET;
  a->sin_port = htons((uint16_t)port);
  if (inet_pton(AF_INET, ip, &a->sin_addr) != 1) return -EINVAL;
  *sl = sizeof *a;
  return 0;
}

/* ── queueing ─────────────────────────────────────────────────────────── */
void wn_sock_push(WnSock *s, uint32_t kind, int32_t a, const void *p, uint32_t n) {
  if (s->closed) return;
  wn_ev_push(wn_ev_new(WN_SRC_NET, s->handle, kind, a, 0, p, n));
}
/* DATA / EOF / READ_ERROR: delivered while the module reads, held while
 * it does not */
void wn_sock_queue_read(WnSock *s, uint32_t kind, int32_t a, const void *p, uint32_t n) {
  if (s->closed) return;
  WnEv *e = wn_ev_new(WN_SRC_NET, s->handle, kind, a, 0, p, n);
  if (!s->reading) {
    *s->held_tail = e;
    s->held_tail = &e->next;
    return;
  }
  wn_ev_push(e);
}

static void sock_update(WnSock *s) {
  if (s->closed || s->io.fd < 0) return;
  uint32_t want = 0;
  if (s->kind == K_SERVER || s->kind == K_UDP) want = EPOLLIN;
  else {
    if (s->connecting || s->out.n > s->out_off) want |= EPOLLOUT;
    if ((s->tls ? s->tls_reads : s->reading) && !s->rd_done && !s->connecting) want |= EPOLLIN;
  }
  wn_io_want(&s->io, want);
}
void wn_sock_update(WnSock *s) { sock_update(s); }

/* flushes the outbound buffer: 0 drained, 1 bytes remain, -errno */
static int out_flush(WnSock *s) {
  while (s->out_off < s->out.n) {
    ssize_t w = send(s->io.fd, s->out.p + s->out_off, s->out.n - s->out_off, MSG_NOSIGNAL);
    if (w < 0) {
      if (errno == EINTR) continue;
      if (errno == EAGAIN || errno == EWOULDBLOCK) return 1;
      return -errno;
    }
    s->out_off += (size_t)w;
  }
  s->out.n = s->out_off = 0;
  return 0;
}
/* raw bytes for the peer (the TLS unit's records): buffered behind what
 * is already waiting, sent as far as the socket takes them */
int wn_sock_raw_out(WnSock *s, const void *p, size_t n) {
  if (s->out_off == s->out.n) s->out.n = s->out_off = 0;
  wn_buf_put(&s->out, p, n);
  int r = s->connecting ? 1 : out_flush(s);
  sock_update(s);
  return r < 0 ? r : 0;
}
int wn_sock_out_pending(WnSock *s) { return s->out.n > s->out_off; }

/* the write side, once nothing waits in the outbound buffer */
static void maybe_shut(WnSock *s) {
  if (s->shut_pending && s->out.n == s->out_off) {
    s->shut_pending = 0;
    shutdown(s->io.fd, SHUT_WR);
  }
}
void wn_sock_shutdown_after_drain(WnSock *s) {
  s->shut_pending = 1;
  maybe_shut(s);
}

/* ── readiness ────────────────────────────────────────────────────────── */
static void read_plain(WnSock *s) {
  static uint8_t buf[65536];
  for (int count = 0; count < 32 && s->reading && !s->rd_done && !s->closed; count++) {
    ssize_t r = recv(s->io.fd, buf, sizeof buf, 0);
    if (r < 0) {
      if (errno == EINTR) continue;
      if (errno == EAGAIN || errno == EWOULDBLOCK) return;
      s->rd_done = 1;
      wn_sock_queue_read(s, EV_READ_ERROR, -errno, NULL, 0);
      return;
    }
    if (r == 0) {
      s->rd_done = 1;
      wn_sock_queue_read(s, EV_EOF, 0, NULL, 0);
      return;
    }
    wn_sock_queue_read(s, EV_DATA, 0, buf, (uint32_t)r);
    /* uv__read: a read that did not fill the buffer ends this callback —
     * what follows (an end of file included) is the next iteration's */
    if ((size_t)r < sizeof buf) return;
  }
}

static void after_write_progress(WnSock *s) {
  int r = out_flush(s);
  if (r == 1) return;
  if (s->pending_write) {
    s->pending_write = 0;
    wn_sock_push(s, EV_WRITE_DONE, r < 0 ? r : 0, NULL, 0);
  }
  if (r == 0) maybe_shut(s);
}

static void sock_ready(WnIo *io, uint32_t evs) {
  WnSock *s = io->ctx;
  if (s->connecting) {
    int err = 0;
    socklen_t el = sizeof err;
    getsockopt(io->fd, SOL_SOCKET, SO_ERROR, &err, &el);
    if (err == 0 && !(evs & (EPOLLOUT | EPOLLERR | EPOLLHUP))) return;
    s->connecting = 0;
    if (err != 0) {
      wn_sock_push(s, EV_CONNECT, -err, NULL, 0);
      s->rd_done = 1;
      sock_update(s);
      return;
    }
    struct sockaddr_storage ss;
    socklen_t sl = sizeof ss;
    memset(&ss, 0, sizeof ss);
    getpeername(io->fd, (struct sockaddr *)&ss, &sl);
    WnBuf b = {0};
    addr_payload(&b, &ss);
    wn_sock_push(s, EV_CONNECT, 0, b.p, (uint32_t)b.n);
    wn_buf_free(&b);
    if (s->tls && s->tls->connected) s->tls->connected(s);
    if (s->out.n > s->out_off) after_write_progress(s);
    sock_update(s);
    return;
  }
  if (evs & (EPOLLIN | EPOLLHUP | EPOLLERR)) {
    if (s->tls) s->tls->readable(s);
    else read_plain(s);
  }
  if (s->closed) return;
  if (evs & (EPOLLOUT | EPOLLERR | EPOLLHUP)) {
    if (s->out.n > s->out_off) after_write_progress(s);
    if (s->tls && s->tls->writable) s->tls->writable(s);
  }
  sock_update(s);
}

/* libuv's uv__emfile_trick: out of descriptors, a pending connection would
 * keep the listener readable forever — so a descriptor is held in reserve,
 * and on EMFILE / ENFILE it is released to accept (and at once close)
 * what is waiting, then taken back */
extern int wn_reserve_fd; /* defined in wn_ev.c (its audit skips it) */
#define reserve_fd wn_reserve_fd
static int emfile_trick(int lfd) {
  if (reserve_fd == -1) return EMFILE;
  close(reserve_fd);
  reserve_fd = -1;
  int err;
  for (;;) {
    int fd = accept4(lfd, NULL, NULL, SOCK_CLOEXEC);
    if (fd >= 0) {
      close(fd);
      continue;
    }
    err = errno;
    if (err == EINTR) continue;
    break;
  }
  reserve_fd = open("/", O_PATH | O_CLOEXEC);
  return err;
}

static void server_ready(WnIo *io, uint32_t evs) {
  (void)evs;
  WnSock *srv = io->ctx;
  if (reserve_fd == -2) reserve_fd = open("/", O_PATH | O_CLOEXEC);
  for (;;) {
    struct sockaddr_storage ss;
    socklen_t sl = sizeof ss;
    int fd = accept4(io->fd, (struct sockaddr *)&ss, &sl, SOCK_NONBLOCK | SOCK_CLOEXEC);
    if (fd < 0) {
      int e = errno;
      if (e == EINTR) continue;
      if (e == EAGAIN || e == EWOULDBLOCK || e == ECONNABORTED) return;
      if (e == EMFILE || e == ENFILE) {
        int t = emfile_trick(io->fd);
        if (t == EAGAIN || t == EWOULDBLOCK) return;
      }
      wn_sock_push(srv, EV_ACCEPT_ERROR, -e, NULL, 0);
      return;
    }
    WnSock *c = sock_new(K_SOCKET, fd);
    c->io.cb = sock_ready;
    c->connected = 1;
    WnBuf b = {0};
    addr_payload(&b, &ss);
    wn_sock_push(srv, EV_ACCEPT, (int32_t)c->handle, b.p, (uint32_t)b.n);
    wn_buf_free(&b);
    sock_update(c);
    if (srv->closed) return;
  }
}

static void udp_ready(WnIo *io, uint32_t evs) {
  (void)evs;
  WnSock *s = io->ctx;
  static uint8_t buf[65536];
  for (int count = 0; count < 32 && !s->closed; count++) {
    struct sockaddr_storage ss;
    socklen_t sl = sizeof ss;
    memset(&ss, 0, sizeof ss);
    ssize_t r = recvfrom(io->fd, buf, sizeof buf, 0, (struct sockaddr *)&ss, &sl);
    if (r < 0) {
      if (errno == EINTR) continue;
      if (errno == EAGAIN || errno == EWOULDBLOCK) break;
      wn_sock_push(s, EV_UDP_ERROR, -errno, NULL, 0);
      break;
    }
    WnBuf b = {0};
    addr_payload(&b, &ss);
    wn_buf_put(&b, buf, (size_t)r);
    wn_sock_push(s, EV_UDP_MESSAGE, 0, b.p, (uint32_t)b.n);
    wn_buf_free(&b);
  }
  /* datagrams the kernel would not take at once, in call order */
  while (s->udpq) {
    UdpOut *u = s->udpq;
    ssize_t w = u->salen ? sendto(io->fd, u->data, u->n, 0, (struct sockaddr *)&u->sa, u->salen) : send(io->fd, u->data, u->n, 0);
    if (w < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) break;
    s->udpq = u->next;
    free(u);
  }
  wn_io_want(io, s->udpq ? EPOLLIN | EPOLLOUT : EPOLLIN);
}

/* ── lookups ──────────────────────────────────────────────────────────── */
typedef struct {
  WnSock *s;
  char *name;
  int family, hints;
  int rc, err;
  struct addrinfo *res;
} Lookup;

static int32_t eai_code(int rc, int err) {
  switch (rc) {
#ifdef EAI_ADDRFAMILY
    case EAI_ADDRFAMILY: return -3000;
#endif
    case EAI_AGAIN: return -3001;
    case EAI_BADFLAGS: return -3002;
#ifdef EAI_CANCELED
    case EAI_CANCELED: return -3003;
#endif
    case EAI_FAIL: return -3004;
    case EAI_FAMILY: return -3005;
    case EAI_MEMORY: return -3006;
#ifdef EAI_NODATA
    case EAI_NODATA: return -3007;
#endif
    case EAI_NONAME: return -3008;
    case EAI_OVERFLOW: return -3009;
    case EAI_SERVICE: return -3010;
    case EAI_SOCKTYPE: return -3011;
    case EAI_SYSTEM: return -err;
    default: return -3004;
  }
}

static void lookup_done(void *ctx) {
  Lookup *l = ctx;
  wn_ev_hold(-1);
  WnSock *s = l->s;
  if (l->rc != 0) {
    wn_sock_push(s, EV_RESOLVE_DONE, eai_code(l->rc, l->err), NULL, 0);
  } else {
    WnBuf b = {0};
    uint32_t count = 0;
    wn_buf_u32(&b, 0);
    for (struct addrinfo *p = l->res; p; p = p->ai_next) {
      char ip[INET6_ADDRSTRLEN];
      if (p->ai_family == AF_INET) inet_ntop(AF_INET, &((struct sockaddr_in *)(void *)p->ai_addr)->sin_addr, ip, sizeof ip);
      else if (p->ai_family == AF_INET6) inet_ntop(AF_INET6, &((struct sockaddr_in6 *)(void *)p->ai_addr)->sin6_addr, ip, sizeof ip);
      else continue;
      wn_buf_u32(&b, p->ai_family == AF_INET6 ? 6 : 4);
      wn_buf_run8(&b, ip, strlen(ip));
      count++;
    }
    memcpy(b.p, &count, 4);
    wn_sock_push(s, EV_RESOLVE_DONE, 0, b.p, (uint32_t)b.n);
    wn_buf_free(&b);
  }
  if (l->res) freeaddrinfo(l->res);
  free(l->name);
  free(l);
}
static void *lookup_thread(void *ctx) {
  Lookup *l = ctx;
  struct addrinfo hints;
  memset(&hints, 0, sizeof hints);
  hints.ai_family = l->family == 4 ? AF_INET : l->family == 6 ? AF_INET6 : AF_UNSPEC;
  hints.ai_socktype = SOCK_STREAM;
  /* Node's dns hints are getaddrinfo's own flag values (ADDRCONFIG 32,
   * V4MAPPED 8, ALL 16) */
  hints.ai_flags = l->hints;
  l->rc = getaddrinfo(l->name, NULL, &hints, &l->res);
  l->err = errno;
  wn_ev_post(lookup_done, l);
  return NULL;
}

static void net_delivered(const WnEv *e) {
  if ((e->kind & 0xff) != EV_RESOLVE_DONE) return;
  WnSock *s = sock_of((int32_t)e->handle);
  if (s && s->kind == K_RESOLVE && !s->closed) {
    s->closed = 1;
    hs[s->handle - 1] = NULL;
    free(s);
  }
}

static int is_handle_ev(const WnEv *e, void *ctx) { return e->source == WN_SRC_NET && e->handle == (uint32_t)(uintptr_t)ctx; }
static int is_read_ev(const WnEv *e, void *ctx) {
  uint32_t k = e->kind & 0xff;
  return e->source == WN_SRC_NET && e->handle == (uint32_t)(uintptr_t)ctx && (k == EV_DATA || k == EV_EOF || k == EV_READ_ERROR);
}

static void sock_destroy(WnSock *s) {
  s->closed = 1;
  if (s->tls && s->tls->free) s->tls->free(s);
  if (s->io.fd >= 0) wn_io_close(&s->io);
  wn_buf_free(&s->out);
  while (s->held) {
    WnEv *e = s->held;
    s->held = e->next;
    free(e);
  }
  while (s->udpq) {
    UdpOut *u = s->udpq;
    s->udpq = u->next;
    free(u);
  }
  hs[s->handle - 1] = NULL;
  free(s);
}

/* a queued ACCEPT's socket goes with its server's CLOSE */
static int purge_server(const WnEv *e, void *ctx) {
  if (!is_handle_ev(e, ctx)) return 0;
  if ((e->kind & 0xff) == EV_ACCEPT) {
    WnSock *c = sock_of(e->a);
    if (c) sock_destroy(c);
  }
  return 1;
}

/* ── the import ───────────────────────────────────────────────────────── */
int32_t host_netCall(int32_t op, int32_t ptr, int32_t len, int32_t h, int32_t x) {
  uint32_t P = (uint32_t)ptr;
  wn_net_delivered = net_delivered;
  switch (op) {
    case 1: { /* LISTEN */
      uint32_t port = wn_rd32(P), family = wn_rd32(P + 4), flags = wn_rd32(P + 8), backlog = wn_rd32(P + 12);
      uint32_t off = P + 16;
      char *addr = wn_read_run(&off, NULL);
      struct sockaddr_storage ss;
      socklen_t sl;
      int stage = 1, err = 0;
      int fd = -1;
      if (make_addr(addr, port, family, &ss, &sl) != 0) err = EINVAL;
      free(addr);
      if (!err) {
        fd = socket(ss.ss_family, SOCK_STREAM | SOCK_NONBLOCK | SOCK_CLOEXEC, 0);
        if (fd < 0) err = errno;
      }
      if (!err) {
        int on = 1;
        setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &on, sizeof on);
        if (ss.ss_family == AF_INET6) {
          int v6 = (flags & 1) != 0;
          if (setsockopt(fd, IPPROTO_IPV6, IPV6_V6ONLY, &v6, sizeof v6) != 0) err = errno;
        }
      }
      if (!err && bind(fd, (struct sockaddr *)&ss, sl) != 0) {
        err = errno;
        if (err == EADDRINUSE) stage = 2; /* libuv's delayed_error */
      }
      if (!err) {
        stage = 2;
        if (listen(fd, (int)backlog) != 0) err = errno;
      }
      if (err) {
        if (fd >= 0) close(fd);
        wn_wr32(P, (uint32_t)stage);
        wn_wr32(P + 4, 0);
        wn_wr32(P + 8, 0);
        wn_wr32(P + 12, 0);
        return -err;
      }
      WnSock *s = sock_new(K_SERVER, fd);
      s->io.cb = server_ready;
      wn_wr32(P, 0);
      bound_reply(P + 4, fd);
      sock_update(s);
      return (int32_t)s->handle;
    }
    case 2: { /* CONNECT */
      uint32_t port = wn_rd32(P), family = wn_rd32(P + 4);
      uint32_t off = P + 8;
      char *addr = wn_read_run(&off, NULL);
      struct sockaddr_storage ss;
      socklen_t sl;
      int bad = make_addr(addr, port, family, &ss, &sl);
      free(addr);
      if (bad) return -EINVAL;
      int fd = socket(ss.ss_family, SOCK_STREAM | SOCK_NONBLOCK | SOCK_CLOEXEC, 0);
      if (fd < 0) return -errno;
      int r;
      do r = connect(fd, (struct sockaddr *)&ss, sl);
      while (r < 0 && errno == EINTR);
      if (r < 0 && errno != EINPROGRESS && errno != ECONNREFUSED) {
        int e = errno;
        close(fd);
        return -e;
      }
      WnSock *s = sock_new(K_SOCKET, fd);
      s->io.cb = sock_ready;
      s->connecting = 1;
      sock_update(s);
      return (int32_t)s->handle;
    }
    case 3: { /* READ_START */
      WnSock *s = wn_sock_get(h);
      if (!s) wn_host_fail("netCall: READ_START of a handle that is not an open socket");
      if (!s->reading) {
        s->reading = 1;
        /* what READ_STOP held: a later iteration's, in order */
        while (s->held) {
          WnEv *e = s->held;
          s->held = e->next;
          wn_ev_requeue_next(e);
        }
        s->held_tail = &s->held;
        if (s->tls && s->tls->read_start) s->tls->read_start(s);
        sock_update(s);
      }
      return 0;
    }
    case 4: { /* READ_STOP */
      WnSock *s = wn_sock_get(h);
      if (!s) wn_host_fail("netCall: READ_STOP of a handle that is not an open socket");
      if (s->reading) {
        s->reading = 0;
        sock_update(s);
        WnEv *t = wn_ev_take(is_read_ev, (void *)(uintptr_t)h);
        if (t) {
          /* the queued ones come before anything held already */
          WnEv *last = t;
          while (last->next) last = last->next;
          last->next = s->held;
          if (!s->held) s->held_tail = &last->next;
          s->held = t;
        }
      }
      return 0;
    }
    case 5: { /* WRITE */
      WnSock *s = wn_sock_get(h);
      if (!s) wn_host_fail("netCall: WRITE to a handle that is not an open socket");
      if (s->tls) {
        int32_t r = s->tls->write(s, w_hostmem + P, (size_t)(uint32_t)len);
        if (r == 1) s->pending_write = 1;
        sock_update(s);
        return r;
      }
      if (s->out.n > s->out_off) wn_host_fail("netCall: a WRITE while one is pending");
      s->out.n = s->out_off = 0;
      wn_buf_put(&s->out, w_hostmem + P, (size_t)(uint32_t)len);
      int r = out_flush(s);
      if (r < 0) {
        s->out.n = s->out_off = 0;
        return r;
      }
      if (r == 1) s->pending_write = 1;
      sock_update(s);
      return r;
    }
    case 6: { /* SHUTDOWN */
      WnSock *s = wn_sock_get(h);
      if (!s) wn_host_fail("netCall: SHUTDOWN of a handle that is not an open socket");
      if (s->shut || s->connecting) return -ENOTCONN;
      s->shut = 1;
      if (s->tls && s->tls->shutdown) s->tls->shutdown(s);
      else wn_sock_shutdown_after_drain(s);
      sock_update(s);
      return 0;
    }
    case 7: { /* CLOSE */
      WnSock *s = sock_of(h);
      if (!s || s->kind == K_RESOLVE) wn_host_fail("netCall: CLOSE of a handle that is not open");
      wn_ev_purge(s->kind == K_SERVER ? purge_server : is_handle_ev, (void *)(uintptr_t)h);
      sock_destroy(s);
      return 0;
    }
    case 8: { /* NODELAY */
      WnSock *s = wn_sock_get(h);
      if (!s) wn_host_fail("netCall: NODELAY of a handle that is not an open socket");
      int on = x != 0;
      setsockopt(s->io.fd, IPPROTO_TCP, TCP_NODELAY, &on, sizeof on);
      return 0;
    }
    case 9: { /* RESOLVE */
      Lookup *l = calloc(1, sizeof *l);
      if (!l) abort();
      l->family = (int)wn_rd32(P);
      l->hints = (int)wn_rd32(P + 4);
      uint32_t off = P + 8;
      l->name = wn_read_run(&off, NULL);
      WnSock *s = sock_new(K_RESOLVE, -1);
      l->s = s;
      wn_ev_hold(1);
      pthread_t th;
      pthread_attr_t at;
      pthread_attr_init(&at);
      pthread_attr_setdetachstate(&at, PTHREAD_CREATE_DETACHED);
      if (pthread_create(&th, &at, lookup_thread, l) != 0) wn_host_fail("netCall: cannot start a lookup thread");
      pthread_attr_destroy(&at);
      return (int32_t)s->handle;
    }
    case 20: { /* UDP_BIND */
      uint32_t port = wn_rd32(P), family = wn_rd32(P + 4);
      uint32_t off = P + 8;
      char *addr = wn_read_run(&off, NULL);
      uint32_t flags = wn_rd32(off);
      struct sockaddr_storage ss;
      socklen_t sl;
      int bad = make_addr(addr, port, family, &ss, &sl);
      free(addr);
      if (bad) return -EINVAL;
      int fd = socket(ss.ss_family, SOCK_DGRAM | SOCK_NONBLOCK | SOCK_CLOEXEC, 0);
      if (fd < 0) return -errno;
      if (flags & 1) {
        int on = 1;
        setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &on, sizeof on);
      }
      if (bind(fd, (struct sockaddr *)&ss, sl) != 0) {
        int e = errno;
        close(fd);
        return -e;
      }
      WnSock *s = sock_new(K_UDP, fd);
      s->io.cb = udp_ready;
      bound_reply(P, fd);
      sock_update(s);
      return (int32_t)s->handle;
    }
    case 21: { /* UDP_CONNECT */
      WnSock *s = sock_of(h);
      if (!s || s->kind != K_UDP) wn_host_fail("netCall: UDP_CONNECT of a handle that is not a UDP socket");
      uint32_t port = wn_rd32(P), family = wn_rd32(P + 4);
      uint32_t off = P + 8;
      char *addr = wn_read_run(&off, NULL);
      struct sockaddr_storage ss;
      socklen_t sl;
      int bad = make_addr(addr, port, family, &ss, &sl);
      free(addr);
      if (bad) return -EINVAL;
      if (connect(s->io.fd, (struct sockaddr *)&ss, sl) != 0) return -errno;
      bound_reply(P, s->io.fd);
      return 0;
    }
    case 22: { /* UDP_SEND */
      WnSock *s = sock_of(h);
      if (!s || s->kind != K_UDP) wn_host_fail("netCall: UDP_SEND to a handle that is not a UDP socket");
      uint32_t port = wn_rd32(P), family = wn_rd32(P + 4);
      uint32_t off = P + 8;
      size_t al;
      char *addr = wn_read_run(&off, &al);
      uint32_t n = wn_rd32(off);
      const uint8_t *data = w_hostmem + off + 4;
      struct sockaddr_storage ss;
      socklen_t sl = 0;
      if (al > 0 && make_addr(addr, port, family, &ss, &sl) != 0) {
        free(addr);
        return -EINVAL;
      }
      free(addr);
      if (!s->udpq) {
        ssize_t w = sl ? sendto(s->io.fd, data, n, 0, (struct sockaddr *)&ss, sl) : send(s->io.fd, data, n, 0);
        if (w >= 0) return 0;
        if (errno != EAGAIN && errno != EWOULDBLOCK) return -errno;
      }
      UdpOut *u = malloc(sizeof *u + n);
      if (!u) abort();
      u->next = NULL;
      u->n = n;
      u->salen = sl;
      if (sl) memcpy(&u->sa, &ss, sizeof ss);
      memcpy(u->data, data, n);
      UdpOut **pp = &s->udpq;
      while (*pp) pp = &(*pp)->next;
      *pp = u;
      wn_io_want(&s->io, EPOLLIN | EPOLLOUT);
      return 0;
    }
    case 23: { /* UDP_RECV_START: UDP_BIND already receives */
      WnSock *s = sock_of(h);
      if (!s || s->kind != K_UDP) wn_host_fail("netCall: UDP_RECV_START of a handle that is not a UDP socket");
      return 0;
    }
    default:
      wn_host_fail("netCall: an op outside the contract");
  }
}
