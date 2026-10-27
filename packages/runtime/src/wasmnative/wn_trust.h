/* The trust stores the TLS unit and fetch share (wn_trust.c). */
#ifndef WN_TRUST_H
#define WN_TRUST_H

#include "mbedtls/x509_crt.h"

/* Node's default: the bundled roots, NODE_EXTRA_CA_CERTS, and the system
 * store under NODE_USE_SYSTEM_CA=1 / --use-system-ca */
mbedtls_x509_crt *wn_trust_default(void);
/* getCACertificates("system") */
mbedtls_x509_crt *wn_trust_system(void);
/* getCACertificates("extra") */
mbedtls_x509_crt *wn_trust_extra(void);

#endif
