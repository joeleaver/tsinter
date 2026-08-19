/* The timer tier end to end: timers.ts's heap and check phase driven by
 * `_tick` through the abi.ts host contract (wasm-host.ts), compiled and
 * run. wasm-async.test.ts's pattern — real TypeScript, output compared
 * byte for byte — because what matters here is ORDER, and order is only
 * observable at runtime.
 *
 * Every expectation is Node's actual output for the same source (checked
 * with `node` while these were written; the corpus differential is the
 * standing proof). The clock is virtual and nothing sleeps, so the
 * delays below are pure ordering, exactly as they are for the corpus. */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { runWasm, runWasmToTrap } from "./wasm-host.js";

let scratch: string;
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "tsinter-wasm-timers-"));
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

test("timers run after the sync tail and after pending microtasks, in registration order", async () => {
  // Node's checkpoint order: the whole synchronous body, then the
  // microtask queue to exhaustion, and only then the timers phase — where
  // two callbacks armed for the same instant fire in ARM order.
  const path = await build("order.ts", [
    "setTimeout(() => {",
    "  console.log('timer one');",
    "}, 0);",
    "setTimeout(() => {",
    "  console.log('timer two');",
    "}, 0);",
    "async function micro(): Promise<void> {",
    "  await null;",
    "  console.log('microtask');",
    "}",
    "micro();",
    "console.log('sync tail');",
  ]);
  const { stdout, stderr } = await runWasm(path);
  expect(stdout).toBe(["sync tail", "microtask", "timer one", "timer two", ""].join("\n"));
  expect(stderr).toBe("");
});

test("delay coercion: sub-ms, fractional and out-of-range delays share the 1ms bucket", async () => {
  // lib/internal/timers.js: `!(ms >= 1)` clamps to 1, past TIMEOUT_MAX
  // (2^31-1, +Infinity included) clamps to 1, and everything else
  // TRUNCATES — so all five below are 1ms timers and fire FIFO, while the
  // 2ms one lands after all of them.
  const path = await build("coerce.ts", [
    "const order: number[] = [];",
    "setTimeout(() => { order.push(1); }, 1);",
    "setTimeout(() => { order.push(2); }, 1.8);",
    "setTimeout(() => { order.push(3); }, 1.1);",
    "setTimeout(() => { order.push(4); }, 0.5);",
    "setTimeout(() => { order.push(5); }, -7);",
    "setTimeout(() => { order.push(6); }, 3000000000);",
    "setTimeout(() => {",
    "  console.log('order', order.join(','));",
    "}, 2);",
  ]);
  const { stdout } = await runWasm(path);
  expect(stdout).toBe("order 1,2,3,4,5,6\n");
});

test("an interval clearing ITSELF from inside its callback stops and the program exits", async () => {
  // The entry is out of the heap while its callback runs, so the clear
  // rides the firing flag and the re-arm drops it — quiescence, exit 0,
  // not a hang.
  const path = await build("selfclear.ts", [
    "let n = 0;",
    "const id = setInterval(() => {",
    "  n += 1;",
    "  console.log('tick', n);",
    "  if (n === 3) {",
    "    clearInterval(id);",
    "    console.log('cleared', id.hasRef());",
    "  }",
    "}, 5);",
    "console.log('armed', id.hasRef());",
  ]);
  const { stdout } = await runWasm(path);
  // hasRef() still answers TRUE inside the clearing callback: clear and
  // ref are separate bits in Node, and only unref() moves the second one.
  expect(stdout).toBe(
    ["armed true", "tick 1", "tick 2", "tick 3", "cleared true", ""].join("\n"),
  );
});

test("clearing an armed interval from OUTSIDE releases the loop immediately", async () => {
  // The clear is EAGER: a one-hour interval removed from the heap must
  // let the program end at the next quiescence, not an hour later. If the
  // entry lingered, the pump would jump the clock by 3600000 and the
  // callback would print.
  const path = await build("crossclear.ts", [
    "const slow = setInterval(() => {",
    "  console.log('SHOULD NOT PRINT');",
    "}, 3600000);",
    "setTimeout(() => {",
    "  clearInterval(slow);",
    "  console.log('cleared');",
    "}, 1);",
    "console.log('armed');",
  ]);
  const { stdout } = await runWasm(path);
  expect(stdout).toBe(["armed", "cleared", ""].join("\n"));
});

test("an unref'd timer never fires when nothing else holds the loop", async () => {
  // unref() drops the timer from the LIVENESS count while leaving it
  // armed: with nothing reffed left the loop exits and it is dropped, but
  // a shorter unref'd one still fires while a reffed timer keeps the loop
  // running past its deadline.
  const path = await build("unref.ts", [
    "setTimeout(() => {",
    "  console.log('SHOULD NOT PRINT');",
    "}, 5000).unref();",
    "const early = setTimeout(() => {",
    "  console.log('early unrefd fires');",
    "}, 1);",
    "early.unref();",
    "console.log('early hasRef', early.hasRef());",
    "setTimeout(() => {",
    "  console.log('reffed fires');",
    "}, 2);",
  ]);
  const { stdout } = await runWasm(path);
  expect(stdout).toBe(
    ["early hasRef false", "early unrefd fires", "reffed fires", ""].join("\n"),
  );
});

test("refresh() from inside the callback re-arms the one-shot exactly once more", async () => {
  // Timeout.refresh() re-arms to now + the ORIGINAL delay, which is why
  // the entry stores that delay; refreshing only on the first fire means
  // the callback runs exactly twice.
  const path = await build("refresh.ts", [
    "let fires = 0;",
    "const t = setTimeout(() => {",
    "  fires += 1;",
    "  console.log('fire', fires);",
    "  if (fires === 1) {",
    "    t.refresh();",
    "  }",
    "}, 3);",
    "console.log('armed', t.hasRef());",
  ]);
  const { stdout } = await runWasm(path);
  expect(stdout).toBe(["armed true", "fire 1", "fire 2", ""].join("\n"));
});

test("refresh() of an ARMED timer moves it, seq and all", async () => {
  // The other half of refresh: the entry is still in the heap, so it
  // leaves and re-enters at now + its ORIGINAL delay with a FRESH seq —
  // which moves it from deadline 3 to deadline 5, behind the 4ms marker.
  // (The corpus only covers refresh from inside the callback.)
  const path = await build("refresharmed.ts", [
    "const t = setTimeout(() => {",
    "  console.log('refreshed one fires');",
    "}, 3);",
    "setTimeout(() => {",
    "  console.log('marker at 4');",
    "}, 4);",
    "setTimeout(() => {",
    "  console.log('refresher at 2');",
    "  t.refresh();",
    "}, 2);",
    "console.log('armed');",
  ]);
  const { stdout } = await runWasm(path);
  expect(stdout).toBe(
    ["armed", "refresher at 2", "marker at 4", "refreshed one fires", ""].join("\n"),
  );
});

test("an async function awaiting a setTimeout-backed promise resumes in the timer's turn", async () => {
  // The delay(ms) idiom: the executor arms a timer whose callback
  // resolves, so the awaiting frame is woken by the microtask drain that
  // follows THAT timer callback — before any later timer fires.
  const path = await build("delay.ts", [
    "function delay(ms: number): Promise<void> {",
    "  return new Promise<void>((resolve) => {",
    "    setTimeout(() => {",
    "      console.log('timer', ms);",
    "      resolve();",
    "    }, ms);",
    "  });",
    "}",
    "async function main(): Promise<void> {",
    "  console.log('enter');",
    "  await delay(2);",
    "  console.log('woke at 2');",
    "  await delay(1);",
    "  console.log('woke at 3');",
    "}",
    "main();",
    "setTimeout(() => {",
    "  console.log('independent 1');",
    "}, 1);",
    "console.log('sync tail');",
  ]);
  const { stdout, stderr } = await runWasm(path);
  expect(stdout).toBe(
    [
      "enter",
      "sync tail",
      "independent 1",
      "timer 2",
      "woke at 2",
      "timer 1",
      "woke at 3",
      "",
    ].join("\n"),
  );
  expect(stderr).toBe("");
});

test("a throw out of an interval callback keeps the output, traps, and kills the re-arm", async () => {
  // Node's uncaught exception ends the process before another tick can
  // run, so the interval does NOT fire a third time (SEMANTICS.md S007 —
  // the trap is the exit-1 channel, and stdout up to it must survive).
  const path = await build("throwing.ts", [
    "let n = 0;",
    "setInterval(() => {",
    "  n += 1;",
    "  console.log('tick', n);",
    "  if (n === 2) {",
    "    throw new Error('interval boom');",
    "  }",
    "}, 3);",
    "console.log('armed');",
  ]);
  const { stdout, stderr } = await runWasmToTrap(path);
  expect(stdout).toBe(["armed", "tick 1", "tick 2", ""].join("\n"));
  // GATE FIX C5 (SEMANTICS.md S007's amendment): `_tick`'s death check
  // reports before it traps too — timers.ts's emitDeathCheck now calls
  // the same %w.err.reportUncaught emitter.ts's `_start` check does.
  // Exact equality is the double-print pin.
  expect(stderr).toBe("Uncaught Error: interval boom\n");
});

test("an unhandled rejection from a timer stops the next same-deadline timer", async () => {
  // The checkpoint runs after EVERY timer callback, not only when one
  // left microtasks ready — Node's `runNextTicks` does, so the process is
  // already dead when the second 1ms timer would have fired. (This is the
  // one place the loop follows Node rather than scr_async.c, whose
  // checkpoint-only report would have let the second one run.)
  const path = await build("rejectstop.ts", [
    "setTimeout(() => {",
    "  console.log('first timer');",
    "  Promise.reject(new Error('nobody handles me'));",
    "}, 1);",
    "setTimeout(() => {",
    "  console.log('SHOULD NOT PRINT');",
    "}, 1);",
    "console.log('sync tail');",
  ]);
  const { stdout, stderr } = await runWasmToTrap(path);
  expect(stdout).toBe(["sync tail", "first timer", ""].join("\n"));
  expect(stderr).toBe("Unhandled promise rejection: Error: nobody handles me\n");
});

test("immediates run after the microtask drain, FIFO", async () => {
  // No timer anywhere on purpose: setImmediate against a setTimeout armed
  // in the SAME synchronous body is the interleaving Node itself calls
  // non-deterministic ("bound by the performance of the process"), so
  // nothing here — and nothing in the corpus — may pin it.
  const path = await build("immbasics.ts", [
    "setImmediate(() => {",
    "  console.log('immediate one');",
    "});",
    "setImmediate(() => {",
    "  console.log('immediate two');",
    "});",
    "async function micro(): Promise<void> {",
    "  await null;",
    "  console.log('microtask');",
    "}",
    "micro();",
    "console.log('sync tail');",
  ]);
  const { stdout } = await runWasm(path);
  expect(stdout).toBe(
    ["sync tail", "microtask", "immediate one", "immediate two", ""].join("\n"),
  );
});

test("the check phase follows due timers, and an immediate queued mid-phase goes last", async () => {
  // Everything is queued from inside ONE timer callback, which is what
  // makes the interleaving deterministic (the corpus's 1804 does the
  // same). The check phase then runs A and B — the entries that existed
  // when it started — and D, queued while A ran, waits for the next turn
  // instead of extending this one: the end snapshot, and the reason a
  // setImmediate chain cannot starve the timers phase.
  const path = await build("immsnapshot.ts", [
    "setTimeout(() => {",
    "  console.log('root');",
    "  setImmediate(() => {",
    "    console.log('A');",
    "    setImmediate(() => {",
    "      console.log('D queued mid-phase');",
    "    });",
    "  });",
    "  setImmediate(() => {",
    "    console.log('B');",
    "  });",
    "}, 1);",
    "console.log('sync tail');",
  ]);
  const { stdout } = await runWasm(path);
  expect(stdout).toBe(["sync tail", "root", "A", "B", "D queued mid-phase", ""].join("\n"));
});

test("an unref'd immediate fires beside reffed work and never once alone", async () => {
  // Liveness counts only REF'D work, immediates included: the unref'd one
  // rides its reffed neighbour's phase, and the one queued when nothing
  // reffed remains is simply dropped at exit.
  const path = await build("immunref.ts", [
    "setImmediate(() => {",
    "  console.log('unrefd neighbour fires');",
    "}).unref();",
    "setImmediate(() => {",
    "  console.log('reffed fires');",
    "  setImmediate(() => {",
    "    console.log('SHOULD NOT PRINT');",
    "  }).unref();",
    "});",
    "console.log('sync tail');",
  ]);
  const { stdout } = await runWasm(path);
  expect(stdout).toBe(
    ["sync tail", "unrefd neighbour fires", "reffed fires", ""].join("\n"),
  );
});

test("a module with no timer surface imports no clock and exports no _tick", async () => {
  // The conditional-surface contract (abi.ts): the timer half of the ABI
  // exists only where a timer can be armed, so an async-but-timerless
  // program keeps stage 2's exact shape.
  const path = await build("notimers.ts", [
    "async function main(): Promise<void> {",
    "  await Promise.resolve(1);",
    "  console.log('done');",
    "}",
    "main();",
  ]);
  const bytes = readFileSync(path);
  expect(bytes.includes(Buffer.from("_tick"))).toBe(false);
  expect(bytes.includes(Buffer.from("%w.timer"))).toBe(false);
  // "now" would appear as an import name only; "%w.async" proves the
  // promise runtime IS there, so the absence above is conditionality and
  // not an empty program.
  expect(bytes.includes(Buffer.from("%w.async"))).toBe(true);
  const { stdout } = await runWasm(path);
  expect(stdout).toBe("done\n");
});
