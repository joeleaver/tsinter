/* Top-level await: the module GRAPH as async functions. What stage 4 adds
 * to wasm-async.test.ts's surface is the loader's half of the protocol —
 * the per-module evaluation promise and its cache, the internal dependency
 * wait that does NOT cost a microtask turn, and the two exits Node has for
 * a module root that a program's own code can no longer influence (a
 * rejected root is 1 and stops the loop; a root still pending at
 * quiescence is 13, through abi.ts's `_status`).
 *
 * Every expectation here is Node's actual output for the same sources,
 * hand-checked against `node` while these were written; the corpus
 * (2646-2665) proves the same programs differentially. Multi-file cases
 * write a real directory and compile its entry, because module.await and
 * the cycle caches only exist in a graph. */
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { runWasm, runWasmToTrap } from "./wasm-host.js";

let scratch: string;
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "tsinter-wasm-tla-"));
});
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

/** Compile one module graph: `files` maps a file name to its lines, and
 * the entry is always `main.ts`. */
async function build(name: string, files: Record<string, string[]>): Promise<string> {
  const dir = join(scratch, name);
  await mkdir(dir, { recursive: true });
  for (const [file, lines] of Object.entries(files)) {
    await writeFile(join(dir, file), `${lines.join("\n")}\n`);
  }
  const res = await compile(join(dir, "main.ts"), {
    outPath: join(dir, "program.wasm"),
    outDir: dir,
    backend: "wasm",
  });
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  expect(WebAssembly.validate(readFileSync(res.binaryPath))).toBe(true);
  return res.binaryPath;
}

const one = (lines: string[]): Record<string, string[]> => ({ "main.ts": lines });

test("a top-level await suspends the module and the rest of it resumes a turn later", async () => {
  // The entry module IS an async function now: everything after the first
  // await is a resume state, so a fire-and-forget async call made BEFORE
  // it gets its turn first — and the module's own tail is just another
  // microtask, still ahead of any timer.
  const path = await build(
    "suspends",
    one([
      "async function tick(label: string): Promise<void> {",
      "  console.log(label, 1);",
      "  await null;",
      "  console.log(label, 2);",
      "}",
      "",
      "console.log('start');",
      "tick('spawn');",
      "const v = await Promise.resolve(41);",
      "console.log('resumed', v + 1);",
      "setTimeout(() => console.log('timer'), 1);",
      "await null;",
      "console.log('done');",
      "",
      "export {};",
    ]),
  );
  const { stdout, stderr, exitCode } = await runWasm(path);
  expect(stdout).toBe(["start", "spawn 1", "spawn 2", "resumed 42", "done", "timer", ""].join("\n"));
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("a module root nothing ever settles is exit 13, after the loop runs dry", async () => {
  // Node's dedicated unsettled-top-level-await status. The loop is NOT cut
  // short by the pending root — the armed timer still fires — and the
  // verdict lands at quiescence, which is exactly when the host reads
  // `_status` (abi.ts).
  const path = await build(
    "pending-root",
    one([
      "console.log('before pending');",
      "setTimeout(() => console.log('timer still runs'), 1);",
      "await new Promise<void>(() => {});",
      "console.log('unreachable');",
      "",
      "export {};",
    ]),
  );
  const { stdout, stderr, exitCode } = await runWasm(path);
  expect(stdout).toBe(["before pending", "timer still runs", ""].join("\n"));
  // Node writes its own "Detected unsettled top-level await" warning here;
  // this tier writes nothing, and the nonzero exit is what the harness
  // compares (S010's stderr stance).
  expect(stderr).toBe("");
  expect(exitCode).toBe(13);
});

test("a rejected module root stops the loop: a timer already armed never fires", async () => {
  // The ESM loader terminates on a rejected module evaluation at the
  // checkpoint that observed it, BEFORE advancing to timers — so the 10ms
  // callback is dead code even though the loop had work left (corpus
  // 2653). Exit 1 is the trap (S010).
  const path = await build(
    "rejected-root",
    one([
      "console.log('before rejection');",
      "setTimeout(() => console.log('late timer'), 10);",
      "await Promise.reject(new Error('top-level stops loop'));",
      "",
      "export {};",
    ]),
  );
  const { stdout, stderr } = await runWasmToTrap(path);
  expect(stdout).toBe("before rejection\n");
  expect(stderr).toBe("Unhandled promise rejection: Error: top-level stops loop\n");
});

test("a root rejected MID-PUMP stops the loop at that checkpoint", async () => {
  // The same verdict from inside `_tick`: the 5ms timer rejects the root,
  // the checkpoint that follows the callback sees it, and the 10ms timer
  // never gets its turn (corpus 2654's shape without the listener).
  const path = await build(
    "rejected-mid-pump",
    one([
      "console.log('start');",
      "setTimeout(() => console.log('later timer'), 10);",
      "await new Promise<void>((_resolve, reject) => {",
      "  setTimeout(() => reject(new Error('late boom')), 5);",
      "});",
      "console.log('unreachable');",
      "",
      "export {};",
    ]),
  );
  const { stdout, stderr } = await runWasmToTrap(path);
  expect(stdout).toBe("start\n");
  expect(stderr).toBe("Unhandled promise rejection: Error: late boom\n");
});

test("an unrelated unhandled rejection beats a root that is merely pending", async () => {
  // The root is parked forever, so the ledger walk is what answers — and
  // it answers for the ONLY rejection nobody observed, since the root
  // itself is loader-owned and marked handled at birth (corpus 2651).
  const path = await build(
    "pending-root-unhandled",
    one([
      "console.log('before pending with rejection');",
      "void Promise.reject(new Error('unhandled wins'));",
      "await new Promise<void>(() => {});",
      "console.log('unreachable');",
      "",
      "export {};",
    ]),
  );
  const { stdout, stderr } = await runWasmToTrap(path);
  expect(stdout).toBe("before pending with rejection\n");
  expect(stderr).toBe("Unhandled promise rejection: Error: unhandled wins\n");
});

test("module.await continues into the importer in the SAME turn", async () => {
  // The discriminator: `racer` queues a microtask, then the a↔b cycle
  // evaluates. b reaches an ALREADY-SETTLED dependency (the re-entrant
  // guard makes a's second call a no-op that fulfils at once), and the
  // loader's internal wait spends no promise job — so "b" prints before
  // "racer micro". An ordinary await there would print it after.
  const path = await build("module-await", {
    "main.ts": ["import './racer.ts';", "import './a.ts';", "", "console.log('main');", "", "export {};"],
    "racer.ts": [
      "void Promise.resolve().then(() => console.log('racer micro'));",
      "console.log('racer');",
      "",
      "export {};",
    ],
    "a.ts": [
      "import './b.ts';",
      "",
      "console.log('a:start');",
      "await Promise.resolve();",
      "console.log('a:end');",
      "",
      "export {};",
    ],
    "b.ts": ["import './a.ts';", "", "console.log('b');", "", "export {};"],
  });
  const { stdout, exitCode } = await runWasm(path);
  expect(stdout).toBe(["racer", "b", "a:start", "racer micro", "a:end", "main", ""].join("\n"));
  expect(exitCode).toBe(0);
});

test("an async import cycle evaluates in Node's order, and an outside importer waits for the root", async () => {
  // Two things at once. The CYCLE (a↔b): b is entered first and blocks on
  // a's top-level await, so a's body straddles the whole timer and b's
  // own tail runs after it. The CYCLE CACHE: `waiter` reaches the running
  // cycle through b and must wait for the member that actually rooted the
  // evaluation — which is the LAST wrapper to publish, the outermost one,
  // not the inner re-entrant spawn that transiently filled the global.
  const path = await build("cycle", {
    "main.ts": ["import './waiter.ts';", "", "console.log('main');", "", "export {};"],
    "waiter.ts": ["import './b.ts';", "", "console.log('waiter');", "", "export {};"],
    "b.ts": ["import './a.ts';", "", "console.log('b');", "", "export {};"],
    "a.ts": [
      "import './b.ts';",
      "",
      "console.log('a:start');",
      "await new Promise<void>((resolve) => setTimeout(resolve, 5));",
      "console.log('a:end');",
      "",
      "export {};",
    ],
  });
  const { stdout, stderr, exitCode } = await runWasm(path);
  expect(stdout).toBe(["a:start", "a:end", "b", "waiter", "main", ""].join("\n"));
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("`_status` appears only in a module that can have an unsettled root", async () => {
  // The conditional-surface contract (abi.ts), the same one `_tick` keeps:
  // an async program without top-level await has no module evaluation
  // promise to report on, so it grows no export and no root global.
  const asyncOnly = await build(
    "no-tla",
    one([
      "async function work(): Promise<number> {",
      "  await null;",
      "  return 7;",
      "}",
      "async function main(): Promise<void> {",
      "  const got = await work();",
      "  console.log('got', got);",
      "}",
      "main();",
    ]),
  );
  expect(readFileSync(asyncOnly).includes(Buffer.from("_status"))).toBe(false);
  const { stdout, exitCode } = await runWasm(asyncOnly);
  expect(stdout).toBe("got 7\n");
  expect(exitCode).toBe(0);

  const tla = await build("with-tla", one(["await null;", "console.log('tla');", "", "export {};"]));
  expect(readFileSync(tla).includes(Buffer.from("_status"))).toBe(true);
  expect((await runWasm(tla)).stdout).toBe("tla\n");
});
