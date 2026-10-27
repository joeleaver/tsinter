/* The native runner's trust stores (native-runner phase N1), shared by the
 * TLS unit (wn_tls.c) and fetch (wn_fetch.c) — Node's, so that wasm,
 * wasm-native and Node trust exactly the same roots:
 *  - DEFAULT (what tlsCall's CTX_ROOTS trusts, and fetch): Node's bundled
 *    root set — the very bytes the wasm module carries for
 *    tls.rootCertificates (backend/wasm/tls-roots.ts, generated from Node
 *    v24.18.1's src/node_root_certs.h), compiled into the runner as
 *    wn_tls_roots (wasm-native.ts generates that unit from the same
 *    module) — plus NODE_EXTRA_CA_CERTS's certificates, plus the system
 *    store when Node would add it (NODE_USE_SYSTEM_CA=1, or
 *    --use-system-ca in NODE_OPTIONS);
 *  - SYSTEM (getCACertificates("system"), CA_STORE 1): the system bundle,
 *    as OpenSSL locates it (SSL_CERT_FILE, else the distribution's file);
 *  - EXTRA (CA_STORE 2): NODE_EXTRA_CA_CERTS's file.
 * SEMANTICS.md S117 (g). */
#define _GNU_SOURCE
#include <stdlib.h>
#include <string.h>

#include "mbedtls/x509_crt.h"

#include "wn_trust.h"

/* the generated unit: u16 little-endian length, then the DER, per root */
extern const unsigned char wn_tls_roots[];
extern const unsigned int wn_tls_roots_len;

static void add_bundled(mbedtls_x509_crt *to) {
  unsigned int off = 0;
  while (off + 2 <= wn_tls_roots_len) {
    unsigned int n = (unsigned int)wn_tls_roots[off] | ((unsigned int)wn_tls_roots[off + 1] << 8);
    off += 2;
    if (off + n > wn_tls_roots_len) break;
    mbedtls_x509_crt_parse_der(to, wn_tls_roots + off, n);
    off += n;
  }
}

static void add_system(mbedtls_x509_crt *to) {
  static const char *const bundles[] = {
      "/etc/ssl/certs/ca-certificates.crt", /* Debian/Ubuntu */
      "/etc/pki/tls/certs/ca-bundle.crt",   /* Fedora/RHEL */
      "/etc/ssl/ca-bundle.pem",             /* openSUSE */
      "/etc/ssl/cert.pem",                  /* Alpine */
  };
  const char *env = getenv("SSL_CERT_FILE");
  if (env && *env && mbedtls_x509_crt_parse_file(to, env) >= 0) return;
  for (size_t i = 0; i < sizeof bundles / sizeof bundles[0]; i++)
    if (mbedtls_x509_crt_parse_file(to, bundles[i]) >= 0) return;
}

static void add_extra(mbedtls_x509_crt *to) {
  const char *f = getenv("NODE_EXTRA_CA_CERTS");
  if (f && *f) mbedtls_x509_crt_parse_file(to, f);
}

static int use_system_ca(void) {
  const char *v = getenv("NODE_USE_SYSTEM_CA");
  if (v && !strcmp(v, "1")) return 1;
  const char *o = getenv("NODE_OPTIONS");
  return o != NULL && strstr(o, "--use-system-ca") != NULL;
}

static mbedtls_x509_crt dflt, sys, extra;
static int have_dflt, have_sys, have_extra;

mbedtls_x509_crt *wn_trust_default(void) {
  if (!have_dflt) {
    have_dflt = 1;
    mbedtls_x509_crt_init(&dflt);
    add_bundled(&dflt);
    add_extra(&dflt);
    if (use_system_ca()) add_system(&dflt);
  }
  return &dflt;
}
mbedtls_x509_crt *wn_trust_system(void) {
  if (!have_sys) {
    have_sys = 1;
    mbedtls_x509_crt_init(&sys);
    add_system(&sys);
  }
  return &sys;
}
mbedtls_x509_crt *wn_trust_extra(void) {
  if (!have_extra) {
    have_extra = 1;
    mbedtls_x509_crt_init(&extra);
    add_extra(&extra);
  }
  return &extra;
}
