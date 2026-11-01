/* GH #80: sorting on the WasmGC lanes is V8's (SEMANTICS.md S024). A comparator can log
 * its calls, so the exact sequence of (x, y) pairs is observable and is what these
 * rows pin, byte for byte against Node, on the wasm and wasm-native lanes:
 *
 *   1. the full call sequence over the shapes TimSort's paths turn on (random, sorted,
 *      reversed, sawtooth, duplicates, runs that gallop) around its size thresholds;
 *   2. every element representation and entry point (strings, records, unions, unknown
 *      and JSON values, typed arrays, sort and toSorted, the default order);
 *   3. what a comparator can do mid-sort (throw, mutate, nest, answer a non-number);
 *   4. the engine's own sort, the same text (any[] and __island_eval).
 *
 * Nothing below is hand-typed output: every expectation is Node running the same
 * source. A million-number sort pins speed and the absence of a stack limit. */
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { HEADER_PATH, OUT_PATH, renderTimsortSrc } from "../../../scripts/gen-wasm-timsort-src.mjs";
import { runWasm } from "./wasm-host.js";

const run = promisify(execFile);
const scratch = mkdtempSync(join(tmpdir(), "tsinter-sort-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

interface Out {
  stdout: string;
  code: number;
}

async function exec(cmd: string, args: string[]): Promise<Out> {
  return run(cmd, args, { maxBuffer: 1 << 30 }).then(
    (r) => ({ stdout: r.stdout, code: 0 }),
    (e: { stdout?: string; code?: number }) => ({ stdout: e.stdout ?? "", code: e.code ?? -1 }),
  );
}

/** Node's answer for `src`, then each lane's, which must be the same bytes. */
async function againstNode(id: string, src: string, opts: { dynamic?: boolean; island?: boolean } = {}): Promise<string> {
  const file = join(scratch, `${id}.ts`);
  writeFileSync(file, src);
  let oracle = file;
  if (opts.island) {
    oracle = join(scratch, `${id}.node.ts`);
    writeFileSync(oracle, `const __island_eval = (s: string): unknown => (0, eval)(s);\n${src}`);
  }
  const node = await exec("node", ["--experimental-transform-types", "--no-warnings", oracle]);
  const dynamic = opts.dynamic === true;
  const wasm = await compile(file, { outPath: join(scratch, `${id}.wasm`), outDir: scratch, backend: "wasm", dynamic });
  if (!wasm.ok) throw new Error(`${id} refused: ${wasm.diagnostics.map((d) => `${d.code} ${d.message}`).join(" | ")}`);
  const w = await runWasm(wasm.binaryPath);
  expect({ stdout: String(w.stdout), code: w.exitCode }).toEqual(node);
  const dir = join(scratch, `${id}-native`);
  mkdirSync(dir, { recursive: true });
  const nat = await compile(file, { outPath: join(dir, "program"), outDir: dir, backend: "wasm-native", dynamic });
  if (!nat.ok) throw new Error(`${id} refused natively: ${nat.diagnostics.map((d) => `${d.code} ${d.message}`).join(" | ")}`);
  expect(await exec(nat.binaryPath, [])).toEqual(node);
  return node.stdout;
}

const SHAPES = String.raw`
function lcg(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s;
  };
}
function shapes(n: number): [string, number[]][] {
  const r = lcg(n + 1);
  return [
    ["random", Array.from({ length: n }, () => r() % 100000)],
    ["sorted", Array.from({ length: n }, (_, i) => i)],
    ["reversed", Array.from({ length: n }, (_, i) => n - i)],
    ["sawtooth", Array.from({ length: n }, (_, i) => i % 17)],
    ["duplicates", Array.from({ length: n }, () => r() % 4)],
    ["gallop-a-first", Array.from({ length: n }, (_, i) => (i < n / 2 ? i * 2 : (i - n / 2) * 2 + 100000))],
    ["gallop-b-first", Array.from({ length: n }, (_, i) => (i < n / 2 ? i + 100000 : i - n / 2))],
    ["runs", Array.from({ length: n }, (_, i) => (Math.floor(i / 70) % 2 === 0 ? i : n - i))],
    ["interleaved", Array.from({ length: n }, (_, i) => (i % 128 < 64 ? i * 3 : i))],
  ];
}
`;

const SIZES = [0, 1, 2, 3, 4, 5, 21, 22, 23, 31, 32, 33, 63, 64, 65, 127, 128, 255, 256, 257, 1000, 10000];

describe("the comparator's calls, as Node makes them", () => {
  test("every (x, y) pair, in order, over TimSort's shapes and thresholds", async () => {
    const out = await againstNode(
      "sequence",
      SHAPES +
        String.raw`
for (const n of [${SIZES.join(",")}]) {
  for (const [name, a] of shapes(n)) {
    const log: number[] = [];
    a.sort((x, y) => {
      log.push(x, y);
      return x - y;
    });
    console.log(name, n, log.length / 2, log.join(" "), a.slice(0, 20).join(","));
  }
}
`,
    );
    // The row is about the sequence: it really logged millions of operands.
    expect(out.length).toBeGreaterThan(1_000_000);
  }, 300_000);

  test("toSorted, a descending comparator and a sparse-answering one", async () => {
    await againstNode(
      "variants",
      SHAPES +
        String.raw`
for (const n of [3, 22, 64, 257, 1000]) {
  for (const [name, a] of shapes(n)) {
    const log: number[] = [];
    const b = a.toSorted((x, y) => {
      log.push(x, y);
      return y - x;
    });
    let calls = 0;
    a.sort((x, y) => {
      calls++;
      return calls % 7 === 0 ? 0 : calls % 3 === 0 ? -1 : x - y;
    });
    console.log(name, n, log.join(" "), b.slice(0, 8).join(","), calls, a.join(","));
  }
}
`,
    );
  }, 300_000);

  test("2000 strings and 60000 records: V8's call counts, in Node's time", async () => {
    await againstNode(
      "counts",
      String.raw`
const words: string[] = [];
let s = 7;
for (let i = 0; i < 2000; i++) {
  s = (s * 1103515245 + 12345) % 2147483648;
  words.push("w" + (s % 5000));
}
let calls = 0;
words.sort((a, b) => {
  calls++;
  return a < b ? -1 : a > b ? 1 : 0;
});
console.log(calls, words[0], words[1999]);
calls = 0;
const xs = Array.from({ length: 60000 }, (_, i) => ({ k: (i * 7919) % 60000 }));
xs.sort((a, b) => {
  calls++;
  return a.k - b.k;
});
console.log(calls, xs[0]!.k, xs[59999]!.k);
`,
    );
  }, 120_000);

  test("a million numbers", async () => {
    await againstNode(
      "million",
      String.raw`
const big: number[] = [];
let s = 7;
for (let i = 0; i < 1000000; i++) {
  s = (s * 1103515245 + 12345) % 2147483648;
  big.push(s);
}
let calls = 0;
const sorted = big.toSorted((a, b) => {
  calls++;
  return a - b;
});
console.log(calls, sorted[0], sorted[999999]);
big.sort();
console.log(big[0], big[500000], big[999999]);
`,
    );
  }, 300_000);
});

describe("every element representation", () => {
  test("default order", async () => {
    await againstNode(
      "default",
      String.raw`
const s = ["b", "a", "d", "c", "aa", "😀", "", "z", ""];
console.log(s.toSorted().join("|"), s.join("|"));
s.sort();
console.log(s.join("|"));
const nums = [10, 9, 1, 100, -5, -50, 2.5, 1e21, 0, -0, NaN, Infinity, -Infinity, 1073741823, 1073741824, -1073741824, 4294967296, 1e-7];
console.log(nums.toSorted().join(","));
nums.sort(undefined);
console.log(nums.join(","));
console.log([true, false, true, false].sort().join(","));
const mixed = [3, "a", 1, true, null, undefined, "b", false, 10];
console.log(mixed.sort().join(","), mixed.length);
const maybe: (string | undefined)[] = ["b", undefined, "a", undefined, "c"];
maybe.sort();
console.log(maybe);
console.log(maybe.toSorted());
const un: unknown[] = [3, "x", undefined, 1, null, 20, "10", true];
un.sort();
console.log(un);
const parsed = JSON.parse('[3,null,"b",1,"a",true,{"x":1},[2,1],false,-1,10,9,2.5]');
console.log(JSON.stringify(parsed.sort()));
`,
    );
  });

  test("a comparator over each representation", async () => {
    await againstNode(
      "reprs",
      String.raw`
class Pt {
  constructor(public x: number) {}
}
const log: string[] = [];
const recs = [{ k: 2, v: "a" }, { k: 1, v: "b" }, { k: 2, v: "c" }, { k: 1, v: "d" }, { k: 0, v: "e" }];
console.log(recs.sort((a, b) => a.k - b.k).map((o) => o.v).join(""));
const pts = [new Pt(3), new Pt(1), new Pt(2)];
console.log(pts.toSorted((a, b) => b.x - a.x).map((p) => p.x).join(","), pts[0]!.x);
const u: (number | string)[] = [3, "a", 1, "b", 2];
u.sort((a, b) => {
  log.push(a + ":" + b);
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
});
console.log(u.join(","), log.join(" "));
log.splice(0);
const opt: (number | undefined)[] = [3, undefined, 1, undefined, 2];
opt.sort((a, b) => {
  log.push(a + ":" + b);
  return (a as number) - (b as number);
});
console.log(opt, log.join(" "));
const plain = [3, undefined as unknown as number, 1, undefined as unknown as number, 2];
let calls = 0;
plain.sort((a, b) => {
  calls++;
  return a - b;
});
console.log(plain, calls);
console.log(plain.toSorted((a, b) => b - a));
const strs = ["b", undefined as unknown as string, "a"];
console.log(strs.sort((a, b) => (a < b ? 1 : -1)));
const bools = [true, false, undefined as unknown as boolean, true];
console.log(bools.sort((a, b) => Number(a) - Number(b)));
const nested = [[3, 1], [2, 9, 4], [7]];
console.log(JSON.stringify(nested.sort((a, b) => a.length - b.length)));
const fns = [() => 2, () => 1];
console.log(fns.sort((a, b) => a() - b())[0]!());
const un: unknown[] = [3, undefined, 1, 2, undefined];
let c = 0;
un.sort((a, b) => {
  c++;
  return (a as number) - (b as number);
});
console.log(un, c);
const concat = "ab".split("").map((x) => x + "z" + x).concat(["q".repeat(3)]);
console.log(concat.sort((a, b) => (a < b ? 1 : -1)).join(","));
const seq = (input: any): string => {
  const pairs: string[] = [];
  input.sort((x: number, y: number) => {
    pairs.push(x + ":" + y);
    return x < y ? -1 : x > y ? 1 : 0;
  });
  return pairs.join(" ");
};
console.log(seq(JSON.parse("[5,2,8,1,9,3,7,4,6,0,11,10]")));
const big: number[] = [];
let s = 1;
for (let i = 0; i < 700; i++) {
  s = (s * 1103515245 + 12345) % 2147483648;
  big.push(s % 1000);
}
console.log(seq(JSON.parse(JSON.stringify(big))));
`,
    );
  });

  test("typed arrays: V8's merge sort with a comparator, numeric without", async () => {
    await againstNode(
      "typed",
      String.raw`
const u8 = new Uint8Array([5, 1, 200, 3, 77, 3, 9, 0, 255, 12, 4, 6]);
const log: string[] = [];
const by = (a: number, b: number): number => {
  log.push(a + ":" + b);
  return a - b;
};
console.log(u8.toSorted().join(","), u8.join(","));
console.log(u8.toSorted((a, b) => b - a).join(","), u8.join(","));
console.log(u8.sort(by).join(","), log.join(" "));
u8.sort((a, b) => b - a);
console.log(u8.join(","));
u8.sort();
console.log(u8.join(","), u8.sort(undefined) === u8);
const f32 = new Float32Array([1.5, -0, 0, NaN, -3, Infinity, -Infinity, 0.1, 0, -0]);
f32.sort();
const seen: string[] = [];
for (const x of f32) seen.push(Object.is(x, -0) ? "-0" : String(x));
console.log(seen.join(","));
log.splice(0);
const i32 = new Int32Array(40);
for (let i = 0; i < 40; i++) i32[i] = ((i * 7919) % 41) - 20;
i32.sort(by);
console.log(i32[0], i32[39], log.join(" "));
const u32 = new Uint32Array([4000000000, 1, 3000000000, 2]);
console.log(u32.sort()[3], u32.toSorted((a, b) => b - a)[0]);
const threw = new Uint8Array([3, 2, 1, 0, 9]);
try {
  threw.sort((a, b) => {
    if (a === 0) throw new Error("boom");
    return a - b;
  });
} catch (e) {
  console.log((e as Error).message, threw.join(","));
}
`,
    );
  });
});

describe("what a comparator can do", () => {
  test("throw, mutate the receiver, nest, answer anything", async () => {
    await againstNode(
      "behaviour",
      String.raw`
const t = [5, 4, 3, 2, 1, 0];
try {
  t.sort((a, b) => {
    if (a === 2) throw new Error("boom");
    return a - b;
  });
} catch (e) {
  console.log((e as Error).message, t.join(","));
}
const big = Array.from({ length: 200 }, (_, i) => (i * 37) % 200);
let n = 0;
try {
  big.sort((a, b) => {
    if (++n === 1000) throw new RangeError("late");
    return a - b;
  });
} catch (e) {
  console.log((e as Error).name, n, big.join(","));
}
n = 0;
try {
  big.toSorted((a, b) => {
    if (++n === 300) throw new Error("copy");
    return a - b;
  });
} catch (e) {
  console.log((e as Error).message, n, big.slice(0, 5).join(","));
}
const shrink = [5, 3, 9, 1, 7, 2];
shrink.sort((a, b) => {
  if (shrink.length > 4) {
    shrink.pop();
    shrink.pop();
  }
  return a - b;
});
console.log(shrink.join(","), shrink.length);
const empty = [5, 3, 9];
empty.sort((a, b) => {
  empty.splice(0);
  return a - b;
});
console.log(empty.join(","), empty.length);
const grow = [5, 3, 9];
grow.sort((a, b) => {
  if (grow.length < 5) grow.push(100);
  return a - b;
});
console.log(grow.join(","), grow.length);
const write = [5, 3, 9, 1];
write.sort((a, b) => {
  write[0] = 42;
  return a - b;
});
console.log(write.join(","));
const nest = [[3, 1], [2, 9, 4], [7]];
nest.sort((a, b) => a.sort((x, y) => x - y)[0]! - b.sort((x, y) => y - x)[0]!);
console.log(JSON.stringify(nest));
const reenter = [3, 1, 2, 9, 7];
reenter.sort((a, b) => {
  [a, b, 1].sort((x, y) => x - y);
  return a - b;
});
console.log(reenter.join(","));
console.log([1, 2, 3].sort(() => NaN).join(","), [3, 2, 1].sort(() => 0).join(","), [1, 2].sort((a, b) => b - a).join(","));
console.log([3, 1, 2].sort(() => Infinity).join(","), [3, 1, 2].sort(() => -Infinity).join(","));
const holey = [3, 1];
holey[5] = 0;
console.log(holey.sort().join(","), holey.length, holey[2], holey[5]);
const holey2 = [3, 1];
holey2[4] = 0;
console.log(holey2.toSorted((a, b) => a - b).join(","), holey2.length);
const consts = [1, 2, 3, 4, 5, 6, 7, 8, 9];
console.log(consts.toSorted(() => 1).join(","), consts.toSorted(() => -1).join(","));
`,
    );
  });

  test("a comparator's answer goes through ToNumber", async () => {
    await againstNode(
      "tonumber",
      String.raw`
const parse = (): any => JSON.parse("[3,1,2,9,7,5]");
console.log(JSON.stringify(parse().sort((x: number, y: number) => (x < y ? "-1" : "1"))));
console.log(JSON.stringify(parse().sort((x: number, y: number) => x > y)));
console.log(JSON.stringify(parse().sort((x: number, y: number) => undefined)));
console.log(JSON.stringify(parse().sort((x: number, y: number) => null)));
console.log(JSON.stringify(parse().sort((x: number, y: number) => ({}))));
console.log(JSON.stringify(parse().sort((x: number, y: number) => [x - y])));
console.log(JSON.stringify(parse().sort((x: number, y: number) => "abc")));
`,
    );
  });

  test("a comparator that is not one", async () => {
    await againstNode(
      "gate",
      String.raw`
const tryit = (f: () => unknown): void => {
  try {
    console.log(f());
  } catch (e) {
    console.log((e as Error).name, (e as Error).message);
  }
};
tryit(() => [1, 2].sort(5 as any));
tryit(() => [1, 2].sort(null as any));
tryit(() => [1, 2].sort("x" as any));
tryit(() => [1, 2].toSorted(true as any));
tryit(() => new Uint8Array([2, 1]).sort(5 as any));
tryit(() => [1].sort(0 as any));
tryit(() => [].sort(null as any));
for (const bad of [5, null, "x", true, {}, [1]]) {
  tryit(() => JSON.parse("[2,1]").sort(bad));
}
tryit(() => [2, 1].sort(undefined));
tryit(() => [2, 1].sort(undefined as any));
tryit(() => [2, 1].sort((console.log("se"), undefined)));
tryit(() => [2, 1].toSorted((console.log("se2"), undefined)));
tryit(() => new Uint8Array([2, 1]).sort((console.log("se3"), undefined)));
const nothing = (): void => {
  console.log("void call");
};
const none = (): undefined => {
  console.log("undefined call");
  return undefined;
};
tryit(() => [2, 1].sort(none()));
tryit(() => [2, 1].sort(void nothing()));
let flag = true;
tryit(() => [2, 1].sort(flag ? undefined : undefined));
tryit(() => [2, 1].sort(flag ? (console.log("then"), undefined) : void nothing()));
flag = false;
tryit(() => [2, 1].sort(flag ? (console.log("then"), undefined) : void nothing()));
{
  const undefined = (a: number, b: number): number => a - b;
  tryit(() => [1, 2].sort(undefined));
}
{
  const undefined: undefined = void 0;
  tryit(() => [2, 1].sort(undefined));
}
type Cmp = (a: number, b: number) => number;
type SCmp = (a: string, b: string) => number;
type BCmp = (a: boolean, b: boolean) => number;
const lie = undefined as unknown as Cmp;
tryit(() => [10, 9, 1].sort(lie));
tryit(() => [10, 9, 1].toSorted(lie));
tryit(() => ["b", "a"].sort(undefined as unknown as SCmp));
const slie = undefined as unknown as SCmp;
tryit(() => ["b", "a"].sort(slie));
const blie = undefined as unknown as BCmp;
tryit(() => [true, false].sort(blie));
tryit(() => new Uint8Array([10, 9, 1]).sort(lie));
tryit(() => [2, 1].toSorted(undefined));
`,
    );
  });
});

describe("the engine's sort, the same text", () => {
  test("any[] under --dynamic", async () => {
    await againstNode(
      "island-any",
      String.raw`
function seq(input: any[]): string {
  const log: string[] = [];
  input.sort((x: any, y: any) => {
    log.push(String(x) + ":" + String(y));
    return x < y ? -1 : x > y ? 1 : 0;
  });
  return JSON.stringify(input) + " " + log.length + " " + log.join(" ");
}
console.log(seq([5, 2, 8, 1, 9, 3, 7, 4, 6, 0, 11, 10]));
console.log(seq([3, 3, 3, 1, "a", "a"]));
const typed: number[] = [4, 2, 9];
const view: any = typed;
view.sort((x: number, y: number) => y - x);
console.log(typed.join(","));
const big: any[] = [];
let s = 1;
for (let i = 0; i < 3000; i++) {
  s = (s * 1103515245 + 12345) % 2147483648;
  big.push(s % 1000);
}
console.log(seq(big));
const a1: any[] = [3, null, "b", 1, "a", true, { x: 1 }, [2, 1], false, undefined, 10, 9];
console.log(a1.sort());
console.log(a1.toSorted((x: any, y: any) => 0));
const a3: any[] = [5, 3, 9, 1, 7, 2];
a3.sort((x: any, y: any) => {
  if (a3.length > 4) {
    a3.pop();
    a3.pop();
  }
  return x - y;
});
console.log(a3, a3.length);
const a4: any[] = [5, 4, 3, 2, 1, 0];
try {
  a4.sort((x: any, y: any) => {
    if (x === 2) throw new Error("boom");
    return x - y;
  });
} catch (e) {
  console.log((e as Error).message, a4);
}
for (const bad of [5, null, "x", true, {}, [1]]) {
  try {
    ([2, 1] as any[]).sort(bad as any);
  } catch (e) {
    console.log((e as Error).name, (e as Error).message);
  }
}
`,
      { dynamic: true },
    );
  }, 120_000);

  test("programs in the engine: holes, generic objects, ToString at every comparison, typed arrays", async () => {
    const js = String.raw`(function () {
  var out = [];
  var l = [];
  var a = [5, 2, 8, 1, 9, 3, 7, 4, 6, 0, 11, 10];
  a.sort(function (x, y) { l.push(x + ":" + y); return x - y; });
  out.push(l.join(" "));
  var h = [3, , 1, undefined, 2, , undefined];
  h.sort();
  out.push(h.length, Object.keys(h).join(), h.join());
  out.push(JSON.stringify([, 2, undefined, 1].toSorted()));
  var o = { length: 4, 0: "c", 1: "a", 3: "b" };
  Array.prototype.sort.call(o);
  out.push(JSON.stringify(o));
  var n = 0;
  var p = [{ toString: function () { n++; return "b"; } }, { toString: function () { n++; return "a"; } }, "c", 10];
  out.push(p.sort().length, n);
  var ks = [];
  var fa = new Float64Array([3, 1, 2, -0, 0, NaN, 7, 5, 9, 4]);
  fa.sort(function (x, y) { ks.push(x + ":" + y); return x - y; });
  out.push(ks.join(" "), fa.join());
  out.push(fa.toSorted(function (x, y) { return y - x; }).join());
  out.push(new BigInt64Array([3n, 1n, 2n]).sort(function (x, y) { return x < y ? 1 : -1; }).join());
  var d = new Uint8Array([3, 1, 2]);
  try { d.sort(function () { throw new Error("boom"); }); } catch (e) { out.push(e.message, d.join()); }
  out.push(new Int16Array([3, -1, 2]).sort().join());
  return out.join("\n");
})()`;
    await againstNode("island-eval", `console.log(__island_eval(${JSON.stringify(js)}));\n`, { dynamic: true, island: true });
  }, 120_000);
});

test("S024's carve-out: a shrinking comparator over a static array with holes", async () => {
  const file = join(scratch, "hole-shrink.ts");
  writeFileSync(
    file,
    `const a: (number | undefined)[] = [3, , 1];
a.sort((x, y) => {
  while (a.length > 0) a.pop();
  return (x as number) - (y as number);
});
console.log(a.length);
const c: any = JSON.parse("[3,1]");
c[3] = 0;
c.sort((p: number, q: number) => {
  for (let n: number = c.length; n > 0; n--) c.pop();
  return p - q;
});
console.log(c.length);
`,
  );
  // Node answers 2 and 3; a hole here is the element's undefined, which sort stores.
  expect((await exec("node", ["--experimental-transform-types", "--no-warnings", file])).stdout).toBe("2\n3\n");
  const res = await compile(file, { outPath: join(scratch, "hole-shrink.wasm"), outDir: scratch, backend: "wasm" });
  if (!res.ok) throw new Error(res.diagnostics.map((d) => d.message).join(" | "));
  expect(String((await runWasm(res.binaryPath)).stdout)).toBe("3\n4\n");
});

test("a lie that undefined is a comparator stops by name where no default order exists", async () => {
  const file = join(scratch, "lie-fence.ts");
  writeFileSync(
    file,
    `class P {}
type Cmp = (a: P, b: P) => number;
const lie = undefined as unknown as Cmp;
[new P(), new P()].sort(lie);
`,
  );
  const res = await compile(file, { outPath: join(scratch, "lie-fence.wasm"), outDir: scratch, backend: "wasm" });
  if (!res.ok) throw new Error(res.diagnostics.map((d) => d.message).join(" | "));
  const dir = join(scratch, "lie-fence-native");
  mkdirSync(dir, { recursive: true });
  const nat = await compile(file, { outPath: join(dir, "program"), outDir: dir, backend: "wasm-native" });
  if (!nat.ok) throw new Error(nat.diagnostics.map((d) => d.message).join(" | "));
  const r = await run(nat.binaryPath, []).then(
    () => "",
    (e: { stderr?: string }) => String(e.stderr),
  );
  expect(r).toContain("without a comparator over elements with no default order");
});

test("timsort-src.ts is the header, rendered", () => {
  expect(readFileSync(OUT_PATH, "utf8")).toBe(renderTimsortSrc(readFileSync(HEADER_PATH, "utf8")));
});
