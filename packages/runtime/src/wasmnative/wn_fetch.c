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
 * and https goes through vendored mbedTLS (the TLS unit's engine) on the
 * program thread. A request holds the loop from START until its BODY or
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

#include "mbedtls/error.h"
#include "mbedtls/net_sockets.h"
#include "mbedtls/oid.h"
#include "mbedtls/ssl.h"
#include "mbedtls/x509_crt.h"
#include "psa/crypto.h"

#include "scr_zlib_prefix.h"
#include "zlib.h"

#include "wn_host.h"
#include "wn_trust.h"

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
    char txt[INET6_ADDRSTRLEN];
    inet_ntop(AF_INET6, &a, txt, sizeof txt);
    Str s = {0};
    s_chr(&s, '[');
    s_cat(&s, txt);
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

typedef struct Req {
  uint32_t handle;
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
  WnBuf in;
  mbedtls_ssl_config conf;
  mbedtls_ssl_context ssl;
  mbedtls_x509_crt chain;
  int tls_on;
  int leaf_self, chain_self, depth_max, top_self;
  /* the response */
  int status;
  char *status_text;
  Hdrs rh;
  int head_done, head_sent, chunked, until_close, no_body;
  long long clen;
  WnBuf body_raw;
  size_t chunk_left;
  int chunk_state; /* 0 size line, 1 data, 2 data CRLF, 3 trailers */
  /* llhttp's view, as undici reads it */
  Str cl_str;              /* every content-length value undici collected */
  unsigned long long bytes_read;
  size_t headers_size;     /* name and value bytes (undici's headersSize) */
  int have_cl, have_te;
  int hop_last_;
} Req;

static Req **reqs;
static uint32_t n_reqs;

static void req_free_hop(Req *r) {
  if (r->fd >= 0) wn_io_close(&r->io);
  r->fd = -1;
  if (r->tls_on) {
    mbedtls_ssl_free(&r->ssl);
    mbedtls_ssl_config_free(&r->conf);
    mbedtls_x509_crt_free(&r->chain);
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
  wn_buf_free(&r->in);
  free(r->status_text);
  r->status_text = NULL;
  h_free(&r->rh);
  wn_buf_free(&r->body_raw);
  free(r->cl_str.p);
  /* everything per hop, zeroed whole (the verification verdict included) */
  memset(&r->hop_first_, 0, offsetof(Req, hop_last_) - offsetof(Req, hop_first_));
  r->fd = -1;
  r->clen = -1;
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
static void err_record(WnBuf *b, const char *name, const char *msg, const char *cname, const char *cmsg, const char *ccode) {
  wn_buf_run8(b, name, strlen(name));
  wn_buf_run8(b, msg, strlen(msg));
  wn_buf_u32(b, cname != NULL);
  if (cname) {
    wn_buf_run8(b, cname, strlen(cname));
    wn_buf_run8(b, cmsg, strlen(cmsg));
    wn_buf_run8(b, ccode ? ccode : "", ccode ? strlen(ccode) : 0);
  }
}
/* the request failed: before its head, fetch() rejects with "fetch
 * failed"; after it, the body readers with "terminated" */
static void req_fail(Req *r, const char *cname, const char *cmsg, const char *ccode) {
  if (r->dead) return;
  WnBuf b = {0};
  err_record(&b, "TypeError", r->head_sent ? "terminated" : "fetch failed", cname, cmsg, ccode);
  wn_ev_push(wn_ev_new(WN_SRC_FETCH, r->handle, EV_FAIL, 0, 0, b.p, (uint32_t)b.n));
  wn_buf_free(&b);
  req_finish(r);
}
static void req_fail_errno(Req *r, const char *syscall, int e, const char *where) {
  char msg[300];
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
  if (where) snprintf(msg, sizeof msg, "%s %s %s", syscall, code, where);
  else snprintf(msg, sizeof msg, "%s %s", syscall, code);
  req_fail(r, "Error", msg, code);
}

/* ── the hop: resolve, connect, (proxy), (TLS), send, read ────────────── */
static void hop_start(Req *r);
static void fx_ready(WnIo *io, uint32_t evs);

static int rng(void *ctx, unsigned char *out, size_t n) {
  (void)ctx;
  size_t got = 0;
  while (got < n) {
    ssize_t k = getrandom(out + got, n - got, 0);
    if (k > 0) got += (size_t)k;
    else if (errno != EINTR) return MBEDTLS_ERR_SSL_INTERNAL_ERROR;
  }
  return 0;
}

static int bio_send(void *ctx, const unsigned char *buf, size_t len) {
  Req *r = ctx;
  wn_buf_put(&r->out, buf, len);
  return (int)len;
}
static int bio_recv(void *ctx, unsigned char *buf, size_t len) {
  Req *r = ctx;
  ssize_t n;
  do n = recv(r->fd, buf, len, 0);
  while (n < 0 && errno == EINTR);
  if (n >= 0) return (int)n;
  if (errno == EAGAIN || errno == EWOULDBLOCK) return MBEDTLS_ERR_SSL_WANT_READ;
  return errno == ECONNRESET ? MBEDTLS_ERR_NET_CONN_RESET : MBEDTLS_ERR_NET_RECV_FAILED;
}
static int vrfy_cb(void *ctx, mbedtls_x509_crt *crt, int depth, uint32_t *flags) {
  Req *r = ctx;
  int self = crt->issuer_raw.len == crt->subject_raw.len && memcmp(crt->issuer_raw.p, crt->subject_raw.p, crt->subject_raw.len) == 0;
  if (depth >= r->depth_max) {
    r->depth_max = depth;
    r->top_self = self;
  }
  if (*flags & MBEDTLS_X509_BADCERT_NOT_TRUSTED) {
    if (depth == 0 && self) r->leaf_self = 1;
    if (depth > 0 && self) r->chain_self = 1;
  }
  return 0;
}

/* a verdict as Node's TLS error: the OpenSSL text and code */
static void tls_verdict_fail(Req *r) {
  uint32_t f = mbedtls_ssl_get_verify_result(&r->ssl);
  const mbedtls_x509_crt *peer = mbedtls_ssl_get_peer_cert(&r->ssl);
  int alone = peer != NULL && peer->next == NULL;
  const char *msg = "unspecified certificate verification error", *code = "UNSPECIFIED";
  const char *hint = "; if the root CA is installed locally, try running Node.js with --use-system-ca";
  char buf[300];
  uint32_t g = f & ~(uint32_t)MBEDTLS_X509_BADCERT_CN_MISMATCH;
  if (g & MBEDTLS_X509_BADCERT_NOT_TRUSTED) {
    if (r->leaf_self && alone) {
      snprintf(buf, sizeof buf, "self-signed certificate%s", hint);
      msg = buf;
      code = "DEPTH_ZERO_SELF_SIGNED_CERT";
    } else if (r->chain_self) {
      msg = "self-signed certificate in certificate chain";
      code = "SELF_SIGNED_CERT_IN_CHAIN";
    } else if (alone) {
      snprintf(buf, sizeof buf, "unable to verify the first certificate%s", hint);
      msg = buf;
      code = "UNABLE_TO_VERIFY_LEAF_SIGNATURE";
    } else {
      msg = "unable to get local issuer certificate";
      code = "UNABLE_TO_GET_ISSUER_CERT_LOCALLY";
    }
  } else if (g & MBEDTLS_X509_BADCERT_EXPIRED) {
    msg = "certificate has expired";
    code = "CERT_HAS_EXPIRED";
  } else if (g & MBEDTLS_X509_BADCERT_FUTURE) {
    msg = "certificate is not yet valid";
    code = "CERT_NOT_YET_VALID";
  } else if (g & MBEDTLS_X509_BADCERT_REVOKED) {
    msg = "certificate revoked";
    code = "CERT_REVOKED";
  } else if (g == 0 && !r->top_self) {
    msg = "unable to get issuer certificate";
    code = "UNABLE_TO_GET_ISSUER_CERT";
  }
  req_fail(r, "Error", msg, code);
}

/* the request head, as undici writes it */
static void write_head(Req *r) {
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
    size_t off = 0;
    while (off < h.n) {
      int k = mbedtls_ssl_write(&r->ssl, (const unsigned char *)h.p + off, h.n - off);
      if (k < 0) break;
      off += (size_t)k;
    }
    off = 0;
    while (r->has_body && off < r->blen) {
      int k = mbedtls_ssl_write(&r->ssl, r->body + off, r->blen - off);
      if (k < 0) break;
      off += (size_t)k;
    }
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
  static int psa;
  if (!psa) {
    psa_crypto_init();
    psa = 1;
  }
  mbedtls_ssl_config_init(&r->conf);
  mbedtls_ssl_init(&r->ssl);
  mbedtls_x509_crt_init(&r->chain);
  r->tls_on = 1;
  mbedtls_ssl_config_defaults(&r->conf, MBEDTLS_SSL_IS_CLIENT, MBEDTLS_SSL_TRANSPORT_STREAM, MBEDTLS_SSL_PRESET_DEFAULT);
  mbedtls_ssl_conf_rng(&r->conf, rng, NULL);
  mbedtls_ssl_conf_authmode(&r->conf, MBEDTLS_SSL_VERIFY_OPTIONAL);
  mbedtls_ssl_conf_ca_chain(&r->conf, wn_trust_default(), NULL);
  mbedtls_ssl_conf_verify(&r->conf, vrfy_cb, r);
  mbedtls_ssl_setup(&r->ssl, &r->conf);
  /* SNI for a DNS name (an IP literal gets none); the name itself is
   * checked by check_identity, as Node checks it, never by the engine */
  struct in6_addr a6;
  struct in_addr a4;
  if (r->url.host[0] == '[' || inet_pton(AF_INET, r->url.host, &a4) == 1 || inet_pton(AF_INET6, r->url.host, &a6) == 1)
    mbedtls_ssl_set_hostname(&r->ssl, NULL);
  else
    mbedtls_ssl_set_hostname(&r->ssl, r->url.host);
  mbedtls_ssl_set_bio(&r->ssl, r, bio_send, bio_recv, NULL);
  r->state = ST_TLS;
}

static void connected(Req *r) {
  if (r->tunnel) {
    Str h = {0};
    char b[300];
    int port = r->url.port >= 0 ? r->url.port : 443;
    snprintf(b, sizeof b, "CONNECT %s:%d HTTP/1.1\r\nhost: %s:%d\r\nconnection: close\r\n\r\n", r->url.host, port, r->url.host, port);
    s_cat(&h, b);
    wn_buf_put(&r->out, h.p, h.n);
    free(h.p);
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
  run_latin1(&b, r->status_text);
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

static int is_redirect(int s) { return s == 301 || s == 302 || s == 303 || s == 307 || s == 308; }

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

/* a parse failure as undici reports it (Parser.createError): when undici
 * has collected a content-length that the body read so far does not
 * match, the ResponseContentLengthMismatchError; otherwise llhttp's
 * reason inside "Response does not match the HTTP/1.1 protocol (...)" */
static void http_error(Req *r, const char *reason) {
  if (r->cl_str.n > 0) {
    /* bytesRead !== parseInt(contentLength, 10): leading whitespace, a
     * sign, the digits; no digits is NaN, which matches nothing */
    const char *q = r->cl_str.p;
    while (*q == ' ' || *q == '\t' || *q == '\n' || *q == '\r' || *q == '\f' || *q == '\v') q++;
    int neg = 0;
    if (*q == '+' || *q == '-') neg = *q++ == '-';
    int any = 0;
    long double v = 0;
    while (*q >= '0' && *q <= '9') v = v * 10 + (*q++ - '0'), any = 1;
    if (neg) v = -v;
    if (!any || v != (long double)r->bytes_read) {
      req_fail(r, "ResponseContentLengthMismatchError", "Response body length does not match content-length header", "UND_ERR_RES_CONTENT_LENGTH_MISMATCH");
      return;
    }
  }
  char msg[200];
  snprintf(msg, sizeof msg, "Response does not match the HTTP/1.1 protocol (%s)", reason);
  req_fail(r, "HTTPParserError", msg, NULL);
}

#define MAX_HEADERS_SIZE 16384 /* http.maxHeaderSize, undici's default */

/* the status line, as llhttp reads a response's; NULL or the reason */
static const char *status_line(Req *r, const char *p, size_t n, int *status, char **reason) {
  size_t i = 0;
  if (n < 5 || memcmp(p, "HTTP/", 5) != 0) return "Expected HTTP/, RTSP/ or ICE/";
  i = 5;
  if (i >= n || p[i] < '0' || p[i] > '9') return "Invalid major version";
  i++;
  if (i >= n || p[i] != '.') return "Expected dot";
  i++;
  if (i >= n || p[i] < '0' || p[i] > '9') return "Invalid minor version";
  i++;
  if (i >= n || p[i] != ' ') return "Expected space after version";
  i++;
  int code = 0, digits = 0;
  while (i < n && p[i] >= '0' && p[i] <= '9' && digits < 3) code = code * 10 + (p[i++] - '0'), digits++;
  if (digits < 3) return "Invalid status code";
  if (i < n && p[i] != ' ' && p[i] != '\r') return "Invalid response status";
  if (i >= n) return "Invalid response status";
  const char *rs = p + i;
  if (*rs == ' ') rs++;
  const char *cr = memchr(rs, '\r', (size_t)(p + n - rs));
  if (!cr || cr + 1 != p + n - 1) return "Missing expected CR after response line";
  (void)r;
  *status = code;
  *reason = xstrndup(rs, (size_t)(cr - rs));
  return NULL;
}

/* one header line (without its LF); NULL or the reason */
static const char *header_line(Req *r, const char *p, size_t n) {
  if (n == 0 || p[n - 1] != '\r') return "Missing expected CR after header value";
  n--;
  if (n > 0 && (p[0] == ' ' || p[0] == '\t')) return "Unexpected whitespace after header value";
  size_t c = 0;
  while (c < n && p[c] != ':') {
    unsigned char ch = (unsigned char)p[c];
    if (!(ch > 0x20 && ch < 0x7f && !strchr("\"(),/:;<=>?@[\\]{}", ch))) return "Invalid header token";
    c++;
  }
  if (c == n || c == 0) return "Invalid header token";
  size_t v = c + 1;
  while (v < n && (p[v] == ' ' || p[v] == '\t')) v++;
  for (size_t k = v; k < n; k++) {
    unsigned char ch = (unsigned char)p[k];
    if ((ch < 0x20 && ch != '\t')) return "Invalid header value char";
  }
  char *name = xstrndup(p, c);
  char *value = xstrndup(p + v, n - v);
  r->headers_size += c + (n - v);
  const char *bad = NULL;
  if (!strcasecmp(name, "content-length")) {
    if (r->have_cl) bad = "Duplicate Content-Length";
    else {
      r->have_cl = 1;
      unsigned long long acc = 0;
      size_t k = 0;
      for (; k < strlen(value) && value[k] >= '0' && value[k] <= '9'; k++) {
        unsigned d = (unsigned)(value[k] - '0');
        if (acc > (18446744073709551615ULL - d) / 10) {
          s_put(&r->cl_str, value, k);
          bad = "Content-Length overflow";
          break;
        }
        acc = acc * 10 + d;
      }
      if (!bad) {
        size_t t = k;
        while (t < strlen(value) && (value[t] == ' ' || value[t] == '\t')) t++;
        if (k == 0 || t != strlen(value)) {
          s_put(&r->cl_str, value, k);
          bad = "Invalid character in Content-Length";
        } else {
          s_cat(&r->cl_str, value);
          r->clen = (long long)acc;
        }
      }
    }
  } else if (!strcasecmp(name, "transfer-encoding")) {
    r->have_te = 1;
    /* chunked only as the final coding */
    const char *last = strrchr(value, ',');
    last = last ? last + 1 : value;
    while (*last == ' ' || *last == '\t') last++;
    size_t ll = strlen(last);
    while (ll && (last[ll - 1] == ' ' || last[ll - 1] == '\t')) ll--;
    r->chunked = ll == 7 && !strncasecmp(last, "chunked", 7);
  }
  if (!bad) h_add(&r->rh, name, value);
  free(name);
  free(value);
  return bad;
}

/* parses what has arrived; returns after the request moved on */
static void parse_in(Req *r, int eof) {
  for (;;) {
    if (r->dead) return;
    if (!r->head_done) {
      /* line by line, each line checked as it completes */
      for (;;) {
        uint8_t *p = r->in.p;
        size_t n = r->in.n;
        uint8_t *lf = n ? memchr(p, '\n', n) : NULL;
        if (!lf) {
          if (r->status != 0 && r->headers_size + n >= MAX_HEADERS_SIZE) {
            req_fail(r, "HeadersOverflowError", "Headers Overflow Error", "UND_ERR_HEADERS_OVERFLOW");
            return;
          }
          if (eof) req_fail(r, "SocketError", "other side closed", "UND_ERR_SOCKET");
          return;
        }
        size_t ll = (size_t)(lf - p);
        char *line = xstrndup((char *)p, ll + 1);
        memmove(r->in.p, r->in.p + ll + 1, n - ll - 1);
        r->in.n = n - ll - 1;
        const char *bad = NULL;
        if (r->status == 0) {
          int st = 0;
          char *reason = NULL;
          bad = status_line(r, line, ll + 1, &st, &reason);
          if (!bad) {
            r->status = st;
            free(r->status_text);
            r->status_text = reason;
            h_free(&r->rh);
          }
        } else if (ll == 1 && line[0] == '\r') {
          free(line);
          break; /* the end of the head */
        } else if (ll == 0) {
          bad = "Missing expected CR after header value";
        } else {
          bad = header_line(r, line, ll);
          if (!bad && r->headers_size >= MAX_HEADERS_SIZE) {
            free(line);
            req_fail(r, "HeadersOverflowError", "Headers Overflow Error", "UND_ERR_HEADERS_OVERFLOW");
            return;
          }
        }
        free(line);
        if (bad) {
          http_error(r, bad);
          return;
        }
      }
      int status = r->status;
      if (status < 100) {
        req_fail(r, "AssertionError", "The expression evaluated to a falsy value:\n\n  assert(statusCode >= 100)\n", "ERR_ASSERTION");
        return;
      }
      if (r->have_cl && r->have_te) {
        http_error(r, "Content-Length can't be present with Transfer-Encoding");
        return;
      }
      if (status < 200 && status != 101) {
        /* an informational response: the next head follows */
        r->status = 0;
        r->headers_size = 0;
        r->have_cl = r->have_te = r->chunked = 0;
        r->clen = -1;
        free(r->cl_str.p);
        memset(&r->cl_str, 0, sizeof r->cl_str);
        h_free(&r->rh);
        continue;
      }
      r->head_done = 1;
      r->no_body = !strcmp(r->method, "HEAD") || status == 204 || status == 205 || status == 304 || status == 101 || status == 103;
      if (r->no_body) {
        r->clen = 0;
        r->chunked = 0;
      } else if (r->chunked) {
        r->clen = -1;
      } else if (r->have_te || r->clen < 0) {
        r->clen = -1;
        r->until_close = 1;
      }
      int redirect_hop = is_redirect(status) && h_find(&r->rh, "location") && r->redirect != 2;
      if (!redirect_hop) send_head(r);
      r->state = ST_BODY;
    }
    /* the body */
    if (r->chunked) {
      for (;;) {
        if (r->chunk_state == 0) {
          /* the size line: hex digits, then extensions, then CRLF */
          size_t i = 0;
          unsigned long long size = 0;
          int digits = 0;
          while (i < r->in.n && isxdigit(r->in.p[i])) {
            if (size >> 60) {
              http_error(r, "Chunk size overflow");
              return;
            }
            size = size * 16 + (unsigned)hexv(r->in.p[i]);
            i++, digits++;
          }
          if (i == r->in.n) {
            if (eof) goto cut;
            return;
          }
          if (digits == 0) {
            http_error(r, "Invalid character in chunk size");
            return;
          }
          uint8_t c = r->in.p[i];
          if (c != '\r' && c != ';' && c != ' ' && c != '\t') {
            http_error(r, "Invalid character in chunk size");
            return;
          }
          uint8_t *nl = memchr(r->in.p + i, '\n', r->in.n - i);
          if (!nl) {
            if (eof) goto cut;
            return;
          }
          if (nl == r->in.p || nl[-1] != '\r') {
            http_error(r, "Missing expected CR after chunk size");
            return;
          }
          size_t ll = (size_t)(nl - r->in.p) + 1;
          memmove(r->in.p, r->in.p + ll, r->in.n - ll);
          r->in.n -= ll;
          r->chunk_left = (size_t)size;
          r->chunk_state = size == 0 ? 3 : 1;
          continue;
        }
        if (r->chunk_state == 3) {
          uint8_t *nl = memchr(r->in.p, '\n', r->in.n);
          if (!nl) {
            if (eof) goto cut;
            return;
          }
          size_t ll = (size_t)(nl - r->in.p) + 1;
          int empty = ll == 2 && r->in.p[0] == '\r';
          memmove(r->in.p, r->in.p + ll, r->in.n - ll);
          r->in.n -= ll;
          if (empty) goto complete;
          continue; /* a trailer */
        }
        if (r->chunk_state == 1) {
          size_t k = r->in.n < r->chunk_left ? r->in.n : r->chunk_left;
          wn_buf_put(&r->body_raw, r->in.p, k);
          r->bytes_read += k;
          memmove(r->in.p, r->in.p + k, r->in.n - k);
          r->in.n -= k;
          r->chunk_left -= k;
          if (r->chunk_left > 0) {
            if (eof) goto cut;
            return;
          }
          r->chunk_state = 2;
        }
        if (r->chunk_state == 2) {
          if (r->in.n < 2) {
            if (r->in.n == 1 && r->in.p[0] != '\r') {
              http_error(r, "Expected LF after chunk data");
              return;
            }
            if (eof) goto cut;
            return;
          }
          if (r->in.p[0] != '\r' || r->in.p[1] != '\n') {
            http_error(r, "Expected LF after chunk data");
            return;
          }
          memmove(r->in.p, r->in.p + 2, r->in.n - 2);
          r->in.n -= 2;
          r->chunk_state = 0;
        }
      }
    }
    if (r->clen >= 0) {
      unsigned long long need = (unsigned long long)r->clen - r->bytes_read;
      size_t k = (unsigned long long)r->in.n < need ? r->in.n : (size_t)need;
      wn_buf_put(&r->body_raw, r->in.p, k);
      r->bytes_read += k;
      memmove(r->in.p, r->in.p + k, r->in.n - k);
      r->in.n -= k;
      if (r->bytes_read >= (unsigned long long)r->clen) goto complete;
      if (eof) goto cut;
      return;
    }
    /* until close */
    wn_buf_put(&r->body_raw, r->in.p, r->in.n);
    r->bytes_read += r->in.n;
    r->in.n = 0;
    if (eof) goto complete;
    return;
  complete:
    if (is_redirect(r->status) && !r->head_sent) {
      if (follow(r)) return;
      send_head(r);
    }
    finish_body(r);
    return;
  cut:
    req_fail(r, "SocketError", "other side closed", "UND_ERR_SOCKET");
    return;
  }
}

static void on_proxy_reply(Req *r) {
  uint8_t *p = r->in.p;
  size_t n = r->in.n;
  for (size_t i = 0; i + 3 < n; i++)
    if (p[i] == '\r' && p[i + 1] == '\n' && p[i + 2] == '\r' && p[i + 3] == '\n') {
      int status = 0;
      sscanf((char *)p + 9, "%d", &status);
      memmove(r->in.p, r->in.p + i + 4, n - i - 4);
      r->in.n = n - i - 4;
      if (status != 200) {
        req_fail(r, "Error", "Proxy response !== 200 when HTTP Tunneling", "UND_ERR_ABORTED");
        return;
      }
      tls_begin(r);
      return;
    }
}

/* Node's tls.checkServerIdentity, which undici's connections run: an IP
 * literal must be one of the certificate's IP-address names (never the
 * CN); a DNS name one of its DNS names (RFC 6125 wildcards: one, in the
 * leftmost label, never for a two-label pattern nor an xn-- label), or —
 * only with no DNS names — its CN. 1 when it matches; otherwise the
 * request fails with ERR_TLS_CERT_ALTNAME_INVALID and Node's reason. */
static int split_host(const char *h, char ***parts) {
  char *c = xstrdup(h);
  size_t n = strlen(c);
  if (n && c[n - 1] == '.') c[--n] = 0;
  for (char *q = c; *q; q++)
    if (*q >= 'A' && *q <= 'Z') *q = (char)(*q - 'A' + 'a');
  int k = 1;
  for (char *q = c; *q; q++)
    if (*q == '.') k++;
  char **v = calloc((size_t)k + 1, sizeof *v);
  if (!v) abort();
  int i = 0;
  char *start = c;
  for (char *q = c;; q++)
    if (*q == '.' || *q == 0) {
      int end = *q == 0;
      *q = 0;
      v[i++] = xstrdup(start);
      start = q + 1;
      if (end) break;
    }
  free(c);
  *parts = v;
  return i;
}
static void free_parts(char **v, int n) {
  for (int i = 0; i < n; i++) free(v[i]);
  free(v);
}
static int wild_match(char **hp, int hn, const char *pattern) {
  if (!pattern || !*pattern) return 0;
  char **pp;
  int pn = split_host(pattern, &pp);
  int ok = 0;
  if (pn != hn) goto out;
  for (int i = 0; i < pn; i++) {
    if (!*pp[i]) goto out;
    for (const char *q = pp[i]; *q; q++)
      if ((unsigned char)*q < 0x21 || (unsigned char)*q > 0x7f) goto out;
  }
  for (int i = hn - 1; i > 0; i--)
    if (strcmp(hp[i], pp[i]) != 0) goto out;
  {
    const char *ps = pp[0], *hs = hp[0];
    const char *star = strchr(ps, '*');
    if (!star || strstr(ps, "xn--")) {
      ok = strcmp(hs, ps) == 0;
      goto out;
    }
    if (strchr(star + 1, '*')) goto out;
    if (pn <= 2) goto out;
    size_t pre = (size_t)(star - ps), suf = strlen(star + 1), hl = strlen(hs);
    if (pre + suf > hl) goto out;
    if (strncmp(hs, ps, pre) != 0) goto out;
    if (strcmp(hs + hl - suf, star + 1) != 0) goto out;
    ok = 1;
  }
out:
  free_parts(pp, pn);
  return ok;
}
static int check_identity(Req *r) {
  const mbedtls_x509_crt *peer = mbedtls_ssl_get_peer_cert(&r->ssl);
  if (!peer) return 1;
  char host[300];
  snprintf(host, sizeof host, "%s", r->url.host);
  if (host[0] == '[') {
    memmove(host, host + 1, strlen(host));
    host[strlen(host) - 1] = 0;
  }
  size_t hl = strlen(host);
  if (hl && host[hl - 1] == '.') host[--hl] = 0;
  /* the altnames as Node prints them, and the DNS and IP lists */
  Str alt = {0}, ips = {0};
  char **dns = NULL;
  int ndns = 0, nips = 0;
  for (const mbedtls_x509_sequence *cur = &peer->subject_alt_names; cur && cur->buf.p; cur = cur->next) {
    mbedtls_x509_subject_alternative_name san;
    if (mbedtls_x509_parse_subject_alt_name(&cur->buf, &san) != 0) continue;
    const mbedtls_x509_buf *u = &san.san.unstructured_name;
    char item[512] = "";
    if (san.type == MBEDTLS_X509_SAN_DNS_NAME) {
      char *d = xstrndup((const char *)u->p, u->len);
      snprintf(item, sizeof item, "DNS:%s", d);
      dns = realloc(dns, sizeof *dns * (size_t)(ndns + 1));
      if (!dns) abort();
      dns[ndns++] = d;
    } else if (san.type == MBEDTLS_X509_SAN_IP_ADDRESS && (u->len == 4 || u->len == 16)) {
      char ip[INET6_ADDRSTRLEN];
      inet_ntop(u->len == 4 ? AF_INET : AF_INET6, u->p, ip, sizeof ip);
      snprintf(item, sizeof item, "IP Address:%s", ip);
      if (nips++) s_cat(&ips, ", ");
      s_cat(&ips, ip);
    } else if (san.type == MBEDTLS_X509_SAN_RFC822_NAME) {
      snprintf(item, sizeof item, "email:%.*s", (int)u->len, (const char *)u->p);
    } else if (san.type == MBEDTLS_X509_SAN_UNIFORM_RESOURCE_IDENTIFIER) {
      snprintf(item, sizeof item, "URI:%.*s", (int)u->len, (const char *)u->p);
    }
    mbedtls_x509_free_subject_alt_name(&san);
    if (!*item) continue;
    if (alt.n) s_cat(&alt, ", ");
    s_cat(&alt, item);
  }
  char *cn = NULL;
  for (const mbedtls_x509_name *nm = &peer->subject; nm; nm = nm->next)
    if (nm->oid.p && MBEDTLS_OID_CMP(MBEDTLS_OID_AT_CN, &nm->oid) == 0) {
      free(cn);
      cn = xstrndup((const char *)nm->val.p, nm->val.len);
    }
  int valid = 0;
  Str reason = {0};
  struct in6_addr a6, b6;
  struct in_addr a4;
  int is4 = inet_pton(AF_INET, host, &a4) == 1, is6 = !is4 && inet_pton(AF_INET6, host, &a6) == 1;
  if (is4 || is6) {
    for (const mbedtls_x509_sequence *cur = &peer->subject_alt_names; cur && cur->buf.p && !valid; cur = cur->next) {
      mbedtls_x509_subject_alternative_name san;
      if (mbedtls_x509_parse_subject_alt_name(&cur->buf, &san) != 0) continue;
      const mbedtls_x509_buf *u = &san.san.unstructured_name;
      if (san.type == MBEDTLS_X509_SAN_IP_ADDRESS) {
        if (is4 && u->len == 4 && memcmp(u->p, &a4, 4) == 0) valid = 1;
        if (is6 && u->len == 16) {
          memcpy(&b6, u->p, 16);
          if (memcmp(&a6, &b6, 16) == 0) valid = 1;
        }
      }
      mbedtls_x509_free_subject_alt_name(&san);
    }
    if (!valid) {
      s_cat(&reason, "IP: ");
      s_cat(&reason, host);
      s_cat(&reason, " is not in the cert's list: ");
      if (ips.p) s_cat(&reason, ips.p);
    }
  } else if (ndns > 0 || (cn && *cn)) {
    char **hp;
    int hn = split_host(host, &hp);
    if (ndns > 0) {
      for (int i = 0; i < ndns && !valid; i++) valid = wild_match(hp, hn, dns[i]);
      if (!valid) {
        s_cat(&reason, "Host: ");
        s_cat(&reason, host);
        s_cat(&reason, ". is not in the cert's altnames: ");
        if (alt.p) s_cat(&reason, alt.p);
      }
    } else {
      valid = wild_match(hp, hn, cn);
      if (!valid) {
        s_cat(&reason, "Host: ");
        s_cat(&reason, host);
        s_cat(&reason, ". is not cert's CN: ");
        s_cat(&reason, cn);
      }
    }
    free_parts(hp, hn);
  } else
    s_cat(&reason, "Cert does not contain a DNS name");
  for (int i = 0; i < ndns; i++) free(dns[i]);
  free(dns);
  free(cn);
  free(alt.p);
  free(ips.p);
  if (!valid) {
    Str m = {0};
    s_cat(&m, "Hostname/IP does not match certificate's altnames: ");
    s_cat(&m, reason.p ? reason.p : "");
    req_fail(r, "Error", m.p, "ERR_TLS_CERT_ALTNAME_INVALID");
    free(m.p);
  }
  free(reason.p);
  return valid;
}

static void tls_pump(Req *r) {
  if (r->state == ST_TLS) {
    int k = mbedtls_ssl_handshake(&r->ssl);
    if (k == MBEDTLS_ERR_SSL_WANT_READ || k == MBEDTLS_ERR_SSL_WANT_WRITE) return;
    if (k != 0) {
      if (k == MBEDTLS_ERR_SSL_CONN_EOF || k == MBEDTLS_ERR_NET_CONN_RESET) {
        req_fail(r, "Error", "Client network socket disconnected before secure TLS connection was established", "ECONNRESET");
        return;
      }
      char d[120], msg[200];
      mbedtls_strerror(k, d, sizeof d);
      snprintf(msg, sizeof msg, "error:0A000000:SSL routines::%s", d);
      req_fail(r, "Error", msg, "ERR_SSL_SSL_HANDSHAKE_FAILURE");
      return;
    }
    /* the chain first, then the name (Node's order); the engine's own
     * name check is never consulted */
    uint32_t f = mbedtls_ssl_get_verify_result(&r->ssl) & ~(uint32_t)MBEDTLS_X509_BADCERT_CN_MISMATCH;
    if (f != 0 || !r->top_self) {
      tls_verdict_fail(r);
      return;
    }
    if (!check_identity(r)) return;
    write_head(r);
    r->state = ST_HEAD;
  }
  uint8_t buf[16384];
  for (;;) {
    int k = mbedtls_ssl_read(&r->ssl, buf, sizeof buf);
    if (k > 0) {
      wn_buf_put(&r->in, buf, (size_t)k);
      continue;
    }
    if (k == MBEDTLS_ERR_SSL_WANT_READ || k == MBEDTLS_ERR_SSL_WANT_WRITE) {
      parse_in(r, 0);
      return;
    }
#ifdef MBEDTLS_ERR_SSL_RECEIVED_NEW_SESSION_TICKET
    if (k == MBEDTLS_ERR_SSL_RECEIVED_NEW_SESSION_TICKET) continue;
#endif
    if (k == 0 || k == MBEDTLS_ERR_SSL_PEER_CLOSE_NOTIFY || k == MBEDTLS_ERR_SSL_CONN_EOF) {
      parse_in(r, 1);
      return;
    }
    if (k == MBEDTLS_ERR_NET_CONN_RESET) {
      req_fail(r, "Error", "read ECONNRESET", "ECONNRESET");
      return;
    }
    char d[120];
    mbedtls_strerror(k, d, sizeof d);
    req_fail(r, "Error", d, "ERR_SSL_SSL_HANDSHAKE_FAILURE");
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
      for (;;) {
        ssize_t n = recv(r->fd, buf, sizeof buf, 0);
        if (n < 0) {
          if (errno == EINTR) continue;
          if (errno == EAGAIN || errno == EWOULDBLOCK) break;
          int e = errno;
          if (e == ECONNRESET && !r->head_done && r->in.n == 0) req_fail(r, "SocketError", "other side closed", "UND_ERR_SOCKET");
          else req_fail_errno(r, "read", e, NULL);
          return;
        }
        if (n == 0) {
          if (r->state == ST_PROXY) {
            req_fail(r, "SocketError", "other side closed", "UND_ERR_SOCKET");
            return;
          }
          parse_in(r, 1);
          return;
        }
        wn_buf_put(&r->in, buf, (size_t)n);
        if (r->state == ST_PROXY) {
          on_proxy_reply(r);
          if (r->dead) return;
          if (r->state == ST_TLS) tls_pump(r);
          break;
        }
        parse_in(r, 0);
        if (r->dead || r->fd < 0) return;
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
  err_record(&b, name, msg, cname, cmsg, ccode);
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
  r->clen = -1;
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
