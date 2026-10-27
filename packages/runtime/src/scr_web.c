/* Web-platform globals for the dynamic island — native's HOST half. The
 * globals themselves are ONE JavaScript text, scr_web_prelude.js (rendered
 * into the C literal scr_web_prelude.h by scripts/gen-web-prelude.mjs),
 * which the WasmGC tier's engine evaluates too (wasm/isl_core.c); its
 * header comment lists the classes and the host contract, SEMANTICS.md
 * S108 states where they part from Node, and tests/harness/web-globals.
 * test.ts holds them to Node on both lanes. Evaluated once at engine boot
 * (before any embedded module runs — eventsource-parser subclasses
 * TransformStream at module-eval time). Compiled and linked ONLY under
 * -DSCR_DYNAMIC, like scr_island.c.
 *
 * This file implements the host functions the text calls — console's fd
 * write (the real stdio buffers), CSPRNG fills and v4 UUIDs (the SAME
 * arc4random_buf the static crypto lowerings use), the zone name for
 * Date#toString, the setTimeout bridge onto the static timer heap and the
 * unref'd island timers behind AbortSignal.timeout — and keeps the
 * prelude's internals object (mkResponse for scr_fetch.c's glue, uspReset
 * for the island URL class, receiveMessageOnPort for worker_threads). */
#ifdef SCR_DYNAMIC

#include "scr_runtime.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "quickjs.h"

/* The prelude: the shared text (scr_web_prelude.h — the wasm engine
 * embeds the same bytes), called with the host object built below. */
#include "scr_web_prelude.h"

/* ── island timers (AbortSignal.timeout) ──────────────────────────────
 * One-shot engine callbacks on the loop's monotonic clock, armed by the
 * prelude's host.timer(fn, ms). UNREF'd like Node's AbortSignal.timeout
 * timer: an armed timer never keeps the loop alive (it joins neither the
 * exhaustion test nor io-pending unless already DUE); the island's io
 * poll caps its sleeps at the earliest deadline and fires due timers, so
 * a fetch timeout fires on time while the transfer keeps the loop
 * running. Fired on the main stack from the io hook — isl_entry already
 * re-anchored the engine. Unfired callbacks are freed at teardown. */

typedef struct WebTimer {
  double deadline_ms;
  JSContext *ctx;
  JSValue fn; /* owned */
  struct WebTimer *next;
} WebTimer;

static WebTimer *web_timers = NULL;

/* ── the setTimeout/setInterval bridge (the prelude's host.setTimer) ──
 * Entries live on the STATIC timer heap (scr_async.c): ref'd liveness,
 * FIFO ordering against static timers, and clearing all come from there.
 * Each entry's closure captures the engine callback through a SCR_BOX_OBJ
 * whose retain/release manage this little handle. */

typedef struct {
  size_t rc;
  JSContext *ctx;
  JSValue fn; /* owned */
} WebTimerFn;

static void *web_timerfn_retain(void *p) {
  WebTimerFn *h = p;
  h->rc++;
  return p;
}

static void web_timerfn_release(void *p) {
  WebTimerFn *h = p;
  if (--h->rc == 0) {
    JS_FreeValue(h->ctx, h->fn);
    free(h);
  }
}

/* The static-heap closure body: calls the engine callback on the main
 * stack (where the loop fires every timer), then drains the engine jobs
 * it queued (Node runs microtasks right after the macrotask). A throw
 * bridges into the loop's uncaught path, exactly like a static timer
 * callback's throw. */
static void web_timer_fire_cb(ScrClosure *env) {
  WebTimerFn *h = scr_box_get_ref(env->caps[0]); /* +1 */
  JSValue r = JS_Call(h->ctx, h->fn, JS_UNDEFINED, 0, NULL);
  if (JS_IsException(r)) {
    scr_island_bridge_exception();
  } else {
    JS_FreeValue(h->ctx, r);
    scr_island_drain_jobs();
  }
  web_timerfn_release(h);
}

static JSValue web_host_set_timer(JSContext *ctx, JSValueConst this_val,
                                  int argc, JSValueConst *argv) {
  (void)this_val;
  (void)argc;
  double ms = 0;
  if (JS_ToFloat64(ctx, &ms, argv[1])) return JS_EXCEPTION;
  bool repeat = JS_ToBool(ctx, argv[2]) > 0;
  WebTimerFn *h = malloc(sizeof *h);
  if (!h) {
    fprintf(stderr, "scriptc: out of memory\n");
    abort();
  }
  h->rc = 1;
  h->ctx = ctx;
  h->fn = JS_DupValue(ctx, argv[0]);
  ScrBox *box = scr_box_new_obj(web_timerfn_retain, web_timerfn_release, NULL);
  scr_box_set_ref(box, h); /* the box owns the +1 */
  ScrClosure *cb = scr_closure_new((void *)web_timer_fire_cb, 1);
  cb->caps[0] = box;
  double id = repeat ? scr_set_interval(cb, ms) : scr_set_timeout_handle(cb, ms);
  return JS_NewFloat64(ctx, id);
}

static JSValue web_host_clear_timer(JSContext *ctx, JSValueConst this_val,
                                    int argc, JSValueConst *argv) {
  (void)this_val;
  (void)argc;
  double id = 0;
  if (JS_ToFloat64(ctx, &id, argv[0])) return JS_EXCEPTION;
  scr_clear_interval(id);
  return JS_UNDEFINED;
}

static JSValue web_host_timer(JSContext *ctx, JSValueConst this_val, int argc,
                              JSValueConst *argv) {
  (void)this_val;
  (void)argc;
  double ms = 0;
  if (JS_ToFloat64(ctx, &ms, argv[1])) return JS_EXCEPTION;
  if (!(ms >= 0)) ms = 0; /* NaN/negative clamp, like the static setTimeout */
  WebTimer *t = malloc(sizeof *t);
  if (!t) {
    fprintf(stderr, "scriptc: out of memory\n");
    abort();
  }
  t->deadline_ms = scr_now_ms() + ms;
  t->ctx = ctx;
  t->fn = JS_DupValue(ctx, argv[0]);
  t->next = web_timers;
  web_timers = t;
  return JS_UNDEFINED;
}

double scr_island_timers_deadline(void) {
  double best = HUGE_VAL;
  for (WebTimer *t = web_timers; t; t = t->next) {
    if (t->deadline_ms < best) best = t->deadline_ms;
  }
  return best;
}

bool scr_island_timers_due(void) {
  return web_timers != NULL && scr_island_timers_deadline() <= scr_now_ms();
}

/* Fires every due timer (a callback may arm new ones — the scan restarts
 * after each firing, so late arrivals with passed deadlines fire too).
 * A throwing callback is our own glue misbehaving: reported, never fatal,
 * the remaining timers still fire. */
bool scr_island_timers_fire_due(void) {
  bool fired = false;
  double now = scr_now_ms();
  for (;;) {
    WebTimer **link = &web_timers;
    WebTimer *due = NULL;
    while (*link) {
      if ((*link)->deadline_ms <= now) {
        due = *link;
        *link = due->next;
        break;
      }
      link = &(*link)->next;
    }
    if (!due) break;
    JSValue r = JS_Call(due->ctx, due->fn, JS_UNDEFINED, 0, NULL);
    if (JS_IsException(r)) {
      JSValue e = JS_GetException(due->ctx);
      const char *msg = JS_ToCString(due->ctx, e);
      fprintf(stderr, "scriptc: island timer callback threw: %s\n", msg ? msg : "?");
      if (msg) JS_FreeCString(due->ctx, msg);
      JS_FreeValue(due->ctx, e);
    } else {
      JS_FreeValue(due->ctx, r);
    }
    JS_FreeValue(due->ctx, due->fn);
    free(due);
    fired = true;
  }
  return fired;
}

void scr_island_timers_teardown(void) {
  while (web_timers) {
    WebTimer *t = web_timers;
    web_timers = t->next;
    JS_FreeValue(t->ctx, t->fn);
    free(t);
  }
}

/* ── host functions ───────────────────────────────────────────────────
 * The prelude's I/O-free exceptions: randomness (bridged to the SAME
 * arc4random_buf CSPRNG behind the static crypto lowerings — one source
 * of truth), console's fd writes (the real stdio buffers, interleaving
 * correctly with static console.log), and the timer above. Engine
 * ownership rules as ever: argv borrowed, results owned. */

/* host.fill(typedArray): fill the view's bytes with CSPRNG output. The
 * JS side already validated the view kind and the 65536-byte quota. */
static JSValue web_host_fill(JSContext *ctx, JSValueConst this_val, int argc,
                             JSValueConst *argv) {
  (void)this_val;
  (void)argc;
  size_t off = 0, len = 0, bpe = 0;
  JSValue ab = JS_GetTypedArrayBuffer(ctx, argv[0], &off, &len, &bpe);
  if (JS_IsException(ab)) return JS_EXCEPTION;
  size_t absize = 0;
  uint8_t *buf = JS_GetArrayBuffer(ctx, &absize, ab);
  JS_FreeValue(ctx, ab);
  if (!buf) return JS_EXCEPTION;
  if (len > 0) arc4random_buf(buf + off, len);
  return JS_UNDEFINED;
}

static JSValue web_host_uuid(JSContext *ctx, JSValueConst this_val, int argc,
                             JSValueConst *argv) {
  (void)this_val;
  (void)argc;
  (void)argv;
  ScrStr *s = scr_crypto_random_uuid(); /* +1 */
  JSValue r = JS_NewStringLen(ctx, s->data, s->len);
  scr_str_release(s);
  return r;
}

/* Date#toString's timezone-name suffix (the prelude's Date patch;
 * SEMANTICS.md S113). Node prints ICU's long name of the zone for standard
 * or daylight time ("Central Standard Time" / "Central Daylight Time"),
 * deciding which by ICU's DST flag at the instant — after V8 maps an
 * instant before 1970 or past 2^31 seconds to its "equivalent" one
 * (DateCache::LocalTimezone / EquivalentTime: the same month and day in
 * the year of 2008..2035 with the same leap-ness and January 1st weekday).
 * Here the flag is the C library's tm_isdst at that equivalent instant, and
 * scr_zone_names.h (generated from Node by scripts/gen-zone-names.mjs) maps
 * (zone, flag) to Node's name. The zone is ICU's choice (scr_lib.c's
 * scr_tz_resolve). A zone the table does not name gets ICU's fallback for
 * an unknown zone, "GMT±hh:mm" of its offset (Node: TZ=Invalid/Zone prints
 * "(GMT+00:00)"). */
#include "scr_zone_names.h"

static long long web_days_from_civil(long long y, int m, int d) {
  y -= m <= 2;
  long long era = (y >= 0 ? y : y - 399) / 400;
  unsigned long long yoe = (unsigned long long)(y - era * 400);
  unsigned long long doy = (unsigned long long)((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1);
  unsigned long long doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
  return era * 146097 + (long long)doe - 719468;
}

/* V8's DateCache::EquivalentTime for an instant outside [0, kMaxInt s]. */
static double web_equivalent_time(double ms) {
  if (ms >= 0 && ms <= 2147483647000.0) return ms;
  long long days = (long long)floor(ms / 86400000.0);
  double within = ms - (double)days * 86400000.0;
  long long z = days + 719468;
  long long era = (z >= 0 ? z : z - 146096) / 146097;
  unsigned long long doe = (unsigned long long)(z - era * 146097);
  unsigned long long yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
  unsigned long long doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
  unsigned long long mp = (5 * doy + 2) / 153;
  int d = (int)(doy - (153 * mp + 2) / 5 + 1);
  int m = (int)(mp < 10 ? mp + 3 : mp - 9);
  long long y = (long long)yoe + era * 400 + (m <= 2);
  bool leap = y % 4 == 0 && (y % 100 != 0 || y % 400 == 0);
  int week_day = (int)(((web_days_from_civil(y, 1, 1) + 4) % 7 + 7) % 7);
  int recent_year = (leap ? 1956 : 1967) + (week_day * 12) % 28;
  int year = 2008 + (recent_year + 3 * 28 - 2008) % 28;
  return (double)(web_days_from_civil(year, m, 1) + d - 1) * 86400000.0 + within;
}

static int web_zone_cmp(const void *key, const void *elem) {
  return strcmp((const char *)key, ((const ScrZoneName *)elem)->id);
}

/* host.now(): Node's performance.now — milliseconds since the process
 * started, on the monotonic clock (scr_perf_now, the static
 * performance.now's own). Event#timeStamp reads it. */
static JSValue web_host_now(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
  (void)this_val;
  (void)argc;
  (void)argv;
  return JS_NewFloat64(ctx, scr_perf_now());
}

static JSValue web_host_tzname(JSContext *ctx, JSValueConst this_val, int argc,
                               JSValueConst *argv) {
  (void)this_val;
  (void)argc;
  double ms = 0;
  if (JS_ToFloat64(ctx, &ms, argv[0])) return JS_EXCEPTION;
  if (!isfinite(ms)) return JS_NewString(ctx, "");
  const char *id = NULL;
  int mode = scr_tz_zone(&id); /* ICU's choice of zone (scr_lib.c) */
  const ScrZoneName *row =
      mode != 1 ? NULL
                : bsearch(id, scr_zone_names, sizeof scr_zone_names / sizeof scr_zone_names[0],
                          sizeof scr_zone_names[0], web_zone_cmp);
  if (row != NULL) {
    int isdst = scr_tz_isdst(web_equivalent_time(ms));
    return JS_NewString(ctx, scr_zone_name_strs[isdst ? row->dst_name : row->std_name]);
  }
  /* ICU's unknown zone: a fixed zone at the C library's standard offset
   * (scr_tz_offset_ms answers that constant for a fixed zone). */
  long east = (long)(scr_tz_offset_ms(ms) / 1000.0);
  char buf[32];
  long a = east < 0 ? -east : east;
  if (a % 60 != 0) {
    snprintf(buf, sizeof buf, "GMT%c%02ld:%02ld:%02ld", east < 0 ? '-' : '+', a / 3600, a / 60 % 60, a % 60);
  } else {
    snprintf(buf, sizeof buf, "GMT%c%02ld:%02ld", east < 0 ? '-' : '+', a / 3600, a / 60 % 60);
  }
  return JS_NewString(ctx, buf);
}

static JSValue web_host_write(JSContext *ctx, JSValueConst this_val, int argc,
                              JSValueConst *argv) {
  (void)this_val;
  (void)argc;
  int32_t fd = 1;
  JS_ToInt32(ctx, &fd, argv[0]);
  size_t len;
  const char *s = JS_ToCStringLen(ctx, &len, argv[1]);
  if (!s) return JS_EXCEPTION;
  scr_stdio_write(fd, s, len);
  JS_FreeCString(ctx, s);
  return JS_UNDEFINED;
}

/* host.isPromise(v) / host.isProxy(v) / host.proxyTarget(v): the internal-
 * slot checks structuredClone needs and JS cannot make without side
 * effects. The same three live in wasm/isl_core.c. */
static JSValue web_host_is_promise(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
  (void)this_val;
  (void)argc;
  return JS_NewBool(ctx, JS_IsPromise(argv[0]));
}
static JSValue web_host_is_proxy(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
  (void)this_val;
  (void)argc;
  return JS_NewBool(ctx, JS_IsProxy(argv[0]));
}
static JSValue web_host_proxy_target(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
  (void)this_val;
  (void)argc;
  return JS_GetProxyTarget(ctx, argv[0]);
}

/* host.promiseState(p) -> [state, result] (0 pending / 1 fulfilled /
 * 2 rejected; V8's Promise::PromiseState, which util.inspect prints) and
 * host.proxyHandler(v): the inspector's two other internal-slot reads
 * (getPromiseDetails, getProxyDetails). Peeking never marks a rejection
 * handled. The same two live in wasm/isl_core.c. */
static JSValue web_host_promise_state(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
  (void)this_val;
  (void)argc;
  JSPromiseStateEnum st = JS_PromiseState(ctx, argv[0]);
  if ((int)st < 0) return JS_UNDEFINED;
  JSValue arr = JS_NewArray(ctx);
  JS_SetPropertyUint32(ctx, arr, 0, JS_NewInt32(ctx, (int32_t)st));
  JS_SetPropertyUint32(ctx, arr, 1, st == JS_PROMISE_PENDING ? JS_UNDEFINED : JS_PromiseResult(ctx, argv[0]));
  return arr;
}
static JSValue web_host_proxy_handler(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
  (void)this_val;
  (void)argc;
  return JS_GetProxyHandler(ctx, argv[0]);
}

/* host.classId(v): the engine's class of an object (0 for a primitive)
 * — the inspector's brand for Map/Set iterators, arguments objects and
 * module namespaces, which a program can neither fake nor observe being
 * asked; host.moduleNamespaceClassId(): a module namespace's class,
 * from the namespace of an empty module compiled (never run) here,
 * since JavaScript cannot make one without a loader. The same two live in wasm/isl_core.c. */
static JSValue web_host_class_id(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
  (void)this_val;
  (void)argc;
  return JS_NewInt32(ctx, JS_IsObject(argv[0]) ? (int32_t)JS_GetClassID(argv[0]) : 0);
}
static JSValue web_host_module_ns_class_id(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
  (void)this_val;
  (void)argc;
  (void)argv;
  JSValue m = JS_Eval(ctx, "", 0, "<scr-module-ns>", JS_EVAL_TYPE_MODULE | JS_EVAL_FLAG_COMPILE_ONLY);
  if (JS_IsException(m)) return m;
  JSValue ns = JS_GetModuleNamespace(ctx, (JSModuleDef *)JS_VALUE_GET_PTR(m));
  JS_FreeValue(ctx, m);
  if (JS_IsException(ns)) return ns;
  int32_t id = (int32_t)JS_GetClassID(ns);
  JS_FreeValue(ctx, ns);
  return JS_NewInt32(ctx, id);
}

/* Valid while web_internals_ctx is non-NULL. */
static JSValue web_internals;
static JSContext *web_internals_ctx = NULL;

void scr_island_web_boot(void *jsctx) {
  JSContext *ctx = (JSContext *)jsctx;
  JSValue fn = JS_Eval(ctx, web_prelude, sizeof web_prelude - 1,
                       "<scr-web>", JS_EVAL_TYPE_GLOBAL);
  if (JS_IsException(fn)) {
    fprintf(stderr, "scriptc: island web prelude failed to evaluate\n");
    JSValue e = JS_GetException(ctx);
    JS_FreeValue(ctx, e);
    abort();
  }
  JSValue host = JS_NewObject(ctx);
  /* JS_SetPropertyStr consumes the function values. */
  JS_SetPropertyStr(ctx, host, "fill", JS_NewCFunction(ctx, web_host_fill, "fill", 1));
  JS_SetPropertyStr(ctx, host, "uuid", JS_NewCFunction(ctx, web_host_uuid, "uuid", 0));
  JS_SetPropertyStr(ctx, host, "write", JS_NewCFunction(ctx, web_host_write, "write", 2));
  JS_SetPropertyStr(ctx, host, "tzname", JS_NewCFunction(ctx, web_host_tzname, "tzname", 1));
  JS_SetPropertyStr(ctx, host, "now", JS_NewCFunction(ctx, web_host_now, "now", 0));
  JS_SetPropertyStr(ctx, host, "timer", JS_NewCFunction(ctx, web_host_timer, "timer", 2));
  JS_SetPropertyStr(ctx, host, "setTimer", JS_NewCFunction(ctx, web_host_set_timer, "setTimer", 3));
  JS_SetPropertyStr(ctx, host, "clearTimer", JS_NewCFunction(ctx, web_host_clear_timer, "clearTimer", 1));
  JS_SetPropertyStr(ctx, host, "isPromise", JS_NewCFunction(ctx, web_host_is_promise, "isPromise", 1));
  JS_SetPropertyStr(ctx, host, "isProxy", JS_NewCFunction(ctx, web_host_is_proxy, "isProxy", 1));
  JS_SetPropertyStr(ctx, host, "proxyTarget", JS_NewCFunction(ctx, web_host_proxy_target, "proxyTarget", 1));
  JS_SetPropertyStr(ctx, host, "proxyHandler", JS_NewCFunction(ctx, web_host_proxy_handler, "proxyHandler", 1));
  JS_SetPropertyStr(ctx, host, "promiseState", JS_NewCFunction(ctx, web_host_promise_state, "promiseState", 1));
  JS_SetPropertyStr(ctx, host, "classId", JS_NewCFunction(ctx, web_host_class_id, "classId", 1));
  JS_SetPropertyStr(ctx, host, "moduleNamespaceClassId",
                    JS_NewCFunction(ctx, web_host_module_ns_class_id, "moduleNamespaceClassId", 0));
  JSValue r = JS_Call(ctx, fn, JS_UNDEFINED, 1, (JSValueConst *)&host);
  JS_FreeValue(ctx, host);
  JS_FreeValue(ctx, fn);
  if (JS_IsException(r)) {
    fprintf(stderr, "scriptc: island web prelude failed to run\n");
    JSValue e = JS_GetException(ctx);
    JS_FreeValue(ctx, e);
    abort();
  }
  /* The prelude answers its internals (mkResponse for the fetch glue,
   * uspReset for the URL class, receiveMessageOnPort for worker_threads):
   * kept here and handed to those boot scripts through their host
   * objects, so none of it is a global a program could see. */
  web_internals = r;
  web_internals_ctx = ctx;
}

JSValue scr_island_web_internals(void *jsctx) {
  JSContext *ctx = (JSContext *)jsctx;
  if (web_internals_ctx == NULL) return JS_UNDEFINED;
  return JS_DupValue(ctx, web_internals);
}

void scr_island_web_teardown(void) {
  if (web_internals_ctx != NULL) JS_FreeValue(web_internals_ctx, web_internals);
  web_internals_ctx = NULL;
}

#endif /* SCR_DYNAMIC */
