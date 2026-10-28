/* Node's OpenSSL in the native runner's host (wn_trust.c): the process's
 * OpenSSL start-up, the trust stores, and the error records as Node
 * words them — shared by the TLS unit (wn_tls.c) and fetch (wn_fetch.c).
 * A unit including this compiles with the vendored OpenSSL's headers and
 * the scr_ossl_ prefix header force-included (backend/openssl-build.ts
 * opensslIncludeArgs). */
#ifndef WN_TRUST_H
#define WN_TRUST_H

#include <stddef.h>

#include <openssl/err.h>
#include <openssl/ssl.h>
#include <openssl/x509.h>

/* node.cc InitializeOncePerProcess's OpenSSL half and crypto_util.cc
 * InitCryptoOnce, once: the configuration (OPENSSL_CONF / the default
 * openssl.cnf's nodejs_conf section), then OPENSSL_init_ssl. A
 * configuration error ends the process as Node's start-up does. */
void wn_ossl_init(void);

/* crypto_context.cc GetOrCreateRootCertStore: the shared store CTX_ROOTS
 * (addRootCerts) and fetch trust */
X509_STORE *wn_trust_root_store(void);
/* crypto_context.cc NewRootCertStore: a fresh store with the same
 * certificates (GetCertStoreOwnedByThisSecureContext's copy) */
X509_STORE *wn_trust_new_root_store(void);
/* getCACertificates("system") / ("extra"): the loaded certificates, in
 * Node's order (the vector GetSystemStoreCACertificates /
 * GetExtraCACertificates keep) */
X509 *const *wn_trust_system(size_t *n);
X509 *const *wn_trust_extra(size_t *n);
/* node_credentials.cc SafeGetenv: NULL in a process with elevated rights */
const char *wn_safe_getenv(const char *name);
/* a new TLS socket's Node-wide set-up (--tls-keylog: the keylog lines and
 * Node's warning) */
void wn_ossl_socket_init(SSL *ssl);
/* --use-system-ca / NODE_USE_SYSTEM_CA=1 */
int wn_trust_use_system_ca(void);

/* SecureContext::Init(secureProtocol undefined, TLSv1.2, TLSv1.3) and
 * configSecureContext's defaults before the material: Node's default
 * TLS 1.3 suites and cipher list (processCiphers' split of
 * DEFAULT_CIPHER_LIST_CORE), ecdhCurve 'auto' (no call), and the ticket
 * key callback over CSPRNG keys */
SSL_CTX *wn_ossl_ctx_new(void);
/* the same, NULL when Node's createSecureContext would throw over the
 * --tls-cipher-list default (the error Node throws) */
typedef struct {
  int type_error; /* a TypeError (ERR_INVALID_ARG_VALUE), else an Error */
  char message[256];
  char code[96];
} WnCtxError;
SSL_CTX *wn_ossl_ctx_new_checked(WnCtxError *err);
/* SecureContext::SetRootCerts (addRootCerts): the shared root store */
void wn_ossl_ctx_roots(SSL_CTX *sc);
/* SecureContext::GetCertStoreOwnedByThisSecureContext: the context's own
 * store (a copy of the root store when it shares that one) */
X509_STORE *wn_ossl_ctx_own_store(SSL_CTX *sc);

/* TLSWrap's GetBIOError: ERR_print_errors_cb's LAST line (with its
 * newline), the queue emptied; malloc'd, "" when the queue was empty */
char *wn_ossl_bio_error(void);
/* crypto_util.cc error::Decorate's code for `err`: "ERR_OSSL_<LIB>_<REASON>"
 * (ERR_SSL_<REASON> for the SSL library, ERR_OSSL_<REASON> for one Node's
 * map does not name); "" when OpenSSL has no reason text for it */
void wn_ossl_err_code(unsigned long err, char *out, size_t cap);

#endif
