/* Node's words for a peer certificate, for the native runner's fetch
 * (wn_fetch.c; OpenSSL unit O2). The verdict itself is OpenSSL's — the
 * engine's SSL_get_verify_result, reached with Node's verify callback —
 * so nothing of X509_verify_cert is transcribed here any more; what is
 * left is what Node's JavaScript and C++ add around it:
 *  - the verdict's code and reason (ncrypto X509Pointer::ErrorCode,
 *    crypto_common.cc GetValidationErrorReason with its --use-system-ca
 *    suggestion);
 *  - tls.checkServerIdentity (lib/tls.js), which undici's connections run,
 *    over the certificate as getPeerCertificate presents it: its
 *    subjectaltname as ncrypto's SafeX509SubjectAltNamePrint prints it
 *    (each GENERAL_NAME OpenSSL parsed, Node's escaping of an unsafe name),
 *    read back as checkServerIdentity reads it, and subject.CN — every
 *    commonName entry, ASN1_STRING_to_UTF8'd (crypto_x509.cc
 *    GetX509NameObject).
 * SEMANTICS.md S117 (h). */
#define _GNU_SOURCE
#include <arpa/inet.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <openssl/asn1.h>
#include <openssl/bio.h>
#include <openssl/err.h>
#include <openssl/objects.h>
#include <openssl/x509.h>
#include <openssl/x509v3.h>

#include "wn_trust.h"
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
  uint8_t ch = (uint8_t)c;
  b_put(b, &ch, 1);
}
static void b_cat(Buf *b, const char *s) { b_put(b, s, strlen(s)); }

/* ── the verdict's words ──────────────────────────────────────────────── */
char *wn_x509_err_reason(long code) {
  const char *text = X509_verify_cert_error_string(code);
  int suggest = code == X509_V_ERR_UNABLE_TO_VERIFY_LEAF_SIGNATURE || code == X509_V_ERR_DEPTH_ZERO_SELF_SIGNED_CERT ||
                (code == X509_V_ERR_UNABLE_TO_GET_ISSUER_CERT && !wn_trust_use_system_ca());
  Buf b = {0};
  b_cat(&b, text);
  if (suggest) b_cat(&b, "; if the root CA is installed locally, try running Node.js with --use-system-ca");
  return (char *)b.p;
}

const char *wn_x509_err_name(long code) {
  switch (code) {
#define CASE(C) \
  case X509_V_ERR_##C: return #C;
    CASE(UNABLE_TO_GET_ISSUER_CERT)
    CASE(UNABLE_TO_GET_CRL)
    CASE(UNABLE_TO_DECRYPT_CERT_SIGNATURE)
    CASE(UNABLE_TO_DECRYPT_CRL_SIGNATURE)
    CASE(UNABLE_TO_DECODE_ISSUER_PUBLIC_KEY)
    CASE(CERT_SIGNATURE_FAILURE)
    CASE(CRL_SIGNATURE_FAILURE)
    CASE(CERT_NOT_YET_VALID)
    CASE(CERT_HAS_EXPIRED)
    CASE(CRL_NOT_YET_VALID)
    CASE(CRL_HAS_EXPIRED)
    CASE(ERROR_IN_CERT_NOT_BEFORE_FIELD)
    CASE(ERROR_IN_CERT_NOT_AFTER_FIELD)
    CASE(ERROR_IN_CRL_LAST_UPDATE_FIELD)
    CASE(ERROR_IN_CRL_NEXT_UPDATE_FIELD)
    CASE(OUT_OF_MEM)
    CASE(DEPTH_ZERO_SELF_SIGNED_CERT)
    CASE(SELF_SIGNED_CERT_IN_CHAIN)
    CASE(UNABLE_TO_GET_ISSUER_CERT_LOCALLY)
    CASE(UNABLE_TO_VERIFY_LEAF_SIGNATURE)
    CASE(CERT_CHAIN_TOO_LONG)
    CASE(CERT_REVOKED)
    CASE(INVALID_CA)
    CASE(PATH_LENGTH_EXCEEDED)
    CASE(INVALID_PURPOSE)
    CASE(CERT_UNTRUSTED)
    CASE(CERT_REJECTED)
    CASE(HOSTNAME_MISMATCH)
#undef CASE
    default: return "UNSPECIFIED";
  }
}

/* ── cert.subjectaltname (ncrypto PrintGeneralName) ───────────────────── */

/* IsSafeAltName */
static int safe_alt_name(const uint8_t *p, size_t n, int utf8) {
  for (size_t i = 0; i < n; i++) {
    uint8_t c = p[i];
    if (c == '"' || c == '\\' || c == ',' || c == '\'') return 0;
    if (utf8 ? (c < ' ' || c == 0x7f) : (c < ' ' || c > '~')) return 0;
  }
  return 1;
}
/* PrintAltName: a safe name as it is, else JSON-escaped in quotes (the
 * prefix inside them) */
static void print_alt_name(Buf *b, const uint8_t *p, size_t n, int utf8, const char *safe_prefix) {
  if (safe_alt_name(p, n, utf8)) {
    if (safe_prefix) {
      b_cat(b, safe_prefix);
      b_chr(b, ':');
    }
    b_put(b, p, n);
    return;
  }
  b_chr(b, '"');
  if (safe_prefix) {
    b_cat(b, safe_prefix);
    b_chr(b, ':');
  }
  for (size_t i = 0; i < n; i++) {
    uint8_t c = p[i];
    if (c == '\\') b_cat(b, "\\\\");
    else if (c == '"') b_cat(b, "\\\"");
    else if ((c >= ' ' && c != ',' && c <= '~') || (utf8 && (c & 0x80))) b_chr(b, c);
    else {
      static const char hex[] = "0123456789abcdef";
      char u[6] = {'\\', 'u', '0', '0', hex[(c & 0xf0) >> 4], hex[c & 0x0f]};
      b_put(b, u, sizeof u);
    }
  }
  b_chr(b, '"');
}
static void print_asn1_alt(Buf *b, const ASN1_STRING *s, int utf8, const char *prefix) {
  print_alt_name(b, ASN1_STRING_get0_data(s), (size_t)ASN1_STRING_length(s), utf8, prefix);
}

/* the DNS names and the canonicalized IP-address names checkServerIdentity
 * reads back out of the printed list */
typedef struct {
  Span *dns;
  size_t ndns;
  char **ips;
  size_t nips;
} AltLists;

/* one GENERAL_NAME (PrintGeneralName); 0 when it cannot be printed */
static int print_general_name(Buf *out, const GENERAL_NAME *gen, AltLists *l) {
  switch (gen->type) {
    case GEN_DNS: {
      b_cat(out, "DNS:");
      print_asn1_alt(out, gen->d.dNSName, 0, NULL);
      l->dns = realloc(l->dns, (l->ndns + 1) * sizeof *l->dns);
      if (!l->dns) abort();
      l->dns[l->ndns].p = ASN1_STRING_get0_data(gen->d.dNSName);
      l->dns[l->ndns].n = (size_t)ASN1_STRING_length(gen->d.dNSName);
      l->ndns++;
      return 1;
    }
    case GEN_EMAIL:
      b_cat(out, "email:");
      print_asn1_alt(out, gen->d.rfc822Name, 0, NULL);
      return 1;
    case GEN_URI:
      b_cat(out, "URI:");
      print_asn1_alt(out, gen->d.uniformResourceIdentifier, 0, NULL);
      return 1;
    case GEN_DIRNAME: {
      b_cat(out, "DirName:");
      BIO *tmp = BIO_new(BIO_s_mem());
      if (!tmp) abort();
      /* kX509NameFlagsRFC2253WithinUtf8JSON */
      if (X509_NAME_print_ex(tmp, gen->d.dirn, 0, XN_FLAG_RFC2253 & ~ASN1_STRFLGS_ESC_MSB & ~ASN1_STRFLGS_ESC_CTRL) < 0) {
        BIO_free(tmp);
        return 0;
      }
      char *oline = NULL;
      long nb = BIO_get_mem_data(tmp, &oline);
      print_alt_name(out, (const uint8_t *)oline, nb > 0 ? (size_t)nb : 0, 1, NULL);
      BIO_free(tmp);
      return 1;
    }
    case GEN_IPADD: {
      b_cat(out, "IP Address:");
      const unsigned char *p = ASN1_STRING_get0_data(gen->d.ip);
      int len = ASN1_STRING_length(gen->d.ip);
      char txt[64];
      char canon[INET6_ADDRSTRLEN] = "";
      if (len == 4) {
        snprintf(txt, sizeof txt, "%d.%d.%d.%d", p[0], p[1], p[2], p[3]);
        inet_ntop(AF_INET, p, canon, sizeof canon);
      } else if (len == 16) {
        size_t o = 0;
        for (int j = 0; j < 8; j++) o += (size_t)snprintf(txt + o, sizeof txt - o, j ? ":%X" : "%X", p[2 * j] << 8 | p[2 * j + 1]);
        inet_ntop(AF_INET6, p, canon, sizeof canon);
      } else
        snprintf(txt, sizeof txt, "<invalid length=%d>", len);
      b_cat(out, txt);
      /* canonicalizeIP of what Node printed: "" for no address */
      l->ips = realloc(l->ips, (l->nips + 1) * sizeof *l->ips);
      if (!l->ips) abort();
      l->ips[l->nips++] = strdup(canon);
      return 1;
    }
    case GEN_RID: {
      char oline[256];
      OBJ_obj2txt(oline, sizeof oline, gen->d.rid, 1);
      b_cat(out, "Registered ID:");
      b_cat(out, oline);
      return 1;
    }
    case GEN_OTHERNAME: {
      int unicode = 1;
      const char *prefix = NULL;
      switch (OBJ_obj2nid(gen->d.otherName->type_id)) {
        case NID_id_on_SmtpUTF8Mailbox: prefix = "SmtpUTF8Mailbox"; break;
        case NID_XmppAddr: prefix = "XmppAddr"; break;
        case NID_SRVName:
          prefix = "SRVName";
          unicode = 0;
          break;
        case NID_ms_upn: prefix = "UPN"; break;
        case NID_NAIRealm: prefix = "NAIRealm"; break;
        default: break;
      }
      int vt = gen->d.otherName->value->type;
      if (prefix == NULL || (unicode && vt != V_ASN1_UTF8STRING) || (!unicode && vt != V_ASN1_IA5STRING)) {
        b_cat(out, "othername:<unsupported>");
      } else {
        b_cat(out, "othername:");
        print_asn1_alt(out, unicode ? gen->d.otherName->value->value.utf8string : gen->d.otherName->value->value.ia5string, unicode, prefix);
      }
      return 1;
    }
    case GEN_X400: b_cat(out, "X400Name:<unsupported>"); return 1;
    case GEN_EDIPARTY: b_cat(out, "EdiPartyName:<unsupported>"); return 1;
    default: return 0;
  }
}

/* X509View::getSubjectAltName: the first subjectAltName extension, as
 * X509V3_EXT_d2i reads it; 0 (no subjectaltname at all) when there is
 * none, it does not decode, or a name cannot be printed */
static int subject_alt_names(X509 *x, Buf *out, AltLists *l, GENERAL_NAMES **keep) {
  ERR_set_mark();
  int ok = 0;
  int idx = X509_get_ext_by_NID(x, NID_subject_alt_name, -1);
  if (idx >= 0) {
    GENERAL_NAMES *names = X509V3_EXT_d2i(X509_get_ext(x, idx));
    if (names) {
      ok = 1;
      for (int i = 0; i < sk_GENERAL_NAME_num(names); i++) {
        if (i) b_cat(out, ", ");
        if (!print_general_name(out, sk_GENERAL_NAME_value(names, i), l)) {
          ok = 0;
          break;
        }
      }
      *keep = names; /* the DNS spans point into it */
    }
  }
  ERR_pop_to_mark();
  return ok;
}

/* ── tls.checkServerIdentity ───────────────────────────────────────────── */

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

/* subject.CN: every commonName entry's UTF-8 value, in order */
typedef struct {
  Buf *vals;
  size_t n;
} Cns;
static void collect_cns(X509 *x, Cns *c) {
  const X509_NAME *name = X509_get_subject_name(x);
  for (int i = 0; i < X509_NAME_entry_count(name); i++) {
    const X509_NAME_ENTRY *e = X509_NAME_get_entry(name, i);
    if (OBJ_obj2nid(X509_NAME_ENTRY_get_object(e)) != NID_commonName) continue;
    unsigned char *u = NULL;
    int n = ASN1_STRING_to_UTF8(&u, X509_NAME_ENTRY_get_data(e));
    c->vals = realloc(c->vals, (c->n + 1) * sizeof *c->vals);
    if (!c->vals) abort();
    Buf *b = &c->vals[c->n++];
    memset(b, 0, sizeof *b);
    b_put(b, u, n > 0 ? (size_t)n : 0);
    OPENSSL_free(u);
  }
}

char *wn_x509_check_identity(X509 *leaf, const char *host, size_t host_len, size_t *reason_len) {
  Buf reason = {0};
  if (!leaf) {
    b_cat(&reason, "Cert does not contain a DNS name");
    *reason_len = reason.n;
    return (char *)reason.p;
  }
  Buf alt = {0};
  AltLists l = {0};
  GENERAL_NAMES *san = NULL;
  if (!subject_alt_names(leaf, &alt, &l, &san)) {
    /* no subjectaltname: neither DNS nor IP names */
    l.ndns = 0;
    for (size_t i = 0; i < l.nips; i++) free(l.ips[i]);
    l.nips = 0;
  }
  Cns cns = {0};
  collect_cns(leaf, &cns);
  /* hostname: unfqdn; an IPv6 address (the URL's host without its
   * brackets) is not net.isIP's IPv4 here — Node's undici hands it over
   * bracketed, so it is matched against the DNS names and fails */
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
  if (san) GENERAL_NAMES_free(san);
  if (valid) {
    free(reason.p);
    return NULL;
  }
  if (!reason.p) b_put(&reason, "", 0);
  *reason_len = reason.n;
  return (char *)reason.p;
}
