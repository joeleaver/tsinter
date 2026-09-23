/* INC-27 unit U2 — H, the static smalls: seven previously-refused wasm
 * backend keys (arrIntrinsic:join:ref-elem, arrIntrinsic:toReversed /
 * toSpliced / with, expr:templateStrings, toString:record,
 * classval:no-ctor) lifted for the shapes the front end actually admits
 * to their sites. ONE `test` PER ROW, EACH ROW ITS OWN COMPILE — the
 * wasm-pow-u0.test.ts / wasm-symbol-u1.test.ts idiom (a mutant that
 * traps one row must not truncate a shared module's other rows and
 * destroy mutation attribution).
 *
 * Every expected line below is an INLINED literal, derived from a real
 * `node --experimental-transform-types` run of the SAME snippet each row
 * compiles — a committed test reads nothing outside this repository at
 * test time. Rows are grouped by class; the class comment states which
 * of the seven keys the class exercises: COPIERS, JOIN-UNION, TEMPLATES,
 * TOSTRING-RECORD, CLASSVAL, B-i, NOT-LIFTED and REGRESSION. */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { runWasm, runWasmToTrap } from "./wasm-host.js";

let scratch: string;
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "tsinter-wasm-smalls-u2-"));
});
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

/** Compile ONE row's program (its own compile, static/plain mode) and
 * return its full stdout. `ext` picks the source extension — most rows
 * are `.ts`; a couple exercise a `.cjs`-only shape (the front end
 * canonicalises `.cjs`'s bare `toSpliced()` call differently than the
 * `.ts` form, which is itself a B-i refusal row in a later checkpoint). */
async function runRow(name: string, src: string, ext: "ts" | "cjs" = "ts"): Promise<string> {
  const entry = join(scratch, `${name}.${ext}`);
  await writeFile(entry, `${src}\n`);
  const res = await compile(entry, {
    outPath: join(scratch, `${name}.wasm`),
    outDir: scratch,
    backend: "wasm",
  });
  if (!res.ok) throw new Error(`${name} refused: ${res.diagnostics[0]?.message}`);
  const { stdout } = await runWasm(res.binaryPath);
  return stdout;
}

/** Same as runRow, but --dynamic (a value crosses into `any`). */
async function runRowDyn(name: string, src: string): Promise<string> {
  const entry = join(scratch, `${name}.ts`);
  await writeFile(entry, `${src}\n`);
  const res = await compile(entry, {
    outPath: join(scratch, `${name}.wasm`),
    outDir: scratch,
    backend: "wasm",
    dynamic: true,
  });
  if (!res.ok) throw new Error(`${name} refused: ${res.diagnostics[0]?.message}`);
  const { stdout } = await runWasm(res.binaryPath);
  return stdout;
}

/** Compile ONE row expecting a COMPILE-TIME refusal (a B-i row) in the
 * given mode; returns the sorted, de-duplicated "CODE:message" list. */
async function runRowRefuse(name: string, src: string, dynamic: boolean, ext: "ts" | "cjs" = "ts"): Promise<string[]> {
  const entry = join(scratch, `${name}.${ext}`);
  await writeFile(entry, `${src}\n`);
  const res = await compile(entry, {
    outPath: join(scratch, `${name}.wasm`),
    outDir: scratch,
    backend: "wasm",
    dynamic,
  });
  if (res.ok) throw new Error(`${name} [${dynamic ? "dyn" : "plain"}] compiled but was expected to refuse`);
  return [...new Set(res.diagnostics.map((d) => `${d.code}:${d.message}`))].sort();
}

/** Compile ONE row expecting an UNCAUGHT trap (runWasmToTrap reports
 * exitCode 0 on every trap — measured on 1304 — so a trap row NEVER
 * asserts exitCode; it asserts the exact stdout before the throw and
 * the exact stderr line). */
async function runRowTrap(name: string, src: string): Promise<{ stdout: string; stderr: string }> {
  const entry = join(scratch, `${name}.ts`);
  await writeFile(entry, `${src}\n`);
  const res = await compile(entry, {
    outPath: join(scratch, `${name}.wasm`),
    outDir: scratch,
    backend: "wasm",
  });
  if (!res.ok) throw new Error(`${name} refused: ${res.diagnostics[0]?.message}`);
  return runWasmToTrap(res.binaryPath);
}

// ============================================================
// COPIERS — arrIntrinsic:toReversed / toSpliced / with, all four
// VecInfo ElemKinds (f64, bool, string, ref-via-record, ref-via-symbol,
// ref-via-union).
// ============================================================

test("row1 f64 toReversed — receiver unchanged", async () => {
  const out = await runRow(
    "row1",
    'const a=[1,2,3,4]; const b=a.toReversed(); console.log(b.join(","), a.join(","));',
  );
  expect(out.trimEnd()).toBe("4,3,2,1 1,2,3,4");
});

test("row2 bool toReversed — receiver unchanged", async () => {
  const out = await runRow(
    "row2",
    'const a=[true,false,false]; const b=a.toReversed(); console.log(b.join(","), a.join(","));',
  );
  expect(out.trimEnd()).toBe("false,false,true true,false,false");
});

test("row3 string toReversed — receiver unchanged", async () => {
  const out = await runRow(
    "row3",
    'const a=["a","b","c"]; const b=a.toReversed(); console.log(b.join(","), a.join(","));',
  );
  expect(out.trimEnd()).toBe("c,b,a a,b,c");
});

test("row4 record (ref) toReversed — receiver unchanged", async () => {
  const out = await runRow(
    "row4",
    'type R={x:number}; const a: R[]=[{x:1},{x:2},{x:3}]; const b=a.toReversed(); ' +
      'let s=""; for(let i=0;i<b.length;i++){s+=`${b[i].x}`; if(i<b.length-1)s+=",";} ' +
      'let t=""; for(let i=0;i<a.length;i++){t+=`${a[i].x}`; if(i<a.length-1)t+=",";} console.log(s,t);',
  );
  expect(out.trimEnd()).toBe("3,2,1 1,2,3");
});

test("row5 symbol (ref) toReversed — copied elements keep IDENTITY", async () => {
  const out = await runRow(
    "row5",
    'const s=Symbol("s"); const a=[Symbol("a"),s]; const b=a.toReversed(); ' +
      "console.log(b[0]===s, b[1]===a[0]);",
  );
  expect(out.trimEnd()).toBe("true true");
});

test("row6 toSpliced() zero-argument call — the .cjs form (2671's own shape)", async () => {
  const out = await runRow(
    "row6",
    "const source = [1, 2, 3];\nconsole.log(source.toSpliced().join(\",\"), source.join(\",\"));",
    "cjs",
  );
  expect(out.trimEnd()).toBe("1,2,3 1,2,3");
});

test("row7 f64 toSpliced — argument forms, Node's own measured canonicalization", async () => {
  // -1 is included alongside -9: -9 saturates to the clamped-0 start
  // either way (correct or mis-normalised), so it alone cannot catch a
  // start-not-clamped mutation (measured: a mutant that skips the
  // negative-start normalisation reddens nothing against -9 alone). -1
  // is a SMALL negative start (relative index 2 on this length-3
  // receiver) whose correct and mis-normalised answers actually differ
  // ("1,2" vs "").
  const out = await runRow(
    "row7",
    "const a=[1,2,3]; console.log(a.toSpliced(1,-5,7).join(\",\"), a.toSpliced(1,Infinity).join(\",\"), " +
      "a.toSpliced(1.7,1.2).join(\",\"), a.toSpliced(9).join(\",\"), a.toSpliced(-9).join(\",\"), a.toSpliced(-1).join(\",\"));",
  );
  expect(out.trimEnd()).toBe("1,7,2,3 1 1,3 1,2,3  1,2");
});

test("row8 bool toSpliced — one non-trivial form", async () => {
  const out = await runRow(
    "row8",
    'const a=[true,false,true]; console.log(a.toSpliced(1,1,false).join(","), a.join(","));',
  );
  expect(out.trimEnd()).toBe("true,false,true true,false,true");
});

test("row9 string toSpliced — one non-trivial form", async () => {
  const out = await runRow(
    "row9",
    'const a=["a","b","c"]; console.log(a.toSpliced(1,1,"x","y").join(","), a.join(","));',
  );
  expect(out.trimEnd()).toBe("a,x,y,c a,b,c");
});

test("row10 record (ref) toSpliced — one non-trivial form", async () => {
  const out = await runRow(
    "row10",
    'type R={x:number}; const a: R[]=[{x:1},{x:2},{x:3}]; const b=a.toSpliced(1,1,{x:9}); ' +
      'let s=""; for(let i=0;i<b.length;i++){s+=`${b[i].x}`; if(i<b.length-1)s+=",";} console.log(s);',
  );
  expect(out.trimEnd()).toBe("1,9,3");
});

test("row11 f64 with — valid index", async () => {
  const out = await runRow("row11", 'const a=[1,2,3]; console.log(a.with(1,8).join(","), a.join(","));');
  expect(out.trimEnd()).toBe("1,8,3 1,2,3");
});

test("row12 bool with — valid index", async () => {
  const out = await runRow("row12", 'const a=[true,false,true]; console.log(a.with(0,false).join(","), a.join(","));');
  expect(out.trimEnd()).toBe("false,false,true true,false,true");
});

test("row13 string with — valid index", async () => {
  const out = await runRow("row13", 'const a=["a","b","c"]; console.log(a.with(2,"z").join(","), a.join(","));');
  expect(out.trimEnd()).toBe("a,b,z a,b,c");
});

test("row14 record (ref) with — valid index", async () => {
  const out = await runRow(
    "row14",
    'type R={x:number}; const a: R[]=[{x:1},{x:2},{x:3}]; const b=a.with(0,{x:9}); ' +
      'let s=""; for(let i=0;i<b.length;i++){s+=`${b[i].x}`; if(i<b.length-1)s+=",";} console.log(s);',
  );
  expect(out.trimEnd()).toBe("9,2,3");
});

test("row15 with — index coercion ladder, incl. the exact +/-length boundary", async () => {
  // length 3: 2 and -3 are the last-element boundary (both VALID);
  // -3.5/-0.5/NaN all read as index 0; 2.5 truncates to index 2.
  const out = await runRow(
    "row15",
    'const a=[1,2,3]; console.log(a.with(2,9).join(","), a.with(-3,9).join(",")); ' +
      'console.log(a.with(-3.5,9).join(","), a.with(-0.5,9).join(","), a.with(NaN,9).join(","), a.with(2.5,9).join(","));',
  );
  expect(out.trimEnd()).toBe("1,2,9 9,2,3\n9,2,3 9,2,3 9,2,3 1,2,9");
});

test("row16 with — RangeError CAUGHT, message byte for byte, incl. the +/-length+1 boundary", async () => {
  // length 3: index 3 (== length) and -4 (== -length-1) both throw.
  const out = await runRow(
    "row16",
    "const a=[1,2,3];\n" +
      "try { a.with(3,9); } catch(err){ const e = err as Error; console.log(e.name, e.message, e instanceof RangeError); }\n" +
      "try { a.with(-4,9); } catch(err){ const e = err as Error; console.log(e.name, e.message); }",
  );
  expect(out.trimEnd()).toBe("RangeError Invalid index : 3 true\nRangeError Invalid index : -4");
});

test("row17 with — RangeError UNCAUGHT, traps (runWasmToTrap; never asserts exitCode)", async () => {
  const { stdout, stderr } = await runRowTrap("row17", "const a=[1,2,3];\na.with(4,9);\nconsole.log(\"unreachable\");");
  expect(stdout).toBe("");
  expect(stderr).toContain("Uncaught RangeError: Invalid index : 4");
});

test("row71 union (ref-via-union) toReversed — (number|null)[], receiver unchanged", async () => {
  const out = await runRow(
    "row71",
    "const a: (number|null)[]=[1,null,3]; const b=a.toReversed(); " +
      'let s=""; for(let i=0;i<b.length;i++){const x=b[i]; s+= x===null?"null":`${x}`; if(i<b.length-1)s+=",";} ' +
      'let t=""; for(let i=0;i<a.length;i++){const x=a[i]; t+= x===null?"null":`${x}`; if(i<a.length-1)t+=",";} console.log(s,t);',
  );
  expect(out.trimEnd()).toBe("3,null,1 1,null,3");
});

test("row72 union (ref-via-union) toSpliced — (number|null)[], items incl. a null", async () => {
  const out = await runRow(
    "row72",
    "const a: (number|null)[]=[1,null,3]; const b=a.toSpliced(1,1,9,null); " +
      'let s=""; for(let i=0;i<b.length;i++){const x=b[i]; s+= x===null?"null":`${x}`; if(i<b.length-1)s+=",";} console.log(s);',
  );
  expect(out.trimEnd()).toBe("1,9,null,3");
});

test("row73 union (ref-via-union) with — (number|null)[], setting an index to null, in range", async () => {
  const out = await runRow(
    "row73",
    "const a: (number|null)[]=[1,2,3]; const b=a.with(1,null); " +
      'let s=""; for(let i=0;i<b.length;i++){const x=b[i]; s+= x===null?"null":`${x}`; if(i<b.length-1)s+=",";} console.log(s);',
  );
  expect(out.trimEnd()).toBe("1,null,3");
});

// ============================================================
// JOIN-UNION — arrIntrinsic:join:ref-elem over union elements (the front
// end's own join element fence: only {number,string,boolean}∪{null,
// undefined} arms ever reach the site — every other element kind is
// refused at the front end before it gets here).
// ============================================================

test("row18 null arm joins as empty string", async () => {
  const out = await runRow("row18", 'const a: (number|null)[] = [1, null, 2]; console.log(a.join(","));');
  expect(out.trimEnd()).toBe("1,,2");
});

test("row19 undefined arm joins as empty string", async () => {
  const out = await runRow("row19", 'const a: (number|undefined)[] = [1, undefined, 2]; console.log(a.join(","));');
  expect(out.trimEnd()).toBe("1,,2");
});

test("row20 f64 arm formats -0 as \"0\" (join's own number formatting, matching number[].join)", async () => {
  const out = await runRow("row20", 'const a: (number|null)[] = [-0]; console.log(a.join(","));');
  expect(out.trimEnd()).toBe("0");
});

test("row21 f64 arm formats NaN", async () => {
  const out = await runRow("row21", 'const a: (number|null)[] = [NaN]; console.log(a.join(","));');
  expect(out.trimEnd()).toBe("NaN");
});

test("row22 string arm containing the separator character prints verbatim", async () => {
  const out = await runRow("row22", 'const a: (string|null)[] = ["a,b", "c"]; console.log(a.join(","));');
  expect(out.trimEnd()).toBe("a,b,c");
});

test("row23 bool arms format as true/false", async () => {
  const out = await runRow("row23", 'const a: (boolean|null)[] = [true, false]; console.log(a.join(","));');
  expect(out.trimEnd()).toBe("true,false");
});

test("row24 empty array joins as empty string", async () => {
  const out = await runRow("row24", 'const a: (number|null)[] = []; console.log(a.join(","));');
  expect(out.trimEnd()).toBe("");
});

test("row25 single element — no separator emitted", async () => {
  const out = await runRow("row25", 'const a: (number|null)[] = [42]; console.log(a.join(","));');
  expect(out.trimEnd()).toBe("42");
});

test("row26 every element is a unit arm (null/undefined)", async () => {
  const out = await runRow("row26", 'const a: (number|undefined|null)[] = [null, undefined, null]; console.log(a.join(","));');
  expect(out.trimEnd()).toBe(",,");
});

test("row27 explicit empty-string separator", async () => {
  const out = await runRow("row27", 'const a: (number|null)[] = [1,2,3]; console.log(a.join(""));');
  expect(out.trimEnd()).toBe("123");
});

test("row28 implicit join via a template literal (no separator written in source)", async () => {
  const out = await runRow("row28", "const a: (number|null)[] = [1, null, 2]; console.log(`${a}`);");
  expect(out.trimEnd()).toBe("1,,2");
});

test("row29 implicit join via String()", async () => {
  const out = await runRow("row29", "const a: (number|null)[] = [1, null, 2]; console.log(String(a));");
  expect(out.trimEnd()).toBe("1,,2");
});

test("row30 a hole joins as an undefined arm", async () => {
  const out = await runRow("row30", 'const a: (number|undefined)[] = [1, , 3]; console.log(a.join(","));');
  expect(out.trimEnd()).toBe("1,,3");
});

test("row31 (number|void) union", async () => {
  const out = await runRow("row31", 'const a: (number|void)[] = [1, undefined, 3]; console.log(a.join(","));');
  expect(out.trimEnd()).toBe("1,,3");
});

test("row32 (number|null) union — a second, independent carrier shape", async () => {
  const out = await runRow("row32", 'const a: (number|null)[] = [1, null, 3]; console.log(a.join(","));');
  expect(out.trimEnd()).toBe("1,,3");
});

test("row33 an enum arm alongside string and null", async () => {
  const out = await runRow("row33", 'enum E { A, B } const a: (E|string|null)[] = [E.A, "x", null]; console.log(a.join(","));');
  expect(out.trimEnd()).toBe("0,x,");
});

test("row34 a generic T bound to number|null", async () => {
  const out = await runRow(
    "row34",
    "function f<T extends number|null>(x: T[]): string { return x.join(\",\"); } console.log(f<number|null>([1, null, 2]));",
  );
  expect(out.trimEnd()).toBe("1,,2");
});

test("row74 a union with NO unit arm — (number|string)[], 2670's own carrier shape", async () => {
  const out = await runRow("row74", 'const a: (number|string)[] = [1, "x", 2]; console.log(a.join(","));');
  expect(out.trimEnd()).toBe("1,x,2");
});

// ============================================================
// TEMPLATES — expr:templateStrings (2250's own per-site interning).
// ============================================================

test("row35 same site, two evaluations — identical array", async () => {
  const out = await runRow(
    "row35",
    'function tag(strings: TemplateStringsArray, ...values: number[]){ return strings; } function site(){ return tag`a${1}b`; } const s1=site(); const s2=site(); console.log(s1===s2);',
  );
  expect(out.trimEnd()).toBe("true");
});

test("row36 same site via a closure — identical array", async () => {
  const out = await runRow(
    "row36",
    'function tag(strings: TemplateStringsArray, ...values: number[]){ return strings; } function makeSite(){ return () => tag`x${1}y`; } const f1=makeSite(); const f2=makeSite(); console.log(f1()===f2());',
  );
  expect(out.trimEnd()).toBe("true");
});

test("row37 two textually-identical but DIFFERENT sites never share", async () => {
  const out = await runRow(
    "row37",
    'function tag(strings: TemplateStringsArray, ...values: number[]){ return strings; } function siteA(){ return tag`a${1}b`; } function siteB(){ return tag`a${1}b`; } console.log(siteA()===siteB());',
  );
  expect(out.trimEnd()).toBe("false");
});

test("row38 a generic function's two instantiations share ONE site", async () => {
  const out = await runRow(
    "row38",
    'function tag(strings: TemplateStringsArray, ...values: number[]){ return strings; } function site<T>(x: T){ return tag`v${1}w`; } const r1=site<number>(1); const r2=site<string>("s"); console.log(r1===r2);',
  );
  expect(out.trimEnd()).toBe("true");
});

test("row39 a generic class method's two instantiations share ONE site", async () => {
  const out = await runRow(
    "row39",
    'function tag(strings: TemplateStringsArray, ...values: number[]){ return strings; } class C<T> { m(){ return tag`p${1}q`; } } const c1=new C<number>(); const c2=new C<string>(); console.log(c1.m()===c2.m());',
  );
  expect(out.trimEnd()).toBe("true");
});

test("row40 the no-substitution form", async () => {
  const out = await runRow(
    "row40",
    'function tag(strings: TemplateStringsArray, ...values: number[]){ return strings; } console.log(tag`hello`.length, tag`hello`[0]);',
  );
  expect(out.trimEnd()).toBe("1 hello");
});

test("row41 leading and trailing empty cooked spans", async () => {
  const out = await runRow(
    "row41",
    'function tag(strings: TemplateStringsArray, ...values: number[]){ return strings; } const s=tag`${1}mid${2}`; console.log(s.length, JSON.stringify(s[0]), s[1], JSON.stringify(s[2]));',
  );
  expect(out.trimEnd()).toBe('3 "" mid ""');
});

test("row42 the strings array passed as an ordinary function argument", async () => {
  const out = await runRow(
    "row42",
    'function tag(strings: TemplateStringsArray, ...values: number[]){ return strings; } function useIt(arr: readonly string[]){ return arr.length; } console.log(useIt(tag`a${1}b`));',
  );
  expect(out.trimEnd()).toBe("2");
});

test("row43 S080 plain shape: `as unknown as string[]` + push succeeds and MUTATES the interned array (Node freezes; this tier does not — REGISTERED, not fixed)", async () => {
  const out = await runRow(
    "row43",
    'function tag(strings: TemplateStringsArray, ...values: number[]){ return strings; } function site(){ return tag`a${1}b`; } const p=site() as unknown as string[]; p.push("EXTRA"); console.log(p.length); console.log(site().length);',
  );
  // Node: p.push throws "TypeError: Cannot add property 2, object is not
  // extensible" and a second site() call still has length 2. This tier's
  // measured (registered, S080) behavior: the push SUCCEEDS silently and
  // the SECOND evaluation of the same site shows the MUTATION persisting.
  expect(out.trimEnd()).toBe("3\n3");
});

test("row44 S080 --dynamic shape: crossing into `any` copies (S014) — the write succeeds on the COPY, the interned original is UNCHANGED", async () => {
  const out = await runRowDyn(
    "row44",
    'function tag(strings: TemplateStringsArray, ...values: number[]){ return strings; } function site2(){ return tag`c${1}d`; } const q: any = site2(); q[0]="Q"; console.log(`${q[0]}`); console.log(`${site2()[0]}`);',
  );
  // Node (strict-mode ESM): q[0]="Q" throws "TypeError: Cannot assign to
  // read only property '0' of object '[object Array]'" and the site
  // re-read is unchanged ("c"). This tier's measured (registered, S080 +
  // S014) behavior: the write succeeds (no throw) on a COPY made at the
  // unknown boundary, so the ORIGINAL interned array — read back through
  // a SECOND, un-widened call to the same site — stays "c".
  expect(out.trimEnd()).toBe("Q\nc");
});

test("row75 S080 CommonJS/sloppy shape: an in-bounds index write is SILENTLY IGNORED by Node; this tier's own answer is the SAME shape as row44's", async () => {
  const out = await runRow(
    "row75",
    'function tag(strings, ...values) { return strings; } function site2() { return tag`c${1}d`; } const q = site2(); q[0] = "Q"; console.log(q[0], site2()[0]);',
    "cjs",
  );
  // Node (CommonJS/sloppy mode): an in-bounds index write on a frozen
  // array is SILENTLY IGNORED (no throw, unlike strict-mode ESM) — Node
  // prints "c c" (the write never took effect, q[0] itself still reads
  // "c"). This tier's measured answer for a `.cjs` source (untyped, so
  // the value already carries the S014 unknown-boundary shape without
  // an explicit widening cast) prints "Q c": q[0] itself DOES show the
  // write (the first read is through the very reference the write
  // landed on), while a SECOND, independent evaluation of the same site
  // ("c") is unaffected — the SAME shape as row44's --dynamic answer
  // ("Q\nc": the write visible through the value, the interned original
  // unchanged on re-evaluation), not a third distinct one; only the
  // print format differs (space- vs newline-joined) because row75's
  // source is untyped from the start rather than cast to `any`.
  expect(out.trimEnd()).toBe("Q c");
});

// ============================================================
// TOSTRING-RECORD — the toString walk's record arm (1872, 1983).
// ============================================================

test("row45 s01: the operand evaluates BEFORE the constant renders (side effect observable)", async () => {
  const out = await runRow("row45", 'let evals=0; function f(){ evals++; return 7; } console.log(`<${{ a: f() }}>`); console.log(evals);');
  expect(out.trimEnd()).toBe("<[object Object]>\n1");
});

test("row46 s02: string concatenation and String() both give the same constant", async () => {
  const out = await runRow("row46", 'const r={x:1}; console.log("x"+r, String(r));');
  expect(out.trimEnd()).toBe("x[object Object] [object Object]");
});

test("row47 s04: an empty record", async () => {
  const out = await runRow("row47", "console.log(`${{}}`);");
  expect(out.trimEnd()).toBe("[object Object]");
});

test("row48 s05: a record with an optional field", async () => {
  const out = await runRow("row48", 'type R={a:number,b?:string}; const r: R={a:1}; console.log(`${r}`);');
  expect(out.trimEnd()).toBe("[object Object]");
});

test("row49 s06: a record narrowed from a nullable union", async () => {
  const out = await runRow("row49", 'type R={a:number}; const x: R|null={a:5}; if (x!==null) { console.log(`${x}`); }');
  expect(out.trimEnd()).toBe("[object Object]");
});

// ============================================================
// CLASSVAL — classval:no-ctor (1973's decorator-guarded class, v05's
// non-decorator carrier, and the compiling controls).
// ============================================================

test("row50 v01: a static-only class value (compiling control)", async () => {
  const out = await runRow("row50", "class K { static x=1; } function mk(): typeof K { return K; } const k=mk(); console.log(k.x);");
  expect(out.trimEnd()).toBe("1");
});

test("row51 v03: an empty class value (compiling control)", async () => {
  const out = await runRow("row51", "class Empty {} function mk(): typeof Empty { return Empty; } const E=mk(); const e=new E(); console.log(e instanceof Empty);");
  expect(out.trimEnd()).toBe("true");
});

test("row52 v04: an APPLIED decorator's class value (compiling control — has a ctor)", async () => {
  const out = await runRow("row52", 'function dec(t: typeof D): void { console.log("applied", t.name); } @dec class D { x: number; constructor(x: number) { this.x=x; } } const d=new D(5); console.log(d.x);');
  expect(out.trimEnd()).toBe("applied D\n5");
});

test("row53 v05: a NON-decorator ctor-less carrier — the class is used ONLY as a type, never materialised as a value", async () => {
  const out = await runRow(
    "row53",
    'class K {} function mk(): (t: typeof K) => void { return (t) => console.log("x"); } const g = mk(); console.log("made");',
  );
  expect(out.trimEnd()).toBe("made");
});

test("row54 1973: the decorator-guarded ctor-less class — before/factory-first/throw, nothing after", async () => {
  const entry = fileURLToPath(new URL("../../../tests/corpus/1973-decorators-ambient.ts", import.meta.url));
  const res = await compile(entry, { outPath: join(scratch, "row54.wasm"), outDir: scratch, backend: "wasm" });
  if (!res.ok) throw new Error(`row54 refused: ${res.diagnostics[0]?.message}`);
  const { stdout, stderr } = await runWasmToTrap(res.binaryPath);
  expect(stdout).toBe("before\nfactory first\n");
  expect(stderr).toContain("Uncaught ReferenceError: vanish is not defined");
});

// ============================================================
// B-i — front-end refusals the seven keys' own element/argument fences
// pin (never lifted).
// ============================================================

test("row55 B-i [plain]: join over (record|null)[] with an explicit separator", async () => {
  const diags = await runRowRefuse("row55", 'type R={x:number}; const a: (R|null)[]=[{x:1},null]; console.log(a.join(","));', false);
  expect(diags).toEqual([
    "SC1090:'.join()' on arrays of this element type (number, string, and boolean arrays join — unions of those with undefined/null arms too, the units printing empty like JS) is not supported yet",
  ]);
});

test("row56 B-i [plain]: join over (class|undefined)[] with an explicit separator", async () => {
  const diags = await runRowRefuse("row56", 'class K { toString(){ return "k"; } } const a: (K|undefined)[]=[new K(),undefined]; console.log(a.join(","));', false);
  expect(diags).toEqual([
    "SC1090:'.join()' on arrays of this element type (number, string, and boolean arrays join — unions of those with undefined/null arms too, the units printing empty like JS) is not supported yet",
  ]);
});

test("row57 B-i [plain]: join over (record|record)[] with an explicit separator", async () => {
  const diags = await runRowRefuse("row57", 'type A={k:"a"}; type B={k:"b"}; const a: (A|B)[]=[{k:"a"},{k:"b"}]; console.log(a.join(","));', false);
  expect(diags).toEqual([
    "SC1090:'.join()' on arrays of this element type (number, string, and boolean arrays join — unions of those with undefined/null arms too, the units printing empty like JS) is not supported yet",
  ]);
});

test("row58 B-i [plain]: join with ZERO arguments (the arity fence — number[]; the ONLY row asserting this fence)", async () => {
  const diags = await runRowRefuse("row58", "const a: number[] = [1, -0, NaN]; console.log(a.join());", false);
  expect(diags).toEqual(["SC2020:'.join with 0 arguments' is part of the standard library types but has no scriptc lowering yet"]);
});

test("row59 B-i [plain]: an array of Date (element does not compile) — the EXACT two-diagnostic set, an explicit separator so the arity fence never fires here (row58 alone owns it)", async () => {
  const diags = await runRowRefuse("row59", 'const a: Date[] = [new Date(0)]; console.log(a.join(","));', false);
  expect(diags).toEqual([
    "SC2009:values of type 'Date[]' cannot be compiled: the array shape is supported, but its element type 'Date' does not compile",
    "SC2020:'Date[].join' is part of the standard library types but has no scriptc lowering yet",
  ]);
});

test("row60 B-i [plain]: a (bigint|null)[] union — the EXACT two-diagnostic set, an explicit separator (same shape as row59)", async () => {
  const diags = await runRowRefuse("row60", 'const a: (bigint | null)[] = [1n, null]; console.log(a.join(","));', false);
  expect(diags).toEqual([
    "SC2009:values of type '(bigint | null)[]' cannot be compiled: the array shape is supported, but its element type 'bigint | null' does not compile",
    "SC2020:'(bigint | null)[].join' is part of the standard library types but has no scriptc lowering yet",
  ]);
});

test("row61 B-i [plain]: a nested array element (number[][])", async () => {
  const diags = await runRowRefuse("row61", 'const a: number[][] = [[1,2],[3]]; console.log(a.join("-"));', false);
  expect(diags).toEqual([
    "SC1090:'.join()' on arrays of this element type (number, string, and boolean arrays join — unions of those with undefined/null arms too, the units printing empty like JS) is not supported yet",
  ]);
});

test("row62 B-i [plain]: a function-typed union element ((fn|null)[])", async () => {
  const diags = await runRowRefuse("row62", 'const a: ((() => number) | null)[] = [null]; console.log(a.join(","));', false);
  expect(diags).toEqual([
    "SC1090:'.join()' on arrays of this element type (number, string, and boolean arrays join — unions of those with undefined/null arms too, the units printing empty like JS) is not supported yet",
  ]);
});

test("row63 B-i: `.raw` — BOTH build modes", async () => {
  const src = 'function tag(strings: TemplateStringsArray, ...values: number[]){ return strings; } console.log(tag`a${1}b`.raw);';
  const plain = await runRowRefuse("row63plain", src, false);
  const dyn = await runRowRefuse("row63dyn", src, true);
  expect(plain).toEqual(["SC2020:'TemplateStringsArray.raw' is part of the standard library types but has no scriptc lowering yet"]);
  expect(dyn).toEqual(["SC2020:'TemplateStringsArray.raw' is part of the standard library types but has no scriptc lowering yet"]);
});

test("row64 B-i [plain]: an invalid escape sequence in a TAGGED template (the span cooks to undefined)", async () => {
  const diags = await runRowRefuse("row64", "function tag(strings: TemplateStringsArray, ...values: number[]){ return strings; } console.log(tag`\\unicode${1}`);", false);
  expect(diags).toEqual([
    "SC1090:tagged templates with invalid escape sequences (the span cooks to undefined, which the strings array cannot carry) are not supported yet",
  ]);
});

test("row65 B-i [plain]: Object.isFrozen on the strings array", async () => {
  const diags = await runRowRefuse("row65", 'function tag(strings: TemplateStringsArray, ...values: number[]){ return strings; } console.log(Object.isFrozen(tag`a${1}b`));', false);
  expect(diags).toEqual(["SC2020:'Object.isFrozen' is part of the standard library types but has no scriptc lowering yet"]);
});

test("row66 B-i: a tuple's toString — MODE-DEPENDENT codes (SC2011 plain, SC2001 --dynamic)", async () => {
  const src = 'const t: [number,string] = [1,"a"]; console.log(`${t}`);';
  const plain = await runRowRefuse("row66plain", src, false);
  const dyn = await runRowRefuse("row66dyn", src, true);
  expect(plain).toEqual([
    "SC2011:values of type '[number, string]' have no static representation but run in the embedded dynamic engine, which this build does not include",
  ]);
  expect(dyn).toEqual([
    "SC2001:values of type '[number, string]' cannot be compiled yet (supported: number, string, boolean, arrays, Maps, Sets, RegExp, functions, classes, records, unions of those, and 'unknown')",
  ]);
});

test("row67 B-i [plain]: toSpliced() with ZERO arguments — the .ts spelling (paired with row6's compiling .cjs twin)", async () => {
  const diags = await runRowRefuse("row67", "const source=[1,2,3]; console.log(source.toSpliced());", false);
  expect(diags).toEqual(["SC0001:Expected at least 1 arguments, but got 0."]);
});

// ============================================================
// NOT-LIFTED — a shape that reaches one of the seven keys' neighborhood
// but is NOT part of this unit (its own, different, still-refused key).
// ============================================================

test("row68 NOT-LIFTED: 2251 (a dyn-tagged template) stays refused at expr:jsOp", async () => {
  const entry = fileURLToPath(new URL("../../../tests/corpus/2251-tagged-templates-dyn.ts", import.meta.url));
  const res = await compile(entry, { outPath: join(scratch, "row68.wasm"), outDir: scratch, backend: "wasm", dynamic: true });
  if (res.ok) throw new Error("row68 (2251) compiled but was expected to stay refused at expr:jsOp");
  const codes = res.diagnostics.map((d) => d.code);
  expect(codes).toContain("SC3001");
  expect(res.diagnostics.some((d) => d.message.includes("expr:jsOp"))).toBe(true);
});

// ============================================================
// REGRESSION — pre-existing, unaffected constructs (a value-path mutant
// that touches shared code would break these too).
// ============================================================

test("row69 REGRESSION: 512 (an existing number[]/string[] join program) is unaffected", async () => {
  const entry = fileURLToPath(new URL("../../../tests/corpus/512-array-join-chains.ts", import.meta.url));
  const res = await compile(entry, { outPath: join(scratch, "row69.wasm"), outDir: scratch, backend: "wasm" });
  if (!res.ok) throw new Error(`row69 (512) refused: ${res.diagnostics[0]?.message}`);
  const { stdout } = await runWasm(res.binaryPath);
  expect(stdout.trimEnd()).toBe(
    "1,2,3\n1.5|0|0.1|1e+21|1e-7\nNaN Infinity -Infinity\na--c\ntrue&false&true\nsolo 42\n<>\nxy\np :: q\n4,16,36\n18\n10+20=30 2",
  );
});

test("row70 REGRESSION: 2667-array-to-sorted-any.ts (a claimed toSorted program) is unaffected", async () => {
  const entry = fileURLToPath(new URL("../../../tests/corpus/2667-array-to-sorted-any.ts", import.meta.url));
  const res = await compile(entry, { outPath: join(scratch, "row70.wasm"), outDir: scratch, backend: "wasm", dynamic: true });
  if (!res.ok) throw new Error(`row70 (2667) refused: ${res.diagnostics[0]?.message}`);
  const { stdout } = await runWasm(res.binaryPath);
  expect(stdout.trimEnd()).toBe("4 1 2 undefined undefined 1\n4 undefined 2 1 undefined");
});
