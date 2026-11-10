/* A small seeded PRNG (sfc32 seeded through splitmix32), so a seed
 * reproduces a program exactly on any machine and Node version. */

function splitmix32(a) {
  return () => {
    a |= 0;
    a = (a + 0x9e3779b9) | 0;
    let t = a ^ (a >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t ^= t >>> 15;
    t = Math.imul(t, 0x735a2d97);
    return (t ^ (t >>> 15)) >>> 0;
  };
}

export class Rng {
  constructor(seed) {
    const sm = splitmix32(seed >>> 0);
    this.a = sm();
    this.b = sm();
    this.c = sm();
    this.d = sm();
  }
  /** A uint32. */
  next() {
    let { a, b, c, d } = this;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    this.a = a; this.b = b; this.c = c; this.d = d;
    return t >>> 0;
  }
  /** An integer in [0, n). */
  int(n) {
    return n <= 1 ? 0 : this.next() % n;
  }
  /** An integer in [lo, hi]. */
  range(lo, hi) {
    return lo + this.int(hi - lo + 1);
  }
  chance(p) {
    return this.next() / 4294967296 < p;
  }
  pick(arr) {
    return arr[this.int(arr.length)];
  }
  /** Pick from [[weight, value], ...]. */
  weighted(pairs) {
    const total = pairs.reduce((s, [w]) => s + w, 0);
    let r = this.next() % total;
    for (const [w, v] of pairs) {
      if (r < w) return v;
      r -= w;
    }
    return pairs[pairs.length - 1][1];
  }
  shuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
  /** k distinct elements, in a random order. */
  sample(arr, k) {
    return this.shuffle(arr).slice(0, Math.min(k, arr.length));
  }
}
