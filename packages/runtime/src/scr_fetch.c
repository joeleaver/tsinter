/* fetch for the dynamic island, over scriptc's OWN net stack — the
 * scr_platform poller + scr_net sockets, scr_http's HTTP/1.1 client
 * parser, scr_tls (vendored mbedTLS) for https, and zlib for response
 * decompression. No libcurl anywhere: the architecture is Node's own
 * (libuv sockets + OpenSSL + undici; ours: poller + mbedTLS + this
 * unit), which is what lets fetch compile for every target the socket
 * units reach — win32 included, where no system-libcurl contract
 * exists. The curl implementation this replaces stays compilable for
 * one release as the reference (scr_fetch_curl.c, selected by
 * SCRIPTC_FETCH_CURL=1 at build time; same install symbol, same island
 * surface, same fixture suite).
 *
 * Architecture (the JS half is UNCHANGED from the curl bridge):
 * - The JS half (fetch_glue below) defines globalThis.fetch over two host
 *   functions: host.start(req, cbs) begins a transfer and host.abort(id)
 *   cancels one (response-body cancel). fetch() returns a REAL island
 *   promise; the Response's body is an island ReadableStream fed by
 *   C→engine callbacks as data arrives.
 * - The C half is a fetch-layer client over scr_http's client machinery:
 *   one ScrHttpClientReq per hop, minted runtime closures (caps[0] boxes
 *   the transfer) as its response/data/end/error listeners, callbacks
 *   firing from the net unit's dispatch station — the loop's own poller
 *   sleeps on socket readiness, so this unit registers NO poll hook with
 *   the island (the curl bridge needed one to sleep on curl's fds).
 *   AbortSignal.timeout stays punctual through the loop's island-timer
 *   deadline hook (scr_loop_set_island_deadline — armed island timers cap
 *   the idle sleep exactly the way the curl poll capped its own).
 * - fetch SEMANTICS, matched to Node/undici: HTTP errors RESOLVE (only
 *   network failure rejects, with TypeError "fetch failed" — Node's exact
 *   message); redirects are followed IN THIS UNIT (20 hops, fetch's
 *   limit; 303 — and 301/302 for POST — rewrite to GET and drop the body
 *   and its content-* headers, the fetch spec's rules; authorization is
 *   stripped on cross-origin hops; response.url = the final URL without
 *   its fragment, response.redirected set; a redirect hop's own body
 *   never reaches the island). The request head carries undici's exact
 *   default header set in undici's order (host, connection, the user
 *   headers, accept, accept-language, sec-fetch-mode, user-agent,
 *   accept-encoding — captured from Node 24 on the wire); gzip/zlib
 *   response bodies arrive decompressed (accept-encoding advertises
 *   "gzip, deflate", and content-encoding: gzip/x-gzip/deflate inflates
 *   through zlib's 15+32 auto-detect — raw-deflate servers and br/zstd
 *   are out of the slice, honestly: br/zstd are never offered).
 * - DNS: scr_net dials IP literals only (Node's shape for its slice), so
 *   this unit resolves hostnames with getaddrinfo AT HOP START — the
 *   dns.lookup precedent (scr_dgram.c): synchronous resolution, first
 *   answer wins; failures ride the socket's deferred
 *   "getaddrinfo ENOTFOUND host" error so the rejection's cause is
 *   Node's exact shape. TLS handshakes verify/SNI against the URL
 *   HOSTNAME while the socket dials the resolved IP.
 * - Proxies, matched to Node: undici's global fetch IGNORES http_proxy/
 *   https_proxy unless NODE_USE_ENV_PROXY=1 opts in (Node 24's
 *   EnvHttpProxyAgent). Opted in, http:// targets relay through the
 *   proxy as absolute-URI requests (the classic forward-proxy wire form;
 *   undici tunnels CONNECT, but the fixture proxy counts either form
 *   identically), no_proxy exclusions honored. https-over-proxy
 *   (CONNECT) is out of the slice.
 * - AbortSignal is wired exactly as before (init.signal, or the
 *   Request's): an already-aborted signal rejects with its reason before
 *   any transfer starts; aborting a live transfer destroys the hop's
 *   connection through host.abort (silent on the C side — the glue owns
 *   the rejection); AbortSignal.timeout's TimeoutError rides the island
 *   timer machinery in scr_web.c.
 * - Error causes, Node's shapes: connect ECONNREFUSED ip:port /
 *   getaddrinfo ENOTFOUND host pass through from the net layer with
 *   their codes; a server that dies before the response head maps to
 *   undici's cause exactly — "other side closed", code UND_ERR_SOCKET
 *   (the curl bridge could only offer curl's own string there).
 * - Ownership: each transfer is refcounted — the live registry holds +1
 *   and every minted listener closure's box holds +1; settling releases
 *   the engine callback object and the hop client, and teardown
 *   (registered with the island) frees whatever is still live before the
 *   engine goes down, so the island audit stays zero. */
#ifdef SCR_DYNAMIC

#include "scr_runtime.h"
#include "scr_url_internal.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* the vendored zlib (Node's own, scr_z_-prefixed — see scr_zlib.c) */
#include "scr_zlib_prefix.h"
#include "zlib.h"

#include "quickjs.h"

static void fx_oom(void) {
  fputs("scriptc: out of memory\n", stderr);
  abort();
}

/* ── small string helpers (ScrStr names are not NUL-guaranteed at the
 * lengths we compare, so everything is len-aware, ASCII-case-folded) ── */

static bool fx_eq_ci(const char *a, size_t alen, const char *b) {
  size_t blen = strlen(b);
  if (alen != blen) return false;
  for (size_t i = 0; i < alen; i++) {
    char c = a[i];
    if (c >= 'A' && c <= 'Z') c = (char)(c - 'A' + 'a');
    if (c != b[i]) return false;
  }
  return true;
}

static bool fx_str_is(const ScrStr *s, const char *lit) { return fx_eq_ci(s->data, s->len, lit); }

/* Does the flat [name, value, ...] pairs array carry `name`? */
static bool fx_pairs_have(ScrArr *pairs, const char *name) {
  size_t n = (size_t)scr_arr_len(pairs);
  bool found = false;
  for (size_t i = 0; i + 1 < n && !found; i += 2) {
    ScrStr *nm = (ScrStr *)scr_arr_get_ref(pairs, (double)i);
    found = fx_eq_ci(nm->data, nm->len, name);
    scr_str_release(nm);
  }
  return found;
}

static void fx_pairs_push(ScrArr *pairs, const char *name, const char *value, size_t vlen) {
  scr_arr_push_ref(pairs, scr_str_new(name, strlen(name)));
  scr_arr_push_ref(pairs, scr_str_new(value, vlen));
}

/* ── transfers ───────────────────────────────────────────────────────── */

typedef struct FxTransfer {
  size_t rc; /* the live registry's +1 plus one per minted listener box */
  int id;
  JSContext *ctx;
  JSValue cbs; /* { onResponse, onData, onEnd, onError } — owned while live */
  bool cbs_live;
  /* the request, as it evolves across redirect hops */
  ScrStr *method;  /* owned */
  ScrArr *headers; /* flat [name, value, ...] user pairs — owned */
  ScrBytes *body;  /* owned, NULL = none */
  ScrUrl *url;     /* the CURRENT hop's URL — owned */
  int hops;
  bool redirected;
  /* the live hop */
  ScrHttpClientReq *client; /* +1, NULL between/after hops */
  bool responded; /* onResponse fired (the final response) */
  bool cancelled; /* island aborted/cancelled: die silently */
  bool done;      /* settled: no callback ever fires again */
  /* response decompression */
  bool inflating;
  z_stream zs;
  struct FxTransfer *next;
} FxTransfer;

static FxTransfer *fx_live = NULL; /* registry: +1 each */
static size_t fx_nlive = 0;
static int fx_next_id = 1;

static FxTransfer *fx_retain(FxTransfer *t) {
  t->rc++;
  return t;
}

static void fx_release(FxTransfer *t) {
  if (--t->rc > 0) return;
  scr_str_release(t->method);
  scr_arr_release(t->headers);
  if (t->body) scr_bytes_release(t->body);
  if (t->url) scr_url_release(t->url);
  if (t->client) scr_http_client_release(t->client);
  if (t->inflating) inflateEnd(&t->zs);
  if (t->cbs_live) JS_FreeValue(t->ctx, t->cbs);
  free(t);
}

static void *fx_retain_v(void *p) { return fx_retain((FxTransfer *)p); }
static void fx_release_v(void *p) { fx_release((FxTransfer *)p); }

/* Settle: the transfer is over (delivered, failed, or aborted) — drop the
 * hop client, free the engine callbacks, and leave the registry. Idempotent. */
static void fx_settle(FxTransfer *t) {
  if (t->done) return;
  t->done = true;
  if (t->client) {
    scr_http_client_release(t->client);
    t->client = NULL;
  }
  if (t->cbs_live) {
    JS_FreeValue(t->ctx, t->cbs);
    t->cbs = JS_UNDEFINED;
    t->cbs_live = false;
  }
  for (FxTransfer **link = &fx_live; *link; link = &(*link)->next) {
    if (*link == t) {
      *link = t->next;
      fx_nlive--;
      fx_release(t); /* the registry's +1 */
      return;
    }
  }
}

/* Calls one callback off the cbs object, swallowing (but reporting) any
 * engine exception — the callbacks are our own glue and must not throw.
 * Entered from the net dispatch station (the main stack): re-anchor the
 * engine's stack-overflow check first, the every-island-entry rule. */
static void fx_call(FxTransfer *t, const char *name, int argc, JSValueConst *argv) {
  if (!t->cbs_live) return;
  scr_island_host_enter();
  JSContext *ctx = t->ctx;
  JSValue fn = JS_GetPropertyStr(ctx, t->cbs, name);
  JSValue r = JS_Call(ctx, fn, JS_UNDEFINED, argc, argv);
  JS_FreeValue(ctx, fn);
  if (JS_IsException(r)) {
    JSValue e = JS_GetException(ctx);
    const char *msg = JS_ToCString(ctx, e);
    fprintf(stderr, "scriptc: fetch internal callback '%s' threw: %s\n", name,
            msg ? msg : "?");
    if (msg) JS_FreeCString(ctx, msg);
    JS_FreeValue(ctx, e);
    return;
  }
  JS_FreeValue(ctx, r);
}

/* Network failure → onError(detail, code) → the glue's TypeError "fetch
 * failed" with the classified cause. Settles the transfer. */
static void fx_error(FxTransfer *t, const char *detail, const char *code) {
  if (t->done || t->cancelled) {
    fx_settle(t);
    return;
  }
  JSContext *ctx = t->ctx;
  JSValue args[2];
  args[0] = JS_NewString(ctx, detail);
  args[1] = code ? JS_NewString(ctx, code) : JS_UNDEFINED;
  fx_call(t, "onError", 2, (JSValueConst *)args);
  JS_FreeValue(ctx, args[0]);
  JS_FreeValue(ctx, args[1]);
  fx_settle(t);
}

/* ── minted listener closures (caps[0] boxes the transfer) ───────────── */

static ScrClosure *fx_closure(FxTransfer *t, void *fn) {
  /* fn doubles as the closure's own entry: zero-payload lists (req 'end')
   * call cb->fn(cb) directly, payload lists call the fn stored beside the
   * registration — both routes land on the same handler here. */
  ScrClosure *cb = scr_closure_new(fn, 1);
  ScrBox *box = scr_box_new_obj(&fx_retain_v, &fx_release_v, NULL);
  scr_box_set_ref(box, fx_retain(t));
  cb->caps[0] = box;
  return cb;
}

/* +1 — release after use. */
static FxTransfer *fx_from(ScrClosure *cb) { return (FxTransfer *)scr_box_get_ref(cb->caps[0]); }

/* ── URL helpers ─────────────────────────────────────────────────────── */

/* scheme://[userinfo@]host[:port]path[?query][#fragment] — response.url
 * and the proxy's absolute-URI form exclude the fragment (Node). */
static ScrStr *fx_url_serialize(const ScrUrl *u, bool with_fragment) {
  size_t cap = u->scheme->len + u->userinfo->len + u->host->len + u->port->len +
               u->path->len + u->query->len + u->fragment->len + 8;
  char *buf = malloc(cap);
  if (!buf) fx_oom();
  size_t n = 0;
  memcpy(buf + n, u->scheme->data, u->scheme->len);
  n += u->scheme->len;
  buf[n++] = ':';
  if (u->has_authority) {
    buf[n++] = '/';
    buf[n++] = '/';
    if (u->userinfo->len > 0) {
      memcpy(buf + n, u->userinfo->data, u->userinfo->len);
      n += u->userinfo->len;
      buf[n++] = '@';
    }
    memcpy(buf + n, u->host->data, u->host->len);
    n += u->host->len;
    if (u->port->len > 0) {
      buf[n++] = ':';
      memcpy(buf + n, u->port->data, u->port->len);
      n += u->port->len;
    }
  }
  if (u->path->len > 0) {
    memcpy(buf + n, u->path->data, u->path->len);
    n += u->path->len;
  } else {
    buf[n++] = '/';
  }
  memcpy(buf + n, u->query->data, u->query->len);
  n += u->query->len;
  if (with_fragment) {
    memcpy(buf + n, u->fragment->data, u->fragment->len);
    n += u->fragment->len;
  }
  ScrStr *out = scr_str_new(buf, n);
  free(buf);
  return out;
}

/* Parse an absolute URL, answering NULL (static exception CLEARED) instead
 * of throwing — this unit runs inside engine host calls and the net
 * dispatch, where a pending static exception belongs to nobody. */
static ScrUrl *fx_url_parse(ScrStr *s) {
  ScrUrl *u = scr_url_new(s);
  if (!u) scr_exc_clear();
  return u;
}

/* Resolve a Location header against the current hop's URL. Handles the
 * absolute form plus the relative shapes real servers send (//authority,
 * /rooted, ?query, plain relative); everything reparses through the
 * WHATWG parser so dot segments and encoding normalize consistently. */
static ScrUrl *fx_resolve(const ScrUrl *base, const ScrStr *loc) {
  ScrStr *abs_try = scr_str_new(loc->data, loc->len);
  ScrUrl *u = fx_url_parse(abs_try);
  scr_str_release(abs_try);
  if (u) return u;
  /* relative: assemble scheme://authority + resolved path/query */
  size_t cap = base->scheme->len + base->userinfo->len + base->host->len + base->port->len +
               base->path->len + base->query->len + loc->len + 16;
  char *buf = malloc(cap);
  if (!buf) fx_oom();
  size_t n = 0;
  memcpy(buf + n, base->scheme->data, base->scheme->len);
  n += base->scheme->len;
  buf[n++] = ':';
  if (loc->len >= 2 && loc->data[0] == '/' && loc->data[1] == '/') {
    memcpy(buf + n, loc->data, loc->len);
    n += loc->len;
  } else {
    buf[n++] = '/';
    buf[n++] = '/';
    if (base->userinfo->len > 0) {
      memcpy(buf + n, base->userinfo->data, base->userinfo->len);
      n += base->userinfo->len;
      buf[n++] = '@';
    }
    memcpy(buf + n, base->host->data, base->host->len);
    n += base->host->len;
    if (base->port->len > 0) {
      buf[n++] = ':';
      memcpy(buf + n, base->port->data, base->port->len);
      n += base->port->len;
    }
    if (loc->len > 0 && loc->data[0] == '/') {
      memcpy(buf + n, loc->data, loc->len);
      n += loc->len;
    } else if (loc->len > 0 && loc->data[0] == '?') {
      memcpy(buf + n, base->path->data, base->path->len);
      n += base->path->len;
      memcpy(buf + n, loc->data, loc->len);
      n += loc->len;
    } else {
      /* plain relative: replace everything after the path's last '/' */
      size_t keep = 0;
      for (size_t i = 0; i < base->path->len; i++) {
        if (base->path->data[i] == '/') keep = i + 1;
      }
      memcpy(buf + n, base->path->data, keep);
      n += keep;
      if (keep == 0) buf[n++] = '/';
      memcpy(buf + n, loc->data, loc->len);
      n += loc->len;
    }
  }
  ScrStr *s = scr_str_new(buf, n);
  free(buf);
  ScrUrl *out = fx_url_parse(s);
  scr_str_release(s);
  return out;
}

/* The URL host with IPv6 brackets stripped (the dial/SNI form). +1. */
static ScrStr *fx_bare_host(const ScrStr *host) {
  if (host->len >= 2 && host->data[0] == '[' && host->data[host->len - 1] == ']') {
    return scr_str_new(host->data + 1, host->len - 2);
  }
  return scr_str_retain((ScrStr *)host);
}

static int fx_url_port(const ScrUrl *u, int deflt) {
  if (u->port->len == 0) return deflt;
  int p = 0;
  for (size_t i = 0; i < u->port->len; i++) p = p * 10 + (u->port->data[i] - '0');
  return p;
}

/* ── env proxy (NODE_USE_ENV_PROXY=1, undici's EnvHttpProxyAgent) ────── */

static const char *fx_env2(const char *lower, const char *upper) {
  const char *v = getenv(lower);
  if (v == NULL || v[0] == '\0') v = getenv(upper);
  return (v != NULL && v[0] != '\0') ? v : NULL;
}

/* no_proxy: comma/space-separated host suffixes; "*" excludes everything;
 * a leading dot is stripped; entries match the host exactly or at a dot
 * boundary. Port qualifiers (host:port) require the port to match. */
static bool fx_no_proxy_match(const char *list, const ScrStr *host, int port) {
  const char *p = list;
  while (*p) {
    while (*p == ',' || *p == ' ' || *p == '\t') p++;
    const char *start = p;
    while (*p && *p != ',' && *p != ' ' && *p != '\t') p++;
    size_t len = (size_t)(p - start);
    if (len == 0) continue;
    if (len == 1 && start[0] == '*') return true;
    /* split a :port qualifier */
    size_t hlen = len;
    long eport = -1;
    for (size_t i = 0; i < len; i++) {
      if (start[i] == ':') {
        hlen = i;
        eport = strtol(start + i + 1, NULL, 10);
        break;
      }
    }
    if (hlen > 0 && start[0] == '.') {
      start++;
      hlen--;
    }
    if (hlen == 0) continue;
    if (eport >= 0 && eport != port) continue;
    if (host->len == hlen) {
      bool eq = true;
      for (size_t i = 0; i < hlen && eq; i++) {
        char a = host->data[i], b = start[i];
        if (a >= 'A' && a <= 'Z') a = (char)(a - 'A' + 'a');
        if (b >= 'A' && b <= 'Z') b = (char)(b - 'A' + 'a');
        eq = a == b;
      }
      if (eq) return true;
    } else if (host->len > hlen && host->data[host->len - hlen - 1] == '.') {
      bool eq = true;
      for (size_t i = 0; i < hlen && eq; i++) {
        char a = host->data[host->len - hlen + i], b = start[i];
        if (a >= 'A' && a <= 'Z') a = (char)(a - 'A' + 'a');
        if (b >= 'A' && b <= 'Z') b = (char)(b - 'A' + 'a');
        eq = a == b;
      }
      if (eq) return true;
    }
  }
  return false;
}

/* The proxy for this hop's target, parsed (+1), or NULL for direct. */
static ScrUrl *fx_proxy_for(const ScrUrl *target, bool https, int target_port) {
  const char *optin = getenv("NODE_USE_ENV_PROXY");
  if (optin == NULL || strcmp(optin, "1") != 0) return NULL;
  const char *proxy = https ? fx_env2("https_proxy", "HTTPS_PROXY")
                            : fx_env2("http_proxy", "HTTP_PROXY");
  if (proxy == NULL) return NULL;
  const char *no = fx_env2("no_proxy", "NO_PROXY");
  if (no != NULL && fx_no_proxy_match(no, target->host, target_port)) return NULL;
  ScrStr *ps = scr_str_new(proxy, strlen(proxy));
  ScrUrl *u = fx_url_parse(ps);
  scr_str_release(ps);
  return u;
}

/* ── DNS (the dns.lookup precedent: getaddrinfo at hop start) ────────── */

/* The address to DIAL for `host` (+1): brackets strip, then the shared
 * blocking lookup (scr_net.c) — IP literals and localhost pass through,
 * hostnames resolve first-answer, and resolution failure answers the
 * HOSTNAME unchanged so the dial's deferred "getaddrinfo ENOTFOUND host"
 * error is Node's exact cause. */
static ScrStr *fx_dial_host(const ScrStr *host) {
  ScrStr *bare = fx_bare_host(host);
  ScrStr *out = scr_net_blocking_lookup(bare);
  scr_str_release(bare);
  return out;
}

/* ── the hop ─────────────────────────────────────────────────────────── */

static void fx_on_response(ScrClosure *cb, ScrHttpReq *res /*+1*/);
static void fx_on_client_error(ScrClosure *cb, ScrStr *msg /*borrowed*/);

static void fx_start_hop(FxTransfer *t) {
  ScrUrl *u = t->url;
  bool https = fx_str_is(u->scheme, "https");
  int default_port = https ? 443 : 80;
  int port = fx_url_port(u, default_port);
  ScrUrl *proxy = https ? NULL : fx_proxy_for(u, https, port);

  /* undici's request head, in undici's order: host, connection, the user
   * headers, then the fetch defaults for whatever the user left unset. */
  size_t nuser = (size_t)scr_arr_len(t->headers);
  ScrArr *pairs = scr_arr_new(SCR_ELEM_STR, nuser + 16);
  if (!fx_pairs_have(t->headers, "host")) {
    char authority[300];
    int alen;
    if (port != default_port) {
      alen = snprintf(authority, sizeof authority, "%.*s:%d", (int)u->host->len, u->host->data, port);
    } else {
      alen = snprintf(authority, sizeof authority, "%.*s", (int)u->host->len, u->host->data);
    }
    fx_pairs_push(pairs, "host", authority, (size_t)alen);
  }
  if (!fx_pairs_have(t->headers, "connection")) {
    fx_pairs_push(pairs, "connection", "keep-alive", 10);
  }
  for (size_t i = 0; i + 1 < nuser; i += 2) {
    scr_arr_push_ref(pairs, scr_arr_get_ref(t->headers, (double)i));
    scr_arr_push_ref(pairs, scr_arr_get_ref(t->headers, (double)(i + 1)));
  }
  if (!fx_pairs_have(t->headers, "accept")) fx_pairs_push(pairs, "accept", "*/*", 3);
  if (!fx_pairs_have(t->headers, "accept-language")) fx_pairs_push(pairs, "accept-language", "*", 1);
  if (!fx_pairs_have(t->headers, "sec-fetch-mode")) fx_pairs_push(pairs, "sec-fetch-mode", "cors", 4);
  if (!fx_pairs_have(t->headers, "user-agent")) fx_pairs_push(pairs, "user-agent", "node", 4);
  if (!fx_pairs_have(t->headers, "accept-encoding")) {
    fx_pairs_push(pairs, "accept-encoding", "gzip, deflate", 13);
  }

  /* the request-target and the wire to dial */
  ScrStr *path;
  ScrStr *dial;
  int dial_port;
  if (proxy != NULL) {
    path = fx_url_serialize(u, false); /* absolute-URI through the proxy */
    dial = fx_dial_host(proxy->host);
    dial_port = fx_url_port(proxy, 80);
  } else {
    if (u->query->len > 0) {
      size_t plen = (u->path->len > 0 ? u->path->len : 1) + u->query->len;
      char *pb = malloc(plen);
      if (!pb) fx_oom();
      size_t n = 0;
      if (u->path->len > 0) {
        memcpy(pb, u->path->data, u->path->len);
        n = u->path->len;
      } else {
        pb[n++] = '/';
      }
      memcpy(pb + n, u->query->data, u->query->len);
      n += u->query->len;
      path = scr_str_new(pb, n);
      free(pb);
    } else {
      path = u->path->len > 0 ? scr_str_retain(u->path) : scr_str_new("/", 1);
    }
    dial = fx_dial_host(u->host);
    dial_port = port;
  }

  ScrHttpClientReq *c;
  if (https) {
    ScrStr *sni = fx_bare_host(u->host);
    void *cli = scr_tls_fetch_client_ctx(sni, true);
    scr_str_release(sni);
    c = scr_http_request_ex(dial, dial_port, path, t->method, 0, pairs, false, NULL, NULL,
                             443, &scr_tls_fetch_client_wrap, cli);
  } else {
    c = scr_http_request_ex(dial, dial_port, path, t->method, 0, pairs, false, NULL, NULL,
                             80, NULL, NULL);
  }
  scr_str_release(dial);
  scr_str_release(path);
  scr_arr_release(pairs);
  if (proxy) scr_url_release(proxy);

  t->client = c; /* the constructor's +1 */
  scr_http_client_on_response(c, fx_closure(t, (void *)&fx_on_response), &fx_on_response, true);
  scr_http_client_on_error(c, fx_closure(t, (void *)&fx_on_client_error), &fx_on_client_error, false);
  if (t->body != NULL) scr_http_client_end_bytes(c, t->body);
  else scr_http_client_end(c);
}

/* ── redirects ───────────────────────────────────────────────────────── */

static void fx_strip_header(ScrArr **headers, const char *name) {
  ScrArr *old = *headers;
  size_t n = (size_t)scr_arr_len(old);
  ScrArr *out = scr_arr_new(SCR_ELEM_STR, n);
  for (size_t i = 0; i + 1 < n; i += 2) {
    ScrStr *nm = (ScrStr *)scr_arr_get_ref(old, (double)i);
    if (fx_eq_ci(nm->data, nm->len, name)) {
      scr_str_release(nm);
      continue;
    }
    scr_arr_push_ref(out, nm);
    scr_arr_push_ref(out, scr_arr_get_ref(old, (double)(i + 1)));
  }
  scr_arr_release(old);
  *headers = out;
}

/* Follows one redirect hop: rewrites the request per the fetch spec and
 * dials the next URL. Consumes nothing; the caller drops res/client. */
static bool fx_redirect(FxTransfer *t, int status, const ScrStr *loc) {
  if (t->hops >= 20) {
    fx_error(t, "redirect count exceeded", NULL);
    return false;
  }
  t->hops++;
  t->redirected = true;
  ScrUrl *next = fx_resolve(t->url, loc);
  if (next == NULL ||
      !(fx_str_is(next->scheme, "http") || fx_str_is(next->scheme, "https"))) {
    if (next) scr_url_release(next);
    fx_error(t, "invalid redirect URL", NULL);
    return false;
  }
  /* 303 rewrites everything but GET/HEAD to GET; 301/302 rewrite POST —
   * the body and its content-* headers drop with the rewrite. */
  bool is_get = fx_str_is(t->method, "GET");
  bool is_head = fx_str_is(t->method, "HEAD");
  if ((status == 303 && !is_get && !is_head) ||
      ((status == 301 || status == 302) && fx_str_is(t->method, "POST"))) {
    scr_str_release(t->method);
    t->method = scr_str_new("GET", 3);
    if (t->body) {
      scr_bytes_release(t->body);
      t->body = NULL;
    }
    fx_strip_header(&t->headers, "content-type");
    fx_strip_header(&t->headers, "content-length");
    fx_strip_header(&t->headers, "content-encoding");
    fx_strip_header(&t->headers, "content-language");
    fx_strip_header(&t->headers, "content-location");
  }
  /* cross-origin hop: credentials do not follow (the fetch spec's
   * authorization rule; cookies are not modeled as ambient state). */
  bool same_origin = t->url->host->len == next->host->len &&
                     memcmp(t->url->host->data, next->host->data, next->host->len) == 0 &&
                     fx_url_port(t->url, 0) == fx_url_port(next, 0) &&
                     t->url->scheme->len == next->scheme->len &&
                     memcmp(t->url->scheme->data, next->scheme->data, next->scheme->len) == 0;
  if (!same_origin) {
    fx_strip_header(&t->headers, "authorization");
    fx_strip_header(&t->headers, "proxy-authorization");
    fx_strip_header(&t->headers, "cookie");
  }
  scr_url_release(t->url);
  t->url = next;
  return true;
}

/* ── response delivery ───────────────────────────────────────────────── */

static void fx_emit_chunk(FxTransfer *t, const uint8_t *data, size_t len) {
  if (len == 0) return;
  JSValue chunk = JS_NewUint8ArrayCopy(t->ctx, data, len);
  fx_call(t, "onData", 1, (JSValueConst *)&chunk);
  JS_FreeValue(t->ctx, chunk);
}

static void fx_on_data(ScrClosure *cb, ScrBytes *chunk /*borrowed*/) {
  FxTransfer *t = fx_from(cb);
  if (t == NULL) return;
  if (t->done || t->cancelled || !t->responded) {
    fx_release(t);
    return;
  }
  if (!t->inflating) {
    fx_emit_chunk(t, chunk->data, chunk->len);
    fx_release(t);
    return;
  }
  t->zs.next_in = (Bytef *)chunk->data;
  t->zs.avail_in = (uInt)chunk->len;
  unsigned char out[16384];
  while (t->zs.avail_in > 0 && !t->done) {
    t->zs.next_out = out;
    t->zs.avail_out = sizeof out;
    int r = inflate(&t->zs, Z_NO_FLUSH);
    size_t produced = sizeof out - t->zs.avail_out;
    if (produced > 0) fx_emit_chunk(t, out, produced);
    if (r == Z_STREAM_END) break; /* trailing bytes (if any) are dropped */
    if (r != Z_OK && r != Z_BUF_ERROR) {
      /* corrupt encoding: the body errors (the glue turns a post-resolve
       * onError into controller.error — undici's terminated shape) */
      const char *detail = t->zs.msg ? t->zs.msg : "invalid compressed body";
      ScrHttpClientReq *c = t->client;
      if (c) scr_http_client_destroy(c);
      fx_error(t, detail, NULL);
      break;
    }
    if (r == Z_BUF_ERROR && produced == 0) break; /* need more input */
  }
  fx_release(t);
}

static void fx_on_end(ScrClosure *cb) {
  FxTransfer *t = fx_from(cb);
  if (t == NULL) return;
  if (t->done || t->cancelled) {
    fx_release(t);
    return;
  }
  fx_call(t, "onEnd", 0, NULL);
  fx_settle(t);
  fx_release(t);
}

/* Mid-body death ('aborted' on the response): the body errors. */
static void fx_on_res_error(ScrClosure *cb, ScrStr *msg /*borrowed*/) {
  FxTransfer *t = fx_from(cb);
  if (t == NULL) return;
  if (t->done || t->cancelled) {
    fx_release(t);
    return;
  }
  fx_error(t, msg->len > 0 ? msg->data : "aborted", NULL);
  fx_release(t);
}

static void fx_on_response(ScrClosure *cb, ScrHttpReq *res /*+1*/) {
  FxTransfer *t = fx_from(cb);
  if (t == NULL) {
    scr_http_req_release(res);
    return;
  }
  if (t->done || t->cancelled) {
    scr_http_req_release(res);
    fx_release(t);
    return;
  }
  int status = (int)scr_http_req_status(res);

  /* a redirect hop? (Location present, a redirect status) */
  if (status == 301 || status == 302 || status == 303 || status == 307 || status == 308) {
    ScrStr *locname = scr_str_new("location", 8);
    ScrStr *loc = scr_http_req_header(res, locname);
    scr_str_release(locname);
    if (loc != NULL) {
      /* drop this hop's connection (its body never reaches the island) */
      ScrHttpClientReq *old = t->client;
      t->client = NULL;
      bool go = fx_redirect(t, status, loc);
      scr_str_release(loc);
      if (old) {
        scr_http_client_destroy(old);
        scr_http_client_release(old);
      }
      if (go) fx_start_hop(t);
      scr_http_req_release(res);
      fx_release(t);
      return;
    }
    /* a FINAL 3xx (no Location) resolves with its own body, like Node —
     * the curl bridge documented this corner away; this unit delivers it */
  }

  t->responded = true;

  /* content-encoding: gzip/x-gzip/deflate inflate transparently (zlib's
   * 15+32 auto-detects the gzip and zlib framings) */
  {
    ScrStr *cename = scr_str_new("content-encoding", 16);
    ScrStr *ce = scr_http_req_header(res, cename);
    scr_str_release(cename);
    if (ce != NULL) {
      if (fx_str_is(ce, "gzip") || fx_str_is(ce, "x-gzip") || fx_str_is(ce, "deflate")) {
        memset(&t->zs, 0, sizeof t->zs);
        if (inflateInit2(&t->zs, 15 + 32) == Z_OK) t->inflating = true;
      }
      scr_str_release(ce);
    }
  }

  JSContext *ctx = t->ctx;
  ScrArr *raw = scr_http_req_raw_headers(res);
  size_t nraw = (size_t)scr_arr_len(raw);
  JSValue hdrs = JS_NewArray(ctx);
  for (size_t i = 0; i < nraw; i++) {
    ScrStr *s = (ScrStr *)scr_arr_get_ref(raw, (double)i);
    JS_SetPropertyUint32(ctx, hdrs, (uint32_t)i, JS_NewStringLen(ctx, s->data, s->len));
    scr_str_release(s);
  }
  scr_arr_release(raw);
  ScrStr *stext = scr_http_req_status_message(res);
  ScrStr *final_url = fx_url_serialize(t->url, false);
  JSValue argv[5] = {
      JS_NewInt32(ctx, status),
      JS_NewStringLen(ctx, stext ? stext->data : "", stext ? stext->len : 0),
      hdrs,
      JS_NewStringLen(ctx, final_url->data, final_url->len),
      JS_NewBool(ctx, t->redirected),
  };
  if (stext) scr_str_release(stext);
  scr_str_release(final_url);
  fx_call(t, "onResponse", 5, argv);
  for (int i = 0; i < 5; i++) JS_FreeValue(ctx, argv[i]);

  /* body listeners (registered inside the 'response' emit — the parser
   * delivers body bytes only after this returns, ended bodies fire 'end'
   * right behind us) */
  scr_http_req_on_data(res, fx_closure(t, (void *)&fx_on_data), &fx_on_data, false);
  scr_http_req_on_end(res, fx_closure(t, (void *)&fx_on_end), false);
  scr_http_req_on_error(res, fx_closure(t, (void *)&fx_on_res_error), &fx_on_res_error, false);

  scr_http_req_release(res);
  fx_release(t);
}

/* Pre-response failure on the hop client: classify into Node's causes. */
static void fx_on_client_error(ScrClosure *cb, ScrStr *msg /*borrowed*/) {
  FxTransfer *t = fx_from(cb);
  if (t == NULL) return;
  if (t->done || t->cancelled || t->responded) {
    fx_release(t);
    return;
  }
  const char *detail = msg->data;
  const char *code = NULL;
  char codebuf[32];
  if (msg->len > 8 && memcmp(detail, "connect E", 9) == 0) {
    /* "connect ECONNREFUSED ip:port" and family: the code is the token */
    const char *s = detail + 8;
    size_t n = 0;
    while (s[n] != '\0' && s[n] != ' ' && n < sizeof codebuf - 1) n++;
    memcpy(codebuf, s, n);
    codebuf[n] = '\0';
    code = codebuf;
  } else if (msg->len > 12 && memcmp(detail, "getaddrinfo E", 13) == 0) {
    const char *s = detail + 12;
    size_t n = 0;
    while (s[n] != '\0' && s[n] != ' ' && n < sizeof codebuf - 1) n++;
    memcpy(codebuf, s, n);
    codebuf[n] = '\0';
    code = codebuf;
  } else if (fx_eq_ci(detail, msg->len, "socket hang up")) {
    /* undici's cause for a server that died before the response head */
    detail = "other side closed";
    code = "UND_ERR_SOCKET";
  }
  fx_error(t, detail, code);
  fx_release(t);
}

/* ── host functions (called by the fetch glue, inside the engine) ────── */

/* host.start({url, method, headers: [n,v,...], body: Uint8Array|undefined},
 * cbs) → transfer id. Everything is copied out of the engine before the
 * net stack sees it. An unparsable URL throws the engine TypeError the
 * promise executor turns into Node's rejection shape. */
static JSValue fx_host_start(JSContext *ctx, JSValueConst this_val, int argc,
                             JSValueConst *argv) {
  (void)this_val;
  (void)argc;
  JSValueConst req = argv[0];

  JSValue urlv = JS_GetPropertyStr(ctx, req, "url");
  const char *url = JS_ToCString(ctx, urlv);
  JS_FreeValue(ctx, urlv);
  if (!url) return JS_EXCEPTION;
  ScrStr *urlstr = scr_str_new(url, strlen(url));
  ScrUrl *u = fx_url_parse(urlstr);
  scr_str_release(urlstr);
  if (u == NULL) {
    JSValue e = JS_ThrowTypeError(ctx, "Failed to parse URL from %s", url);
    JS_FreeCString(ctx, url);
    return e;
  }
  JS_FreeCString(ctx, url);
  if (!(fx_str_is(u->scheme, "http") || fx_str_is(u->scheme, "https"))) {
    scr_url_release(u);
    return JS_ThrowTypeError(ctx, "fetch failed");
  }

  FxTransfer *t = calloc(1, sizeof *t);
  if (!t) fx_oom();
  t->rc = 1; /* the registry's */
  t->ctx = ctx;
  t->id = fx_next_id++;
  t->cbs = JS_DupValue(ctx, argv[1]);
  t->cbs_live = true;
  t->url = u;

  JSValue methodv = JS_GetPropertyStr(ctx, req, "method");
  const char *method = JS_ToCString(ctx, methodv);
  JS_FreeValue(ctx, methodv);
  t->method = scr_str_new(method ? method : "GET", method ? strlen(method) : 3);
  if (method) JS_FreeCString(ctx, method);

  JSValue hdrs = JS_GetPropertyStr(ctx, req, "headers");
  JSValue lenv = JS_GetPropertyStr(ctx, hdrs, "length");
  uint32_t hn = 0;
  JS_ToUint32(ctx, &hn, lenv);
  JS_FreeValue(ctx, lenv);
  t->headers = scr_arr_new(SCR_ELEM_STR, hn);
  for (uint32_t i = 0; i + 1 < hn; i += 2) {
    JSValue nv = JS_GetPropertyUint32(ctx, hdrs, i);
    JSValue vv = JS_GetPropertyUint32(ctx, hdrs, i + 1);
    size_t nlen = 0, vlen = 0;
    const char *hname = JS_ToCStringLen(ctx, &nlen, nv);
    const char *hvalue = JS_ToCStringLen(ctx, &vlen, vv);
    if (hname && hvalue) {
      scr_arr_push_ref(t->headers, scr_str_new(hname, nlen));
      scr_arr_push_ref(t->headers, scr_str_new(hvalue, vlen));
    }
    if (hname) JS_FreeCString(ctx, hname);
    if (hvalue) JS_FreeCString(ctx, hvalue);
    JS_FreeValue(ctx, nv);
    JS_FreeValue(ctx, vv);
  }
  JS_FreeValue(ctx, hdrs);

  JSValue bodyv = JS_GetPropertyStr(ctx, req, "body");
  if (!JS_IsUndefined(bodyv) && !JS_IsNull(bodyv)) {
    size_t blen = 0;
    uint8_t *bytes = JS_GetUint8Array(ctx, &blen, bodyv);
    if (bytes != NULL || blen == 0) {
      t->body = scr_bytes_new(SCR_BYTES_U8, (double)blen);
      if (blen > 0) memcpy(t->body->data, bytes, blen);
    }
  }
  JS_FreeValue(ctx, bodyv);

  t->next = fx_live;
  fx_live = t;
  fx_nlive++;
  fx_start_hop(t);
  return JS_NewInt32(ctx, t->id);
}

/* host.abort(id): the island aborted the fetch or cancelled the response
 * body stream. The transfer dies quietly — no onError, no onEnd. */
static JSValue fx_host_abort(JSContext *ctx, JSValueConst this_val, int argc,
                             JSValueConst *argv) {
  (void)this_val;
  (void)argc;
  int32_t id = 0;
  JS_ToInt32(ctx, &id, argv[0]);
  for (FxTransfer *t = fx_live; t; t = t->next) {
    if (t->id == id) {
      t->cancelled = true;
      if (t->client) scr_http_client_destroy(t->client);
      fx_settle(t);
      break;
    }
  }
  return JS_UNDEFINED;
}

/* ── the JS half (UNCHANGED from the curl bridge — the island surface,
 * abort wiring, and error shaping are the contract the fixture suite
 * pins) ──────────────────────────────────────────────────────────────── */

static const char fx_glue[] =
    "(host) => {\n"
    "  'use strict';\n"
    "  const g = globalThis;\n"
    "  const NULL_BODY = { 204: true, 205: true, 304: true };\n"
    "  g.fetch = function fetch(input, init) {\n"
    "    return new Promise((resolve, reject) => {\n"
    "      let url;\n"
    "      let method = 'GET';\n"
    "      let headers = null;\n"
    "      let body = null;\n"
    "      let signal = null;\n"
    "      if (input instanceof g.Request) {\n"
    "        url = input.url;\n"
    "        method = input.method;\n"
    "        headers = new g.Headers(input.headers);\n"
    "        body = host.web.requestBody(input);\n"
    "        signal = host.web.requestSignal(input);\n"
    "      } else {\n"
    "        url = String(input);\n"
    "      }\n"
    "      init = init === undefined || init === null ? {} : init;\n"
    "      // An explicit init.signal overrides the Request's, null included.\n"
    "      if (init.signal !== undefined) {\n"
    "        if (init.signal !== null && !(init.signal instanceof g.AbortSignal)) {\n"
    "          throw new TypeError('fetch init.signal must be an AbortSignal or null');\n"
    "        }\n"
    "        signal = init.signal;\n"
    "      }\n"
    "      if (init.redirect !== undefined && init.redirect !== 'follow') {\n"
    "        throw new Error(\"scriptc: only redirect: 'follow' is supported by the embedded fetch\");\n"
    "      }\n"
    "      // Reuse Request's init handling: method normalization, header\n"
    "      // collection, body coercion with its implicit content-type, and the\n"
    "      // GET/HEAD-with-body TypeError.\n"
    "      const reqInit = {};\n"
    "      if (init.method !== undefined) reqInit.method = init.method;\n"
    "      if (init.headers !== undefined) reqInit.headers = init.headers;\n"
    "      if (init.body !== undefined && init.body !== null) reqInit.body = init.body;\n"
    "      if (reqInit.method !== undefined || reqInit.headers !== undefined || reqInit.body !== undefined || headers === null) {\n"
    "        const base = input instanceof g.Request ? input : url;\n"
    "        const r = new g.Request(base, reqInit);\n"
    "        method = r.method;\n"
    "        headers = r.headers;\n"
    "        if (host.web.requestBody(r) !== null) body = host.web.requestBody(r);\n"
    "      }\n"
    "      if (body !== null && !(body instanceof Uint8Array)) {\n"
    "        throw new TypeError('streaming request bodies are not supported in the scriptc island');\n"
    "      }\n"
    "      // An already-aborted signal rejects with ITS reason before any\n"
    "      // transfer starts (Node: validation above still throws first).\n"
    "      if (signal !== null && signal.aborted) {\n"
    "        reject(signal.reason);\n"
    "        return;\n"
    "      }\n"
    "      let controller = null;\n"
    "      let resolved = false;\n"
    "      let done = false;\n"
    "      let id = 0;\n"
    "      // The transfer is over (delivered, failed, cancelled, or aborted):\n"
    "      // a later signal abort must not touch it.\n"
    "      const finish = () => {\n"
    "        done = true;\n"
    "        if (signal !== null) signal.removeEventListener('abort', onAbort);\n"
    "      };\n"
    "      const onAbort = () => {\n"
    "        if (done) return;\n"
    "        finish();\n"
    "        host.abort(id); // the C side dies quietly; rejection is ours\n"
    "        if (!resolved) {\n"
    "          resolved = true;\n"
    "          reject(signal.reason);\n"
    "        } else if (controller !== null) {\n"
    "          // Mid-stream: pending and future reads reject with the reason,\n"
    "          // exactly Node's aborted-body behavior.\n"
    "          try { controller.error(signal.reason); } catch (_e) { /* already closed */ }\n"
    "          controller = null;\n"
    "        }\n"
    "      };\n"
    "      const flat = [];\n"
    "      for (const pair of headers) { flat.push(pair[0], pair[1]); }\n"
    "      id = host.start(\n"
    "        { url, method, headers: flat, body: body === null ? undefined : body },\n"
    "        {\n"
    "          onResponse(status, statusText, raw, finalUrl, redirected) {\n"
    "            resolved = true;\n"
    "            const h = new g.Headers();\n"
    "            for (let i = 0; i + 1 < raw.length; i += 2) {\n"
    "              try { h.append(raw[i], raw[i + 1]); } catch (_e) { /* junk line */ }\n"
    "            }\n"
    "            let stream = null;\n"
    "            if (method !== 'HEAD' && NULL_BODY[status] !== true) {\n"
    "              stream = new g.ReadableStream({\n"
    "                start(c) { controller = c; },\n"
    "                cancel() { controller = null; finish(); host.abort(id); },\n"
    "              });\n"
    "            }\n"
    "            resolve(host.web.mkResponse(status, statusText, h, finalUrl, redirected, stream));\n"
    "          },\n"
    "          onData(chunk) {\n"
    "            if (controller !== null) {\n"
    "              try { controller.enqueue(chunk); } catch (_e) { /* consumer went away */ }\n"
    "            }\n"
    "          },\n"
    "          onEnd() {\n"
    "            finish();\n"
    "            if (controller !== null) {\n"
    "              try { controller.close(); } catch (_e) { /* already errored */ }\n"
    "              controller = null;\n"
    "            }\n"
    "          },\n"
    "          onError(detail, code) {\n"
    "            finish();\n"
    "            if (!resolved) {\n"
    "              // Node's shape: TypeError 'fetch failed' with a CAUSE the\n"
    "              // wrappers classify (message + code for the network cases).\n"
    "              const cause = new Error(String(detail));\n"
    "              if (code !== undefined) cause.code = code;\n"
    "              if (code === 'ECONNREFUSED') cause.syscall = 'connect';\n"
    "              else if (code === 'ENOTFOUND') cause.syscall = 'getaddrinfo';\n"
    "              const err = new TypeError('fetch failed');\n"
    "              err.cause = cause;\n"
    "              reject(err);\n"
    "            } else if (controller !== null) {\n"
    "              try { controller.error(new TypeError('terminated')); } catch (_e) { /* already closed */ }\n"
    "              controller = null;\n"
    "            }\n"
    "          },\n"
    "        },\n"
    "      );\n"
    "      if (signal !== null) signal.addEventListener('abort', onAbort, { once: true });\n"
    "    });\n"
    "  };\n"
    "}\n";

/* ── boot / teardown (registered with the island) ────────────────────── */

/* scr_web.c: the web prelude's internals object (owned reference). */
JSValue scr_island_web_internals(void *jsctx);

static void fx_boot(void *jsctx) {
  JSContext *ctx = (JSContext *)jsctx;
  JSValue fn = JS_Eval(ctx, fx_glue, sizeof fx_glue - 1, "<scr-fetch>", JS_EVAL_TYPE_GLOBAL);
  if (JS_IsException(fn)) {
    fprintf(stderr, "scriptc: island fetch glue failed to evaluate\n");
    abort();
  }
  JSValue host = JS_NewObject(ctx);
  JS_SetPropertyStr(ctx, host, "start", JS_NewCFunction(ctx, fx_host_start, "start", 2));
  JS_SetPropertyStr(ctx, host, "abort", JS_NewCFunction(ctx, fx_host_abort, "abort", 1));
  /* The web prelude's internals: mkResponse builds wire responses. */
  JS_SetPropertyStr(ctx, host, "web", scr_island_web_internals(ctx));
  JSValue r = JS_Call(ctx, fn, JS_UNDEFINED, 1, (JSValueConst *)&host);
  JS_FreeValue(ctx, host);
  JS_FreeValue(ctx, fn);
  if (JS_IsException(r)) {
    fprintf(stderr, "scriptc: island fetch glue failed to run\n");
    abort();
  }
  JS_FreeValue(ctx, r);
}

/* Engine teardown with transfers still live (process.exit mid-request, or
 * an exit with an abandoned body stream): free their engine values FIRST
 * so the island's counting allocator returns to zero. The net/http exit
 * cleanups (registered later, so they run earlier — atexit LIFO) have
 * already dropped the listener closures; whatever the registry still
 * holds settles here. */
static void fx_teardown(void) {
  while (fx_live) fx_settle(fx_live);
}

/* The emitted main calls this (before any island entry) in builds whose
 * embedded graph references fetch. No pending/poll hooks: transfers live
 * on real sockets the loop's own poller sleeps on, and armed island
 * timers cap that sleep through the loop's island-deadline hook. */
void scr_fetch_install(void) {
  static bool installed = false;
  if (installed) return;
  installed = true;
  /* The net unit's loop hooks (pending/dispatch/pollfd): the emitted main
   * registers them only for programs that USE node:net — a fetch-only
   * build must register them itself or its sockets would neither keep
   * the loop alive nor dispatch. */
  scr_net_install();
  /* The island's node:http/https client bridge rides the same units and
   * is always compiled beside the native fetch (cc.ts) — embedded graphs
   * that require node:http/https get working clients, not refusals. */
  scr_net_island_install();
  scr_island_set_fetch(fx_boot, NULL, NULL, fx_teardown);
}

#endif /* SCR_DYNAMIC */
