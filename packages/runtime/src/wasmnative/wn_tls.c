/* The native runner's TLS engine (native-runner phase N1): abi.ts's
 * `tlsCall` over vendored mbedTLS 3.6 — the same engine the native lane's
 * scr_tls.c uses, recut to the contract's facts-only shape — with the
 * trust and the verdict on Node's own OpenSSL (OpenSSL unit O2: each
 * context is a Node SecureContext, an SSL_CTX built as Node builds one,
 * whose store is Node's — wn_trust.c — and the peer's chain is judged by
 * OpenSSL's X509_verify_cert exactly as OpenSSL's handshake judges it).
 * Every Node behaviour (options, events, socket.authorized, the
 * verification codes' texts, the host-name check, the CA store's strings)
 * is the module's (tls.ts, tls-x509.ts); the host keeps contexts (trust,
 * certificate, key), secures an open netCall socket, VERIFIES the peer's
 * chain and REPORTS the result in OpenSSL's X509_V_ERR numbering — it
 * never fails a handshake over it, never checks a name, never asks a
 * client for a certificate.
 *
 * A secured socket keeps wn_net.c's descriptor, outbound buffer and read
 * gating (WnTlsOps): the engine reads the descriptor from SECURE on
 * (its handshake, then records), its plaintext is queued as DATA — held
 * while the module does not read — and its writes go out as records
 * through the socket's outbound buffer.
 *
 * What an mbedTLS engine cannot say as OpenSSL does (a material error's
 * text, a protocol failure's, a verdict OpenSSL would split further) is
 * SEMANTICS.md S090 (b) and S117 (g). */
#define _GNU_SOURCE
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/epoll.h>
#include <sys/socket.h>
#include <unistd.h>

#include "mbedtls/ctr_drbg.h"
#include "mbedtls/entropy.h"
#include "mbedtls/error.h"
#include "mbedtls/net_sockets.h"
#include "mbedtls/pk.h"
#include "mbedtls/ssl.h"
#include "mbedtls/x509_crt.h"
#include "psa/crypto.h"

#include <openssl/bio.h>
#include <openssl/pem.h>
#include <openssl/ssl.h>
#include <openssl/x509.h>

#include "wn_host.h"
#include "wn_net.h"
#include "wn_trust.h"

enum { EV_DATA = 3, EV_EOF = 4, EV_READ_ERROR = 5, EV_SECURE = 10, EV_TLS_ERROR = 11 };

static mbedtls_entropy_context entropy;
static mbedtls_ctr_drbg_context drbg;
static int rng_ready;
static void rng_init(void) {
  if (rng_ready) return;
  psa_crypto_init();
  mbedtls_entropy_init(&entropy);
  mbedtls_ctr_drbg_init(&drbg);
  if (mbedtls_ctr_drbg_seed(&drbg, mbedtls_entropy_func, &entropy, (const unsigned char *)"tsinter-wn-tls", 14) != 0)
    wn_host_fail("tlsCall: the engine's random generator could not be seeded");
  rng_ready = 1;
}

/* the stores are Node's (wn_trust.c, SEMANTICS.md S117 (g)) */

/* ── contexts ─────────────────────────────────────────────────────────── */
typedef struct {
  SSL_CTX *sc; /* Node's SecureContext: the trust (its store) */
  mbedtls_x509_crt cert;
  int has_cert;
  mbedtls_pk_context key;
  int has_key;
} Ctx;
static Ctx **ctxs;
static int n_ctxs;

/* NoPasswordCallback: never a prompt */
static int no_password(char *buf, int size, int rwflag, void *u) {
  (void)buf, (void)size, (void)rwflag, (void)u;
  return 0;
}

/* a material failure: -1, the message's run then the code's run at ptr */
static int32_t fail(uint32_t ptr, const char *msg, const char *code) {
  WnBuf b = {0};
  wn_buf_run8(&b, msg, strlen(msg));
  wn_buf_run8(&b, code, strlen(code));
  memcpy(w_hostmem + ptr, b.p, b.n);
  wn_buf_free(&b);
  return -1;
}
/* a PEM blob, NUL-terminated (mbedTLS's PEM mode counts the NUL) */
static unsigned char *blob_pem(uint32_t ptr, size_t *n) {
  uint32_t len = wn_rd32(ptr);
  unsigned char *b = malloc((size_t)len + 1);
  if (!b) abort();
  memcpy(b, w_hostmem + ptr + 4, len);
  b[len] = 0;
  *n = (size_t)len + 1;
  return b;
}
static int pair_ok(Ctx *c) {
  if (!c->has_cert || !c->has_key) return 1;
  return mbedtls_pk_check_pair(&c->cert.pk, &c->key, mbedtls_ctr_drbg_random, &drbg) == 0;
}

/* ── secured sockets ──────────────────────────────────────────────────── */
typedef struct {
  mbedtls_ssl_config conf;
  mbedtls_ssl_context ssl;
  SSL_CTX *sc; /* the context's trust */
  int server;
  int handshaken, dead, notify;
  /* the raw side read as libuv's uv__read reads it: 64 KiB at a time, at
   * most 32 reads per readiness, and none after a short one (the next
   * iteration's) — the engine consumes these bytes */
  uint8_t *rbuf;
  size_t rlen, roff;
  int reads_left, raw_eof, raw_err;
  /* plaintext a WRITE handed over that the engine has not taken yet (it
   * answered WANT_READ / WANT_WRITE): taken as the engine can */
  WnBuf wp;
  size_t wp_off;
} Tls;

enum { EV_WRITE_DONE = 6 };
static void flush_plain(WnSock *s);

static int bio_send(void *ctx, const unsigned char *buf, size_t len) {
  WnSock *s = ctx;
  if (s->closed) return MBEDTLS_ERR_NET_CONN_RESET;
  int r = wn_sock_raw_out(s, buf, len);
  if (r < 0) return r == -EPIPE || r == -ECONNRESET ? MBEDTLS_ERR_NET_CONN_RESET : MBEDTLS_ERR_NET_SEND_FAILED;
  return (int)len;
}
static int bio_recv(void *ctx, unsigned char *buf, size_t len) {
  WnSock *s = ctx;
  Tls *t = s->tctx;
  if (t->roff == t->rlen) {
    t->roff = t->rlen = 0;
    if (t->raw_err) return MBEDTLS_ERR_NET_RECV_FAILED;
    if (t->raw_eof) return 0;
    if (t->reads_left <= 0) return MBEDTLS_ERR_SSL_WANT_READ;
    if (!t->rbuf) {
      t->rbuf = malloc(65536);
      if (!t->rbuf) abort();
    }
    ssize_t n;
    do n = recv(s->io.fd, t->rbuf, 65536, 0);
    while (n < 0 && errno == EINTR);
    if (n < 0) {
      t->reads_left = 0;
      if (errno == EAGAIN || errno == EWOULDBLOCK) return MBEDTLS_ERR_SSL_WANT_READ;
      t->raw_err = errno;
      return MBEDTLS_ERR_NET_RECV_FAILED;
    }
    if (n == 0) {
      t->raw_eof = 1;
      return 0; /* mbedTLS maps it to CONN_EOF */
    }
    t->rlen = (size_t)n;
    t->reads_left = n < 65536 ? 0 : t->reads_left - 1;
  }
  size_t k = t->rlen - t->roff < len ? t->rlen - t->roff : len;
  memcpy(buf, t->rbuf + t->roff, k);
  t->roff += k;
  return (int)k;
}

/* the verdict on the peer's chain in OpenSSL's X509_V_ERR numbers (abi.ts
 * tlsCall): OpenSSL's, over the chain as the peer sent it, against the
 * context's store (wn_trust.c) — the engine carries the handshake only. A
 * certificate OpenSSL cannot decode is no verdict it could reach:
 * UNSPECIFIED (OpenSSL's handshake fails on it; unit O3) */
static uint32_t verify_code(Tls *t) {
  STACK_OF(X509) *sk = sk_X509_new_null();
  if (!sk) abort();
  long code = 0;
  for (const mbedtls_x509_crt *c = mbedtls_ssl_get_peer_cert(&t->ssl); c && c->raw.p; c = c->next) {
    const unsigned char *p = c->raw.p;
    X509 *x = d2i_X509(NULL, &p, (long)c->raw.len);
    if (!x || p != c->raw.p + c->raw.len) {
      X509_free(x);
      code = X509_V_ERR_UNSPECIFIED;
      break;
    }
    sk_X509_push(sk, x);
  }
  if (code == 0) code = sk_X509_num(sk) ? wn_ossl_verify_chain(t->sc, sk) : X509_V_ERR_UNSPECIFIED;
  sk_X509_pop_free(sk, X509_free);
  return (uint32_t)code;
}

/* an engine failure as OpenSSL would name it (the nearest text) */
static void tls_error(WnSock *s, int r) {
  Tls *t = s->tctx;
  t->dead = 1;
  s->tls_reads = 0;
  const char *msg, *code;
  switch (r) {
    case MBEDTLS_ERR_SSL_INVALID_RECORD:
    case MBEDTLS_ERR_SSL_UNSUPPORTED_EXTENSION:
    case MBEDTLS_ERR_SSL_DECODE_ERROR:
      msg = "error:0A00010B:SSL routines::wrong version number";
      code = "ERR_SSL_WRONG_VERSION_NUMBER";
      break;
    case MBEDTLS_ERR_SSL_HANDSHAKE_FAILURE:
      msg = "error:0A000410:SSL routines::sslv3 alert handshake failure";
      code = "ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE";
      break;
    case MBEDTLS_ERR_SSL_BAD_PROTOCOL_VERSION:
      msg = "error:0A000102:SSL routines::unsupported protocol";
      code = "ERR_SSL_UNSUPPORTED_PROTOCOL";
      break;
    default: {
      static char buf[160];
      char detail[100];
      mbedtls_strerror(r, detail, sizeof detail);
      snprintf(buf, sizeof buf, "error:0A000000:SSL routines::%s", detail);
      msg = buf;
      code = "ERR_SSL_SSL_HANDSHAKE_FAILURE";
    }
  }
  WnBuf b = {0};
  wn_buf_run8(&b, msg, strlen(msg));
  wn_buf_run8(&b, code, strlen(code));
  wn_sock_push(s, EV_TLS_ERROR, 0, b.p, (uint32_t)b.n);
  wn_buf_free(&b);
}

/* a transport failure / end of file: the net events, as a plain socket's */
static void tls_eof(WnSock *s, int r) {
  Tls *t = s->tctx;
  t->dead = 1;
  s->tls_reads = 0;
  if (r == MBEDTLS_ERR_NET_RECV_FAILED) wn_sock_queue_read(s, EV_READ_ERROR, -(t->raw_err ? t->raw_err : EIO), NULL, 0);
  else wn_sock_queue_read(s, EV_EOF, 0, NULL, 0);
}

static void pump(WnSock *s) {
  Tls *t = s->tctx;
  if (t->dead || s->connecting) return;
  if (!t->handshaken) {
    int r = mbedtls_ssl_handshake(&t->ssl);
    if (r == MBEDTLS_ERR_SSL_WANT_READ || r == MBEDTLS_ERR_SSL_WANT_WRITE || r == MBEDTLS_ERR_SSL_ASYNC_IN_PROGRESS) return;
    if (r == MBEDTLS_ERR_SSL_CONN_EOF || r == MBEDTLS_ERR_NET_CONN_RESET || r == MBEDTLS_ERR_NET_RECV_FAILED) {
      tls_eof(s, r);
      return;
    }
    if (r != 0) {
      tls_error(s, r);
      return;
    }
    t->handshaken = 1;
    WnBuf b = {0};
    if (t->server) {
      wn_buf_u32(&b, 0);
      wn_buf_blob(&b, NULL, 0);
    } else {
      wn_buf_u32(&b, verify_code(t));
      const mbedtls_x509_crt *peer = mbedtls_ssl_get_peer_cert(&t->ssl);
      wn_buf_blob(&b, peer ? peer->raw.p : NULL, peer ? peer->raw.len : 0);
    }
    wn_sock_push(s, EV_SECURE, 0, b.p, (uint32_t)b.n);
    wn_buf_free(&b);
  }
  flush_plain(s);
  if (t->dead) return;
  static unsigned char buf[16384];
  for (;;) {
    /* after the handshake the engine reads only while the module does
     * (Node's TLSWrap passes readStop down to the socket): what the peer
     * sends meanwhile waits in the kernel, back-pressuring it */
    if (!s->reading) {
      s->tls_reads = 0;
      wn_sock_update(s);
      return;
    }
    int r = mbedtls_ssl_read(&t->ssl, buf, sizeof buf);
    if (r > 0) {
      wn_sock_queue_read(s, EV_DATA, 0, buf, (uint32_t)r);
      continue;
    }
    if (r == MBEDTLS_ERR_SSL_WANT_READ || r == MBEDTLS_ERR_SSL_WANT_WRITE) return;
#ifdef MBEDTLS_ERR_SSL_RECEIVED_NEW_SESSION_TICKET
    if (r == MBEDTLS_ERR_SSL_RECEIVED_NEW_SESSION_TICKET) continue;
#endif
    if (r == 0 || r == MBEDTLS_ERR_SSL_PEER_CLOSE_NOTIFY || r == MBEDTLS_ERR_SSL_CONN_EOF || r == MBEDTLS_ERR_NET_CONN_RESET ||
        r == MBEDTLS_ERR_NET_RECV_FAILED) {
      tls_eof(s, r);
      return;
    }
    tls_error(s, r);
    return;
  }
}

static void t_readable(WnSock *s) {
  Tls *t = s->tctx;
  t->reads_left = 32;
  pump(s);
}
static void t_writable(WnSock *s) {
  Tls *t = s->tctx;
  if (!t->handshaken) pump(s);
  else flush_plain(s);
}
/* hands the engine what it has not taken yet; a WRITE whose plaintext is
 * all taken and whose records are all sent completes */
static void flush_plain(WnSock *s) {
  Tls *t = s->tctx;
  while (!t->dead && t->wp_off < t->wp.n) {
    int r = mbedtls_ssl_write(&t->ssl, t->wp.p + t->wp_off, t->wp.n - t->wp_off);
    if (r >= 0) {
      t->wp_off += (size_t)r;
      continue;
    }
    if (r == MBEDTLS_ERR_SSL_WANT_WRITE || r == MBEDTLS_ERR_SSL_WANT_READ) return;
    t->wp.n = t->wp_off = 0;
    if (s->pending_write) {
      s->pending_write = 0;
      wn_sock_push(s, EV_WRITE_DONE, r == MBEDTLS_ERR_NET_CONN_RESET ? -ECONNRESET : -EPIPE, NULL, 0);
    }
    return;
  }
  if (t->wp.n) t->wp.n = t->wp_off = 0;
  if (s->pending_write && !wn_sock_out_pending(s)) {
    s->pending_write = 0;
    wn_sock_push(s, EV_WRITE_DONE, 0, NULL, 0);
  }
}
static int t_busy(WnSock *s) {
  Tls *t = s->tctx;
  return t->wp_off < t->wp.n;
}
static void t_connected(WnSock *s) { pump(s); }
static int32_t t_write(WnSock *s, const uint8_t *p, size_t n) {
  Tls *t = s->tctx;
  if (t->dead) return -EPIPE;
  size_t off = 0;
  while (off < n) {
    int r = mbedtls_ssl_write(&t->ssl, p + off, n - off);
    if (r >= 0) {
      off += (size_t)r;
      continue;
    }
    if (r == MBEDTLS_ERR_SSL_WANT_WRITE || r == MBEDTLS_ERR_SSL_WANT_READ) {
      /* the engine cannot take more now (never a spin): the rest waits,
       * and the WRITE completes when it is taken and sent */
      wn_buf_put(&t->wp, p + off, n - off);
      return 1;
    }
    return r == MBEDTLS_ERR_NET_CONN_RESET ? -ECONNRESET : -EPIPE;
  }
  return wn_sock_out_pending(s) ? 1 : 0;
}
static void t_shutdown(WnSock *s) {
  Tls *t = s->tctx;
  if (!t->dead && t->handshaken && !t->notify) {
    t->notify = 1;
    mbedtls_ssl_close_notify(&t->ssl);
  }
  wn_sock_shutdown_after_drain(s);
}
static void t_read_start(WnSock *s) {
  Tls *t = s->tctx;
  if (t->dead) return;
  s->tls_reads = 1;
  /* what the engine already holds flows now; the descriptor is read again */
  if (t->handshaken) pump(s);
  wn_sock_update(s);
}
static void t_read_stop(WnSock *s) {
  Tls *t = s->tctx;
  if (t->handshaken && !t->dead) s->tls_reads = 0;
}
static void t_free(WnSock *s) {
  Tls *t = s->tctx;
  if (!t) return;
  mbedtls_ssl_free(&t->ssl);
  mbedtls_ssl_config_free(&t->conf);
  free(t->rbuf);
  wn_buf_free(&t->wp);
  free(t);
  s->tctx = NULL;
}
static const WnTlsOps OPS = {t_readable, t_writable, t_connected, t_write, t_shutdown, t_read_start, t_read_stop, t_busy, t_free};

/* appends every certificate of `from` to `to` */
static void chain_add(mbedtls_x509_crt *to, const mbedtls_x509_crt *from) {
  for (const mbedtls_x509_crt *c = from; c && c->raw.p; c = c->next) mbedtls_x509_crt_parse_der(to, c->raw.p, c->raw.len);
}

static int32_t secure(uint32_t ptr, int32_t h) {
  WnSock *s = wn_sock_get(h);
  if (!s || s->tls) wn_host_fail("tlsCall: SECURE of a handle that is not an open plain socket");
  uint32_t cid = wn_rd32(ptr), mode = wn_rd32(ptr + 4);
  uint32_t off = ptr + 8;
  size_t snl;
  char *sni = wn_read_run(&off, &snl);
  if (cid < 1 || (int)cid > n_ctxs) wn_host_fail("tlsCall: SECURE with an unknown context");
  Ctx *c = ctxs[cid - 1];
  Tls *t = calloc(1, sizeof *t);
  if (!t) abort();
  t->server = mode == 1;
  mbedtls_ssl_config_init(&t->conf);
  mbedtls_ssl_init(&t->ssl);
  if (mbedtls_ssl_config_defaults(&t->conf, t->server ? MBEDTLS_SSL_IS_SERVER : MBEDTLS_SSL_IS_CLIENT, MBEDTLS_SSL_TRANSPORT_STREAM,
                                  MBEDTLS_SSL_PRESET_DEFAULT) != 0)
    wn_host_fail("tlsCall: the engine refused its default configuration");
  mbedtls_ssl_conf_rng(&t->conf, mbedtls_ctr_drbg_random, &drbg);
  if (t->server) {
    mbedtls_ssl_conf_authmode(&t->conf, MBEDTLS_SSL_VERIFY_NONE);
    if (c->has_cert && c->has_key) mbedtls_ssl_conf_own_cert(&t->conf, &c->cert, &c->key);
  } else {
    /* the verdict is recorded, never enforced (Node's verify callback
     * accepts; the module decides): judged after the handshake against
     * the context's store */
    mbedtls_ssl_conf_authmode(&t->conf, MBEDTLS_SSL_VERIFY_NONE);
    t->sc = c->sc;
    if (c->has_cert && c->has_key) mbedtls_ssl_conf_own_cert(&t->conf, &c->cert, &c->key);
  }
  if (mbedtls_ssl_setup(&t->ssl, &t->conf) != 0) wn_host_fail("tlsCall: the engine could not set up a session");
  if (!t->server) mbedtls_ssl_set_hostname(&t->ssl, snl ? sni : NULL);
  free(sni);
  mbedtls_ssl_set_bio(&t->ssl, s, bio_send, bio_recv, NULL);
  s->tls = &OPS;
  s->tctx = t;
  s->tls_reads = 1;
  pump(s);
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

static int has_begin(const unsigned char *p, size_t n) {
  static const char m[] = "-----BEGIN ";
  for (size_t i = 0; i + sizeof m - 1 <= n; i++)
    if (memcmp(p + i, m, sizeof m - 1) == 0) return 1;
  return 0;
}

int32_t host_tlsCall(int32_t op, int32_t ptr, int32_t len, int32_t h, int32_t x) {
  uint32_t P = (uint32_t)ptr;
  rng_init();
  switch (op) {
    case 1: { /* CTX_NEW */
      Ctx *c = calloc(1, sizeof *c);
      if (!c) abort();
      c->sc = wn_ossl_ctx_new();
      mbedtls_x509_crt_init(&c->cert);
      mbedtls_pk_init(&c->key);
      ctxs = realloc(ctxs, sizeof *ctxs * (size_t)(n_ctxs + 1));
      if (!ctxs) abort();
      ctxs[n_ctxs++] = c;
      return n_ctxs;
    }
    case 2: { /* CTX_ROOTS */
      if (h < 1 || h > n_ctxs) wn_host_fail("tlsCall: CTX_ROOTS of a handle that is not a context");
      wn_ossl_ctx_roots(ctxs[h - 1]->sc);
      return 0;
    }
    case 3:
    case 4:
    case 5: {
      if (h < 1 || h > n_ctxs) wn_host_fail("tlsCall: material for a handle that is not a context");
      Ctx *c = ctxs[h - 1];
      size_t n;
      unsigned char *pem = blob_pem(P, &n);
      int32_t ans = 0;
      if (op == 3) {
        /* SecureContext::SetCACert: every certificate PEM_read_bio_X509_AUX
         * reads, into the context's own store and its client CA list;
         * what does not parse ends the read, silently */
        BIO *bio = BIO_new_mem_buf(pem, (int)(n - 1));
        if (!bio) abort();
        X509 *x;
        while ((x = PEM_read_bio_X509_AUX(bio, NULL, no_password, NULL)) != NULL) {
          if (X509_STORE_add_cert(wn_ossl_ctx_own_store(c->sc), x) != 1 || SSL_CTX_add_client_CA(c->sc, x) != 1)
            wn_host_fail("tlsCall: CTX_ADD_CA could not add a certificate");
          X509_free(x);
        }
        BIO_free(bio);
        ERR_clear_error();
      } else if (op == 4) {
        mbedtls_x509_crt add;
        mbedtls_x509_crt_init(&add);
        int r = mbedtls_x509_crt_parse(&add, pem, n);
        if (r != 0 || add.raw.p == NULL) {
          ans = has_begin(pem, n - 1) ? fail(P, "error:068000A8:asn1 encoding routines::wrong tag", "ERR_OSSL_ASN1_WRONG_TAG")
                                      : fail(P, "error:0480006C:PEM routines::no start line", "ERR_OSSL_PEM_NO_START_LINE");
        } else {
          mbedtls_x509_crt_free(&c->cert);
          mbedtls_x509_crt_init(&c->cert);
          chain_add(&c->cert, &add);
          int had = c->has_cert;
          c->has_cert = 1;
          if (!pair_ok(c)) {
            c->has_cert = had;
            ans = fail(P, "error:05800074:x509 certificate routines::key values mismatch", "ERR_OSSL_X509_KEY_VALUES_MISMATCH");
          }
        }
        mbedtls_x509_crt_free(&add);
      } else {
        mbedtls_pk_context k;
        mbedtls_pk_init(&k);
        if (mbedtls_pk_parse_key(&k, pem, n, NULL, 0, mbedtls_ctr_drbg_random, &drbg) != 0) {
          ans = fail(P, "error:1E08010C:DECODER routines::unsupported", "ERR_OSSL_UNSUPPORTED");
          mbedtls_pk_free(&k);
        } else {
          mbedtls_pk_context old = c->key;
          int had = c->has_key;
          c->key = k;
          c->has_key = 1;
          if (!pair_ok(c)) {
            c->key = old;
            c->has_key = had;
            mbedtls_pk_free(&k);
            ans = fail(P, "error:05800074:x509 certificate routines::key values mismatch", "ERR_OSSL_X509_KEY_VALUES_MISMATCH");
          } else if (had)
            mbedtls_pk_free(&old);
        }
      }
      free(pem);
      return ans;
    }
    case 6:
      return secure(P, h);
    case 7:
      return ca_store(P, (uint32_t)len, x);
    default:
      wn_host_fail("tlsCall: an op outside the contract");
  }
}
