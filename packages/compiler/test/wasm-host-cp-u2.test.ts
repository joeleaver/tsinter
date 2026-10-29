/* INC-28 U2 — the FORCED-HOST rows for child_process's asynchronous surface:
 * a real compile()d program run through wasm-host.ts's event drive against a
 * SCRIPTED cpCall (SPAWN's reply, UNREF, RELEASE) and a SCRIPTED evPoll
 * queue, on the virtual clock — never a real child. Each row scripts what
 * the host hands back and asserts what the module makes of it, or records
 * what the module asks and asserts that. The values are deliberately not a
 * real host's (pids, handles, times). Rows that run real children live in
 * tests/harness/wasm-differential.test.ts. Every row names the single edit
 * that would make it fail. */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { runWasm, runWasmToTrap, type HostOverrides, type HostRun } from "./wasm-host.js";
import { osTableHostNum } from "./wasm-os-tables-host.js";

let scratch: string;
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "tsinter-wasm-host-cp-u2-"));
});
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

let seq = 0;
async function buildProgram(src: string): Promise<string> {
  const file = join(scratch, `p${seq++}.ts`);
  await writeFile(file, src);
  const res = await compile(file, { outPath: `${file}.wasm`, outDir: scratch, dynamic: false, backend: "wasm" });
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message} (${res.diagnostics[0]?.code})`);
  return res.binaryPath;
}

/** One scripted SPAWN reply: the answer, then the 12-byte reply record. */
interface SpawnReply {
  answer: number;
  errno: number;
  disposition: number;
  pid: number;
}

/** One scripted event, deliverable once the drive's clock reaches `at`. */
interface ScriptedEvent {
  at: number;
  source?: number;
  handle: number;
  kind: number;
  a?: number;
  b?: number;
  payload?: number[];
}

/** A SPAWN request as the module wrote it (abi.ts layout). */
interface SpawnRequest {
  modes: number[];
  outFd: number;
  errFd: number;
  detached: number;
  file: string;
  argv: string[];
  cwd: string;
  env: [string, string][];
}

interface Script {
  spawns?: SpawnReply[];
  events?: ScriptedEvent[];
  /** The module's environment, served through hostStr/hostNum. */
  env?: [string, string][];
  /** Leave evPoll to wasm-host.ts's loud default. */
  noEvPoll?: boolean;
  /** From the `now` import's (calls + 1)-th answer on, the clock reads at
   * least `value` — synchronous time passing in _start. */
  nowAfter?: { calls: number; value: number };
  /** Once the clock has reached `at`, the `now` import's third answer
   * there and every later one read at least `value`: the drive's own read
   * and the loop's update before the timers phase come first, so the jump
   * lands inside the first callback that reads the clock. */
  nowBump?: { at: number; value: number };
  /** KILL's answers, in order. */
  kills?: number[];
}

interface Trace {
  requests: SpawnRequest[];
  /** Every cpCall after SPAWN as "op:h", and every evPoll as "poll:cap". */
  ops: string[];
  idles: number;
}

function decodeSpawn(mem: WebAssembly.Memory, ptr: number, len: number): SpawnRequest {
  const dv = new DataView(mem.buffer, ptr, len);
  let off = 32;
  const u32 = (): number => {
    const v = dv.getUint32(off, true);
    off += 4;
    return v;
  };
  const run = (): string => {
    const n = u32();
    let text = "";
    for (let i = 0; i < n; i++) text += String.fromCharCode(dv.getUint16(off + 2 * i, true));
    off += (2 * n + 3) & ~3;
    return text;
  };
  const file = run();
  const argv: string[] = [];
  for (let i = u32(); i > 0; i--) argv.push(run());
  const cwd = run();
  const env: [string, string][] = [];
  for (let i = u32(); i > 0; i--) {
    const k = run();
    env.push([k, run()]);
  }
  return {
    modes: [dv.getUint32(0, true), dv.getUint32(4, true), dv.getUint32(8, true)],
    outFd: dv.getInt32(12, true),
    errFd: dv.getInt32(16, true),
    detached: dv.getUint32(20, true),
    file,
    argv,
    cwd,
    env,
  };
}

/** The scripted host: SPAWN answers from `spawns` in order; UNREF and
 * RELEASE answer 0; evPoll serves `events` whose time has come, oldest
 * first, with abi.ts's short-buffer answer; the drive's +Infinity jumps to
 * the next event's time. */
function forced(script: Script): { overrides: HostOverrides; trace: Trace } {
  let memory: WebAssembly.Memory | null = null;
  let clock = 0;
  const spawns = [...(script.spawns ?? [])];
  const events = [...(script.events ?? [])];
  const trace: Trace = { requests: [], ops: [], idles: 0 };
  const env = script.env ?? [];
  let nowCalls = 0;
  let bumpCalls = 0;
  const kills = [...(script.kills ?? [])];
  const imports: Record<string, unknown> = {
    cpCall(op: number, ptr: number, len: number, h: number, which: number): number {
      if (op === 5) {
        trace.requests.push(decodeSpawn(memory!, ptr, len));
        const r = spawns.shift();
        if (r === undefined) throw new Error("forced host: no SPAWN reply scripted");
        const dv = new DataView(memory!.buffer, ptr, 12);
        dv.setInt32(0, r.errno, true);
        dv.setInt32(4, r.disposition, true);
        dv.setInt32(8, r.pid, true);
        return r.answer;
      }
      trace.ops.push(`${op}:${h}${op === 6 ? `:${which}` : ""}`);
      if (op === 6) {
        const k = kills.shift();
        if (k === undefined) throw new Error("forced host: no KILL answer scripted");
        return k;
      }
      return 0;
    },
    hostNum(kind: number, _arg: number): number {
      const os = osTableHostNum(kind, _arg);
      if (os !== undefined) return os;
      if (kind === 0) return 2;
      if (kind === 1) return env.length;
      throw new Error(`forced host: hostNum kind ${kind}`);
    },
    hostStr(kind: number, index: number, ptr: number, cap: number): number {
      const s = kind === 1 ? env[index]?.[0] : kind === 2 ? env[index]?.[1] : kind === 0 ? ["scriptc", "p.wasm"][index] : undefined;
      if (s === undefined) return -1;
      if (s.length > cap) return s.length;
      const view = new Uint16Array(memory!.buffer, ptr, s.length);
      for (let i = 0; i < s.length; i++) view[i] = s.charCodeAt(i);
      return s.length;
    },
    now: (): number => {
      nowCalls++;
      if (script.nowAfter !== undefined && nowCalls > script.nowAfter.calls) clock = Math.max(clock, script.nowAfter.value);
      if (script.nowBump !== undefined && clock >= script.nowBump.at) {
        bumpCalls++;
        if (bumpCalls >= 3) clock = Math.max(clock, script.nowBump.value);
      }
      return clock;
    },
  };
  if (!script.noEvPoll) {
    imports["evPoll"] = (ptr: number, cap: number): number => {
      trace.ops.push(`poll:${cap}`);
      const ev = events[0];
      if (ev === undefined || ev.at > clock) return 0;
      const payload = ev.payload ?? [];
      const need = 24 + payload.length;
      if (cap < need) return -need;
      events.shift();
      const dv = new DataView(memory!.buffer, ptr, need);
      dv.setUint32(0, ev.source ?? 1, true);
      dv.setUint32(4, ev.handle, true);
      dv.setUint32(8, ev.kind, true);
      dv.setUint32(12, payload.length, true);
      dv.setInt32(16, ev.a ?? 0, true);
      dv.setInt32(20, ev.b ?? 0, true);
      new Uint8Array(memory!.buffer, ptr + 24, payload.length).set(payload);
      return need;
    };
  }
  const overrides: HostOverrides = {
    imports,
    onInstance: (instance) => {
      memory = instance.exports["memory"] as WebAssembly.Memory;
    },
    onIdle: () => {
      trace.idles++;
      return events[0]?.at;
    },
    onJump: (to) => {
      clock = to;
    },
  };
  return { overrides, trace };
}

const ok = (handle: number, pid = 4000 + handle): SpawnReply => ({ answer: handle, errno: 0, disposition: 0, pid });

async function run(src: string, script: Script): Promise<{ out: HostRun; trace: Trace }> {
  const path = await buildProgram(src);
  const { overrides, trace } = forced(script);
  const out = await runWasm(path, overrides);
  return { out, trace };
}

async function runToTrap(src: string, script: Script): Promise<{ out: HostRun; trace: Trace }> {
  const path = await buildProgram(src);
  const { overrides, trace } = forced(script);
  const out = await runWasmToTrap(path, overrides);
  return { out, trace };
}

const LISTEN2 =
  'import { spawn } from "node:child_process";\nconst c = spawn("prog", ["a1"], { stdio: "ignore" });\nc.on("exit", (code, signal) => {\n  console.log("exit", code, signal);\n});\nconsole.log("main done");\n';

describe("INC-28 U2 child_process async — forced-host rows", () => {
  test("U2-FH-01 an EXIT with code 3 reaches the listener as (3, null), and RELEASE follows — SINGLE-EDIT: a and b swapped when reading the record", async () => {
    const { out, trace } = await run(LISTEN2, { spawns: [ok(1)], events: [{ at: 5, handle: 1, kind: 1, a: 3, b: 0 }] });
    expect(out.stdout).toBe("main done\nexit 3 null\n");
    expect(out.exitCode).toBe(0);
    expect(trace.ops.filter((o) => !o.startsWith("poll"))).toEqual(["8:1"]);
  });
  test("U2-FH-02 an EXIT ended by signal 9 reaches the listener as (null, \"SIGKILL\") — SINGLE-EDIT: the signal arm built from a instead of b", async () => {
    const { out } = await run(LISTEN2, { spawns: [ok(1)], events: [{ at: 5, handle: 1, kind: 1, a: -1, b: 9 }] });
    expect(out.stdout).toBe("main done\nexit null SIGKILL\n");
  });
  test("U2-FH-03 kind 2 bytes are written raw to the program's stdout, kind 3 to its stderr, at the poll — SINGLE-EDIT: kinds 2 and 3 swapped", async () => {
    const { out } = await run(LISTEN2, {
      spawns: [ok(1)],
      events: [
        { at: 1, handle: 1, kind: 2, payload: [104, 105, 10] },
        { at: 1, handle: 1, kind: 3, payload: [0xff, 10] },
        { at: 2, handle: 1, kind: 1, a: 0 },
      ],
    });
    expect(out.stdout).toBe("main done\nhi\nexit 0 null\n");
    // The raw byte FF, decoded by this host's utf8 capture as U+FFFD.
    expect(out.stderr).toBe("\ufffd\n");
  });
  test("U2-FH-05 a short buffer: evPoll answers -(5024) for a 5000-byte event, the module asks again with a buffer that large, and the bytes arrive whole — SINGLE-EDIT: the module drops the event on a negative answer", async () => {
    const payload = Array.from({ length: 5000 }, () => 120);
    const { out, trace } = await run(LISTEN2, { spawns: [ok(1)], events: [{ at: 1, handle: 1, kind: 2, payload }, { at: 1, handle: 1, kind: 1, a: 0 }] });
    expect(out.stdout).toBe(`main done\n${"x".repeat(5000)}exit 0 null\n`);
    const polls = trace.ops.filter((o) => o.startsWith("poll")).map((o) => Number(o.slice(5)));
    expect(polls[0]).toBe(1024);
    expect(polls[1]).toBe(5024);
  });
  test("U2-FH-06 the first _loop call never answers -1 when something was alive before the pre-loop timers pass: an unref'd child's exit queued at 0 is delivered after the last ref'd timer ran in that pass — SINGLE-EDIT: liveness re-tested after the pre-loop pass", async () => {
    const { out } = await run(
      'import { spawn } from "node:child_process";\nconst c = spawn("prog", [], { stdio: "ignore" });\nc.unref();\nc.on("exit", (code) => {\n  console.log("exit", code);\n});\nsetTimeout(() => {\n  console.log("t0");\n}, 0);\nconsole.log("main done");\n',
      { spawns: [ok(1)], events: [{ at: 0, handle: 1, kind: 1, a: 0 }], nowAfter: { calls: 1, value: 10 } },
    );
    expect(out.stdout).toBe("main done\nt0\nexit 0\n");
  });
  test("U2-FH-07 liveness: a ref'd child alone holds the loop (+Infinity, the drive asks for the next event); once unref'd nothing holds it and evPoll is never called — SINGLE-EDIT: unref leaves the child counted", async () => {
    const held = await run(LISTEN2, { spawns: [ok(1)], events: [{ at: 7, handle: 1, kind: 1, a: 0 }] });
    expect(held.trace.idles).toBe(1);
    expect(held.out.stdout).toBe("main done\nexit 0 null\n");
    const unref = await run(
      'import { spawn } from "node:child_process";\nconst c = spawn("prog", [], { stdio: "ignore" });\nc.unref();\nc.on("exit", () => {\n  console.log("never");\n});\nconsole.log("main done");\n',
      { spawns: [ok(1)], events: [{ at: 7, handle: 1, kind: 1, a: 0 }] },
    );
    expect(unref.out.stdout).toBe("main done\n");
    expect(unref.trace.ops).toEqual(["7:1"]);
  });
  test("U2-FH-08 the poll phase runs before the check phase: an exit queued at 0 is delivered before an immediate queued in _start — SINGLE-EDIT: check before poll", async () => {
    const { out } = await run(
      'import { spawn } from "node:child_process";\nconst c = spawn("prog", [], { stdio: "ignore" });\nc.on("exit", () => {\n  console.log("exit");\n});\nsetImmediate(() => {\n  console.log("immediate");\n});\n',
      { spawns: [ok(1)], events: [{ at: 0, handle: 1, kind: 1, a: 0 }] },
    );
    expect(out.stdout).toBe("exit\nimmediate\n");
  });
  test("U2-FH-09 the poll phase runs before the timers phase: an exit and a timer both ready at 10 — the exit first — SINGLE-EDIT: timers before poll", async () => {
    const { out } = await run(
      'import { spawn } from "node:child_process";\nconst c = spawn("prog", [], { stdio: "ignore" });\nc.on("exit", () => {\n  console.log("exit");\n});\nsetTimeout(() => {\n  console.log("timer");\n}, 10);\n',
      { spawns: [ok(1)], events: [{ at: 10, handle: 1, kind: 1, a: 0 }] },
    );
    expect(out.stdout).toBe("exit\ntimer\n");
  });
  test("U2-FH-11 +Infinity with no event any source can deliver is a loud failure of the drive, never a hang — SINGLE-EDIT: the drive treats +Infinity as a jump", async () => {
    const path = await buildProgram(LISTEN2);
    const { overrides } = forced({ spawns: [ok(1)], events: [] });
    await expect(runWasm(path, overrides)).rejects.toThrow(/module waits for an event no source can deliver/);
  });
  test("U2-FH-12 wasm-host.ts's default evPoll is loud: a module that polls with no scripted evPoll fails naming evPoll — SINGLE-EDIT: the default stub answers 0", async () => {
    const path = await buildProgram(LISTEN2);
    const { overrides } = forced({ spawns: [ok(1)], noEvPoll: true });
    overrides.onIdle = () => 1;
    await expect(runWasm(path, overrides)).rejects.toThrow(/evPoll: reached with no forced host/);
  });
  test("U2-FH-13 the disposition check: a host answering disposition 1 for ENOTDIR (Node throws ENOTDIR) is a host failure trap — SINGLE-EDIT: the module trusts the host's disposition", async () => {
    const { out } = await runToTrap(LISTEN2, { spawns: [{ answer: 0, errno: -20, disposition: 1, pid: 0 }] });
    expect(out.stdout).toBe("");
    expect(out.stderr).toContain("cpCall: host failure");
  });
  test("U2-FH-14 a negative SPAWN answer is a host failure trap — SINGLE-EDIT: the negative answer read as a handle", async () => {
    const { out } = await runToTrap(LISTEN2, { spawns: [{ answer: -1, errno: 0, disposition: 0, pid: 0 }] });
    expect(out.stderr).toContain("cpCall: host failure");
  });
  test("U2-FH-21 SPAWN's answer rule both ways: a handle of 0 with disposition 0, and a handle of 3 with disposition 1, are both host failure traps — SINGLE-EDIT: either direction of the check removed", async () => {
    const a = await runToTrap(LISTEN2, { spawns: [{ answer: 0, errno: 0, disposition: 0, pid: 9 }] });
    expect(a.out.stderr).toContain("cpCall: host failure");
    const b = await runToTrap(LISTEN2, { spawns: [{ answer: 3, errno: -2, disposition: 1, pid: 0 }] });
    expect(b.out.stderr).toContain("cpCall: host failure");
  });
  test("U2-FH-15 the SPAWN request: modes, detached, cwd, args, and the environment — the module's own map cut at U+0000 when the call has no env option, the replacement pairs as given when it has one — SINGLE-EDIT: the cut applied to the replacement pairs", async () => {
    const { trace } = await run(
      'import { spawn } from "node:child_process";\nprocess.env.EXTRA = "a\\u0000b";\nconst a = spawn("prog", ["x", "y z"], { stdio: "ignore" });\na.unref();\nconst b = spawn("other", [], { stdio: "ignore", detached: true, cwd: "/tmp", env: { ONLY: "v" } });\nb.unref();\nconsole.log("main done");\n',
      { spawns: [ok(1), ok(2)], env: [["HOME", "/h"]] },
    );
    expect(trace.requests).toEqual([
      { modes: [0, 0, 0], outFd: 0, errFd: 0, detached: 0, file: "prog", argv: ["x", "y z"], cwd: "", env: [["HOME", "/h"], ["EXTRA", "a"]] },
      { modes: [0, 0, 0], outFd: 0, errFd: 0, detached: 1, file: "other", argv: [], cwd: "/tmp", env: [["ONLY", "v"]] },
    ]);
  });
  test("U2-FH-18 UNREF is sent once for a live ref'd child (a second unref sends nothing), and RELEASE only after its EXIT was read — SINGLE-EDIT: RELEASE sent before the exit is delivered", async () => {
    const { trace } = await run(
      'import { spawn } from "node:child_process";\nconst c = spawn("prog", [], { stdio: "ignore" });\nc.unref();\nc.unref();\nc.on("exit", () => {\n  console.log("exit");\n});\nsetTimeout(() => {\n  console.log("holder");\n}, 20);\n',
      { spawns: [ok(1)], events: [{ at: 5, handle: 1, kind: 1, a: 0 }] },
    );
    const ops = trace.ops.filter((o) => !o.startsWith("poll"));
    expect(ops).toEqual(["7:1", "8:1"]);
  });
  test("U2-FH-10 the cached due: a timer that comes due while an earlier timer's callback runs (the clock jumps from 10 to 200 inside it) waits for the next timers pass, after the immediate that callback queued — SINGLE-EDIT: the timers phase re-reads the clock per timer", async () => {
    const { out } = await run(
      'import { spawn } from "node:child_process";\nconst c = spawn("prog", [], { stdio: "ignore" });\nc.unref();\nsetTimeout(() => {\n  console.log("C (100)");\n}, 100);\nsetTimeout(() => {\n  performance.now();\n  setImmediate(() => {\n    console.log("I");\n  });\n  console.log("A (10)");\n}, 10);\n',
      { spawns: [ok(1)], nowBump: { at: 10, value: 200 } },
    );
    expect(out.stdout).toBe("A (10)\nI\nC (100)\n");
  });
  test("U2-FH-16 KILL: the handle and the Linux signal number reach the host (SIGINT = 2, the default SIGTERM = 15); an EPERM answer emits 'error' (\"kill EPERM\", code EPERM) synchronously, before kill returns false — SINGLE-EDIT: the error emitted on a nextTick", async () => {
    const { out, trace } = await run(
      'import { spawn } from "node:child_process";\nconst c = spawn("prog", [], { stdio: "ignore" });\nc.on("error", (e) => {\n  console.log("error", e.message, (e as NodeJS.ErrnoException).code);\n});\nconsole.log("int", c.kill("SIGINT"), c.killed);\nconsole.log("term", c.kill(), c.killed);\nc.unref();\n',
      { spawns: [ok(1)], kills: [-1, 0] },
    );
    expect(trace.ops.slice(0, 2)).toEqual(["6:1:2", "6:1:15"]);
    expect(out.stdout).toBe("error kill EPERM EPERM\nint false false\nterm true true\n");
  });
  test("U2-FH-17 KILL answering EINVAL throws \"kill EINVAL\" (code EINVAL), catchably; ESRCH answers false — SINGLE-EDIT: EINVAL emitted instead of thrown", async () => {
    const { out } = await run(
      'import { spawn } from "node:child_process";\nconst c = spawn("prog", [], { stdio: "ignore" });\ntry {\n  c.kill("SIGHUP");\n} catch (e) {\n  console.log("threw", (e as Error).message, (e as NodeJS.ErrnoException).code);\n}\nconsole.log("gone", c.kill("SIGHUP"), c.killed);\nc.unref();\n',
      { spawns: [ok(1)], kills: [-22, -3] },
    );
    expect(out.stdout).toBe("threw kill EINVAL EINVAL\ngone false false\n");
  });
  test("U2-FH-19 kill with an unknown NUMBER throws ERR_UNKNOWN_SIGNAL through a function boundary, with no other try or rejection handler in the module; the catch's own cast marks only the caller (the may-throw analysis reads child.killNum as throwing) — SINGLE-EDIT: child.killNum dropped from the may-throw copy", async () => {
    const { out, trace } = await run(
      'import { spawn, type ChildProcess } from "node:child_process";\nfunction stop(c: ChildProcess, n: number): void {\n  c.kill(n);\n  console.log("not reached");\n}\nfunction guarded(c: ChildProcess): void {\n  try {\n    stop(c, 999);\n  } catch (e) {\n    console.log("caught", (e as Error).message);\n  }\n}\nconst c = spawn("prog", [], { stdio: "ignore" });\nguarded(c);\nc.unref();\n',
      { spawns: [ok(1)] },
    );
    expect(out.stdout).toBe("caught Unknown signal: 999\n");
    expect(trace.ops.filter((o) => o.startsWith("6:"))).toEqual([]);
  });
  test("U2-FH-20 an evPoll record the module cannot read (an unknown source, kind or handle) is a host failure trap — SINGLE-EDIT: an unknown kind ignored", async () => {
    for (const ev of [
      { at: 1, source: 2, handle: 1, kind: 1 },
      { at: 1, handle: 1, kind: 9 },
      { at: 1, handle: 7, kind: 1 },
    ]) {
      const { out } = await runToTrap(LISTEN2, { spawns: [ok(1)], events: [ev] });
      expect(out.stderr).toContain("cpCall: host failure");
    }
  });
});
