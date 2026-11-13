/* paperclip step 13: Promise.allSettled. paperclip's channels command
 * resolves every release channel with `Promise.allSettled(channels.map(
 * ...))` and reads `outcome.status === "fulfilled" ? outcome.value :
 * null`; its sandbox teardown uses `await Promise.allSettled([...])` as a
 * barrier. It lowers to Promise.all's countdown combinator with the
 * settled reactions: one reaction per entry, subscribed in input order,
 * each storing a fresh `{ status: "fulfilled", value }` or `{ status:
 * "rejected", reason }` record at its index (the reason in the dynamic
 * value), the last one to settle fulfilling the result, nothing rejecting
 * it. Microtask-exact: the rows interleave it with Promise.all and plain
 * reaction chains and compare the order with Node's. A result the program
 * never reads settles void (Promise<void> entries need no records). Rows
 * run under Node and on both WasmGC lanes. */
import { describe, test } from "vitest";
import { checkRow, type Row, scratchDir } from "./top10-paperclip-rows.js";

const scratch = scratchDir("pc-all-settled");

const ROWS: Row[] = [
  {
    id: "PC13-01 values, reasons and the result records",
    files: {
      "main.ts": `async function version(tag: string): Promise<string> {
  if (tag === "canary") throw new Error("no canary for " + tag);
  return tag + "-1.2.3";
}
async function main(): Promise<void> {
  const tags = ["stable", "canary", "beta"];
  const resolved = await Promise.allSettled(tags.map((t) => version(t)));
  for (let i = 0; i < tags.length; i++) {
    const outcome = resolved[i]!;
    const v = outcome.status === "fulfilled" ? outcome.value : null;
    console.log(tags[i], outcome.status, v);
    if (outcome.status === "rejected") console.log("  reason:", outcome.reason instanceof Error ? outcome.reason.message : "?");
  }
  console.log(resolved.length);
  const [first, second] = await Promise.allSettled([version("x"), version("canary")]);
  console.log(first.status, second.status, first.status === "fulfilled" ? first.value : "");
  const p = version("pair");
  const rs = await Promise.allSettled([p, p]);
  console.log(rs.length, rs[0].status, rs[1].status === "fulfilled" ? rs[1].value : "");
  const none = await Promise.allSettled([] as Promise<number>[]);
  console.log("empty", none.length);
}
void main();`,
    },
  },
  {
    id: "PC13-02 microtask order against Promise.all and plain chains",
    files: {
      "main.ts": `const log: string[] = [];
const a: Promise<number> = Promise.resolve(1);
const b: Promise<number> = Promise.reject(new Error("b"));
const c = new Promise<number>((r) => setTimeout(() => r(3), 1));
b.catch(() => { log.push("b caught"); return 0; });
const abc: Promise<number>[] = [a, b, c];
Promise.allSettled(abc).then((rs) => { log.push("settled " + rs.map((r) => r.status).join(",")); });
const pair: Promise<number>[] = [a, Promise.resolve(2)];
Promise.all(pair).then((vs) => { log.push("all " + vs.length); });
a.then(() => { log.push("a1"); }).then(() => { log.push("a2"); }).then(() => { log.push("a3"); }).then(() => { log.push("a4"); });
Promise.allSettled([a]).then(() => { log.push("settled-a"); });
Promise.allSettled([] as Promise<number>[]).then(() => { log.push("settled-empty"); });
setTimeout(() => console.log(log.join("\\n")), 20);`,
    },
  },
  {
    id: "PC13-03 a barrier over Promise<void> entries",
    files: {
      "main.ts": `async function stop(name: string, fail: boolean): Promise<void> {
  await new Promise<void>((r) => setTimeout(r, 2));
  console.log("stopped", name);
  if (fail) throw new Error("stop " + name);
}
async function teardown(): Promise<void> {
  try {
    await Promise.allSettled([stop("server", true), stop("worker", false)]);
    console.log("all stopped");
    throw new Error("original");
  } catch (e) {
    console.log("caught", (e as Error).message);
  }
}
void teardown();`,
    },
  },
];

describe("paperclip: Promise.allSettled (wasm lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await checkRow(scratch, row, "wasm");
  });
});

describe("paperclip: Promise.allSettled (wasm-native lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await checkRow(scratch, row, "wasm-native");
  }, 600_000);
});
