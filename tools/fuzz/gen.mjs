/* The program generator: a seed in, one small deterministic TypeScript
 * program out. Each program is a handful of SNIPPETS, one per bug-prone
 * area (records, spreads, any/unknown, unions, classes, closures, errors,
 * formatting), that share earlier snippets' values, and every snippet
 * ends in OBSERVERS (console.log, JSON.stringify, Object.keys, for-in,
 * `in`, inspect, ...). Every printed line starts with a label
 * `#<snippet>:<observer>` so a divergent line names what diverged.
 *
 * The programs use erasable TypeScript only (Node runs them with plain
 * type stripping, as the corpus harness does), type-check under the
 * repo's tsconfig.base.json (strict, exactOptionalPropertyTypes,
 * noUncheckedIndexedAccess), never read the clock or randomness, never
 * let an exception escape, and finish in milliseconds. */
import ts from "typescript";
import { Rng } from "./prng.mjs";

export const AREAS = ["rec", "spread", "dyn", "union", "class", "closure", "error", "format", "control"];

const IDENT_KEYS = ["a", "b", "c", "x", "y", "id", "name", "kind", "val", "next", "size", "tag"];
const QUOTED_KEYS = ["1", "10", "0", "2", "-1", "k-1", "%p", "a b", "01", "1.5", "$x", "_"];
const NUMS = ["0", "1", "2", "3", "7", "42", "-1", "-0", "1.5", "0.1", "100", "255", "1e21", "1e-7", "123456789",
  "NaN", "Infinity", "-Infinity", "2 ** 53", "0.1 + 0.2", "Number.MAX_SAFE_INTEGER", "5e-324", "-2.5", "1000000", "0.5", "1 / 3"];
const STRS = ["", "a", "hello", "it's", 'say "hi"', "both ' and \"", "back`tick'\"", "line\nbreak", "tab\there", "héllo", "😀",
  "\u0000", "back\\slash", "  pad  ", "123", "true", "null", "undefined", "x".repeat(30), "ß", "İ", "\ud800", "a,b,c", "Z", "-0", "1e3"];
const NUMERIC_STRS = ["  12  ", "0x1f", "1e3", "12px", "", ".5", "-0", "Infinity", "1_000", "0b101", "08", "  ", "3.14abc", "-12.5e-1", "0o17", "1e400"];

const isIdent = (k) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k);
const keyDecl = (k) => (isIdent(k) ? k : JSON.stringify(k));
const acc = (e, k) => (isIdent(k) ? `${e}.${k}` : `${e}[${JSON.stringify(k)}]`);

class Program {
  constructor(seed, opts = {}) {
    this.rng = new Rng(seed);
    this.seed = seed;
    this.opts = opts;
    this.n = 0;
    this.lines = [];
    this.snips = [];
    this.recs = []; // { v, t } record-typed values later snippets reuse
    this.numArrs = []; // number[] variables
    this.usesInspect = false;
    this.usesFormat = false;
  }
  fresh(p) {
    return `${p}${++this.n}`;
  }
  emit(...ls) {
    this.lines.push(...ls);
  }
  P(sid, obs, ...exprs) {
    return `console.log(${JSON.stringify(`#${sid}:${obs}`)}${exprs.map((e) => ", " + e).join("")});`;
  }

  /* ── types and values ─────────────────────────────────────────────── */

  primType(depth = 0) {
    const r = this.rng;
    const t = r.weighted([
      [5, { k: "num" }],
      [5, { k: "str" }],
      [2, { k: "bool" }],
      [2, { k: "arr", el: { k: "num" } }],
      [1, { k: "arr", el: { k: "str" } }],
      [depth < 1 ? 2 : 0, "rec"],
      [1, { k: "nul" }],
    ]);
    return t === "rec" ? { k: "rec", inline: true, fields: this.fields(depth + 1, 1, 3) } : t;
  }
  fields(depth, lo, hi) {
    const r = this.rng;
    const n = r.range(lo, hi);
    const pool = r.chance(0.35) ? [...IDENT_KEYS, ...QUOTED_KEYS] : IDENT_KEYS;
    const keys = r.sample(pool, n);
    return keys.map((k) => {
      const opt = r.chance(0.45);
      return { k, t: this.primType(depth), opt, undef: opt && r.chance(0.35) };
    });
  }
  ts(t) {
    switch (t.k) {
      case "num": return "number";
      case "str": return "string";
      case "bool": return "boolean";
      case "nul": return "string | null";
      case "arr": return `${this.ts(t.el)}[]`;
      case "rec": return t.inline ? `{ ${t.fields.map((f) => this.fieldDecl(f)).join("; ")} }` : t.name;
    }
    throw new Error("ts " + t.k);
  }
  fieldDecl(f) {
    return `${keyDecl(f.k)}${f.opt ? "?" : ""}: ${this.ts(f.t)}${f.undef ? " | undefined" : ""}`;
  }
  num() {
    return this.rng.pick(NUMS);
  }
  str() {
    return JSON.stringify(this.rng.pick(STRS));
  }
  val(t) {
    const r = this.rng;
    switch (t.k) {
      case "num": return this.num();
      case "str": return this.str();
      case "bool": return r.pick(["true", "false"]);
      case "nul": return r.chance(0.5) ? "null" : this.str();
      case "arr": {
        const len = r.weighted([[4, r.range(0, 3)], [2, r.range(4, 8)], [1, r.range(9, 30)]]);
        return `[${Array.from({ length: len }, () => this.val(t.el)).join(", ")}]`;
      }
      case "rec": return this.recLit(t);
    }
    throw new Error("val " + t.k);
  }
  /** An object literal of record type t: every required field, a random
   * subset of the optional ones, in declared or shuffled order. */
  recLit(t, forceOrder) {
    const r = this.rng;
    let fs = t.fields.filter((f) => !f.opt || r.chance(0.5));
    // S041: a shape with no optional field renders its declared order
    // whatever the literal's spelling (registered), so only shapes with
    // one get a shuffled literal unless known divergences are wanted.
    const mayShuffle = this.opts.includeKnown || t.fields.some((f) => f.opt);
    if (mayShuffle && (forceOrder ?? r.chance(0.5))) fs = r.shuffle(fs);
    return `{ ${fs.map((f) => `${keyDecl(f.k)}: ${f.undef && r.chance(0.3) ? "undefined" : this.val(f.t)}`).join(", ")} }`;
  }
  declRec(sid) {
    const t = { k: "rec", name: `R${sid}`, fields: this.fields(0, 2, 5) };
    if (this.rng.chance(0.3)) this.emit(`interface ${t.name} { ${t.fields.map((f) => this.fieldDecl(f)).join("; ")} }`);
    else this.emit(`type ${t.name} = { ${t.fields.map((f) => this.fieldDecl(f)).join("; ")} };`);
    return t;
  }
  /** A record value to work on: an earlier snippet's, or a new one. */
  someRec(sid) {
    if (this.recs.length > 0 && this.rng.chance(0.6)) return this.rng.pick(this.recs);
    const t = this.declRec(sid);
    const v = this.fresh("o");
    this.emit(`const ${v}: ${t.name} = ${this.recLit(t)};`);
    const rec = { v, t };
    this.recs.push(rec);
    return rec;
  }

  /* ── observers ────────────────────────────────────────────────────── */

  observe(sid, e, opts = {}) {
    const r = this.rng;
    const keys = opts.keys ?? [];
    const probe = keys.length > 0 ? r.pick(keys) : "a";
    const all = [
      [6, () => this.P(sid, "log", e)],
      [5, () => this.P(sid, "json", `JSON.stringify(${e})`)],
      [5, () => this.P(sid, "keys", `Object.keys(${e})`)],
      [2, () => this.P(sid, "entries", `Object.entries(${e})`)],
      [2, () => this.P(sid, "values", `Object.values(${e})`)],
      [3, () => { const ks = this.fresh("ks"); const k = this.fresh("k"); return `{ const ${ks}: string[] = []; for (const ${k} in ${e}) ${ks}.push(${k}); ${this.P(sid, "forin", `${ks}.join(",")`)} }`; }],
      [3, () => this.P(sid, "in", `${JSON.stringify(probe)} in ${e}`, `"zz" in ${e}`)],
      [2, () => this.P(sid, "hasOwn", `Object.hasOwn(${e}, ${JSON.stringify(probe)})`)],
      [2, () => { this.usesInspect = true; return this.P(sid, "inspect", `inspect(${e}, { depth: ${r.range(0, 3)}${r.chance(0.2) ? `, breakLength: ${r.pick([40, 120, "Infinity"])}` : ""} })`); }],
      [1, () => this.P(sid, "spreadkeys", `Object.keys({ ...${e} })`)],
      [1, () => this.P(sid, "json2", `JSON.stringify(${e}, null, ${r.pick([2, '"\\t"', 1])})`)],
      [1, () => { this.usesFormat = true; return this.P(sid, "format", `format(${JSON.stringify(r.pick(["%s|%j", "%o", "%O", "%j", "x %s y"]))}, ${e}, ${e})`); }],
      [1, () => this.P(sid, "tmpl", `\`[\${typeof ${e}}]\``)],
    ];
    const n = opts.n ?? r.range(1, 3);
    const out = [];
    for (let i = 0; i < n; i++) out.push(r.weighted(all)());
    return out;
  }

  /* ── snippets ─────────────────────────────────────────────────────── */

  snipRec(sid) {
    const r = this.rng;
    const t = this.declRec(sid);
    const v = this.fresh("o");
    const viaFactory = r.chance(0.25);
    const ops = [];
    for (let i = r.range(0, 4); i > 0; i--) {
      const f = r.pick(t.fields);
      const op = r.weighted([[4, "write"], [f.opt ? 3 : 0, "delete"], [f.undef ? 2 : 0, "undef"], [1, "assign"], [1, "cond"]]);
      const tgt = viaFactory ? "r" : v;
      if (op === "write") ops.push(`${acc(tgt, f.k)} = ${this.val(f.t)};`);
      else if (op === "delete") ops.push(`delete ${acc(tgt, f.k)};`);
      else if (op === "undef") ops.push(`${acc(tgt, f.k)} = undefined;`);
      else if (op === "assign") ops.push(`Object.assign(${tgt}, { ${keyDecl(f.k)}: ${this.val(f.t)} });`);
      else ops.push(`if (${r.pick(["true", "false", "1 > 0"])}) ${acc(tgt, f.k)} = ${this.val(f.t)};`);
    }
    if (viaFactory) {
      const fn = this.fresh("mk");
      this.emit(`function ${fn}(): ${t.name} {`, `  const r: ${t.name} = ${this.recLit(t)};`, ...ops.map((o) => "  " + o), "  return r;", "}");
      this.emit(`const ${v}: ${t.name} = ${fn}();`);
    } else {
      this.emit(`const ${v}: ${t.name} = ${this.recLit(t)};`, ...ops);
    }
    this.recs.push({ v, t });
    if (r.chance(0.3)) {
      const f = r.pick(t.fields);
      this.emit(this.P(sid, "field", acc(v, f.k), `typeof ${acc(v, f.k)}`));
    }
    if (r.chance(0.2)) {
      const arr = this.fresh("list");
      this.emit(`const ${arr}: ${t.name}[] = [${v}, ${this.recLit(t)}];`);
      this.emit(...this.observe(sid, arr, { n: 1 }));
    }
    this.emit(...this.observe(sid, v, { keys: t.fields.map((f) => f.k) }));
  }

  snipSpread(sid) {
    const r = this.rng;
    const { v, t } = this.someRec(sid);
    const s = this.fresh("s");
    const keys = t.fields.map((f) => f.k);
    const f = r.pick(t.fields);
    const kind = r.weighted([[3, "copy"], [3, "over"], [2, "before"], [2, "two"], [this.opts.includeKnown ? 2 : 0, "narrow"], [2, "rest"], [2, "default"], [1, "assign"], [2, "array"], [1, "params"], [1, "arrdestr"]]);
    switch (kind) {
      case "copy": this.emit(`const ${s} = { ...${v} };`); break;
      case "over": this.emit(`const ${s} = { ...${v}, ${keyDecl(f.k)}: ${this.val(f.t)}${r.chance(0.4) ? ", zz: " + this.num() : ""} };`); break;
      case "before": this.emit(`const ${s} = { ${f.opt ? `${keyDecl(f.k)}: ${this.val(f.t)}, ` : ""}zz: ${this.str()}, ...${v} };`); break;
      case "two": {
        const o2 = r.chance(0.5) && this.recs.length > 1 ? r.pick(this.recs).v : v;
        this.emit(`const ${s} = { ...${v}, ...${o2} };`);
        break;
      }
      case "narrow": {
        const sub = t.fields.filter(() => r.chance(0.5));
        const n = `N${sid}`;
        this.emit(`type ${n} = { ${sub.map((x) => this.fieldDecl(x)).join("; ")} };`);
        this.emit(`const ${s}: ${n} = { ...${v} };`);
        break;
      }
      case "rest": {
        const b = this.fresh("p");
        this.emit(`const { ${keyDecl(f.k)}: ${b}, ...${s} } = ${v};`);
        this.emit(this.P(sid, "picked", b));
        break;
      }
      case "default": {
        const b = this.fresh("d");
        const dflt = f.t.k === "rec" || f.t.k === "arr" ? this.val(f.t) : this.val(f.t);
        this.emit(`const { ${keyDecl(f.k)}: ${b} = ${dflt} } = ${v};`);
        this.emit(this.P(sid, "default", b));
        this.emit(...this.observe(sid, v, { keys, n: 1 }));
        return;
      }
      case "assign": this.emit(`const ${s} = Object.assign({}, ${v}, { zz: ${this.num()} });`); break;
      case "array": {
        const a = this.fresh("xs");
        this.emit(`const ${a}: number[] = ${this.val({ k: "arr", el: { k: "num" } })};`);
        this.numArrs.push(a);
        this.emit(`const ${s} = [${r.pick(["0, ", ""])}...${a}, ...${r.pick([a, "[1, 2]", "[] as number[]"])}];`);
        this.emit(this.P(sid, "len", `${s}.length`, `Math.max(...${a})`, `Math.min(...${s})`, r.chance(0.3) ? `[..."a😀b", ...${a}]` : `${s}.concat(${a})`));
        this.emit(...this.observe(sid, s, { n: r.range(1, 2) }));
        return;
      }
      case "params": {
        const fn = this.fresh("rest");
        this.emit(`function ${fn}(first: number, ...more: number[]): string { return first + ":" + more.length + ":" + more.join("|") + ":" + JSON.stringify(more); }`);
        const a = this.numArrs.length > 0 ? r.pick(this.numArrs) : "[3, 4]";
        this.emit(this.P(sid, "rest", `${fn}(1)`, `${fn}(1, ...${a})`, `${fn}(...[5, 6, 7] as [number, ...number[]])`));
        return;
      }
      case "arrdestr": {
        const a = this.numArrs.length > 0 ? r.pick(this.numArrs) : "[3, 4, 5]";
        const [h, t2, tl] = [this.fresh("h"), this.fresh("t"), this.fresh("tl")];
        this.emit(`const [${h}, , ${t2} = ${this.num()}, ...${tl}] = ${a};`);
        this.emit(this.P(sid, "destr", h, t2, tl));
        return;
      }
    }
    this.emit(...this.observe(sid, s, { keys: [...keys, "zz"] }));
    if (r.chance(0.3)) this.emit(...this.observe(sid, v, { keys, n: 1 }));
  }

  snipDyn(sid) {
    const r = this.rng;
    const kind = r.weighted([[3, "view"], [3, "parse"], [2, "unknown"], [2, "anyarr"], [2, "typeof"], [1, "roundtrip"], [2, "back"]]);
    switch (kind) {
      case "view": {
        const { v, t } = this.someRec(sid);
        const d = this.fresh("d");
        const f = r.pick(t.fields);
        this.emit(`const ${d}: any = ${v};`);
        const w = r.weighted([[3, "known"], [1, "new"], [1, "del"], [1, "read"]]);
        if (w === "known") this.emit(`${acc(d, f.k)} = ${this.val(f.t)};`);
        else if (w === "new") this.emit(`${d}.zz = ${this.num()};`);
        else if (w === "del" && f.opt) this.emit(`delete ${acc(d, f.k)};`);
        else this.emit(this.P(sid, "read", acc(d, f.k), `${d}.zz`, `typeof ${d}.zz`));
        this.emit(...this.observe(sid, r.chance(0.5) ? v : d, { keys: t.fields.map((x) => x.k) }));
        return;
      }
      case "parse": case "back": {
        const t = this.declRec(sid);
        // S041 amendment / S115: a checked conversion takes the declared
        // order and drops undeclared keys (registered).
        const lit = this.recLit(t, this.opts.includeKnown ? true : false);
        // eslint-disable-next-line no-new-func
        const json = JSON.stringify(Function(`"use strict"; return (${lit});`)());
        const j = this.fresh("j");
        if (kind === "parse") this.emit(`const ${j} = JSON.parse(${JSON.stringify(json)}) as ${t.name};`);
        else this.emit(`const ${j}raw: any = JSON.parse(${JSON.stringify(json)});`, ...(this.opts.includeKnown ? [`${j}raw.extra = ${this.num()};`] : []), `const ${j}: ${t.name} = ${j}raw;`);
        const f = r.pick(t.fields);
        this.emit(this.P(sid, "field", acc(j, f.k)));
        this.emit(...this.observe(sid, j, { keys: t.fields.map((x) => x.k) }));
        this.recs.push({ v: j, t });
        return;
      }
      case "unknown": {
        const u = this.fresh("u");
        const t = this.primType(0);
        const json = JSON.stringify(Function(`"use strict"; return (${this.val(t)});`)());
        this.emit(`const ${u}: unknown = JSON.parse(${JSON.stringify(json)});`);
        this.emit(`if (typeof ${u} === "object" && ${u} !== null) {`,
          `  ${this.P(sid, "ukeys", `Object.keys(${u})`, `Array.isArray(${u})`)}`,
          `  if ("a" in ${u}) ${this.P(sid, "ua", `${u}.a`)}`,
          `} else ${this.P(sid, "uprim", `typeof ${u}`, u)}`);
        return;
      }
      case "anyarr": {
        const a = this.fresh("aa");
        const items = Array.from({ length: r.range(1, 6) }, () => r.pick(["1", '"s"', "null", "undefined", "{ a: 1 }", "[2]", "true", "-0", "NaN", "{}", "[]", "{ b: undefined }"]));
        this.emit(`const ${a}: any[] = [${items.join(", ")}];`);
        this.emit(this.P(sid, "types", `${a}.map((x) => typeof x).join(",")`));
        this.emit(...this.observe(sid, a, { n: 2 }));
        return;
      }
      case "typeof": {
        const x = this.fresh("tv");
        const e = r.pick(["null", "undefined", "() => 1", "class {}", "[]", "{}", "1n", "Symbol.iterator", "new Map()", "/re/", '"s"', "0", "function () {}", "new Error(\"e\")", "Math", "JSON", "console.log"]);
        this.emit(`const ${x}: unknown = ${e};`);
        this.emit(this.P(sid, "typeof", `typeof ${x}`, `${x} === null`, `${x} === undefined`, `typeof ${x} === "function"`, `typeof ${x} === "object"`));
        return;
      }
      case "roundtrip": {
        const { v } = this.someRec(sid);
        this.emit(this.P(sid, "rt", `JSON.stringify(JSON.parse(JSON.stringify(${v})))`));
        const c = this.fresh("c");
        this.emit(`const ${c}: any = structuredClone(${v});`);
        this.emit(...this.observe(sid, c, { n: 1 }));
        return;
      }
    }
  }

  snipUnion(sid) {
    const r = this.rng;
    const kind = r.weighted([[3, "prims"], [3, "disc"], [2, "chain"]]);
    if (kind === "prims") {
      const arms = r.sample(["number", "string", "boolean", "null", "undefined", "number[]", "{ a: number }"], r.range(2, 4));
      const U = `U${sid}`;
      this.emit(`type ${U} = ${arms.join(" | ")};`);
      const litFor = (a) => ({ number: this.num(), string: this.str(), boolean: r.pick(["true", "false"]), null: "null", undefined: "undefined", "number[]": "[1, 2]", "{ a: number }": `{ a: ${this.num()} }` })[a];
      const xs = this.fresh("us");
      this.emit(`const ${xs}: ${U}[] = [${Array.from({ length: r.range(1, 5) }, () => litFor(r.pick(arms))).join(", ")}];`);
      const u = this.fresh("u");
      const body = r.weighted([
        [3, `${this.P(sid, "typeof", `typeof ${u}`, `String(${u})`)}`],
        [2, `${this.P(sid, "nullish", `${u} ?? "dflt"`, `${u} === undefined`, `${u} == null`)}`],
        [2, `${this.P(sid, "json", `JSON.stringify(${u})`)}`],
        [arms.includes("number") && arms.includes("string") ? 2 : 0, `if (typeof ${u} === "number") ${this.P(sid, "num", `${u}.toFixed(1)`)} else if (typeof ${u} === "string") ${this.P(sid, "str", `${u}.length`)} else ${this.P(sid, "other", u)}`],
        [1, `${this.P(sid, "tmpl", `\`<\${${u}}>\``)}`],
      ]);
      this.emit(`for (const ${u} of ${xs}) { ${body} }`);
      this.emit(...this.observe(sid, xs, { n: 1 }));
    } else if (kind === "disc") {
      const S = `S${sid}`;
      this.emit(`type ${S} = { kind: "c"; r: number } | { kind: "s"; side: number; tag?: string } | { kind: "t"; label: string };`);
      const sh = () => r.pick([`{ kind: "c", r: ${this.num()} }`, `{ kind: "s", side: ${this.num()} }`, `{ kind: "s", side: 2, tag: ${this.str()} }`, `{ tag: "z", side: 1, kind: "s" }`, `{ kind: "t", label: ${this.str()} }`]);
      const xs = this.fresh("shapes");
      this.emit(`const ${xs}: ${S}[] = [${Array.from({ length: r.range(1, 4) }, sh).join(", ")}];`);
      const fn = this.fresh("desc");
      this.emit(`function ${fn}(s: ${S}): string {`,
        "  switch (s.kind) {",
        '    case "c": return "circle " + s.r;',
        `    case "s": return "square " + s.side + ("tag" in s ? " tag=" + s.tag : "");`,
        '    case "t": return `text ${s.label}`;',
        "  }",
        "}");
      this.emit(this.P(sid, "desc", `${xs}.map(${fn})`));
      this.emit(...this.observe(sid, xs, { n: r.range(1, 2) }));
    } else {
      const { v, t } = this.someRec(sid);
      const f = r.pick(t.fields);
      const opt = `${v}${isIdent(f.k) ? "?." + f.k : "?.[" + JSON.stringify(f.k) + "]"}`;
      const ext = f.t.k === "str" || f.t.k === "arr" ? `${opt}?.length` : f.t.k === "num" ? `${opt}?.toFixed(2)` : opt;
      this.emit(this.P(sid, "chain", ext, `${acc(v, f.k)} ?? "none"`, `${acc(v, f.k)} === undefined`));
    }
  }

  snipClass(sid) {
    const r = this.rng;
    const C = `C${sid}`;
    const fields = r.sample(["a", "b", "count", "label", "items"], r.range(1, 3));
    const ftype = { a: "number", b: "string", count: "number", label: "string", items: "number[]" };
    const finit = { a: () => this.num(), b: () => this.str(), count: () => "0", label: () => this.str(), items: () => "[]" };
    const ctorAssigned = fields.filter(() => r.chance(0.4));
    const lines = [`class ${C} {`];
    for (const f of fields) lines.push(ctorAssigned.includes(f) ? `  ${f}: ${ftype[f]};` : `  ${f}: ${ftype[f]} = ${finit[f]()};`);
    const optF = r.chance(0.4);
    if (optF) lines.push("  extra?: number;");
    if (r.chance(0.3)) lines.push(`  static made = 0;`);
    if (r.chance(0.3)) lines.push(`  #secret = ${this.num()};`);
    const arrow = r.chance(0.5);
    if (arrow) lines.push(`  get2 = () => this.${fields[0]};`);
    lines.push("  constructor() {");
    for (const f of ctorAssigned) lines.push(`    this.${f} = ${finit[f]()};`);
    if (lines.some((l) => l.includes("static made"))) lines.push(`    ${C}.made++;`);
    lines.push("  }");
    lines.push(`  get first(): ${ftype[fields[0]]} { return this.${fields[0]}; }`);
    lines.push(`  self(): this { return this; }`);
    lines.push(`  show(): string { return \`${C}(\${JSON.stringify(this)})\`; }`);
    const ts = r.chance(0.3);
    if (ts) lines.push(`  toString(): string { return "${C}!"; }`);
    if (lines.some((l) => l.includes("#secret"))) lines.push("  peek(): number { return this.#secret; }");
    lines.push("}");
    this.emit(...lines);
    let cls = C;
    if (r.chance(0.4)) {
      const D = `D${sid}`;
      this.emit(`class ${D} extends ${C} {`, "  more = 1;", `  override show(): string { return "D:" + super.show(); }`, "}");
      cls = D;
    }
    const c = this.fresh("inst");
    this.emit(`const ${c} = new ${cls}();`);
    if (optF && r.chance(0.6)) this.emit(`${c}.extra = ${this.num()};`);
    if (fields.includes("items") && r.chance(0.6)) this.emit(`${c}.items.push(1, 2);`);
    if (r.chance(0.4)) this.emit(`${c}.${fields[0]} = ${finit[fields[0]]()};`);
    const extra = [];
    extra.push(this.P(sid, "show", `${c}.show()`, `${c}.self() === ${c}`, `${c}.first`));
    if (arrow) {
      const g = this.fresh("g");
      extra.push(`const ${g} = ${c}.get2;`, this.P(sid, "arrow", `${g}()`));
    }
    if (ts) extra.push(this.P(sid, "tostr", `String(${c})`, `\`\${${c}}\``, `${c} + ""`));
    extra.push(this.P(sid, "meta", `${c}.constructor.name`, `${c} instanceof ${C}`, `Object.getPrototypeOf(${c}) === ${cls}.prototype`, `typeof ${cls}`));
    if (lines.some((l) => l.includes("#secret"))) extra.push(this.P(sid, "priv", `${c}.peek()`));
    if (r.chance(0.3)) {
      const m = this.fresh("m");
      extra.push(`const ${m} = ${c}.show;`, `try { ${this.P(sid, "unbound", `${m}()`)} } catch (e) { ${this.P(sid, "unbound-err", "e instanceof Error ? e.constructor.name + \": \" + e.message : String(e)")} }`);
    }
    this.emit(...extra);
    this.emit(...this.observe(sid, c, { keys: [...fields, "extra", "more"] }));
  }

  snipClosure(sid) {
    const r = this.rng;
    const kind = r.weighted([[2, "counter"], [3, "loop"], [2, "objthis"], [2, "hof"], [1, "defaults"], [1, "recur"], [2, "sort"], [2, "bind"], [2, "fnprint"], [1, "accessor"]]);
    switch (kind) {
      case "counter": {
        const mk = this.fresh("mkCounter");
        const c = this.fresh("ctr");
        this.emit(`function ${mk}(start: number) { let n = start; return { inc: () => ++n, add(k: number) { n += k; return this; }, get: () => n }; }`);
        this.emit(`const ${c} = ${mk}(${r.range(0, 5)});`, `${c}.inc();`, `${c}.add(${r.range(1, 9)}).add(1);`);
        this.emit(this.P(sid, "ctr", `${c}.get()`, `${c}.inc()`));
        this.emit(...this.observe(sid, c, { keys: ["inc", "add", "get"], n: 1 }));
        return;
      }
      case "loop": {
        const fs = this.fresh("fns");
        const decl = r.pick(["let", "var"]);
        const iv = this.fresh("i");
        this.emit(`const ${fs}: (() => number)[] = [];`, `for (${decl} ${iv} = 0; ${iv} < ${r.range(1, 4)}; ${iv}++) ${fs}.push(() => ${iv} * ${r.range(1, 5)});`);
        this.emit(this.P(sid, "loop", `${fs}.map((f) => f())`, `${fs}.length`));
        if (r.chance(0.5)) this.emit(`if (${fs}.length > 0) ${this.P(sid, "elem", `${fs}[0]!()`)}`);
        return;
      }
      case "objthis": {
        const o = this.fresh("obj");
        this.emit(`const ${o} = { n: ${r.range(1, 9)}, tag: ${this.str()}, m() { return [1, 2].map((x) => x + this.n); }, f: function () { return this === undefined; }, a: () => typeof globalThis };`);
        this.emit(this.P(sid, "this", `${o}.m()`, `${o}.f()`, `${o}.a()`));
        if (r.chance(0.5)) {
          this.emit(`const { m: ${o}m } = ${o};`, `try { ${this.P(sid, "detached", `${o}m()`)} } catch (e) { ${this.P(sid, "detached-err", "e instanceof Error ? e.constructor.name + \": \" + e.message : String(e)")} }`);
        }
        this.emit(...this.observe(sid, o, { keys: ["n", "m", "f", "tag"], n: 1 }));
        return;
      }
      case "hof": {
        const a = this.numArrs.length > 0 && r.chance(0.5) ? r.pick(this.numArrs) : `(${this.val({ k: "arr", el: { k: "num" } })} as number[])`;
        const e = r.pick([
          `${a}.map((x, i) => x * i)`,
          `${a}.filter((x) => x > 1).map(String)`,
          `${a}.reduce((acc, x) => acc + x, 0)`,
          `${a}.map((x, i, arr) => arr.length - i)`,
          `${a}.findLast((x) => x < 3)`,
          `${a}.flatMap((x) => [x, -x])`,
          `${a}.some(Number.isInteger)`,
          `${a}.map(Math.round)`,
          `${a}.join("-")`,
          `${a}.indexOf(-0)`,
          `${a}.includes(NaN)`,
          `${a}.at(-1)`,
          `Array.from({ length: 3 }, (_, i) => i * 2)`,
          `${a}.entries().next().value`,
          `[...${a}.keys()]`,
        ]);
        this.emit(this.P(sid, "hof", e));
        return;
      }
      case "defaults": {
        const f = this.fresh("dflt");
        this.emit(`function ${f}(a: number, b: number = a * 2, c?: string): string { return [a, b, c, arguments.length].join("/"); }`);
        this.emit(this.P(sid, "defaults", `${f}(1)`, `${f}(1, undefined, "z")`, `${f}.length`, `${f}.name`));
        return;
      }
      case "recur": {
        const f = this.fresh("fib");
        this.emit(`const ${f} = (n: number): number => (n < 2 ? n : ${f}(n - 1) + ${f}(n - 2));`);
        this.emit(this.P(sid, "recur", `${f}(${r.range(0, 15)})`, `[0, 1, 2, 3].map(${f})`));
        return;
      }
      case "sort": {
        const a = this.fresh("arr");
        const el = r.pick([{ k: "num" }, { k: "str" }]);
        this.emit(`const ${a}: ${this.ts(el)}[] = ${this.val({ k: "arr", el })};`);
        this.emit(this.P(sid, "sort", r.pick([`[...${a}].sort()`, `${a}.toSorted()`, `[...${a}].reverse()`, `${a}.slice(1, -1)`, `${a}.toSorted().join()`])));
        return;
      }
      case "bind": {
        const o = this.fresh("tgt");
        const f = this.fresh("who");
        this.emit(`const ${o} = { n: ${r.range(1, 9)}, label: ${this.str()} };`);
        this.emit(`function ${f}(this: { n: number; label: string } | undefined, k: number): string { return this === undefined ? "no this " + k : this.label + ":" + (this.n + k); }`);
        this.emit(this.P(sid, "bind", r.pick([`${f}.call(${o}, 1)`, `${f}.apply(${o}, [2])`, `${f}.bind(${o})(3)`, `${f}.call(undefined, 4)`, `[1, 2].map(${f}.bind(${o}))`, `${f}.bind(${o}, 5)()`])));
        if (r.chance(0.4)) this.emit(this.P(sid, "bound", `${f}.bind(${o}).name`, `${f}.bind(${o}).length`));
        return;
      }
      case "fnprint": {
        const f = this.fresh("named");
        const K = this.fresh("K");
        this.emit(`function ${f}(a: number, b: number): number { return a + b; }`, `const ${f}arrow = (x: number) => x;`, `const ${K} = class {};`, `class ${K}b extends ${K} {}`);
        this.emit(this.P(sid, "fnprint", r.pick([f, `${f}arrow`, K, `${K}b`, `[${f}, ${f}arrow]`, `{ f: ${f}, k: ${K}b }`, `function () {}`, `() => 1`, `Math.max`, `async function af() {}`, `function* gen() {}`])));
        this.emit(this.P(sid, "fnmeta", `${f}.name`, `${f}.length`, `${f}arrow.name`, `${K}.name`, `${K}b.name`, `typeof ${K}b`, `String(${r.pick([`${f}arrow`, K])}).length > 0`));
        return;
      }
      case "accessor": {
        const o = this.fresh("acc");
        this.emit(`let ${o}hits = 0;`, `const ${o} = { base: ${r.range(1, 9)}, get dbl(): number { ${o}hits++; return this.base * 2; }, set dbl(v: number) { this.base = v / 2; } };`);
        this.emit(`${o}.dbl = ${r.range(2, 20)};`);
        this.emit(this.P(sid, "accessor", `${o}.dbl`, `${o}hits`));
        this.emit(...this.observe(sid, o, { keys: ["base", "dbl"], n: r.range(1, 2) }));
        this.emit(this.P(sid, "hits", `${o}hits`));
        return;
      }
    }
  }

  snipControl(sid) {
    const r = this.rng;
    const kind = r.weighted([[2, "order"], [2, "logical"], [2, "loops"], [1, "switch"], [2, "coerce"], [1, "swap"], [1, "holes"]]);
    const log = this.fresh("ev");
    switch (kind) {
      case "order": {
        this.emit(`const ${log}: string[] = [];`, `const ${log}f = (tag: string, v: number): number => { ${log}.push(tag); return v; };`);
        const e = r.pick([
          `${log}f("a", 1) + ${log}f("b", 2) * ${log}f("c", 3)`,
          `[${log}f("a", 1), ${log}f("b", 2)].map((x) => x + ${log}f("c", 0))`,
          `Math.max(${log}f("a", 1), ${log}f("b", 5), ${log}f("c", 3))`,
          `({ p: ${log}f("a", 1), q: ${log}f("b", 2), [String(${log}f("c", 3))]: 0 })`,
          `${log}f("a", 0) || ${log}f("b", 0) || ${log}f("c", 7)`,
          `${log}f("a", 1) && ${log}f("b", 0) && ${log}f("c", 3)`,
          `(${log}f("a", 1), ${log}f("b", 2))`,
          `${log}f("a", 1) > 0 ? ${log}f("b", 2) : ${log}f("c", 3)`,
          `\`\${${log}f("a", 1)}-\${${log}f("b", 2)}\``,
        ]);
        this.emit(this.P(sid, "order", e, `${log}.join("")`));
        return;
      }
      case "logical": {
        const o = this.fresh("lg");
        this.emit(`const ${o}: { a?: number; b: number | null; c: string } = { b: null, c: "" };`);
        this.emit(...r.sample([`${o}.a ??= ${this.num()};`, `${o}.b ??= 3;`, `${o}.c ||= "filled";`, `${o}.b &&= 9;`, `${o}.a ||= 5;`, `${o}.a &&= ${o}.a + 1;`], r.range(1, 4)));
        this.emit(...this.observe(sid, o, { keys: ["a", "b", "c"], n: r.range(1, 2) }));
        return;
      }
      case "loops": {
        const acc = this.fresh("out");
        this.emit(`const ${acc}: string[] = [];`);
        this.emit("{ " + r.pick([
          `outer: for (let i = 0; i < 4; i++) { for (let j = 0; j < 4; j++) { if (j === 2) continue outer; if (i === 3) break outer; ${acc}.push(\`\${i}\${j}\`); } }`,
          `let w = 0; do { ${acc}.push(String(w)); w += 2; } while (w < 7);`,
          `for (const [i, v] of ["x", "y", "z"].entries()) { if (i === 1) continue; ${acc}.push(i + v); }`,
          `for (const ch of "a😀b") ${acc}.push(ch + ch.length);`,
          `const m = new Map([["k1", 1], ["k2", 2]]); for (const [k, v] of m) ${acc}.push(k + "=" + v); m.set("k0", 0); for (const k of m.keys()) ${acc}.push(k);`,
          `let k = 10; while (k-- > 7) ${acc}.push(String(k));`,
          `for (let i = 0, j = 5; i < j; i++, j--) ${acc}.push(i + ":" + j);`,
        ]) + " }");
        this.emit(this.P(sid, "loops", `${acc}.join(" ")`));
        return;
      }
      case "switch": {
        const f = this.fresh("sw");
        this.emit(`function ${f}(x: number | string): string {`, "  switch (x) {", '    case 1: case 2: return "low";', '    case "1": return "str one";', '    case 3: { const y = 3; return "three" + y; }', '    default: return "other " + typeof x;', "  }", "}");
        this.emit(this.P(sid, "switch", `[1, 2, "1", 3, 4, "x"].map(${f}).join("|")`));
        return;
      }
      case "coerce": {
        const e = r.pick([
          "String(null)", "String([null])", "String([1, [2, 3]])", "[undefined, null].join()", "`${[1, 2]}`", "`${{}}`", '[] + ""',
          'String(Symbol("s"))', "String(-0)", "`${-0}`", "[-0].toString()", "JSON.stringify([-0])", "String(1e21)", "String(123e-20)",
          "Object.is(NaN, NaN)", "[NaN].includes(NaN)", "[NaN].indexOf(NaN)", "typeof NaN", "0.1 * 3",
          "(25).toString(36)", 'parseInt("z", 36)', 'Number("")', 'Number(" 0x10 ")', "Number(null)", "Number(undefined)", "Number([])",
          "Number([5])", "Number(true)", '!!"0"', '!!""', "+[]", "String(Number.MIN_VALUE)", "(1e-7).toFixed(10)", "(0.000001).toString()",
          "(123.456).toFixed(1)", "(1.005).toFixed(2)", "(2 ** 31) | 0", "-7 % 3", "2 ** -1", "Math.round(2.5)", "Math.round(-2.5)",
        ]);
        this.emit(this.P(sid, "coerce", e));
        return;
      }
      case "swap": {
        const [a, b] = [this.fresh("sa"), this.fresh("sb")];
        this.emit(`let ${a} = ${this.num()};`, `let ${b} = ${this.num()};`, `[${a}, ${b}] = [${b}, ${a}];`);
        this.emit(this.P(sid, "swap", a, b));
        return;
      }
      case "holes": {
        const a = this.fresh("sp");
        this.emit(`const ${a}: number[] = [];`, `${a}[${r.range(1, 4)}] = 1;`);
        this.emit(this.P(sid, "holes", a, `${a}.length`, `JSON.stringify(${a})`, `0 in ${a}`));
        return;
      }
    }
  }

  snipError(sid) {
    const r = this.rng;
    const kind = r.weighted([[3, "custom"], [2, "rename"], [3, "builtin"], [2, "nonerror"], [1, "cause"], [1, "finally"], [2, "inspect"]]);
    const e = this.fresh("e");
    const errObs = (x) => {
      const pool = [
        [3, this.P(sid, "name", `${x}.name`, `${x}.message`)],
        [3, this.P(sid, "str", `String(${x})`, `\`\${${x}}\``)],
        [2, this.P(sid, "ctor", `${x}.constructor.name`, `${x} instanceof Error`, `${x} instanceof TypeError`, `${x} instanceof RangeError`)],
        [2, this.P(sid, "keys", `Object.keys(${x})`, `JSON.stringify(${x})`)],
        [1, this.P(sid, "stack0", `(${x}.stack ?? "").split("\\n")[0]`)],
        [1, this.P(sid, "code", `(${x} as Error & { code?: unknown }).code`, `"code" in ${x}`)],
        [1, this.P(sid, "proto", `Object.prototype.toString.call(${x})`)],
      ];
      return Array.from({ length: r.range(1, 3) }, () => r.weighted(pool));
    };
    switch (kind) {
      case "custom": {
        const E = `Err${sid}`;
        const withCode = r.chance(0.6);
        const setName = r.chance(0.6);
        this.emit(`class ${E} extends ${r.pick(["Error", "TypeError", "RangeError"])} {`,
          ...(withCode ? [`  code = ${this.str()};`] : []),
          "  constructor(msg: string) {",
          "    super(msg);",
          ...(setName ? [`    this.name = "${E}";`] : []),
          "  }",
          "}");
        this.emit(`try { throw new ${E}(${this.str()}); } catch (${e}) {`, `  if (${e} instanceof ${E}) {`, ...errObs(e).map((l) => "    " + l), `  }`, "}");
        if (r.chance(0.4)) {
          const x = this.fresh("ex");
          this.emit(`const ${x} = new ${E}("direct");`, ...errObs(x));
        }
        return;
      }
      case "rename": {
        const ctor = r.pick(["Error", "TypeError", "RangeError", "SyntaxError"]);
        this.emit(`const ${e} = new ${ctor}(${this.str()});`, `${e}.name = ${JSON.stringify(r.pick(["Custom", "", "Error", "X Y"]))};`);
        if (r.chance(0.3)) this.emit(`${e}.message = ${this.str()};`);
        this.emit(...errObs(e));
        return;
      }
      case "builtin": {
        const thrower = r.pick([
          "(null as any).x",
          "(undefined as any).foo.bar",
          'JSON.parse("{bad")',
          'JSON.parse("")',
          'JSON.parse("[1,]")',
          '"a".repeat(-1)',
          "(1).toFixed(101)",
          "(255).toString(1)",
          "new Array(-1)",
          "(123 as any)()",
          "({} as any).method()",
          "([] as number[]).reduce((a, b) => a + b)",
          "BigInt(1.5)",
          "(Symbol() as any) + \"\"",
          "decodeURIComponent(\"%\")",
          "new (class { constructor() { throw new RangeError(\"in ctor\"); } })()",
          "(Object.freeze({ a: 1 }) as any).a = 2",
        ]);
        this.emit(`try { ${this.P(sid, "noerr", thrower)} } catch (${e}) {`, `  if (${e} instanceof Error) {`, ...errObs(e).map((l) => "    " + l), `  } else ${this.P(sid, "nonerr", `typeof ${e}`)}`, "}");
        return;
      }
      case "nonerror": {
        // S022: a non-Error object payload crossing into unknown becomes an empty object (registered).
        const payload = r.pick(['"str"', "42", "null", "undefined", "true", ...(this.opts.includeKnown ? ["{ code: 1, msg: \"m\" }", "[1, 2]", "new Map([[1, 2]])"] : [])]);
        this.emit(`try { throw ${payload}; } catch (${e}) {`, `  ${this.P(sid, "thrown", `typeof ${e}`, `${e} instanceof Error`, `JSON.stringify(${e})`)}`, `  ${this.P(sid, "thrownlog", e)}`, "}");
        return;
      }
      case "cause": {
        this.emit(`const ${e} = new Error("outer", { cause: ${r.pick(['"why"', "42", "new Error(\"inner\")", "{ a: 1 }"])} });`);
        this.emit(this.P(sid, "cause", `typeof ${e}.cause`, `${e}.cause instanceof Error`, `Object.keys(${e})`, `"cause" in ${e}`));
        return;
      }
      case "inspect": {
        // A cleared stack makes Node print the bracket form, with own props.
        const ctor = r.pick(["Error", "TypeError", "RangeError"]);
        this.emit(`const ${e} = new ${ctor}(${this.str()});`, `${e}.stack = "";`);
        if (r.chance(0.5)) this.emit(`${e}.name = ${JSON.stringify(r.pick(["Custom", "TypeError", "X"]))};`);
        if (r.chance(0.5)) this.emit(`(${e} as Error & { code?: string }).code = "E_FUZZ";`);
        this.emit(this.P(sid, "errlog", r.pick([e, `{ err: ${e} }`, `[${e}]`])));
        return;
      }
      case "finally": {
        const f = this.fresh("tf");
        this.emit(`function ${f}(k: number): string {`, `  try { if (k > 1) throw new Error("big " + k); return "ok " + k; }`, `  catch (err) { return "caught " + (err as Error).message; }`, `  finally { ${this.P(sid, "finally", "k")} }`, "}");
        this.emit(this.P(sid, "tf", `${f}(1)`, `${f}(2)`));
        return;
      }
    }
  }

  snipFormat(sid) {
    const r = this.rng;
    const kind = r.weighted([[3, "num"], [2, "parse"], [3, "str"], [3, "inspect"], [2, "json"], [1, "fmt"], [1, "coll"]]);
    switch (kind) {
      case "num": {
        const n = this.fresh("n");
        this.emit(`const ${n}: number = ${this.num()};`);
        const e = r.pick([
          `${n}.toFixed(${r.range(0, 6)})`, `${n}.toPrecision(${r.range(1, 8)})`, `${n}.toString(${r.pick([2, 8, 16, 36])})`,
          `${n}.toExponential(${r.range(0, 4)})`, `String(${n})`, `${n} + ""`, `JSON.stringify(${n})`, n, `[${n}]`, `{ v: ${n} }`,
          `Math.round(${n})`, `Math.sign(${n})`, `Object.is(${n}, -0)`, `${n} | 0`, `${n} >>> 0`, `${n} % 3`, `-${n}`, `Number.isInteger(${n})`,
          `Math.trunc(${n})`, `${n} ** 2`, `Math.hypot(${n}, 1)`,
        ]);
        this.emit(this.P(sid, "num", e));
        return;
      }
      case "parse": {
        const s = JSON.stringify(r.pick(NUMERIC_STRS));
        this.emit(this.P(sid, "parse", `Number(${s})`, `parseInt(${s}${r.chance(0.3) ? ", " + r.pick([2, 10, 16, 36]) : ""})`, `parseFloat(${s})`, `+${s}`, `isNaN(${s} as any)`));
        return;
      }
      case "str": {
        const s = this.fresh("st");
        this.emit(`const ${s}: string = ${this.str()};`);
        const e = r.pick([
          `${s}.length`, `${s}.toUpperCase()`, `${s}.toLowerCase()`, `${s}.padStart(${r.range(0, 8)}, "*")`, `${s}.padEnd(6)`, `${s}.slice(-2)`,
          `${s}.split("")`, `${s}.split(",")`, `${s}.replace("l", "L")`, `${s}.replaceAll("a", "$&$&")`, `${s}.at(-1)`, `${s}.charCodeAt(0)`,
          `${s}.codePointAt(0)`, `${s}.trim()`, `JSON.stringify(${s})`, `[${s}]`, `{ s: ${s} }`, `${s}.repeat(2)`, `${s}.indexOf("l")`,
          `${s}.includes("")`, `${s}.substring(3, 1)`, `${s}.startsWith("h")`, `[...${s}]`, `${s}.normalize("NFD").length`, `encodeURIComponent(${s})`,
          `${s}.localeCompare("m")`, `${s} < "m"`, `${s}.concat("!", ${s})`, `String.raw\`a\\n\${${s}}\``,
        ]);
        this.emit(this.P(sid, "str", e));
        return;
      }
      case "inspect": {
        const e = r.pick([
          `{ a: { b: { c: { d: 1 } } } }`,
          `[[1, [2, [3, [4]]]]]`,
          `Array.from({ length: ${r.range(5, 120)} }, (_, i) => i)`,
          `Array.from({ length: ${r.range(3, 30)} }, (_, i) => "item" + i)`,
          `{ longKeyNameNumberOne: ${this.str()}, longKeyNameNumberTwo: ${this.str()}, longKeyNameNumberThree: [1, 2, 3] }`,
          `[${this.str()}, ${this.str()}, ${this.str()}]`,
          `{ "a-b": 1, "1": 2, b: undefined, c: null, [${this.str()}]: 3 }`,
          `[undefined, null, , 3]`,
          `{ f() {}, g: () => 1, h: function named() {} }`,
          `[{ a: 1, b: "x" }, { a: 2, b: "y" }]`,
          `new Array(5)`,
          `[1.5, -0, 0, NaN, 1e21, 1e-7]`,
          `{ nested: [{ deep: { deeper: { deepest: true } } }] }`,
          `[${this.val({ k: "arr", el: { k: "str" } })}]`,
          `Object.assign(Object.create(null), { a: 1 })`,
          `[new Map([["k", { v: 1 }]]), new Set([1, "a"])]`,
        ]);
        if (r.chance(0.4)) {
          this.usesInspect = true;
          this.emit(this.P(sid, "inspect", `inspect(${e}, { depth: ${r.pick([0, 1, 2, "null", "Infinity"])}${r.chance(0.25) ? `, breakLength: ${r.pick([40, "Infinity"])}` : ""}${r.chance(0.5) ? `, compact: ${r.pick([1, 3, "false", "true"])}` : ""} })`));
        } else {
          this.emit(this.P(sid, "log", e));
        }
        return;
      }
      case "json": {
        const e = r.pick([
          `{ a: undefined, b: () => 1, c: null, d: NaN, e: -0, f: [undefined, () => 1] }`,
          `{ toJSON() { return { x: 1 }; } }`,
          `[new Date(0)]`,
          `{ s: "\\u2028\\ud800\\"" }`,
          `"\\u0007\\u001f"`,
          `{ "1": 1, b: 2, "0": 0, a: 3 }`,
          `new Map([[1, 2]])`,
          `[Infinity, -Infinity, 1e21]`,
        ]);
        const arg = r.pick(["", ", null, 2", ', ["a", "b", "1"]', ", (k, v) => (typeof v === \"number\" ? v * 2 : v)", ", null, \"--\""]);
        this.emit(this.P(sid, "json", `JSON.stringify(${e}${arg})`));
        return;
      }
      case "fmt": {
        this.usesFormat = true;
        const f = JSON.stringify(r.pick(["%s=%d", "%i|%f", "%j", "%s %s", "100%% %s", "%c%s", "%d"]));
        this.emit(this.P(sid, "fmt", `format(${f}, ${r.pick(['"x"', "1.5", "-0", "42", "{ a: 1 }", "[1]", "null"])}, ${r.pick(['"y"', "2", "undefined", "true"])})`));
        return;
      }
      case "coll": {
        const m = this.fresh("map");
        this.emit(`const ${m} = new Map<string, number>([[${this.str()}, 1], ["b", 2]]);`, `${m}.set("a", 3);`, `${m}.delete("b");`);
        const s = this.fresh("set");
        this.emit(`const ${s} = new Set<number | string>([3, 1, "1", 3]);`);
        this.emit(this.P(sid, "coll", m, s, `[...${m}.keys()]`, `${s}.size`, `JSON.stringify([...${m}])`));
        return;
      }
    }
  }

  build() {
    const r = this.rng;
    const weights = this.opts.weights ?? { rec: 4, spread: 4, dyn: 3, union: 2, class: 3, closure: 3, error: 3, format: 3, control: 3 };
    const areas = this.opts.areas ?? AREAS;
    const n = r.range(this.opts.minSnippets ?? 2, this.opts.maxSnippets ?? 6);
    for (let i = 0; i < n; i++) {
      const area = r.weighted(areas.map((a) => [weights[a] ?? 1, a]));
      const sid = i + 1;
      const start = this.lines.length;
      const nr = this.recs.length;
      const na = this.numArrs.length;
      this.emit(`// snippet ${sid}: ${area}`);
      const fn = { rec: this.snipRec, spread: this.snipSpread, dyn: this.snipDyn, union: this.snipUnion, class: this.snipClass, closure: this.snipClosure, error: this.snipError, format: this.snipFormat, control: this.snipControl }[area];
      fn.call(this, sid);
      // A skipped snippet still draws from the PRNG, so every other
      // snippet comes out exactly as in the unpruned program.
      if (this.opts.skip?.has(sid)) {
        this.lines.length = start;
        this.recs.length = nr;
        this.numArrs.length = na;
        continue;
      }
      this.snips.push({ sid, area, start, end: this.lines.length });
    }
    const imports = [];
    const names = [this.usesInspect && "inspect", this.usesFormat && "format"].filter(Boolean);
    if (names.length > 0) imports.push(`import { ${names.join(", ")} } from "node:util";`);
    const head = [`// tsinter fuzz seed=${this.seed}`, ...imports];
    let source = [...head, ...this.lines, "export {};", ""].join("\n");
    if (this.opts.drop?.size > 0) source = dropStatements(source, this.opts.drop);
    return { source, snippets: this.snips.map((s) => ({ sid: s.sid, area: s.area })) };
  }
}

/** `source` without its top-level statements whose text is in `drop`
 * (the driver's pruning of a refused observer or write). */
function dropStatements(source, drop) {
  const sf = ts.createSourceFile("main.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let out = source;
  for (const st of [...sf.statements].reverse()) {
    if (drop.has(st.getText(sf))) out = out.slice(0, st.getStart(sf)) + out.slice(st.getEnd());
  }
  return out;
}

/** The program for `seed`. */
export function generate(seed, opts) {
  return new Program(seed, opts).build();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const seed = Number(process.argv[2] ?? 1);
  process.stdout.write(generate(seed).source);
}
