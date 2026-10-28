/* The native runner's fetch (native-runner phase N1): abi.ts's `fetch`
 * import — START / ABORT, the answer as evPoll source 6 (HEAD, BODY,
 * FAIL). abi.ts and SEMANTICS.md S098 (a) make the network half the
 * HOST's own fetch; under the differential harness that is Node's
 * (undici), so this unit answers as undici does, measured against Node
 * v24.18.1 — the Request constructor's refusals and their texts, the
 * request head on the wire (host, connection, the program's headers,
 * content-type, then undici's defaults and content-length, in that
 * order), the fetch spec's redirect rules (20 hops; 303, and 301/302 for
 * POST, become a GET without the body and its content-* headers; a
 * cross-origin hop drops authorization, proxy-authorization and cookie),
 * the fetch spec's bad ports, data: URLs, content decoding (gzip, x-gzip,
 * deflate; an unknown coding leaves the body as it came), Node's opt-in
 * environment proxy (NODE_USE_ENV_PROXY=1 with http_proxy / no_proxy),
 * and the failures' messages and causes ("fetch failed" with "connect
 * ECONNREFUSED <ip>:<port>", "getaddrinfo ENOTFOUND <host>", undici's
 * "other side closed", "terminated" for a body cut short, ...). What the
 * module builds from these is the module's (fetch.ts).
 *
 * The transfer runs on the runner's event loop (wn_ev.c), never on a
 * thread of its own: a name is looked up on a thread (as libuv does), the
 * socket is non-blocking and polled with the program's other descriptors,
 * and https goes through Node's own OpenSSL (the TLS unit's engine,
 * wn_trust.c) on the program thread, driven as Node's TLSWrap drives it
 * for undici's tls.connect: a default secure context, the always-accepting
 * verify callback, SNI for a host name, ALPN "http/1.1", the verdict
 * (SSL_get_verify_result) and then tls.checkServerIdentity. A request holds the loop from START until its BODY or
 * FAIL is queued, or the module ABORTs it. Connections are not kept for
 * reuse (undici's pool is not observable by a program; the request still
 * says `connection: keep-alive`, as undici's does).
 *
 * What differs from Node is SEMANTICS.md S117 (h). */
#define _GNU_SOURCE
#include <arpa/inet.h>
#include <ctype.h>
#include <errno.h>
#include <fcntl.h>
#include <netdb.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <pthread.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/epoll.h>
#include <sys/random.h>
#include <sys/socket.h>
#include <unistd.h>

#include <openssl/bio.h>
#include <openssl/err.h>
#include <openssl/ssl.h>
#include <openssl/x509.h>

#include "scr_zlib_prefix.h"
#include "zlib.h"

#include "wn_host.h"
#include "wn_llw.h"
#include "wn_trust.h"
#include "wn_x509.h"

extern void (*wn_fetch_delivered)(const WnEv *e);

enum { EV_HEAD = 1, EV_BODY = 2, EV_FAIL = 3 };

/* ── small strings ────────────────────────────────────────────────────── */
static char *xstrndup(const char *s, size_t n) {
  char *p = malloc(n + 1);
  if (!p) abort();
  memcpy(p, s, n);
  p[n] = 0;
  return p;
}
static char *xstrdup(const char *s) { return xstrndup(s, strlen(s)); }
typedef struct {
  char *p;
  size_t n, cap;
} Str;
static void s_put(Str *s, const char *p, size_t n) {
  if (s->n + n + 1 > s->cap) {
    size_t c = s->cap ? s->cap : 64;
    while (c < s->n + n + 1) c *= 2;
    s->p = realloc(s->p, c);
    if (!s->p) abort();
    s->cap = c;
  }
  memcpy(s->p + s->n, p, n);
  s->n += n;
  s->p[s->n] = 0;
}
static void s_cat(Str *s, const char *p) { s_put(s, p, strlen(p)); }
static void s_chr(Str *s, char c) { s_put(s, &c, 1); }
static char *s_take(Str *s) {
  if (!s->p) return xstrdup("");
  char *p = s->p;
  s->p = NULL;
  s->n = s->cap = 0;
  return p;
}

/* ── URLs (the WHATWG parser's shape, for what fetch takes) ───────────── */
typedef struct {
  char *scheme; /* lowercase, no ':' */
  char *user, *pass;
  char *host;   /* NULL for an opaque URL; IPv6 kept with its brackets */
  int port;     /* -1: the scheme's default */
  char *path;   /* "/..." (special) or the opaque path */
  char *query;  /* "" or "?..." */
  char *frag;   /* "" or "#..." */
  int special;
} Url;

static void url_free(Url *u) {
  free(u->scheme);
  free(u->user);
  free(u->pass);
  free(u->host);
  free(u->path);
  free(u->query);
  free(u->frag);
  memset(u, 0, sizeof *u);
}
static int default_port(const char *scheme) {
  if (!strcmp(scheme, "http") || !strcmp(scheme, "ws")) return 80;
  if (!strcmp(scheme, "https") || !strcmp(scheme, "wss")) return 443;
  if (!strcmp(scheme, "ftp")) return 21;
  return -1;
}
static int is_special(const char *scheme) {
  return !strcmp(scheme, "http") || !strcmp(scheme, "https") || !strcmp(scheme, "ws") || !strcmp(scheme, "wss") || !strcmp(scheme, "ftp") ||
         !strcmp(scheme, "file");
}

/* percent-encode sets: 1 C0, 2 fragment, 3 query, 4 special-query, 5 path, 6 userinfo */
static int in_set(unsigned char c, int set) {
  if (c < 0x20 || c > 0x7e) return 1;
  if (set == 1) return 0;
  if (set == 2) return c == ' ' || c == '"' || c == '<' || c == '>' || c == '`';
  int q = c == ' ' || c == '"' || c == '#' || c == '<' || c == '>';
  if (set == 3) return q;
  if (set == 4) return q || c == '\'';
  int p = q || c == '?' || c == '^' || c == '`' || c == '{' || c == '}';
  if (set == 5) return p;
  return p || c == '/' || c == ':' || c == ';' || c == '=' || c == '@' || c == '[' || c == '\\' || c == ']' || c == '|';
}
static void enc_put(Str *s, const char *p, size_t n, int set) {
  for (size_t i = 0; i < n; i++) {
    unsigned char c = (unsigned char)p[i];
    if (in_set(c, set)) {
      char b[4];
      snprintf(b, sizeof b, "%%%02X", c);
      s_put(s, b, 3);
    } else
      s_chr(s, (char)c);
  }
}

static int hexv(int c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}
static char *pct_decode(const char *p, size_t n, size_t *outn) {
  char *o = malloc(n + 1);
  if (!o) abort();
  size_t k = 0;
  for (size_t i = 0; i < n; i++) {
    if (p[i] == '%' && i + 2 < n + 0 && hexv((unsigned char)p[i + 1]) >= 0 && hexv((unsigned char)p[i + 2]) >= 0) {
      o[k++] = (char)(hexv((unsigned char)p[i + 1]) * 16 + hexv((unsigned char)p[i + 2]));
      i += 2;
    } else
      o[k++] = p[i];
  }
  o[k] = 0;
  if (outn) *outn = k;
  return o;
}

/* an IPv4 number part (decimal, 0x hex, 0 octal); -1 invalid */
static long long v4_part(const char *p, size_t n) {
  if (n == 0) return -1;
  int base = 10;
  if (n >= 2 && p[0] == '0' && (p[1] == 'x' || p[1] == 'X')) base = 16, p += 2, n -= 2;
  else if (n >= 2 && p[0] == '0') base = 8, p++, n--;
  if (n == 0) return 0;
  long long v = 0;
  for (size_t i = 0; i < n; i++) {
    int d = hexv((unsigned char)p[i]);
    if (d < 0 || d >= base) return -1;
    v = v * base + d;
    if (v > 0xffffffffLL) return 0x100000000LL;
  }
  return v;
}
/* the WHATWG URL serializer's IPv6 address: lowercase hex pieces, the
 * first longest run of two or more zero pieces compressed to "::" (never
 * a dotted IPv4 tail — "::ffff:7f00:1", as Node's URL prints it) */
static void ipv6_ser(const uint8_t a[16], Str *s) {
  unsigned w[8];
  for (int i = 0; i < 8; i++) w[i] = (unsigned)(a[2 * i] << 8 | a[2 * i + 1]);
  int best = -1, bestlen = 0;
  for (int i = 0; i < 8;) {
    if (w[i] != 0) {
      i++;
      continue;
    }
    int j = i;
    while (j < 8 && w[j] == 0) j++;
    if (j - i > bestlen) best = i, bestlen = j - i;
    i = j;
  }
  if (bestlen < 2) best = -1;
  int ignore0 = 0;
  for (int i = 0; i < 8; i++) {
    if (ignore0 && w[i] == 0) continue;
    ignore0 = 0;
    if (best == i) {
      s_cat(s, i == 0 ? "::" : ":");
      ignore0 = 1;
      continue;
    }
    char h[8];
    snprintf(h, sizeof h, "%x", w[i]);
    s_cat(s, h);
    if (i != 7) s_chr(s, ':');
  }
}

/* an "xn--" label as the URL parser's domain-to-ASCII accepts one: its
 * Punycode (RFC 3492) must decode, to something that is not plain ASCII,
 * holding no code point UTS #46 never lets through (an ASCII capital or
 * symbol, a control, a surrogate, a noncharacter). The rest of UTS #46's
 * table (mapped and disallowed code points) is not consulted: SEMANTICS.md
 * S117 (h). 1 when acceptable. */
static int puny_ok(const char *p, size_t n) {
  enum { BASE = 36, TMIN = 1, TMAX = 26, SKEW = 38, DAMP = 700 };
  uint32_t out[256];
  size_t on = 0;
  size_t b = 0;
  for (size_t j = 0; j < n; j++)
    if (p[j] == '-') b = j + 1;
  size_t in = 0;
  if (b > 0) {
    if (b - 1 > sizeof out / sizeof *out) return 0;
    for (size_t j = 0; j + 1 < b; j++) out[on++] = (unsigned char)p[j];
    in = b;
  }
  uint32_t nn = 128, i = 0, bias = 72;
  while (in < n) {
    uint32_t oldi = i, w = 1;
    for (uint32_t k = BASE;; k += BASE) {
      if (in >= n) return 0;
      int c = (unsigned char)p[in++];
      uint32_t d = c >= 'a' && c <= 'z' ? (uint32_t)(c - 'a') : c >= 'A' && c <= 'Z' ? (uint32_t)(c - 'A') : c >= '0' && c <= '9' ? (uint32_t)(c - '0' + 26) : 99;
      if (d >= BASE) return 0;
      if (d > (UINT32_MAX - i) / w) return 0;
      i += d * w;
      uint32_t t = k <= bias ? TMIN : k >= bias + TMAX ? TMAX : k - bias;
      if (d < t) break;
      if (w > UINT32_MAX / (BASE - t)) return 0;
      w *= BASE - t;
    }
    /* adapt */
    uint32_t delta = oldi == 0 ? (i - oldi) / DAMP : (i - oldi) / 2;
    delta += delta / (uint32_t)(on + 1);
    uint32_t kk = 0;
    while (delta > ((BASE - TMIN) * TMAX) / 2) delta /= BASE - TMIN, kk += BASE;
    bias = kk + (BASE - TMIN + 1) * delta / (delta + SKEW);
    if (i / (on + 1) > UINT32_MAX - nn) return 0;
    nn += i / (uint32_t)(on + 1);
    i %= (uint32_t)(on + 1);
    if (on >= sizeof out / sizeof *out) return 0;
    memmove(out + i + 1, out + i, (on - i) * sizeof *out);
    out[i++] = nn;
    on++;
  }
  if (on == 0) return 0;
  int non_ascii = 0;
  for (size_t j = 0; j < on; j++) {
    uint32_t c = out[j];
    if (c >= 0x80) non_ascii = 1;
    if (c < 0xa0 && !((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-')) return 0;
    if ((c >= 0xd800 && c <= 0xdfff) || c > 0x10ffff || (c >= 0xfdd0 && c <= 0xfdef) || (c & 0xfffe) == 0xfffe) return 0;
  }
  return non_ascii;
}

/* host: 0 ok (*out set), -1 invalid */
static int parse_host(const char *p, size_t n, char **out) {
  if (n == 0) return -1;
  if (p[0] == '[') {
    if (p[n - 1] != ']') return -1;
    char buf[64];
    if (n - 2 >= sizeof buf) return -1;
    memcpy(buf, p + 1, n - 2);
    buf[n - 2] = 0;
    struct in6_addr a;
    if (inet_pton(AF_INET6, buf, &a) != 1) return -1;
    Str s = {0};
    s_chr(&s, '[');
    ipv6_ser(a.s6_addr, &s);
    s_chr(&s, ']');
    *out = s_take(&s);
    return 0;
  }
  size_t dn;
  char *d = pct_decode(p, n, &dn);
  for (size_t i = 0; i < dn; i++) {
    unsigned char c = (unsigned char)d[i];
    /* a non-ASCII name would go through IDNA (punycode): not here (SEMANTICS.md S117 (h)) */
    if (c >= 0x80 || c <= 0x20 || c == 0x7f || strchr("#%/:<>?@[\\]^|", c)) {
      free(d);
      return -1;
    }
    d[i] = (char)tolower(c);
  }
  /* a Punycode label must decode (domain to ASCII) */
  for (size_t st = 0; st <= dn;) {
    size_t en = st;
    while (en < dn && d[en] != '.') en++;
    if (en - st >= 4 && !memcmp(d + st, "xn--", 4) && !puny_ok(d + st + 4, en - st - 4)) {
      free(d);
      return -1;
    }
    st = en + 1;
  }
  /* an IPv4 address in any of its number forms ends in a number */
  const char *last = strrchr(d, '.');
  const char *lab = last ? last + 1 : d;
  if (*lab == 0 && last) {
    /* a trailing dot: the label before it decides */
    const char *q = last;
    while (q > d && q[-1] != '.') q--;
    lab = q;
  }
  int numeric = *lab != 0;
  for (const char *q = lab; *q && *q != '.'; q++)
    if (!isxdigit((unsigned char)*q) && *q != 'x' && *q != 'X') numeric = 0;
  if (numeric && (isdigit((unsigned char)*lab))) {
    long long parts[4];
    int np = 0;
    const char *q = d;
    size_t len = strlen(d);
    if (len && d[len - 1] == '.') len--;
    while (q <= d + len) {
      const char *e = memchr(q, '.', (size_t)(d + len - q));
      if (!e) e = d + len;
      if (np == 4) {
        free(d);
        return -1;
      }
      parts[np] = v4_part(q, (size_t)(e - q));
      if (parts[np] < 0) {
        free(d);
        return -1;
      }
      np++;
      q = e + 1;
    }
    unsigned long long v = 0;
    for (int i = 0; i < np - 1; i++) {
      if (parts[i] > 255) {
        free(d);
        return -1;
      }
      v = v * 256 + (unsigned long long)parts[i];
    }
    long long lastp = parts[np - 1];
    if (lastp >= (1LL << (8 * (5 - np)))) {
      free(d);
      return -1;
    }
    for (int i = np - 1; i < 4; i++) v *= 256;
    v = v / 256 + 0;
    v = 0;
    for (int i = 0; i < np - 1; i++) v = (v << 8) | (unsigned long long)parts[i];
    v <<= 8 * (5 - np);
    v |= (unsigned long long)lastp;
    char txt[32];
    snprintf(txt, sizeof txt, "%llu.%llu.%llu.%llu", (v >> 24) & 255, (v >> 16) & 255, (v >> 8) & 255, v & 255);
    free(d);
    *out = xstrdup(txt);
    return 0;
  }
  *out = d;
  return 0;
}

/* the path's segments with "." and ".." applied (special URLs) */
static char *norm_path(const char *p, size_t n) {
  /* split on '/' (and '\\'), percent-encoded per the path set */
  char **segs = NULL;
  size_t ns = 0, cap = 0;
  size_t i = 0;
  if (n > 0 && (p[0] == '/' || p[0] == '\\')) i = 1;
  for (;;) {
    size_t j = i;
    while (j < n && p[j] != '/' && p[j] != '\\') j++;
    char *seg = xstrndup(p + i, j - i);
    int dot = !strcmp(seg, ".") || !strcasecmp(seg, "%2e");
    int dotdot = !strcmp(seg, "..") || !strcasecmp(seg, ".%2e") || !strcasecmp(seg, "%2e.") || !strcasecmp(seg, "%2e%2e");
    int at_end = j >= n;
    if (dotdot) {
      if (ns > 0) free(segs[--ns]);
      if (at_end) {
        if (ns == cap) segs = realloc(segs, sizeof *segs * (cap = cap ? cap * 2 : 8));
        segs[ns++] = xstrdup("");
      }
      free(seg);
    } else if (dot) {
      if (at_end) {
        if (ns == cap) segs = realloc(segs, sizeof *segs * (cap = cap ? cap * 2 : 8));
        segs[ns++] = xstrdup("");
      }
      free(seg);
    } else {
      if (ns == cap) segs = realloc(segs, sizeof *segs * (cap = cap ? cap * 2 : 8));
      segs[ns++] = seg;
    }
    if (at_end) break;
    i = j + 1;
  }
  Str s = {0};
  for (size_t k = 0; k < ns; k++) {
    s_chr(&s, '/');
    enc_put(&s, segs[k], strlen(segs[k]), 5);
    free(segs[k]);
  }
  free(segs);
  if (s.n == 0) s_chr(&s, '/');
  return s_take(&s);
}

/* 0 ok, -1 invalid ("Invalid URL") */
static int url_parse(const char *input, Url *u) {
  memset(u, 0, sizeof *u);
  /* strip leading and trailing C0 control or space; drop tab and newlines */
  size_t n = strlen(input);
  size_t a = 0, b = n;
  while (a < b && (unsigned char)input[a] <= 0x20) a++;
  while (b > a && (unsigned char)input[b - 1] <= 0x20) b--;
  Str in = {0};
  for (size_t i = a; i < b; i++)
    if (input[i] != '\t' && input[i] != '\n' && input[i] != '\r') s_chr(&in, input[i]);
  char *s = in.p ? in.p : xstrdup("");
  size_t len = in.n;
  /* scheme */
  size_t i = 0;
  if (len == 0 || !isalpha((unsigned char)s[0])) {
    free(s);
    return -1;
  }
  while (i < len && (isalnum((unsigned char)s[i]) || s[i] == '+' || s[i] == '-' || s[i] == '.')) i++;
  if (i >= len || s[i] != ':') {
    free(s);
    return -1;
  }
  u->scheme = xstrndup(s, i);
  for (char *q = u->scheme; *q; q++) *q = (char)tolower((unsigned char)*q);
  u->special = is_special(u->scheme);
  u->port = -1;
  const char *r = s + i + 1;
  const char *end = s + len;
  if (!u->special) {
    /* an opaque path (data:, about:, blob:, mailto:, ...) */
    const char *h = memchr(r, '#', (size_t)(end - r));
    const char *pe = h ? h : end;
    const char *q = memchr(r, '?', (size_t)(pe - r));
    Str p = {0}, qs = {0}, f = {0};
    enc_put(&p, r, (size_t)((q ? q : pe) - r), 1);
    if (q) {
      s_chr(&qs, '?');
      enc_put(&qs, q + 1, (size_t)(pe - q - 1), 3);
    }
    if (h) {
      s_chr(&f, '#');
      enc_put(&f, h + 1, (size_t)(end - h - 1), 2);
    }
    u->path = s_take(&p);
    u->query = s_take(&qs);
    u->frag = s_take(&f);
    free(s);
    return 0;
  }
  if (!strcmp(u->scheme, "file")) {
    /* fetch answers file: before it looks further */
    u->host = xstrdup("");
    u->path = xstrndup(r, (size_t)(end - r));
    u->query = xstrdup("");
    u->frag = xstrdup("");
    free(s);
    return 0;
  }
  while (r < end && (*r == '/' || *r == '\\')) r++;
  const char *ae = r;
  while (ae < end && *ae != '/' && *ae != '\\' && *ae != '?' && *ae != '#') ae++;
  /* userinfo: up to the last '@' */
  const char *at = NULL;
  for (const char *q = r; q < ae; q++)
    if (*q == '@') at = q;
  const char *hs = r;
  if (at) {
    const char *colon = memchr(r, ':', (size_t)(at - r));
    Str us = {0}, ps = {0};
    enc_put(&us, r, (size_t)((colon ? colon : at) - r), 6);
    if (colon) enc_put(&ps, colon + 1, (size_t)(at - colon - 1), 6);
    u->user = s_take(&us);
    u->pass = s_take(&ps);
    hs = at + 1;
  } else {
    u->user = xstrdup("");
    u->pass = xstrdup("");
  }
  /* host and port */
  const char *pc = NULL;
  int inb = 0;
  for (const char *q = hs; q < ae; q++) {
    if (*q == '[') inb = 1;
    else if (*q == ']') inb = 0;
    else if (*q == ':' && !inb) {
      pc = q;
      break;
    }
  }
  if (parse_host(hs, (size_t)((pc ? pc : ae) - hs), &u->host) != 0) {
    url_free(u);
    free(s);
    return -1;
  }
  if (pc) {
    long port = 0;
    size_t digits = 0;
    for (const char *q = pc + 1; q < ae; q++) {
      if (!isdigit((unsigned char)*q)) {
        url_free(u);
        free(s);
        return -1;
      }
      port = port * 10 + (*q - '0');
      if (port > 65535) {
        url_free(u);
        free(s);
        return -1;
      }
      digits++;
    }
    if (digits > 0 && port != default_port(u->scheme)) u->port = (int)port;
  }
  /* path, query, fragment */
  const char *h = memchr(ae, '#', (size_t)(end - ae));
  const char *pe = h ? h : end;
  const char *q = memchr(ae, '?', (size_t)(pe - ae));
  u->path = norm_path(ae, (size_t)((q ? q : pe) - ae));
  Str qs = {0}, f = {0};
  if (q) {
    s_chr(&qs, '?');
    enc_put(&qs, q + 1, (size_t)(pe - q - 1), 4);
  }
  if (h) {
    s_chr(&f, '#');
    enc_put(&f, h + 1, (size_t)(end - h - 1), 2);
  }
  u->query = s_take(&qs);
  u->frag = s_take(&f);
  free(s);
  return 0;
}

static char *url_ser(const Url *u, int with_frag) {
  Str s = {0};
  s_cat(&s, u->scheme);
  s_chr(&s, ':');
  if (u->host) {
    s_cat(&s, "//");
    if ((u->user && *u->user) || (u->pass && *u->pass)) {
      s_cat(&s, u->user);
      if (*u->pass) {
        s_chr(&s, ':');
        s_cat(&s, u->pass);
      }
      s_chr(&s, '@');
    }
    s_cat(&s, u->host);
    if (u->port >= 0) {
      char b[16];
      snprintf(b, sizeof b, ":%d", u->port);
      s_cat(&s, b);
    }
  }
  s_cat(&s, u->path);
  s_cat(&s, u->query);
  if (with_frag) s_cat(&s, u->frag);
  return s_take(&s);
}

/* a Location against the URL it came from: an absolute string */
static char *url_resolve(const Url *base, const char *ref) {
  size_t i = 0;
  while ((unsigned char)ref[i] <= 0x20 && ref[i]) i++;
  const char *r = ref + i;
  /* a scheme of its own */
  size_t k = 0;
  if (isalpha((unsigned char)r[0])) {
    while (isalnum((unsigned char)r[k]) || r[k] == '+' || r[k] == '-' || r[k] == '.') k++;
    if (r[k] == ':') {
      char *sch = xstrndup(r, k);
      for (char *q = sch; *q; q++) *q = (char)tolower((unsigned char)*q);
      int same = !strcmp(sch, base->scheme) && base->special;
      free(sch);
      /* "http:foo" against an http base is relative (the special rule) */
      if (!same || r[k + 1] == '/' || r[k + 1] == '\\') return xstrdup(r);
      r += k + 1;
    }
  }
  Str s = {0};
  s_cat(&s, base->scheme);
  s_chr(&s, ':');
  if ((r[0] == '/' || r[0] == '\\') && (r[1] == '/' || r[1] == '\\')) {
    s_cat(&s, r);
    return s_take(&s);
  }
  s_cat(&s, "//");
  if (base->user && *base->user) {
    s_cat(&s, base->user);
    if (*base->pass) {
      s_chr(&s, ':');
      s_cat(&s, base->pass);
    }
    s_chr(&s, '@');
  }
  s_cat(&s, base->host);
  if (base->port >= 0) {
    char b[16];
    snprintf(b, sizeof b, ":%d", base->port);
    s_cat(&s, b);
  }
  if (r[0] == '/' || r[0] == '\\') s_cat(&s, r);
  else if (r[0] == '?') {
    s_cat(&s, base->path);
    s_cat(&s, r);
  } else if (r[0] == '#') {
    s_cat(&s, base->path);
    s_cat(&s, base->query);
    s_cat(&s, r);
  } else if (r[0] == 0) {
    s_cat(&s, base->path);
    s_cat(&s, base->query);
  } else {
    const char *slash = strrchr(base->path, '/');
    s_put(&s, base->path, slash ? (size_t)(slash - base->path) + 1 : 0);
    s_cat(&s, r);
  }
  return s_take(&s);
}

/* the fetch spec's bad ports */
static int bad_port(int port) {
  static const int bad[] = {1,    7,    9,    11,   13,   15,   17,   19,   20,   21,   22,   23,   25,   37,   42,   43,   53,   69,   77,
                            79,   87,   95,   101,  102,  103,  104,  109,  110,  111,  113,  115,  117,  119,  123,  135,  137,  139,  143,
                            161,  179,  389,  427,  465,  512,  513,  514,  515,  526,  530,  531,  532,  540,  548,  554,  556,  563,  587,
                            601,  636,  989,  990,  993,  995,  1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666,
                            6667, 6668, 6669, 6679, 6697, 10080};
  for (size_t i = 0; i < sizeof bad / sizeof bad[0]; i++)
    if (bad[i] == port) return 1;
  return 0;
}

/* ── the request ──────────────────────────────────────────────────────── */
typedef struct {
  char *name, *value;
} Hdr;
typedef struct {
  Hdr *v;
  size_t n, cap;
} Hdrs;
static void h_add(Hdrs *h, const char *name, const char *value) {
  if (h->n == h->cap) {
    h->cap = h->cap ? h->cap * 2 : 16;
    h->v = realloc(h->v, sizeof *h->v * h->cap);
    if (!h->v) abort();
  }
  h->v[h->n].name = xstrdup(name);
  h->v[h->n].value = xstrdup(value);
  h->n++;
}
static Hdr *h_find(Hdrs *h, const char *name) {
  for (size_t i = 0; i < h->n; i++)
    if (!strcasecmp(h->v[i].name, name)) return &h->v[i];
  return NULL;
}
static void h_del(Hdrs *h, const char *name) {
  size_t k = 0;
  for (size_t i = 0; i < h->n; i++) {
    if (!strcasecmp(h->v[i].name, name)) {
      free(h->v[i].name);
      free(h->v[i].value);
    } else
      h->v[k++] = h->v[i];
  }
  h->n = k;
}
static void h_free(Hdrs *h) {
  for (size_t i = 0; i < h->n; i++) {
    free(h->v[i].name);
    free(h->v[i].value);
  }
  free(h->v);
  memset(h, 0, sizeof *h);
}

enum { ST_RESOLVE = 1, ST_CONNECT, ST_PROXY, ST_TLS, ST_SEND, ST_HEAD, ST_BODY, ST_DONE };

typedef struct {
  uint8_t *p;
  size_t n;
} Bytes;

typedef struct Req {
  uint32_t handle;
  unsigned hop_gen; /* counts hops: a loop that ran a parser callback stops when it moved */
  int dead;
  char *method;
  Url url;
  Hdrs hdrs;
  uint8_t *body;
  size_t blen;
  int has_body, body_is_text;
  int redirect; /* 0 follow, 1 error, 2 manual */
  int hops, redirected;
  /* ── the hop: everything from hop_first_ to hop_last_ is per connection
   * and is zeroed WHOLE at every hop (req_free_hop) — a redirect starts
   * with no verification verdict, no parse state, nothing of the hop
   * before it */
  int hop_first_;
  int state;
  int https, via_proxy, tunnel;
  char *dial_host;
  int dial_port;
  struct addrinfo *ai, *ai_cur;
  int lookups; /* a lookup in flight (its thread holds this request) */
  int conn_errs, first_err;
  char *first_err_addr;
  int fd;
  WnIo io;
  WnBuf out;
  size_t out_off;
  WnBuf tunnel_in; /* the bytes behind the proxy's CONNECT answer */
  size_t tunnel_off;
  SSL *ssl;        /* the connection (its two memory BIOs: rbio, wbio) */
  BIO *rbio, *wbio;
  int tls_on;
  /* the response, as fetch holds it */
  int status;
  char *resp_text; /* its status text (UTF-8 bytes, as undici took them) */
  size_t resp_text_n;
  Hdrs rh;
  int head_sent, no_body;
  WnBuf body_raw;
  /* undici's Parser (client-h1.js) over undici's llhttp */
  int32_t llp;           /* the parser (in the parser module's memory); 0 none */
  int u_connect;         /* reading the proxy's answer to a CONNECT */
  int u_status;          /* statusCode */
  int u_keepalive;       /* shouldKeepAlive */
  int u_upgrade;         /* upgrade */
  Str status_text;       /* statusText */
  Bytes *raw;            /* headers: name, value, name, value, ... */
  size_t raw_n, raw_cap;
  size_t headers_size;   /* headersSize */
  Str keep_alive, connection, cl_str;
  unsigned long long bytes_read;
  int completed;         /* request.onComplete ran */
  int destroyed;         /* util.destroy(socket, err) ran: its error */
  int tls_err;           /* a TLS error after the handshake was emitted on
                          * the socket (kError: d_*), which stays open */
  char *d_name, *d_msg, *d_code;
  unsigned long long rx; /* bytes read on this hop */
  int hop_last_;
} Req;

static Req **reqs;
static uint32_t n_reqs;

static void req_free_hop(Req *r) {
  if (r->fd >= 0) wn_io_close(&r->io);
  r->fd = -1;
  if (r->tls_on) {
    SSL_free(r->ssl);
    r->tls_on = 0;
  }
  if (r->ai) freeaddrinfo(r->ai);
  r->ai = r->ai_cur = NULL;
  free(r->dial_host);
  r->dial_host = NULL;
  free(r->first_err_addr);
  r->first_err_addr = NULL;
  r->conn_errs = r->first_err = 0;
  wn_buf_free(&r->out);
  r->out_off = 0;
  wn_buf_free(&r->tunnel_in);
  free(r->resp_text);
  h_free(&r->rh);
  wn_buf_free(&r->body_raw);
  if (r->llp) wn_llw_llhttp_free(r->llp);
  free(r->status_text.p);
  for (size_t i = 0; i < r->raw_n; i++) free(r->raw[i].p);
  free(r->raw);
  free(r->keep_alive.p);
  free(r->connection.p);
  free(r->cl_str.p);
  free(r->d_name);
  free(r->d_msg);
  free(r->d_code);
  /* everything per hop, zeroed whole (the verification verdict included) */
  memset(&r->hop_first_, 0, offsetof(Req, hop_last_) - offsetof(Req, hop_first_));
  r->fd = -1;
  r->hop_gen++;
}

static void req_finish(Req *r) {
  if (r->dead) return;
  r->dead = 1;
  req_free_hop(r);
  free(r->method);
  r->method = NULL;
  url_free(&r->url);
  h_free(&r->hdrs);
  free(r->body);
  r->body = NULL;
  wn_ev_hold(-1);
}

/* an ERROR RECORD (abi.ts fetch): name, message, hasCause, then the
 * cause's name, message and code (empty = none) */
static void err_record(WnBuf *b, const char *name, const char *msg, const char *cname, const char *cmsg, size_t cmsg_len, const char *ccode) {
  wn_buf_run8(b, name, strlen(name));
  wn_buf_run8(b, msg, strlen(msg));
  wn_buf_u32(b, cname != NULL);
  if (cname) {
    wn_buf_run8(b, cname, strlen(cname));
    wn_buf_run8(b, cmsg, cmsg_len);
    wn_buf_run8(b, ccode ? ccode : "", ccode ? strlen(ccode) : 0);
  }
}
/* the request failed: before its head, fetch() rejects with "fetch
 * failed"; after it, the body readers with "terminated" */
static void req_fail_len(Req *r, const char *cname, const char *cmsg, size_t cmsg_len, const char *ccode) {
  if (r->dead) return;
  if (r->head_sent && r->no_body) {
    /* the response's body is null (a null-body status, or HEAD): what
     * fails behind its head is nothing the program can read (Node's
     * stream errors where no reader is) */
    wn_ev_push(wn_ev_new(WN_SRC_FETCH, r->handle, EV_BODY, 0, 0, NULL, 0));
    req_finish(r);
    return;
  }
  WnBuf b = {0};
  err_record(&b, "TypeError", r->head_sent ? "terminated" : "fetch failed", cname, cmsg, cmsg_len, ccode);
  wn_ev_push(wn_ev_new(WN_SRC_FETCH, r->handle, EV_FAIL, 0, 0, b.p, (uint32_t)b.n));
  wn_buf_free(&b);
  req_finish(r);
}
static const char *errno_code(int e) {
  const char *code = NULL;
  static char codebuf[32];
  switch (e) {
    case ECONNREFUSED: code = "ECONNREFUSED"; break;
    case ECONNRESET: code = "ECONNRESET"; break;
    case ETIMEDOUT: code = "ETIMEDOUT"; break;
    case EHOSTUNREACH: code = "EHOSTUNREACH"; break;
    case ENETUNREACH: code = "ENETUNREACH"; break;
    case EADDRNOTAVAIL: code = "EADDRNOTAVAIL"; break;
    case EPIPE: code = "EPIPE"; break;
    case EACCES: code = "EACCES"; break;
    case EPERM: code = "EPERM"; break;
    default:
      snprintf(codebuf, sizeof codebuf, "E%d", e);
      code = codebuf;
  }
  return code;
}
static void req_fail(Req *r, const char *cname, const char *cmsg, const char *ccode) { req_fail_len(r, cname, cmsg, cmsg ? strlen(cmsg) : 0, ccode); }
static void req_fail_errno(Req *r, const char *syscall, int e, const char *where) {
  char msg[300];
  const char *code = errno_code(e);
  if (where) snprintf(msg, sizeof msg, "%s %s %s", syscall, code, where);
  else snprintf(msg, sizeof msg, "%s %s", syscall, code);
  req_fail(r, "Error", msg, code);
}

/* ── the hop: resolve, connect, (proxy), (TLS), send, read ────────────── */
static void hop_start(Req *r);
static void fx_ready(WnIo *io, uint32_t evs);

/* the socket's bytes into the engine's input (TLSWrap::OnStreamRead): the
 * tunnel's first bytes, then one read; 1 bytes went in, 0 none now, -1
 * the end of file, -2 a read error (*e) */
static int flush_out(Req *r);
static int tls_fill(Req *r, int *e) {
  if (r->tunnel_off < r->tunnel_in.n) {
    size_t k = r->tunnel_in.n - r->tunnel_off;
    if (BIO_write(r->rbio, r->tunnel_in.p + r->tunnel_off, (int)k) != (int)k) abort();
    r->tunnel_off = r->tunnel_in.n;
    return 1;
  }
  static uint8_t buf[65536];
  ssize_t n;
  do n = recv(r->fd, buf, sizeof buf, 0);
  while (n < 0 && errno == EINTR);
  if (n > 0) {
    if (BIO_write(r->rbio, buf, (int)n) != (int)n) abort();
    return 1;
  }
  if (n == 0) return -1;
  if (errno == EAGAIN || errno == EWOULDBLOCK) return 0;
  *e = errno;
  return -2;
}
/* EncOut: the engine's records, behind what waits for the socket */
static void tls_flush(Req *r) {
  char b[16384];
  int n;
  while ((n = BIO_read(r->wbio, b, sizeof b)) > 0) wn_buf_put(&r->out, b, (size_t)n);
}
static int32_t ll_new(void);
/* a verdict as Node's TLS error: OpenSSL's text (with Node's hint where it
 * gives one) and Node's code */
static void tls_verdict_fail(Req *r, long code) {
  char *msg = wn_x509_err_reason(code);
  req_fail(r, "Error", msg, wn_x509_err_name(code));
  free(msg);
}

/* crypto_tls.cc VerifyCallback: verification continues whatever it meets */
static int fetch_verify_continue(int preverify_ok, X509_STORE_CTX *ctx) {
  (void)preverify_ok, (void)ctx;
  return 1;
}
/* undici's connections: tls.connect with a default secure context (its
 * store the root store: addRootCerts) */
static SSL_CTX *fetch_ctx(WnCtxError *err) {
  static SSL_CTX *sc;
  if (!sc) {
    sc = wn_ossl_ctx_new_checked(err);
    if (sc) wn_ossl_ctx_roots(sc);
  }
  return sc;
}
/* TLSWrap::ClearOut's error: the message is GetBIOError's, the code
 * "ERR_SSL_" + the first error's reason, upper-cased (NULL: a reason Node
 * cannot name — Node emits nothing); a TLS alert waiting in the output goes
 * out first */
static char *tls_ssl_error(Req *r, char *code, size_t cap) {
  unsigned long first = ERR_peek_error();
  const char *rs = first ? ERR_reason_error_string(first) : NULL;
  char *msg = wn_ossl_bio_error();
  tls_flush(r);
  flush_out(r);
  if (!rs) {
    free(msg);
    return NULL;
  }
  size_t k = (size_t)snprintf(code, cap, "ERR_SSL_");
  for (size_t i = 0; rs[i] && k + 1 < cap; i++) code[k++] = rs[i] == ' ' ? '_' : (rs[i] >= 'a' && rs[i] <= 'z' ? (char)(rs[i] - 32) : rs[i]);
  code[k] = 0;
  return msg;
}
/* before the handshake finished: the TLSSocket is destroyed with it */
static void tls_ssl_fail(Req *r) {
  char code[160] = "";
  char *msg = tls_ssl_error(r, code, sizeof code);
  req_fail(r, "Error", msg ? msg : "", code);
  free(msg);
}

/* SSL_write of every byte, in pieces an int can count (a memory BIO takes
 * everything; only a failed engine refuses — what it refused never reaches
 * the peer, and the read side reports the failure): 1, or 0 */
static int tls_write_all(Req *r, const uint8_t *p, size_t n) {
  while (n > 0) {
    int part = n > (1u << 30) ? 1 << 30 : (int)n;
    int w = SSL_write(r->ssl, p, part);
    if (w <= 0) return 0;
    tls_flush(r);
    p += w;
    n -= (size_t)w;
  }
  return 1;
}

/* the request head, as undici writes it */
static void write_head(Req *r) {
  if (!r->llp) r->llp = ll_new();
  Str h = {0};
  s_cat(&h, r->method);
  s_chr(&h, ' ');
  if (r->via_proxy && !r->tunnel) {
    char *abs = url_ser(&r->url, 0);
    s_cat(&h, abs);
    free(abs);
  } else {
    s_cat(&h, r->url.path);
    s_cat(&h, r->url.query);
  }
  s_cat(&h, " HTTP/1.1\r\nhost: ");
  s_cat(&h, r->url.host);
  if (r->url.port >= 0) {
    char b[16];
    snprintf(b, sizeof b, ":%d", r->url.port);
    s_cat(&h, b);
  }
  s_cat(&h, "\r\n");
  Hdr *conn = h_find(&r->hdrs, "connection");
  s_cat(&h, conn && !strcasecmp(conn->value, "close") ? "connection: close\r\n" : "connection: keep-alive\r\n");
  for (size_t i = 0; i < r->hdrs.n; i++) {
    const char *nm = r->hdrs.v[i].name;
    if (!strcasecmp(nm, "host") || !strcasecmp(nm, "connection") || !strcasecmp(nm, "content-length")) continue;
    s_cat(&h, nm);
    s_cat(&h, ": ");
    s_cat(&h, r->hdrs.v[i].value);
    s_cat(&h, "\r\n");
  }
  static const char *const defs[][2] = {{"accept", "*/*"}, {"accept-language", "*"}, {"sec-fetch-mode", "cors"}, {"user-agent", "node"}, {"accept-encoding", "gzip, deflate"}};
  for (size_t i = 0; i < 5; i++)
    if (!h_find(&r->hdrs, defs[i][0])) {
      s_cat(&h, defs[i][0]);
      s_cat(&h, ": ");
      s_cat(&h, defs[i][1]);
      s_cat(&h, "\r\n");
    }
  int expects = !strcmp(r->method, "POST") || !strcmp(r->method, "PUT") || !strcmp(r->method, "PATCH") || !strcmp(r->method, "QUERY");
  if (r->has_body || expects) {
    char b[48];
    snprintf(b, sizeof b, "content-length: %zu\r\n", r->has_body ? r->blen : (size_t)0);
    s_cat(&h, b);
  }
  s_cat(&h, "\r\n");
  WnBuf *dst = &r->out;
  if (r->tls_on) {
    /* undici writes the head, then the body: each SSL_write a whole
     * record run into the output BIO */
    ERR_set_mark();
    int ok = tls_write_all(r, (const uint8_t *)h.p, h.n);
    if (ok && r->has_body) ok = tls_write_all(r, r->body, r->blen);
    ERR_pop_to_mark();
    tls_flush(r);
  } else {
    wn_buf_put(dst, h.p, h.n);
    if (r->has_body) wn_buf_put(dst, r->body, r->blen);
  }
  free(h.p);
}

static int flush_out(Req *r) {
  while (r->out_off < r->out.n) {
    ssize_t w = send(r->fd, r->out.p + r->out_off, r->out.n - r->out_off, MSG_NOSIGNAL);
    if (w < 0) {
      if (errno == EINTR) continue;
      if (errno == EAGAIN || errno == EWOULDBLOCK) return 1;
      return -errno;
    }
    r->out_off += (size_t)w;
  }
  r->out.n = r->out_off = 0;
  return 0;
}

static void want(Req *r) {
  if (r->fd < 0 || r->dead) return;
  uint32_t ev = EPOLLIN;
  if (r->state == ST_CONNECT || r->out.n > r->out_off) ev |= EPOLLOUT;
  wn_io_want(&r->io, ev);
}

/* the next address, or the connect failure */
static void try_connect(Req *r) {
  while (r->ai_cur) {
    struct addrinfo *a = r->ai_cur;
    r->ai_cur = a->ai_next;
    int fd = socket(a->ai_family, SOCK_STREAM | SOCK_NONBLOCK | SOCK_CLOEXEC, 0);
    if (fd < 0) continue;
    int rc;
    do rc = connect(fd, a->ai_addr, a->ai_addrlen);
    while (rc < 0 && errno == EINTR);
    if (rc < 0 && errno != EINPROGRESS) {
      int e = errno;
      close(fd);
      char ip[INET6_ADDRSTRLEN] = "";
      int port = 0;
      if (a->ai_family == AF_INET6) {
        inet_ntop(AF_INET6, &((struct sockaddr_in6 *)(void *)a->ai_addr)->sin6_addr, ip, sizeof ip);
        port = ntohs(((struct sockaddr_in6 *)(void *)a->ai_addr)->sin6_port);
      } else {
        inet_ntop(AF_INET, &((struct sockaddr_in *)(void *)a->ai_addr)->sin_addr, ip, sizeof ip);
        port = ntohs(((struct sockaddr_in *)(void *)a->ai_addr)->sin_port);
      }
      if (r->conn_errs++ == 0) {
        r->first_err = e;
        char w[80];
        snprintf(w, sizeof w, "%s:%d", ip, port);
        r->first_err_addr = xstrdup(w);
      }
      continue;
    }
    r->fd = fd;
    wn_io_init(&r->io, fd, fx_ready, r);
    r->state = ST_CONNECT;
    want(r);
    return;
  }
  /* every address refused */
  if (r->conn_errs > 1) {
    static const char *names[] = {"ECONNREFUSED", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH"};
    const char *code = r->first_err == ECONNREFUSED ? names[0] : r->first_err == ETIMEDOUT ? names[1] : r->first_err == EHOSTUNREACH ? names[2] : names[3];
    req_fail(r, "AggregateError", "", code);
    return;
  }
  req_fail_errno(r, "connect", r->first_err ? r->first_err : ECONNREFUSED, r->first_err_addr);
}

static void connected(Req *r);

typedef struct {
  Req *r;
  uint32_t handle;
  char *host;
  int port;
  int rc, err;
  struct addrinfo *res;
} Lookup;
static Req *req_of(uint32_t h) { return h >= 1 && h <= n_reqs ? reqs[h - 1] : NULL; }
static void lookup_done(void *ctx) {
  Lookup *l = ctx;
  wn_ev_hold(-1);
  Req *r = req_of(l->handle);
  if (!r || r->dead) {
    if (l->res) freeaddrinfo(l->res);
  } else if (l->rc != 0) {
    const char *code = l->rc == EAI_AGAIN ? "EAI_AGAIN" : l->rc == EAI_FAIL ? "EAI_FAIL" : "ENOTFOUND";
    char msg[400];
    snprintf(msg, sizeof msg, "getaddrinfo %s %s", code, l->host);
    req_fail(r, "Error", msg, code);
  } else {
    r->ai = r->ai_cur = l->res;
    try_connect(r);
  }
  free(l->host);
  free(l);
}
static void *lookup_thread(void *ctx) {
  Lookup *l = ctx;
  struct addrinfo hints;
  memset(&hints, 0, sizeof hints);
  hints.ai_family = AF_UNSPEC;
  hints.ai_socktype = SOCK_STREAM;
  hints.ai_flags = AI_ADDRCONFIG;
  char port[16];
  snprintf(port, sizeof port, "%d", l->port);
  l->rc = getaddrinfo(l->host, port, &hints, &l->res);
  l->err = errno;
  wn_ev_post(lookup_done, l);
  return NULL;
}

/* no_proxy: a host (or a domain suffix, ".x" or "x"), "*" for all */
static int no_proxy_for(const char *host) {
  const char *np = getenv("no_proxy");
  if (!np || !*np) np = getenv("NO_PROXY");
  if (!np || !*np) return 0;
  char *list = xstrdup(np);
  int hit = 0;
  for (char *t = strtok(list, ", "); t && !hit; t = strtok(NULL, ", ")) {
    if (!strcmp(t, "*")) hit = 1;
    else {
      char *colon = strrchr(t, ':');
      if (colon && !strchr(t, ']')) *colon = 0;
      const char *d = t[0] == '.' ? t + 1 : t;
      size_t hl = strlen(host), dl = strlen(d);
      if (!strcasecmp(host, d)) hit = 1;
      else if (hl > dl && !strcasecmp(host + hl - dl, d) && host[hl - dl - 1] == '.') hit = 1;
    }
  }
  free(list);
  return hit;
}

static void hop_start(Req *r) {
  r->https = !strcmp(r->url.scheme, "https");
  const char *host = r->url.host;
  int port = r->url.port >= 0 ? r->url.port : default_port(r->url.scheme);
  r->via_proxy = 0;
  r->tunnel = 0;
  const char *nv = getenv("NODE_USE_ENV_PROXY");
  if (nv && (!strcmp(nv, "1") || !strcmp(nv, "true"))) {
    const char *px = r->https ? (getenv("https_proxy") ? getenv("https_proxy") : getenv("HTTPS_PROXY")) : (getenv("http_proxy") ? getenv("http_proxy") : getenv("HTTP_PROXY"));
    if (px && *px && !no_proxy_for(host)) {
      Url pu;
      if (url_parse(px, &pu) == 0 && pu.host) {
        r->via_proxy = 1;
        r->tunnel = r->https;
        free(r->dial_host);
        r->dial_host = xstrdup(pu.host);
        r->dial_port = pu.port >= 0 ? pu.port : default_port(pu.scheme);
        url_free(&pu);
      } else if (pu.scheme)
        url_free(&pu);
    }
  }
  if (!r->via_proxy) {
    free(r->dial_host);
    r->dial_host = xstrdup(host);
    r->dial_port = port;
  } else if (h_find(&r->hdrs, "proxy-authorization")) {
    /* undici's ProxyAgent refuses the program's own (throwIfProxyAuthIsSent) */
    req_fail(r, "InvalidArgumentError", "Proxy-Authorization should be sent in ProxyAgent constructor", "UND_ERR_INVALID_ARG");
    return;
  }
  /* strip IPv6 brackets for the lookup */
  char *bare = xstrdup(r->dial_host);
  if (bare[0] == '[') {
    memmove(bare, bare + 1, strlen(bare));
    bare[strlen(bare) - 1] = 0;
  }
  r->state = ST_RESOLVE;
  struct addrinfo hints;
  memset(&hints, 0, sizeof hints);
  hints.ai_socktype = SOCK_STREAM;
  hints.ai_flags = AI_NUMERICHOST;
  char portstr[16];
  snprintf(portstr, sizeof portstr, "%d", r->dial_port);
  struct addrinfo *res = NULL;
  if (getaddrinfo(bare, portstr, &hints, &res) == 0) {
    free(bare);
    r->ai = r->ai_cur = res;
    try_connect(r);
    return;
  }
  Lookup *l = calloc(1, sizeof *l);
  if (!l) abort();
  l->handle = r->handle;
  l->host = bare;
  l->port = r->dial_port;
  wn_ev_hold(1);
  pthread_t th;
  pthread_attr_t at;
  pthread_attr_init(&at);
  pthread_attr_setdetachstate(&at, PTHREAD_CREATE_DETACHED);
  if (pthread_create(&th, &at, lookup_thread, l) != 0) wn_host_fail("fetch: cannot start a lookup thread");
  pthread_attr_destroy(&at);
}

static void tls_begin(Req *r) {
  /* tls.connect's createSecureContext: what it throws fails the request */
  WnCtxError ce;
  SSL_CTX *sc = fetch_ctx(&ce);
  if (!sc) {
    req_fail(r, ce.type_error ? "TypeError" : "Error", ce.message, ce.code);
    return;
  }
  /* TLSWrap::InitSSL on undici's tls.connect */
  r->ssl = SSL_new(sc);
  if (!r->ssl) wn_host_fail("fetch: SSL_new failed");
  r->rbio = BIO_new(BIO_s_mem());
  r->wbio = BIO_new(BIO_s_mem());
  if (!r->rbio || !r->wbio) abort();
  BIO_set_mem_eof_return(r->rbio, -1);
  BIO_set_mem_eof_return(r->wbio, -1);
  SSL_set_bio(r->ssl, r->rbio, r->wbio);
  r->tls_on = 1;
  /* the verdict is recorded and judged after the handshake (Node's
   * VerifyCallback accepts) */
  SSL_set_verify(r->ssl, SSL_VERIFY_NONE, fetch_verify_continue);
  SSL_set_mode(r->ssl, SSL_MODE_RELEASE_BUFFERS);
  SSL_set_mode(r->ssl, SSL_MODE_AUTO_RETRY);
  /* undici: ALPNProtocols ["http/1.1"] */
  static const unsigned char alpn[] = "\x08http/1.1";
  if (SSL_set_alpn_protos(r->ssl, alpn, sizeof alpn - 1) != 0) wn_host_fail("fetch: ALPN was refused");
  /* SNI for a DNS name (an IP literal gets none); the name itself is
   * checked by check_identity, as Node checks it, never by the engine */
  struct in6_addr a6;
  struct in_addr a4;
  if (!(r->url.host[0] == '[' || inet_pton(AF_INET, r->url.host, &a4) == 1 || inet_pton(AF_INET6, r->url.host, &a6) == 1))
  {
    /* TLSWrap::SetServername ignores a refusal (a name past 255 bytes
     * goes without SNI) */
    ERR_set_mark();
    SSL_set_tlsext_host_name(r->ssl, r->url.host);
    ERR_pop_to_mark();
  }
  wn_ossl_socket_init(r->ssl);
  SSL_set_connect_state(r->ssl);
  r->state = ST_TLS;
}

static void connected(Req *r) {
  if (r->tunnel) {
    /* the tunnel, as undici's proxy agent asks for it (any host length) */
    Str h = {0};
    char port[16];
    snprintf(port, sizeof port, ":%d", r->url.port >= 0 ? r->url.port : 443);
    s_cat(&h, "CONNECT ");
    s_cat(&h, r->url.host);
    s_cat(&h, port);
    s_cat(&h, " HTTP/1.1\r\nhost: ");
    s_cat(&h, r->url.host);
    s_cat(&h, port);
    s_cat(&h, "\r\nconnection: close\r\nproxy-connection: keep-alive\r\n\r\n");
    wn_buf_put(&r->out, h.p, h.n);
    free(h.p);
    r->llp = ll_new();
    r->u_connect = 1;
    r->state = ST_PROXY;
    return;
  }
  if (r->https) {
    tls_begin(r);
    return;
  }
  write_head(r);
  r->state = ST_HEAD;
}

/* ── the response ─────────────────────────────────────────────────────── */
static int hdr_cmp(const void *a, const void *b) { return strcmp(((const Hdr *)a)->name, ((const Hdr *)b)->name); }

/* a byte string (undici reads the status text and the headers as latin1) */
static void run_latin1(WnBuf *b, const char *s) {
  size_t n = strlen(s);
  uint16_t *u = malloc(n * 2 + 2);
  if (!u) abort();
  for (size_t i = 0; i < n; i++) u[i] = (unsigned char)s[i];
  wn_buf_run16(b, u, n);
  free(u);
}

/* the HEAD event: status text, url, type, then the header list as
 * undici's Headers iterates it — lowercase names, sorted, duplicates
 * combined with ", ", each set-cookie its own entry */
static void send_head(Req *r) {
  Hdrs l = {0};
  for (size_t i = 0; i < r->rh.n; i++) {
    char *nm = xstrdup(r->rh.v[i].name);
    for (char *q = nm; *q; q++) *q = (char)tolower((unsigned char)*q);
    Hdr *e = strcmp(nm, "set-cookie") ? h_find(&l, nm) : NULL;
    if (e) {
      size_t a = strlen(e->value), b = strlen(r->rh.v[i].value);
      e->value = realloc(e->value, a + b + 3);
      memcpy(e->value + a, ", ", 2);
      memcpy(e->value + a + 2, r->rh.v[i].value, b + 1);
    } else
      h_add(&l, nm, r->rh.v[i].value);
    free(nm);
  }
  /* a stable sort keeps set-cookie entries in arrival order */
  for (size_t i = 1; i < l.n; i++)
    for (size_t j = i; j > 0 && hdr_cmp(&l.v[j - 1], &l.v[j]) > 0; j--) {
      Hdr t = l.v[j];
      l.v[j] = l.v[j - 1];
      l.v[j - 1] = t;
    }
  WnBuf b = {0};
  {
    /* statusText = buf.toString(): UTF-8 */
    size_t m = wn_utf8_to_16((const uint8_t *)r->resp_text, r->resp_text_n, NULL);
    uint16_t *u = malloc(m * 2 + 2);
    if (!u) abort();
    wn_utf8_to_16((const uint8_t *)r->resp_text, r->resp_text_n, u);
    wn_buf_run16(&b, u, m);
    free(u);
  }
  char *u = url_ser(&r->url, 0);
  wn_buf_run8(&b, u, strlen(u));
  free(u);
  wn_buf_run8(&b, "basic", 5);
  wn_buf_u32(&b, (uint32_t)l.n);
  for (size_t i = 0; i < l.n; i++) {
    run_latin1(&b, l.v[i].name);
    run_latin1(&b, l.v[i].value);
  }
  h_free(&l);
  int null_body = r->no_body;
  wn_ev_push(wn_ev_new(WN_SRC_FETCH, r->handle, EV_HEAD, r->status, (r->redirected ? 1 : 0) | (null_body ? 2 : 0), b.p, (uint32_t)b.n));
  wn_buf_free(&b);
  r->head_sent = 1;
}

/* content-encoding, as undici decodes: the codings in reverse, gzip /
 * x-gzip and deflate (zlib-wrapped or raw); any other coding leaves the
 * body as it came. 0, or -1 with *zerr set (a corrupt stream). */
static int decode_body(Req *r, WnBuf *out, const char **zmsg, const char **zcode) {
  Hdr *ce = NULL;
  for (size_t i = 0; i < r->rh.n; i++)
    if (!strcasecmp(r->rh.v[i].name, "content-encoding")) ce = &r->rh.v[i];
  wn_buf_put(out, r->body_raw.p, r->body_raw.n);
  if (!ce || !strcmp(r->method, "HEAD")) return 0;
  char *list = xstrdup(ce->value);
  char *codings[16];
  int nc = 0;
  for (char *t = strtok(list, ","); t && nc < 16; t = strtok(NULL, ",")) {
    while (*t == ' ' || *t == '\t') t++;
    char *e = t + strlen(t);
    while (e > t && (e[-1] == ' ' || e[-1] == '\t')) *--e = 0;
    for (char *q = t; *q; q++) *q = (char)tolower((unsigned char)*q);
    codings[nc++] = t;
  }
  for (int i = nc - 1; i >= 0; i--)
    if (strcmp(codings[i], "gzip") && strcmp(codings[i], "x-gzip") && strcmp(codings[i], "deflate")) {
      free(list);
      return 0; /* an unknown coding: no decoding at all */
    }
  for (int i = nc - 1; i >= 0; i--) {
    int gz = strcmp(codings[i], "deflate") != 0;
    WnBuf dst = {0};
    z_stream z;
    memset(&z, 0, sizeof z);
    int raw = 0;
    if (!gz && out->n > 0 && (out->p[0] & 0x0f) != 8) raw = 1; /* not a zlib header: raw deflate */
    inflateInit2(&z, gz ? 16 + MAX_WBITS : raw ? -MAX_WBITS : MAX_WBITS);
    z.next_in = out->p;
    z.avail_in = (uInt)out->n;
    int rc = Z_OK;
    uint8_t chunk[65536];
    while (z.avail_in > 0 || rc == Z_OK) {
      z.next_out = chunk;
      z.avail_out = sizeof chunk;
      rc = inflate(&z, Z_SYNC_FLUSH);
      wn_buf_put(&dst, chunk, sizeof chunk - z.avail_out);
      if (rc == Z_STREAM_END) {
        if (gz && z.avail_in > 0) {
          /* another gzip member */
          inflateReset(&z);
          rc = Z_OK;
          continue;
        }
        break;
      }
      if (rc == Z_BUF_ERROR && z.avail_in == 0) break;
      if (rc != Z_OK) {
        *zmsg = z.msg ? z.msg : "invalid data";
        *zcode = "Z_DATA_ERROR";
        inflateEnd(&z);
        wn_buf_free(&dst);
        free(list);
        return -1;
      }
    }
    inflateEnd(&z);
    wn_buf_free(out);
    *out = dst;
  }
  free(list);
  return 0;
}

static void finish_body(Req *r) {
  WnBuf out = {0};
  const char *zm = NULL, *zc = NULL;
  if (decode_body(r, &out, &zm, &zc) != 0) {
    wn_buf_free(&out);
    char msg[200];
    snprintf(msg, sizeof msg, "%s", zm);
    req_fail(r, "Error", msg, zc);
    return;
  }
  wn_ev_push(wn_ev_new(WN_SRC_FETCH, r->handle, EV_BODY, 0, 0, out.p, (uint32_t)out.n));
  wn_buf_free(&out);
  req_finish(r);
}

/* a redirect hop per the fetch spec; 1 when a new hop started */
static int follow(Req *r) {
  Hdr *loc = h_find(&r->rh, "location");
  if (!loc || r->redirect == 2) return 0;
  if (r->redirect == 1) {
    req_fail(r, "Error", "unexpected redirect", NULL);
    return 1;
  }
  char *abs = url_resolve(&r->url, loc->value);
  Url next;
  int bad = url_parse(abs, &next);
  free(abs);
  if (bad) {
    req_fail(r, "TypeError", "Invalid URL", "ERR_INVALID_URL");
    return 1;
  }
  if (strcmp(next.scheme, "http") && strcmp(next.scheme, "https")) {
    url_free(&next);
    req_fail(r, "Error", "URL scheme must be a HTTP(S) scheme", NULL);
    return 1;
  }
  if (r->hops >= 20) {
    url_free(&next);
    req_fail(r, "Error", "redirect count exceeded", NULL);
    return 1;
  }
  r->hops++;
  /* a location with credentials: request mode "cors" refuses it (the
   * request's origin is never the location's under Node — measured) */
  if ((next.user && *next.user) || (next.pass && *next.pass)) {
    url_free(&next);
    req_fail(r, "Error", "cross origin not allowed for request mode \"cors\"", NULL);
    return 1;
  }
  int status = r->status;
  if ((status == 303 && strcmp(r->method, "GET") && strcmp(r->method, "HEAD")) || ((status == 301 || status == 302) && !strcmp(r->method, "POST"))) {
    free(r->method);
    r->method = xstrdup("GET");
    free(r->body);
    r->body = NULL;
    r->blen = 0;
    r->has_body = 0;
    static const char *const drop[] = {"content-encoding", "content-language", "content-location", "content-type", "content-length"};
    for (size_t i = 0; i < 5; i++) h_del(&r->hdrs, drop[i]);
  }
  int same = !strcmp(next.scheme, r->url.scheme) && !strcmp(next.host, r->url.host) && next.port == r->url.port;
  if (!same) {
    h_del(&r->hdrs, "authorization");
    h_del(&r->hdrs, "proxy-authorization");
    h_del(&r->hdrs, "cookie");
  }
  url_free(&r->url);
  r->url = next;
  r->redirected = 1;
  req_free_hop(r);
  if (bad_port(r->url.port >= 0 ? r->url.port : default_port(r->url.scheme))) {
    req_fail(r, "Error", "bad port", NULL);
    return 1;
  }
  hop_start(r);
  return 1;
}

/* ── the response: undici's Parser over undici's own llhttp ─────────────
 * Node's fetch reads a response with undici's client-h1 Parser driving
 * the llhttp wasm module undici ships; this host links that very module
 * (translated: wn_llw.h) and transcribes the Parser's callbacks below, so
 * a response is accepted, or refused with its reason, exactly as Node's
 * fetch accepts or refuses it. The Parser's state lives in the request's
 * hop (u_*). util.destroy(socket, err) is u_destroy: the first error
 * wins, and the socket counts as destroyed from then on (the callbacks
 * that check `socket.destroyed` answer -1). The proxy's answer to a
 * CONNECT is read by the same parser (undici's connect() goes through
 * it): u_connect. */
#define MAX_HEADERS_SIZE 16384 /* http.maxHeaderSize, undici's default */
enum { LL_TYPE_RESPONSE = 2, LL_OK = 0, LL_PAUSED = 21, LL_PAUSED_UPGRADE = 22 };

static uint8_t *llmem;           /* the parser module's memory */
static Req *ll_cur;              /* undici's currentParser */
static int32_t ll_buf, ll_bufsz; /* currentBufferPtr / currentBufferSize */

static int32_t ll_new(void) {
  static int ready;
  if (!ready) {
    wn_llw_init();
    wn_llw_initialize();
    llmem = wn_llw_export_memory();
    ready = 1;
  }
  return wn_llw_llhttp_alloc(LL_TYPE_RESPONSE);
}

static void u_destroy(Req *r, const char *name, const char *msg, const char *code) {
  if (r->destroyed) return;
  r->destroyed = 1;
  /* the 'error' it emits replaces any earlier one as kError */
  free(r->d_name);
  free(r->d_msg);
  free(r->d_code);
  r->d_name = xstrdup(name);
  r->d_msg = xstrdup(msg);
  r->d_code = code ? xstrdup(code) : NULL;
}

static void bytes_add(Bytes *b, const uint8_t *p, size_t n) {
  b->p = realloc(b->p, b->n + n + 1);
  if (!b->p) abort();
  memcpy(b->p + b->n, p, n);
  b->n += n;
  b->p[b->n] = 0;
}
static void raw_free(Req *r) {
  for (size_t i = 0; i < r->raw_n; i++) free(r->raw[i].p);
  free(r->raw);
  r->raw = NULL;
  r->raw_n = r->raw_cap = 0;
}
static Bytes *raw_push(Req *r) {
  if (r->raw_n == r->raw_cap) {
    r->raw_cap = r->raw_cap ? r->raw_cap * 2 : 16;
    r->raw = realloc(r->raw, r->raw_cap * sizeof *r->raw);
    if (!r->raw) abort();
  }
  Bytes *b = &r->raw[r->raw_n++];
  b->p = NULL;
  b->n = 0;
  return b;
}

/* JavaScript's parseInt(s, 10) of a UTF-8 string, as a double (NaN when no
 * digit): StrWhiteSpaceChar skipped, a sign, the longest digit run
 * (correctly rounded) */
static double js_parse_int10(const uint8_t *s, size_t n) {
  size_t m = wn_utf8_to_16(s, n, NULL);
  uint16_t *u = malloc((m + 1) * 2);
  if (!u) abort();
  wn_utf8_to_16(s, n, u);
  size_t i = 0;
  for (; i < m; i++) {
    uint16_t c = u[i];
    int ws = c == 9 || c == 10 || c == 11 || c == 12 || c == 13 || c == 32 || c == 0xa0 || c == 0x1680 || (c >= 0x2000 && c <= 0x200a) ||
             c == 0x2028 || c == 0x2029 || c == 0x202f || c == 0x205f || c == 0x3000 || c == 0xfeff;
    if (!ws) break;
  }
  int neg = 0;
  if (i < m && (u[i] == '+' || u[i] == '-')) neg = u[i++] == '-';
  Str d = {0};
  while (i < m && u[i] >= '0' && u[i] <= '9') s_chr(&d, (char)u[i++]);
  free(u);
  if (d.n == 0) {
    free(d.p);
    return __builtin_nan("");
  }
  double v = strtod(d.p, NULL);
  free(d.p);
  return neg ? -v : v;
}
/* contentLength && bytesRead !== parseInt(contentLength, 10) */
static int cl_mismatch(Req *r) {
  if (r->cl_str.n == 0) return 0;
  return (double)r->bytes_read != js_parse_int10((const uint8_t *)r->cl_str.p, r->cl_str.n);
}
static const char *const MISMATCH[3] = {"ResponseContentLengthMismatchError", "Response body length does not match content-length header",
                                        "UND_ERR_RES_CONTENT_LENGTH_MISMATCH"};

/* Parser.createError */
static void u_create_error(Req *r, int32_t ret) {
  (void)ret;
  if (cl_mismatch(r)) {
    u_destroy(r, MISMATCH[0], MISMATCH[1], MISMATCH[2]);
    return;
  }
  int32_t rp = wn_llw_llhttp_get_error_reason(r->llp);
  Str m = {0};
  if (rp) {
    s_cat(&m, "Response does not match the HTTP/1.1 protocol (");
    s_cat(&m, (const char *)llmem + rp);
    s_chr(&m, ')');
  }
  /* undici's code is `HPE_${constants.ERROR[ret]}` — constants.ERROR maps
   * names to numbers, so it is undefined */
  u_destroy(r, "HTTPParserError", m.p ? m.p : "", NULL);
  free(m.p);
}

/* the response head as fetch keeps it (request.onHeaders): the raw list */
static void keep_head(Req *r) {
  h_free(&r->rh);
  for (size_t i = 0; i + 1 < r->raw_n; i += 2) h_add(&r->rh, (const char *)r->raw[i].p, (const char *)r->raw[i + 1].p);
  free(r->resp_text);
  r->resp_text = malloc(r->status_text.n + 1);
  if (!r->resp_text) abort();
  memcpy(r->resp_text, r->status_text.p ? r->status_text.p : "", r->status_text.n);
  r->resp_text_n = r->status_text.n;
}

int32_t wn_llw_on_message_begin(int32_t p) {
  Req *r = ll_cur;
  (void)p;
  if (r->destroyed) return -1;
  if (r->completed) {
    /* client[kRunning] === 0 */
    u_destroy(r, "SocketError", "bad response", "UND_ERR_SOCKET");
    return -1;
  }
  return 0;
}
int32_t wn_llw_on_url(int32_t p, int32_t at, int32_t len) {
  (void)p, (void)at, (void)len;
  return 0;
}
int32_t wn_llw_on_status(int32_t p, int32_t at, int32_t len) {
  Req *r = ll_cur;
  (void)p;
  /* this.statusText = buf.toString(): each piece replaces the last */
  r->status_text.n = 0;
  s_put(&r->status_text, (const char *)llmem + at, (size_t)len);
  return 0;
}
static void track_header(Req *r, size_t n) {
  r->headers_size += n;
  if (r->headers_size >= MAX_HEADERS_SIZE) u_destroy(r, "HeadersOverflowError", "Headers Overflow Error", "UND_ERR_HEADERS_OVERFLOW");
}
int32_t wn_llw_on_header_field(int32_t p, int32_t at, int32_t len) {
  Req *r = ll_cur;
  (void)p;
  Bytes *b = (r->raw_n & 1) == 0 ? raw_push(r) : &r->raw[r->raw_n - 1];
  bytes_add(b, llmem + at, (size_t)len);
  track_header(r, (size_t)len);
  return 0;
}
int32_t wn_llw_on_header_value(int32_t p, int32_t at, int32_t len) {
  Req *r = ll_cur;
  (void)p;
  Bytes *b = (r->raw_n & 1) == 1 ? raw_push(r) : &r->raw[r->raw_n - 1];
  bytes_add(b, llmem + at, (size_t)len);
  const Bytes *key = &r->raw[r->raw_n - 2];
  const char *v = (const char *)llmem + at;
  if (key->n == 10 && !strncasecmp((const char *)key->p, "keep-alive", 10)) s_put(&r->keep_alive, v, (size_t)len);
  else if (key->n == 10 && !strncasecmp((const char *)key->p, "connection", 10)) s_put(&r->connection, v, (size_t)len);
  else if (key->n == 14 && !strncasecmp((const char *)key->p, "content-length", 14)) s_put(&r->cl_str, v, (size_t)len);
  track_header(r, (size_t)len);
  return 0;
}

static int is_redirect(int s) { return s == 301 || s == 302 || s == 303 || s == 307 || s == 308; }
static void send_head(Req *r);

int32_t wn_llw_on_headers_complete(int32_t p, int32_t status, int32_t upgrade, int32_t keep_alive) {
  Req *r = ll_cur;
  (void)p;
  if (r->destroyed) return -1;
  if (r->completed) {
    u_destroy(r, "SocketError", "bad response", "UND_ERR_SOCKET");
    return -1;
  }
  if (status == 100) {
    u_destroy(r, "SocketError", "bad response", "UND_ERR_SOCKET");
    return -1;
  }
  /* neither fetch nor connect() asks for an upgrade */
  if (upgrade) {
    u_destroy(r, "SocketError", "bad upgrade", "UND_ERR_SOCKET");
    return -1;
  }
  r->u_status = status;
  /* keep-alive as llhttp says (undici's HEAD override needs a socket that
   * is not reset, and a HEAD request resets it) */
  r->u_keepalive = keep_alive;
  if (r->u_connect) {
    r->u_upgrade = 1;
    return 2;
  }
  /* request.onHeaders(statusCode, headers, resume, statusText): fetch
   * ignores an informational response */
  if (status >= 200) {
    keep_head(r);
    r->status = status;
    r->no_body = !strcmp(r->method, "HEAD") || status == 204 || status == 205 || status == 304 || status == 101 || status == 103;
    int redirect_hop = is_redirect(status) && h_find(&r->rh, "location") && r->redirect != 2;
    if (!redirect_hop) send_head(r);
  }
  raw_free(r);
  r->headers_size = 0;
  if (!strcmp(r->method, "HEAD")) return 1;
  if (status < 200) return 1;
  return 0;
}

int32_t wn_llw_on_body(int32_t p, int32_t at, int32_t len) {
  Req *r = ll_cur;
  (void)p;
  if (r->destroyed) return -1;
  r->bytes_read += (unsigned long long)len;
  wn_buf_put(&r->body_raw, llmem + at, (size_t)len);
  return 0;
}

int32_t wn_llw_on_message_complete(int32_t p) {
  Req *r = ll_cur;
  (void)p;
  int status = r->u_status;
  if (r->destroyed && (!status || r->u_keepalive)) return -1;
  if (r->u_upgrade) return 0;
  if (status < 100) {
    /* assert(statusCode >= 100) throws out of the parser */
    u_destroy(r, "AssertionError", "The expression evaluated to a falsy value:\n\n  assert(statusCode >= 100)\n", "ERR_ASSERTION");
    return -1;
  }
  int mismatch = strcmp(r->method, "HEAD") && cl_mismatch(r);
  r->u_status = 0;
  r->status_text.n = 0;
  r->bytes_read = 0;
  r->cl_str.n = 0;
  r->keep_alive.n = 0;
  r->connection.n = 0;
  raw_free(r);
  r->headers_size = 0;
  if (status < 200) return 0;
  if (mismatch) {
    u_destroy(r, MISMATCH[0], MISMATCH[1], MISMATCH[2]);
    return -1;
  }
  r->completed = 1; /* request.onComplete */
  if (!r->u_keepalive) {
    u_destroy(r, "InformationalError", "reset", "UND_ERR_INFO");
    return LL_PAUSED;
  }
  return 0;
}

static void tls_begin(Req *r);
static int follow(Req *r);
static void finish_body(Req *r);

/* the parser's verdict, once a read (or the end) is through it */
static void settle(Req *r) {
  if (r->dead) return;
  if (r->completed) {
    if (is_redirect(r->status) && !r->head_sent) {
      if (follow(r)) return;
      send_head(r);
    }
    finish_body(r);
    return;
  }
  if (r->destroyed) req_fail(r, r->d_name, r->d_msg, r->d_code);
}

/* the proxy's answer to the CONNECT (undici's connect handler, then the
 * proxy agent: anything but 200 aborts the tunnel); what follows the
 * answer's head is the tunnel's first bytes */
static void tunnel_open(Req *r, const uint8_t *rest, size_t n) {
  int status = r->u_status;
  r->u_status = 0;
  r->u_upgrade = 0;
  r->u_connect = 0;
  raw_free(r);
  r->headers_size = 0;
  wn_llw_llhttp_free(r->llp);
  r->llp = 0;
  if (status != 200) {
    char m[96];
    snprintf(m, sizeof m, "Proxy response (%d) !== 200 when HTTP Tunneling", status);
    req_fail(r, "AbortError", m, "UND_ERR_ABORTED");
    return;
  }
  wn_buf_put(&r->tunnel_in, rest, n);
  tls_begin(r);
}

/* Parser.execute(chunk) */
static void feed(Req *r, const uint8_t *data, size_t n) {
  if (r->dead) return;
  r->rx += n;
  if (r->completed || r->destroyed || r->llp == 0) return;
  if ((int64_t)n > ll_bufsz) {
    if (ll_buf) wn_llw_free(ll_buf);
    ll_bufsz = (int32_t)((n + 4095) / 4096 * 4096);
    ll_buf = wn_llw_malloc(ll_bufsz);
    if (ll_buf == 0) wn_host_fail("fetch: the HTTP parser is out of memory");
  }
  memcpy(llmem + ll_buf, data, n);
  ll_cur = r;
  int32_t ret = wn_llw_llhttp_execute(r->llp, ll_buf, (int32_t)n);
  ll_cur = NULL;
  if (ret != LL_OK) {
    size_t off = (size_t)(wn_llw_llhttp_get_error_pos(r->llp) - ll_buf);
    if (off > n) off = n;
    if (ret == LL_PAUSED_UPGRADE) {
      if (r->u_upgrade && !r->destroyed) {
        tunnel_open(r, data + off, n - off);
        return;
      }
      u_destroy(r, "AssertionError", "The expression evaluated to a falsy value:\n\n  assert(upgrade)\n", "ERR_ASSERTION");
    } else if (ret != LL_PAUSED)
      u_create_error(r, ret);
  }
  settle(r);
}

/* Parser.finish(): 1 when it produced an error (destroyed with it) */
static void u_finish(Req *r) {
  if (r->llp == 0) return;
  ll_cur = r;
  int32_t ret = wn_llw_llhttp_finish(r->llp);
  ll_cur = NULL;
  if (ret == LL_OK || ret == LL_PAUSED || ret == LL_PAUSED_UPGRADE) return;
  u_create_error(r, ret);
}

/* the socket closed (onHttpSocketClose): the request still running fails
 * with the error the socket was destroyed with, or "closed" */
static void on_close(Req *r) {
  if (r->dead) return;
  if (!r->destroyed && !r->tls_err && r->u_status && !r->u_keepalive) u_finish(r);
  settle(r);
  if (!r->dead && r->tls_err) req_fail(r, r->d_name, r->d_msg, r->d_code);
  if (!r->dead) req_fail(r, "SocketError", "closed", "UND_ERR_SOCKET");
}
/* the end of the stream (onHttpSocketEnd) */
static void on_eof(Req *r) {
  if (r->dead) return;
  if (r->u_status && !r->u_keepalive) u_finish(r);
  else u_destroy(r, "SocketError", "other side closed", "UND_ERR_SOCKET");
  on_close(r);
}
/* a read error (onHttpSocketError): a reset after a head that asked for
 * the connection's end finishes the parser instead */
static void on_read_error(Req *r, int e) {
  if (r->dead) return;
  if (e == ECONNRESET && r->u_status && !r->u_keepalive) {
    u_finish(r);
  } else if (e == ECONNRESET && r->rx == 0 && !r->tls_err) {
    /* measured: a peer that resets before it answers reads as an end */
    u_destroy(r, "SocketError", "other side closed", "UND_ERR_SOCKET");
  } else {
    char msg[64];
    snprintf(msg, sizeof msg, "read %s", e == ECONNRESET ? "ECONNRESET" : "EIO");
    u_destroy(r, "Error", msg, e == ECONNRESET ? "ECONNRESET" : "EIO");
  }
  on_close(r);
}

/* Node's tls.checkServerIdentity, which undici's connections run, over
 * the URL's host name (an IPv6 address without its brackets) as Node
 * hands it over: 1 when it matches; otherwise the request fails with
 * ERR_TLS_CERT_ALTNAME_INVALID and Node's reason (wn_x509.c). No
 * certificate at all fails too. */
static int check_identity(Req *r, X509 *peer) {
  const char *h = r->url.host;
  size_t hl = strlen(h);
  if (hl >= 2 && h[0] == '[') h++, hl -= 2;
  size_t n = 0;
  char *why = wn_x509_check_identity(peer, h, hl, &n);
  if (!why) return 1;
  static const char pre[] = "Hostname/IP does not match certificate's altnames: ";
  char *m = malloc(sizeof pre + n);
  if (!m) abort();
  memcpy(m, pre, sizeof pre - 1);
  memcpy(m + sizeof pre - 1, why, n);
  req_fail_len(r, "Error", m, sizeof pre - 1 + n, "ERR_TLS_CERT_ALTNAME_INVALID");
  free(m);
  free(why);
  return 0;
}

/* TLSWrap's cycle for the request: the handshake, the verdict and the
 * name, then the response's records into undici's parser */
static void tls_pump(Req *r) {
  unsigned gen = r->hop_gen;
  for (;;) {
    int k, e, rerr = 0, f;
    ERR_clear_error();
    if (r->state == ST_TLS) {
      k = SSL_do_handshake(r->ssl);
      tls_flush(r);
      if (k == 1) {
        /* the chain first, then the name (Node's onConnectSecure) */
        long code = SSL_get_verify_result(r->ssl);
        if (code != X509_V_OK) {
          flush_out(r);
          tls_verdict_fail(r, code);
          return;
        }
        if (!check_identity(r, SSL_get0_peer_certificate(r->ssl))) return;
        write_head(r);
        r->state = ST_HEAD;
        continue;
      }
      e = SSL_get_error(r->ssl, k);
      if (e != SSL_ERROR_WANT_READ && e != SSL_ERROR_WANT_WRITE) {
        tls_ssl_fail(r);
        return;
      }
      f = tls_fill(r, &rerr);
      if (f > 0) continue;
      if (f == 0) return;
      /* the peer went away before the handshake finished */
      if (f == -1) req_fail(r, "Error", "Client network socket disconnected before secure TLS connection was established", "ECONNRESET");
      else req_fail_errno(r, "read", rerr, NULL);
      return;
    }
    uint8_t buf[16384];
    k = SSL_read(r->ssl, buf, sizeof buf);
    if (k > 0) {
      feed(r, buf, (size_t)k);
      if (r->dead || r->hop_gen != gen) return;
      continue;
    }
    e = SSL_get_error(r->ssl, k);
    tls_flush(r);
    if (e == SSL_ERROR_ZERO_RETURN) {
      on_eof(r);
      return;
    }
    if (e != SSL_ERROR_WANT_READ && e != SSL_ERROR_WANT_WRITE) {
      /* after the handshake a TLS error is EMITTED on the socket, not a
       * destroy (_tls_wrap.js onerror -> _emitTLSError; only the first:
       * _hadError): undici keeps it as kError and the request fails when
       * the socket closes — unless the peer's end or reset comes first
       * and replaces it (onHttpSocketEnd / onHttpSocketError). The socket
       * keeps being read, its records into the failed engine. */
      char code[160];
      char *msg = tls_ssl_error(r, code, sizeof code);
      if (msg && !r->tls_err && !r->destroyed) {
        r->tls_err = 1;
        free(r->d_name);
        free(r->d_msg);
        free(r->d_code);
        r->d_name = xstrdup("Error");
        r->d_msg = msg;
        r->d_code = xstrdup(code);
      } else
        free(msg);
      ERR_clear_error();
      if (r->dead) return;
    }
    f = tls_fill(r, &rerr);
    if (f > 0) continue;
    if (f == 0) return;
    if (f == -1) on_eof(r);
    else on_read_error(r, rerr);
    return;
  }
}

static void fx_ready(WnIo *io, uint32_t evs) {
  Req *r = io->ctx;
  if (r->dead) return;
  if (r->state == ST_CONNECT) {
    int err = 0;
    socklen_t el = sizeof err;
    getsockopt(r->fd, SOL_SOCKET, SO_ERROR, &err, &el);
    if (err == 0 && !(evs & (EPOLLOUT | EPOLLERR | EPOLLHUP))) return;
    if (err != 0) {
      /* this address failed: the next one, if any */
      wn_io_close(&r->io);
      r->fd = -1;
      struct sockaddr_storage ss;
      (void)ss;
      if (r->conn_errs++ == 0) {
        r->first_err = err;
        char ip[INET6_ADDRSTRLEN] = "";
        int port = r->dial_port;
        char bare[INET6_ADDRSTRLEN + 2];
        snprintf(bare, sizeof bare, "%s", r->dial_host);
        if (bare[0] == '[') {
          memmove(bare, bare + 1, strlen(bare));
          bare[strlen(bare) - 1] = 0;
        }
        snprintf(ip, sizeof ip, "%s", bare);
        /* the address that refused, as Node names it */
        char w[80];
        snprintf(w, sizeof w, "%s:%d", ip, port);
        r->first_err_addr = xstrdup(w);
      }
      try_connect(r);
      return;
    }
    connected(r);
  }
  if (r->dead) return;
  if (r->out.n > r->out_off) {
    int k = flush_out(r);
    if (k < 0) {
      req_fail_errno(r, "write", -k, NULL);
      return;
    }
  }
  if (evs & (EPOLLIN | EPOLLHUP | EPOLLERR)) {
    if (r->tls_on && r->state != ST_PROXY) tls_pump(r);
    else {
      uint8_t buf[65536];
      unsigned gen = r->hop_gen;
      for (;;) {
        ssize_t n = recv(r->fd, buf, sizeof buf, 0);
        if (n < 0) {
          if (errno == EINTR) continue;
          if (errno == EAGAIN || errno == EWOULDBLOCK) break;
          on_read_error(r, errno);
          return;
        }
        if (n == 0) {
          on_eof(r);
          return;
        }
        int proxy = r->state == ST_PROXY;
        feed(r, buf, (size_t)n);
        if (r->dead || r->hop_gen != gen) return;
        if (proxy && r->state == ST_TLS) {
          /* the tunnel is open: TLS reads the socket from here on */
          tls_pump(r);
          break;
        }
      }
    }
  } else if (r->tls_on && r->state == ST_TLS)
    tls_pump(r);
  if (r->dead || r->fd < 0) return;
  if (r->out.n > r->out_off) {
    int k = flush_out(r);
    if (k < 0) {
      req_fail_errno(r, "write", -k, NULL);
      return;
    }
  }
  want(r);
}

/* ── START: undici's Request constructor, then the fetch ──────────────── */
static int is_tchar(unsigned char c) { return c > 0x20 && c < 0x7f && !strchr("\"(),/:;<=>?@[\\]{}", c); }
static int valid_token(const char *s) {
  if (!*s) return 0;
  for (; *s; s++)
    if (!is_tchar((unsigned char)*s)) return 0;
  return 1;
}

/* the reply when the Request constructor throws: -1 and the record */
static int32_t refuse(uint32_t ptr, uint32_t room, const char *name, const char *msg, const char *cname, const char *cmsg, const char *ccode) {
  WnBuf b = {0};
  err_record(&b, name, msg, cname, cmsg, cmsg ? strlen(cmsg) : 0, ccode);
  if (b.n > room) wn_host_fail("fetch: an error record larger than the room the module left");
  memcpy(w_hostmem + ptr, b.p, b.n);
  wn_buf_free(&b);
  return -1;
}

static void fetch_delivered(const WnEv *e) { (void)e; }

/* a data: URL's body and type (the fetch spec's data: URL processor) */
static int data_url(Req *r, const char *href) {
  const char *s = href + 5;
  const char *comma = strchr(s, ',');
  if (!comma) return -1;
  char *mt = xstrndup(s, (size_t)(comma - s));
  int b64 = 0;
  size_t ml = strlen(mt);
  /* ";base64" at the end, ASCII case-insensitive, spaces before allowed */
  while (ml && mt[ml - 1] == ' ') mt[--ml] = 0;
  if (ml >= 7 && !strcasecmp(mt + ml - 7, ";base64")) {
    b64 = 1;
    mt[ml - 7] = 0;
    ml -= 7;
    while (ml && mt[ml - 1] == ' ') mt[--ml] = 0;
  }
  const char *frag = strchr(comma + 1, '#');
  size_t dn;
  char *data = pct_decode(comma + 1, frag ? (size_t)(frag - comma - 1) : strlen(comma + 1), &dn);
  WnBuf body = {0};
  if (b64) {
    static const char *alpha = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    unsigned v = 0;
    int bits = 0;
    size_t count = 0;
    for (size_t i = 0; i < dn; i++)
      if (!strchr(" \t\n\f\r", data[i])) count++;
    for (size_t i = 0; i < dn; i++) {
      char c = data[i];
      if (strchr(" \t\n\f\r", c) || c == '=') continue;
      const char *q = strchr(alpha, c);
      if (!q || !c) {
        free(data);
        free(mt);
        return -1;
      }
      v = (v << 6) | (unsigned)(q - alpha);
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        uint8_t byte = (uint8_t)(v >> bits);
        wn_buf_put(&body, &byte, 1);
      }
    }
    (void)count;
  } else
    wn_buf_put(&body, data, dn);
  free(data);
  /* the MIME type: text/plain;charset=US-ASCII when none is given */
  char *type;
  const char *t = mt;
  while (*t == ' ') t++;
  if (*t == 0 || *t == ';') type = xstrdup("text/plain;charset=US-ASCII");
  else {
    type = xstrdup(t);
    for (char *q = type; *q && *q != ';'; q++) *q = (char)tolower((unsigned char)*q);
  }
  free(mt);
  WnBuf b = {0};
  wn_buf_run8(&b, "OK", 2);
  char *u = url_ser(&r->url, 0);
  wn_buf_run8(&b, u, strlen(u));
  free(u);
  wn_buf_run8(&b, "basic", 5);
  wn_buf_u32(&b, 1);
  wn_buf_run8(&b, "content-type", 12);
  wn_buf_run8(&b, type, strlen(type));
  free(type);
  wn_ev_push(wn_ev_new(WN_SRC_FETCH, r->handle, EV_HEAD, 200, 0, b.p, (uint32_t)b.n));
  wn_buf_free(&b);
  r->head_sent = 1;
  wn_ev_push(wn_ev_new(WN_SRC_FETCH, r->handle, EV_BODY, 0, 0, body.p, (uint32_t)body.n));
  wn_buf_free(&body);
  req_finish(r);
  return 0;
}

static int32_t start(uint32_t ptr, uint32_t len, uint32_t room) {
  uint32_t off = ptr;
  uint32_t bodyKind = wn_rd32(off), count = wn_rd32(off + 4), given = wn_rd32(off + 8);
  off += 12;
  size_t ml, rl;
  char *method = wn_read_run(&off, &ml);
  char *url = wn_read_run(&off, NULL);
  char *redirect = wn_read_run(&off, &rl);
  char **hn = calloc(count + 1, sizeof *hn), **hv = calloc(count + 1, sizeof *hv);
  if (!hn || !hv) abort();
  for (uint32_t i = 0; i < count; i++) {
    hn[i] = wn_read_run(&off, NULL);
    hv[i] = wn_read_run(&off, NULL);
  }
  uint8_t *body = NULL;
  size_t blen = 0;
  if (bodyKind != 0) {
    blen = wn_rd32(off);
    body = malloc(blen ? blen : 1);
    if (!body) abort();
    memcpy(body, w_hostmem + off + 4, blen);
    off += 4 + (uint32_t)((blen + 3) & ~(size_t)3);
  }
  if (off != ptr + len) wn_host_fail("fetch: a START record whose parts do not add up to its length");
  int32_t ans = 0;
  Req *r = NULL;
  Url u;
  memset(&u, 0, sizeof u);
  /* RequestInit's dictionary conversion: redirect's enum first */
  int redir = 0;
  if (given & 2) {
    if (!strcmp(redirect, "follow")) redir = 0;
    else if (!strcmp(redirect, "error")) redir = 1;
    else if (!strcmp(redirect, "manual")) redir = 2;
    else {
      Str m = {0};
      s_cat(&m, "undefined: ");
      s_cat(&m, redirect);
      s_cat(&m, " is not an accepted type. Expected one of follow, manual, error.");
      ans = refuse(ptr, room, "TypeError", m.p, NULL, NULL, NULL);
      free(m.p);
      goto out;
    }
  }
  if (url_parse(url, &u) != 0) {
    Str m = {0};
    s_cat(&m, "Failed to parse URL from ");
    s_cat(&m, url);
    ans = refuse(ptr, room, "TypeError", m.p, "TypeError", "Invalid URL", "ERR_INVALID_URL");
    free(m.p);
    goto out;
  }
  if ((u.user && *u.user) || (u.pass && *u.pass)) {
    Str m = {0};
    s_cat(&m, "Request cannot be constructed from a URL that includes credentials: ");
    s_cat(&m, url);
    ans = refuse(ptr, room, "TypeError", m.p, NULL, NULL, NULL);
    free(m.p);
    goto out;
  }
  char *meth = xstrdup((given & 1) ? method : "GET");
  if (given & 1) {
    static const char *const norm[] = {"DELETE", "GET", "HEAD", "OPTIONS", "POST", "PUT"};
    int done = 0;
    for (size_t i = 0; i < 6; i++)
      if (!strcasecmp(meth, norm[i])) {
        free(meth);
        meth = xstrdup(norm[i]);
        done = 1;
      }
    if (!done) {
      if (!valid_token(meth)) {
        Str m = {0};
        s_cat(&m, "'");
        s_cat(&m, meth);
        s_cat(&m, "' is not a valid HTTP method.");
        ans = refuse(ptr, room, "TypeError", m.p, NULL, NULL, NULL);
        free(m.p);
        free(meth);
        goto out;
      }
      if (!strcasecmp(meth, "CONNECT") || !strcasecmp(meth, "TRACE") || !strcasecmp(meth, "TRACK")) {
        Str m = {0};
        s_cat(&m, "'");
        s_cat(&m, meth);
        s_cat(&m, "' HTTP method is unsupported.");
        ans = refuse(ptr, room, "TypeError", m.p, NULL, NULL, NULL);
        free(m.p);
        free(meth);
        goto out;
      }
    }
  }
  /* the headers: names checked, values normalized then checked, same
   * names combined (the first spelling kept) */
  Hdrs hs = {0};
  for (uint32_t i = 0; i < count; i++) {
    const char *bad = NULL;
    if (!valid_token(hn[i])) bad = "name";
    char *v = hv[i];
    while (*v == ' ' || *v == '\t' || *v == '\n' || *v == '\r') v++;
    size_t vl = strlen(v);
    while (vl && (v[vl - 1] == ' ' || v[vl - 1] == '\t' || v[vl - 1] == '\n' || v[vl - 1] == '\r')) v[--vl] = 0;
    if (!bad)
      for (size_t k = 0; k < vl; k++)
        if (v[k] == 0 || v[k] == '\n' || v[k] == '\r') bad = "value";
    if (bad) {
      Str m = {0};
      s_cat(&m, "Headers.append: \"");
      s_cat(&m, !strcmp(bad, "name") ? hn[i] : hv[i]);
      s_cat(&m, "\" is an invalid header ");
      s_cat(&m, bad);
      s_cat(&m, ".");
      ans = refuse(ptr, room, "TypeError", m.p, NULL, NULL, NULL);
      free(m.p);
      free(meth);
      h_free(&hs);
      goto out;
    }
    Hdr *e = h_find(&hs, hn[i]);
    if (e) {
      size_t a = strlen(e->value);
      e->value = realloc(e->value, a + vl + 3);
      memcpy(e->value + a, ", ", 2);
      memcpy(e->value + a + 2, v, vl + 1);
    } else
      h_add(&hs, hn[i], v);
  }
  if (bodyKind != 0 && (!strcmp(meth, "GET") || !strcmp(meth, "HEAD"))) {
    ans = refuse(ptr, room, "TypeError", "Request with GET/HEAD method cannot have body.", NULL, NULL, NULL);
    free(meth);
    h_free(&hs);
    goto out;
  }
  if (bodyKind == 1 && !h_find(&hs, "content-type")) h_add(&hs, "content-type", "text/plain;charset=UTF-8");
  /* the request exists */
  r = calloc(1, sizeof *r);
  if (!r) abort();
  reqs = realloc(reqs, sizeof *reqs * (n_reqs + 1));
  if (!reqs) abort();
  reqs[n_reqs++] = r;
  r->handle = n_reqs;
  r->method = meth;
  r->url = u;
  memset(&u, 0, sizeof u);
  r->hdrs = hs;
  r->body = body;
  body = NULL;
  r->blen = blen;
  r->has_body = bodyKind != 0;
  r->redirect = redir;
  r->fd = -1;
  wn_ev_hold(1);
  wn_fetch_delivered = fetch_delivered;
  ans = (int32_t)r->handle;
  /* scheme fetch */
  const char *sc = r->url.scheme;
  if (!strcmp(sc, "http") || !strcmp(sc, "https")) {
    /* undici's dispatcher refuses some headers (a failed fetch) */
    for (size_t i = 0; i < r->hdrs.n; i++) {
      const char *nm = r->hdrs.v[i].name, *val = r->hdrs.v[i].value;
      const char *why = NULL, *cname = "InvalidArgumentError", *code = "UND_ERR_INVALID_ARG";
      if (!strcasecmp(nm, "connection") && strcasecmp(val, "close") && strcasecmp(val, "keep-alive")) why = "invalid connection header";
      else if (!strcasecmp(nm, "keep-alive")) why = "invalid keep-alive header";
      else if (!strcasecmp(nm, "transfer-encoding")) why = "invalid transfer-encoding header";
      else if (!strcasecmp(nm, "upgrade")) why = "invalid upgrade header";
      else if (!strcasecmp(nm, "expect")) why = "expect header not supported", cname = "NotSupportedError", code = "UND_ERR_NOT_SUPPORTED";
      if (why) {
        req_fail(r, cname, why, code);
        goto out;
      }
    }
    if (bad_port(r->url.port >= 0 ? r->url.port : default_port(sc))) {
      req_fail(r, "Error", "bad port", NULL);
      goto out;
    }
    hop_start(r);
  } else if (!strcmp(sc, "data")) {
    char *href = url_ser(&r->url, 0);
    if (data_url(r, href) != 0) req_fail(r, "Error", "failed to fetch the data URL", NULL);
    free(href);
  } else if (!strcmp(sc, "about")) {
    req_fail(r, "Error", "about scheme is not supported", NULL);
  } else if (!strcmp(sc, "blob")) {
    req_fail(r, "Error", "invalid method", NULL);
  } else if (!strcmp(sc, "file")) {
    req_fail(r, "Error", "not implemented... yet...", NULL);
  } else {
    req_fail(r, "Error", "unknown scheme", NULL);
  }
out:
  url_free(&u);
  free(body);
  free(method);
  free(url);
  free(redirect);
  for (uint32_t i = 0; i < count; i++) {
    free(hn[i]);
    free(hv[i]);
  }
  free(hn);
  free(hv);
  return ans;
}

static int is_req_ev(const WnEv *e, void *ctx) { return e->source == WN_SRC_FETCH && e->handle == (uint32_t)(uintptr_t)ctx; }

int32_t host_fetch(int32_t op, int32_t ptr, int32_t len, int32_t h, int32_t x) {
  if (op == 1) return start((uint32_t)ptr, (uint32_t)len, (uint32_t)x);
  if (op == 2) {
    Req *r = req_of((uint32_t)h);
    if (!r) wn_host_fail("fetch: ABORT of a request that does not exist");
    wn_ev_purge(is_req_ev, (void *)(uintptr_t)h);
    req_finish(r);
    return 0;
  }
  wn_host_fail("fetch: an op outside the contract");
}
