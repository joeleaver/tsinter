/* The native runner's TLS engine (native-runner phase N1): abi.ts's
 * `tlsCall` over vendored mbedTLS 3.6 — the same engine the native lane's
 * scr_tls.c uses, recut to the contract's facts-only shape. Every Node
 * behaviour (options, events, socket.authorized, the verification codes'
 * texts, the host-name check, the CA store's strings) is the module's
 * (tls.ts, tls-x509.ts); the host keeps contexts (trust, certificate,
 * key), secures an open netCall socket, VERIFIES the peer's chain and
 * REPORTS the result in OpenSSL's X509_V_ERR numbering — it never fails a
 * handshake over it, never checks a name, never asks a client for a
 * certificate.
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

#include "wn_host.h"
#include "wn_net.h"

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

/* ── the host's default store: the system bundle (S117 (g)) ───────────────── */
static const char *const BUNDLES[] = {
    "/etc/ssl/certs/ca-certificates.crt", /* Debian/Ubuntu */
    "/etc/pki/tls/certs/ca-bundle.crt",   /* Fedora/RHEL */
    "/etc/ssl/ca-bundle.pem",             /* openSUSE */
    "/etc/ssl/cert.pem",                  /* Alpine */
};
static mbedtls_x509_crt sys_roots;
static int sys_loaded;
static mbedtls_x509_crt *system_roots(void) {
  if (!sys_loaded) {
    sys_loaded = 1;
    mbedtls_x509_crt_init(&sys_roots);
    const char *env = getenv("SSL_CERT_FILE");
    if (env && *env && mbedtls_x509_crt_parse_file(&sys_roots, env) >= 0) return &sys_roots;
    for (size_t i = 0; i < sizeof BUNDLES / sizeof BUNDLES[0]; i++)
      if (mbedtls_x509_crt_parse_file(&sys_roots, BUNDLES[i]) >= 0 && sys_roots.raw.p != NULL) break;
  }
  return &sys_roots;
}

/* ── contexts ─────────────────────────────────────────────────────────── */
typedef struct {
  int roots;
  mbedtls_x509_crt ca;
  int has_ca;
  mbedtls_x509_crt cert;
  int has_cert;
  mbedtls_pk_context key;
  int has_key;
} Ctx;
static Ctx **ctxs;
static int n_ctxs;

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
  mbedtls_x509_crt chain; /* the client's trust: roots and added CAs */
  int server;
  int handshaken, dead, notify;
  /* what the verify callback saw, by depth */
  int leaf_self, chain_self, depth_max, top_self;
  /* the raw side read as libuv's uv__read reads it: 64 KiB at a time, at
   * most 32 reads per readiness, and none after a short one (the next
   * iteration's) — the engine consumes these bytes */
  uint8_t *rbuf;
  size_t rlen, roff;
  int reads_left, raw_eof, raw_err;
} Tls;

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

static int vrfy_cb(void *ctx, mbedtls_x509_crt *crt, int depth, uint32_t *flags) {
  Tls *t = ctx;
  int self = crt->issuer_raw.len == crt->subject_raw.len && memcmp(crt->issuer_raw.p, crt->subject_raw.p, crt->subject_raw.len) == 0;
  if (depth >= t->depth_max) {
    t->depth_max = depth;
    t->top_self = self;
  }
  if (*flags & MBEDTLS_X509_BADCERT_NOT_TRUSTED) {
    if (depth == 0 && self) t->leaf_self = 1;
    if (depth > 0 && self) t->chain_self = 1;
  }
  return 0;
}

/* mbedTLS's verdict in OpenSSL's X509_V_ERR numbers (abi.ts tlsCall) */
static uint32_t verify_code(Tls *t) {
  uint32_t f = mbedtls_ssl_get_verify_result(&t->ssl) & ~(uint32_t)MBEDTLS_X509_BADCERT_CN_MISMATCH;
  /* OpenSSL anchors a chain only at a self-signed root (no
   * X509_V_FLAG_PARTIAL_CHAIN, Node's default): a chain mbedTLS accepted
   * at a trusted intermediate is, there, one whose issuer is missing */
  if (f == 0) return t->top_self ? 0 : 2; /* UNABLE_TO_GET_ISSUER_CERT */
  if (f & MBEDTLS_X509_BADCERT_NOT_TRUSTED) {
    const mbedtls_x509_crt *peer = mbedtls_ssl_get_peer_cert(&t->ssl);
    int alone = peer != NULL && peer->next == NULL;
    if (t->leaf_self && alone) return 18;   /* DEPTH_ZERO_SELF_SIGNED_CERT */
    if (t->chain_self) return 19;           /* SELF_SIGNED_CERT_IN_CHAIN */
    if (alone) return 21;                   /* UNABLE_TO_VERIFY_LEAF_SIGNATURE */
    return 20;                              /* UNABLE_TO_GET_ISSUER_CERT_LOCALLY */
  }
  if (f & MBEDTLS_X509_BADCERT_EXPIRED) return 10;
  if (f & MBEDTLS_X509_BADCERT_FUTURE) return 9;
  if (f & MBEDTLS_X509_BADCERT_REVOKED) return 23;
  if (f & MBEDTLS_X509_BADCERT_BAD_KEY) return t->chain_self || t->depth_max > 0 ? 67 : 66;
  if (f & MBEDTLS_X509_BADCERT_BAD_MD) return 68;
  return 1;
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
  static unsigned char buf[16384];
  for (;;) {
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
    if (r == MBEDTLS_ERR_SSL_WANT_WRITE || r == MBEDTLS_ERR_SSL_WANT_READ) continue;
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
static void t_read_start(WnSock *s) { (void)s; }
static void t_free(WnSock *s) {
  Tls *t = s->tctx;
  if (!t) return;
  mbedtls_ssl_free(&t->ssl);
  mbedtls_ssl_config_free(&t->conf);
  mbedtls_x509_crt_free(&t->chain);
  free(t->rbuf);
  free(t);
  s->tctx = NULL;
}
static const WnTlsOps OPS = {t_readable, t_writable, t_connected, t_write, t_shutdown, t_read_start, t_free};

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
  mbedtls_x509_crt_init(&t->chain);
  if (mbedtls_ssl_config_defaults(&t->conf, t->server ? MBEDTLS_SSL_IS_SERVER : MBEDTLS_SSL_IS_CLIENT, MBEDTLS_SSL_TRANSPORT_STREAM,
                                  MBEDTLS_SSL_PRESET_DEFAULT) != 0)
    wn_host_fail("tlsCall: the engine refused its default configuration");
  mbedtls_ssl_conf_rng(&t->conf, mbedtls_ctr_drbg_random, &drbg);
  if (t->server) {
    mbedtls_ssl_conf_authmode(&t->conf, MBEDTLS_SSL_VERIFY_NONE);
    if (c->has_cert && c->has_key) mbedtls_ssl_conf_own_cert(&t->conf, &c->cert, &c->key);
  } else {
    /* the verdict is recorded, never enforced (Node's verify callback
     * accepts; the module decides) */
    mbedtls_ssl_conf_authmode(&t->conf, MBEDTLS_SSL_VERIFY_OPTIONAL);
    if (c->roots) chain_add(&t->chain, system_roots());
    if (c->has_ca) chain_add(&t->chain, &c->ca);
    mbedtls_ssl_conf_ca_chain(&t->conf, &t->chain, NULL);
    mbedtls_ssl_conf_verify(&t->conf, vrfy_cb, t);
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

/* CA_STORE: 'system' (1) or 'extra' (2, NODE_EXTRA_CA_CERTS) as DER blobs */
static int32_t ca_store(uint32_t ptr, uint32_t cap, int32_t which) {
  mbedtls_x509_crt chain;
  mbedtls_x509_crt_init(&chain);
  if (which == 1) chain_add(&chain, system_roots());
  else {
    const char *f = getenv("NODE_EXTRA_CA_CERTS");
    if (f && *f) mbedtls_x509_crt_parse_file(&chain, f);
  }
  WnBuf b = {0};
  uint32_t count = 0;
  wn_buf_u32(&b, 0);
  for (const mbedtls_x509_crt *c = &chain; c && c->raw.p; c = c->next) {
    wn_buf_blob(&b, c->raw.p, c->raw.len);
    count++;
  }
  memcpy(b.p, &count, 4);
  mbedtls_x509_crt_free(&chain);
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
      mbedtls_x509_crt_init(&c->ca);
      mbedtls_x509_crt_init(&c->cert);
      mbedtls_pk_init(&c->key);
      ctxs = realloc(ctxs, sizeof *ctxs * (size_t)(n_ctxs + 1));
      if (!ctxs) abort();
      ctxs[n_ctxs++] = c;
      return n_ctxs;
    }
    case 2: { /* CTX_ROOTS */
      if (h < 1 || h > n_ctxs) wn_host_fail("tlsCall: CTX_ROOTS of a handle that is not a context");
      ctxs[h - 1]->roots = 1;
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
        /* Node keeps what parses and ignores the rest */
        mbedtls_x509_crt_parse(&c->ca, pem, n);
        c->has_ca = c->ca.raw.p != NULL;
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
