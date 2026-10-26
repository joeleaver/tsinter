// Board #239: Buffer.alloc / Buffer.allocUnsafe validate the size as Node's
// validateNumber(size, "size", 0, kMaxLength) does on every lane —
// ERR_OUT_OF_RANGE with Node's Received rendering (NaN, Infinity, the
// underscore-grouped big integers and their exponent quirks) — after every
// argument evaluates and before the fill runs; fractional sizes truncate.
function show(label: string, f: () => Buffer): void {
  try {
    const b = f();
    console.log(label, "ok", b.length, b.toString("hex"));
  } catch (e) {
    const x = e as NodeJS.ErrnoException;
    console.log(label, x.name, String(x.code), x.message);
  }
}
let calls = 0;
const sz = (n: number): number => { calls++; return n; };
show("a0", () => Buffer.alloc(0));
show("a3", () => Buffer.alloc(3));
show("a2.5", () => Buffer.alloc(2.5));
show("neg", () => Buffer.alloc(-1));
show("negfrac", () => Buffer.alloc(-0.5));
show("negzero", () => Buffer.alloc(-0));
show("nan", () => Buffer.alloc(NaN));
show("inf", () => Buffer.alloc(Infinity));
show("ninf", () => Buffer.alloc(-Infinity));
show("big", () => Buffer.alloc(2 ** 53));
show("bigneg", () => Buffer.alloc(-(2 ** 40)));
show("negbig", () => Buffer.alloc(-5000000000));
show("1e21", () => Buffer.alloc(1e21));
show("fill", () => Buffer.alloc(4, 7));
show("fillstr", () => Buffer.alloc(5, "ab"));
show("fillhex", () => Buffer.alloc(4, "0a0b", "hex"));
show("fillbuf", () => Buffer.alloc(3, Buffer.from([1, 2])));
show("fillneg", () => Buffer.alloc(-2, sz(1)));
console.log("calls", calls);
show("u3", () => Buffer.allocUnsafe(3).fill(0));
show("uneg", () => Buffer.allocUnsafe(-3));
show("unan", () => Buffer.allocUnsafe(NaN));
show("sz", () => Buffer.alloc(sz(2), sz(9)));
console.log("calls", calls);
function f(n: number): Buffer { return Buffer.alloc(n); }
show("fn", () => f(Number("x")));
