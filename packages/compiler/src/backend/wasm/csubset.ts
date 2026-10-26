/* A compiler for the small subset of C/C++ that V8's src/base/ieee754.cc is
 * written in (ieee754-src.ts holds that file verbatim), to WebAssembly function
 * bodies (SEMANTICS.md S100). It exists so the transcendental Math functions are
 * the upstream text itself, not a hand transcription of it: what this file must get
 * right is the C semantics of a few dozen constructs, each spelled out below, and
 * every one is exercised by the per-function bit-exact rows of
 * test/wasm-ieee754.test.ts against live Node.
 *
 * What it accepts, and what each construct means here (C11/C++17 on an LP64
 * target, which is what V8 is compiled as on Linux x86-64):
 *   - the preprocessor: line splicing, comments, #include (ignored), object- and
 *     function-like #define / #undef with rescanning, #if / #else / #endif over
 *     `defined(X)`, identifiers (an undefined one is 0), `!`, `&&`, `||`. The two
 *     V8 attribute macros the file uses are predefined empty (V8_INLINE,
 *     V8_WARN_UNUSED_RESULT); V8_USE_LIBM_TRIG_FUNCTIONS and V8_CC_MSVC are not
 *     defined, as in Node's build.
 *   - types: double; int / int32_t (i32, signed); uint32_t (i32, unsigned); long
 *     (i64, signed: only as the type of an unsuffixed hexadecimal literal);
 *     uint64_t (i64, unsigned); arrays and pointers of double / int32_t / int
 *     (a GC array reference, never pointer arithmetic). The usual arithmetic
 *     conversions, integer promotions and the signedness of / % >> < <= > >= follow
 *     C exactly over these types; integer arithmetic wraps (two's complement) where
 *     C leaves signed overflow undefined -- the file's own wraparound helpers say
 *     that is what it relies on.
 *   - double -> integer conversion truncates (i32.trunc_f64_s / _u); every such
 *     conversion in ieee754.cc is in range by the source's own guards, and an
 *     out-of-range one would TRAP here (loudly) rather than produce x86's
 *     0x80000000 silently.
 *   - floating-point arithmetic is IEEE-754 binary64, round to nearest, no
 *     contraction (WebAssembly has no fused multiply-add; V8's x86-64 build has
 *     none either). Nothing is folded at compile time except literal values and
 *     reads of `static const` scalars (exactly the stored value).
 *   - `static` / `static const` / `static volatile` scalars with literal
 *     initializers are compile-time constants, and such arrays are immutable module
 *     globals built by array.new_fixed (none is ever written; a write refuses);
 *     `volatile` only stops a C compiler folding, which this compiler never does.
 *     `*const_cast<volatile double*>(&a[i])` is a read of a[i].
 *   - std::numeric_limits<double>::signaling_NaN() is 0x7ff4000000000000 and
 *     quiet_NaN() 0x7ff8000000000000, the bits libstdc++ and libc++ give them on
 *     x86-64 (__builtin_nans / __builtin_nan) and the bits Node's Math.log(-1) /
 *     Math.log10(-1) measurably return; both are emitted as exact bit patterns
 *     (i64.const + f64.reinterpret_i64), never through a JavaScript NaN.
 *     infinity() is +Infinity.
 *   - statements: blocks with scoping, declarations, if/else, while, do/while,
 *     for (with comma expressions), switch (case/default, fall-through, break),
 *     break, return, and a `goto` to a label EARLIER in an enclosing block (the one
 *     use, __kernel_rem_pio2's `goto recompute`, becomes a wasm loop).
 *   - calls: the file's own functions (compiled on first use), fabs, sqrt and floor
 *     (the exact f64 instructions), scalbn (supplied as C by ieee754.ts), and the
 *     V8 helpers static_cast, base::bit_cast, NegateWithWraparound and
 *     SubWithWraparound.
 * Anything else throws a CSubsetError naming the construct and line, while the
 * module is being built -- an internal error, never a wrong answer. The input is
 * fixed text, so whether it throws does not depend on the program being compiled;
 * test/wasm-ieee754.test.ts compiles every function. */

import { Code } from "./code.js";
import { F64, I32, I64, type ModuleBuilder, type ValType } from "./module.js";

export class CSubsetError extends Error {}

/* ── lexer ─────────────────────────────────────────────────────────────────── */

interface Tok {
  k: "id" | "num" | "p" | "str" | "nl";
  v: string;
  line: number;
  /** whitespace (or a comment) precedes this token on its line */
  sp: boolean;
  /** macro names this token must not be expanded as again (the hide set) */
  hide?: ReadonlySet<string>;
}

const PUNCS = [
  "<<=", ">>=", "...",
  "::", "->", "++", "--", "<<", ">>", "<=", ">=", "==", "!=", "&&", "||",
  "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "##",
  "(", ")", "[", "]", "{", "}", ";", ",", "?", ":", "=", "<", ">", "+", "-", "*", "/",
  "%", "&", "|", "^", "~", "!", ".", "#",
];

function lex(src: string): Tok[] {
  const text = src.replace(/\\\r?\n/g, ""); // line splicing (lines shift; only diagnostics care)
  const out: Tok[] = [];
  let line = 1;
  let i = 0;
  let sp = false;
  const n = text.length;
  while (i < n) {
    const ch = text[i]!;
    if (ch === "\n") {
      out.push({ k: "nl", v: "\n", line, sp });
      line++;
      i++;
      sp = false;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\r" || ch === "\f" || ch === "\v") {
      i++;
      sp = true;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      while (i < n && text[i] !== "\n") i++;
      sp = true;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end < 0) throw new CSubsetError(`line ${line}: unterminated comment`);
      for (let j = i; j < end; j++) if (text[j] === "\n") line++;
      i = end + 2;
      sp = true;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_]/.test(text[j]!)) j++;
      out.push({ k: "id", v: text.slice(i, j), line, sp });
      i = j;
      sp = false;
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(text[i + 1] ?? ""))) {
      // a pp-number: digits, letters, '.', digit separators, and an exponent sign
      let j = i + 1;
      while (j < n) {
        const c = text[j]!;
        if (/[A-Za-z0-9_.']/.test(c)) j++;
        else if ((c === "+" || c === "-") && /[eEpP]/.test(text[j - 1]!)) j++; // C11 6.4.8
        else break;
      }
      out.push({ k: "num", v: text.slice(i, j), line, sp });
      i = j;
      sp = false;
      continue;
    }
    if (ch === '"') {
      // only #include's operand; the parser refuses a string anywhere else
      const end = text.indexOf('"', i + 1);
      if (end < 0 || text.slice(i, end).includes("\n")) throw new CSubsetError(`line ${line}: unterminated string`);
      out.push({ k: "str", v: text.slice(i, end + 1), line, sp });
      i = end + 1;
      sp = false;
      continue;
    }
    if (ch === "'") throw new CSubsetError(`line ${line}: character literals are outside the subset`);
    const p = PUNCS.find((q) => text.startsWith(q, i));
    if (p === undefined) throw new CSubsetError(`line ${line}: unexpected character ${JSON.stringify(ch)}`);
    out.push({ k: "p", v: p, line, sp });
    i += p.length;
    sp = false;
  }
  out.push({ k: "nl", v: "\n", line, sp });
  return out;
}

/* ── preprocessor ──────────────────────────────────────────────────────────── */

interface Macro {
  params: string[] | null; // null: object-like
  body: Tok[];
}

type PpItem = Tok | { define: string; macro: Macro | null };

function isEvent(x: PpItem): x is { define: string; macro: Macro | null } {
  return (x as { define?: string }).define !== undefined;
}

function preprocess(src: string, predefined: Record<string, string>): Tok[] {
  const toks = lex(src);
  const lines: Tok[][] = [[]];
  for (const t of toks) {
    if (t.k === "nl") lines.push([]);
    else lines[lines.length - 1]!.push(t);
  }
  const defined = new Set<string>(Object.keys(predefined));
  const items: PpItem[] = [];
  for (const [name, body] of Object.entries(predefined)) {
    items.push({ define: name, macro: { params: null, body: lex(body).filter((t) => t.k !== "nl") } });
  }
  // #if stack: whether the current group is live, whether a branch was taken
  const conds: { live: boolean; taken: boolean; parentLive: boolean }[] = [];
  const live = (): boolean => conds.length === 0 || conds[conds.length - 1]!.live;
  const evalIf = (ts: Tok[], line: number): boolean => {
    let i = 0;
    const prim = (): number => {
      const t = ts[i++];
      if (t === undefined) throw new CSubsetError(`line ${line}: truncated #if`);
      if (t.v === "!") return prim() ? 0 : 1;
      if (t.v === "(") {
        const v = or();
        if (ts[i++]?.v !== ")") throw new CSubsetError(`line ${line}: #if: expected )`);
        return v;
      }
      if (t.v === "defined") {
        const paren = ts[i]?.v === "(";
        if (paren) i++;
        const name = ts[i++];
        if (name?.k !== "id") throw new CSubsetError(`line ${line}: #if defined: expected a name`);
        if (paren && ts[i++]?.v !== ")") throw new CSubsetError(`line ${line}: #if defined: expected )`);
        return defined.has(name.v) ? 1 : 0;
      }
      if (t.k === "num") return Number(intLiteral(t.v, line).v); // suffixes as C reads them; a float refuses
      if (t.k === "id") {
        if (defined.has(t.v)) throw new CSubsetError(`line ${line}: #if over a defined macro's value is outside the subset`);
        return 0;
      }
      throw new CSubsetError(`line ${line}: #if: unexpected ${t.v}`);
    };
    const and = (): number => {
      let v = prim();
      while (ts[i]?.v === "&&") {
        i++;
        const r = prim();
        v = v && r ? 1 : 0;
      }
      return v;
    };
    const or = (): number => {
      let v = and();
      while (ts[i]?.v === "||") {
        i++;
        const r = and();
        v = v || r ? 1 : 0;
      }
      return v;
    };
    const v = or();
    if (i !== ts.length) throw new CSubsetError(`line ${line}: #if: trailing tokens`);
    return v !== 0;
  };
  for (const ln of lines) {
    if (ln.length === 0) continue;
    if (ln[0]!.v !== "#") {
      if (live()) items.push(...ln);
      continue;
    }
    const d = ln[1]?.v ?? "";
    const line = ln[0]!.line;
    const rest = ln.slice(2);
    if (d === "if" || d === "ifdef" || d === "ifndef") {
      const parentLive = live();
      let v = false;
      if (parentLive) {
        if (d === "if") v = evalIf(rest, line);
        else v = defined.has(rest[0]?.v ?? "") === (d === "ifdef");
      }
      conds.push({ live: parentLive && v, taken: v, parentLive });
      continue;
    }
    if (d === "else" || d === "elif") {
      const c = conds[conds.length - 1];
      if (c === undefined) throw new CSubsetError(`line ${line}: #${d} without #if`);
      const v = !c.taken && (d === "else" || (c.parentLive && evalIf(rest, line)));
      c.live = c.parentLive && v;
      c.taken = c.taken || v;
      continue;
    }
    if (d === "endif") {
      if (conds.pop() === undefined) throw new CSubsetError(`line ${line}: #endif without #if`);
      continue;
    }
    if (!live()) continue;
    if (d === "include" || d === "pragma") continue;
    if (d === "define") {
      const name = rest[0];
      if (name?.k !== "id") throw new CSubsetError(`line ${line}: #define: expected a name`);
      let params: string[] | null = null;
      let at = 1;
      if (rest[1]?.v === "(" && !rest[1].sp) {
        params = [];
        at = 2;
        while (rest[at]?.v !== ")") {
          const p = rest[at++];
          if (p?.k !== "id") throw new CSubsetError(`line ${line}: #define ${name.v}: bad parameter list`);
          params.push(p.v);
          if (rest[at]?.v === ",") at++;
        }
        at++;
      }
      const body = rest.slice(at);
      if (body.some((t) => t.v === "#" || t.v === "##")) {
        throw new CSubsetError(`line ${line}: #define ${name.v}: # and ## are outside the subset`);
      }
      defined.add(name.v);
      items.push({ define: name.v, macro: { params, body } });
      continue;
    }
    if (d === "undef") {
      const name = rest[0]?.v ?? "";
      defined.delete(name);
      items.push({ define: name, macro: null });
      continue;
    }
    throw new CSubsetError(`line ${line}: #${d} is outside the subset`);
  }
  if (conds.length > 0) throw new CSubsetError("unterminated #if");
  return expandAll(items);
}

function expandAll(items: PpItem[]): Tok[] {
  const macros = new Map<string, Macro>();
  const work = items.slice();
  const out: Tok[] = [];
  const expandList = (toks: Tok[]): Tok[] => {
    // expand a macro argument completely, with the macro table as it stands
    const res: Tok[] = [];
    const w = toks.slice();
    let i = 0;
    while (i < w.length) {
      const r = tryExpand(w, i);
      if (r) continue;
      res.push(w[i]!);
      i++;
    }
    return res;
  };
  /** If w[i] starts a macro invocation, replace it in place by its expansion
   * and return true (the caller rescans at i). */
  const tryExpand = (w: PpItem[], i: number): boolean => {
    const t = w[i]!;
    if (isEvent(t) || t.k !== "id") return false;
    const m = macros.get(t.v);
    if (m === undefined || t.hide?.has(t.v)) return false;
    const hide = new Set(t.hide ?? []);
    hide.add(t.v);
    if (m.params === null) {
      w.splice(i, 1, ...m.body.map((b) => ({ ...b, line: t.line, hide })));
      return true;
    }
    const open = w[i + 1];
    if (open === undefined || isEvent(open) || open.v !== "(") return false;
    const args: Tok[][] = [[]];
    let depth = 0;
    let j = i + 2;
    for (;; j++) {
      const a = w[j];
      if (a === undefined) throw new CSubsetError(`line ${t.line}: unterminated call of macro ${t.v}`);
      if (isEvent(a)) throw new CSubsetError(`line ${t.line}: a directive inside the arguments of ${t.v}`);
      if (a.v === "(") depth++;
      if (a.v === ")") {
        if (depth === 0) break;
        depth--;
      }
      if (a.v === "," && depth === 0) {
        args.push([]);
        continue;
      }
      args[args.length - 1]!.push(a);
    }
    if (args.length === 1 && args[0]!.length === 0 && m.params.length === 0) args.length = 0;
    if (args.length !== m.params.length) {
      throw new CSubsetError(`line ${t.line}: macro ${t.v} takes ${m.params.length} arguments, got ${args.length}`);
    }
    const expanded = args.map(expandList);
    const body: Tok[] = [];
    for (const b of m.body) {
      const p = b.k === "id" ? m.params.indexOf(b.v) : -1;
      if (p >= 0) body.push(...expanded[p]!);
      else body.push({ ...b, line: t.line, hide });
    }
    w.splice(i, j - i + 1, ...body);
    return true;
  };
  let i = 0;
  while (i < work.length) {
    const t = work[i]!;
    if (isEvent(t)) {
      if (t.macro === null) macros.delete(t.define);
      else macros.set(t.define, t.macro);
      i++;
      continue;
    }
    if (tryExpand(work, i)) continue;
    out.push(t);
    i++;
  }
  return out;
}

/* ── AST ───────────────────────────────────────────────────────────────────── */

/** C scalar and reference types: int/int32_t = "int", uint32_t = "uint",
 * long = "i64", uint64_t = "u64"; "fa"/"ia" are double / int32 arrays. */
export type CT = "double" | "int" | "uint" | "i64" | "u64" | "fa" | "ia";

type Expr =
  | { k: "num"; t: CT; v: number | bigint; line: number }
  | { k: "id"; name: string; line: number }
  | { k: "bin"; op: string; a: Expr; b: Expr; line: number }
  | { k: "un"; op: string; a: Expr; line: number }
  | { k: "asg"; op: string; a: Expr; b: Expr; line: number }
  | { k: "inc"; pre: boolean; d: 1 | -1; a: Expr; line: number }
  | { k: "cond"; c: Expr; a: Expr; b: Expr; line: number }
  | { k: "call"; name: string; args: Expr[]; line: number }
  | { k: "idx"; a: Expr; i: Expr; line: number }
  | { k: "cast"; t: CT; a: Expr; line: number }
  | { k: "bitcast"; t: CT; a: Expr; line: number }
  | { k: "wrap"; op: "neg" | "sub"; t: CT; args: Expr[]; line: number }
  | { k: "lim"; v: "snan" | "qnan" | "inf"; line: number }
  | { k: "comma"; a: Expr; b: Expr; line: number };

interface Declarator {
  name: string;
  t: CT;
  /** array length for a local array; -1 for `[]` sized by its initializer */
  arr?: number;
  init?: Expr;
  list?: Expr[];
}

type Stmt =
  | { k: "block"; body: Stmt[] }
  | { k: "decl"; isStatic: boolean; decls: Declarator[]; line: number }
  | { k: "expr"; e: Expr }
  | { k: "if"; c: Expr; t: Stmt; e?: Stmt }
  | { k: "while"; c: Expr; body: Stmt }
  | { k: "do"; body: Stmt; c: Expr }
  | { k: "for"; init: Stmt | undefined; c: Expr | undefined; step: Expr | undefined; body: Stmt }
  | { k: "switch"; e: Expr; clauses: { labels: (number | "default")[]; body: Stmt[] }[]; line: number }
  | { k: "break"; line: number }
  | { k: "ret"; e?: Expr; line: number }
  | { k: "goto"; label: string; line: number }
  | { k: "label"; label: string; s: Stmt }
  | { k: "empty" };

export interface CFunc {
  name: string;
  ret: CT;
  params: { name: string; t: CT }[];
  body: Stmt[];
  line: number;
}

interface CConst {
  t: CT;
  v?: number | bigint;
  vals?: (number | bigint)[];
}

export interface CUnit {
  funcs: Map<string, CFunc>;
  globals: Map<string, CConst>;
}

/* ── parser ────────────────────────────────────────────────────────────────── */

const TYPE_NAMES: Record<string, CT> = {
  double: "double",
  int: "int",
  int32_t: "int",
  uint32_t: "uint",
  uint64_t: "u64",
};
const SPECIFIERS = new Set(["static", "const", "volatile", "inline"]);

function intLiteral(text: string, line: number): { t: CT; v: number | bigint } {
  const m = /^(0[xX][0-9a-fA-F']+|[0-9']+)([uUlL]*)$/.exec(text);
  if (!m) throw new CSubsetError(`line ${line}: bad integer literal ${text}`);
  const digits = m[1]!.replace(/'/g, "");
  const suffix = m[2]!.toLowerCase();
  const v = BigInt(digits);
  const hex = /^0x/i.test(digits);
  const unsigned = suffix.includes("u");
  const long = suffix.includes("l");
  if (digits.length > 1 && digits[0] === "0" && !hex) throw new CSubsetError(`line ${line}: octal literals are outside the subset`);
  // C11 6.4.4.1: the first type in the literal's list that holds the value
  const fitsInt = v <= 0x7fffffffn;
  const fitsUint = v <= 0xffffffffn;
  const fitsLong = v <= 0x7fffffffffffffffn;
  if (v > 0xffffffffffffffffn) throw new CSubsetError(`line ${line}: literal ${text} out of range`);
  if (!long && !unsigned && fitsInt) return { t: "int", v: Number(v) };
  if (!long && unsigned && fitsUint) return { t: "uint", v: Number(v) };
  if (!long && !unsigned && hex && fitsUint) return { t: "uint", v: Number(v) };
  if (!unsigned && fitsLong) return { t: "i64", v };
  if (unsigned || hex) return { t: "u64", v };
  throw new CSubsetError(`line ${line}: literal ${text} has no type in the subset`);
}

/** 2^e as a double, exactly, for -1074 <= e <= 1023. */
function pow2(e: number): number {
  const f = new Float64Array(1);
  const u = new BigUint64Array(f.buffer);
  if (e >= -1022) u[0] = BigInt(e + 1023) << 52n;
  else u[0] = 1n << BigInt(e + 1074);
  return f[0]!;
}

function floatLiteral(text: string, line: number): number {
  const t = text.replace(/'/g, "");
  if (/[fFlL]$/.test(t)) throw new CSubsetError(`line ${line}: float suffixes are outside the subset (${text})`);
  const hx = /^0[xX]([0-9a-fA-F]*)(?:\.([0-9a-fA-F]*))?[pP]([+-]?[0-9]+)$/.exec(t);
  if (hx) {
    const int = hx[1] ?? "";
    const frac = hx[2] ?? "";
    const mant = BigInt("0x" + (int + frac || "0"));
    if (mant >= 1n << 53n) throw new CSubsetError(`line ${line}: hex float ${text} has more than 53 significant bits`);
    const e = Number(hx[3]) - 4 * frac.length;
    if (mant === 0n) return 0;
    // mant * 2^e, exact: mant < 2^53 and the result is a normal number here
    const r = Number(mant) * pow2(e);
    if (!Number.isFinite(r) || r < pow2(-1022)) throw new CSubsetError(`line ${line}: hex float ${text} out of the normal range`);
    return r;
  }
  if (!/^([0-9]+\.?[0-9]*|\.[0-9]+)([eE][+-]?[0-9]+)?$/.test(t)) throw new CSubsetError(`line ${line}: bad floating literal ${text}`);
  // Number() rounds a decimal literal correctly (to nearest, ties to even), as
  // C requires of a conforming compiler and as clang does.
  return Number(t);
}

function numLiteral(text: string, line: number): Expr {
  const t = text.replace(/'/g, "");
  const isFloat = /^0[xX]/.test(t) ? /[pP]/.test(t) : /[.eE]/.test(t);
  if (isFloat) return { k: "num", t: "double", v: floatLiteral(text, line), line };
  const r = intLiteral(text, line);
  return { k: "num", t: r.t, v: r.v, line };
}

class Parser {
  private i = 0;
  constructor(private readonly t: Tok[]) {}

  private peek(o = 0): Tok | undefined {
    return this.t[this.i + o];
  }
  private line(): number {
    return (this.t[this.i] ?? this.t[this.t.length - 1])?.line ?? 0;
  }
  private err(msg: string): never {
    throw new CSubsetError(`line ${this.line()}: ${msg} (at ${JSON.stringify(this.peek()?.v ?? "EOF")})`);
  }
  private is(v: string, o = 0): boolean {
    return this.peek(o)?.v === v && this.peek(o)?.k !== "num";
  }
  private eat(v: string): boolean {
    if (this.is(v)) {
      this.i++;
      return true;
    }
    return false;
  }
  private expect(v: string): void {
    if (!this.eat(v)) this.err(`expected ${JSON.stringify(v)}`);
  }
  private ident(): string {
    const t = this.peek();
    if (t?.k !== "id") this.err("expected a name");
    this.i++;
    return t.v;
  }

  /** At a declaration's start: specifiers then a type name. */
  private atDecl(): boolean {
    let o = 0;
    while (this.peek(o)?.k === "id" && SPECIFIERS.has(this.peek(o)!.v)) o++;
    const t = this.peek(o);
    return t?.k === "id" && Object.hasOwn(TYPE_NAMES, t.v);
  }

  /** Specifiers and the base type; returns [type, isStatic]. A `static`
   * VARIABLE must also be `const` or `volatile` (staticVar checks that): this
   * subset holds statics as compile-time constants, which mutable static state
   * is not. */
  private declSpec(): [CT, boolean, boolean] {
    let isStatic = false;
    let qualified = false;
    const spec = (): void => {
      const v = this.peek()!.v;
      if (v === "static") isStatic = true;
      if (v === "const" || v === "volatile") qualified = true;
      this.i++;
    };
    while (this.peek()?.k === "id" && SPECIFIERS.has(this.peek()!.v)) spec();
    const name = this.ident();
    const t = TYPE_NAMES[name];
    if (t === undefined) this.err(`type ${name} is outside the subset`);
    while (this.peek()?.k === "id" && SPECIFIERS.has(this.peek()!.v)) spec();
    return [t, isStatic, qualified];
  }

  private staticVar(isStatic: boolean, qualified: boolean): void {
    if (isStatic && !qualified) {
      this.err("a static variable that is neither const nor volatile (mutable static state) is outside the subset");
    }
  }

  /** A type name inside <...> of a cast. */
  private typeName(): CT {
    while (this.peek()?.k === "id" && SPECIFIERS.has(this.peek()!.v)) this.i++;
    const name = this.ident();
    let t = TYPE_NAMES[name];
    if (t === undefined) this.err(`type ${name} is outside the subset`);
    if (this.eat("*")) t = t === "double" ? "fa" : t === "int" ? "ia" : this.err("pointer type outside the subset");
    return t;
  }

  unit(): CUnit {
    const funcs = new Map<string, CFunc>();
    const globals = new Map<string, CConst>();
    let depth = 0;
    while (this.i < this.t.length) {
      if (this.eat("namespace")) {
        if (this.peek()?.k === "id") this.i++;
        this.expect("{");
        depth++;
        continue;
      }
      if (this.eat("}")) {
        if (depth-- === 0) this.err("unbalanced }");
        continue;
      }
      if (!this.atDecl()) this.err("expected a declaration");
      const line = this.line();
      const [t, isStatic, qualified] = this.declSpec();
      const name = this.ident();
      const fresh = (n: string): void => {
        if (funcs.has(n) || globals.has(n)) this.err(`a second file-scope definition of ${n}`);
      };
      if (this.is("(")) {
        const params = this.params();
        if (this.eat(";")) continue; // a prototype
        fresh(name);
        const body = this.block();
        funcs.set(name, { name, ret: t, params, body, line });
        continue;
      }
      // a file-scope variable: only constant scalars/arrays
      if (!isStatic) this.err("a non-static file-scope variable");
      this.staticVar(isStatic, qualified);
      const decls = this.declRest(t, name);
      for (const d of decls) {
        fresh(d.name);
        globals.set(d.name, constOf(d, line));
      }
    }
    if (depth !== 0) this.err("unbalanced namespace braces");
    return { funcs, globals };
  }

  private params(): { name: string; t: CT }[] {
    this.expect("(");
    const ps: { name: string; t: CT }[] = [];
    if (this.eat(")")) return ps;
    for (;;) {
      let [t] = this.declSpec();
      if (this.eat("*")) t = t === "double" ? "fa" : t === "int" ? "ia" : this.err("pointer parameter type");
      const name = this.ident();
      ps.push({ name, t });
      if (this.eat(")")) return ps;
      this.expect(",");
    }
  }

  /** Declarators after the first name, through the `;`. */
  private declRest(t: CT, first: string): Declarator[] {
    const out: Declarator[] = [];
    let name = first;
    for (;;) {
      const d: Declarator = { name, t };
      if (this.eat("[")) {
        if (this.eat("]")) d.arr = -1;
        else {
          const n = this.expr();
          if (n.k !== "num" || typeof n.v !== "number") this.err("array length must be a literal");
          d.arr = n.v;
          this.expect("]");
        }
      }
      if (this.eat("=")) {
        if (d.arr !== undefined) {
          this.expect("{");
          d.list = [];
          while (!this.eat("}")) {
            d.list.push(this.assign());
            if (!this.eat(",")) {
              this.expect("}");
              break;
            }
          }
        } else d.init = this.assign();
      }
      out.push(d);
      if (this.eat(";")) return out;
      this.expect(",");
      if (this.eat("*")) this.err("pointer declarators outside parameters");
      name = this.ident();
    }
  }

  private block(): Stmt[] {
    this.expect("{");
    const body: Stmt[] = [];
    while (!this.eat("}")) body.push(this.stmt());
    return body;
  }

  private stmt(): Stmt {
    const line = this.line();
    if (this.is("{")) return { k: "block", body: this.block() };
    if (this.atDecl()) {
      const [t, isStatic, qualified] = this.declSpec();
      this.staticVar(isStatic, qualified);
      const name = this.ident();
      return { k: "decl", isStatic, decls: this.declRest(t, name), line };
    }
    if (this.eat(";")) return { k: "empty" };
    if (this.eat("if")) {
      this.expect("(");
      const c = this.expr();
      this.expect(")");
      const t = this.stmt();
      if (this.eat("else")) return { k: "if", c, t, e: this.stmt() };
      return { k: "if", c, t };
    }
    if (this.eat("while")) {
      this.expect("(");
      const c = this.expr();
      this.expect(")");
      return { k: "while", c, body: this.stmt() };
    }
    if (this.eat("do")) {
      const body = this.stmt();
      if (!this.eat("while")) this.err("expected while");
      this.expect("(");
      const c = this.expr();
      this.expect(")");
      this.expect(";");
      return { k: "do", body, c };
    }
    if (this.eat("for")) {
      this.expect("(");
      let init: Stmt | undefined;
      if (this.atDecl()) {
        const [t, isStatic, qualified] = this.declSpec();
        this.staticVar(isStatic, qualified);
        init = { k: "decl", isStatic, decls: this.declRest(t, this.ident()), line };
      } else if (!this.eat(";")) {
        init = { k: "expr", e: this.expr() };
        this.expect(";");
      }
      const c = this.is(";") ? undefined : this.expr();
      this.expect(";");
      const step = this.is(")") ? undefined : this.expr();
      this.expect(")");
      return { k: "for", init, c, step, body: this.stmt() };
    }
    if (this.eat("switch")) {
      this.expect("(");
      const e = this.expr();
      this.expect(")");
      this.expect("{");
      const clauses: { labels: (number | "default")[]; body: Stmt[] }[] = [];
      while (!this.eat("}")) {
        if (this.is("case") || this.is("default")) {
          let label: number | "default";
          if (this.eat("default")) label = "default";
          else {
            this.i++;
            const v = this.expr();
            const n = v.k === "num" && typeof v.v === "number" ? v.v : this.err("case label must be an integer literal");
            label = n;
          }
          this.expect(":");
          const last = clauses[clauses.length - 1];
          if (last !== undefined && last.body.length === 0) last.labels.push(label);
          else clauses.push({ labels: [label], body: [] });
          continue;
        }
        const last = clauses[clauses.length - 1];
        if (last === undefined) this.err("a statement before the first case label");
        last.body.push(this.stmt());
      }
      return { k: "switch", e, clauses, line };
    }
    if (this.eat("break")) {
      this.expect(";");
      return { k: "break", line };
    }
    if (this.is("continue")) this.err("continue is outside the subset");
    if (this.eat("return")) {
      if (this.eat(";")) return { k: "ret", line };
      const e = this.expr();
      this.expect(";");
      return { k: "ret", e, line };
    }
    if (this.eat("goto")) {
      const label = this.ident();
      this.expect(";");
      return { k: "goto", label, line };
    }
    if (this.peek()?.k === "id" && this.is(":", 1)) {
      const label = this.ident();
      this.expect(":");
      return { k: "label", label, s: this.stmt() };
    }
    const e = this.expr();
    this.expect(";");
    return { k: "expr", e };
  }

  /* expressions, by C precedence */

  expr(): Expr {
    let e = this.assign();
    while (this.is(",")) {
      const line = this.line();
      this.i++;
      e = { k: "comma", a: e, b: this.assign(), line };
    }
    return e;
  }

  private assign(): Expr {
    const a = this.cond();
    const op = this.peek();
    if (op?.k === "p" && ["=", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "<<=", ">>="].includes(op.v)) {
      this.i++;
      if (a.k !== "id" && a.k !== "idx") this.err("assignment to a non-lvalue");
      return { k: "asg", op: op.v, a, b: this.assign(), line: op.line };
    }
    return a;
  }

  private cond(): Expr {
    const c = this.binary(0);
    if (this.is("?")) {
      const line = this.line();
      this.i++;
      const a = this.expr();
      this.expect(":");
      const b = this.cond();
      return { k: "cond", c, a, b, line };
    }
    return c;
  }

  private static readonly LEVELS: string[][] = [
    ["||"], ["&&"], ["|"], ["^"], ["&"], ["==", "!="], ["<", ">", "<=", ">="], ["<<", ">>"], ["+", "-"], ["*", "/", "%"],
  ];

  private binary(level: number): Expr {
    if (level === Parser.LEVELS.length) return this.unary();
    let a = this.binary(level + 1);
    for (;;) {
      const op = this.peek();
      if (op?.k !== "p" || !Parser.LEVELS[level]!.includes(op.v)) return a;
      this.i++;
      a = { k: "bin", op: op.v, a, b: this.binary(level + 1), line: op.line };
    }
  }

  private unary(): Expr {
    const t = this.peek();
    const line = this.line();
    if (t?.k === "p") {
      if (t.v === "-" || t.v === "+" || t.v === "!" || t.v === "~") {
        this.i++;
        return { k: "un", op: t.v, a: this.unary(), line };
      }
      if (t.v === "++" || t.v === "--") {
        this.i++;
        const a = this.unary();
        if (a.k !== "id") this.err("++/-- on a non-variable");
        return { k: "inc", pre: true, d: t.v === "++" ? 1 : -1, a, line };
      }
      if (t.v === "*") {
        // only `*const_cast<volatile double*>(&lvalue)`: a volatile read
        this.i++;
        if (!this.eat("const_cast")) this.err("pointer dereference outside the subset");
        this.expect("<");
        this.typeName();
        this.expect(">");
        this.expect("(");
        this.expect("&");
        const lv = this.unary();
        this.expect(")");
        if (lv.k !== "idx" && lv.k !== "id") this.err("address of a non-lvalue");
        return lv;
      }
      if (t.v === "(" && this.peek(1)?.k === "id" && Object.hasOwn(TYPE_NAMES, this.peek(1)!.v)) {
        this.err("C-style casts are outside the subset");
      }
    }
    return this.postfix(this.primary());
  }

  private postfix(e: Expr): Expr {
    for (;;) {
      const line = this.line();
      if (this.eat("[")) {
        const i = this.expr();
        this.expect("]");
        e = { k: "idx", a: e, i, line };
        continue;
      }
      if (this.is("++") || this.is("--")) {
        const d = this.peek()!.v === "++" ? 1 : -1;
        this.i++;
        if (e.k !== "id") this.err("++/-- on a non-variable");
        e = { k: "inc", pre: false, d, a: e, line };
        continue;
      }
      return e;
    }
  }

  private templArgType(): CT {
    this.expect("<");
    const t = this.typeName();
    this.expect(">");
    return t;
  }

  private callArgs(): Expr[] {
    this.expect("(");
    const args: Expr[] = [];
    if (this.eat(")")) return args;
    for (;;) {
      args.push(this.assign());
      if (this.eat(")")) return args;
      this.expect(",");
    }
  }

  private primary(): Expr {
    const t = this.peek();
    const line = this.line();
    if (t === undefined) this.err("unexpected end");
    if (t.k === "num") {
      this.i++;
      return numLiteral(t.v, line);
    }
    if (this.eat("(")) {
      const e = this.expr();
      this.expect(")");
      return e;
    }
    if (t.k !== "id") this.err("expected an expression");
    this.i++;
    switch (t.v) {
      case "static_cast": {
        const to = this.templArgType();
        const [a] = this.oneArg();
        return { k: "cast", t: to, a, line };
      }
      case "base": {
        this.expect("::");
        if (!this.eat("bit_cast")) this.err("only base::bit_cast is in the subset");
        const to = this.templArgType();
        const [a] = this.oneArg();
        return { k: "bitcast", t: to, a, line };
      }
      case "std": {
        this.expect("::");
        if (!this.eat("numeric_limits")) this.err("only std::numeric_limits is in the subset");
        if (this.templArgType() !== "double") this.err("numeric_limits of a non-double");
        this.expect("::");
        const which = this.ident();
        this.expect("(");
        this.expect(")");
        if (which === "signaling_NaN") return { k: "lim", v: "snan", line };
        if (which === "quiet_NaN") return { k: "lim", v: "qnan", line };
        if (which === "infinity") return { k: "lim", v: "inf", line };
        return this.err(`numeric_limits<double>::${which} is outside the subset`);
      }
      case "NegateWithWraparound": {
        const ty = this.templArgType();
        return { k: "wrap", op: "neg", t: ty, args: this.callArgs(), line };
      }
      case "false":
      case "true":
        return { k: "num", t: "int", v: t.v === "true" ? 1 : 0, line };
      case "SubWithWraparound":
        return { k: "wrap", op: "sub", t: "int", args: this.callArgs(), line };
      default:
        break;
    }
    if (this.is("(")) return { k: "call", name: t.v, args: this.callArgs(), line };
    return { k: "id", name: t.v, line };
  }

  private oneArg(): [Expr] {
    const args = this.callArgs();
    if (args.length !== 1) this.err("expected one argument");
    return [args[0]!];
  }
}

/** The compile-time value of a `static` declarator's initializer. */
function constOf(d: Declarator, line: number): CConst {
  const val = (e: Expr): number | bigint => {
    if (e.k === "num") return convertConst(e.v, e.t, d.t);
    if (e.k === "un" && e.op === "-" && e.a.k === "num") {
      if (e.a.t === "double") return convertConst(-(e.a.v as number), "double", d.t);
      return convertConst(-BigInt(e.a.v), e.a.t, d.t);
    }
    throw new CSubsetError(`line ${line}: ${d.name}: initializer is not a literal`);
  };
  if (d.arr !== undefined) {
    // tables live in i32 or f64 GC arrays: any other element type would be stored wrongly
    if (d.t !== "int" && d.t !== "double") {
      throw new CSubsetError(`line ${line}: static table ${d.name} of ${d.t} (only int/int32_t and double tables are in the subset)`);
    }
    if (d.list === undefined) throw new CSubsetError(`line ${line}: static array ${d.name} without initializer`);
    if (d.arr >= 0 && d.arr !== d.list.length) throw new CSubsetError(`line ${line}: ${d.name}: partial initializer`);
    return { t: d.t, vals: d.list.map(val) };
  }
  if (d.init === undefined) throw new CSubsetError(`line ${line}: static ${d.name} without initializer`);
  return { t: d.t, v: val(d.init) };
}

function convertConst(v: number | bigint, from: CT, to: CT): number | bigint {
  if (to === "double") return typeof v === "bigint" ? Number(v) : v;
  if (from === "double") throw new CSubsetError(`a floating initializer for an integer constant`);
  const b = BigInt(v);
  if (to === "int") return Number(BigInt.asIntN(32, b));
  if (to === "uint") return Number(BigInt.asUintN(32, b));
  return BigInt.asUintN(64, b);
}

export function parseC(src: string, predefined: Record<string, string>): CUnit {
  return new Parser(preprocess(src, predefined)).unit();
}

/* ── code generation ───────────────────────────────────────────────────────── */

const isInt = (t: CT): boolean => t === "int" || t === "uint" || t === "i64" || t === "u64";
const is64 = (t: CT): boolean => t === "i64" || t === "u64";
const isUnsigned = (t: CT): boolean => t === "uint" || t === "u64";

/** C11 6.3.1.8 over this subset's types. */
function usual(a: CT, b: CT, line: number): CT {
  if (!(a === "double" || isInt(a)) || !(b === "double" || isInt(b))) {
    throw new CSubsetError(`line ${line}: arithmetic on an array`);
  }
  if (a === "double" || b === "double") return "double";
  if (a === "u64" || b === "u64") return "u64";
  if (a === "i64" || b === "i64") return "i64"; // long holds every int and uint
  if (a === "uint" || b === "uint") return "uint";
  return "int";
}

type Sym =
  | { kind: "local"; idx: number; t: CT }
  | { kind: "const"; c: CConst };

interface Frame {
  /** what `break` targets (loop exits, switch exits), or a goto label's loop */
  kind: "break" | "label" | "plain";
  label?: string;
}

/** Compiles a CUnit's functions into a ModuleBuilder on demand. */
export class CCompiler {
  private readonly idx = new Map<string, number>();
  private readonly tabGlobals = new Map<CConst, number>();
  readonly fa: number;
  readonly ia: number;
  private readonly pending: string[] = [];

  constructor(
    private readonly mb: ModuleBuilder,
    private readonly unit: CUnit,
    private readonly prefix: string,
  ) {
    this.fa = mb.arrayType(F64, true);
    this.ia = mb.arrayType(I32, true);
  }

  valType(t: CT): ValType {
    switch (t) {
      case "double":
        return F64;
      case "int":
      case "uint":
        return I32;
      case "i64":
      case "u64":
        return I64;
      case "fa":
        return { kind: "ref", nullable: true, typeIndex: this.fa };
      case "ia":
        return { kind: "ref", nullable: true, typeIndex: this.ia };
    }
  }

  /** The wasm function index of C function `name`, declared on first use; its
   * body (and the bodies of everything it calls) is compiled before this returns. */
  fn(name: string): number {
    const got = this.idx.get(name);
    if (got !== undefined) return got;
    const idx = this.declare(name);
    while (this.pending.length > 0) this.compile(this.pending.shift()!);
    return idx;
  }

  private declare(name: string): number {
    const got = this.idx.get(name);
    if (got !== undefined) return got;
    const f = this.unit.funcs.get(name);
    if (f === undefined) throw new CSubsetError(`no C function ${name}`);
    const ty = this.mb.funcType(f.params.map((p) => this.valType(p.t)), [this.valType(f.ret)]);
    const idx = this.mb.declareFunc(ty, `${this.prefix}${name}`);
    this.idx.set(name, idx);
    this.pending.push(name);
    return idx;
  }

  /** A `static const` table as an immutable module global (array.new_fixed). */
  tableGlobal(c: CConst): number {
    const got = this.tabGlobals.get(c);
    if (got !== undefined) return got;
    const T = c.t === "double" ? this.fa : this.ia;
    const vals = c.vals!;
    const g = this.mb.addGlobal({ kind: "ref", nullable: false, typeIndex: T }, false, (w) => {
      for (const v of vals) {
        if (c.t === "double") {
          w.u8(0x44);
          w.f64(v as number);
        } else {
          w.u8(0x41);
          w.sleb(Number(v) | 0);
        }
      }
      w.u8(0xfb);
      w.uleb(0x08);
      w.uleb(T);
      w.uleb(vals.length);
    });
    this.tabGlobals.set(c, g);
    return g;
  }

  private compile(name: string): void {
    const f = this.unit.funcs.get(name)!;
    const g = new FnGen(this, this.unit, f, (n) => this.declare(n));
    this.mb.setBody(this.idx.get(name)!, g.locals, g.code.bytes());
  }
}

class FnGen {
  readonly code = new Code();
  readonly locals: ValType[] = [];
  private readonly scopes: Map<string, Sym>[] = [];
  private readonly frames: Frame[] = [];
  private readonly nparams: number;

  constructor(
    private readonly cc: CCompiler,
    private readonly unit: CUnit,
    private readonly f: CFunc,
    private readonly callee: (name: string) => number,
  ) {
    this.nparams = f.params.length;
    const top = new Map<string, Sym>();
    f.params.forEach((p, i) => top.set(p.name, { kind: "local", idx: i, t: p.t }));
    this.scopes.push(top);
    this.block(f.body, false);
    // every path of a value-returning function returns; falling off its end is
    // undefined behaviour in C and a trap here
    this.code.unreachable(); // (the module writer appends the body's final end)
  }

  private err(line: number, msg: string): never {
    throw new CSubsetError(`${this.f.name}, line ${line}: ${msg}`);
  }

  private newLocal(t: CT): number {
    this.locals.push(this.cc.valType(t));
    return this.nparams + this.locals.length - 1;
  }

  private lookup(name: string, line: number): Sym {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const s = this.scopes[i]!.get(name);
      if (s !== undefined) return s;
    }
    const g = this.unit.globals.get(name);
    if (g !== undefined) return { kind: "const", c: g };
    return this.err(line, `unknown name ${name}`);
  }

  /* ── statements ── */

  private block(body: Stmt[], scoped = true): void {
    if (scoped) this.scopes.push(new Map());
    // labels in this block that a goto targets: the statements from the label on
    // become one wasm loop the goto branches back to
    for (let i = 0; i < body.length; i++) {
      const s = body[i]!;
      if (s.k === "label") {
        const c = this.code;
        c.loop();
        this.frames.push({ kind: "label", label: s.label });
        this.stmt(s.s);
        for (let j = i + 1; j < body.length; j++) this.stmt(body[j]!);
        this.frames.pop();
        c.end();
        break;
      }
      this.stmt(s);
    }
    if (scoped) this.scopes.pop();
  }

  private depthOf(pred: (f: Frame) => boolean, line: number, what: string): number {
    for (let i = this.frames.length - 1; i >= 0; i--) {
      if (pred(this.frames[i]!)) return this.frames.length - 1 - i;
    }
    return this.err(line, `${what} outside any target`);
  }

  private stmt(s: Stmt): void {
    const c = this.code;
    switch (s.k) {
      case "block":
        this.block(s.body);
        return;
      case "empty":
        return;
      case "decl":
        this.decl(s);
        return;
      case "expr":
        this.effect(s.e);
        return;
      case "if":
        this.cond(s.c);
        c.ifVoid();
        this.frames.push({ kind: "plain" });
        this.scoped(s.t);
        if (s.e !== undefined) {
          c.else_();
          this.scoped(s.e);
        }
        this.frames.pop();
        c.end();
        return;
      case "while":
        c.block();
        this.frames.push({ kind: "break" });
        c.loop();
        this.frames.push({ kind: "plain" });
        this.cond(s.c);
        c.i32Eqz();
        c.brIf(1);
        this.scoped(s.body);
        c.br(0);
        this.frames.pop();
        c.end();
        this.frames.pop();
        c.end();
        return;
      case "do":
        c.block();
        this.frames.push({ kind: "break" });
        c.loop();
        this.frames.push({ kind: "plain" });
        this.scoped(s.body);
        this.cond(s.c);
        c.brIf(0);
        this.frames.pop();
        c.end();
        this.frames.pop();
        c.end();
        return;
      case "for":
        this.scopes.push(new Map());
        if (s.init !== undefined) this.stmt(s.init);
        c.block();
        this.frames.push({ kind: "break" });
        c.loop();
        this.frames.push({ kind: "plain" });
        if (s.c !== undefined) {
          this.cond(s.c);
          c.i32Eqz();
          c.brIf(1);
        }
        this.scoped(s.body);
        if (s.step !== undefined) this.effect(s.step);
        c.br(0);
        this.frames.pop();
        c.end();
        this.frames.pop();
        c.end();
        this.scopes.pop();
        return;
      case "switch": {
        const t = this.typeOf(s.e);
        if (t !== "int" && t !== "uint") this.err(s.line, "switch over a non-int");
        const v = this.newLocal("int");
        this.emit(s.e);
        c.localSet(v);
        const m = s.clauses.length;
        c.block();
        this.frames.push({ kind: "break" });
        for (let i = 0; i < m; i++) {
          c.block();
          this.frames.push({ kind: "plain" });
        }
        // dispatch: br i lands at clause i's statements
        let def = m; // no default: leave the switch
        s.clauses.forEach((cl, i) => {
          for (const l of cl.labels) {
            if (l === "default") {
              def = i;
              continue;
            }
            c.localGet(v);
            c.i32Const(l | 0);
            c.i32Eq();
            c.brIf(i);
          }
        });
        c.br(def);
        for (let i = 0; i < m; i++) {
          this.frames.pop();
          c.end();
          this.scopes.push(new Map());
          for (const st of s.clauses[i]!.body) this.stmt(st);
          this.scopes.pop();
        }
        this.frames.pop();
        c.end();
        return;
      }
      case "break":
        c.br(this.depthOf((f) => f.kind === "break", s.line, "break"));
        return;
      case "goto":
        c.br(this.depthOf((f) => f.kind === "label" && f.label === s.label, s.line, `goto ${s.label} (only a backward goto to an enclosing block's label is in the subset)`));
        return;
      case "label":
        this.err(0, `label ${s.label} not directly in a block`);
        return;
      case "ret":
        if (s.e === undefined) this.err(s.line, "return without a value");
        this.emitAs(s.e, this.f.ret);
        c.return_();
        return;
    }
  }

  /** A sub-statement in its own scope (C99 6.8.4: selection and iteration
   * bodies are blocks). */
  private scoped(s: Stmt): void {
    this.scopes.push(new Map());
    this.stmt(s);
    this.scopes.pop();
  }

  private decl(s: Extract<Stmt, { k: "decl" }>): void {
    const scope = this.scopes[this.scopes.length - 1]!;
    for (const d of s.decls) {
      if (s.isStatic) {
        scope.set(d.name, { kind: "const", c: constOf(d, s.line) });
        continue;
      }
      if (d.arr !== undefined) {
        if (d.list !== undefined || d.arr < 0) this.err(s.line, `initialized local array ${d.name}`);
        const t: CT = d.t === "double" ? "fa" : d.t === "int" ? "ia" : this.err(s.line, `array of ${d.t}`);
        const l = this.newLocal(t);
        // a fresh zeroed array per execution of the declaration; ieee754.cc writes
        // every element it reads before reading it
        this.code.i32Const(d.arr);
        this.code.arrayNewDefault(t === "fa" ? this.cc.fa : this.cc.ia);
        this.code.localSet(l);
        scope.set(d.name, { kind: "local", idx: l, t });
        continue;
      }
      const l = this.newLocal(d.t);
      // the name is in scope from its declarator on (C11 6.2.1p7)
      scope.set(d.name, { kind: "local", idx: l, t: d.t });
      if (d.init !== undefined) {
        this.emitAs(d.init, d.t);
        this.code.localSet(l);
      }
    }
  }

  /* ── expressions ── */

  typeOf(e: Expr): CT {
    switch (e.k) {
      case "num":
        return e.t;
      case "lim":
        return "double";
      case "id": {
        const s = this.lookup(e.name, e.line);
        if (s.kind === "local") return s.t;
        if (s.c.vals !== undefined) return s.c.t === "double" ? "fa" : "ia";
        return s.c.t;
      }
      case "bin":
        if (["==", "!=", "<", ">", "<=", ">=", "&&", "||"].includes(e.op)) return "int";
        if (e.op === "<<" || e.op === ">>") return this.typeOf(e.a);
        return usual(this.typeOf(e.a), this.typeOf(e.b), e.line);
      case "un":
        if (e.op === "!") return "int";
        return this.typeOf(e.a);
      case "asg":
      case "inc":
        return this.typeOf(e.a);
      case "cond": {
        const a = this.typeOf(e.a);
        const b = this.typeOf(e.b);
        return a === b ? a : usual(a, b, e.line);
      }
      case "call": {
        if (e.name === "fabs" || e.name === "sqrt" || e.name === "floor") return "double";
        const f = this.unit.funcs.get(e.name);
        if (f === undefined) return this.err(e.line, `unknown function ${e.name}`);
        return f.ret;
      }
      case "idx": {
        const a = this.typeOf(e.a);
        if (a === "fa") return "double";
        if (a === "ia") return "int";
        return this.err(e.line, "subscript of a non-array");
      }
      case "cast":
      case "bitcast":
      case "wrap":
        return e.t;
      case "comma":
        return this.typeOf(e.b);
    }
  }

  /** Converts the value on the stack from `from` to `to` (C11 6.3.1). */
  private conv(from: CT, to: CT, line: number): void {
    const c = this.code;
    if (from === to) return;
    if (to === "double") {
      if (from === "int") c.f64ConvertI32S();
      else if (from === "uint") c.f64ConvertI32U();
      else if (from === "i64") c.f64ConvertI64S();
      else if (from === "u64") c.f64ConvertI64U();
      else this.err(line, `conversion of ${from} to double`);
      return;
    }
    if (from === "double") {
      if (to === "int") c.i32TruncF64S();
      else if (to === "uint") c.i32TruncF64U();
      else if (to === "i64") c.i64TruncF64S();
      else if (to === "u64") c.i64TruncF64U();
      else this.err(line, `conversion of double to ${to}`);
      return;
    }
    if (!isInt(from) || !isInt(to)) this.err(line, `conversion of ${from} to ${to}`);
    if (is64(from) && !is64(to)) c.i32WrapI64();
    else if (!is64(from) && is64(to)) {
      if (isUnsigned(from)) c.i64ExtendI32U();
      else c.i64ExtendI32S();
    }
  }

  emitAs(e: Expr, to: CT): void {
    const t = this.emit(e);
    this.conv(t, to, e.line);
  }

  /** Pushes an i32 that is nonzero exactly when `e` is true. */
  private cond(e: Expr): void {
    const t = this.emit(e);
    const c = this.code;
    if (t === "int" || t === "uint") return;
    if (is64(t)) {
      c.i64Eqz();
      c.i32Eqz();
      return;
    }
    if (t === "double") {
      c.f64Const(0);
      c.f64Ne();
      return;
    }
    this.err(e.line, "an array as a condition");
  }

  /** A 0/1 truth value. */
  private truth(e: Expr): void {
    this.cond(e);
    const t = this.typeOf(e);
    if (t === "int" || t === "uint") {
      this.code.i32Eqz();
      this.code.i32Eqz();
    }
  }

  /** Evaluates `e` for its effects only. */
  private effect(e: Expr): void {
    if (e.k === "asg") {
      this.assign(e, false);
      return;
    }
    if (e.k === "inc") {
      this.incr(e, false);
      return;
    }
    if (e.k === "comma") {
      this.effect(e.a);
      this.effect(e.b);
      return;
    }
    this.emit(e);
    this.code.drop();
  }

  private constPush(t: CT, v: number | bigint): void {
    const c = this.code;
    if (t === "double") c.f64Const(Number(v));
    else if (t === "int" || t === "uint") c.i32Const(Number(BigInt.asIntN(32, BigInt(v))));
    else c.i64Const(BigInt.asIntN(64, BigInt(v)));
  }

  /** Emits `e`, returning its C type. */
  emit(e: Expr): CT {
    const c = this.code;
    switch (e.k) {
      case "num":
        this.constPush(e.t, e.v);
        return e.t;
      case "lim":
        if (e.v === "inf") c.f64Const(Infinity);
        else {
          c.i64Const(e.v === "snan" ? 0x7ff4000000000000n : 0x7ff8000000000000n);
          c.f64ReinterpretI64();
        }
        return "double";
      case "id": {
        const s = this.lookup(e.name, e.line);
        if (s.kind === "local") {
          c.localGet(s.idx);
          return s.t;
        }
        if (s.c.vals !== undefined) {
          c.globalGet(this.cc.tableGlobal(s.c));
          return s.c.t === "double" ? "fa" : "ia";
        }
        this.constPush(s.c.t, s.c.v!);
        return s.c.t;
      }
      case "comma":
        this.effect(e.a);
        return this.emit(e.b);
      case "asg":
        return this.assign(e, true);
      case "inc":
        return this.incr(e, true);
      case "cast": {
        this.emitAs(e.a, e.t);
        return e.t;
      }
      case "bitcast": {
        const from = this.emit(e.a);
        if (e.t === "u64" && from === "double") c.i64ReinterpretF64();
        else if (e.t === "double" && is64(from)) c.f64ReinterpretI64();
        else this.err(e.line, `bit_cast<${e.t}> of ${from}`);
        return e.t;
      }
      case "wrap": {
        // V8's overflowing-math.h: computed in the unsigned type, converted back
        if (e.t !== "int") this.err(e.line, "wraparound helper over a non-int32");
        if (e.op === "neg") {
          if (e.args.length !== 1) this.err(e.line, "NegateWithWraparound takes one argument");
          c.i32Const(0);
          this.emitAs(e.args[0]!, "int");
          c.i32Sub();
        } else {
          if (e.args.length !== 2) this.err(e.line, "SubWithWraparound takes two arguments");
          this.emitAs(e.args[0]!, "int");
          this.emitAs(e.args[1]!, "int");
          c.i32Sub();
        }
        return "int";
      }
      case "idx": {
        const at = this.emit(e.a);
        if (at !== "fa" && at !== "ia") this.err(e.line, "subscript of a non-array");
        this.emitIndex(e.i);
        c.arrayGet(at === "fa" ? this.cc.fa : this.cc.ia);
        return at === "fa" ? "double" : "int";
      }
      case "cond": {
        const t = this.typeOf(e);
        this.cond(e.c);
        c.ifResult(this.cc.valType(t));
        this.emitAs(e.a, t);
        c.else_();
        this.emitAs(e.b, t);
        c.end();
        return t;
      }
      case "call":
        return this.call(e);
      case "un": {
        if (e.op === "!") {
          this.cond(e.a);
          c.i32Eqz();
          return "int";
        }
        const t = this.typeOf(e.a);
        if (e.op === "+") return this.emit(e.a);
        if (e.op === "-") {
          if (t === "double") {
            this.emit(e.a);
            c.f64Neg();
            return t;
          }
          if (!isInt(t)) this.err(e.line, "negation of an array");
          this.constPush(t, 0);
          this.emit(e.a);
          if (is64(t)) c.i64Sub();
          else c.i32Sub();
          return t;
        }
        // ~
        if (!isInt(t)) this.err(e.line, "~ of a non-integer");
        this.emit(e.a);
        this.constPush(t, -1);
        if (is64(t)) c.i64Xor();
        else c.i32Xor();
        return t;
      }
      case "bin":
        return this.binop(e);
    }
  }

  private emitIndex(i: Expr): void {
    const t = this.emit(i);
    if (t !== "int" && t !== "uint") this.err(i.line, "a non-int subscript");
  }

  /** The value of the arithmetic `a op b` after the usual conversions, as `t`. */
  private arith(op: string, t: CT, line: number): void {
    const c = this.code;
    const w = is64(t);
    const u = isUnsigned(t);
    if (t === "double") {
      if (op === "+") c.f64Add();
      else if (op === "-") c.f64Sub();
      else if (op === "*") c.f64Mul();
      else if (op === "/") c.f64Div();
      else this.err(line, `${op} on doubles`);
      return;
    }
    switch (op) {
      case "+":
        if (w) c.i64Add();
        else c.i32Add();
        return;
      case "-":
        if (w) c.i64Sub();
        else c.i32Sub();
        return;
      case "*":
        if (w) c.i64Mul();
        else c.i32Mul();
        return;
      case "/":
        if (w && u) c.i64DivU();
        else if (w) this.err(line, "signed 64-bit division");
        else if (u) c.i32DivU();
        else c.i32DivS();
        return;
      case "%":
        if (w && u) c.i64RemU();
        else if (w) this.err(line, "signed 64-bit remainder");
        else if (u) c.i32RemU();
        else c.i32RemS();
        return;
      case "&":
        if (w) c.i64And();
        else c.i32And();
        return;
      case "|":
        if (w) c.i64Or();
        else c.i32Or();
        return;
      case "^":
        if (w) c.i64Xor();
        else c.i32Xor();
        return;
      case "<<":
        if (w) c.i64Shl();
        else c.i32Shl();
        return;
      case ">>":
        if (w && u) c.i64ShrU();
        else if (w) c.i64ShrS();
        else if (u) c.i32ShrU();
        else c.i32ShrS();
        return;
    }
    this.err(line, `operator ${op}`);
  }

  private binop(e: Extract<Expr, { k: "bin" }>): CT {
    const c = this.code;
    const op = e.op;
    if (op === "&&" || op === "||") {
      this.cond(e.a);
      c.ifResult(I32);
      if (op === "&&") {
        this.truth(e.b);
        c.else_();
        c.i32Const(0);
      } else {
        c.i32Const(1);
        c.else_();
        this.truth(e.b);
      }
      c.end();
      return "int";
    }
    const ta = this.typeOf(e.a);
    const tb = this.typeOf(e.b);
    if (op === "<<" || op === ">>") {
      if (!isInt(ta) || !isInt(tb)) this.err(e.line, "shift of a non-integer");
      this.checkShiftCount(e.b, ta, e.line);
      this.emit(e.a);
      this.emitAs(e.b, is64(ta) ? "u64" : "int");
      this.arith(op, ta, e.line);
      return ta;
    }
    const t = usual(ta, tb, e.line);
    this.emitAs(e.a, t);
    this.emitAs(e.b, t);
    if (["==", "!=", "<", ">", "<=", ">="].includes(op)) {
      this.compare(op, t);
      return "int";
    }
    if ((op === "&" || op === "|" || op === "^" || op === "%") && t === "double") this.err(e.line, `${op} on a double`);
    this.arith(op, t, e.line);
    return t;
  }

  /** A shift count known at compile time must be in [0, width): C leaves any
   * other undefined, and wasm would take it modulo the width. (A count known
   * only at run time is ieee754.cc's own business: every one it computes is in
   * range by its guards.) */
  private checkShiftCount(b: Expr, t: CT, line: number): void {
    const v = this.constInt(b);
    if (v === null) return;
    const width = is64(t) ? 64n : 32n;
    if (v < 0n || v >= width) this.err(line, `a shift by ${v} of a ${width}-bit value (undefined behaviour in C)`);
  }

  /** The value of an integer constant expression this subset can see through:
   * a literal, a static const scalar, unary minus, + - *. Null otherwise. */
  private constInt(e: Expr): bigint | null {
    if (e.k === "num") return typeof e.v === "bigint" ? e.v : Number.isInteger(e.v) && e.t !== "double" ? BigInt(e.v) : null;
    if (e.k === "id") {
      const s = this.lookup(e.name, e.line);
      if (s.kind === "const" && s.c.v !== undefined && s.c.t !== "double") return BigInt(s.c.v);
      return null;
    }
    if (e.k === "un" && e.op === "-") {
      const a = this.constInt(e.a);
      return a === null ? null : -a;
    }
    if (e.k === "bin" && (e.op === "+" || e.op === "-" || e.op === "*")) {
      const a = this.constInt(e.a);
      const b = this.constInt(e.b);
      if (a === null || b === null) return null;
      return e.op === "+" ? a + b : e.op === "-" ? a - b : a * b;
    }
    return null;
  }

  private compare(op: string, t: CT): void {
    const c = this.code;
    if (t === "double") {
      if (op === "==") c.f64Eq();
      else if (op === "!=") c.f64Ne();
      else if (op === "<") c.f64Lt();
      else if (op === ">") c.f64Gt();
      else if (op === "<=") c.f64Le();
      else c.f64Ge();
      return;
    }
    const u = isUnsigned(t);
    if (is64(t)) {
      if (op === "==") c.i64Eq();
      else if (op === "!=") c.i64Ne();
      else if (op === "<" && u) c.i64LtU();
      else if (op === "<") c.i64LtS();
      else if (op === ">" && u) c.i64GtU();
      else if (op === "<=" && u) c.i64LeU();
      else if (op === ">=" && u) c.i64GeU();
      else if (op === ">=") c.i64GeS();
      else throw new CSubsetError(`signed 64-bit ${op}`);
      return;
    }
    if (op === "==") c.i32Eq();
    else if (op === "!=") c.i32Ne();
    else if (op === "<") {
      if (u) c.i32LtU();
      else c.i32LtS();
    } else if (op === ">") {
      if (u) c.i32GtU();
      else c.i32GtS();
    } else if (op === "<=") {
      if (u) c.i32LeU();
      else c.i32LeS();
    } else if (u) c.i32GeU();
    else c.i32GeS();
  }

  /** `a op= b` / `a = b`; leaves the assigned value when `value`. */
  private assign(e: Extract<Expr, { k: "asg" }>, value: boolean): CT {
    const c = this.code;
    const tt = this.typeOf(e.a);
    const bop = e.op === "=" ? null : e.op.slice(0, -1);
    const rhs = (): void => {
      if (bop === null) {
        this.emitAs(e.b, tt);
        return;
      }
      // the target's value is already on the stack
      const tb = this.typeOf(e.b);
      if (bop === "<<" || bop === ">>") {
        this.checkShiftCount(e.b, tt, e.line);
        this.emitAs(e.b, is64(tt) ? "u64" : "int");
        this.arith(bop, tt, e.line);
        return;
      }
      const t = usual(tt, tb, e.line);
      this.conv(tt, t, e.line);
      this.emitAs(e.b, t);
      this.arith(bop, t, e.line);
      this.conv(t, tt, e.line);
    };
    if (e.a.k === "id") {
      const s = this.lookup(e.a.name, e.line);
      if (s.kind !== "local") this.err(e.line, `assignment to the static constant ${e.a.name} (statics are compile-time constants here)`);
      if (bop !== null) c.localGet(s.idx);
      rhs();
      if (value) c.localTee(s.idx);
      else c.localSet(s.idx);
      return tt;
    }
    if (e.a.k !== "idx") this.err(e.line, "assignment to a non-lvalue");
    const at = this.emit(e.a.a);
    if (at !== "fa" && at !== "ia") this.err(e.line, "subscript of a non-array");
    if (e.a.a.k === "id") {
      const s = this.lookup(e.a.a.name, e.line);
      if (s.kind === "const") this.err(e.line, `assignment into the constant table ${e.a.a.name}`);
    }
    const T = at === "fa" ? this.cc.fa : this.cc.ia;
    if (bop === null) {
      this.emitIndex(e.a.i);
      rhs();
    } else {
      const r = this.newLocal(at);
      const i = this.newLocal("int");
      c.localTee(r);
      this.emitIndex(e.a.i);
      c.localTee(i);
      c.localGet(r);
      c.localGet(i);
      c.arrayGet(T);
      rhs();
    }
    if (value) {
      const tmp = this.newLocal(tt);
      c.localTee(tmp);
      c.arraySet(T);
      c.localGet(tmp);
    } else c.arraySet(T);
    return tt;
  }

  private incr(e: Extract<Expr, { k: "inc" }>, value: boolean): CT {
    const c = this.code;
    if (e.a.k !== "id") this.err(e.line, "++/-- on a non-variable");
    const s = this.lookup(e.a.name, e.line);
    if (s.kind === "const") this.err(e.line, `++/-- on the static constant ${e.a.name} (statics are compile-time constants here)`);
    if (s.t !== "int" && s.t !== "uint") this.err(e.line, "++/-- on a non-int variable");
    if (value && !e.pre) c.localGet(s.idx);
    c.localGet(s.idx);
    c.i32Const(e.d);
    c.i32Add();
    if (value && e.pre) c.localTee(s.idx);
    else c.localSet(s.idx);
    return s.t;
  }

  private call(e: Extract<Expr, { k: "call" }>): CT {
    const c = this.code;
    if (e.name === "fabs" || e.name === "sqrt" || e.name === "floor") {
      if (e.args.length !== 1) this.err(e.line, `${e.name} takes one argument`);
      this.emitAs(e.args[0]!, "double");
      if (e.name === "fabs") c.f64Abs();
      else if (e.name === "sqrt") c.f64Sqrt();
      else c.f64Floor();
      return "double";
    }
    const f = this.unit.funcs.get(e.name);
    if (f === undefined) this.err(e.line, `unknown function ${e.name}`);
    if (f.params.length !== e.args.length) this.err(e.line, `${e.name} takes ${f.params.length} arguments`);
    e.args.forEach((a, i) => {
      const pt = f.params[i]!.t;
      const at = this.typeOf(a);
      if ((pt === "fa" || pt === "ia") && at !== pt) this.err(e.line, `argument ${i + 1} of ${e.name}: ${at} for ${pt}`);
      this.emitAs(a, pt);
    });
    c.call(this.callee(e.name));
    return f.ret;
  }
}
