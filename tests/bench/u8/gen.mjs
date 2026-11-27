// node tests/bench/u8/gen.mjs <rounds> <outdir> [prefix]
//
// Writes the U8 dynamic-object probes (docs/design/u8-dynamic-speed.md §2, §8)
// with ROUNDS rounds over 1,000 records: 5,000 rounds is 20M operations.
// tests/bench/programs holds the 5,000-round forms with the prefix "u8-"
// (regenerate with `node tests/bench/u8/gen.mjs 5000 tests/bench/programs u8-`);
// tests/bench/u8/bench.mjs generates its own 5,000- and 0-round forms. The
// JavaScript probes (e5, e5own) are run by bench.mjs; scripts/bench-lanes.mjs
// runs the .ts programs only.
import { mkdirSync, writeFileSync } from "node:fs";

const R = Number(process.argv[2]);
const out = process.argv[3];
const prefix = process.argv[4] ?? "";
if (!Number.isInteger(R) || R < 0 || !out) throw new Error("usage: gen.mjs <rounds> <outdir> [prefix]");
mkdirSync(out, { recursive: true });

const recs = `const parts: string[] = [];
for (let i = 0; i < 1000; i++) parts.push('{"a":' + i + ',"b":' + (i * 2) + ',"c":' + (i + 1) + ',"d":' + (i % 7) + '}');
const text = "[" + parts.join(",") + "]";`;
const oneKey = `const parts: string[] = [];
for (let i = 0; i < 1000; i++) parts.push('{"a":' + i + '}');
const xs: any = JSON.parse("[" + parts.join(",") + "]");`;
const readLoop = `let s = 0;
for (let r = 0; r < ${R}; r++) for (let i = 0; i < xs.length; i++) { const p = xs[i]; const a: number = p.a, b: number = p.b, c: number = p.c, d: number = p.d; s += a + b + c + d; }
console.log(s);`;

const P = {
  b1: [
    "U8 b1: typed copy of parsed records (U2b's typed arm), 4 reads per record",
    `interface P { a: number; b: number; c: number; d: number }
${recs}
const xs = JSON.parse(text) as P[];
let s = 0;
for (let r = 0; r < ${R}; r++) for (let i = 0; i < xs.length; i++) { const p = xs[i]!; s += p.a + p.b + p.c + p.d; }
console.log(s);`,
  ],
  b2: [
    "U8 b2: the b1 loop on an any-held array, typed number leaves",
    `${recs}
const xs: any = JSON.parse(text);
${readLoop}`,
  ],
  b2any: [
    "U8 b2any: the b2 loop with its arithmetic in the any world (a box per operator)",
    `${recs}
const xs: any = JSON.parse(text);
let s: any = 0;
for (let r = 0; r < ${R}; r++) for (let i = 0; i < xs.length; i++) { const p = xs[i]; s = s + p.a + p.b + p.c + p.d; }
console.log(s);`,
  ],
  w: [
    "U8 w: 4 dynamic writes per record into existing keys",
    `${recs}
const xs: any = JSON.parse(text);
for (let r = 0; r < ${R}; r++) for (let i = 0; i < xs.length; i++) { const p = xs[i]; p.a = r; p.b = i; p.c = r + i; p.d = 1; }
let s = 0;
for (let i = 0; i < xs.length; i++) { const c: number = xs[i].c; s += c; }
console.log(s);`,
  ],
  w1: [
    "U8 w1: the w loop on a typed copy (w's typed reference)",
    `interface P { a: number; b: number; c: number; d: number }
${recs}
const xs = JSON.parse(text) as P[];
for (let r = 0; r < ${R}; r++) for (let i = 0; i < xs.length; i++) { const p = xs[i]!; p.a = r; p.b = i; p.c = r + i; p.d = 1; }
let s = 0;
for (let i = 0; i < xs.length; i++) { s += xs[i]!.c; }
console.log(s);`,
  ],
  m: [
    "U8 m: dynamic method calls on an any-held object literal",
    `const lib: any = { k: 1, add(x: number, y: number): number { return x + y; } };
let s = 0;
for (let r = 0; r < ${R}; r++) for (let i = 0; i < 4000; i++) { const v: number = lib.add(s, i); s = v % 1000003; }
console.log(s);`,
  ],
  m1: [
    "U8 m1: the m loop on a typed object literal (m's typed reference)",
    `const lib = { k: 1, add(x: number, y: number): number { return x + y; } };
let s = 0;
for (let r = 0; r < ${R}; r++) for (let i = 0; i < 4000; i++) { const v: number = lib.add(s, i); s = v % 1000003; }
console.log(s);`,
  ],
  poly2: [
    "U8 poly2: the b2 loop with one read site seeing 2 key orders",
    `const parts: string[] = [];
for (let i = 0; i < 1000; i++) parts.push(i % 2 === 0 ? '{"a":' + i + ',"b":1,"c":2,"d":' + (i % 7) + '}' : '{"b":1,"a":' + i + ',"c":2,"d":' + (i % 7) + '}');
const text = "[" + parts.join(",") + "]";
const xs: any = JSON.parse(text);
${readLoop}`,
  ],
  poly4: [
    "U8 poly4: the b2 loop with one read site seeing 4 shapes",
    `const parts: string[] = [];
const sh = ['{"a":#,"b":1,"c":2,"d":$}', '{"b":1,"a":#,"c":2,"d":$}', '{"a":#,"b":1,"c":2,"d":$,"e":0}', '{"d":$,"c":2,"b":1,"a":#}'];
for (let i = 0; i < 1000; i++) parts.push(sh[i % 4]!.replace("#", String(i)).replace("$", String(i % 7)));
const text = "[" + parts.join(",") + "]";
const xs: any = JSON.parse(text);
${readLoop}`,
  ],
  hoist: [
    "U8 hoist: xs[i] on an any-held array with the bound hoisted (U8a's index cost)",
    `${oneKey}
const n: number = xs.length;
let s = 0;
for (let r = 0; r < ${R}; r++) for (let i = 0; i < n; i++) { const p = xs[i]; if (p === null) s++; }
console.log(s);`,
  ],
  len: [
    "U8 len: i < xs.length on an any-held array, empty body (U8a's length cost)",
    `${oneKey}
let s = 0;
for (let r = 0; r < ${R}; r++) for (let i = 0; i < xs.length; i++) { s++; }
console.log(s);`,
  ],
};

// U8d: the prototype probes are JavaScript (an ES5 constructor's `this`
// is a script's construct, which TypeScript code refuses, SC1080).
const es5 = `function P(i) { this.a = i; this.b = i * 2; this.c = i + 1; this.d = i % 7; }
P.prototype.f = function () { return 1; };
P.prototype.g = function () { return 2; };
P.prototype.h = function () { return 3; };
P.prototype.k = function () { return 4; };
const xs = [];
for (let i = 0; i < 1000; i++) xs.push(new P(i));
const n = xs.length;
let s = 0;`;
const PJ = {
  e5: [
    "U8 e5: an ES5 constructor's instances, 4 prototype-method reads per record",
    `${es5}
for (let r = 0; r < ${R}; r++) for (let i = 0; i < n; i++) { const p = xs[i]; if (p.f !== undefined) s++; if (p.g !== undefined) s++; if (p.h !== undefined) s++; if (p.k !== undefined) s++; }
console.log(s);`,
  ],
  e5own: [
    "U8 e5own: the e5 loop reading the instances' own keys (e5's reference)",
    `${es5}
for (let r = 0; r < ${R}; r++) for (let i = 0; i < n; i++) { const p = xs[i]; if (p.a !== undefined) s++; if (p.b !== undefined) s++; if (p.c !== undefined) s++; if (p.d !== undefined) s++; }
console.log(s);`,
  ],
};

for (const [name, [what, src]] of Object.entries(P)) writeFileSync(`${out}/${prefix}${name}.ts`, `// ${what}\n${src}\n`);
for (const [name, [what, src]] of Object.entries(PJ)) writeFileSync(`${out}/${prefix}${name}.js`, `// ${what}\n${src}\n`);
