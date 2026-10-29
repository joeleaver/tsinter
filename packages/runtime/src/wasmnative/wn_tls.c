/* The native runner's TLS engine (native-runner phase N1; OpenSSL unit
 * O3): abi.ts's `tlsCall` on Node's own OpenSSL (3.5.7, the vendored
 * library backend/openssl-build.ts builds), driven as Node's C++ drives it
 * — transcribed from Node v24.18.1's src/crypto/crypto_context.cc
 * (SecureContext: Init, SetCACert, AddCert and its
 * SSL_CTX_use_certificate_chain, SetKey, SetRootCerts) and
 * src/crypto/crypto_tls.cc (TLSWrap: InitSSL, the always-accepting
 * VerifyCallback, ClearOut / ClearIn / EncOut over two memory BIOs,
 * OnStreamRead, DoWrite, DoShutdown, the SSL error's message and code).
 * Every Node behaviour above that C++ (options, events, socket.authorized,
 * the verification codes' texts, the host-name check, the CA store's
 * strings) is the module's (tls.ts, tls-x509.ts); the host keeps contexts
 * (Node's SecureContexts: wn_trust.c), secures an open netCall socket and
 * REPORTS the verdict OpenSSL reached (SSL_get_verify_result) — it never
 * fails a handshake over it, never checks a name, never asks a client for
 * a certificate.
 *
 * A secured socket keeps wn_net.c's descriptor, outbound buffer and read
 * gating (WnTlsOps): what the descriptor reads (libuv's 64 KiB reads, at
 * most 32 per readiness, none after a short one) goes into the SSL's
 * input BIO and through TLSWrap's cycle; its plaintext is queued as DATA —
 * held while the module does not read — and the output BIO's records go
 * out through the socket's outbound buffer. After the handshake the
 * descriptor is read only while the module reads (Node's TLSWrap passes
 * readStop down to the socket): what the peer sends meanwhile waits in the
 * kernel, back-pressuring it.
 *
 * SEMANTICS.md S117 (g). */
#define _GNU_SOURCE
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/epoll.h>
#include <sys/socket.h>
#include <unistd.h>

#include <openssl/bio.h>
#include <openssl/err.h>
#include <openssl/pem.h>
#include <openssl/ssl.h>
#include <openssl/x509.h>

#include "wn_host.h"
#include "wn_net.h"
#include "wn_trust.h"

enum { EV_DATA = 3, EV_EOF = 4, EV_READ_ERROR = 5, EV_WRITE_DONE = 6, EV_SECURE = 10, EV_TLS_ERROR = 11 };

/* ── contexts (SecureContext) ─────────────────────────────────────────── */
typedef struct {
  SSL_CTX *sc;
} Ctx;
static Ctx **ctxs;
static int n_ctxs;

/* NoPasswordCallback */
static int no_password(char *buf, int size, int rwflag, void *u) {
  (void)buf, (void)size, (void)rwflag, (void)u;
  return 0;
}
/* crypto_util.cc PasswordCallback with an empty passphrase (SetKey's
 * ByteSource when the module passes none): an empty password */
static int empty_password(char *buf, int size, int rwflag, void *u) {
  (void)buf, (void)size, (void)rwflag, (void)u;
  return 0;
}

/* ThrowCryptoError(err): -1, then over ptr the message (ERR_error_string_n
 * of the error) and the code error::Decorate gives it */
static int32_t crypto_fail(uint32_t ptr, unsigned long err) {
  char msg[128] = {0};
  ERR_error_string_n(err, msg, sizeof msg);
  char code[160];
  wn_ossl_err_code(err, code, sizeof code);
  ERR_clear_error();
  WnBuf b = {0};
  wn_buf_run8(&b, msg, strlen(msg));
  wn_buf_run8(&b, code, strlen(code));
  memcpy(w_hostmem + ptr, b.p, b.n);
  wn_buf_free(&b);
  return -1;
}

/* the PEM blob at ptr in a memory BIO (Node's LoadBIO) */
static BIO *blob_bio(uint32_t ptr) {
  uint32_t len = wn_rd32(ptr);
  BIO *bio = BIO_new(BIO_s_mem());
  if (!bio) abort();
  if (len && BIO_write(bio, w_hostmem + ptr + 4, (int)len) != (int)len) abort();
  return bio;
}

/* crypto_context.cc SSL_CTX_use_certificate_chain (Node's own, "taken from
 * OpenSSL"): the first certificate, then the rest as the chain; the
 * issuer it looks up only feeds OCSP stapling */
static int use_certificate_chain(SSL_CTX *sc, BIO *in) {
  ERR_clear_error();
  X509 *x = PEM_read_bio_X509_AUX(in, NULL, no_password, NULL);
  if (!x) return 0;
  STACK_OF(X509) *extra = sk_X509_new_null();
  if (!extra) abort();
  X509 *e;
  while ((e = PEM_read_bio_X509(in, NULL, no_password, NULL)) != NULL) sk_X509_push(extra, e);
  unsigned long err = ERR_peek_last_error();
  int ret = 0;
  if (ERR_GET_LIB(err) == ERR_LIB_PEM && ERR_GET_REASON(err) == PEM_R_NO_START_LINE) {
    ERR_clear_error();
    ret = SSL_CTX_use_certificate(sc, x);
    if (ret) {
      SSL_CTX_clear_extra_chain_certs(sc);
      for (int i = 0; i < sk_X509_num(extra); i++)
        if (!SSL_CTX_add1_chain_cert(sc, sk_X509_value(extra, i))) {
          ret = 0;
          break;
        }
    }
  }
  sk_X509_pop_free(extra, X509_free);
  X509_free(x);
  return ret;
}

/* ── secured sockets (TLSWrap) ────────────────────────────────────────── */
typedef struct {
  SSL *ssl;
  BIO *enc_in, *enc_out;
  int server;
  int established, dead, eof, shutdown;
  /* plaintext a WRITE handed over that SSL_write has not taken yet
   * (pending_cleartext_input_): taken by ClearIn */
  WnBuf wp;
  WnSock *sock;
  /* TLSWrap's write_size_: records went out in one write, and EncOut
   * writes nothing more until that write completes — a write the kernel
   * took at once completes in a native SetImmediate, which Node runs at
   * the start of the check phase, ahead of the program's setImmediate
   * callbacks (here: when the module's poll phase ends — its evPoll
   * answering no more events, wn_ev.c), one that waited once the outbound
   * buffer drained. What OpenSSL produces meanwhile gathers in the output BIO and
   * leaves as ONE write then, so the segments on the wire are Node's
   * (board #336: a record per write let Nagle hold the next one for the
   * peer's delayed ACK). */
  int gated;
  /* the handshake completed in this read's cycle: Node runs the module's
   * 'secure' / 'secureConnect' / 'secureConnection' listeners INSIDE that
   * cycle, before its EncOut, so what they write leaves with the
   * handshake's last flight; held until the module writes or its poll
   * phase ends (a socket destroyed meanwhile sends none of it, as Node's
   * listener destroying it does) */
  int held;
  int queued; /* on the release list */
} Tls;

static Tls **rel;
static size_t n_rel, cap_rel;
static void release_later(Tls *t) {
  if (t->queued) return;
  if (n_rel == cap_rel) {
    cap_rel = cap_rel ? cap_rel * 2 : 16;
    rel = realloc(rel, cap_rel * sizeof *rel);
    if (!rel) abort();
  }
  rel[n_rel++] = t;
  t->queued = 1;
}

static int tls_index = -1;

/* crypto_tls.cc VerifyCallback: verification continues whatever it meets;
 * the verdict is SSL_get_verify_result's, judged by the module */
static int verify_continue(int preverify_ok, X509_STORE_CTX *ctx) {
  (void)preverify_ok, (void)ctx;
  return 1;
}

/* TLSWrap::SelectSNIContextCallback with no SNI context (the module offers
 * no SNICallback): the name is not acknowledged */
static int sni_noack(SSL *s, int *ad, void *arg) {
  (void)s, (void)ad, (void)arg;
  return SSL_TLSEXT_ERR_NOACK;
}

/* EncOut: the records OpenSSL produced, out through the socket's buffer
 * as one write — unless a write is still in flight (gated) or the
 * handshake's last flight waits for the module (held); `force`
 * (close_notify, an alert before an error, the transport's end) writes
 * regardless. A transport failure is the read side's to report (0, or
 * -errno). */
static int enc_out_x(WnSock *s, int force) {
  Tls *t = s->tctx;
  if (!force && (t->gated || t->held)) return 0;
  char *p = NULL;
  long n = BIO_get_mem_data(t->enc_out, &p);
  if (n <= 0) return 0;
  int r = 0;
  if (!s->closed) {
    r = wn_sock_raw_out(s, p, (size_t)n);
    t->gated = 1;
    t->held = 0;
    release_later(t);
  }
  (void)BIO_reset(t->enc_out);
  return r;
}
static int enc_out(WnSock *s) { return enc_out_x(s, 0); }

/* SSLInfoCallback's SSL_CB_HANDSHAKE_DONE: the module's onhandshakedone —
 * the SECURE event, the verdict and the peer's certificate */
static void info_cb(const SSL *ssl, int where, int ret) {
  (void)ret;
  if (!(where & SSL_CB_HANDSHAKE_DONE)) return;
  WnSock *s = SSL_get_ex_data(ssl, tls_index);
  Tls *t = s->tctx;
  if (t->established) return;
  t->established = 1;
  WnBuf b = {0};
  if (t->server) {
    wn_buf_u32(&b, 0);
    wn_buf_blob(&b, NULL, 0);
  } else {
    wn_buf_u32(&b, (uint32_t)SSL_get_verify_result(ssl));
    X509 *peer = SSL_get0_peer_certificate(ssl);
    unsigned char *der = NULL;
    int len = peer ? i2d_X509(peer, &der) : 0;
    wn_buf_blob(&b, der, len > 0 ? (size_t)len : 0);
    OPENSSL_free(der);
  }
  wn_sock_push(s, EV_SECURE, 0, b.p, (uint32_t)b.n);
  wn_buf_free(&b);
}

/* a TLS failure (ClearOut's SSL_ERROR_SSL): the message is GetBIOError's,
 * the code "ERR_SSL_" + the reason of the first error, upper-cased */
static void tls_error(WnSock *s, unsigned long first) {
  Tls *t = s->tctx;
  const char *rs = ERR_reason_error_string(first);
  char *msg = wn_ossl_bio_error();
  t->dead = 1;
  s->tls_reads = 0;
  /* a reason Node cannot name sets no code (Node returns before onerror) */
  if (!rs) {
    free(msg);
    return;
  }
  char code[160];
  size_t k = (size_t)snprintf(code, sizeof code, "ERR_SSL_");
  for (size_t i = 0; rs[i] && k + 1 < sizeof code; i++) code[k++] = rs[i] == ' ' ? '_' : (rs[i] >= 'a' && rs[i] <= 'z' ? (char)(rs[i] - 32) : rs[i]);
  code[k] = 0;
  /* a TLS alert stored in the output is flushed before the error */
  enc_out_x(s, 1);
  WnBuf b = {0};
  wn_buf_run8(&b, msg, strlen(msg));
  wn_buf_run8(&b, code, strlen(code));
  wn_sock_push(s, EV_TLS_ERROR, 0, b.p, (uint32_t)b.n);
  wn_buf_free(&b);
  free(msg);
}

/* ClearOut: SSL_read until it has nothing, the plaintext queued as DATA */
static void clear_out(WnSock *s) {
  Tls *t = s->tctx;
  if (t->eof || t->dead || s->closed) return;
  static char out[16384];
  int n;
  ERR_set_mark();
  for (;;) {
    n = SSL_read(t->ssl, out, sizeof out);
    if (n <= 0) break;
    wn_sock_queue_read(s, EV_DATA, 0, out, (uint32_t)n);
    if (s->closed) {
      ERR_pop_to_mark();
      return;
    }
  }
  int err = SSL_get_error(t->ssl, n);
  if (err == SSL_ERROR_ZERO_RETURN) {
    ERR_pop_to_mark();
    t->eof = 1;
    s->tls_reads = 0;
    wn_sock_queue_read(s, EV_EOF, 0, NULL, 0);
    return;
  }
  if (err == SSL_ERROR_SSL || err == SSL_ERROR_SYSCALL) {
    unsigned long first = ERR_peek_error();
    if (first == 0) {
      ERR_pop_to_mark();
      return;
    }
    tls_error(s, first);
    ERR_pop_to_mark();
    return;
  }
  ERR_pop_to_mark();
}

/* ClearIn: the plaintext that waited for the handshake; a WRITE whose
 * plaintext is all taken and whose records are all sent completes */
static void clear_in(WnSock *s) {
  Tls *t = s->tctx;
  if (t->dead || t->wp.n == 0) return;
  ERR_set_mark();
  int w = SSL_write(t->ssl, t->wp.p, (int)t->wp.n);
  if (w > 0) {
    t->wp.n = 0;
    ERR_pop_to_mark();
    return;
  }
  int err = SSL_get_error(t->ssl, w);
  ERR_pop_to_mark();
  if (err == SSL_ERROR_SSL || err == SSL_ERROR_SYSCALL) {
    t->wp.n = 0;
    if (s->pending_write) {
      s->pending_write = 0;
      wn_sock_push(s, EV_WRITE_DONE, -EPROTO, NULL, 0);
    }
  }
}

/* a WRITE whose plaintext was taken and whose records are out: done */
static void write_progress(WnSock *s) {
  Tls *t = s->tctx;
  if (s->pending_write && t->wp.n == 0 && BIO_ctrl_pending(t->enc_out) == 0 && !wn_sock_out_pending(s)) {
    s->pending_write = 0;
    wn_sock_push(s, EV_WRITE_DONE, 0, NULL, 0);
  }
}

/* TLSWrap::Cycle */
static void cycle(WnSock *s) {
  clear_in(s);
  clear_out(s);
  if (!s->closed) enc_out(s);
}

/* a transport end of file / failure: ClearOut first (an error is emitted
 * only after all data was read), then the net event, as a plain socket's */
static void raw_end(WnSock *s, int e) {
  Tls *t = s->tctx;
  clear_out(s);
  if (s->closed) return;
  enc_out_x(s, 1);
  s->tls_reads = 0;
  if (t->eof) return; /* after close_notify everything is ignored */
  t->eof = 1;
  t->dead = 1;
  if (e) wn_sock_queue_read(s, EV_READ_ERROR, -e, NULL, 0);
  else wn_sock_queue_read(s, EV_EOF, 0, NULL, 0);
}

/* the descriptor is readable: uv__read's reads into the input BIO, each
 * cycled (OnStreamRead) */
static void t_readable(WnSock *s) {
  Tls *t = s->tctx;
  static uint8_t buf[65536];
  for (int count = 0; count < 32 && !t->dead && !t->eof && !s->closed; count++) {
    if (t->established && !s->reading) {
      s->tls_reads = 0;
      break;
    }
    ssize_t n = recv(s->io.fd, buf, sizeof buf, 0);
    if (n < 0) {
      if (errno == EINTR) continue;
      if (errno == EAGAIN || errno == EWOULDBLOCK) break;
      raw_end(s, errno);
      break;
    }
    if (n == 0) {
      raw_end(s, 0);
      break;
    }
    if (BIO_write(t->enc_in, buf, (int)n) != (int)n) abort();
    int was = t->established;
    clear_in(s);
    clear_out(s);
    /* the cycle that completed the handshake: its flight waits for the
     * module's listeners (held) */
    if (!was && t->established && !s->closed) {
      t->held = 1;
      release_later(t);
    }
    if (!s->closed) enc_out(s);
    if ((size_t)n < sizeof buf) break;
  }
  if (!s->closed) {
    write_progress(s);
    wn_sock_update(s);
  }
}
/* the outbound buffer drained some; once all of it, the write completed
 * (OnStreamAfterWrite): ClearIn, EncOut */
static void t_writable(WnSock *s) {
  Tls *t = s->tctx;
  if (wn_sock_out_pending(s)) return;
  t->gated = 0;
  cycle(s);
  if (!s->closed) write_progress(s);
}
static int t_busy(WnSock *s) {
  Tls *t = s->tctx;
  return t->wp.n != 0 || BIO_ctrl_pending(t->enc_out) != 0;
}
/* a client secured mid-connect: TLSWrap::Start — ClearOut (the
 * ClientHello), EncOut */
static void t_connected(WnSock *s) { cycle(s); }
/* DoWrite: 0 written, 1 pending (WRITE_DONE), -errno */
static int32_t t_write(WnSock *s, const uint8_t *p, size_t n) {
  Tls *t = s->tctx;
  if (t->dead) return -EPIPE;
  /* the module's write runs where Node's listener would: inside the
   * cycle, before its EncOut */
  t->held = 0;
  if (n == 0) {
    /* an empty write drives the stream: ClearOut, then EncOut */
    clear_out(s);
    int r = enc_out(s);
    if (r < 0) return r;
    return wn_sock_out_pending(s) ? 1 : 0;
  }
  ERR_set_mark();
  int w = SSL_write(t->ssl, p, (int)n);
  if (w <= 0) {
    int err = SSL_get_error(t->ssl, w);
    ERR_pop_to_mark();
    if (err == SSL_ERROR_SSL || err == SSL_ERROR_SYSCALL) return -EPROTO;
    /* saved for ClearIn (the handshake has not finished) */
    wn_buf_put(&t->wp, p, n);
    int r = enc_out(s);
    return r < 0 ? r : 1;
  }
  ERR_pop_to_mark();
  int r = enc_out(s);
  if (r < 0) return r;
  return wn_sock_out_pending(s) || BIO_ctrl_pending(t->enc_out) != 0 ? 1 : 0;
}
/* DoShutdown: close_notify (SSL_shutdown, twice when the first answers
 * 0), EncOut, then the write side */
static void t_shutdown(WnSock *s) {
  Tls *t = s->tctx;
  if (!t->dead) {
    ERR_set_mark();
    if (SSL_shutdown(t->ssl) == 0) SSL_shutdown(t->ssl);
    ERR_pop_to_mark();
  }
  t->shutdown = 1;
  enc_out_x(s, 1);
  wn_sock_shutdown_after_drain(s);
}
static void t_read_start(WnSock *s) {
  Tls *t = s->tctx;
  if (t->dead || t->eof) return;
  s->tls_reads = 1;
  wn_sock_update(s);
}
static void t_read_stop(WnSock *s) {
  Tls *t = s->tctx;
  if (t->established && !t->dead) s->tls_reads = 0;
}
static void t_free(WnSock *s) {
  Tls *t = s->tctx;
  if (!t) return;
  if (t->queued)
    for (size_t i = 0; i < n_rel; i++)
      if (rel[i] == t) {
        rel[i] = rel[--n_rel];
        break;
      }
  SSL_free(t->ssl); /* and its BIOs */
  wn_buf_free(&t->wp);
  free(t);
  s->tctx = NULL;
}
/* the module's poll phase ended (wn_ev.c host_evPoll): Node's check phase
 * begins with its native immediates, among them the one completing a write
 * the kernel took at once — the gate opens and what gathered goes out
 * (OnStreamAfterWrite: EncOut, then the write's callback); a held flight
 * goes too. All of it before the program's own setImmediate callbacks and
 * timers run. */
static void tls_release(void) {
  Tls **v = rel;
  size_t n = n_rel;
  rel = NULL;
  n_rel = cap_rel = 0;
  for (size_t i = 0; i < n; i++) v[i]->queued = 0;
  for (size_t i = 0; i < n; i++) {
    Tls *t = v[i];
    if (t == NULL) continue;
    WnSock *s = t->sock;
    if (s->closed || s->tctx != t) continue;
    t->held = 0;
    if (wn_sock_out_pending(s)) continue; /* it completes as it drains */
    t->gated = 0;
    enc_out(s);
    if (!s->closed) {
      write_progress(s);
      wn_sock_update(s);
    }
  }
  free(v);
}
/* something waits for the next poll phase's end: the host's wait must
 * not block (Node's pending native immediate keeps its poll from blocking) */
static int tls_due(void) {
  for (size_t i = 0; i < n_rel; i++) {
    Tls *t = rel[i];
    if (t->held || BIO_ctrl_pending(t->enc_out) != 0) return 1;
  }
  return 0;
}
extern void (*wn_tls_release)(void); /* wn_ev.c */
extern int (*wn_tls_due)(void);

static const WnTlsOps OPS = {t_readable, t_writable, t_connected, t_write, t_shutdown, t_read_start, t_read_stop, t_busy, t_free};

static int32_t secure(uint32_t ptr, int32_t h) {
  WnSock *s = wn_sock_get(h);
  if (!s || s->tls) wn_host_fail("tlsCall: SECURE of a handle that is not an open plain socket");
  uint32_t cid = wn_rd32(ptr), mode = wn_rd32(ptr + 4);
  uint32_t off = ptr + 8;
  size_t snl;
  char *sni = wn_read_run(&off, &snl);
  if (cid < 1 || (int)cid > n_ctxs) wn_host_fail("tlsCall: SECURE with an unknown context");
  SSL_CTX *sc = ctxs[cid - 1]->sc;
  if (tls_index < 0) tls_index = SSL_get_ex_new_index(0, NULL, NULL, NULL, NULL);
  Tls *t = calloc(1, sizeof *t);
  if (!t) abort();
  t->server = mode == 1;
  t->sock = s;
  /* TLSWrap: SecureContext::CreateSSL, then InitSSL */
  t->ssl = SSL_new(sc);
  if (!t->ssl) wn_host_fail("tlsCall: SSL_new failed");
  t->enc_in = BIO_new(BIO_s_mem());
  t->enc_out = BIO_new(BIO_s_mem());
  if (!t->enc_in || !t->enc_out) abort();
  /* NodeBIO: an empty read is "retry", never an end */
  BIO_set_mem_eof_return(t->enc_in, -1);
  BIO_set_mem_eof_return(t->enc_out, -1);
  SSL_set_bio(t->ssl, t->enc_in, t->enc_out);
  SSL_set_verify(t->ssl, SSL_VERIFY_NONE, verify_continue);
  SSL_set_mode(t->ssl, SSL_MODE_RELEASE_BUFFERS);
  SSL_set_mode(t->ssl, SSL_MODE_AUTO_RETRY);
  SSL_set_ex_data(t->ssl, tls_index, s);
  SSL_set_info_callback(t->ssl, info_cb);
  wn_ossl_socket_init(t->ssl);
  if (t->server) {
    SSL_CTX_set_tlsext_servername_callback(sc, sni_noack);
    SSL_set_accept_state(t->ssl);
  } else {
    if (snl) {
      /* TLSWrap::SetServername ignores a refusal (a name past 255 bytes
       * goes without SNI) */
      ERR_set_mark();
      SSL_set_tlsext_host_name(t->ssl, sni);
      ERR_pop_to_mark();
    }
    SSL_set_connect_state(t->ssl);
  }
  free(sni);
  wn_tls_release = tls_release;
  wn_tls_due = tls_due;
  s->tls = &OPS;
  s->tctx = t;
  s->tls_reads = 1;
  /* a client starts its handshake (TLSWrap::Start) once connected */
  if (!t->server && !s->connecting) cycle(s);
  wn_sock_update(s);
  return 0;
}

/* CA_STORE: 'system' (1) or 'extra' (2, NODE_EXTRA_CA_CERTS) as DER blobs,
 * Node's loaded certificates in its order */
static int32_t ca_store(uint32_t ptr, uint32_t cap, int32_t which) {
  size_t count = 0;
  X509 *const *v = which == 1 ? wn_trust_system(&count) : wn_trust_extra(&count);
  WnBuf b = {0};
  wn_buf_u32(&b, (uint32_t)count);
  for (size_t i = 0; i < count; i++) {
    unsigned char *der = NULL;
    int len = i2d_X509(v[i], &der);
    if (len < 0) wn_host_fail("tlsCall: a store certificate could not be encoded");
    wn_buf_blob(&b, der, (size_t)len);
    OPENSSL_free(der);
  }
  int32_t n = (int32_t)b.n;
  if (b.n > cap) {
    wn_buf_free(&b);
    return -n;
  }
  memcpy(w_hostmem + ptr, b.p, b.n);
  wn_buf_free(&b);
  return n;
}

static Ctx *ctx_of(int32_t h, const char *what) {
  if (h < 1 || h > n_ctxs) wn_host_fail(what);
  return ctxs[h - 1];
}

int32_t host_tlsCall(int32_t op, int32_t ptr, int32_t len, int32_t h, int32_t x) {
  uint32_t P = (uint32_t)ptr;
  switch (op) {
    case 1: { /* CTX_NEW: new SecureContext, init, configSecureContext's defaults */
      Ctx *c = calloc(1, sizeof *c);
      if (!c) abort();
      c->sc = wn_ossl_ctx_new();
      ctxs = realloc(ctxs, sizeof *ctxs * (size_t)(n_ctxs + 1));
      if (!ctxs) abort();
      ctxs[n_ctxs++] = c;
      return n_ctxs;
    }
    case 2: /* CTX_ROOTS: addRootCerts */
      wn_ossl_ctx_roots(ctx_of(h, "tlsCall: CTX_ROOTS of a handle that is not a context")->sc);
      return 0;
    case 3: { /* CTX_ADD_CA: SecureContext::SetCACert */
      SSL_CTX *sc = ctx_of(h, "tlsCall: material for a handle that is not a context")->sc;
      BIO *bio = blob_bio(P);
      X509 *xc;
      while ((xc = PEM_read_bio_X509_AUX(bio, NULL, no_password, NULL)) != NULL) {
        if (X509_STORE_add_cert(wn_ossl_ctx_own_store(sc), xc) != 1 || SSL_CTX_add_client_CA(sc, xc) != 1)
          wn_host_fail("tlsCall: CTX_ADD_CA could not add a certificate");
        X509_free(xc);
      }
      BIO_free(bio);
      ERR_clear_error();
      return 0;
    }
    case 4: { /* CTX_SET_CERT: SecureContext::AddCert */
      SSL_CTX *sc = ctx_of(h, "tlsCall: material for a handle that is not a context")->sc;
      BIO *bio = blob_bio(P);
      int ok = use_certificate_chain(sc, bio);
      BIO_free(bio);
      if (!ok) return crypto_fail(P, ERR_get_error());
      ERR_clear_error();
      return 0;
    }
    case 5: { /* CTX_SET_KEY: SecureContext::SetKey (no passphrase) */
      SSL_CTX *sc = ctx_of(h, "tlsCall: material for a handle that is not a context")->sc;
      BIO *bio = blob_bio(P);
      EVP_PKEY *key = PEM_read_bio_PrivateKey(bio, NULL, empty_password, NULL);
      BIO_free(bio);
      if (!key) return crypto_fail(P, ERR_get_error());
      int ok = SSL_CTX_use_PrivateKey(sc, key);
      EVP_PKEY_free(key);
      if (!ok) return crypto_fail(P, ERR_get_error());
      ERR_clear_error();
      return 0;
    }
    case 6:
      return secure(P, h);
    case 7:
      wn_ossl_init();
      return ca_store(P, (uint32_t)len, x);
    default:
      wn_host_fail("tlsCall: an op outside the contract");
  }
}
