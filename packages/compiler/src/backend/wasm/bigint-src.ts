/* The BigInt magnitude arithmetic, as C the WasmGC tier's C-subset compiler
 * (csubset.ts) turns into wasm function bodies (bigint.ts instantiates it).
 * Hand-written for this tier, not vendored: every operation is the textbook
 * algorithm (schoolbook add/sub/mul, Knuth's algorithm D for division,
 * Hacker's Delight's divmnu for the multiply-and-subtract step), chosen so
 * the result is exact, deterministic and identical on every engine. Node's
 * V8 uses faster algorithms for huge operands (Karatsuba, FFT), but the
 * VALUES are the same: BigInt arithmetic has one exact answer.
 *
 * THE FORMAT. A value is one GC int array `a`: a[0] is the sign (1 when the
 * value is negative, else 0) and a[1..n] the magnitude's 32-bit limbs, least
 * significant first, with no high zero limb. Zero is {0} (sign 0, no limbs),
 * so every value has exactly one spelling and equality is limb equality.
 * Every function answers a FRESH array or one of its arguments (values are
 * immutable once built, so sharing is safe).
 *
 * bigint.ts keeps values in [-2^63, 2^63) in an i64 fast path and calls in
 * here for the rest (and for the operations it does not inline). A failed
 * parse answers the empty array (length 0), which no value has. */
export const BIGINT_C = String.raw`
static int nl(int* a) { return ia_len(a) - 1; }

static uint32_t limb(int* a, int i) {
  if (i < ia_len(a) - 1) return (uint32_t)a[i + 1];
  return 0u;
}

/* r with its high zero limbs dropped and its sign set to neg (0 for zero). */
static int* bn_trim(int* r, int neg) {
  int n = ia_len(r) - 1;
  while (n > 0 && r[n] == 0) n--;
  if (n == ia_len(r) - 1) {
    r[0] = n == 0 ? 0 : neg;
    return r;
  }
  int* t = ia_new(n + 1);
  for (int i = 1; i <= n; i++) t[i] = r[i];
  t[0] = n == 0 ? 0 : neg;
  return t;
}

/* The value of the two's-complement 64-bit pattern v. */
int* bn_from_bits(uint64_t v) {
  int neg = (v >> 63) != 0u ? 1 : 0;
  uint64_t m = neg ? (~v) + 1u : v;
  int n = m == 0u ? 0 : ((m >> 32) == 0u ? 1 : 2);
  int* r = ia_new(n + 1);
  r[0] = neg;
  if (n >= 1) r[1] = (int)(uint32_t)m;
  if (n == 2) r[2] = (int)(uint32_t)(m >> 32);
  return r;
}

/* An unsigned 64-bit magnitude with sign neg. */
static int* bn_from_mag64(uint64_t m, int neg) {
  int* r = ia_new(3);
  r[1] = (int)(uint32_t)m;
  r[2] = (int)(uint32_t)(m >> 32);
  return bn_trim(r, neg);
}

/* The unsigned 64-bit pattern m's value (readBigUInt64). */
int* bn_from_ubits(uint64_t m) { return bn_from_mag64(m, 0); }

/* 1 when the value is in [-2^63, 2^63). */
int bn_fits_i64(int* a) {
  int n = nl(a);
  if (n <= 1) return 1;
  if (n > 2) return 0;
  uint32_t hi = limb(a, 1);
  if (hi < 0x80000000u) return 1;
  if (a[0] == 1 && hi == 0x80000000u && limb(a, 0) == 0u) return 1;
  return 0;
}

/* The low 64 bits of the value's two's complement (the value itself when it
 * fits in an i64; BigInt.asUintN(64, x)'s bits otherwise). */
uint64_t bn_to_bits(int* a) {
  uint64_t m = ((uint64_t)limb(a, 1) << 32) | (uint64_t)limb(a, 0);
  if (a[0] == 1) return (~m) + 1u;
  return m;
}

static int mag_cmp(int* a, int* b) {
  int na = nl(a);
  int nb = nl(b);
  if (na != nb) return na > nb ? 1 : -1;
  for (int i = na - 1; i >= 0; i--) {
    uint32_t x = limb(a, i);
    uint32_t y = limb(b, i);
    if (x != y) return x > y ? 1 : -1;
  }
  return 0;
}

static int* mag_add(int* a, int* b, int neg) {
  int na = nl(a);
  int nb = nl(b);
  int n = na > nb ? na : nb;
  int* r = ia_new(n + 2);
  uint64_t c = 0u;
  for (int i = 0; i < n; i++) {
    c = c + (uint64_t)limb(a, i) + (uint64_t)limb(b, i);
    r[i + 1] = (int)(uint32_t)c;
    c = c >> 32;
  }
  r[n + 1] = (int)(uint32_t)c;
  return bn_trim(r, neg);
}

/* |a| - |b|, for |a| >= |b|. */
static int* mag_sub(int* a, int* b, int neg) {
  int na = nl(a);
  int* r = ia_new(na + 1);
  uint64_t borrow = 0u;
  for (int i = 0; i < na; i++) {
    uint64_t d = (uint64_t)limb(a, i) - (uint64_t)limb(b, i) - borrow;
    r[i + 1] = (int)(uint32_t)d;
    borrow = (d >> 32) & 1u;
  }
  return bn_trim(r, neg);
}

int bn_cmp(int* a, int* b) {
  if (a[0] != b[0]) return a[0] == 1 ? -1 : 1;
  int c = mag_cmp(a, b);
  return a[0] == 1 ? -c : c;
}

int* bn_add(int* a, int* b) {
  if (a[0] == b[0]) return mag_add(a, b, a[0]);
  int c = mag_cmp(a, b);
  if (c == 0) return ia_new(1);
  if (c > 0) return mag_sub(a, b, a[0]);
  return mag_sub(b, a, b[0]);
}

int* bn_neg(int* a) {
  int n = ia_len(a);
  if (n == 1) return a;
  int* r = ia_new(n);
  for (int i = 1; i < n; i++) r[i] = a[i];
  r[0] = 1 - a[0];
  return r;
}

int* bn_sub(int* a, int* b) { return bn_add(a, bn_neg(b)); }

int* bn_mul(int* a, int* b) {
  int na = nl(a);
  int nb = nl(b);
  if (na == 0 || nb == 0) return ia_new(1);
  int* r = ia_new(na + nb + 1);
  for (int i = 0; i < na; i++) {
    uint64_t ai = (uint64_t)limb(a, i);
    uint64_t c = 0u;
    for (int j = 0; j < nb; j++) {
      uint64_t t = ai * (uint64_t)limb(b, j) + (uint64_t)(uint32_t)r[i + j + 1] + c;
      r[i + j + 1] = (int)(uint32_t)t;
      c = t >> 32;
    }
    r[i + nb + 1] = (int)(uint32_t)c;
  }
  return bn_trim(r, a[0] ^ b[0]);
}

/* Truncating division of magnitudes (Knuth D): the quotient (signed qneg)
 * when wantRem is 0, else the remainder (signed rneg). |b| != 0. */
static int* mag_divmod(int* a, int* b, int wantRem, int qneg, int rneg) {
  int na = nl(a);
  int nb = nl(b);
  if (mag_cmp(a, b) < 0) {
    if (wantRem == 0) return ia_new(1);
    int* r = ia_new(na + 1);
    for (int i = 1; i <= na; i++) r[i] = a[i];
    return bn_trim(r, rneg);
  }
  if (nb == 1) {
    uint64_t d = (uint64_t)limb(b, 0);
    uint64_t rem = 0u;
    int* q = ia_new(na + 1);
    for (int i = na - 1; i >= 0; i--) {
      uint64_t cur = (rem << 32) | (uint64_t)limb(a, i);
      q[i + 1] = (int)(uint32_t)(cur / d);
      rem = cur % d;
    }
    if (wantRem) return bn_from_mag64(rem, rneg);
    return bn_trim(q, qneg);
  }
  /* normalize: shift so the divisor's top limb has its high bit set */
  int s = 0;
  uint32_t top = limb(b, nb - 1);
  while ((top & 0x80000000u) == 0u) {
    top = top << 1;
    s++;
  }
  int* vn = ia_new(nb);
  for (int i = nb - 1; i > 0; i--) {
    uint32_t hi = limb(b, i) << s;
    uint32_t lo = s == 0 ? 0u : limb(b, i - 1) >> (32 - s);
    vn[i] = (int)(hi | lo);
  }
  vn[0] = (int)(limb(b, 0) << s);
  int* un = ia_new(na + 1);
  un[na] = s == 0 ? 0 : (int)(limb(a, na - 1) >> (32 - s));
  for (int i = na - 1; i > 0; i--) {
    uint32_t hi = limb(a, i) << s;
    uint32_t lo = s == 0 ? 0u : limb(a, i - 1) >> (32 - s);
    un[i] = (int)(hi | lo);
  }
  un[0] = (int)(limb(a, 0) << s);
  int* q = ia_new(na - nb + 2);
  uint64_t vtop = (uint64_t)(uint32_t)vn[nb - 1];
  uint64_t vnext = (uint64_t)(uint32_t)vn[nb - 2];
  for (int j = na - nb; j >= 0; j--) {
    uint64_t num = ((uint64_t)(uint32_t)un[j + nb] << 32) | (uint64_t)(uint32_t)un[j + nb - 1];
    uint64_t qhat = num / vtop;
    uint64_t rhat = num % vtop;
    while (qhat >= 0x100000000u || qhat * vnext > ((rhat << 32) | (uint64_t)(uint32_t)un[j + nb - 2])) {
      qhat = qhat - 1u;
      rhat = rhat + vtop;
      if (rhat >= 0x100000000u) break;
    }
    int64_t k = 0;
    int64_t t = 0;
    for (int i = 0; i < nb; i++) {
      uint64_t p = qhat * (uint64_t)(uint32_t)vn[i];
      t = (int64_t)(uint64_t)(uint32_t)un[i + j] - k - (int64_t)(p & 0xffffffffu);
      un[i + j] = (int)(uint32_t)(uint64_t)t;
      k = (int64_t)(p >> 32) - (t >> 32);
    }
    t = (int64_t)(uint64_t)(uint32_t)un[j + nb] - k;
    un[j + nb] = (int)(uint32_t)(uint64_t)t;
    if (t < 0) {
      qhat = qhat - 1u;
      uint64_t c = 0u;
      for (int i = 0; i < nb; i++) {
        c = (uint64_t)(uint32_t)un[i + j] + (uint64_t)(uint32_t)vn[i] + c;
        un[i + j] = (int)(uint32_t)c;
        c = c >> 32;
      }
      un[j + nb] = (int)((uint32_t)un[j + nb] + (uint32_t)c);
    }
    q[j + 1] = (int)(uint32_t)qhat;
  }
  if (wantRem == 0) return bn_trim(q, qneg);
  /* the remainder is un[0..nb-1] shifted back right by s */
  int* r = ia_new(nb + 1);
  for (int i = 0; i < nb; i++) {
    uint32_t lo = (uint32_t)un[i] >> s;
    uint32_t hi = s == 0 ? 0u : (i + 1 < nb ? (uint32_t)un[i + 1] << (32 - s) : 0u);
    r[i + 1] = (int)(lo | hi);
  }
  return bn_trim(r, rneg);
}

/* a / b truncated toward zero; b != 0 (bigint.ts throws first). */
int* bn_div(int* a, int* b) { return mag_divmod(a, b, 0, a[0] ^ b[0], a[0]); }

/* a % b, the sign of a; b != 0. */
int* bn_rem(int* a, int* b) { return mag_divmod(a, b, 1, a[0] ^ b[0], a[0]); }

/* a ** e for a small non-negative e (bigint.ts bounds the result size). */
int* bn_pow(int* a, uint32_t e) {
  int* r = bn_from_bits(1u);
  int* x = a;
  while (e != 0u) {
    if ((e & 1u) != 0u) r = bn_mul(r, x);
    e = e >> 1;
    if (e != 0u) x = bn_mul(x, x);
  }
  return r;
}

/* The magnitude's bit length (0 for zero). */
uint32_t bn_bitlen(int* a) {
  int n = nl(a);
  if (n == 0) return 0u;
  uint32_t top = limb(a, n - 1);
  uint32_t bits = (uint32_t)(n - 1) * 32u;
  while (top != 0u) {
    top = top >> 1;
    bits++;
  }
  return bits;
}

/* log2 |a| for |a| >= 1, to about 2^-40 relative: the top two limbs as a
 * double scaled into [1, 2), its fraction bits by repeated squaring. */
static double bn_log2(int* a) {
  int n = nl(a);
  uint64_t m = (uint64_t)limb(a, n - 1);
  int below = n - 1;
  if (n >= 2) {
    m = (m << 32) | (uint64_t)limb(a, n - 2);
    below = n - 2;
  }
  int bl = 0;
  uint64_t t = m;
  while (t != 0u) {
    t = t >> 1;
    bl++;
  }
  double scale = 1.0;
  for (int i = 1; i < bl; i++) scale = scale * 2.0;
  double x = (double)m / scale;
  double frac = 0.0;
  double bit = 0.5;
  for (int i = 0; i < 40; i++) {
    x = x * x;
    if (x >= 2.0) {
      x = x / 2.0;
      frac = frac + bit;
    }
    bit = bit / 2.0;
  }
  return (double)(bl - 1) + frac + (double)below * 32.0;
}

/* a ** e under V8's size limit (2^30 bits), for |a| >= 2: the empty array
 * when the result would pass it. A power-of-two base is a shift (exact and
 * fast); any other base is estimated by log2 |a| * e first (past the limit
 * by more than two bits throws without computing), then measured. */
int* bn_pow_limited(int* a, uint32_t e) {
  uint64_t maxBits = 1073741824u;
  uint32_t len = bn_bitlen(a);
  int n = nl(a);
  int pow2 = (limb(a, n - 1) & (limb(a, n - 1) - 1u)) == 0u ? 1 : 0;
  for (int i = 0; i < n - 1; i++)
    if (limb(a, i) != 0u) pow2 = 0;
  if (pow2) {
    uint64_t bits = (uint64_t)(len - 1u) * (uint64_t)e;
    if (bits + 1u > maxBits) return ia_new(0);
    int* one = bn_from_bits(a[0] == 1 && (e & 1u) != 0u ? 0xffffffffffffffffu : 1u);
    return bn_shl(one, (uint32_t)bits);
  }
  if (bn_log2(a) * (double)e > (double)maxBits + 2.0) return ia_new(0);
  int* r = bn_pow(a, e);
  if ((uint64_t)bn_bitlen(r) > maxBits) return ia_new(0);
  return r;
}

/* a * 2^n (n >= 0; bigint.ts bounds the result size). */
int* bn_shl(int* a, uint32_t n) {
  int na = nl(a);
  if (na == 0) return a;
  int w = (int)(n >> 5);
  int s = (int)(n & 31u);
  int* r = ia_new(na + w + 2);
  for (int i = 0; i < na; i++) {
    uint32_t x = limb(a, i);
    r[i + w + 1] = (int)((uint32_t)r[i + w + 1] | (x << s));
    if (s != 0) r[i + w + 2] = (int)(x >> (32 - s));
  }
  return bn_trim(r, a[0]);
}

/* floor(a / 2^n) (n >= 0): the arithmetic right shift. */
int* bn_sar(int* a, uint32_t n) {
  int na = nl(a);
  int w = (int)(n >> 5);
  int s = (int)(n & 31u);
  if (na == 0) return a;
  int lost = 0;
  if (w >= na) {
    if (a[0] == 1) return bn_from_bits(0xffffffffffffffffu);
    return ia_new(1);
  }
  for (int i = 0; i < w; i++)
    if (limb(a, i) != 0u) lost = 1;
  if (s != 0 && (limb(a, w) << (32 - s)) != 0u) lost = 1;
  int* r = ia_new(na - w + 1);
  for (int i = w; i < na; i++) {
    uint32_t lo = limb(a, i) >> s;
    uint32_t hi = s == 0 ? 0u : limb(a, i + 1) << (32 - s);
    r[i - w + 1] = (int)(lo | hi);
  }
  int* q = bn_trim(r, a[0]);
  if (a[0] == 1 && lost) return bn_sub(q, bn_from_bits(1u));
  return q;
}

/* The value's two's complement in n limbs (0-based), sign-extended. */
static int* to_twos(int* a, int n) {
  int* out = ia_new(n);
  if (a[0] == 0) {
    for (int i = 0; i < n; i++) out[i] = (int)limb(a, i);
    return out;
  }
  uint64_t borrow = 1u;
  for (int i = 0; i < n; i++) {
    uint64_t d = (uint64_t)limb(a, i) - borrow;
    borrow = (d >> 32) & 1u;
    out[i] = (int)(~(uint32_t)d);
  }
  return out;
}

/* The value whose two's complement is t's n limbs (signed when sgn is 1). */
static int* from_twos(int* t, int n, int sgn) {
  int* r = ia_new(n + 1);
  int neg = sgn != 0 && ((uint32_t)t[n - 1] & 0x80000000u) != 0u ? 1 : 0;
  if (neg == 0) {
    for (int i = 0; i < n; i++) r[i + 1] = t[i];
    return bn_trim(r, 0);
  }
  uint64_t c = 1u;
  for (int i = 0; i < n; i++) {
    c = (uint64_t)(~(uint32_t)t[i]) + c;
    r[i + 1] = (int)(uint32_t)c;
    c = c >> 32;
  }
  return bn_trim(r, 1);
}

/* & (op 0), | (op 1), ^ (op 2) over the infinite two's complement. */
int* bn_bitop(int* a, int* b, int op) {
  int na = nl(a);
  int nb = nl(b);
  int n = (na > nb ? na : nb) + 1;
  int* x = to_twos(a, n);
  int* y = to_twos(b, n);
  for (int i = 0; i < n; i++) {
    uint32_t p = (uint32_t)x[i];
    uint32_t q = (uint32_t)y[i];
    uint32_t v = op == 0 ? (p & q) : (op == 1 ? (p | q) : (p ^ q));
    x[i] = (int)v;
  }
  return from_twos(x, n, 1);
}

/* ~a = -a - 1 */
int* bn_not(int* a) { return bn_sub(bn_neg(a), bn_from_bits(1u)); }

/* BigInt.asUintN(bits, a) (signed 0) and BigInt.asIntN(bits, a) (signed
 * 1), for bits >= 1 that bigint.ts has bounded. */
int* bn_asn(int* a, uint32_t bits, int sgn) {
  int na = nl(a);
  if (sgn == 0 && a[0] == 0 && bits >= (uint32_t)na * 32u) return a;
  if (sgn == 1 && bits > (uint32_t)na * 32u) return a;
  int n = (int)((bits + 31u) >> 5);
  int* t = to_twos(a, n);
  uint32_t part = bits & 31u;
  if (part != 0u) {
    uint32_t mask = (1u << part) - 1u;
    uint32_t v = (uint32_t)t[n - 1] & mask;
    /* asIntN: sign-extend from bit (bits - 1) */
    if (sgn == 1 && (v & (1u << (part - 1u))) != 0u) v = v | ~mask;
    t[n - 1] = (int)v;
  }
  return from_twos(t, n, sgn);
}

/* An integral double with |d| >= 2^63 (and any smaller integral one). */
int* bn_from_double(double d) {
  uint64_t bits = base::bit_cast<uint64_t>(d);
  int neg = (bits >> 63) != 0u ? 1 : 0;
  int e = (int)((bits >> 52) & 0x7ffu) - 1075;
  uint64_t mant = (bits & 0xfffffffffffffu) | 0x10000000000000u;
  if (((bits >> 52) & 0x7ffu) == 0u) return ia_new(1);
  if (e <= 0) {
    uint64_t m = mant >> (uint64_t)(-e);
    return bn_from_mag64(m, neg);
  }
  return bn_shl(bn_from_mag64(mant, neg), (uint32_t)e);
}

/* The double nearest the value (ties to even), Infinity past the range. */
double bn_to_double(int* a) {
  uint32_t len = bn_bitlen(a);
  int neg = a[0];
  double r = 0.0;
  if (len <= 64u) {
    uint64_t m = ((uint64_t)limb(a, 1) << 32) | (uint64_t)limb(a, 0);
    r = (double)m;
    return neg ? -r : r;
  }
  if (len > 1024u) {
    r = std::numeric_limits<double>::infinity();
    return neg ? -r : r;
  }
  /* the top 64 bits, then whether anything below them is set */
  uint32_t sh = len - 64u;
  int* t = a;
  int w = (int)(sh >> 5);
  int s = (int)(sh & 31u);
  uint64_t m = 0u;
  for (int i = 2; i >= 0; i--) {
    uint64_t x = (uint64_t)limb(t, w + i);
    if (i == 2) m = s == 0 ? 0u : x << (uint64_t)(64 - s);
    else if (i == 1) m = m | (s == 0 ? x << 32 : x << (uint64_t)(32 - s));
    else m = m | (x >> (uint64_t)s);
  }
  int sticky = 0;
  for (int i = 0; i < w; i++)
    if (limb(t, i) != 0u) sticky = 1;
  if (s != 0 && (limb(t, w) << (32 - s)) != 0u) sticky = 1;
  uint64_t mant = m >> 11;
  uint64_t rest = m & 0x7ffu;
  uint32_t ex = len - 1u;
  if (rest > 0x400u || (rest == 0x400u && (sticky || (mant & 1u) != 0u))) {
    mant = mant + 1u;
    if (mant == 0x20000000000000u) {
      mant = mant >> 1;
      ex++;
    }
  }
  if (ex > 1023u) {
    r = std::numeric_limits<double>::infinity();
    return neg ? -r : r;
  }
  uint64_t out = ((uint64_t)(ex + 1023u) << 52) | (mant & 0xfffffffffffffu);
  if (neg) out = out | 0x8000000000000000u;
  return base::bit_cast<double>(out);
}

/* The order of the value against a non-NaN double: -1, 0 or 1. */
int bn_cmp_double(int* a, double d) {
  if (d == std::numeric_limits<double>::infinity()) return -1;
  if (d == -std::numeric_limits<double>::infinity()) return 1;
  double f = floor(d);
  int c = bn_cmp(a, bn_from_double(f));
  if (c != 0) return c;
  return d == f ? 0 : -1;
}

/* digit values of c in radix r, or -1 */
static int digit_of(int c, int r) {
  int v = 99;
  if (c >= 48 && c <= 57) v = c - 48;
  else if (c >= 97 && c <= 122) v = c - 87;
  else if (c >= 65 && c <= 90) v = c - 55;
  return v < r ? v : -1;
}

static int is_space(int c) {
  if (c == 9 || c == 10 || c == 11 || c == 12 || c == 13 || c == 32 || c == 160) return 1;
  if (c == 0x1680 || (c >= 0x2000 && c <= 0x200a) || c == 0x2028 || c == 0x2029) return 1;
  if (c == 0x202f || c == 0x205f || c == 0x3000 || c == 0xfeff) return 1;
  return 0;
}

/* StringToBigInt over the UTF-16 code units s[0..n): the value, or the
 * empty array when the text is not a StringIntegerLiteral. */
int* bn_parse(int* s, int n) {
  int i = 0;
  int end = n;
  while (i < end && is_space(s[i])) i++;
  while (end > i && is_space(s[end - 1])) end--;
  if (i == end) return ia_new(1);
  int radix = 10;
  int neg = 0;
  if (end - i >= 2 && s[i] == 48 && (s[i + 1] == 120 || s[i + 1] == 88)) radix = 16;
  else if (end - i >= 2 && s[i] == 48 && (s[i + 1] == 111 || s[i + 1] == 79)) radix = 8;
  else if (end - i >= 2 && s[i] == 48 && (s[i + 1] == 98 || s[i + 1] == 66)) radix = 2;
  if (radix != 10) i = i + 2;
  else if (s[i] == 43 || s[i] == 45) {
    neg = s[i] == 45 ? 1 : 0;
    i++;
  }
  if (i == end) return ia_new(0);
  for (int j = i; j < end; j++)
    if (digit_of(s[j], radix) < 0) return ia_new(0);
  /* bits per digit, rounded up, sizes the limb buffer */
  int per = radix == 2 ? 1 : (radix == 8 ? 3 : 4);
  int* r = ia_new((end - i) * per / 32 + 3);
  int used = 0;
  for (int j = i; j < end; j++) {
    uint64_t c = (uint64_t)digit_of(s[j], radix);
    for (int k = 0; k < used; k++) {
      uint64_t t = (uint64_t)(uint32_t)r[k + 1] * (uint64_t)radix + c;
      r[k + 1] = (int)(uint32_t)t;
      c = t >> 32;
    }
    if (c != 0u) {
      r[used + 1] = (int)(uint32_t)c;
      used++;
    }
  }
  return bn_trim(r, neg);
}

/* The value's digits in radix r (2..36) as character codes, a leading '-'
 * for a negative value; with group set (radix 10), that character between
 * groups of three: ',' for toLocaleString's en-US form, '_' for Node's
 * addNumericalSeparator. */
int* bn_digits(int* a, int radix, int group) {
  int na = nl(a);
  if (na == 0) {
    int* z = ia_new(1);
    z[0] = 48;
    return z;
  }
  /* the largest power of the radix below 2^32, and its digit count */
  uint64_t chunk = (uint64_t)radix;
  int per = 1;
  while (chunk * (uint64_t)radix < 0x100000000u) {
    chunk = chunk * (uint64_t)radix;
    per++;
  }
  int* w = ia_new(na);
  for (int i = 0; i < na; i++) w[i] = (int)limb(a, i);
  int used = na;
  int cap = na * 32 + 2;
  int* rev = ia_new(cap);
  int nd = 0;
  while (used > 0) {
    uint64_t rem = 0u;
    for (int i = used - 1; i >= 0; i--) {
      uint64_t cur = (rem << 32) | (uint64_t)(uint32_t)w[i];
      w[i] = (int)(uint32_t)(cur / chunk);
      rem = cur % chunk;
    }
    while (used > 0 && w[used - 1] == 0) used--;
    for (int k = 0; k < per; k++) {
      if (used == 0 && rem == 0u) break;
      int d = (int)(rem % (uint64_t)radix);
      rev[nd] = d < 10 ? d + 48 : d + 87;
      nd++;
      rem = rem / (uint64_t)radix;
    }
  }
  int commas = group ? (nd - 1) / 3 : 0;
  int total = nd + commas + a[0];
  int* out = ia_new(total);
  int p = 0;
  if (a[0] == 1) {
    out[0] = 45;
    p = 1;
  }
  for (int i = nd - 1; i >= 0; i--) {
    out[p] = rev[i];
    p++;
    if (group && i > 0 && i % 3 == 0) {
      out[p] = group;
      p++;
    }
  }
  return out;
}

/* A hash of the value's limbs and sign (the Map/Set key hash for values
 * outside the i64 fast path). */
uint32_t bn_hash(int* a) {
  uint32_t h = 0x811c9dc5u ^ (uint32_t)a[0];
  int n = ia_len(a);
  for (int i = 1; i < n; i++) {
    h = (h ^ (uint32_t)a[i]) * 0x01000193u;
    h = h ^ (h >> 15);
  }
  return h;
}

int bn_eq(int* a, int* b) {
  int n = ia_len(a);
  if (n != ia_len(b)) return 0;
  for (int i = 0; i < n; i++)
    if (a[i] != b[i]) return 0;
  return 1;
}
`;
