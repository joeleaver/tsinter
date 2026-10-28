/* Node's OpenSSL in the native runner's host (OpenSSL units O2/O3): the
 * vendored OpenSSL Node v24.18.1 bundles (3.5.7, backend/openssl-build.ts),
 * started and configured as Node starts it, with the trust stores Node
 * builds — so wasm, wasm-native and Node trust exactly the same roots
 * and judge them with the same code. Transcribed from Node's
 * src/node.cc (InitializeOncePerProcess's OpenSSL half),
 * src/crypto/crypto_util.cc (InitCryptoOnce, error::Decorate) and
 * src/crypto/crypto_context.cc (NewRootCertStore and the loaders behind
 * it):
 *  - the ROOT STORE (CTX_ROOTS' addRootCerts, fetch's trust): one shared
 *    X509_STORE holding Node's bundled roots — the very bytes the wasm
 *    module carries for tls.rootCertificates (backend/wasm/tls-roots.ts,
 *    generated from Node's src/node_root_certs.h), compiled into the
 *    runner as wn_tls_roots — then, with --use-system-ca (NODE_OPTIONS)
 *    or NODE_USE_SYSTEM_CA=1, the system store, then NODE_EXTRA_CA_CERTS's
 *    certificates; with --use-openssl-ca, OpenSSL's default locations in
 *    place of the bundled and system sets. No X509_V_FLAG_* is set on it.
 *  - the SYSTEM store (getCACertificates("system")): on Linux what
 *    GetOpenSSLSystemCertificates reads — SSL_CERT_FILE, else OpenSSL's
 *    default file (OPENSSLDIR "/cert.pem" = /etc/ssl/cert.pem), then every
 *    regular file of SSL_CERT_DIR, else /etc/ssl/certs, in libuv's
 *    scandir order (strcmp).
 *  - the EXTRA store: NODE_EXTRA_CA_CERTS's PEM certificates; a file that
 *    cannot be read prints Node's "Warning: Ignoring extra certs from
 *    `<file>`, load failed: <OpenSSL's error>".
 * SEMANTICS.md S117 (g). */
#define _GNU_SOURCE
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <sys/auxv.h>
#include <unistd.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>

#include <openssl/bio.h>
#include <openssl/conf.h>
#include <openssl/crypto.h>
#include <openssl/engine.h>
#include <openssl/err.h>
#include <openssl/evp.h>
#include <openssl/hmac.h>
#include <openssl/pem.h>
#include <openssl/rand.h>
#include <openssl/provider.h>
#include <openssl/ssl.h>
#include <openssl/x509.h>

#include "wn_host.h"
#include "wn_trust.h"

/* the generated unit: u16 little-endian length, then the DER, per root */
extern const unsigned char wn_tls_roots[];
extern const unsigned int wn_tls_roots_len;

const char *wn_host_argv0(void);

/* ── the environment as Node reads it ──────────────────────────────────── */

/* node_credentials.cc SafeGetenv: in a process running with elevated
 * rights (AT_SECURE, or a real uid/gid other than the effective one) every
 * variable Node reads this way is unset. The host reads NODE_OPTIONS,
 * NODE_USE_SYSTEM_CA, NODE_EXTRA_CA_CERTS, OPENSSL_CONF, SSL_CERT_FILE and
 * SSL_CERT_DIR through it — exactly the ones Node's C++ does (the proxy
 * variables fetch reads are JavaScript's process.env: plain). */
const char *wn_safe_getenv(const char *name) {
  if (getauxval(AT_SECURE) || getuid() != geteuid() || getgid() != getegid()) return NULL;
  return getenv(name);
}

/* ── Node's command-line options that reach OpenSSL (NODE_OPTIONS) ────── */
static int opt_use_system_ca, opt_use_openssl_ca, opt_shared_config, opt_legacy_provider;
static int opt_tls_min_v1_0, opt_tls_min_v1_1, opt_tls_min_v1_2, opt_tls_min_v1_3, opt_tls_max_v1_2, opt_tls_max_v1_3;
static int opt_enable_fips, opt_force_fips;
static char *opt_openssl_config, *opt_tls_cipher_list, *opt_tls_keylog;
/* a start-up error Node reports before running anything ("node: ..." and
 * exit 9), reported here at the program's first TLS use */
static char *opt_error;

static void set_str(char **slot, const char *v) {
  free(*slot);
  *slot = strdup(v);
  if (!*slot) abort();
}

/* node_options.cc ParseNodeOptionsEnvVar: blanks split, "..." quotes,
 * a backslash in quotes escapes the next character; then the options
 * parser: a boolean takes --no-, a string option its value after '=' or as
 * the next argument */
static void options_once(void) {
  static int done;
  if (done) return;
  done = 1;
  opt_tls_cipher_list = strdup(
      "TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256:TLS_AES_128_GCM_SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES128-GCM-SHA256:"
      "ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-AES256-GCM-SHA384:DHE-RSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-SHA256:DHE-RSA-AES128-SHA256:"
      "ECDHE-RSA-AES256-SHA384:DHE-RSA-AES256-SHA384:ECDHE-RSA-AES256-SHA256:DHE-RSA-AES256-SHA256:HIGH:!aNULL:!eNULL:!EXPORT:!DES:!RC4:!MD5:!PSK:"
      "!SRP:!CAMELLIA");
  if (!opt_tls_cipher_list) abort();
  const char *v = wn_safe_getenv("NODE_USE_SYSTEM_CA");
  const char *o = wn_safe_getenv("NODE_OPTIONS");
  if (o) {
    size_t n = strlen(o);
    char *tok = malloc(n + 1);
    if (!tok) abort();
    size_t k = 0;
    int in_str = 0, have = 0;
    char **pending = NULL; /* a string option waiting for its value */
    for (size_t i = 0; i <= n; i++) {
      char c = i < n ? o[i] : 0;
      int end = i == n || (c == ' ' && !in_str);
      if (!end) {
        if (c == '\\' && in_str && i + 1 < n) c = o[++i];
        else if (c == '"') {
          in_str = !in_str;
          have = 1;
          continue;
        }
        tok[k++] = c;
        have = 1;
        continue;
      }
      if (!have) continue;
      tok[k] = 0;
      if (pending) {
        set_str(pending, tok);
        pending = NULL;
      } else if (tok[0] == '-' && tok[1] == '-') {
        /* an option's name: '_' reads as '-' up to any '=' */
        for (char *p = tok; *p && *p != '='; p++)
          if (*p == '_') *p = '-';
        int neg = !strncmp(tok, "--no-", 5);
        const char *name = neg ? tok + 5 : tok + 2;
        static const struct {
          const char *name;
          int *flag;
        } bools[] = {
            {"use-system-ca", &opt_use_system_ca},
            {"use-openssl-ca", &opt_use_openssl_ca},
            {"openssl-shared-config", &opt_shared_config},
            {"openssl-legacy-provider", &opt_legacy_provider},
            {"tls-min-v1.0", &opt_tls_min_v1_0},
            {"tls-min-v1.1", &opt_tls_min_v1_1},
            {"tls-min-v1.2", &opt_tls_min_v1_2},
            {"tls-min-v1.3", &opt_tls_min_v1_3},
            {"tls-max-v1.2", &opt_tls_max_v1_2},
            {"tls-max-v1.3", &opt_tls_max_v1_3},
            {"enable-fips", &opt_enable_fips},
            {"force-fips", &opt_force_fips},
        };
        static const struct {
          const char *name;
          char **slot;
        } strs[] = {{"openssl-config", &opt_openssl_config}, {"tls-cipher-list", &opt_tls_cipher_list}, {"tls-keylog", &opt_tls_keylog}};
        int matched = 0;
        for (size_t j = 0; j < sizeof bools / sizeof bools[0] && !matched; j++)
          if (!strcmp(name, bools[j].name)) {
            *bools[j].flag = !neg;
            matched = 1;
          }
        if (!strcmp(name, "use-bundled-ca") && !neg) opt_use_openssl_ca = 0;
        for (size_t j = 0; j < sizeof strs / sizeof strs[0] && !matched && !neg; j++) {
          size_t ln = strlen(strs[j].name);
          if (!strncmp(name, strs[j].name, ln) && name[ln] == '=') {
            if (name[ln + 1] == 0 && !opt_error) {
              char m[96];
              snprintf(m, sizeof m, "--%s= requires an argument", strs[j].name);
              opt_error = strdup(m);
            } else
              set_str(strs[j].slot, name + ln + 1);
            matched = 1;
          } else if (!strcmp(name, strs[j].name)) {
            pending = strs[j].slot;
            matched = 1;
          }
        }
      }
      k = 0;
      have = 0;
    }
    free(tok);
  }
  /* node.cc: NODE_USE_SYSTEM_CA=1 after the options */
  if (v && !strcmp(v, "1")) opt_use_system_ca = 1;
  /* node_options.cc EnvironmentOptions::CheckOptions */
  if (opt_tls_min_v1_3 && opt_tls_max_v1_2 && !opt_error) opt_error = strdup("either --tls-min-v1.3 or --tls-max-v1.2 can be used, not both");
}

/* lib/tls.js DEFAULT_MIN_VERSION / DEFAULT_MAX_VERSION, as Init gets them */
static int default_min_version(void) {
  if (opt_tls_min_v1_0) return TLS1_VERSION;
  if (opt_tls_min_v1_1) return TLS1_1_VERSION;
  if (opt_tls_min_v1_2) return TLS1_2_VERSION;
  if (opt_tls_min_v1_3) return TLS1_3_VERSION;
  return TLS1_2_VERSION;
}
static int default_max_version(void) {
  if (opt_tls_max_v1_3) return TLS1_3_VERSION;
  if (opt_tls_max_v1_2) return TLS1_2_VERSION;
  return TLS1_3_VERSION;
}

int wn_trust_use_system_ca(void) {
  options_once();
  return opt_use_system_ca;
}

/* ── start-up ─────────────────────────────────────────────────────────── */
static void print_errors_appending(const char *str, size_t len, void *u) {
  WnBuf *b = u;
  wn_buf_put(b, str, len);
  wn_buf_put(b, "\n", 1);
}
static int print_errors_append_cb(const char *str, size_t len, void *u) {
  print_errors_appending(str, len, u);
  return 0;
}

void wn_ossl_init(void) {
  static int done;
  if (done) return;
  done = 1;
  options_once();
  if (opt_error) {
    fprintf(stderr, "%s: %s\n", wn_host_argv0(), opt_error);
    fflush(stderr);
    exit(9);
  }
  /* node.cc: the configuration first, its errors fatal */
  const char *conf_file = NULL;
  const char *section = opt_shared_config ? "openssl_conf" : "nodejs_conf";
  const char *env_conf = wn_safe_getenv("OPENSSL_CONF");
  if (env_conf && *env_conf) conf_file = env_conf;
  if (opt_openssl_config && *opt_openssl_config) conf_file = opt_openssl_config;
  OPENSSL_INIT_SETTINGS *settings = OPENSSL_INIT_new();
  OPENSSL_INIT_set_config_filename(settings, conf_file);
  OPENSSL_INIT_set_config_appname(settings, section);
  OPENSSL_INIT_set_config_file_flags(settings, CONF_MFLAGS_IGNORE_MISSING_FILE);
  OPENSSL_init_crypto(OPENSSL_INIT_LOAD_CONFIG, settings);
  OPENSSL_INIT_free(settings);
  if (ERR_peek_error() != 0) {
    int code = ERR_GET_REASON(ERR_peek_error());
    WnBuf b = {0};
    ERR_print_errors_cb(print_errors_append_cb, &b);
    fprintf(stderr, "%s: OpenSSL configuration error:\n%.*s\n", wn_host_argv0(), (int)b.n, b.p ? (const char *)b.p : "");
    fflush(stderr);
    exit(code);
  }
  /* crypto_util.cc ProcessFipsOptions (ncrypto testFipsEnabled /
   * setFipsEnabled): Node's bundled OpenSSL carries no FIPS provider, so
   * --enable-fips / --force-fips end the process as Node's start-up does,
   * unless the configuration supplies one */
  if (opt_enable_fips || opt_force_fips) {
    int ok = 0;
    ERR_set_mark();
    if (OSSL_PROVIDER_available(NULL, "fips")) {
      OSSL_PROVIDER *fp = OSSL_PROVIDER_load(NULL, "fips");
      if (fp) {
        ok = OSSL_PROVIDER_self_test(fp);
        OSSL_PROVIDER_unload(fp);
      }
    }
    ERR_pop_to_mark();
    if (ok && EVP_default_properties_is_fips_enabled(NULL) != 1)
      ok = EVP_default_properties_enable_fips(NULL, 1) == 1 && EVP_default_properties_is_fips_enabled(NULL);
    if (!ok) {
      WnBuf b = {0};
      ERR_print_errors_cb(print_errors_append_cb, &b);
      fprintf(stderr, "%s: OpenSSL error when trying to enable FIPS:\n%.*s\n", wn_host_argv0(), (int)b.n, b.p ? (const char *)b.p : "");
      fflush(stderr);
      exit(1);
    }
  }
  /* crypto_util.cc InitCryptoOnce */
  if (opt_legacy_provider && OSSL_PROVIDER_load(NULL, "legacy") == NULL) fprintf(stderr, "Unable to load legacy provider.\n");
  settings = OPENSSL_INIT_new();
  OPENSSL_init_ssl(0, settings);
  OPENSSL_INIT_free(settings);
  sk_SSL_COMP_zero(SSL_COMP_get_compression_methods());
#ifndef OPENSSL_NO_ENGINE
  /* ncrypto EnginePointer::initEnginesOnce */
  ENGINE_load_builtin_engines();
  ENGINE_register_all_complete();
#endif
}

/* ── loaders (crypto_context.cc) ──────────────────────────────────────── */
typedef struct {
  X509 **v;
  size_t n, cap;
} Certs;
static void certs_push(Certs *c, X509 *x) {
  if (c->n == c->cap) {
    c->cap = c->cap ? c->cap * 2 : 64;
    c->v = realloc(c->v, c->cap * sizeof *c->v);
    if (!c->v) abort();
  }
  c->v[c->n++] = x;
}
/* NoPasswordCallback */
static int no_password(char *buf, int size, int rwflag, void *u) {
  (void)buf, (void)size, (void)rwflag, (void)u;
  return 0;
}
/* LoadCertsFromBIO: every PEM certificate; 0, or the error that stopped
 * the read (a PEM "no start line" — the end — is none) */
static unsigned long load_bio(Certs *c, BIO *bio) {
  ERR_set_mark();
  X509 *x;
  while ((x = PEM_read_bio_X509(bio, NULL, no_password, NULL)) != NULL) certs_push(c, x);
  unsigned long err = ERR_peek_last_error();
  if (ERR_GET_LIB(err) == ERR_LIB_PEM && ERR_GET_REASON(err) == PEM_R_NO_START_LINE) err = 0;
  ERR_pop_to_mark();
  return err;
}
/* LoadCertsFromFile */
static unsigned long load_file(Certs *c, const char *file) {
  ERR_set_mark();
  BIO *bio = BIO_new_file(file, "r");
  if (!bio) {
    unsigned long err = ERR_get_error();
    ERR_pop_to_mark();
    return err;
  }
  ERR_pop_to_mark();
  unsigned long err = load_bio(c, bio);
  BIO_free_all(bio);
  return err;
}
static int name_cmp(const struct dirent **a, const struct dirent **b) { return strcmp((*a)->d_name, (*b)->d_name); }
static int not_dots(const struct dirent *d) { return strcmp(d->d_name, ".") != 0 && strcmp(d->d_name, "..") != 0; }
/* LoadCertsFromDir (uv_fs_scandir: sorted by strcmp, "." and ".." out) */
static void load_dir(Certs *c, const char *dir) {
  struct dirent **ents = NULL;
  int n = scandir(dir, &ents, not_dots, name_cmp);
  if (n < 0) {
    fprintf(stderr, "Cannot open directory %s to load OpenSSL certificates.\n", dir);
    return;
  }
  for (int i = 0; i < n; i++) {
    size_t len = strlen(dir) + 1 + strlen(ents[i]->d_name) + 1;
    char *path = malloc(len);
    if (!path) abort();
    snprintf(path, len, "%s/%s", dir, ents[i]->d_name);
    struct stat st;
    if (stat(path, &st) == 0 && (st.st_mode & S_IFREG)) load_file(c, path);
    free(path);
    free(ents[i]);
  }
  free(ents);
}

static Certs bundled, system_certs, extra;
static int have_bundled, have_system, have_extra;

/* GetBundledRootCertificates: Node reads node_root_certs.h's PEM; these
 * are its DER (tls-roots.ts), the same certificates */
static Certs *get_bundled(void) {
  if (!have_bundled) {
    have_bundled = 1;
    unsigned int off = 0;
    while (off + 2 <= wn_tls_roots_len) {
      unsigned int n = (unsigned int)wn_tls_roots[off] | ((unsigned int)wn_tls_roots[off + 1] << 8);
      off += 2;
      if (off + n > wn_tls_roots_len) wn_host_fail("tlsCall: the bundled root store is truncated");
      const unsigned char *p = wn_tls_roots + off;
      X509 *x = d2i_X509(NULL, &p, n);
      /* parse errors from the built-in roots are fatal (Node's CHECK) */
      if (!x || p != wn_tls_roots + off + n) wn_host_fail("tlsCall: a bundled root does not parse");
      certs_push(&bundled, x);
      off += n;
    }
  }
  return &bundled;
}
/* GetOpenSSLSystemCertificates */
static Certs *get_system(void) {
  if (!have_system) {
    have_system = 1;
    const char *file = wn_safe_getenv(X509_get_default_cert_file_env());
    if (!file) file = X509_get_default_cert_file();
    const char *dir = wn_safe_getenv(X509_get_default_cert_dir_env());
    if (!dir) dir = X509_get_default_cert_dir();
    if (*file) load_file(&system_certs, file);
    if (*dir) load_dir(&system_certs, dir);
  }
  return &system_certs;
}
static const char *extra_file(void) {
  const char *f = wn_safe_getenv("NODE_EXTRA_CA_CERTS");
  return f && *f ? f : NULL;
}
/* GetExtraCACertificates */
static Certs *get_extra(void) {
  if (!have_extra) {
    have_extra = 1;
    const char *f = extra_file();
    unsigned long err = load_file(&extra, f ? f : "");
    if (err) {
      char buf[256];
      ERR_error_string_n(err, buf, sizeof buf);
      fprintf(stderr, "Warning: Ignoring extra certs from `%s`, load failed: %s\n", f ? f : "", buf);
    }
  }
  return &extra;
}

static void add_all(X509_STORE *s, const Certs *c) {
  for (size_t i = 0; i < c->n; i++)
    if (X509_STORE_add_cert(s, c->v[i]) != 1) wn_host_fail("tlsCall: a root could not be added to the store");
}

X509_STORE *wn_trust_new_root_store(void) {
  wn_ossl_init();
  X509_STORE *store = X509_STORE_new();
  if (!store) abort();
  if (opt_use_openssl_ca) {
    if (X509_STORE_set_default_paths(store) != 1) wn_host_fail("tlsCall: OpenSSL's default certificate paths could not be set");
  } else {
    add_all(store, get_bundled());
    if (opt_use_system_ca) add_all(store, get_system());
  }
  if (extra_file()) add_all(store, get_extra());
  return store;
}

X509_STORE *wn_trust_root_store(void) {
  static X509_STORE *root;
  if (!root) root = wn_trust_new_root_store();
  return root;
}

X509 *const *wn_trust_system(size_t *n) {
  wn_ossl_init();
  Certs *c = get_system();
  *n = c->n;
  return c->v;
}
X509 *const *wn_trust_extra(size_t *n) {
  wn_ossl_init();
  if (!extra_file()) {
    *n = 0;
    return NULL;
  }
  Certs *c = get_extra();
  *n = c->n;
  return c->v;
}

/* ── Node's secure context (crypto_context.cc SecureContext) ────────────── */
typedef struct {
  unsigned char name[16], hmac[16], aes[16];
  X509_STORE *own; /* own_cert_store_cache_ */
} NodeCtx;
static int ctx_index = -1;
static NodeCtx *node_ctx(SSL_CTX *sc) { return SSL_CTX_get_ex_data(sc, ctx_index); }

/* TicketCompatibilityCallback: OpenSSL 1.0's ticket key layout */
static int ticket_cb(SSL *ssl, unsigned char *name, unsigned char *iv, EVP_CIPHER_CTX *ectx, HMAC_CTX *hctx, int enc) {
  NodeCtx *c = node_ctx(SSL_get_SSL_CTX(ssl));
  if (enc) {
    memcpy(name, c->name, sizeof c->name);
    if (RAND_bytes(iv, 16) != 1 || EVP_EncryptInit_ex(ectx, EVP_aes_128_cbc(), NULL, c->aes, iv) <= 0 ||
        HMAC_Init_ex(hctx, c->hmac, sizeof c->hmac, EVP_sha256(), NULL) <= 0)
      return -1;
    return 1;
  }
  if (memcmp(name, c->name, sizeof c->name) != 0) return 0;
  if (EVP_DecryptInit_ex(ectx, EVP_aes_128_cbc(), NULL, c->aes, iv) <= 0 || HMAC_Init_ex(hctx, c->hmac, sizeof c->hmac, EVP_sha256(), NULL) <= 0)
    return -1;
  return 1;
}

SSL_CTX *wn_ossl_ctx_new(void) {
  WnCtxError e;
  SSL_CTX *sc = wn_ossl_ctx_new_checked(&e);
  if (!sc) {
    char m[512];
    snprintf(m, sizeof m, "tlsCall: NODE_OPTIONS --tls-cipher-list makes Node's createSecureContext throw (%s: %s), which a secure context cannot answer: not supported", e.code, e.message);
    wn_host_fail(m);
  }
  return sc;
}

SSL_CTX *wn_ossl_ctx_new_checked(WnCtxError *err) {
  wn_ossl_init();
  if (ctx_index < 0) ctx_index = SSL_CTX_get_ex_new_index(0, NULL, NULL, NULL, NULL);
  SSL_CTX *sc = SSL_CTX_new(TLS_method());
  if (!sc) wn_host_fail("tlsCall: SSL_CTX_new failed");
  NodeCtx *c = calloc(1, sizeof *c);
  if (!c) abort();
  SSL_CTX_set_ex_data(sc, ctx_index, c);
  SSL_CTX_set_options(sc, SSL_OP_NO_SSLv2);
  SSL_CTX_set_options(sc, SSL_OP_NO_SSLv3);
  SSL_CTX_set_options(sc, SSL_OP_ALLOW_CLIENT_RENEGOTIATION);
  SSL_CTX_clear_mode(sc, SSL_MODE_NO_AUTO_CHAIN);
  SSL_CTX_set_session_cache_mode(sc, SSL_SESS_CACHE_CLIENT | SSL_SESS_CACHE_SERVER | SSL_SESS_CACHE_NO_INTERNAL | SSL_SESS_CACHE_NO_AUTO_CLEAR);
  int min_version = default_min_version(), max_version = default_max_version();
  if (!SSL_CTX_set_min_proto_version(sc, min_version) || !SSL_CTX_set_max_proto_version(sc, max_version))
    wn_host_fail("tlsCall: the protocol versions could not be set");
  if (RAND_bytes(c->name, sizeof c->name) != 1 || RAND_bytes(c->hmac, sizeof c->hmac) != 1 || RAND_bytes(c->aes, sizeof c->aes) != 1)
    wn_host_fail("tlsCall: Error generating ticket keys");
  SSL_CTX_set_tlsext_ticket_key_cb(sc, ticket_cb);
  /* configSecureContext: the default ciphers (--tls-cipher-list), split
   * by processCiphers: the TLS_ ones for setCipherSuites (when any), the
   * rest for setCiphers; no TLS 1.2 cipher at all makes TLS 1.3 the
   * minimum. A list Node's createSecureContext would throw on is a named
   * refusal here (the context has no failure answer) */
  {
    const char *ciphers = opt_tls_cipher_list;
    size_t cn = strlen(ciphers);
    char *list = calloc(cn + 2, 1), *suites = calloc(cn + 2, 1);
    if (!list || !suites) abort();
    for (const char *p = ciphers; *p || p == ciphers;) {
      const char *e = strchr(p, ':');
      size_t len = e ? (size_t)(e - p) : strlen(p);
      if (len > 0) {
        int tls13 = (len >= 4 && !strncmp(p, "TLS_", 4)) || (len >= 5 && !strncmp(p, "!TLS_", 5));
        char *dst = tls13 ? suites : list;
        if (*dst) strcat(dst, ":");
        strncat(dst, p, len);
      }
      if (!e) break;
      p = e + 1;
    }
    int bad = 0;
    if (!*list && !*suites) {
      /* processCiphers: ERR_INVALID_ARG_VALUE('options.ciphers', ciphers) */
      bad = 1;
      err->type_error = 1;
      snprintf(err->code, sizeof err->code, "ERR_INVALID_ARG_VALUE");
      /* the value is processCiphers' split: n empty strings, inspected */
      size_t n = 1;
      for (const char *q = ciphers; *q; q++) n += *q == ':';
      if (n > 6) wn_host_fail("tlsCall: NODE_OPTIONS --tls-cipher-list of more than 6 empty names (Node's ERR_INVALID_ARG_VALUE inspects the array in columns): not supported");
      char arr[64] = "[ ";
      for (size_t i = 0; i < n; i++) strcat(arr, i ? ", ''" : "''");
      strcat(arr, " ]");
      snprintf(err->message, sizeof err->message, "The property 'options.ciphers' is invalid. Received %s", arr);
    } else {
      /* SetCipherSuites / SetCiphers: ThrowCryptoError(ERR_get_error()) */
      ERR_clear_error();
      unsigned long e = 0;
      if (*suites && !SSL_CTX_set_ciphersuites(sc, suites)) e = ERR_get_error();
      else if (!SSL_CTX_set_cipher_list(sc, list)) {
        e = ERR_get_error();
        if (*list == 0 && ERR_GET_REASON(e) == SSL_R_NO_CIPHER_MATCH) e = 0;
      }
      ERR_clear_error();
      if (e) {
        bad = 1;
        err->type_error = 0;
        ERR_error_string_n(e, err->message, sizeof err->message);
        wn_ossl_err_code(e, err->code, sizeof err->code);
      }
    }
    if (bad) {
      free(list);
      free(suites);
      SSL_CTX_free(sc);
      return NULL;
    }
    if (!*list && SSL_CTX_get_min_proto_version(sc) < TLS1_3_VERSION && SSL_CTX_get_max_proto_version(sc) > TLS1_2_VERSION)
      SSL_CTX_set_min_proto_version(sc, TLS1_3_VERSION);
    free(list);
    free(suites);
  }
  return sc;
}

void wn_ossl_ctx_roots(SSL_CTX *sc) {
  X509_STORE *store = wn_trust_root_store();
  X509_STORE_up_ref(store);
  SSL_CTX_set_cert_store(sc, store);
}

X509_STORE *wn_ossl_ctx_own_store(SSL_CTX *sc) {
  NodeCtx *c = node_ctx(sc);
  if (c->own) return c->own;
  X509_STORE *store = SSL_CTX_get_cert_store(sc);
  if (store == wn_trust_root_store()) {
    store = wn_trust_new_root_store();
    SSL_CTX_set_cert_store(sc, store);
  }
  return c->own = store;
}

/* --tls-keylog: every TLSSocket gets a 'keylog' listener appending each
 * line (and its newline) to the file, mode 0600; the first socket prints
 * Node's warning (lib/internal/tls/wrap.js) */
static void keylog_line(const SSL *ssl, const char *line) {
  (void)ssl;
  int fd = open(opt_tls_keylog, O_WRONLY | O_APPEND | O_CREAT | O_CLOEXEC, 0600);
  if (fd < 0) {
    static int warned;
    if (!warned) {
      warned = 1;
      /* the fs error as Node prints it: "<CODE>: <libuv's text>, open '<path>'" */
      char text[128];
      snprintf(text, sizeof text, "%s", strerror(errno));
      if (text[0] >= 'A' && text[0] <= 'Z') text[0] = (char)(text[0] + 32);
      fprintf(stderr, "(node:%d) Warning: Failed to write TLS keylog (this warning will not be repeated): Error: %s: %s, open '%s'\n", (int)getpid(),
              strerrorname_np(errno), text, opt_tls_keylog);
    }
    return;
  }
  size_t n = strlen(line);
  char *b = malloc(n + 1);
  if (!b) abort();
  memcpy(b, line, n);
  b[n] = '\n';
  ssize_t w = write(fd, b, n + 1);
  (void)w;
  free(b);
  close(fd);
}
void wn_ossl_socket_init(SSL *ssl) {
  options_once();
  if (!opt_tls_keylog) return;
  static int warned;
  if (!warned) {
    warned = 1;
    fprintf(stderr,
            "(node:%d) Warning: Using --tls-keylog makes TLS connections insecure by writing secret key material to file %s\n(Use `node "
            "--trace-warnings ...` to show where the warning was created)\n",
            (int)getpid(), opt_tls_keylog);
  }
  SSL_CTX_set_keylog_callback(SSL_get_SSL_CTX(ssl), keylog_line);
}

/* ── error records ────────────────────────────────────────────────────── */
static int keep_last(const char *str, size_t len, void *u) {
  WnBuf *b = u;
  b->n = 0;
  wn_buf_put(b, str, len);
  return 0;
}
char *wn_ossl_bio_error(void) {
  WnBuf b = {0};
  ERR_print_errors_cb(keep_last, &b);
  char *s = malloc(b.n + 1);
  if (!s) abort();
  if (b.n) memcpy(s, b.p, b.n);
  s[b.n] = 0;
  wn_buf_free(&b);
  return s;
}

void wn_ossl_err_code(unsigned long err, char *out, size_t cap) {
  const char *rs = err ? ERR_reason_error_string(err) : NULL;
  if (!rs) {
    if (cap) out[0] = 0;
    return;
  }
  const char *lib = "";
  switch (ERR_GET_LIB(err)) {
#define V(name) \
  case ERR_LIB_##name: lib = #name "_"; break;
    V(SYS) V(BN) V(RSA) V(DH) V(EVP) V(BUF) V(OBJ) V(PEM) V(DSA) V(X509) V(ASN1) V(CONF) V(CRYPTO) V(EC) V(SSL) V(BIO) V(PKCS7) V(X509V3) V(RAND)
    V(ENGINE) V(OCSP) V(UI) V(COMP) V(ECDSA) V(ECDH) V(CMS) V(HMAC) V(USER) V(PKCS12) V(DSO) V(OSSL_STORE) V(FIPS) V(TS) V(CT) V(ASYNC) V(KDF) V(SM2)
#undef V
    default: break;
  }
  const char *prefix = strcmp(lib, "SSL_") == 0 ? "" : "OSSL_";
  char reason[128];
  size_t i = 0;
  for (; rs[i] && i + 1 < sizeof reason; i++) reason[i] = rs[i] == ' ' ? '_' : (rs[i] >= 'a' && rs[i] <= 'z' ? (char)(rs[i] - 32) : rs[i]);
  reason[i] = 0;
  snprintf(out, cap, "ERR_%s%s%s", prefix, lib, reason);
}
