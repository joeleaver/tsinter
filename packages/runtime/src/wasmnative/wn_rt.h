/* The native runner's view of a translated module (native-runner phase N0).
 *
 * backend/wasm2c.ts (whole-program profile) translates a WasmGC program
 * module to one C file that includes this header; the runner's three units
 * — wn_gc.c (the collector), wn_host.c (abi.ts's host imports over the OS)
 * and wn_main.c (instantiate, `_start`, the `_tick`/`_loop` pump) — link
 * beside it. Everything here is the wasm semantics the translation calls:
 * the object model, checked array access, linear memory, and the numeric
 * operations whose C spelling differs from wasm's (trapping division and
 * truncation, shift counts, NaN-propagating min/max, bit casts).
 *
 * Build line requirements (wasm-native.ts): -fno-strict-aliasing (the
 * object model and memory reads go through casts); -ffp-model=strict (wasm
 * float arithmetic is IEEE and every operation runs: clang's default model
 * folds x*-1.0, x/-1.0 and -0.0-x into a sign flip and x*1.0, x/1.0, x-0.0
 * and x+-0.0 into x, which changes a NaN operand's bits where V8 runs the
 * instruction — observable through Float64Array; it also implies no
 * contraction); -fstack-clash-protection (a large frame probes its pages,
 * so it cannot step over the stack's guard region). -fwrapv is not needed
 * (signed arithmetic is done unsigned). */
#ifndef WN_RT_H
#define WN_RT_H

#include <math.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

#define W_LIKELY(x) __builtin_expect(!!(x), 1)
#define W_UNLIKELY(x) __builtin_expect(!!(x), 0)

/* ── traps: the program dies with exit status 1 (abi.ts: "a trap is the
 * exit code"). `unreachable` is the module's own uncaught-error path (it
 * has already printed Node's report), so it adds no text; every other kind
 * names itself on stderr. */
enum {
  W_TRAP_UNREACHABLE,
  W_TRAP_NULL,
  W_TRAP_BOUNDS,
  W_TRAP_DIV0,
  W_TRAP_IOVF,
  W_TRAP_CONV,
  W_TRAP_REM0,
  W_TRAP_DATA,
  W_TRAP_ARRAY_SIZE,
  W_TRAP_CAST,
  W_TRAP_MEM,
  W_TRAP_TABLE,
  W_TRAP_SIG,
  W_TRAP_OOM,
  W_TRAP_STACK,
};
_Noreturn void w_trap(int kind);

/* The stack-depth limit (SEMANTICS.md S117 (b)): every translated function
 * that calls another counts its frame in the translation's w_depth
 * (wasm2c.ts translateBody);
 * past W_DEPTH_MAX frames the program traps with V8's stack-overflow text,
 * as the wasm lane's module does when V8's stack runs out. The limit is the
 * deepest the wasm lane reaches on Node's default stack (about 18,000 of
 * the smallest frames), so a recursion that fits there fits here. */
#define W_DEPTH_MAX 20000u

/* ── the object model: an 8-byte header (canonical type id, array length),
 * then a struct's fields at their natural alignment or an array's
 * elements. References are plain pointers; null is 0. A function
 * reference is the translated function's address. */
typedef struct WObj WObj;
#define W_TID(o) (((const uint32_t *)(const void *)(o))[0])
#define W_LEN(o) (((const uint32_t *)(const void *)(o))[1])
#define W_FLD(o, T, off) (*(T *)(void *)((char *)(o) + (off)))
#define W_EL(o, T) ((T *)(void *)((char *)(o) + 8))

/* The translation's type tables, by canonical type id. kind: 0 function,
 * 1 struct, 2 array. The display holds a type's ancestors by depth, so a
 * subtype test is two loads. refs/nrefs index w_refoffs: a struct's traced
 * reference fields. */
typedef struct {
  uint8_t kind;
  uint8_t elemRef;
  uint8_t esz;
  uint8_t pad;
  uint32_t size;
  uint32_t depth;
  uint32_t disp;
  uint32_t nrefs;
  uint32_t refs;
} WType;
extern const WType w_types[];
extern const uint32_t w_ntypes;
extern const uint32_t w_disp[];
extern const uint32_t w_refoffs[];
extern WObj **const w_gc_roots[];
extern const uint32_t w_gc_nroots;

static inline int w_tsub(uint32_t tid, uint32_t target, uint32_t depth) {
  return w_types[tid].depth >= depth && w_disp[w_types[tid].disp + depth] == target;
}

static inline WObj *w_nn(WObj *o) {
  if (W_UNLIKELY(o == 0)) w_trap(W_TRAP_NULL);
  return o;
}

/* ── the collector (wn_gc.c). Memory comes back zeroed. */
WObj *w_gc_alloc(size_t bytes);
static inline WObj *w_new_struct(uint32_t tid, uint32_t size) {
  WObj *o = w_gc_alloc(size);
  ((uint32_t *)(void *)o)[0] = tid;
  return o;
}
static inline WObj *w_new_array(uint32_t tid, uint32_t esz, int32_t len) {
  /* wasm reads the length unsigned; V8's limit: an array's body must stay
   * under 1 GiB less its 24-byte header, i.e. a length below
   * (2^30 - 24) / element size (i8: 1073741799 at most, ref: 134217724) —
   * past it, "requested new array is too large" */
  if (W_UNLIKELY((uint32_t)len >= ((1u << 30) - 24u) / esz)) w_trap(W_TRAP_ARRAY_SIZE);
  WObj *o = w_gc_alloc(8 + (size_t)(uint32_t)len * esz);
  ((uint32_t *)(void *)o)[0] = tid;
  ((uint32_t *)(void *)o)[1] = (uint32_t)len;
  return o;
}
static inline WObj *w_new_array_data(uint32_t tid, uint32_t esz, const unsigned char *seg, uint32_t seglen, int32_t off, int32_t len) {
  if (W_UNLIKELY((uint64_t)(uint32_t)off + (uint64_t)(uint32_t)len * esz > seglen)) w_trap(W_TRAP_DATA);
  WObj *o = w_new_array(tid, esz, len);
  memcpy(W_EL(o, uint8_t), seg + (uint32_t)off, (size_t)(uint32_t)len * esz); /* little-endian host */
  return o;
}

/* ── checked array access: get/set with a null and a bounds check; the
 * `n` forms skip the null check (a non-nullable operand). */
#define W_ARR(ACC, T, RT)                                                                              \
  static inline RT w_agetn_##ACC(WObj *a, int32_t i) {                                                 \
    if (W_UNLIKELY((uint32_t)i >= W_LEN(a))) w_trap(W_TRAP_BOUNDS);                                    \
    return (RT)W_EL(a, T)[(uint32_t)i];                                                                \
  }                                                                                                    \
  static inline RT w_aget_##ACC(WObj *a, int32_t i) { return w_agetn_##ACC(w_nn(a), i); }
W_ARR(i8u, uint8_t, int32_t)
W_ARR(i8s, int8_t, int32_t)
W_ARR(i16u, uint16_t, int32_t)
W_ARR(i16s, int16_t, int32_t)
W_ARR(i32, int32_t, int32_t)
W_ARR(i64, int64_t, int64_t)
W_ARR(f32, float, float)
W_ARR(f64, double, double)
W_ARR(ref, WObj *, WObj *)
#define W_ASET(ACC, T, VT)                                                                             \
  static inline void w_asetn_##ACC(WObj *a, int32_t i, VT v) {                                         \
    if (W_UNLIKELY((uint32_t)i >= W_LEN(a))) w_trap(W_TRAP_BOUNDS);                                    \
    W_EL(a, T)[(uint32_t)i] = (T)v;                                                                    \
  }                                                                                                    \
  static inline void w_aset_##ACC(WObj *a, int32_t i, VT v) { w_asetn_##ACC(w_nn(a), i, v); }          \
  static inline void w_afill_##ACC(WObj *a, int32_t off, VT v, int32_t n) {                            \
    w_nn(a);                                                                                           \
    if (W_UNLIKELY((uint64_t)(uint32_t)off + (uint32_t)n > W_LEN(a))) w_trap(W_TRAP_BOUNDS);           \
    T *p = W_EL(a, T) + (uint32_t)off;                                                                 \
    for (uint32_t q = 0; q < (uint32_t)n; q++) p[q] = (T)v;                                            \
  }
W_ASET(i8, uint8_t, int32_t)
W_ASET(i16, uint16_t, int32_t)
W_ASET(i32, int32_t, int32_t)
W_ASET(i64, int64_t, int64_t)
W_ASET(f32, float, float)
W_ASET(f64, double, double)
W_ASET(ref, WObj *, WObj *)
static inline void w_acopy(WObj *d, int32_t di, WObj *s, int32_t si, int32_t n, uint32_t esz) {
  w_nn(d);
  w_nn(s);
  if (W_UNLIKELY((uint64_t)(uint32_t)di + (uint32_t)n > W_LEN(d) || (uint64_t)(uint32_t)si + (uint32_t)n > W_LEN(s))) w_trap(W_TRAP_BOUNDS);
  memmove(W_EL(d, uint8_t) + (size_t)(uint32_t)di * esz, W_EL(s, uint8_t) + (size_t)(uint32_t)si * esz, (size_t)(uint32_t)n * esz);
}
static inline void w_ainit_data(WObj *a, int32_t d, const unsigned char *seg, uint32_t seglen, int32_t s, int32_t n, uint32_t esz) {
  w_nn(a);
  if (W_UNLIKELY((uint64_t)(uint32_t)d + (uint32_t)n > W_LEN(a))) w_trap(W_TRAP_BOUNDS);
  if (W_UNLIKELY((uint64_t)(uint32_t)s + (uint64_t)(uint32_t)n * esz > seglen)) w_trap(W_TRAP_DATA);
  memcpy(W_EL(a, uint8_t) + (size_t)(uint32_t)d * esz, seg + (uint32_t)s, (size_t)(uint32_t)n * esz);
}

/* ── linear memory: each memory is an 8 GiB PROT_NONE reservation with the
 * live pages read-write; the base never moves (grow only changes
 * protection). Every access is CHECKED against the memory's live length
 * where wasm performs it (w_addr): an out-of-bounds read in C is undefined
 * behavior, and clang deletes an unused one or sinks it past a host call,
 * so a guard-page fault alone would trap late or not at all. The
 * reservation stays as a second line: nothing can reach past it. */
uint8_t *w_mem_reserve(uint32_t pages);
int32_t w_mem_grow(uint8_t **base, uint32_t *pages, int32_t delta, uint32_t max);
#define W_ADDR(m, a, off) ((m) + (uint64_t)(uint32_t)(a) + (uint64_t)(off))
/* the address of an n-byte access at a + off, or the trap */
static inline uint8_t *w_addr(uint8_t *m, uint64_t len, int32_t a, uint64_t off, uint64_t n) {
  uint64_t e = (uint64_t)(uint32_t)a + off;
  if (W_UNLIKELY(e + n > len)) w_trap(W_TRAP_MEM);
  return m + e;
}
static inline void w_mem_check(uint32_t pages, uint32_t off, uint32_t n) {
  if (W_UNLIKELY((uint64_t)off + n > (uint64_t)pages * 65536u)) w_trap(W_TRAP_MEM);
}
static inline void w_mem_copy(uint8_t *dm, uint32_t dp, int32_t d, uint8_t *sm, uint32_t sp, int32_t s, int32_t n) {
  w_mem_check(dp, (uint32_t)d, (uint32_t)n);
  w_mem_check(sp, (uint32_t)s, (uint32_t)n);
  memmove(dm + (uint32_t)d, sm + (uint32_t)s, (uint32_t)n);
}
static inline void w_mem_fill(uint8_t *m, uint32_t pages, int32_t d, int32_t v, int32_t n) {
  w_mem_check(pages, (uint32_t)d, (uint32_t)n);
  memset(m + (uint32_t)d, (int)(uint8_t)v, (uint32_t)n);
}
static inline void w_mem_init(uint8_t *m, uint32_t pages, int32_t d, const unsigned char *seg, uint32_t seglen, int32_t s, int32_t n) {
  w_mem_check(pages, (uint32_t)d, (uint32_t)n);
  if (W_UNLIKELY((uint64_t)(uint32_t)s + (uint32_t)n > seglen)) w_trap(W_TRAP_MEM);
  memcpy(m + (uint32_t)d, seg + (uint32_t)s, (uint32_t)n);
}
#define W_LD(name, T)                                       \
  static inline T name(const uint8_t *p) {                  \
    T v;                                                    \
    memcpy(&v, p, sizeof v);                                \
    return v;                                               \
  }
W_LD(w_ld_u8, uint8_t)
W_LD(w_ld_u16, uint16_t)
W_LD(w_ld_i32, int32_t)
W_LD(w_ld_i64, int64_t)
W_LD(w_ld_f32, float)
W_LD(w_ld_f64, double)
static inline void w_st_i8(uint8_t *p, int64_t v) { *p = (uint8_t)v; }
static inline void w_st_i16(uint8_t *p, int64_t v) {
  uint16_t x = (uint16_t)v;
  memcpy(p, &x, 2);
}
static inline void w_st_i32(uint8_t *p, int64_t v) {
  uint32_t x = (uint32_t)v;
  memcpy(p, &x, 4);
}
static inline void w_st_i64(uint8_t *p, int64_t v) { memcpy(p, &v, 8); }
static inline void w_st_f32(uint8_t *p, float v) { memcpy(p, &v, 4); }
static inline void w_st_f64(uint8_t *p, double v) { memcpy(p, &v, 8); }

/* ── tables (funcref): the entry and its canonical function type, checked
 * as call_indirect checks (null entry, signature subtype). */
static inline void *w_tbl_get(void *const *t, const int32_t *ty, uint32_t n, int32_t i, uint32_t want, uint32_t depth) {
  if (W_UNLIKELY((uint32_t)i >= n)) w_trap(W_TRAP_TABLE);
  if (W_UNLIKELY(t[(uint32_t)i] == 0)) w_trap(W_TRAP_SIG);
  if (W_UNLIKELY(!w_tsub((uint32_t)ty[(uint32_t)i], want, depth))) w_trap(W_TRAP_SIG);
  return t[(uint32_t)i];
}
static inline void *w_tbl_at(void *const *t, uint32_t n, int32_t i) {
  if (W_UNLIKELY((uint32_t)i >= n)) w_trap(W_TRAP_TABLE);
  return t[(uint32_t)i];
}

/* ── numbers: bit casts and constants */
static inline float w_f32_of(int32_t b) {
  float f;
  memcpy(&f, &b, 4);
  return f;
}
static inline double w_f64_of(int64_t b) {
  double d;
  memcpy(&d, &b, 8);
  return d;
}
static inline int32_t w_bits_f32(float f) {
  int32_t b;
  memcpy(&b, &f, 4);
  return b;
}
static inline int64_t w_bits_f64(double d) {
  int64_t b;
  memcpy(&b, &d, 8);
  return b;
}
#define W_F32C(bits) w_f32_of((int32_t)(bits))
#define W_F64C(bits) w_f64_of((int64_t)(bits))

/* sign/magnitude operations are bit operations in wasm (they never touch a
 * NaN's payload or quiet it) */
static inline float w_fnegf(float a) { return w_f32_of(w_bits_f32(a) ^ (int32_t)0x80000000u); }
static inline double w_fneg(double a) { return w_f64_of(w_bits_f64(a) ^ (int64_t)0x8000000000000000ull); }
static inline float w_fabsf(float a) { return w_f32_of(w_bits_f32(a) & 0x7fffffff); }
static inline double w_fabs(double a) { return w_f64_of(w_bits_f64(a) & 0x7fffffffffffffffll); }
static inline float w_copysignf(float a, float b) {
  return w_f32_of((w_bits_f32(a) & 0x7fffffff) | (int32_t)((uint32_t)w_bits_f32(b) & 0x80000000u));
}
static inline double w_copysign(double a, double b) {
  return w_f64_of((w_bits_f64(a) & 0x7fffffffffffffffll) | (int64_t)((uint64_t)w_bits_f64(b) & 0x8000000000000000ull));
}
/* wasm min/max: a NaN operand gives NaN; -0 is less than +0 (C's fmin
 * returns the other operand for a NaN and may pick either zero). WHICH NaN
 * is the engine's: V8 on x86-64 answers the processor's default NaN
 * (sign set, quiet, no payload) whatever the operands' payloads
 * (wasm2c-whole.test.ts pins it bit for bit); elsewhere the NaN operand
 * propagates, quieted. */
#if defined(__x86_64__)
#define W_MINMAX_NAN64(a, b) w_f64_of((int64_t)0xfff8000000000000ull)
#define W_MINMAX_NAN32(a, b) w_f32_of((int32_t)0xffc00000u)
#else
#define W_MINMAX_NAN64(a, b) ((a) + (b))
#define W_MINMAX_NAN32(a, b) ((a) + (b))
#endif
static inline double w_fmin(double a, double b) {
  if (a != a || b != b) return W_MINMAX_NAN64(a, b);
  if (a == 0 && b == 0) return signbit(a) ? a : b;
  return a < b ? a : b;
}
static inline double w_fmax(double a, double b) {
  if (a != a || b != b) return W_MINMAX_NAN64(a, b);
  if (a == 0 && b == 0) return signbit(a) ? b : a;
  return a > b ? a : b;
}
static inline float w_fminf(float a, float b) {
  if (a != a || b != b) return W_MINMAX_NAN32(a, b);
  if (a == 0 && b == 0) return signbit(a) ? a : b;
  return a < b ? a : b;
}
static inline float w_fmaxf(float a, float b) {
  if (a != a || b != b) return W_MINMAX_NAN32(a, b);
  if (a == 0 && b == 0) return signbit(a) ? b : a;
  return a > b ? a : b;
}

/* ── integers */
static inline int32_t w_clz32(int32_t a) { return a ? __builtin_clz((uint32_t)a) : 32; }
static inline int32_t w_ctz32(int32_t a) { return a ? __builtin_ctz((uint32_t)a) : 32; }
static inline int32_t w_popcnt32(int32_t a) { return __builtin_popcount((uint32_t)a); }
static inline int64_t w_clz64(int64_t a) { return a ? __builtin_clzll((uint64_t)a) : 64; }
static inline int64_t w_ctz64(int64_t a) { return a ? __builtin_ctzll((uint64_t)a) : 64; }
static inline int64_t w_popcnt64(int64_t a) { return __builtin_popcountll((uint64_t)a); }
static inline int32_t w_rotl32(int32_t a, int32_t b) {
  uint32_t x = (uint32_t)a, n = (uint32_t)b & 31u;
  return (int32_t)((x << n) | (x >> ((32u - n) & 31u)));
}
static inline int32_t w_rotr32(int32_t a, int32_t b) {
  uint32_t x = (uint32_t)a, n = (uint32_t)b & 31u;
  return (int32_t)((x >> n) | (x << ((32u - n) & 31u)));
}
static inline int64_t w_rotl64(int64_t a, int64_t b) {
  uint64_t x = (uint64_t)a, n = (uint64_t)b & 63u;
  return (int64_t)((x << n) | (x >> ((64u - n) & 63u)));
}
static inline int64_t w_rotr64(int64_t a, int64_t b) {
  uint64_t x = (uint64_t)a, n = (uint64_t)b & 63u;
  return (int64_t)((x >> n) | (x << ((64u - n) & 63u)));
}
static inline int32_t w_shr_s(int32_t a, int32_t b) {
  uint32_t n = (uint32_t)b & 31u;
  uint32_t u = (uint32_t)a >> n;
  if (a < 0 && n > 0) u |= ~(0xffffffffu >> n);
  return (int32_t)u;
}
static inline int64_t w_shr_s64(int64_t a, int64_t b) {
  uint64_t n = (uint64_t)b & 63u;
  uint64_t u = (uint64_t)a >> n;
  if (a < 0 && n > 0) u |= ~(0xffffffffffffffffull >> n);
  return (int64_t)u;
}
static inline int32_t w_div_s(int32_t a, int32_t b) {
  if (W_UNLIKELY(b == 0)) w_trap(W_TRAP_DIV0);
  if (W_UNLIKELY(a == INT32_MIN && b == -1)) w_trap(W_TRAP_IOVF); /* V8: "divide result unrepresentable" */
  return a / b;
}
static inline int32_t w_div_u(int32_t a, int32_t b) {
  if (W_UNLIKELY(b == 0)) w_trap(W_TRAP_DIV0);
  return (int32_t)((uint32_t)a / (uint32_t)b);
}
static inline int32_t w_rem_s(int32_t a, int32_t b) {
  if (W_UNLIKELY(b == 0)) w_trap(W_TRAP_REM0);
  return b == -1 ? 0 : a % b;
}
static inline int32_t w_rem_u(int32_t a, int32_t b) {
  if (W_UNLIKELY(b == 0)) w_trap(W_TRAP_REM0);
  return (int32_t)((uint32_t)a % (uint32_t)b);
}
static inline int64_t w_div_s64(int64_t a, int64_t b) {
  if (W_UNLIKELY(b == 0)) w_trap(W_TRAP_DIV0);
  if (W_UNLIKELY(a == INT64_MIN && b == -1)) w_trap(W_TRAP_IOVF);
  return a / b;
}
static inline int64_t w_div_u64(int64_t a, int64_t b) {
  if (W_UNLIKELY(b == 0)) w_trap(W_TRAP_DIV0);
  return (int64_t)((uint64_t)a / (uint64_t)b);
}
static inline int64_t w_rem_s64(int64_t a, int64_t b) {
  if (W_UNLIKELY(b == 0)) w_trap(W_TRAP_REM0);
  return b == -1 ? 0 : a % b;
}
static inline int64_t w_rem_u64(int64_t a, int64_t b) {
  if (W_UNLIKELY(b == 0)) w_trap(W_TRAP_REM0);
  return (int64_t)((uint64_t)a % (uint64_t)b);
}

/* ── float → int: the trapping forms trap on NaN and on a value whose
 * truncation is out of range (V8 words both "float unrepresentable in
 * integer range") (the bounds are exclusive and exactly
 * representable in the source type); the saturating forms clamp and map
 * NaN to 0. */
#define W_TRUNC(name, R, CR, F, lo, hi)                                    \
  static inline R name(F x) {                                              \
    if (W_UNLIKELY(x != x)) w_trap(W_TRAP_CONV);                           \
    if (W_UNLIKELY(!(x > (F)(lo) && x < (F)(hi)))) w_trap(W_TRAP_CONV);    \
    return (R)(CR)x;                                                       \
  }
W_TRUNC(w_trunc_i32_f64, int32_t, int32_t, double, -2147483649.0, 2147483648.0)
W_TRUNC(w_trunc_u32_f64, int32_t, uint32_t, double, -1.0, 4294967296.0)
W_TRUNC(w_trunc_i32_f32, int32_t, int32_t, float, -2147483904.0f, 2147483648.0f)
W_TRUNC(w_trunc_u32_f32, int32_t, uint32_t, float, -1.0f, 4294967296.0f)
W_TRUNC(w_trunc_i64_f64, int64_t, int64_t, double, -9223372036854777856.0, 9223372036854775808.0)
W_TRUNC(w_trunc_u64_f64, int64_t, uint64_t, double, -1.0, 18446744073709551616.0)
W_TRUNC(w_trunc_i64_f32, int64_t, int64_t, float, -9223373136366403584.0f, 9223372036854775808.0f)
W_TRUNC(w_trunc_u64_f32, int64_t, uint64_t, float, -1.0f, 18446744073709551616.0f)
#define W_SAT(name, R, CR, F, lo, hi, mn, mx)                              \
  static inline R name(F x) {                                              \
    if (x != x) return 0;                                                  \
    if (x <= (F)(lo)) return (R)(CR)(mn);                                  \
    if (x >= (F)(hi)) return (R)(CR)(mx);                                  \
    return (R)(CR)x;                                                       \
  }
W_SAT(w_sat_i32_f64, int32_t, int32_t, double, -2147483649.0, 2147483648.0, INT32_MIN, INT32_MAX)
W_SAT(w_sat_u32_f64, int32_t, uint32_t, double, -1.0, 4294967296.0, 0, UINT32_MAX)
W_SAT(w_sat_i32_f32, int32_t, int32_t, float, -2147483904.0f, 2147483648.0f, INT32_MIN, INT32_MAX)
W_SAT(w_sat_u32_f32, int32_t, uint32_t, float, -1.0f, 4294967296.0f, 0, UINT32_MAX)
W_SAT(w_sat_i64_f64, int64_t, int64_t, double, -9223372036854777856.0, 9223372036854775808.0, INT64_MIN, INT64_MAX)
W_SAT(w_sat_u64_f64, int64_t, uint64_t, double, -1.0, 18446744073709551616.0, 0, UINT64_MAX)
W_SAT(w_sat_i64_f32, int64_t, int64_t, float, -9223373136366403584.0f, 9223372036854775808.0f, INT64_MIN, INT64_MAX)
W_SAT(w_sat_u64_f32, int64_t, uint64_t, float, -1.0f, 18446744073709551616.0f, 0, UINT64_MAX)

/* the module's exported memory, which every host import addresses */
extern uint8_t *w_hostmem;

/* ── the module's entry points (the translation defines them) */
void w_init(void);
extern const int w_has__start, w_has__tick, w_has__loop, w_has__status;
void w_export__start(void);
double w_export__tick(double now);
double w_export__loop(double now);
int32_t w_export__status(void);
uint8_t *w_export_memory(void);

#endif /* WN_RT_H */
