/* Node's words for a peer certificate's verdict and its name check, for
 * the native runner's fetch (wn_fetch.c): wn_x509.c. Compiled with the
 * vendored OpenSSL's headers (wn_trust.h). */
#ifndef WN_X509_H
#define WN_X509_H

#include <stddef.h>

#include <openssl/x509.h>

/* X509_verify_cert_error_string, Node's validation reason (ncrypto
 * X509Pointer::ErrorReason), with crypto_common.cc's --use-system-ca
 * suggestion where Node appends it; malloc'd */
char *wn_x509_err_reason(long code);
/* ncrypto X509Pointer::ErrorCode: the X509_V_ERR_ name without its prefix
 * for the ones Node names, "UNSPECIFIED" otherwise */
const char *wn_x509_err_name(long code);
/* Node's tls.checkServerIdentity(host, cert) over the certificate as
 * getPeerCertificate presents it (cert.subjectaltname, printed as ncrypto
 * prints it; cert.subject.CN): NULL when the name matches, else the
 * malloc'd reason Node words (what follows "Hostname/IP does not match
 * certificate's altnames: "). `host` is the URL's host name — an IPv6
 * address without its brackets — compared with its length (never as a C
 * string); the reason may hold any byte, so its length is *reason_len. No
 * certificate (`leaf` NULL) is "Cert does not contain a DNS name". */
char *wn_x509_check_identity(X509 *leaf, const char *host, size_t host_len, size_t *reason_len);

#endif
