/* OpenSSL's certificate verification as Node runs it, for the native
 * runner's TLS (wn_tls.c) and fetch (wn_fetch.c): wn_x509.c. */
#ifndef WN_X509_H
#define WN_X509_H

#include "mbedtls/x509_crt.h"

/* The verdict on a peer's chain (the certificates as it sent them, leaf
 * first) against a trust store, in OpenSSL's X509_V_ERR numbering: 0 when
 * verified. Node's verify callback lets verification run to its end, so
 * the verdict is the LAST error OpenSSL's checks met, in their order. */
int wn_x509_verify(const mbedtls_x509_crt *peer, const mbedtls_x509_crt *trust);
/* X509_verify_cert_error_string */
const char *wn_x509_err_text(int code);
/* Node's error code for it (X509_V_ERR_ without the prefix, for the ones
 * Node names; "UNSPECIFIED" otherwise) */
const char *wn_x509_err_name(int code);
/* Node's tls.checkServerIdentity(host, cert) over the leaf: NULL when the
 * name matches, else the malloc'd reason Node words (what follows
 * "Hostname/IP does not match certificate's altnames: "). `host` is the
 * URL's host name — an IPv6 address without its brackets — compared with
 * its length (never as a C string); the reason may hold any byte (a CN
 * with a NUL in it is quoted as Node quotes it), so its length is
 * *reason_len. */
char *wn_x509_check_identity(const mbedtls_x509_crt *leaf, const char *host, size_t host_len, size_t *reason_len);

#endif
