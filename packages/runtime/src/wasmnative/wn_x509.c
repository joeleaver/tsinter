/* Certificate verification as Node runs it (native-runner phase N1), for
 * the TLS unit (wn_tls.c) and fetch (wn_fetch.c).
 *
 * mbedTLS is the handshake engine; the verdict on the peer's chain is
 * OpenSSL's, transcribed here, because Node's is OpenSSL's and mbedTLS's
 * own differs where it matters: it ignores a CA's extended key usage and
 * name constraints, and refuses to parse a critical extension it does not
 * know (the wasm-native lane links an mbedTLS built to keep such a
 * certificate: MBEDTLS_X509_ALLOW_UNSUPPORTED_CRITICAL_EXTENSION, so the
 * check below decides, as OpenSSL does). The transcription follows
 * OpenSSL 3's crypto/x509/x509_vfy.c (X509_verify_cert, build_chain,
 * check_extensions, check_auth_level, internal_verify,
 * check_name_constraints), v3_purp.c (the extension cache, check_ca, the
 * SSL server purpose, X509_check_akid), v3_ncons.c (NAME_CONSTRAINTS_check
 * and the per-type matches) and x_name.c (the canonical name encoding
 * names are compared by), with Node's settings: purpose SSL server,
 * trusted-first chain building, no partial chains, depth 100, security
 * level 2 (Node's default), and a verify callback that lets every check
 * run, so the verdict is the LAST error met (OpenSSL keeps overwriting
 * ctx->error) — an expired self-signed leaf is "certificate has expired".
 *
 * The certificates are read from their DER (the extensions, the names);
 * mbedTLS's parse supplies the key, the signature algorithm and the
 * validity times, and its primitives check signatures.
 *
 * wn_x509_check_identity is Node's tls.checkServerIdentity over the
 * certificate as Node presents it to that function (cert.subjectaltname,
 * Node's own escaping of unsafe names; cert.subject.CN), for fetch.
 *
 * SEMANTICS.md S117 (g). */
#define _GNU_SOURCE
#define MBEDTLS_ALLOW_PRIVATE_ACCESS
#include <arpa/inet.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "mbedtls/md.h"
#include "mbedtls/oid.h"
#include "mbedtls/pk.h"
#include "mbedtls/x509_crt.h"

#include "wn_x509.h"

/* ── bytes ────────────────────────────────────────────────────────────── */
typedef struct {
  const uint8_t *p;
  size_t n;
} Span;
typedef struct {
  uint8_t *p;
  size_t n, cap;
} Buf;
static void b_put(Buf *b, const void *s, size_t n) {
  if (b->n + n + 1 > b->cap) {
    size_t c = b->cap ? b->cap * 2 : 64;
    while (c < b->n + n + 1) c *= 2;
    b->p = realloc(b->p, c);
    if (!b->p) abort();
    b->cap = c;
  }
  if (n) memcpy(b->p + b->n, s, n);
  b->n += n;
  b->p[b->n] = 0;
}
static void b_chr(Buf *b, int c) {
  uint8_t x = (uint8_t)c;
  b_put(b, &x, 1);
}
static void b_cat(Buf *b, const char *s) { b_put(b, s, strlen(s)); }
static void b_len(Buf *b, size_t n) {
  if (n < 0x80) b_chr(b, (int)n);
  else if (n < 0x100) b_chr(b, 0x81), b_chr(b, (int)n);
  else if (n < 0x10000) b_chr(b, 0x82), b_chr(b, (int)(n >> 8)), b_chr(b, (int)(n & 255));
  else b_chr(b, 0x83), b_chr(b, (int)(n >> 16)), b_chr(b, (int)((n >> 8) & 255)), b_chr(b, (int)(n & 255));
}
static void b_utf8(Buf *b, uint32_t c) {
  if (c < 0x80) b_chr(b, (int)c);
  else if (c < 0x800) b_chr(b, 0xc0 | (int)(c >> 6)), b_chr(b, 0x80 | (int)(c & 63));
  else if (c < 0x10000) b_chr(b, 0xe0 | (int)(c >> 12)), b_chr(b, 0x80 | (int)((c >> 6) & 63)), b_chr(b, 0x80 | (int)(c & 63));
  else b_chr(b, 0xf0 | (int)(c >> 18)), b_chr(b, 0x80 | (int)((c >> 12) & 63)), b_chr(b, 0x80 | (int)((c >> 6) & 63)), b_chr(b, 0x80 | (int)(c & 63));
}

/* one DER element: 0, or -1 when malformed */
static int der(const uint8_t **p, const uint8_t *e, int *tag, Span *val, Span *whole) {
  const uint8_t *s = *p;
  if (s >= e) return -1;
  int t = *s++;
  if ((t & 0x1f) == 0x1f || s >= e) return -1;
  size_t len = *s++;
  if (len & 0x80) {
    int k = (int)(len & 0x7f);
    if (k == 0 || k > 4 || e - s < k) return -1;
    len = 0;
    while (k--) len = len << 8 | *s++;
  }
  if ((size_t)(e - s) < len) return -1;
  if (tag) *tag = t;
  if (val) val->p = s, val->n = len;
  if (whole) whole->p = *p, whole->n = (size_t)(s - *p) + len;
  *p = s + len;
  return 0;
}
static int span_eq(Span a, const uint8_t *b, size_t n) { return a.n == n && memcmp(a.p, b, n) == 0; }
#define OID_IS(sp, lit) span_eq((sp), (const uint8_t *)(lit), sizeof(lit) - 1)

/* ── names: OpenSSL's canonical encoding (x_name.c x509_name_canon) ─────
 * Every RDN re-encoded as a SET OF its attributes (DER-sorted), each
 * string value of the "canon" types turned to UTF-8, its leading and
 * trailing white space dropped, inner runs of white space made one space
 * and ASCII lowered, as a UTF8String; the SETs back to back. Names are
 * equal when these are (X509_NAME_cmp), and a directoryName constraint is
 * a prefix of them (nc_dn). */
static int canon_type(int tag) {
  return tag == 0x0c || tag == 0x1e || tag == 0x1c || tag == 0x13 || tag == 0x14 || tag == 0x16 || tag == 0x1a;
}
/* ASN1_STRING_to_UTF8 of a string value */
static void to_utf8(Buf *out, int tag, Span v) {
  if (tag == 0x1e) {
    for (size_t i = 0; i + 1 < v.n; i += 2) b_utf8(out, (uint32_t)(v.p[i] << 8 | v.p[i + 1]));
  } else if (tag == 0x1c) {
    for (size_t i = 0; i + 3 < v.n; i += 4) b_utf8(out, (uint32_t)v.p[i] << 24 | (uint32_t)v.p[i + 1] << 16 | (uint32_t)v.p[i + 2] << 8 | v.p[i + 3]);
  } else if (tag == 0x0c) {
    b_put(out, v.p, v.n);
  } else {
    for (size_t i = 0; i < v.n; i++) b_utf8(out, v.p[i]);
  }
}
static int ossl_space(int c) { return c == ' ' || c == '\t' || c == '\n' || c == '\v' || c == '\f' || c == '\r'; }
typedef struct {
  Buf enc;
} Ent;
static int ent_cmp(const void *a, const void *b) {
  const Buf *x = &((const Ent *)a)->enc, *y = &((const Ent *)b)->enc;
  size_t m = x->n < y->n ? x->n : y->n;
  int r = memcmp(x->p, y->p, m);
  if (r) return r;
  return x->n < y->n ? -1 : x->n > y->n;
}
/* the canonical encoding of a Name's DER (its SEQUENCE); -1 malformed */
static int name_canon(Span name, Buf *out) {
  const uint8_t *p = name.p, *e = name.p + name.n;
  int tag;
  Span seq;
  if (der(&p, e, &tag, &seq, NULL) || tag != 0x30) return -1;
  p = seq.p;
  e = seq.p + seq.n;
  while (p < e) {
    Span set;
    if (der(&p, e, &tag, &set, NULL) || tag != 0x31) return -1;
    Ent *ents = NULL;
    size_t ne = 0;
    const uint8_t *q = set.p, *qe = set.p + set.n;
    int bad = 0;
    while (q < qe) {
      Span atv, oid, oidw, val, valw;
      int vt;
      if (der(&q, qe, &tag, &atv, NULL) || tag != 0x30) {
        bad = 1;
        break;
      }
      const uint8_t *r = atv.p, *re = atv.p + atv.n;
      if (der(&r, re, &tag, &oid, &oidw) || tag != 0x06 || der(&r, re, &vt, &val, &valw)) {
        bad = 1;
        break;
      }
      ents = realloc(ents, (ne + 1) * sizeof *ents);
      if (!ents) abort();
      Ent *en = &ents[ne++];
      memset(en, 0, sizeof *en);
      Buf body = {0};
      b_put(&body, oidw.p, oidw.n);
      if (canon_type(vt)) {
        Buf u = {0};
        to_utf8(&u, vt, val);
        size_t i = 0, n = u.n;
        while (i < n && ossl_space(u.p ? u.p[i] : 0)) i++;
        while (n > i && ossl_space(u.p[n - 1])) n--;
        Buf c = {0};
        while (i < n) {
          uint8_t ch = u.p[i];
          if (ch >= 0x80) {
            b_chr(&c, ch);
            i++;
          } else if (ossl_space(ch)) {
            b_chr(&c, ' ');
            while (i < n && ossl_space(u.p[i])) i++;
          } else {
            b_chr(&c, ch >= 'A' && ch <= 'Z' ? ch + 32 : ch);
            i++;
          }
        }
        b_chr(&body, 0x0c);
        b_len(&body, c.n);
        b_put(&body, c.p, c.n);
        free(c.p);
        free(u.p);
      } else
        b_put(&body, valw.p, valw.n);
      b_chr(&en->enc, 0x30);
      b_len(&en->enc, body.n);
      b_put(&en->enc, body.p, body.n);
      free(body.p);
    }
    if (bad) {
      for (size_t i = 0; i < ne; i++) free(ents[i].enc.p);
      free(ents);
      return -1;
    }
    qsort(ents, ne, sizeof *ents, ent_cmp);
    size_t total = 0;
    for (size_t i = 0; i < ne; i++) total += ents[i].enc.n;
    b_chr(out, 0x31);
    b_len(out, total);
    for (size_t i = 0; i < ne; i++) {
      b_put(out, ents[i].enc.p, ents[i].enc.n);
      free(ents[i].enc.p);
    }
    free(ents);
  }
  return 0;
}

/* ── the extension cache (v3_purp.c ossl_x509v3_cache_extensions) ─────── */
enum {
  EX_BCONS = 1 << 0,
  EX_KUSAGE = 1 << 1,
  EX_XKUSAGE = 1 << 2,
  EX_NSCERT = 1 << 3,
  EX_CA = 1 << 4,
  EX_SI = 1 << 5,
  EX_V1 = 1 << 6,
  EX_INVALID = 1 << 7,
  EX_CRITICAL = 1 << 8,
  EX_SS = 1 << 9,
};
enum { KU_DIGITAL_SIGNATURE = 0x0080, KU_KEY_ENCIPHERMENT = 0x0020, KU_KEY_AGREEMENT = 0x0008, KU_KEY_CERT_SIGN = 0x0004 };
enum { XKU_SSL_SERVER = 0x1, XKU_SGC = 0x10 };
enum { NS_SSL_SERVER = 0x40, NS_SSL_CA = 0x04, NS_ANY_CA = 0x07 };

typedef struct {
  const mbedtls_x509_crt *c;
  int trusted;
  int flags, kusage, xkusage, nscert;
  long pathlen;
  Span skid;              /* .p NULL: none */
  int has_akid;
  Span akid_keyid, akid_serial, akid_issuer; /* the dirName in authorityCertIssuer */
  Span san, nc;           /* the GeneralNames / NameConstraints contents */
  int has_san, has_nc, has_dns_san;
  Buf subj, iss;          /* canonical names */
  int names_ok;
} Fx;

static const char OID_BC[] = "\x55\x1d\x13", OID_KU[] = "\x55\x1d\x0f", OID_EKU[] = "\x55\x1d\x25", OID_SAN[] = "\x55\x1d\x11",
                  OID_NC[] = "\x55\x1d\x1e", OID_AKID[] = "\x55\x1d\x23", OID_SKID[] = "\x55\x1d\x0e", OID_CP[] = "\x55\x1d\x20",
                  OID_CRLDP[] = "\x55\x1d\x1f", OID_PC[] = "\x55\x1d\x24", OID_PM[] = "\x55\x1d\x21", OID_IAP[] = "\x55\x1d\x36",
                  OID_NSCT[] = "\x60\x86\x48\x01\x86\xf8\x42\x01\x01", OID_OCSPNC[] = "\x2b\x06\x01\x05\x05\x07\x30\x01\x05",
                  OID_PROXY[] = "\x2b\x06\x01\x05\x05\x07\x01\x0e", OID_IPADDR[] = "\x2b\x06\x01\x05\x05\x07\x01\x07",
                  OID_ASNUM[] = "\x2b\x06\x01\x05\x05\x07\x01\x08", OID_SERVER_AUTH[] = "\x2b\x06\x01\x05\x05\x07\x03\x01",
                  OID_NS_SGC[] = "\x60\x86\x48\x01\x86\xf8\x42\x04\x01", OID_MS_SGC[] = "\x2b\x06\x01\x04\x01\x82\x37\x0a\x03\x03",
                  OID_CN[] = "\x55\x04\x03", OID_EMAIL[] = "\x2a\x86\x48\x86\xf7\x0d\x01\x09\x01";

/* X509_supported_extension: the critical extensions OpenSSL handles */
static int supported_ext(Span oid) {
  return OID_IS(oid, OID_NSCT) || OID_IS(oid, OID_KU) || OID_IS(oid, OID_SAN) || OID_IS(oid, OID_BC) || OID_IS(oid, OID_CP) ||
         OID_IS(oid, OID_CRLDP) || OID_IS(oid, OID_EKU) || OID_IS(oid, OID_IPADDR) || OID_IS(oid, OID_ASNUM) || OID_IS(oid, OID_OCSPNC) ||
         OID_IS(oid, OID_PC) || OID_IS(oid, OID_PROXY) || OID_IS(oid, OID_NC) || OID_IS(oid, OID_PM) || OID_IS(oid, OID_IAP);
}

/* a BIT STRING's first data bytes as OpenSSL keeps them */
static int bits16(Span v, int *out) {
  if (v.n < 1) return -1;
  int x = 0;
  if (v.n > 1) x = v.p[1];
  if (v.n > 2) x |= v.p[2] << 8;
  *out = x;
  return 0;
}

static void fx_init(Fx *f, const mbedtls_x509_crt *c, int trusted) {
  memset(f, 0, sizeof *f);
  f->c = c;
  f->trusted = trusted;
  f->pathlen = -1;
  if (c->version == 1) f->flags |= EX_V1;
  Span sr = {c->subject_raw.p, c->subject_raw.len}, ir = {c->issuer_raw.p, c->issuer_raw.len};
  f->names_ok = name_canon(sr, &f->subj) == 0 && name_canon(ir, &f->iss) == 0;
  if (!f->names_ok) f->flags |= EX_INVALID;
  if (c->v3_ext.p && c->v3_ext.len) {
    const uint8_t *p = c->v3_ext.p, *e = c->v3_ext.p + c->v3_ext.len;
    int tag;
    Span seq;
    if (der(&p, e, &tag, &seq, NULL) || tag != 0x30) {
      f->flags |= EX_INVALID;
      return;
    }
    p = seq.p;
    e = seq.p + seq.n;
    while (p < e) {
      Span ext, oid, val;
      if (der(&p, e, &tag, &ext, NULL) || tag != 0x30) {
        f->flags |= EX_INVALID;
        return;
      }
      const uint8_t *q = ext.p, *qe = ext.p + ext.n;
      if (der(&q, qe, &tag, &oid, NULL) || tag != 0x06) {
        f->flags |= EX_INVALID;
        return;
      }
      int crit = 0;
      if (q < qe && *q == 0x01) {
        Span b;
        if (der(&q, qe, &tag, &b, NULL) || b.n != 1) {
          f->flags |= EX_INVALID;
          return;
        }
        crit = b.p[0] != 0;
      }
      if (der(&q, qe, &tag, &val, NULL) || tag != 0x04) {
        f->flags |= EX_INVALID;
        return;
      }
      if (crit && !supported_ext(oid)) f->flags |= EX_CRITICAL;
      const uint8_t *v = val.p, *ve = val.p + val.n;
      Span in;
      if (OID_IS(oid, OID_BC)) {
        if (der(&v, ve, &tag, &in, NULL) || tag != 0x30) {
          f->flags |= EX_INVALID;
          continue;
        }
        const uint8_t *r = in.p, *re = in.p + in.n;
        int ca = 0;
        if (r < re && *r == 0x01) {
          Span b;
          if (der(&r, re, &tag, &b, NULL) || b.n != 1) {
            f->flags |= EX_INVALID;
            continue;
          }
          ca = b.p[0] != 0;
        }
        if (ca) f->flags |= EX_CA;
        if (r < re) {
          Span pl;
          if (der(&r, re, &tag, &pl, NULL) || tag != 0x02 || pl.n == 0) {
            f->flags |= EX_INVALID;
            continue;
          }
          if ((pl.p[0] & 0x80) || !ca) {
            f->flags |= EX_INVALID;
            f->pathlen = 0;
          } else {
            long x = 0;
            for (size_t i = 0; i < pl.n; i++) x = x > (1L << 40) ? x : x * 256 + pl.p[i];
            f->pathlen = x;
          }
        } else
          f->pathlen = -1;
        f->flags |= EX_BCONS;
      } else if (OID_IS(oid, OID_KU)) {
        if (der(&v, ve, &tag, &in, NULL) || tag != 0x03 || bits16(in, &f->kusage)) {
          f->flags |= EX_INVALID;
          continue;
        }
        f->flags |= EX_KUSAGE;
      } else if (OID_IS(oid, OID_NSCT)) {
        if (der(&v, ve, &tag, &in, NULL) || tag != 0x03 || in.n < 1) {
          f->flags |= EX_INVALID;
          continue;
        }
        f->nscert = in.n > 1 ? in.p[1] : 0;
        f->flags |= EX_NSCERT;
      } else if (OID_IS(oid, OID_EKU)) {
        if (der(&v, ve, &tag, &in, NULL) || tag != 0x30) {
          f->flags |= EX_INVALID;
          continue;
        }
        f->flags |= EX_XKUSAGE;
        const uint8_t *r = in.p, *re = in.p + in.n;
        while (r < re) {
          Span o;
          if (der(&r, re, &tag, &o, NULL) || tag != 0x06) {
            f->flags |= EX_INVALID;
            break;
          }
          if (OID_IS(o, OID_SERVER_AUTH)) f->xkusage |= XKU_SSL_SERVER;
          else if (OID_IS(o, OID_NS_SGC) || OID_IS(o, OID_MS_SGC)) f->xkusage |= XKU_SGC;
        }
      } else if (OID_IS(oid, OID_SAN)) {
        if (der(&v, ve, &tag, &in, NULL) || tag != 0x30) {
          f->flags |= EX_INVALID;
          continue;
        }
        f->san = in;
        f->has_san = 1;
        const uint8_t *r = in.p, *re = in.p + in.n;
        while (r < re) {
          Span g;
          int gt;
          if (der(&r, re, &gt, &g, NULL)) {
            f->flags |= EX_INVALID;
            break;
          }
          if ((gt & 0x1f) == 2) f->has_dns_san = 1;
        }
      } else if (OID_IS(oid, OID_NC)) {
        if (der(&v, ve, &tag, &in, NULL) || tag != 0x30) {
          f->flags |= EX_INVALID;
          continue;
        }
        f->nc = in;
        f->has_nc = 1;
      } else if (OID_IS(oid, OID_SKID)) {
        if (der(&v, ve, &tag, &in, NULL) || tag != 0x04) {
          f->flags |= EX_INVALID;
          continue;
        }
        f->skid = in;
      } else if (OID_IS(oid, OID_AKID)) {
        if (der(&v, ve, &tag, &in, NULL) || tag != 0x30) {
          f->flags |= EX_INVALID;
          continue;
        }
        f->has_akid = 1;
        const uint8_t *r = in.p, *re = in.p + in.n;
        while (r < re) {
          Span x;
          int xt;
          if (der(&r, re, &xt, &x, NULL)) {
            f->flags |= EX_INVALID;
            break;
          }
          if (xt == 0x80) f->akid_keyid = x;
          else if (xt == 0x82) f->akid_serial = x;
          else if (xt == 0xa1 && !f->akid_issuer.p) {
            /* the first directoryName ([4], explicit) among the names */
            const uint8_t *s = x.p, *se = x.p + x.n;
            while (s < se) {
              Span g;
              int gt;
              if (der(&s, se, &gt, &g, NULL)) break;
              if (gt == 0xa4) {
                f->akid_issuer = g;
                break;
              }
            }
          }
        }
      }
    }
  }
}
static void fx_free(Fx *f) {
  free(f->subj.p);
  free(f->iss.p);
}

static int name_eq(const Buf *a, const Buf *b) { return a->n == b->n && (a->n == 0 || memcmp(a->p, b->p, a->n) == 0); }

/* X509_check_akid(issuer, subject's AKID) */
static int akid_ok(const Fx *issuer, const Fx *subject) {
  if (!subject->has_akid) return 1;
  if (subject->akid_keyid.p && issuer->skid.p && (subject->akid_keyid.n != issuer->skid.n || memcmp(subject->akid_keyid.p, issuer->skid.p, issuer->skid.n)))
    return 0;
  if (subject->akid_serial.p && (subject->akid_serial.n != issuer->c->serial.len || memcmp(subject->akid_serial.p, issuer->c->serial.p, subject->akid_serial.n)))
    return 0;
  if (subject->akid_issuer.p) {
    Buf nm = {0};
    int ok = name_canon(subject->akid_issuer, &nm) == 0 && name_eq(&nm, &issuer->iss);
    free(nm.p);
    if (!ok) return 0;
  }
  return 1;
}
/* ossl_x509_likely_issued(issuer, subject) == X509_V_OK */
static int likely_issued(const Fx *issuer, const Fx *subject) {
  if (!issuer->names_ok || !subject->names_ok || !name_eq(&issuer->subj, &subject->iss)) return 0;
  if ((issuer->flags | subject->flags) & EX_INVALID) return 0;
  if (!akid_ok(issuer, subject)) return 0;
  return mbedtls_pk_can_do(&issuer->c->pk, subject->c->sig_pk);
}
static void fx_selfness(Fx *f) {
  if (f->names_ok && name_eq(&f->subj, &f->iss)) {
    f->flags |= EX_SI;
    if (akid_ok(f, f) && mbedtls_pk_can_do(&f->c->pk, f->c->sig_pk)) f->flags |= EX_SS;
  }
}

static int time_ok(const mbedtls_x509_crt *c) { return !mbedtls_x509_time_is_future(&c->valid_from) && !mbedtls_x509_time_is_past(&c->valid_to); }
static int later_expiry(const mbedtls_x509_crt *a, const mbedtls_x509_crt *b) {
  const mbedtls_x509_time *x = &a->valid_to, *y = &b->valid_to;
  int ax[6] = {x->year, x->mon, x->day, x->hour, x->min, x->sec}, bx[6] = {y->year, y->mon, y->day, y->hour, y->min, y->sec};
  for (int i = 0; i < 6; i++)
    if (ax[i] != bx[i]) return ax[i] > bx[i];
  return 0;
}

/* X509_verify(subject, issuer's key) */
static int sig_ok(const mbedtls_x509_crt *subject, const mbedtls_x509_crt *issuer) {
  const mbedtls_md_info_t *md = mbedtls_md_info_from_type(subject->sig_md);
  if (!md) return 0;
  unsigned char hash[MBEDTLS_MD_MAX_SIZE];
  if (mbedtls_md(md, subject->tbs.p, subject->tbs.len, hash) != 0) return 0;
  if (!mbedtls_pk_can_do(&issuer->pk, subject->sig_pk)) return 0;
  return mbedtls_pk_verify_ext(subject->sig_pk, subject->sig_opts, (mbedtls_pk_context *)&issuer->pk, subject->sig_md, hash, mbedtls_md_get_size(md),
                               subject->sig.p, subject->sig.len) == 0;
}

/* ── security levels (Node's default: 2, 112 bits) ─────────────────────── */
#define MIN_BITS 112
static const uint64_t SCALE = 1 << 18;
static const uint64_t CBRT_SCALE = 1 << (2 * 18 / 3);
static const uint64_t LOG_2 = 0x02c5c8, LOG_E = 0x05c551, C1_923 = 0x07b126, C4_690 = 0x12c28f;
static uint64_t mul2(uint64_t a, uint64_t b) { return a * b / SCALE; }
static uint64_t icbrt64(uint64_t x) {
  uint64_t r = 0, b;
  for (int s = 63; s >= 0; s -= 3) {
    r <<= 1;
    b = 3 * r * (r + 1) + 1;
    if ((x >> s) >= b) {
      x -= b << s;
      r++;
    }
  }
  return r * CBRT_SCALE;
}
static uint32_t ilog_e(uint64_t v) {
  uint32_t i, r = 0;
  while (v >= 2 * SCALE) {
    v >>= 1;
    r += (uint32_t)SCALE;
  }
  for (i = (uint32_t)SCALE / 2; i != 0; i /= 2) {
    v = mul2(v, v);
    if (v >= 2 * SCALE) {
      v >>= 1;
      r += i;
    }
  }
  return (uint32_t)((r * (uint64_t)SCALE) / LOG_E);
}
/* ossl_ifc_ffc_compute_security_bits */
static int rsa_bits(int n) {
  switch (n) {
    case 2048: return 112;
    case 3072: return 128;
    case 4096: return 152;
    case 6144: return 176;
    case 7680: return 192;
    case 8192: return 200;
    case 15360: return 256;
  }
  if (n >= 687737) return 1200;
  if (n < 8) return 0;
  int cap = n <= 7680 ? 192 : n <= 15360 ? 256 : 1200;
  uint64_t x = (uint64_t)n * LOG_2;
  uint32_t lx = ilog_e(x);
  uint16_t y = (uint16_t)((mul2(C1_923, icbrt64(mul2(mul2(x, lx), lx))) - C4_690) / LOG_2);
  y = (uint16_t)((y + 4) & ~7);
  return y > cap ? cap : y;
}
/* EVP_PKEY_get_security_bits */
static int key_bits(const mbedtls_pk_context *pk) {
  mbedtls_pk_type_t t = mbedtls_pk_get_type(pk);
  int b = (int)mbedtls_pk_get_bitlen(pk);
  if (t == MBEDTLS_PK_RSA || t == MBEDTLS_PK_RSASSA_PSS) return rsa_bits(b);
  if (t == MBEDTLS_PK_ECKEY || t == MBEDTLS_PK_ECDSA || t == MBEDTLS_PK_ECKEY_DH) {
    if (b >= 512) return 256;
    if (b >= 384) return 192;
    if (b >= 256) return 128;
    if (b >= 224) return 112;
    if (b >= 160) return 80;
    return b / 2;
  }
  return 0;
}
/* the signature's security bits (x509_sig_info_init) */
static int sig_bits(const mbedtls_x509_crt *c) {
  switch (c->sig_md) {
    case MBEDTLS_MD_MD5: return 39;
    case MBEDTLS_MD_SHA1: return 63;
    case MBEDTLS_MD_SHA224: return 112;
    case MBEDTLS_MD_SHA256: return 128;
    case MBEDTLS_MD_SHA384: return 192;
    case MBEDTLS_MD_SHA512: return 256;
    case MBEDTLS_MD_RIPEMD160: return 80;
    default: return 0;
  }
}

/* ── purposes (v3_purp.c) ──────────────────────────────────────────────── */
#define ku_reject(f, u) (((f)->flags & EX_KUSAGE) && !((f)->kusage & (u)))
#define xku_reject(f, u) (((f)->flags & EX_XKUSAGE) && !((f)->xkusage & (u)))
#define ns_reject(f, u) (((f)->flags & EX_NSCERT) && !((f)->nscert & (u)))
/* check_ca */
static int check_ca(const Fx *f) {
  if (ku_reject(f, KU_KEY_CERT_SIGN)) return 0;
  if (f->flags & EX_BCONS) return (f->flags & EX_CA) != 0;
  if ((f->flags & (EX_V1 | EX_SS)) == (EX_V1 | EX_SS)) return 3;
  if (f->flags & EX_KUSAGE) return 4;
  if ((f->flags & EX_NSCERT) && (f->nscert & NS_ANY_CA)) return 5;
  return 0;
}
/* X509_check_ca (0 when the extensions did not decode) */
static int x509_check_ca(const Fx *f) { return (f->flags & EX_INVALID) ? 0 : check_ca(f); }
/* X509_check_purpose(x, X509_PURPOSE_SSL_SERVER, ca): 1, 0, or -1 */
static int purpose_ssl_server(const Fx *f, int require_ca) {
  if (f->flags & EX_INVALID) return -1;
  if (xku_reject(f, XKU_SSL_SERVER | XKU_SGC)) return 0;
  if (require_ca) {
    int r = check_ca(f);
    if (r == 0) return 0;
    return r != 5 || (f->nscert & NS_SSL_CA) != 0;
  }
  if (ns_reject(f, NS_SSL_SERVER)) return 0;
  if (ku_reject(f, KU_DIGITAL_SIGNATURE | KU_KEY_ENCIPHERMENT | KU_KEY_AGREEMENT)) return 0;
  return 1;
}

/* ── name constraints (v3_ncons.c) ─────────────────────────────────────── */
enum { V_OK = 0, V_PERMITTED = 47, V_EXCLUDED = 48, V_MINMAX = 49, V_CTYPE = 51, V_CSYNTAX = 52, V_NSYNTAX = 53, V_UNSPEC = 1 };
static int ia5ncasecmp(const uint8_t *a, const uint8_t *b, size_t n) {
  for (size_t i = 0; i < n; i++) {
    int x = a[i] >= 'A' && a[i] <= 'Z' ? a[i] + 32 : a[i], y = b[i] >= 'A' && b[i] <= 'Z' ? b[i] + 32 : b[i];
    if (x != y) return x < y ? -1 : 1;
  }
  return 0;
}
static const uint8_t *memrchr_n(const uint8_t *p, size_t n, int c) {
  while (n--)
    if (p[n] == c) return p + n;
  return NULL;
}
static int nc_dns(Span dns, Span base) {
  if (base.n == 0) return V_OK;
  if (dns.n < base.n) return V_PERMITTED;
  const uint8_t *d = dns.p;
  if (dns.n > base.n) {
    d += dns.n - base.n;
    if (base.p[0] != '.' && d[-1] != '.') return V_PERMITTED;
  }
  return ia5ncasecmp(base.p, d, base.n) ? V_PERMITTED : V_OK;
}
static int nc_email(Span eml, Span base) {
  const uint8_t *bp = base.p, *ep = eml.p;
  const uint8_t *bat = memrchr_n(base.p, base.n, '@'), *eat = memrchr_n(eml.p, eml.n, '@');
  if (!eat) return V_NSYNTAX;
  if (!bat && base.n > 0 && bp[0] == '.') {
    if (eml.n > base.n) {
      ep += eml.n - base.n;
      if (ia5ncasecmp(bp, ep, base.n) == 0) return V_OK;
    }
    return V_PERMITTED;
  }
  if (bat) {
    if (bat != bp) {
      if (bat - bp != eat - ep) return V_PERMITTED;
      if (memchr(bp, 0, (size_t)(bat - bp)) || memchr(ep, 0, (size_t)(eat - ep))) return V_NSYNTAX;
      if (memcmp(bp, ep, (size_t)(eat - ep))) return V_PERMITTED;
    }
    bp = bat + 1;
  }
  ep = eat + 1;
  size_t bl = (size_t)(base.p + base.n - bp), el = (size_t)(eml.p + eml.n - ep);
  if (bl != el || ia5ncasecmp(bp, ep, el)) return V_PERMITTED;
  return V_OK;
}
static int nc_uri(Span uri, Span base) {
  const uint8_t *e = uri.p + uri.n;
  const uint8_t *p = memchr(uri.p, ':', uri.n);
  if (!p || e - p < 3 || p[1] != '/' || p[2] != '/') return V_NSYNTAX;
  const uint8_t *host = p + 3;
  p = memchr(host, ':', (size_t)(e - host));
  if (!p) p = memchr(host, '/', (size_t)(e - host));
  size_t hl = p ? (size_t)(p - host) : (size_t)(e - host);
  if (hl == 0) return V_NSYNTAX;
  if (base.n > 0 && base.p[0] == '.') {
    if (hl > base.n && ia5ncasecmp(host + hl - base.n, base.p, base.n) == 0) return V_OK;
    return V_PERMITTED;
  }
  if (base.n != hl || ia5ncasecmp(host, base.p, hl)) return V_PERMITTED;
  return V_OK;
}
static int nc_ip(Span ip, Span base) {
  if (ip.n != 4 && ip.n != 16) return V_NSYNTAX;
  if (base.n != 8 && base.n != 32) return V_NSYNTAX;
  if (ip.n * 2 != base.n) return V_PERMITTED;
  const uint8_t *mask = base.p + ip.n;
  for (size_t i = 0; i < ip.n; i++)
    if ((ip.p[i] & mask[i]) != (base.p[i] & mask[i])) return V_PERMITTED;
  return V_OK;
}
static int nc_dn(const Buf *nm, Span base_name) {
  Buf b = {0};
  if (name_canon(base_name, &b) != 0) {
    free(b.p);
    return V_CSYNTAX;
  }
  int r = V_OK;
  if (b.n > nm->n || (b.n && memcmp(b.p, nm->p, b.n))) r = V_PERMITTED;
  free(b.p);
  return r;
}
/* a GeneralName as nc_match sees it: its type (the tag number), its value
 * (for [0] otherName and [4] directoryName, the explicit inner element) */
typedef struct {
  int type;
  Span v;        /* IA5 / octets content; for dirName the Name's whole DER */
  const Buf *dn; /* a subject name already canonical */
  Span oid;      /* otherName type-id */
} Gn;
static int gn_read(int tag, Span val, Gn *g) {
  memset(g, 0, sizeof *g);
  g->type = tag & 0x1f;
  g->v = val;
  if (g->type == 4) {
    const uint8_t *p = val.p;
    Span inner, whole;
    int t;
    if (der(&p, val.p + val.n, &t, &inner, &whole) || t != 0x30) return -1;
    g->v = whole;
  } else if (g->type == 0) {
    const uint8_t *p = val.p;
    Span oid;
    int t;
    if (der(&p, val.p + val.n, &t, &oid, NULL) || t != 0x06) return -1;
    g->oid = oid;
  }
  return 0;
}
static int nc_single(const Gn *gen, const Gn *base) {
  switch (gen->type) {
    case 0: return V_CTYPE; /* SmtpUTF8Mailbox not supported here: refused as an unsupported constraint type */
    case 4: {
      if (gen->dn) return nc_dn(gen->dn, base->v);
      Buf nm = {0};
      int r = name_canon(gen->v, &nm) == 0 ? nc_dn(&nm, base->v) : V_NSYNTAX;
      free(nm.p);
      return r;
    }
    case 2: return nc_dns(gen->v, base->v);
    case 1: return nc_email(gen->v, base->v);
    case 6: return nc_uri(gen->v, base->v);
    case 7: return nc_ip(gen->v, base->v);
    default: return V_CTYPE;
  }
}
/* the subtrees of one kind ([0] permitted / [1] excluded) */
typedef struct {
  Gn base;
  int minmax_ok;
} Sub;
static int read_subtrees(Span nc, int which, Sub **out, size_t *n) {
  *out = NULL;
  *n = 0;
  const uint8_t *p = nc.p, *e = nc.p + nc.n;
  while (p < e) {
    int t;
    Span v;
    if (der(&p, e, &t, &v, NULL)) return -1;
    if (t != (0xa0 | which)) continue;
    const uint8_t *q = v.p, *qe = v.p + v.n;
    while (q < qe) {
      Span gs;
      if (der(&q, qe, &t, &gs, NULL) || t != 0x30) return -1;
      const uint8_t *r = gs.p, *re = gs.p + gs.n;
      Span bv;
      int bt;
      if (der(&r, re, &bt, &bv, NULL)) return -1;
      Sub s;
      memset(&s, 0, sizeof s);
      if (gn_read(bt, bv, &s.base)) return -1;
      s.minmax_ok = 1;
      while (r < re) {
        Span mv;
        int mt;
        if (der(&r, re, &mt, &mv, NULL)) return -1;
        if (mt == 0x81) s.minmax_ok = 0; /* a maximum */
        if (mt == 0x80) {
          for (size_t i = 0; i < mv.n; i++)
            if (mv.p[i]) s.minmax_ok = 0; /* a minimum other than 0 */
        }
      }
      *out = realloc(*out, (*n + 1) * sizeof **out);
      if (!*out) abort();
      (*out)[(*n)++] = s;
    }
  }
  return 0;
}
static int nc_match(const Gn *gen, const Sub *perm, size_t np, const Sub *excl, size_t nx) {
  int match = 0;
  for (size_t i = 0; i < np; i++) {
    const Sub *s = &perm[i];
    if (gen->type != s->base.type || (gen->type == 0 && (gen->oid.n != s->base.oid.n || memcmp(gen->oid.p, s->base.oid.p, gen->oid.n)))) continue;
    if (!s->minmax_ok) return V_MINMAX;
    if (match == 2) continue;
    if (match == 0) match = 1;
    int r = nc_single(gen, &s->base);
    if (r == V_OK) match = 2;
    else if (r != V_PERMITTED) return r;
  }
  if (match == 1) return V_PERMITTED;
  for (size_t i = 0; i < nx; i++) {
    const Sub *s = &excl[i];
    if (gen->type != s->base.type || (gen->type == 0 && (gen->oid.n != s->base.oid.n || memcmp(gen->oid.p, s->base.oid.p, gen->oid.n)))) continue;
    if (!s->minmax_ok) return V_MINMAX;
    int r = nc_single(gen, &s->base);
    if (r == V_OK) return V_EXCLUDED;
    if (r != V_PERMITTED) return r;
  }
  return V_OK;
}
/* the subject's attributes: each (type, value) handed to `fn` */
typedef int (*AtvFn)(Span oid, int vtag, Span val, void *ctx);
static int each_atv(Span name, AtvFn fn, void *ctx, size_t *count) {
  const uint8_t *p = name.p, *e = name.p + name.n;
  int tag;
  Span seq;
  if (count) *count = 0;
  if (der(&p, e, &tag, &seq, NULL) || tag != 0x30) return V_NSYNTAX;
  p = seq.p;
  e = seq.p + seq.n;
  while (p < e) {
    Span set;
    if (der(&p, e, &tag, &set, NULL)) return V_NSYNTAX;
    const uint8_t *q = set.p, *qe = set.p + set.n;
    while (q < qe) {
      Span atv, oid, val;
      int vt;
      if (der(&q, qe, &tag, &atv, NULL)) return V_NSYNTAX;
      const uint8_t *r = atv.p, *re = atv.p + atv.n;
      if (der(&r, re, &tag, &oid, NULL) || der(&r, re, &vt, &val, NULL)) return V_NSYNTAX;
      if (count) (*count)++;
      if (fn) {
        int rv = fn(oid, vt, val, ctx);
        if (rv) return rv;
      }
    }
  }
  return V_OK;
}
typedef struct {
  const Sub *perm, *excl;
  size_t np, nx;
} NcCtx;
static int email_atv(Span oid, int vtag, Span val, void *vctx) {
  NcCtx *c = vctx;
  if (!OID_IS(oid, OID_EMAIL)) return V_OK;
  if (vtag != 0x16) return V_NSYNTAX;
  Gn g;
  memset(&g, 0, sizeof g);
  g.type = 1;
  g.v = val;
  return nc_match(&g, c->perm, c->np, c->excl, c->nx);
}
/* cn2dnsid: a CN that reads as a DNS name (two labels or more) */
static int cn_atv(Span oid, int vtag, Span val, void *vctx) {
  NcCtx *c = vctx;
  if (!OID_IS(oid, OID_CN)) return V_OK;
  Buf u = {0};
  to_utf8(&u, vtag, val);
  size_t n = u.n;
  while (n > 0 && u.p[n - 1] == 0) n--;
  if (n && memchr(u.p, 0, n)) {
    free(u.p);
    return V_NSYNTAX;
  }
  int isdns = 0;
  for (size_t i = 0; i < n; i++) {
    uint8_t ch = u.p[i];
    if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch == '_') continue;
    if (i > 0 && i < n - 1) {
      if (ch == '-') continue;
      if (ch == '.' && u.p[i + 1] != '.' && u.p[i - 1] != '-' && u.p[i + 1] != '-') {
        isdns = 1;
        continue;
      }
    }
    isdns = 0;
    break;
  }
  int r = V_OK;
  if (isdns && n) {
    Gn g;
    memset(&g, 0, sizeof g);
    g.type = 2;
    g.v.p = u.p;
    g.v.n = n;
    r = nc_match(&g, c->perm, c->np, c->excl, c->nx);
  }
  free(u.p);
  return r;
}
#define NAME_CHECK_MAX (1 << 20)
/* NAME_CONSTRAINTS_check (+ the CN check for a leaf without DNS names) */
static int nc_check(const Fx *x, const Fx *ca, int leaf) {
  Sub *perm = NULL, *excl = NULL;
  size_t np = 0, nx = 0;
  if (read_subtrees(ca->nc, 0, &perm, &np) || read_subtrees(ca->nc, 1, &excl, &nx)) {
    free(perm);
    free(excl);
    return V_CSYNTAX;
  }
  NcCtx ctx = {perm, excl, np, nx};
  Span subj = {x->c->subject_raw.p, x->c->subject_raw.len};
  size_t nent = 0, nsan = 0;
  int r = each_atv(subj, NULL, NULL, &nent);
  if (x->has_san) {
    const uint8_t *p = x->san.p, *e = x->san.p + x->san.n;
    while (p < e) {
      int t;
      Span v;
      if (der(&p, e, &t, &v, NULL)) break;
      nsan++;
    }
  }
  size_t names = nent + nsan, cons = np + nx;
  if (r == V_OK && names > 0 && cons > NAME_CHECK_MAX / names) r = V_UNSPEC;
  if (r == V_OK && nent > 0) {
    Gn g;
    memset(&g, 0, sizeof g);
    g.type = 4;
    g.dn = &x->subj;
    r = nc_match(&g, perm, np, excl, nx);
    if (r == V_OK) r = each_atv(subj, email_atv, &ctx, NULL);
  }
  if (r == V_OK && x->has_san) {
    const uint8_t *p = x->san.p, *e = x->san.p + x->san.n;
    while (p < e && r == V_OK) {
      int t;
      Span v;
      if (der(&p, e, &t, &v, NULL)) break;
      Gn g;
      if (gn_read(t, v, &g)) {
        r = V_NSYNTAX;
        break;
      }
      r = nc_match(&g, perm, np, excl, nx);
    }
  }
  if (r == V_OK && leaf && !x->has_dns_san) r = each_atv(subj, cn_atv, &ctx, NULL);
  free(perm);
  free(excl);
  return r;
}

/* ── X509_verify_cert ──────────────────────────────────────────────────── */
#define MAX_DEPTH 101 /* the verify depth (100) + 1 */

int wn_x509_verify(const mbedtls_x509_crt *peer, const mbedtls_x509_crt *trust) {
  if (!peer || !peer->raw.p) return V_UNSPEC;
  int last = 0;
#define FAIL(e) (last = (e))
  /* the certificates: the peer's (untrusted) and the store's */
  size_t np = 0, nt = 0;
  for (const mbedtls_x509_crt *c = peer; c && c->raw.p; c = c->next) np++;
  for (const mbedtls_x509_crt *c = trust; c && c->raw.p; c = c->next) nt++;
  Fx *pf = calloc(np + 1, sizeof *pf), *tf = calloc(nt + 1, sizeof *tf);
  if (!pf || !tf) abort();
  size_t k = 0;
  for (const mbedtls_x509_crt *c = peer; c && c->raw.p; c = c->next) fx_init(&pf[k], c, 0), fx_selfness(&pf[k]), k++;
  k = 0;
  for (const mbedtls_x509_crt *c = trust; c && c->raw.p; c = c->next) fx_init(&tf[k], c, 1), fx_selfness(&tf[k]), k++;
  char *used = calloc(np + 1, 1);
  if (!used) abort();
  used[0] = 1;
  Fx *chain[MAX_DEPTH + 2];
  int num = 1, num_untrusted = 1;
  chain[0] = &pf[0];

  /* the peer's key */
  if (key_bits(&pf[0].c->pk) < MIN_BITS) FAIL(66); /* EE_KEY_TOO_SMALL */

  /* build_chain: trusted first, then the peer's certificates */
  enum { S_UNTRUSTED = 1, S_TRUSTED = 2 };
  int search = S_UNTRUSTED | S_TRUSTED, trusted = 0;
  while (search) {
    if (search & S_TRUSTED) {
      Fx *curr = chain[num - 1];
      Fx *iss = NULL;
      if (num <= MAX_DEPTH)
        for (size_t i = 0; i < nt; i++) {
          if (!likely_issued(&tf[i], curr)) continue;
          if (time_ok(tf[i].c)) {
            iss = &tf[i];
            break;
          }
          if (!iss || later_expiry(tf[i].c, iss->c)) iss = &tf[i];
        }
      int ok = iss != NULL;
      if (ok) {
        int self = (curr->flags & EX_SS) != 0;
        if (!self) {
          chain[num++] = iss;
          self = (iss->flags & EX_SS) != 0;
        } else if (curr->c->raw.len != iss->c->raw.len || memcmp(curr->c->raw.p, iss->c->raw.p, iss->c->raw.len)) {
          ok = 0; /* a self-signed mimic of a trusted certificate */
        } else {
          chain[num - 1] = iss;
          num_untrusted = num - 1;
        }
        if (ok) {
          search &= ~S_UNTRUSTED;
          /* check_trust: a self-signed certificate from the store anchors */
          for (int i = num_untrusted; i < num; i++)
            if ((chain[i]->flags & (EX_SS | EX_INVALID)) == EX_SS) trusted = 1;
          if (trusted) break;
          if (!self) continue;
        }
      }
      if (!(search & S_UNTRUSTED)) break;
    }
    if (search & S_UNTRUSTED) {
      Fx *curr = chain[num - 1];
      Fx *iss = NULL;
      size_t iss_i = 0;
      if (!(curr->flags & EX_SS) && num <= MAX_DEPTH)
        for (size_t i = 1; i < np; i++) {
          if (used[i] || !likely_issued(&pf[i], curr)) continue;
          if (time_ok(pf[i].c)) {
            iss = &pf[i];
            iss_i = i;
            break;
          }
          if (!iss || later_expiry(pf[i].c, iss->c)) iss = &pf[i], iss_i = i;
        }
      if (!iss) {
        search &= ~S_UNTRUSTED;
        search |= S_TRUSTED;
        continue;
      }
      used[iss_i] = 1;
      chain[num++] = iss;
      num_untrusted++;
    }
  }
  if (!trusted) {
    if (num > MAX_DEPTH) FAIL(22); /* CERT_CHAIN_TOO_LONG */
    else if (chain[num - 1]->flags & EX_SS) FAIL(num == 1 ? 18 : 19);
    else FAIL(num_untrusted < num ? 2 : 20);
  }

  /* check_extensions */
  {
    int plen = 0, must_be_ca = -1;
    for (int i = 0; i < num; i++) {
      Fx *x = chain[i];
      if (x->flags & EX_CRITICAL) FAIL(34); /* UNHANDLED_CRITICAL_EXTENSION */
      int ret = x509_check_ca(x);
      if (must_be_ca == -1) ret = 1;
      else if (ret == 0 || (i + 1 < num && ret != 1)) {
        ret = 0;
        FAIL(79); /* INVALID_CA (OpenSSL 3 numbering) */
      } else
        ret = 1;
      (void)ret;
      int pr = purpose_ssl_server(x, must_be_ca > 0);
      if (pr == 0) FAIL(26); /* INVALID_PURPOSE */
      if (i > 1 && x->pathlen != -1 && plen > x->pathlen) FAIL(25); /* PATH_LENGTH_EXCEEDED */
      if (i > 0 && !(x->flags & EX_SI)) plen++;
      must_be_ca = 1;
    }
  }

  /* check_auth_level */
  for (int i = 0; i < num; i++) {
    if (i > 0 && key_bits(&chain[i]->c->pk) < MIN_BITS) FAIL(67); /* CA_KEY_TOO_SMALL */
    if (i < num - 1 && sig_bits(chain[i]->c) < MIN_BITS) FAIL(68); /* CA_MD_TOO_WEAK */
  }

  /* internal_verify: from the top down, the issuer's key usage, the
   * signature, then the certificate's validity */
  {
    int n = num - 1;
    Fx *xi = chain[n], *xs = xi;
    if (!likely_issued(xi, xi)) {
      if (n > 0) {
        n--;
        xs = chain[n];
      } else
        FAIL(21); /* UNABLE_TO_VERIFY_LEAF_SIGNATURE */
    }
    while (n >= 0) {
      if (xs != xi) {
        if (ku_reject(xi, KU_KEY_CERT_SIGN)) FAIL(32); /* KEYUSAGE_NO_CERTSIGN */
        if (!sig_ok(xs->c, xi->c)) FAIL(7);           /* CERT_SIGNATURE_FAILURE */
      }
      if (mbedtls_x509_time_is_future(&xs->c->valid_from)) FAIL(9); /* CERT_NOT_YET_VALID */
      if (mbedtls_x509_time_is_past(&xs->c->valid_to)) FAIL(10);    /* CERT_HAS_EXPIRED */
      if (--n >= 0) {
        xi = xs;
        xs = chain[n];
      }
    }
  }

  /* check_name_constraints */
  for (int i = num - 1; i >= 0; i--) {
    Fx *x = chain[i];
    if (i != 0 && (x->flags & EX_SI)) continue;
    for (int j = num - 1; j > i; j--) {
      if (!chain[j]->has_nc) continue;
      int rv = nc_check(x, chain[j], i == 0);
      if (rv != V_OK) FAIL(rv);
    }
  }

  for (size_t i = 0; i < np; i++) fx_free(&pf[i]);
  for (size_t i = 0; i < nt; i++) fx_free(&tf[i]);
  free(pf);
  free(tf);
  free(used);
  return last;
#undef FAIL
}

const char *wn_x509_err_text(int code) {
  switch (code) {
    case 0: return "ok";
    case 2: return "unable to get issuer certificate";
    case 3: return "unable to get certificate CRL";
    case 4: return "unable to decrypt certificate's signature";
    case 6: return "unable to decode issuer public key";
    case 7: return "certificate signature failure";
    case 9: return "certificate is not yet valid";
    case 10: return "certificate has expired";
    case 13: return "format error in certificate's notBefore field";
    case 14: return "format error in certificate's notAfter field";
    case 17: return "out of memory";
    case 18: return "self-signed certificate";
    case 19: return "self-signed certificate in certificate chain";
    case 20: return "unable to get local issuer certificate";
    case 21: return "unable to verify the first certificate";
    case 22: return "certificate chain too long";
    case 23: return "certificate revoked";
    case 24: return "issuer certificate doesn't have a public key";
    case 79: return "invalid CA certificate";
    case 25: return "path length constraint exceeded";
    case 26: return "unsuitable certificate purpose";
    case 27: return "certificate not trusted";
    case 28: return "certificate rejected";
    case 32: return "key usage does not include certificate signing";
    case 34: return "unhandled critical extension";
    case 37: return "invalid non-CA certificate (has CA markings)";
    case 41: return "invalid or inconsistent certificate extension";
    case 47: return "permitted subtree violation";
    case 48: return "excluded subtree violation";
    case 49: return "name constraints minimum and maximum not supported";
    case 51: return "unsupported name constraint type";
    case 52: return "unsupported or invalid name constraint syntax";
    case 53: return "unsupported or invalid name syntax";
    case 66: return "EE certificate key too weak";
    case 67: return "CA certificate key too weak";
    case 68: return "CA signature digest algorithm too weak";
    default: return "unspecified certificate verification error";
  }
}

const char *wn_x509_err_name(int code) {
  switch (code) {
    case 2: return "UNABLE_TO_GET_ISSUER_CERT";
    case 3: return "UNABLE_TO_GET_CRL";
    case 4: return "UNABLE_TO_DECRYPT_CERT_SIGNATURE";
    case 5: return "UNABLE_TO_DECRYPT_CRL_SIGNATURE";
    case 6: return "UNABLE_TO_DECODE_ISSUER_PUBLIC_KEY";
    case 7: return "CERT_SIGNATURE_FAILURE";
    case 8: return "CRL_SIGNATURE_FAILURE";
    case 9: return "CERT_NOT_YET_VALID";
    case 10: return "CERT_HAS_EXPIRED";
    case 11: return "CRL_NOT_YET_VALID";
    case 12: return "CRL_HAS_EXPIRED";
    case 13: return "ERROR_IN_CERT_NOT_BEFORE_FIELD";
    case 14: return "ERROR_IN_CERT_NOT_AFTER_FIELD";
    case 15: return "ERROR_IN_CRL_LAST_UPDATE_FIELD";
    case 16: return "ERROR_IN_CRL_NEXT_UPDATE_FIELD";
    case 17: return "OUT_OF_MEM";
    case 18: return "DEPTH_ZERO_SELF_SIGNED_CERT";
    case 19: return "SELF_SIGNED_CERT_IN_CHAIN";
    case 20: return "UNABLE_TO_GET_ISSUER_CERT_LOCALLY";
    case 21: return "UNABLE_TO_VERIFY_LEAF_SIGNATURE";
    case 22: return "CERT_CHAIN_TOO_LONG";
    case 23: return "CERT_REVOKED";
    case 79: return "INVALID_CA";
    case 25: return "PATH_LENGTH_EXCEEDED";
    case 26: return "INVALID_PURPOSE";
    case 27: return "CERT_UNTRUSTED";
    case 28: return "CERT_REJECTED";
    case 62: return "HOSTNAME_MISMATCH";
    default: return "UNSPECIFIED";
  }
}

/* ── tls.checkServerIdentity ───────────────────────────────────────────── */

/* PrintAltName: a name Node can print as is, or its JSON-escaped form */
static void alt_name(Buf *b, const uint8_t *p, size_t n, int utf8) {
  int safe = 1;
  for (size_t i = 0; i < n && safe; i++) {
    uint8_t c = p[i];
    if (c == '"' || c == '\\' || c == ',' || c == '\'') safe = 0;
    else if (utf8 ? (c < ' ' || c == 0x7f) : (c < ' ' || c > '~')) safe = 0;
  }
  if (safe) {
    b_put(b, p, n);
    return;
  }
  b_chr(b, '"');
  for (size_t i = 0; i < n; i++) {
    uint8_t c = p[i];
    if (c == '"' || c == '\\') {
      b_chr(b, '\\');
      b_chr(b, c);
    } else if ((c >= ' ' && c != ',' && c <= '~') || (utf8 && (c & 0x80))) {
      b_chr(b, c);
    } else {
      char e[8];
      snprintf(e, sizeof e, "\\u%04x", c);
      b_cat(b, e);
    }
  }
  b_chr(b, '"');
}

/* X509_NAME_print_ex(..., XN_FLAG_RFC2253-style) of a directoryName: the
 * common attributes by their short names, others by number */
static void dn_print(Buf *b, Span name) {
  const uint8_t *p = name.p, *e = name.p + name.n;
  int tag;
  Span seq;
  if (der(&p, e, &tag, &seq, NULL)) return;
  /* RFC 2253 order: the last RDN first */
  Span rdns[64];
  int nr = 0;
  p = seq.p;
  e = seq.p + seq.n;
  while (p < e && nr < 64) {
    if (der(&p, e, &tag, &rdns[nr], NULL)) return;
    nr++;
  }
  for (int i = nr - 1; i >= 0; i--) {
    const uint8_t *q = rdns[i].p, *qe = rdns[i].p + rdns[i].n;
    int first = 1;
    while (q < qe) {
      Span atv, oid, val;
      int vt;
      if (der(&q, qe, &tag, &atv, NULL)) return;
      const uint8_t *r = atv.p, *re = atv.p + atv.n;
      if (der(&r, re, &tag, &oid, NULL) || der(&r, re, &vt, &val, NULL)) return;
      if (!first) b_chr(b, '+');
      first = 0;
      const char *sn = NULL;
      mbedtls_asn1_buf ob = {MBEDTLS_ASN1_OID, oid.n, (unsigned char *)oid.p};
      if (mbedtls_oid_get_attr_short_name(&ob, &sn) != 0) sn = NULL;
      if (sn) b_cat(b, sn);
      else {
        char num[128];
        if (mbedtls_oid_get_numeric_string(num, sizeof num, &ob) > 0) b_cat(b, num);
      }
      b_chr(b, '=');
      Buf u = {0};
      to_utf8(&u, vt, val);
      for (size_t k = 0; k < u.n; k++) {
        uint8_t c = u.p[k];
        if (c == ',' || c == '+' || c == '"' || c == '\\' || c == '<' || c == '>' || c == ';' || (k == 0 && (c == '#' || c == ' ')) || (k == u.n - 1 && c == ' '))
          b_chr(b, '\\');
        b_chr(b, c);
      }
      free(u.p);
    }
    if (i > 0) b_chr(b, ',');
  }
}

/* cert.subjectaltname as Node prints it, and the DNS and IP lists
 * checkServerIdentity reads back out of it */
typedef struct {
  Span *dns;
  size_t ndns;
  char **ips; /* canonicalized */
  size_t nips;
} AltLists;
static void alt_names(const Fx *f, Buf *out, AltLists *l) {
  if (!f->has_san) return;
  const uint8_t *p = f->san.p, *e = f->san.p + f->san.n;
  int first = 1;
  while (p < e) {
    int t;
    Span v;
    if (der(&p, e, &t, &v, NULL)) break;
    Buf item = {0};
    int type = t & 0x1f;
    switch (type) {
      case 2:
        b_cat(&item, "DNS:");
        alt_name(&item, v.p, v.n, 0);
        l->dns = realloc(l->dns, (l->ndns + 1) * sizeof *l->dns);
        if (!l->dns) abort();
        l->dns[l->ndns++] = v;
        break;
      case 1:
        b_cat(&item, "email:");
        alt_name(&item, v.p, v.n, 0);
        break;
      case 6:
        b_cat(&item, "URI:");
        alt_name(&item, v.p, v.n, 0);
        break;
      case 4: {
        b_cat(&item, "DirName:");
        const uint8_t *q = v.p;
        Span inner, whole;
        int it;
        if (der(&q, v.p + v.n, &it, &inner, &whole) == 0) {
          Buf dn = {0};
          dn_print(&dn, whole);
          alt_name(&item, dn.p ? dn.p : (const uint8_t *)"", dn.n, 1);
          free(dn.p);
        }
        break;
      }
      case 7: {
        b_cat(&item, "IP Address:");
        char txt[64] = "";
        char canon[INET6_ADDRSTRLEN] = "";
        if (v.n == 4) {
          snprintf(txt, sizeof txt, "%d.%d.%d.%d", v.p[0], v.p[1], v.p[2], v.p[3]);
          inet_ntop(AF_INET, v.p, canon, sizeof canon);
        } else if (v.n == 16) {
          size_t o = 0;
          for (int j = 0; j < 8; j++) o += (size_t)snprintf(txt + o, sizeof txt - o, j ? ":%X" : "%X", v.p[2 * j] << 8 | v.p[2 * j + 1]);
          inet_ntop(AF_INET6, v.p, canon, sizeof canon);
        } else
          snprintf(txt, sizeof txt, "<invalid length=%d>", (int)v.n);
        b_cat(&item, txt);
        l->ips = realloc(l->ips, (l->nips + 1) * sizeof *l->ips);
        if (!l->ips) abort();
        l->ips[l->nips++] = strdup(canon);
        break;
      }
      case 8: {
        b_cat(&item, "Registered ID:");
        char num[128] = "";
        mbedtls_asn1_buf ob = {MBEDTLS_ASN1_OID, v.n, (unsigned char *)v.p};
        if (mbedtls_oid_get_numeric_string(num, sizeof num, &ob) > 0) b_cat(&item, num);
        break;
      }
      case 0: b_cat(&item, "othername:<unsupported>"); break;
      case 3: b_cat(&item, "X400Name:<unsupported>"); break;
      case 5: b_cat(&item, "EdiPartyName:<unsupported>"); break;
      default: break;
    }
    if (item.n) {
      if (!first) b_cat(out, ", ");
      first = 0;
      b_put(out, item.p, item.n);
    }
    free(item.p);
  }
}

/* a name split as checkServerIdentity splits one: one trailing dot off,
 * A-Z lowered, cut at every dot */
typedef struct {
  uint8_t *buf;
  Span *v;
  size_t n;
} Labels;
static void labels(const uint8_t *s, size_t n, Labels *l) {
  if (n && s[n - 1] == '.') n--;
  l->buf = malloc(n + 1);
  if (!l->buf) abort();
  for (size_t i = 0; i < n; i++) l->buf[i] = s[i] >= 'A' && s[i] <= 'Z' ? s[i] + 32 : s[i];
  size_t k = 1;
  for (size_t i = 0; i < n; i++) k += l->buf[i] == '.';
  l->v = malloc(k * sizeof *l->v);
  if (!l->v) abort();
  l->n = 0;
  size_t st = 0;
  for (size_t i = 0; i <= n; i++)
    if (i == n || l->buf[i] == '.') {
      l->v[l->n].p = l->buf + st;
      l->v[l->n].n = i - st;
      l->n++;
      st = i + 1;
    }
}
static void labels_free(Labels *l) {
  free(l->buf);
  free(l->v);
}
static int lab_eq(Span a, Span b) { return a.n == b.n && (a.n == 0 || memcmp(a.p, b.p, a.n) == 0); }
/* check(hostParts, pattern, wildcards = true) */
static int name_check(const Labels *hp, const uint8_t *pat, size_t pn) {
  if (pn == 0) return 0;
  Labels pp;
  labels(pat, pn, &pp);
  int ok = 0;
  if (pp.n != hp->n) goto out;
  for (size_t i = 0; i < pp.n; i++) {
    if (pp.v[i].n == 0) goto out;
    for (size_t j = 0; j < pp.v[i].n; j++)
      if (pp.v[i].p[j] < 0x21 || pp.v[i].p[j] > 0x7f) goto out; /* isBad */
  }
  for (size_t i = hp->n - 1; i > 0; i--)
    if (!lab_eq(hp->v[i], pp.v[i])) goto out;
  {
    Span hs = hp->v[0], ps = pp.v[0];
    size_t stars = 0;
    const uint8_t *star = NULL;
    for (size_t j = 0; j < ps.n; j++)
      if (ps.p[j] == '*') {
        if (!star) star = ps.p + j;
        stars++;
      }
    int xn = 0;
    for (size_t j = 0; j + 4 <= ps.n; j++)
      if (!memcmp(ps.p + j, "xn--", 4)) xn = 1;
    if (stars == 0 || xn) {
      ok = lab_eq(hs, ps);
      goto out;
    }
    if (stars > 1) goto out;
    if (pp.n <= 2) goto out;
    size_t pre = (size_t)(star - ps.p), suf = ps.n - pre - 1;
    if (pre + suf > hs.n) goto out;
    if (memcmp(hs.p, ps.p, pre)) goto out;
    if (memcmp(hs.p + hs.n - suf, star + 1, suf)) goto out;
    ok = 1;
  }
out:
  labels_free(&pp);
  return ok;
}

typedef struct {
  Buf *vals;
  size_t n;
} Cns;
static int collect_cn(Span oid, int vtag, Span val, void *vctx) {
  Cns *c = vctx;
  if (!OID_IS(oid, OID_CN)) return 0;
  c->vals = realloc(c->vals, (c->n + 1) * sizeof *c->vals);
  if (!c->vals) abort();
  Buf *b = &c->vals[c->n++];
  memset(b, 0, sizeof *b);
  to_utf8(b, vtag, val);
  if (!b->p) b_put(b, "", 0);
  return 0;
}

char *wn_x509_check_identity(const mbedtls_x509_crt *leaf, const char *host, size_t host_len, size_t *reason_len) {
  Buf reason = {0};
  if (!leaf || !leaf->raw.p) {
    b_cat(&reason, "Cert does not contain a DNS name");
    *reason_len = reason.n;
    return (char *)reason.p;
  }
  Fx f;
  fx_init(&f, leaf, 0);
  Buf alt = {0};
  AltLists l = {0};
  alt_names(&f, &alt, &l);
  Cns cns = {0};
  Span subj = {leaf->subject_raw.p, leaf->subject_raw.len};
  each_atv(subj, collect_cn, &cns, NULL);
  /* hostname: unfqdn; the ASCII form (domainToASCII): an IPv6 address
   * (the URL's host without its brackets) has none */
  size_t hn = host_len;
  if (hn && host[hn - 1] == '.') hn--;
  int v6 = memchr(host, ':', host_len) != NULL;
  struct in_addr a4;
  char hbuf[64];
  int is_ip = 0;
  if (!v6 && hn < sizeof hbuf) {
    memcpy(hbuf, host, hn);
    hbuf[hn] = 0;
    is_ip = inet_pton(AF_INET, hbuf, &a4) == 1;
  }
  int valid = 0;
  if (is_ip) {
    for (size_t i = 0; i < l.nips && !valid; i++) valid = strcmp(l.ips[i], hbuf) == 0;
    if (!valid) {
      b_cat(&reason, "IP: ");
      b_put(&reason, host, hn);
      b_cat(&reason, " is not in the cert's list: ");
      for (size_t i = 0; i < l.nips; i++) {
        if (i) b_cat(&reason, ", ");
        b_cat(&reason, l.ips[i]);
      }
    }
  } else if (l.ndns > 0 || (cns.n == 1 && cns.vals[0].n > 0) || cns.n > 1) {
    Labels hp;
    labels(v6 ? (const uint8_t *)"" : (const uint8_t *)host, v6 ? 0 : host_len, &hp);
    if (l.ndns > 0) {
      for (size_t i = 0; i < l.ndns && !valid; i++) valid = name_check(&hp, l.dns[i].p, l.dns[i].n);
      if (!valid) {
        b_cat(&reason, "Host: ");
        b_put(&reason, host, hn);
        b_cat(&reason, ". is not in the cert's altnames: ");
        b_put(&reason, alt.p, alt.n);
      }
    } else {
      for (size_t i = 0; i < cns.n && !valid; i++) valid = name_check(&hp, cns.vals[i].p, cns.vals[i].n);
      if (!valid) {
        b_cat(&reason, "Host: ");
        b_put(&reason, host, hn);
        b_cat(&reason, ". is not cert's CN: ");
        for (size_t i = 0; i < cns.n; i++) {
          if (i) b_chr(&reason, ',');
          b_put(&reason, cns.vals[i].p, cns.vals[i].n);
        }
      }
    }
    labels_free(&hp);
  } else
    b_cat(&reason, "Cert does not contain a DNS name");
  for (size_t i = 0; i < l.nips; i++) free(l.ips[i]);
  free(l.ips);
  free(l.dns);
  for (size_t i = 0; i < cns.n; i++) free(cns.vals[i].p);
  free(cns.vals);
  free(alt.p);
  fx_free(&f);
  if (valid) {
    free(reason.p);
    return NULL;
  }
  if (!reason.p) b_put(&reason, "", 0);
  *reason_len = reason.n;
  return (char *)reason.p;
}
