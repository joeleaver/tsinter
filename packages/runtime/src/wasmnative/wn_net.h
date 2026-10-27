/* The net unit's socket, shared with the TLS unit (native-runner N1):
 * wn_net.c owns the descriptor, the outbound buffer and the module's read
 * gating; a secured socket carries wn_tls.c's ops, so its reads decrypt
 * and its writes encrypt while netCall's contract stays the same. */
#ifndef WN_NET_H
#define WN_NET_H

#include <sys/socket.h>

#include "wn_host.h"

typedef struct WnSock WnSock;

typedef struct {
  /* the descriptor is readable: read ciphertext, drive the handshake,
   * queue plaintext with wn_sock_queue_read */
  void (*readable)(WnSock *s);
  /* the outbound buffer drained some: resume what waited on it */
  void (*writable)(WnSock *s);
  /* a plain socket's connect completed (a client secured mid-connect) */
  void (*connected)(WnSock *s);
  /* netCall WRITE's plaintext: 0 written, 1 pending (WRITE_DONE), -errno */
  int32_t (*write)(WnSock *s, const uint8_t *p, size_t n);
  /* netCall SHUTDOWN: close_notify, then the write side */
  void (*shutdown)(WnSock *s);
  /* netCall READ_START: plaintext the engine already holds can flow */
  void (*read_start)(WnSock *s);
  void (*free)(WnSock *s);
} WnTlsOps;

typedef struct UdpOut {
  struct UdpOut *next;
  struct sockaddr_storage sa;
  socklen_t salen;
  uint32_t n;
  uint8_t data[];
} UdpOut;

struct WnSock {
  int kind;
  uint32_t handle;
  WnIo io;
  int connecting, connected, reading, rd_done, closed;
  int shut, shut_pending, pending_write;
  WnEv *held, **held_tail;
  WnBuf out;
  size_t out_off;
  UdpOut *udpq;
  /* TLS (wn_tls.c) */
  const WnTlsOps *tls;
  void *tctx;
  int tls_reads; /* the engine reads the descriptor (handshake, records) */
};

WnSock *wn_sock_get(int32_t h);
void wn_sock_push(WnSock *s, uint32_t kind, int32_t a, const void *p, uint32_t n);
void wn_sock_queue_read(WnSock *s, uint32_t kind, int32_t a, const void *p, uint32_t n);
int wn_sock_raw_out(WnSock *s, const void *p, size_t n);
int wn_sock_out_pending(WnSock *s);
void wn_sock_shutdown_after_drain(WnSock *s);
void wn_sock_update(WnSock *s);

#endif
