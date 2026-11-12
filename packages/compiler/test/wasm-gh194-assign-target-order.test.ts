/* GH #194: an assignment's target receiver (and an element target's key)
 * evaluates BEFORE the right-hand side. `box.inner.v = rhs()` where rhs
 * reassigns box.inner writes the OLD object in Node; the lowering used to
 * re-read the receiver after the right-hand side ran. Now a right-hand side
 * that may write a binding (a call, new, an assignment, ++/--, delete,
 * await, yield) makes the receiver/key evaluate into hidden locals first,
 * for plain `=` and for `??=` (n8n step 3's member form). Reads below go
 * through functions so TypeScript's flow narrowing (which does not see the
 * call's writes) is not involved. Rows run under Node and on both WasmGC
 * lanes. */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { checkRow, type Row, scratchDir } from "./top10-paperclip-rows.js";
import { runWasmToTrap } from "./wasm-host.js";

const scratch = scratchDir("gh194");

const ROWS: Row[] = [
  {
    id: "GH194-01 record, class-free object, array and index-signature targets; '=' and '??='",
    nodeTypes: false,
    files: {
      "main.ts": `const v = (o: { v: number | null }): number | null => o.v;
const box: { inner: { v: number | null } } = { inner: { v: null } };
const old = box.inner;
function rhs2(): number { box.inner = { v: 100 }; return 5; }
box.inner.v = rhs2();
console.log(v(old), v(box.inner));
let obj: { v: number | null } = { v: null };
const first = obj;
function rhs3(): number { obj = { v: null }; return 7; }
obj.v = rhs3();
console.log(v(first), v(obj));
const arr: (number | null)[] = [null, null];
let j = 0;
function rhs4(): number { j = 1; return 8; }
arr[j] = rhs4();
const at = (i: number): number | null | undefined => arr[i];
console.log(at(0), at(1), j);
const o2: Record<string, number | null> = { a: null, b: null };
let k = "a";
function rhs5(): number { k = "b"; return 1; }
o2[k] = rhs5();
console.log(JSON.stringify(o2), k);
let obj2: { v: number | null } = { v: null };
const first2 = obj2;
function rhs6(): number { obj2 = { v: null }; return 9; }
obj2.v ??= rhs6();
console.log(v(first2), v(obj2));
const arr2: (number | null)[] = [null, null];
let j2 = 0;
function rhs7(): number { j2 = 1; return 3; }
arr2[j2] ??= rhs7();
console.log(JSON.stringify(arr2), j2);`,
    },
  },
  {
    id: "GH194-02 the key expression and an increment in the right-hand side",
    nodeTypes: false,
    files: {
      "main.ts": `const xs = [0, 0, 0, 0];
let i = 0;
xs[i] = ++i;
xs[i] = i++ + 10;
console.log(xs.join(","), i);
class C {
  n = 0;
}
let c = new C();
const c0 = c;
c.n = (c = new C(), 4);
console.log(c0.n, c.n);`,
    },
  },
  {
    id: "GH194-03 compound member assignment: += -= **= and string += write the object read before the right-hand side",
    nodeTypes: false,
    files: {
      "main.ts": `let box = { v: 1, s: "a" };
const first = box;
function swap(): number { box = { v: 100, s: "z" }; return 10; }
box.v += swap();
console.log(first.v, box.v);
box = first;
box.s += String(swap());
console.log(first.s, box.s);
class K {
  n = 1;
  inc(): number { this.n = 100; return 5; }
  go(): void { this.n += this.inc(); console.log(this.n); }
}
new K().go();
let cnt = { c: 1 };
const c0 = cnt;
function sw(): number { cnt = { c: 50 }; return 2; }
cnt.c -= sw();
cnt = c0;
cnt.c **= sw();
console.log(c0.c, cnt.c);`,
    },
  },
];

for (const backend of ["wasm", "wasm-native"] as const) {
  describe(`GH #194: assignment target order (${backend} lane vs Node)`, () => {
    test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
      await checkRow(scratch, row, backend);
    }, 600_000);
  });
}

/* A narrowing the type checker cannot see undone (TypeScript keeps
 * `obj.v` narrowed to number across a call that replaced obj): the read
 * stops at S122's fence, whose message names that cause. */
describe("GH #194: a stale flow narrowing stops by name (wasm lane)", () => {
  test("GH194-04 obj.v read after a call replaced obj", async () => {
    const file = join(scratch, "GH194-04.ts");
    writeFileSync(file, `let obj: { v: number | null } = { v: null };
function rhs(): number { obj = { v: null }; return 7; }
obj.v = rhs();
console.log("before");
console.log(obj.v);
`);
    const res = await compile(file, { outPath: join(scratch, "GH194-04.wasm"), outDir: scratch, backend: "wasm" });
    if (!res.ok) throw new Error(res.diagnostics.map((d) => `${d.code} ${d.message}`).join(" | "));
    const r = await runWasmToTrap(res.binaryPath);
    expect(String(r.stdout)).toBe("before\n");
    expect(String(r.stderr)).toContain("a write the checker did not track, such as one inside a called function, replaced it");
  }, 600_000);
});
