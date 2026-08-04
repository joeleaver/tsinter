/* The promise combinators and the union-armed await, end to end:
 * Promise.all, Promise.race, Promise.withResolvers, and `await (p:
 * Promise<T> | units)`. wasm-async.test.ts's pattern — compile real
 * TypeScript, run it, compare output byte for byte — because what these
 * pin is ORDER, and order is only observable at runtime.
 *
 * EVERY EXPECTATION HERE WAS PRODUCED BY `node` FIRST, then asserted of
 * the wasm module. That matters more than usual in this file: the
 * combinators are exactly where the C runtime and Node disagree, so an
 * expectation copied from scr_async.c's behaviour would have been wrong
 * and would have looked right.
 *
 * THE TURN COUNT IS THE POINT of the first two tests. ECMAScript builds
 * both combinators out of `.then(...)` on every entry, so an entry's
 * settlement ENQUEUES its reaction: the result promise settles one
 * microtask turn after the deciding entry, and an awaiter resumes a turn
 * after that. scr_async.c instead runs its callbacks synchronously inside
 * settle, which lands the result a full turn early — invisible to every
 * corpus program (none of them runs a competing microtask chain across a
 * combinator) and plainly visible to a ticker. These two tests ARE that
 * ticker. */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { type IrType, typeKey } from "../src/ir/nodes.js";
import { runWasm } from "./wasm-host.js";

let scratch: string;
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "tsinter-wasm-comb-"));
});
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function build(name: string, lines: string[]) {
  const entry = join(scratch, name);
  await writeFile(entry, `${lines.join("\n")}\n`);
  const res = await compile(entry, {
    outPath: join(scratch, `${name}.wasm`),
    outDir: scratch,
    backend: "wasm",
  });
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  expect(WebAssembly.validate(readFileSync(res.binaryPath))).toBe(true);
  return res.binaryPath;
}

/** The competing microtask chain both turn-count tests run a combinator
 * against: one line per turn, so the combinator's answer lands at a
 * countable position. */
const TICKER = [
  "async function hop(): Promise<void> {}",
  "async function ticker(tag: string, n: number): Promise<void> {",
  "  for (let i = 0; i < n; i++) { console.log(`${tag}${i}`); await hop(); }",
  "}",
];

test("Promise.all over settled entries costs two turns, not one", async () => {
  // Node: the two entries' reactions are queued behind ticker's first
  // resumption, run on turns 2 and 3, and the second fulfils the result —
  // whose own reaction (the await) runs on turn 5. So `all` lands between
  // t2 and t3. Running the reactions INLINE (the C runtime's shape) would
  // print it between t1 and t2.
  const path = await build("turns-all.ts", [
    ...TICKER,
    "async function main(): Promise<void> {",
    "  const ps: Promise<number>[] = [Promise.resolve(1), Promise.resolve(2)];",
    "  void ticker('t', 8);",
    "  const v = await Promise.all(ps);",
    "  console.log('all', v.join(','));",
    "}",
    "main();",
  ]);
  const { stdout, stderr, exitCode } = await runWasm(path);
  expect(stdout).toBe(
    ["t0", "t1", "t2", "all 1,2", "t3", "t4", "t5", "t6", "t7", ""].join("\n"),
  );
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("Promise.race over settled entries costs two turns, not one", async () => {
  // Same count on the other combinator, and the same loser story: the
  // second entry's reaction still runs (turn 3) and settle's pending
  // guard makes it a no-op.
  const path = await build("turns-race.ts", [
    ...TICKER,
    "async function main(): Promise<void> {",
    "  const a = Promise.resolve(1);",
    "  const b = Promise.resolve(2);",
    "  void ticker('t', 8);",
    "  const v = await Promise.race([a, b]);",
    "  console.log('race', v);",
    "}",
    "main();",
  ]);
  const { stdout, stderr } = await runWasm(path);
  expect(stdout).toBe(
    ["t0", "t1", "t2", "race 1", "t3", "t4", "t5", "t6", "t7", ""].join("\n"),
  );
  expect(stderr).toBe("");
});

test("Promise.all fills by INPUT index whatever the settlement order", async () => {
  // The interleaved "settle" lines are the proof: b, then c, then a — and
  // the values still read a|b|c. Also the empty array (fulfils during
  // construction, so the await is one plain settled hop) and the void
  // entries (no values array at all; the result fulfils void).
  const path = await build("all-order.ts", [
    "function later<T>(v: T, ms: number, tag: string): Promise<T> {",
    "  return new Promise<T>((resolve) => setTimeout(() => { console.log('settle', tag); resolve(v); }, ms));",
    "}",
    "async function main(): Promise<void> {",
    "  const ps: Promise<string>[] = [later('a', 30, 'a'), later('b', 5, 'b'), later('c', 15, 'c')];",
    "  const got = await Promise.all(ps);",
    "  console.log('values', got.join('|'));",
    "  const nums: Promise<number>[] = [later(1, 20, 'n1'), later(2, 2, 'n2')];",
    "  console.log('sum', (await Promise.all(nums)).join('+'));",
    "  const empty: Promise<number>[] = [];",
    "  console.log('empty', (await Promise.all(empty)).length);",
    "  const voids: Promise<void>[] = [",
    "    new Promise<void>((resolve) => setTimeout(() => { console.log('settle v1'); resolve(); }, 10)),",
    "    new Promise<void>((resolve) => setTimeout(() => { console.log('settle v2'); resolve(); }, 3)),",
    "  ];",
    "  await Promise.all(voids);",
    "  console.log('voids done');",
    "}",
    "main();",
    "console.log('sync');",
  ]);
  const { stdout, stderr } = await runWasm(path);
  expect(stdout).toBe(
    [
      "sync",
      "settle b",
      "settle c",
      "settle a",
      "values a|b|c",
      "settle n2",
      "settle n1",
      "sum 1+2",
      "empty 0",
      "settle v2",
      "settle v1",
      "voids done",
      "",
    ].join("\n"),
  );
  expect(stderr).toBe("");
});

test("Promise.all takes the first rejection in SETTLEMENT order, losers handled", async () => {
  // "fast" is third by input and first by settlement, so it wins; "slow"
  // rejects afterwards into an already-rejected result and the surviving
  // fulfilment lands later still. Neither is an unhandled rejection —
  // subscribing IS handling — which is what the empty stderr and the
  // clean exit assert.
  const path = await build("all-reject.ts", [
    "function later<T>(v: T, ms: number, tag: string): Promise<T> {",
    "  return new Promise<T>((resolve) => setTimeout(() => { console.log('settle', tag); resolve(v); }, ms));",
    "}",
    "async function boom(msg: string, ms: number): Promise<number> {",
    "  await new Promise<void>((resolve) => setTimeout(() => resolve(), ms));",
    "  console.log('throwing', msg);",
    "  throw new Error(msg);",
    "}",
    "async function main(): Promise<void> {",
    "  const ps: Promise<number>[] = [boom('slow', 30), later(7, 60, 'survivor'), boom('fast', 5)];",
    "  try {",
    "    await Promise.all(ps);",
    "    console.log('unreachable');",
    "  } catch (e) {",
    "    if (e instanceof Error) console.log('caught', e.message);",
    "  }",
    "  await new Promise<void>((resolve) => setTimeout(() => resolve(), 80));",
    "  console.log('end');",
    "}",
    "main();",
  ]);
  const { stdout, stderr, exitCode } = await runWasm(path);
  expect(stdout).toBe(
    ["throwing fast", "caught fast", "throwing slow", "settle survivor", "end", ""].join("\n"),
  );
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("Promise.race: first settle wins, a rejection can win, losers keep running", async () => {
  // The heterogeneous entry is the payload-converting adapter: a
  // Promise<number> settling into a `string | number` result has to be
  // WRAPPED at the number arm on the way in.
  const path = await build("race.ts", [
    "function later<T>(v: T, ms: number, tag: string): Promise<T> {",
    "  return new Promise<T>((resolve) => setTimeout(() => { console.log('settle', tag); resolve(v); }, ms));",
    "}",
    "async function boom(msg: string, ms: number): Promise<string> {",
    "  await new Promise<void>((resolve) => setTimeout(() => resolve(), ms));",
    "  throw new Error(msg);",
    "}",
    "async function main(): Promise<void> {",
    "  console.log('fastest', await Promise.race([later('slow', 40, 's1'), later('fast', 5, 'f1')]));",
    "  const mixed = await Promise.race([later('str', 40, 's2'), later(42, 5, 'n2')]);",
    "  console.log('mixed', typeof mixed === 'number' ? mixed + 1 : mixed);",
    "  try {",
    "    await Promise.race([later('ok', 40, 's3'), boom('raced-boom', 3)]);",
    "    console.log('unreachable');",
    "  } catch (e) {",
    "    if (e instanceof Error) console.log('caught', e.message);",
    "  }",
    "  await new Promise<void>((resolve) => setTimeout(() => resolve(), 60));",
    "  console.log('end');",
    "}",
    "main();",
  ]);
  const { stdout, stderr, exitCode } = await runWasm(path);
  expect(stdout).toBe(
    [
      "settle f1",
      "fastest fast",
      "settle n2",
      "mixed 43",
      "caught raced-boom",
      "settle s1",
      "settle s2",
      "settle s3",
      "end",
      "",
    ].join("\n"),
  );
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("Promise.race over a SUB-UNION entry re-tags arm by arm", async () => {
  // `Promise<string | null>` racing into a `string | null | number`
  // result: the two unions are interned separately and sorted by typeKey,
  // so "null" is arm 0 going in and arm 1 coming out. The adapter has to
  // unwrap and rebuild under the result's tags — passing the value
  // through would be a well-typed lie. Both arms of the sub-union win a
  // race here, so both retags execute.
  const path = await build("race-subunion.ts", [
    "function later<T>(v: T, ms: number): Promise<T> {",
    "  return new Promise<T>((resolve) => setTimeout(() => resolve(v), ms));",
    "}",
    "async function main(): Promise<void> {",
    "  const a: Promise<string | null> = later<string | null>(null, 5);",
    "  const b: Promise<number> = later(7, 40);",
    "  const first: string | null | number = await Promise.race([a, b]);",
    "  console.log('null arm wins:', first === null);",
    "  const c: Promise<string | null> = later<string | null>('hi', 5);",
    "  const d: Promise<number> = later(9, 40);",
    "  const second: string | null | number = await Promise.race([c, d]);",
    "  console.log('string arm wins:', second === 'hi');",
    "  const e: Promise<string | null> = later<string | null>('late', 40);",
    "  const f: Promise<number> = later(3, 5);",
    "  const third: string | null | number = await Promise.race([e, f]);",
    "  console.log('number arm wins:', third === 3);",
    "}",
    "main();",
  ]);
  const { stdout, stderr } = await runWasm(path);
  expect(stdout).toBe(
    ["null arm wins: true", "string arm wins: true", "number arm wins: true", ""].join("\n"),
  );
  expect(stderr).toBe("");
});

test("Promise.withResolvers hands the settlers out as values", async () => {
  // Destructured and held whole, over string/number/void inners, resolved
  // from a timer long after the expression that made them — which is the
  // whole difference from newPromise's executor-scoped settlers.
  const path = await build("withresolvers.ts", [
    "const gate = Promise.withResolvers<string>();",
    "const { promise, resolve } = Promise.withResolvers<number>();",
    "async function main(): Promise<void> {",
    "  setTimeout(() => { console.log('firing'); gate.resolve('opened'); resolve(7); }, 5);",
    "  console.log('gate', await gate.promise);",
    "  console.log('num', await promise);",
    "  const done = Promise.withResolvers<void>();",
    "  done.resolve();",
    "  await done.promise;",
    "  console.log('void ok');",
    "  const bad = Promise.withResolvers<string>();",
    "  bad.reject(new RangeError('nope'));",
    "  try {",
    "    await bad.promise;",
    "  } catch (e) {",
    "    if (e instanceof Error) console.log('caught', e.name, e.message);",
    "  }",
    "  console.log('end');",
    "}",
    "void main();",
    "console.log('sync');",
  ]);
  const { stdout, stderr, exitCode } = await runWasm(path);
  expect(stdout).toBe(
    ["sync", "firing", "gate opened", "num 7", "void ok", "caught RangeError nope", "end", ""].join(
      "\n",
    ),
  );
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("awaiting `Promise<T> | undefined`: the promise arm parks, the unit arm hops", async () => {
  // The tickers count the turns each arm costs. The promise arm waits for
  // the whole inner chain (three ticker lines pass); the undefined arm is
  // exactly ONE hop, so only one does.
  const path = await build("awaitunion.ts", [
    ...TICKER,
    "async function mk(n: number): Promise<string> { await hop(); return `v${n}`; }",
    "async function read(p: Promise<string> | undefined): Promise<string> {",
    "  const got = await p;",
    "  return got === undefined ? '(none)' : got;",
    "}",
    "async function main(): Promise<void> {",
    "  void ticker('a', 6);",
    "  console.log('hit', await read(mk(1)));",
    "  void ticker('b', 4);",
    "  console.log('miss', await read(undefined));",
    "  const failing = async (): Promise<string> => { await hop(); throw new Error('boom'); };",
    "  const doomed: Promise<string> | undefined = failing();",
    "  try {",
    "    console.log('never', await doomed);",
    "  } catch (e) {",
    "    if (e instanceof Error) console.log('caught', e.message);",
    "  }",
    "}",
    "main();",
    "console.log('sync');",
  ]);
  const { stdout, stderr } = await runWasm(path);
  expect(stdout).toBe(
    [
      "a0",
      "sync",
      "a1",
      "a2",
      "a3",
      "hit v1",
      "b0",
      "a4",
      "b1",
      "a5",
      "b2",
      "miss (none)",
      "b3",
      "caught boom",
      "",
    ].join("\n"),
  );
  expect(stderr).toBe("");
});

test("awaiting `Promise<number> | null` re-tags the unit arm", async () => {
  // The smallest witness that the awaited union and the RESULT union do
  // not share a numbering. Sorted by typeKey, the input's arms are
  // ["null", "promise<f64>"] and the result's are ["f64", "null"] — so
  // null is arm 0 going in and arm 1 coming out. A unit instance is
  // interned per TAG across the module, so handing the value straight
  // through would produce a value that reads as a NUMBER arm.
  const path = await build("retag.ts", [
    "async function hop(): Promise<void> {}",
    "async function mk(n: number): Promise<number> { await hop(); return n; }",
    "async function read(p: Promise<number> | null): Promise<void> {",
    "  const v: number | null = await p;",
    "  if (v === null) console.log('got null');",
    "  else console.log('got', v);",
    "}",
    "async function main(): Promise<void> {",
    "  await read(mk(41));",
    "  await read(null);",
    "  await read(mk(-0));",
    "}",
    "main();",
    "console.log('sync');",
  ]);
  const { stdout, stderr } = await runWasm(path);
  expect(stdout).toBe(["sync", "got 41", "got null", "got -0", ""].join("\n"));
  expect(stderr).toBe("");
});

test("the awaited union and its result union really do number arms differently", () => {
  // The structural half of the test above. Union arms are canonically
  // ordered by typeKey (IrUnionDef's contract, and what the frontend's
  // intern does), and swapping `Promise<number>` for `number` MOVES the
  // null arm across it: "null" < "promise<f64>" but "f64" < "null". That
  // is why the settled read re-tags by TYPE instead of passing the value
  // through, and it is the only reason `Promise<number> | null` is the
  // witness rather than the tidier `Promise<string> | undefined` (where
  // the two numberings happen to agree, which is exactly the coincidence
  // a positional implementation would have been shipped on).
  const key = (ts: IrType[]): string[] => ts.map(typeKey).sort();
  const NULL_T: IrType = { kind: "nullT" };
  const NUM: IrType = { kind: "f64" };
  const STR: IrType = { kind: "string" };
  const UNDEF: IrType = { kind: "undefinedT" };
  expect(key([{ kind: "promise", inner: NUM }, NULL_T])).toEqual(["null", "promise<f64>"]);
  expect(key([NUM, NULL_T])).toEqual(["f64", "null"]);
  // The coincidence, for contrast: undefined sorts last either way.
  expect(key([{ kind: "promise", inner: STR }, UNDEF])).toEqual(["promise<string>", "undefined"]);
  expect(key([STR, UNDEF])).toEqual(["string", "undefined"]);
});

test("a module with no combinator emits no combinator runtime", async () => {
  // The laziness contract, one level down from wasm-async.test.ts's: a
  // plain async program mints promises and drains microtasks but must not
  // pull in the reaction nodes or their helpers — which is also what keeps
  // every previously claimed module byte-identical.
  const path = await build("plain-async.ts", [
    "async function main(): Promise<void> {",
    "  const v = await Promise.resolve(2);",
    "  console.log('v', v);",
    "}",
    "main();",
  ]);
  const bytes = readFileSync(path);
  expect(bytes.includes(Buffer.from("%w.async.mint"))).toBe(true);
  expect(bytes.includes(Buffer.from("%w.async.all"))).toBe(false);
  expect(bytes.includes(Buffer.from("%w.async.raceRx"))).toBe(false);
  expect(bytes.includes(Buffer.from("%w.async.settleFrom"))).toBe(false);
  expect(bytes.includes(Buffer.from("%w.async.subscribeHandled"))).toBe(false);
  expect(bytes.includes(Buffer.from("%w.all.entry"))).toBe(false);
  expect(bytes.includes(Buffer.from("%w.race.entry"))).toBe(false);
  const { stdout } = await runWasm(path);
  expect(stdout).toBe("v 2\n");
});
