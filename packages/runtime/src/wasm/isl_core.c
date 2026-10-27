/* isl_core.c — the engine half of the island on the WasmGC tier.
 *
 * Linked INSIDE the prebuilt engine module (scripts/build-engine-wasm.mjs:
 * quickjs-ng + this file + scr_ieee754.cc over the vendored V8 ieee754.cc +
 * wasi-libc, `wasm-ld --emit-relocs`), which the
 * wasm emitter splices into a program's own module only when the program
 * reaches the engine (packages/compiler/src/backend/wasm/engine.ts). It is
 * the wasm counterpart of the JSValue-touching half of the native island
 * (packages/runtime/src/scr_island.c): everything that holds a JSValue
 * lives here; the static-world half (strings as `(array i16)`, the
 * exception cell) is emitted wasm on the other side of these exports.
 *
 * The protocol is deliberately flat — i32/f64 scalars and UTF-16 buffers
 * in this module's own linear memory (memory 0 of the merged module):
 *
 *   isl_alloc(n) / isl_free(p)  engine-heap buffers the static side fills
 *   isl_eval16(p, n) -> kind    evaluate UTF-16 source in the global scope
 *   isl_out_num()               the number/boolean answer of the last call
 *   isl_out_ptr(i)/isl_out_len(i)  UTF-16 answer strings 0 and 1
 *   isl_out_done()              release the answer strings
 *   isl_drain_jobs() -> n|-1    run pending engine jobs (promise reactions)
 *   isl_rejection() -> 0|1      an unhandled engine rejection is ledgered:
 *                               out string 0 = String(reason); the ledger
 *                               is cleared (native isl_report_rejections)
 *   isl_live_allocs()           the counting allocator (the leak oracle)
 *
 * Answer kinds (ISL_K_*): a string result (out 0), a number (out_num), a
 * boolean (out_num 0/1), a thrown Error (out 0 = name, out 1 = message —
 * native isl_throw_reason's Error arm), a thrown non-Error (out 0 =
 * String(v), or native's fixed fallback text when ToString throws).
 *
 * The runtime is created on first entry: one runtime + one context for the
 * instance, so island globals persist across evals (native's
 * one-context-per-process model). Its context boots as native's does: the
 * shared web-platform prelude (scr_web_prelude.h — the SAME text, over this
 * file's host functions; SEMANTICS.md S108), then the fence of whatever
 * Node global is still missing. Nothing is ever torn down — a wasm
 * instance's memory dies with it; isl_live_allocs is what the unit tests
 * read instead of native's teardown audit. */
#include <math.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#include "quickjs.h"
#include "node_globals.h"
/* The web-platform globals — the SAME text the native island evaluates
 * (packages/runtime/src/scr_web_prelude.h; the build puts that directory
 * on the include path). */
#include "scr_web_prelude.h"

#define ISL_EXPORT(n) __attribute__((export_name(n)))

/* The ONE non-WASI engine import: the host module's own Math.random
 * (emitter.ts binds it to the static side's generator, seeded once from
 * the `seed` import), so static code and island code draw from ONE
 * sequence — Node's single per-isolate generator, `--random-seed`
 * included. */
__attribute__((import_module("tsinter_engine"), import_name("math_random"))) double isl_host_math_random(void);

/* The second: the host module's entropy read (its `tsinter.random`
 * import, abi.ts) filling n bytes of THIS module's memory at p — the web
 * prelude's crypto.getRandomValues/randomUUID, as native bridges them to
 * the same arc4random_buf behind its static crypto. */
__attribute__((import_module("tsinter_engine"), import_name("random"))) void isl_host_random(void *p, size_t n);

/* The third: the module's own `x ** y` (%w.jsPow — V8's math::pow over the
 * tier's port of the glibc pow Node's x86-64 build calls, S079), behind
 * scr_jsmath.h's scr_js_pow: wasi-libc's pow is musl's, which Node never
 * runs. */
__attribute__((import_module("tsinter_engine"), import_name("pow"))) double isl_host_pow(double x, double y);

/* The host's local time zone (SEMANTICS.md S113): the module's own
 * %w.date.zoneOffset (tzCall OFFSET, clamped and checked — a broken host is
 * the module's named trap) and tzCall NAME written into THIS module's
 * memory at p (at most cap UTF-16 units; the answer is the name's length,
 * hostStr's retry contract). */
__attribute__((import_module("tsinter_engine"), import_name("tz_offset"))) double isl_host_tz_offset(double ms);
__attribute__((import_module("tsinter_engine"), import_name("tz_name"))) int isl_host_tz_name(double ms, uint16_t *p, int cap);

/* performance.now as the static side reads it (`now` minus the origin the
 * module sampled at _start), for Event#timeStamp — native's scr_perf_now. */
__attribute__((import_module("tsinter_engine"), import_name("perf_now"))) double isl_host_perf_now(void);

/* The engine's Date local time (quickjs.c's tsinter zone hooks, defined
 * for this build too): the offset at a UTC instant in ms, seconds kept,
 * and V8's ToUTC — scr_lib.c's two functions, over tzCall instead of the C
 * library. The FORMER rule: a local time L takes the offset at
 * L - max(offset a day before, offset a day after). */
double scr_tz_offset_ms(double t) { return isl_host_tz_offset(t); }
double scr_tz_local_to_utc(double local) {
  if (!(fabs(local) <= 8640000000000000.0 + 864000000.0)) return NAN;
  double before = isl_host_tz_offset(local - 86400000.0);
  double after = isl_host_tz_offset(local + 86400000.0);
  return local - isl_host_tz_offset(local - (before > after ? before : after));
}

/* The engine's Math, as Node computes it (SEMANTICS.md S100): the native
 * island's own override (scr_island_math.h) over the same ports
 * (scr_jsmath.h, defined here) and the same V8 ieee754.cc (scr_ieee754.cc,
 * linked into this module by the build). */
#define SCR_JSMATH_POW(x, y) isl_host_pow(x, y)
#define SCR_JSMATH_NAN
#define SCR_JSMATH_LIB
#include "scr_jsmath.h"
#include "scr_island_math.h"

/* The engine's stack-overflow budget, in bytes of the C (shadow) stack.
 * The shadow stack lives in linear memory, but every engine C frame is
 * ALSO a wasm frame on the host's native stack, shared with the static
 * program's own frames: the budget must run out before the HOST stack
 * does, or deep recursion becomes an uncatchable host stack-overflow
 * instead of the engine's catchable RangeError. Measured on Node 24 / V8
 * (default --stack-size): about 256 bytes of shadow stack and about 250
 * bytes of host stack per simple JS call, so 256KiB is ~1,000 JS frames
 * — caught as RangeError with 5,000 host frames already on the stack at
 * the call site, while 1MiB overflows the host before the budget runs
 * out. SEMANTICS.md S103 states what this means for recursion depth. The
 * linker reserves 1MiB for the shadow stack itself
 * (build-engine-wasm.mjs): margin for C frames past the last check. */
#ifndef ISL_STACK_BUDGET
#define ISL_STACK_BUDGET (256 * 1024)
#endif

enum {
  ISL_K_STR = 0,
  ISL_K_NUM = 1,
  ISL_K_BOOL = 2,
  ISL_K_THROW_ERROR = 3,
  ISL_K_THROW_VALUE = 4,
};

static JSRuntime *isl_rt;
static JSContext *isl_ctx;

/* ── counting allocator (the leak oracle; native isl_mf) ─────────────── */
static long isl_live = 0;

static void *isl_mf_calloc(void *opaque, size_t count, size_t size) {
  (void)opaque;
  void *p = calloc(count, size);
  if (p) isl_live++;
  return p;
}
static void *isl_mf_malloc(void *opaque, size_t size) {
  (void)opaque;
  void *p = malloc(size);
  if (p) isl_live++;
  return p;
}
static void isl_mf_free(void *opaque, void *ptr) {
  (void)opaque;
  if (ptr) isl_live--;
  free(ptr);
}
static void *isl_mf_realloc(void *opaque, void *ptr, size_t size) {
  (void)opaque;
  void *p = realloc(ptr, size);
  if (!ptr && p) isl_live++;
  return p;
}
size_t malloc_usable_size(void *ptr);
static size_t isl_mf_usable(const void *ptr) { return malloc_usable_size((void *)ptr); }

static const JSMallocFunctions isl_mf = {
    isl_mf_calloc, isl_mf_malloc, isl_mf_free, isl_mf_realloc, isl_mf_usable,
};

/* ── answer slots ──────────────────────────────────────────────────── */
#define ISL_SLOTS 3
static double isl_num;
static const uint16_t *isl_str[ISL_SLOTS];
static size_t isl_len[ISL_SLOTS];
/* A fallback answer that is not an engine string (the fixed texts below):
 * static storage, never freed through the engine. */
static bool isl_str_static[ISL_SLOTS];

static void isl_out_clear(void) {
  for (int i = 0; i < ISL_SLOTS; i++) {
    if (isl_str[i] != NULL && !isl_str_static[i]) JS_FreeCStringUTF16(isl_ctx, isl_str[i]);
    isl_str[i] = NULL;
    isl_len[i] = 0;
    isl_str_static[i] = false;
  }
}

/* A fixed ASCII text as answer string `i` (no engine allocation). */
static uint16_t isl_fixed_buf[ISL_SLOTS][64];
static void isl_out_fixed(int i, const char *text) {
  size_t n = strlen(text);
  if (n > 64) n = 64;
  for (size_t k = 0; k < n; k++) isl_fixed_buf[i][k] = (uint16_t)(unsigned char)text[k];
  isl_str[i] = isl_fixed_buf[i];
  isl_len[i] = n;
  isl_str_static[i] = true;
}

/* String(v) as answer string `i`. False = ToString threw; the engine's
 * pending exception is left for the caller. Borrows v. */
static bool isl_out_string(int i, JSValueConst v) {
  size_t n = 0;
  const uint16_t *s = JS_ToCStringLenUTF16(isl_ctx, &n, v);
  if (s == NULL) return false;
  isl_str[i] = s;
  isl_len[i] = n;
  isl_str_static[i] = false;
  return true;
}

/* String(v) as the explicit conversion does it: a symbol renders
 * "Symbol(desc)" through the global String function (as Node's
 * String(result) resolves it), which the engine's ToString — and so
 * JS_ToCStringLen — refuses. False = it threw; the exception is pending. */
static bool isl_out_string_explicit(int i, JSValueConst v) {
  if (!JS_IsSymbol(v)) return isl_out_string(i, v);
  JSValue g = JS_GetGlobalObject(isl_ctx);
  JSValue fn = JS_GetPropertyStr(isl_ctx, g, "String");
  JS_FreeValue(isl_ctx, g);
  JSValue s = JS_Call(isl_ctx, fn, JS_UNDEFINED, 1, (JSValueConst *)&v);
  JS_FreeValue(isl_ctx, fn);
  if (JS_IsException(s)) return false;
  bool ok = isl_out_string(i, s);
  JS_FreeValue(isl_ctx, s);
  return ok;
}

/* String(obj.prop) with a FALLBACK instead of recursion (native
 * isl_prop_str): a throwing getter or an unrepresentable value must not
 * re-enter the bridge. */
static void isl_out_prop(int i, JSValueConst obj, const char *prop, const char *fallback) {
  JSValue v = JS_GetPropertyStr(isl_ctx, obj, prop);
  if (JS_IsException(v)) {
    JS_FreeValue(isl_ctx, JS_GetException(isl_ctx));
    isl_out_fixed(i, fallback);
    return;
  }
  bool ok = isl_out_string(i, v);
  JS_FreeValue(isl_ctx, v);
  if (!ok) {
    JS_FreeValue(isl_ctx, JS_GetException(isl_ctx));
    isl_out_fixed(i, fallback);
  }
}

/* Engine VALUE → thrown answer (native isl_throw_reason, verbatim in
 * behaviour). Borrows exc. */
static int isl_throw_reason(JSValueConst exc) {
  if (JS_IsError(exc)) {
    isl_out_prop(0, exc, "name", "Error");
    isl_out_prop(1, exc, "message", "");
    /* A string `code` crosses too (the static error has the slot;
     * SEMANTICS.md S103 (h) lists what does not). Slot 2 stays unset —
     * isl_out_len(2) answers -1 — otherwise. */
    JSValue code = JS_GetPropertyStr(isl_ctx, exc, "code");
    if (JS_IsException(code)) {
      JS_FreeValue(isl_ctx, JS_GetException(isl_ctx));
    } else {
      if (JS_IsString(code) && !isl_out_string(2, code)) JS_FreeValue(isl_ctx, JS_GetException(isl_ctx));
      JS_FreeValue(isl_ctx, code);
    }
    return ISL_K_THROW_ERROR;
  }
  if (!isl_out_string_explicit(0, exc)) {
    /* ToString itself threw (e.g. a symbol): clear that too, keep a
     * deterministic message. */
    JS_FreeValue(isl_ctx, JS_GetException(isl_ctx));
    isl_out_fixed(0, "Error: unrepresentable island exception");
  }
  return ISL_K_THROW_VALUE;
}

static int isl_bridge_exception(void) {
  JSValue exc = JS_GetException(isl_ctx); /* owned; clears the pending state */
  int k = isl_throw_reason(exc);
  JS_FreeValue(isl_ctx, exc);
  return k;
}

/* ── unhandled-rejection ledger (native isl_rejection_tracker) ─────── */
typedef struct IslRejection {
  JSValue promise;
  JSValue reason;
  struct IslRejection *next;
} IslRejection;

static IslRejection *isl_rejections = NULL;
static IslRejection **isl_rejections_tail = &isl_rejections;

static void isl_rejection_free(IslRejection *r) {
  JS_FreeValue(isl_ctx, r->promise);
  JS_FreeValue(isl_ctx, r->reason);
  free(r);
}

static void isl_rejection_tracker(JSContext *ctx, JSValueConst promise, JSValueConst reason,
                                  bool is_handled, void *opaque) {
  (void)ctx;
  (void)opaque;
  if (is_handled) {
    /* Rescission drops the handled promise's entry and its same-reason
     * twins (native isl_rejections_drop_reason). */
    IslRejection **pp = &isl_rejections;
    while (*pp) {
      IslRejection *r = *pp;
      if (JS_IsSameValue(isl_ctx, r->reason, reason) || JS_IsSameValue(isl_ctx, r->promise, promise)) {
        *pp = r->next;
        isl_rejection_free(r);
      } else {
        pp = &r->next;
      }
    }
    isl_rejections_tail = &isl_rejections;
    while (*isl_rejections_tail) isl_rejections_tail = &(*isl_rejections_tail)->next;
    return;
  }
  IslRejection *r = malloc(sizeof *r);
  if (!r) abort();
  r->promise = JS_DupValue(ctx, promise);
  r->reason = JS_DupValue(ctx, reason);
  r->next = NULL;
  *isl_rejections_tail = r;
  isl_rejections_tail = &r->next;
}

/* Names Node's global scope has that this engine does not (yet): reading
 * one inside an island eval would silently answer `undefined` (or
 * `typeof x === "undefined"`) where Node answers a real object, so each
 * absent one becomes an accessor that throws a NAMED error instead —
 * SEMANTICS.md S103 (b). The candidate list is GENERATED: node_globals.h
 * holds every own property name of a fresh Node CommonJS global
 * (scripts/build-engine-wasm.mjs); the names the engine already has are
 * skipped. Assigning one replaces the fence with an ordinary global, so a
 * program that defines its own `console` keeps working.
 *
 * The locale-sensitive methods answer differently without Intl (the
 * engine has none: `1234567.891.toLocaleString()` is "1234567.891" where
 * Node prints "1,234,567.891"), so they throw the same named error
 * (S103 (b)); Array and TypedArray toLocaleString reach them through
 * their elements. The script answers the fenced global names (the build
 * script records them for the compiler's build-time fence). */
static const char isl_fence_src[] =
    "(() => {\n"
    "  const g = globalThis;\n"
    "  const msg = (n) => n + ' inside __island_eval is not supported yet on the wasm lane (SEMANTICS.md S103)';\n"
    "  const fenced = [];\n"
    "  for (const n of " ISL_NODE_GLOBALS ") {\n"
    "    if (n in g) continue;\n"
    "    fenced.push(n);\n"
    "    Object.defineProperty(g, n, {\n"
    "      configurable: true,\n"
    "      enumerable: false,\n"
    "      get() { throw new Error(msg(n)); },\n"
    "      set(v) { Object.defineProperty(g, n, { value: v, writable: true, configurable: true, enumerable: true }); },\n"
    "    });\n"
    "  }\n"
    "  const lf = (o, cls, k) => {\n"
    "    const f = { [k]() { throw new Error(msg(cls + '.prototype.' + k)); } }[k];\n"
    "    Object.defineProperty(f, 'length', { value: o[k].length });\n"
    "    Object.defineProperty(o, k, { value: f, writable: true, configurable: true, enumerable: false });\n"
    "  };\n"
    "  lf(Number.prototype, 'Number', 'toLocaleString');\n"
    "  lf(BigInt.prototype, 'BigInt', 'toLocaleString');\n"
    "  for (const k of ['toLocaleString', 'toLocaleDateString', 'toLocaleTimeString']) lf(Date.prototype, 'Date', k);\n"
    "  for (const k of ['localeCompare', 'toLocaleLowerCase', 'toLocaleUpperCase']) lf(String.prototype, 'String', k);\n"
    "  return fenced.join(',');\n"
    "})()";

/* ── the web prelude's host object (native: scr_web.c) ──────────────
 * scr_web_prelude.h is shared verbatim; these are the wasm lane's
 * implementations of its seven host functions. Engine ownership rules as
 * ever: argv borrowed, results owned. */

/* host.write(fd, s): console's write — straight to WASI fd_write (no stdio
 * buffer), which the module serves through its own `write` import, so a
 * line lands in order with the static side's console output. */
static JSValue isl_web_write(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
  (void)this_val;
  (void)argc;
  int32_t fd = 1;
  JS_ToInt32(ctx, &fd, argv[0]);
  size_t len;
  const char *s = JS_ToCStringLen(ctx, &len, argv[1]);
  if (!s) return JS_EXCEPTION;
  size_t at = 0;
  while (at < len) {
    ssize_t n = write(fd, s + at, len - at);
    if (n <= 0) break;
    at += (size_t)n;
  }
  JS_FreeCString(ctx, s);
  return JS_UNDEFINED;
}

/* host.fill(typedArray): the view's bytes from the host's entropy. The
 * prelude already validated the view kind and the 65536-byte quota. */
static JSValue isl_web_fill(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
  (void)this_val;
  (void)argc;
  size_t off = 0, len = 0, bpe = 0;
  JSValue ab = JS_GetTypedArrayBuffer(ctx, argv[0], &off, &len, &bpe);
  if (JS_IsException(ab)) return JS_EXCEPTION;
  size_t absize = 0;
  uint8_t *buf = JS_GetArrayBuffer(ctx, &absize, ab);
  JS_FreeValue(ctx, ab);
  if (!buf) return JS_EXCEPTION;
  if (len > 0) isl_host_random(buf + off, len);
  return JS_UNDEFINED;
}

/* host.uuid(): Node's randomUUID shape (16 random bytes, version 4,
 * variant 10xx, lowercase 8-4-4-4-12) — native's scr_crypto_random_uuid. */
static JSValue isl_web_uuid(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
  (void)this_val;
  (void)argc;
  (void)argv;
  uint8_t b[16];
  isl_host_random(b, sizeof b);
  b[6] = (uint8_t)((b[6] & 0x0f) | 0x40);
  b[8] = (uint8_t)((b[8] & 0x3f) | 0x80);
  static const char hex[] = "0123456789abcdef";
  char out[36];
  int o = 0;
  for (int i = 0; i < 16; i++) {
    if (i == 4 || i == 6 || i == 8 || i == 10) out[o++] = '-';
    out[o++] = hex[b[i] >> 4];
    out[o++] = hex[b[i] & 15];
  }
  return JS_NewStringLen(ctx, out, sizeof out);
}

/* host.now(): performance.now as the static side reads it — the same
 * origin (sampled at _start) and clock, so Event#timeStamp and a static
 * performance.now() agree, as native's scr_perf_now does. */
static JSValue isl_web_now(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
  (void)this_val;
  (void)argc;
  (void)argv;
  return JS_NewFloat64(ctx, isl_host_perf_now());
}

static long long isl_days_from_civil(long long y, int m, int d) {
  y -= m <= 2;
  long long era = (y >= 0 ? y : y - 399) / 400;
  unsigned long long yoe = (unsigned long long)(y - era * 400);
  unsigned long long doy = (unsigned long long)((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1);
  unsigned long long doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
  return era * 146097 + (long long)doe - 719468;
}

/* V8's DateCache::EquivalentTime for an instant outside [0, kMaxInt s] —
 * native scr_web.c's web_equivalent_time: tzCall NAME is asked only about
 * instants in that range (abi.ts). */
static double isl_equivalent_time(double ms) {
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
  int leap = y % 4 == 0 && (y % 100 != 0 || y % 400 == 0);
  int week_day = (int)(((isl_days_from_civil(y, 1, 1) + 4) % 7 + 7) % 7);
  int recent_year = (leap ? 1956 : 1967) + (week_day * 12) % 28;
  int year = 2008 + (recent_year + 3 * 28 - 2008) % 28;
  return (double)(isl_days_from_civil(year, m, 1) + d - 1) * 86400000.0 + within;
}

/* host.tzname(ms): Date#toString's zone-name suffix — the host's own name
 * for the zone at V8's equivalent instant (tzCall NAME; SEMANTICS.md S113),
 * as native's web_host_tzname answers it from its table. */
static JSValue isl_web_tzname(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
  (void)this_val;
  (void)argc;
  double ms = 0;
  if (JS_ToFloat64(ctx, &ms, argv[0])) return JS_EXCEPTION;
  if (!isfinite(ms)) return JS_NewString(ctx, "");
  double at = isl_equivalent_time(ms);
  uint16_t small[128];
  int n = isl_host_tz_name(at, small, (int)(sizeof small / sizeof small[0]));
  if (n <= (int)(sizeof small / sizeof small[0])) return JS_NewStringUTF16(ctx, small, (size_t)n);
  uint16_t *big = malloc((size_t)n * sizeof *big);
  if (big == NULL) return JS_ThrowOutOfMemory(ctx);
  int m = isl_host_tz_name(at, big, n);
  JSValue r = JS_NewStringUTF16(ctx, big, (size_t)(m <= n ? m : 0));
  free(big);
  return r;
}

/* host.timer / host.setTimer / host.clearTimer: the engine has no timer
 * bridge onto the module's loop yet, so the timer globals stay FENCED
 * (isl_web_boot deletes them before the fence runs) and
 * AbortSignal.timeout — the one other caller — throws the fence's named
 * error. */
static JSValue isl_web_no_timer(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv, int magic) {
  (void)this_val;
  (void)argc;
  (void)argv;
  return JS_ThrowPlainError(ctx, "%s inside __island_eval is not supported yet on the wasm lane (SEMANTICS.md S103)",
                            magic == 0 ? "AbortSignal.timeout" : "setTimeout");
}

/* host.isPromise / isProxy / proxyTarget: native's (scr_web.c), the
 * internal-slot checks structuredClone needs. */
static JSValue isl_web_is_promise(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
  (void)this_val;
  (void)argc;
  return JS_NewBool(ctx, JS_IsPromise(argv[0]));
}
static JSValue isl_web_is_proxy(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
  (void)this_val;
  (void)argc;
  return JS_NewBool(ctx, JS_IsProxy(argv[0]));
}
static JSValue isl_web_proxy_target(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
  (void)this_val;
  (void)argc;
  return JS_GetProxyTarget(ctx, argv[0]);
}

/* Evaluates the shared prelude and calls it with the host object, then
 * removes the timer globals it defined, which this lane cannot serve (the
 * fence that runs next covers them by name). 0 = ok. */
static int isl_web_boot(void) {
  JSValue fn = JS_Eval(isl_ctx, web_prelude, sizeof web_prelude - 1, "<scr-web>", JS_EVAL_TYPE_GLOBAL);
  if (JS_IsException(fn)) return -1;
  JSValue host = JS_NewObject(isl_ctx);
  /* JS_SetPropertyStr consumes the function values. */
  JS_SetPropertyStr(isl_ctx, host, "fill", JS_NewCFunction(isl_ctx, isl_web_fill, "fill", 1));
  JS_SetPropertyStr(isl_ctx, host, "uuid", JS_NewCFunction(isl_ctx, isl_web_uuid, "uuid", 0));
  JS_SetPropertyStr(isl_ctx, host, "write", JS_NewCFunction(isl_ctx, isl_web_write, "write", 2));
  JS_SetPropertyStr(isl_ctx, host, "tzname", JS_NewCFunction(isl_ctx, isl_web_tzname, "tzname", 1));
  JS_SetPropertyStr(isl_ctx, host, "now", JS_NewCFunction(isl_ctx, isl_web_now, "now", 0));
  JS_SetPropertyStr(isl_ctx, host, "timer",
                    JS_NewCFunctionMagic(isl_ctx, isl_web_no_timer, "timer", 2, JS_CFUNC_generic_magic, 0));
  JS_SetPropertyStr(isl_ctx, host, "setTimer",
                    JS_NewCFunctionMagic(isl_ctx, isl_web_no_timer, "setTimer", 3, JS_CFUNC_generic_magic, 1));
  JS_SetPropertyStr(isl_ctx, host, "clearTimer",
                    JS_NewCFunctionMagic(isl_ctx, isl_web_no_timer, "clearTimer", 1, JS_CFUNC_generic_magic, 1));
  JS_SetPropertyStr(isl_ctx, host, "isPromise", JS_NewCFunction(isl_ctx, isl_web_is_promise, "isPromise", 1));
  JS_SetPropertyStr(isl_ctx, host, "isProxy", JS_NewCFunction(isl_ctx, isl_web_is_proxy, "isProxy", 1));
  JS_SetPropertyStr(isl_ctx, host, "proxyTarget", JS_NewCFunction(isl_ctx, isl_web_proxy_target, "proxyTarget", 1));
  JSValue r = JS_Call(isl_ctx, fn, JS_UNDEFINED, 1, (JSValueConst *)&host);
  JS_FreeValue(isl_ctx, host);
  JS_FreeValue(isl_ctx, fn);
  if (JS_IsException(r)) return -2;
  JS_FreeValue(isl_ctx, r);
  JSValue g = JS_GetGlobalObject(isl_ctx);
  static const char *const timers[] = {"setTimeout", "setInterval", "clearTimeout", "clearInterval"};
  int rc = 0;
  for (size_t i = 0; i < sizeof timers / sizeof timers[0]; i++) {
    JSAtom a = JS_NewAtom(isl_ctx, timers[i]);
    if (JS_DeleteProperty(isl_ctx, g, a, 0) < 0) rc = -3;
    JS_FreeAtom(isl_ctx, a);
  }
  JS_FreeValue(isl_ctx, g);
  return rc;
}

/* The fenced names, kept from init for isl_fence_list (plain malloc: not
 * an engine allocation). */
static char *isl_fenced_names;

/* Math.random over the host module's generator (see the import above). */
static JSValue isl_js_math_random(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
  (void)this_val;
  (void)argc;
  (void)argv;
  return JS_NewFloat64(ctx, isl_host_math_random());
}

static int isl_depth = 0;

static int isl_init(void) {
  isl_rt = JS_NewRuntime2(&isl_mf, NULL);
  if (!isl_rt) return -1;
  JS_SetMaxStackSize(isl_rt, ISL_STACK_BUDGET);
  isl_ctx = JS_NewContext(isl_rt);
  if (!isl_ctx) return -2;
  JS_SetHostPromiseRejectionTracker(isl_rt, isl_rejection_tracker, NULL);
  /* Native's boot order: Math's members first (scr_island.c isl_init). */
  isl_install_math(isl_ctx);
  /* The web globals next (as native boots them), so the fence below covers
   * only what is still missing. */
  if (isl_web_boot() != 0) return -5;
  JSValue r = JS_Eval(isl_ctx, isl_fence_src, sizeof isl_fence_src - 1, "<scr-fence>", JS_EVAL_TYPE_GLOBAL);
  if (JS_IsException(r)) return -3;
  const char *names = JS_ToCString(isl_ctx, r);
  JS_FreeValue(isl_ctx, r);
  if (names == NULL) return -4;
  isl_fenced_names = strdup(names);
  JS_FreeCString(isl_ctx, names);
  JSValue g = JS_GetGlobalObject(isl_ctx);
  JSValue math = JS_GetPropertyStr(isl_ctx, g, "Math");
  JS_FreeValue(isl_ctx, g);
  JS_DefinePropertyValueStr(isl_ctx, math, "random", JS_NewCFunction(isl_ctx, isl_js_math_random, "random", 0),
                            JS_PROP_WRITABLE | JS_PROP_CONFIGURABLE);
  JS_FreeValue(isl_ctx, math);
  return 0;
}

/* Every entry: lazy init, then (outermost entries only) re-anchor the
 * overflow check at the CURRENT shadow-stack pointer — native isl_entry. */
static void isl_entry(void) {
  if (!isl_rt && isl_init() != 0) abort();
  if (isl_depth == 0) JS_UpdateStackTop(isl_rt);
  isl_out_clear();
}

ISL_EXPORT("isl_alloc") void *isl_alloc(size_t n) { return malloc(n == 0 ? 1 : n); }
ISL_EXPORT("isl_free") void isl_free(void *p) { free(p); }

/* Evaluate n UTF-16 code units at p in the island's global scope; the
 * answer is String(result) — numbers and booleans travel as out_num for
 * the static side's own formatter, exactly like native scr_island_eval's
 * scr_f64_to_scrstr / scr_bool_to_scrstr arms. The source enters as an
 * engine string built from the UTF-16 units (lone surrogates intact). */
ISL_EXPORT("isl_eval16") int isl_eval16(const uint16_t *p, int n) {
  isl_entry();
  JSValue src = JS_NewStringUTF16(isl_ctx, p, (uint32_t)n);
  if (JS_IsException(src)) return isl_bridge_exception();
  /* An INDIRECT eval — `(0, eval)(code)`, the corpus oracle's own shim
   * (tests/harness/island-shim.mjs) — not a script: `let`/`const` stay
   * local to the one eval while `var` and functions land on the global
   * object, exactly as in Node. The global `eval` is looked up at every
   * call, as the shim's is. */
  JSValue g = JS_GetGlobalObject(isl_ctx);
  JSValue ev = JS_GetPropertyStr(isl_ctx, g, "eval");
  JS_FreeValue(isl_ctx, g);
  if (JS_IsException(ev)) {
    JS_FreeValue(isl_ctx, src);
    return isl_bridge_exception();
  }
  isl_depth++;
  JSValue r = JS_Call(isl_ctx, ev, JS_UNDEFINED, 1, (JSValueConst *)&src);
  isl_depth--;
  JS_FreeValue(isl_ctx, ev);
  JS_FreeValue(isl_ctx, src);
  if (JS_IsException(r)) return isl_bridge_exception();
  int kind;
  if (JS_IsNumber(r)) {
    double d;
    if (JS_ToFloat64(isl_ctx, &d, r)) {
      JS_FreeValue(isl_ctx, r);
      return isl_bridge_exception();
    }
    isl_num = d;
    kind = ISL_K_NUM;
  } else if (JS_IsBool(r)) {
    isl_num = JS_ToBool(isl_ctx, r) > 0 ? 1 : 0;
    kind = ISL_K_BOOL;
  } else if (JS_IsSymbol(r)) {
    bool ok = isl_out_string_explicit(0, r);
    JS_FreeValue(isl_ctx, r);
    return ok ? ISL_K_STR : isl_bridge_exception();
  } else if (isl_out_string(0, r)) {
    kind = ISL_K_STR;
  } else {
    /* String(result) threw (an object whose toString throws): bridged. */
    JS_FreeValue(isl_ctx, r);
    return isl_bridge_exception();
  }
  JS_FreeValue(isl_ctx, r);
  return kind;
}

ISL_EXPORT("isl_out_num") double isl_out_num(void) { return isl_num; }
ISL_EXPORT("isl_out_ptr") const uint16_t *isl_out_ptr(int i) { return (unsigned)i < ISL_SLOTS ? isl_str[i] : NULL; }
/* -1 = slot unset (only slot 2, an Error's string `code`, is optional). */
ISL_EXPORT("isl_out_len") int isl_out_len(int i) {
  if ((unsigned)i >= ISL_SLOTS || isl_str[i] == NULL) return i == 2 ? -1 : 0;
  return (int)isl_len[i];
}
ISL_EXPORT("isl_out_done") void isl_out_done(void) {
  if (isl_rt) isl_out_clear();
}

/* Run every pending engine job (native scr_island_drain_jobs). Answers
 * the count, or -1 when a job the engine itself could not complete threw
 * — out string 0 then holds String(exception) and the static side dies
 * with "Uncaught <it>" exactly like native's _Exit(1) path. */
ISL_EXPORT("isl_drain_jobs") int isl_drain_jobs(void) {
  if (!isl_rt) return 0;
  isl_entry();
  int n = 0;
  for (;;) {
    JSContext *jctx;
    isl_depth++;
    int r = JS_ExecutePendingJob(isl_rt, &jctx);
    isl_depth--;
    if (r == 0) break;
    if (r < 0) {
      JSValue exc = JS_GetException(jctx);
      if (!isl_out_string(0, exc)) {
        JS_FreeValue(isl_ctx, JS_GetException(isl_ctx));
        isl_out_fixed(0, "island job exception");
      }
      JS_FreeValue(jctx, exc);
      return -1;
    }
    n++;
  }
  return n;
}

/* The ledger's report (native isl_report_rejections with print=true):
 * 1 = at least one unhandled rejection was ledgered — out string 0 is
 * String(first reason) ("[object]" when ToString throws) — and the whole
 * ledger is cleared; 0 = nothing to report. */
ISL_EXPORT("isl_rejection") int isl_rejection(void) {
  if (!isl_rt || isl_rejections == NULL) return 0;
  isl_out_clear();
  if (!isl_out_string(0, isl_rejections->reason)) {
    JS_FreeValue(isl_ctx, JS_GetException(isl_ctx));
    isl_out_fixed(0, "[object]");
  }
  while (isl_rejections) {
    IslRejection *r = isl_rejections;
    isl_rejections = r->next;
    isl_rejection_free(r);
  }
  isl_rejections_tail = &isl_rejections;
  return 1;
}

/* The comma-joined global names the fence covers (initializing the
 * engine if needed) — read by the build script, never by a program. */
ISL_EXPORT("isl_fence_list") const char *isl_fence_list(void) {
  if (!isl_rt && isl_init() != 0) abort();
  return isl_fenced_names;
}

ISL_EXPORT("isl_live_allocs") int isl_live_allocs(void) { return (int)isl_live; }
