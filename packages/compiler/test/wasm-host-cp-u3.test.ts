/* INC-28 U3 — the FORCED-HOST rows for child output streams: a real
 * compile()d program run through wasm-host.ts's event drive against a
 * SCRIPTED cpCall (SPAWN's reply, FLOW, RELEASE) and a SCRIPTED evPoll queue
 * carrying kinds 4 (STREAM-DATA) and 5 (STREAM-END) and the kind word's
 * same-scope bit (0x100), on the virtual clock — never a real child. The
 * scripting helpers are wasm-host-cp-u2.test.ts's, copied (each forced-host
 * file is self-contained), with FLOW's `which` recorded. Rows that run real
 * children live in tests/harness/wasm-differential.test.ts ("INC-28 U3 child
 * output stream rows"). Every row names the single edit that would make it
 * fail. */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { runWasm, runWasmToTrap, type HostOverrides, type HostRun } from "./wasm-host.js";

let scratch: string;
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "tsinter-wasm-host-cp-u3-"));
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
      trace.ops.push(`${op}:${h}${op === 6 || op === 9 ? `:${which}` : ""}`);
      if (op === 6) {
        const k = kills.shift();
        if (k === undefined) throw new Error("forced host: no KILL answer scripted");
        return k;
      }
      return 0;
    },
    hostNum(kind: number, _arg: number): number {
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

const SAME = 0x100;
const DATA = 4;
const END = 5;
const HELD = 6;
const bytes = (s: string): number[] => [...Buffer.from(s, "latin1")];
const nonPoll = (ops: string[]): string[] => ops.filter((o) => !o.startsWith("poll"));

/** stdout piped, stderr ignored; data, end and exit each logged. */
const PIPE_OUT =
  'import { spawn } from "node:child_process";\nconst c = spawn("prog", [], { stdio: ["ignore", "pipe", "ignore"] });\nc.stdout?.on("data", (d: Buffer) => console.log("data", d.toString()));\nc.stdout?.on("end", () => console.log("end"));\nc.on("exit", (code) => console.log("exit", code));\n';

/** The chain-and-microtask marker of the measured order rows. */
const MARK =
  'const mark = (name: string): void => {\n  console.log(name);\n  process.nextTick(() => {\n    console.log(name + ":t1");\n    process.nextTick(() => {\n      console.log(name + ":t2");\n      process.nextTick(() => console.log(name + ":t3"));\n    });\n  });\n  void Promise.resolve().then(() => console.log(name + ":m"));\n};\n';

describe("INC-28 U3 child output streams — forced-host rows", () => {
  test("U3-FH-01 FLOW: the first 'data' listener of each stream sends op 9 with its handle and slot, once; an 'end' listener and a second 'data' listener send nothing — SINGLE-EDIT: FLOW sent for every data listener", async () => {
    const { trace } = await run(
      'import { spawn } from "node:child_process";\nconst c = spawn("prog", [], { stdio: ["ignore", "pipe", "pipe"] });\nc.stdout?.on("end", () => console.log("end"));\nc.stdout?.on("data", () => console.log("a"));\nc.stdout?.on("data", () => console.log("b"));\nc.stderr?.on("data", () => console.log("c"));\nc.on("exit", () => console.log("exit"));\n',
      { spawns: [ok(1)], events: [{ at: 1, handle: 1, kind: 1, a: 0 }, { at: 2, handle: 1, kind: END, a: 1 }, { at: 2, handle: 1, kind: END, a: 2 }] },
    );
    expect(nonPoll(trace.ops)).toEqual(["9:1:1", "9:1:2", "8:1"]);
    expect(trace.requests[0]!.modes).toEqual([0, 3, 3]);
  });
  test("U3-FH-02 DATA: one fresh Buffer per chunk, the SAME object for every listener (a write by the first is seen by the second); the payload's bytes as sent — SINGLE-EDIT: a Buffer built per listener", async () => {
    const { out } = await run(
      'import { spawn } from "node:child_process";\nconst c = spawn("prog", [], { stdio: ["ignore", "pipe", "ignore"] });\nc.stdout?.on("data", (d: Buffer) => {\n  console.log("first", d.toString("hex"));\n  d[0] = 0x7a;\n});\nc.stdout?.on("data", (d: Buffer) => console.log("second", d.toString("latin1"), d.length));\nc.on("exit", () => console.log("exit"));\n',
      { spawns: [ok(1)], events: [{ at: 1, handle: 1, kind: DATA, a: 1, payload: [0x61, 0x00, 0xff] }, { at: 2, handle: 1, kind: END, a: 1 }, { at: 3, handle: 1, kind: 1, a: 0 }] },
    );
    expect(out.stdout).toBe("first 6100ff\nsecond z\u0000\u00ff 3\nexit\n");
  });
  test("U3-FH-03 a short buffer: a 5000-byte DATA is answered -(5024), the module asks again with that much and the chunk arrives whole — SINGLE-EDIT: the DATA payload read before the grow", async () => {
    const payload = Array.from({ length: 5000 }, (_, i) => 97 + (i % 26));
    const { out, trace } = await run(PIPE_OUT, {
      spawns: [ok(1)],
      events: [{ at: 1, handle: 1, kind: DATA, a: 1, payload }, { at: 1, handle: 1, kind: END, a: 1 }, { at: 2, handle: 1, kind: 1, a: 0 }],
    });
    expect(out.stdout).toBe(`data ${Buffer.from(payload).toString("latin1")}\nend\nexit 0\n`);
    const polls = trace.ops.filter((o) => o.startsWith("poll")).map((o) => Number(o.slice(5)));
    expect(polls[0]).toBe(1024);
    expect(polls[1]).toBe(5024);
  });
  test("U3-FH-04 the same-scope bit: an EXIT marked 0x100 followed by its unconsumed stream's END ends the stream from the exit's three-hop flushStdio chain, before the exit listener's microtask (Node's flushStdio chain); unmarked, the END is its own scope and 'end' follows the microtask — SINGLE-EDIT: the bit ignored", async () => {
    const src =
      'import { spawn } from "node:child_process";\n' + MARK +
      'const c = spawn("prog", [], { stdio: ["ignore", "pipe", "ignore"] });\nc.stdout?.on("end", () => mark("end"));\nc.on("exit", () => mark("exit"));\n';
    const same = await run(src, { spawns: [ok(1)], events: [{ at: 1, handle: 1, kind: 1 | SAME, a: 0 }, { at: 1, handle: 1, kind: END, a: 1 }] });
    // Node's own order (measured: U3-ORD-02's stdout): flushStdio, resume_
    // and endReadableNT are three hops, so 'end' follows the listener's
    // third-generation tick and precedes its microtask.
    expect(same.out.stdout).toBe("exit\nexit:t1\nexit:t2\nexit:t3\nend\nend:t1\nend:t2\nend:t3\nexit:m\nend:m\n");
    const apart = await run(src, { spawns: [ok(1)], events: [{ at: 1, handle: 1, kind: 1, a: 0 }, { at: 1, handle: 1, kind: END, a: 1 }] });
    expect(apart.out.stdout).toBe("exit\nexit:t1\nexit:t2\nexit:t3\nexit:m\nend\nend:t1\nend:t2\nend:t3\nend:m\n");
  });
  test("U3-FH-05 'end' is one tick after a consuming stream's END: the last data listener's ticks and microtask run first, each event its own scope — SINGLE-EDIT: 'end' emitted at the poll point before the previous event's checkpoint", async () => {
    const { out } = await run(
      'import { spawn } from "node:child_process";\n' + MARK +
      'const c = spawn("prog", [], { stdio: ["ignore", "pipe", "ignore"] });\nc.stdout?.on("data", () => mark("data"));\nc.stdout?.on("end", () => mark("end"));\nc.on("exit", () => mark("exit"));\n',
      { spawns: [ok(1)], events: [{ at: 1, handle: 1, kind: DATA, a: 1, payload: [1] }, { at: 1, handle: 1, kind: END, a: 1 }, { at: 1, handle: 1, kind: 1, a: 0 }] },
    );
    expect(out.stdout).toBe("data\ndata:t1\ndata:t2\ndata:t3\ndata:m\nend\nend:t1\nend:t2\nend:t3\nend:m\nexit\nexit:t1\nexit:t2\nexit:t3\nexit:m\n");
  });
  test("U3-FH-06 an unconsumed stream's END in its own scope (an empty stream ends on its own) runs 'end' one tick on, before an exit that comes later — SINGLE-EDIT: every unconsumed END left to the exit's flush chain", async () => {
    const { out } = await run(
      'import { spawn } from "node:child_process";\nconst c = spawn("prog", [], { stdio: ["ignore", "ignore", "pipe"] });\nc.stderr?.on("end", () => console.log("err end"));\nc.on("exit", () => console.log("exit"));\n',
      { spawns: [ok(1)], events: [{ at: 1, handle: 1, kind: END, a: 2 }, { at: 5, handle: 1, kind: 1, a: 0 }] },
    );
    expect(out.stdout).toBe("err end\nexit\n");
  });
  test("U3-FH-07 RELEASE waits for the EXIT and every stream's END; until the last END a delivered exit still holds the loop (+Infinity: the drive waits for the next event) — SINGLE-EDIT: RELEASE sent at the exit", async () => {
    const { out, trace } = await run(PIPE_OUT, {
      spawns: [ok(1)],
      events: [{ at: 1, handle: 1, kind: 1, a: 0 }, { at: 9, handle: 1, kind: DATA, a: 1, payload: bytes("late") }, { at: 9, handle: 1, kind: END, a: 1 }],
    });
    expect(out.stdout).toBe("exit 0\ndata late\nend\n");
    const ops = nonPoll(trace.ops);
    expect(ops).toEqual(["9:1:1", "8:1"]);
    expect(trace.idles).toBe(2);
  });
  test("U3-FH-08 once listeners and a listener added during an emission, scripted: the once 'data' listener sees only the first chunk, the added one only the second; a once 'end' runs once — SINGLE-EDIT: the once flag ignored", async () => {
    const { out } = await run(
      'import { spawn } from "node:child_process";\nconst c = spawn("prog", [], { stdio: ["ignore", "pipe", "ignore"] });\nlet added = false;\nc.stdout?.once("data", (d: Buffer) => console.log("once", d.toString()));\nc.stdout?.on("data", (d: Buffer) => {\n  console.log("on", d.toString());\n  if (!added) {\n    added = true;\n    c.stdout?.on("data", (e: Buffer) => console.log("added", e.toString()));\n  }\n});\nc.stdout?.once("end", () => console.log("once end"));\nc.on("exit", () => console.log("exit"));\n',
      { spawns: [ok(1)], events: [{ at: 1, handle: 1, kind: DATA, a: 1, payload: bytes("one") }, { at: 2, handle: 1, kind: DATA, a: 1, payload: bytes("two") }, { at: 3, handle: 1, kind: END, a: 1 }, { at: 4, handle: 1, kind: 1, a: 0 }] },
    );
    expect(out.stdout).toBe("once one\non one\non two\nadded two\nonce end\nexit\n");
  });
  test("U3-FH-09 a failed spawn reported later with piped slots: SPAWN answers a handle, 'error' runs on its nextTick, both ENDs end both streams, and RELEASE follows the last; no FLOW-less DATA, no EXIT — SINGLE-EDIT: the failed child's streams never registered in the table", async () => {
    const { out, trace } = await run(
      'import { spawn } from "node:child_process";\nconst c = spawn("nope", [], { stdio: ["ignore", "pipe", "pipe"] });\nc.stdout?.on("end", () => console.log("out end"));\nc.stderr?.on("end", () => console.log("err end"));\nc.on("error", (e) => console.log("error", e.message, c.stdout !== null));\nconsole.log("main done");\n',
      { spawns: [{ answer: 3, errno: -2, disposition: 1, pid: 0 }], events: [{ at: 1, handle: 3, kind: END, a: 1 }, { at: 1, handle: 3, kind: END, a: 2 }] },
    );
    expect(out.stdout).toBe("main done\nerror spawn nope ENOENT true\nout end\nerr end\n");
    expect(nonPoll(trace.ops)).toEqual(["8:3"]);
  });
  test("U3-FH-10 the answer rule with pipes: a failed spawn reported later with a piped slot answering no handle is a host failure trap (and a handle with no piped slot stays one, U2's rule) — SINGLE-EDIT: the pipe arm of the rule dropped", async () => {
    const a = await runToTrap(
      'import { spawn } from "node:child_process";\nconst c = spawn("nope", [], { stdio: ["ignore", "pipe", "ignore"] });\nc.on("error", () => console.log("error"));\nc.stdout?.on("end", () => console.log("end"));\n',
      { spawns: [{ answer: 0, errno: -2, disposition: 1, pid: 0 }] },
    );
    expect(a.out.stderr).toContain("cpCall: host failure");
    const b = await runToTrap(
      'import { spawn } from "node:child_process";\nconst c = spawn("nope", [], { stdio: ["ignore", "ignore", "ignore"] });\nc.on("error", () => console.log("error"));\nconsole.log(c.stdout === null);\n',
      { spawns: [{ answer: 2, errno: -2, disposition: 1, pid: 0 }] },
    );
    expect(b.out.stderr).toContain("cpCall: host failure");
  });
  test("U3-FH-11 records the module cannot read are host failure traps: DATA for a stream with no 'data' listener (never FLOWed), a second END, DATA after END, a slot of 3, b nonzero on DATA, an END with a payload, and a same-scope bit on the last queued event — SINGLE-EDIT: an unFLOWed DATA delivered", async () => {
    const cases: ScriptedEvent[][] = [
      [{ at: 1, handle: 1, kind: DATA, a: 2, payload: [1] }],
      [{ at: 1, handle: 1, kind: END, a: 1 }, { at: 2, handle: 1, kind: END, a: 1 }],
      [{ at: 1, handle: 1, kind: END, a: 1 }, { at: 2, handle: 1, kind: DATA, a: 1, payload: [1] }],
      [{ at: 1, handle: 1, kind: DATA, a: 3, payload: [1] }],
      [{ at: 1, handle: 1, kind: DATA, a: 1, b: 1, payload: [1] }],
      [{ at: 1, handle: 1, kind: END, a: 1, payload: [1] }],
      [{ at: 1, handle: 1, kind: DATA | SAME, a: 1, payload: [1] }],
    ];
    for (const events of cases) {
      const { out } = await runToTrap(
        'import { spawn } from "node:child_process";\nconst c = spawn("prog", [], { stdio: ["ignore", "pipe", "pipe"] });\nc.stdout?.on("data", () => console.log("data"));\nc.on("exit", () => console.log("exit"));\n',
        { spawns: [ok(1)], events },
      );
      expect(out.stderr, JSON.stringify(events)).toContain("cpCall: host failure");
    }
  });
  test("U3-FH-12 a 'data' listener that throws is the program's uncaught exception: the next listener never runs and the program dies — SINGLE-EDIT: the death check after each data listener removed", async () => {
    const { out } = await runToTrap(
      'import { spawn } from "node:child_process";\nconst c = spawn("prog", [], { stdio: ["ignore", "pipe", "ignore"] });\nc.stdout?.on("data", () => {\n  console.log("first");\n  throw new Error("boom in data");\n});\nc.stdout?.on("data", () => console.log("second never"));\n',
      { spawns: [ok(1)], events: [{ at: 1, handle: 1, kind: DATA, a: 1, payload: [1] }] },
    );
    expect(out.stdout).toBe("first\n");
    expect(out.stderr).toContain("boom in data");
  });
  test("U3-FH-13 a FLOW answer other than 0 is a host failure trap — SINGLE-EDIT: FLOW's answer unchecked", async () => {
    const path = await buildProgram(PIPE_OUT);
    const { overrides } = forced({ spawns: [ok(1)] });
    const base = overrides.imports!["cpCall"] as (...a: number[]) => number;
    overrides.imports!["cpCall"] = (op: number, ptr: number, len: number, h: number, which: number): number => (op === 9 ? -1 : base(op, ptr, len, h, which));
    const out = await runWasmToTrap(path, overrides);
    expect(out.stderr).toContain("cpCall: host failure");
  });
  test("U3-FH-14 kind 6 (STREAM-HELD) in the exit's scope: a 'data' listener added in the 'exit' listener gets the held chunk from its resume_ tick, before the exit listener's own nextTick; with none added the chunk is dropped and 'end' still comes from the flushStdio chain — SINGLE-EDIT: held chunks emitted at the poll point", async () => {
    const withListener = await run(
      'import { spawn } from "node:child_process";\nconst c = spawn("prog", [], { stdio: ["ignore", "pipe", "ignore"] });\nc.on("exit", () => {\n  console.log("exit");\n  c.stdout?.on("data", (d: Buffer) => console.log("data", d.toString()));\n  c.stdout?.on("end", () => console.log("end"));\n  process.nextTick(() => console.log("exit tick"));\n});\n',
      { spawns: [ok(1)], events: [{ at: 1, handle: 1, kind: 1 | SAME, a: 0 }, { at: 1, handle: 1, kind: HELD | SAME, a: 1, payload: bytes("hi") }, { at: 1, handle: 1, kind: END, a: 1 }] },
    );
    expect(withListener.out.stdout).toBe("exit\ndata hi\nexit tick\nend\n");
    expect(nonPoll(withListener.trace.ops)).toEqual(["9:1:1", "8:1"]);
    const without = await run(
      'import { spawn } from "node:child_process";\nconst c = spawn("prog", [], { stdio: ["ignore", "pipe", "ignore"] });\nc.stdout?.on("end", () => console.log("end"));\nc.on("exit", () => console.log("exit"));\n',
      { spawns: [ok(1)], events: [{ at: 1, handle: 1, kind: 1 | SAME, a: 0 }, { at: 1, handle: 1, kind: HELD | SAME, a: 1, payload: bytes("hi") }, { at: 1, handle: 1, kind: END, a: 1 }] },
    );
    expect(without.out.stdout).toBe("exit\nend\n");
  });
  test("U3-FH-15 a listener added two ticks after the exit still gets the held chunk (flushStdio's resume_ has not flowed yet); three ticks after, it is gone — SINGLE-EDIT: held chunks emitted by the flush tick instead of resume_", async () => {
    const src = (depth: number): string =>
      'import { spawn } from "node:child_process";\nconst c = spawn("prog", [], { stdio: ["ignore", "pipe", "ignore"] });\nconst add = (): void => {\n  c.stdout?.on("data", (d: Buffer) => console.log("data", d.toString()));\n};\nc.stdout?.on("end", () => console.log("end"));\nc.on("exit", () => {\n  console.log("exit");\n  ' +
      "process.nextTick(() => { ".repeat(depth) + "add(); " + "});".repeat(depth) + "\n});\n";
    const ev: ScriptedEvent[] = [{ at: 1, handle: 1, kind: 1 | SAME, a: 0 }, { at: 1, handle: 1, kind: HELD | SAME, a: 1, payload: bytes("hi") }, { at: 1, handle: 1, kind: END, a: 1 }];
    expect((await run(src(2), { spawns: [ok(1)], events: ev })).out.stdout).toBe("exit\ndata hi\nend\n");
    expect((await run(src(3), { spawns: [ok(1)], events: ev })).out.stdout).toBe("exit\nend\n");
  });
  test("U3-FH-16 kind 6 in a later scope (the stream already flowing since the exit) goes to the listeners present at the poll, or nowhere — SINGLE-EDIT: later held chunks kept for a resume_ that never comes", async () => {
    const { out } = await run(
      'import { spawn } from "node:child_process";\nconst c = spawn("prog", [], { stdio: ["ignore", "pipe", "ignore"] });\nc.stdout?.on("end", () => console.log("end"));\nc.on("exit", () => {\n  console.log("exit");\n  setTimeout(() => {\n    c.stdout?.on("data", (d: Buffer) => console.log("data", d.toString()));\n  }, 5);\n});\n',
      { spawns: [ok(1)], events: [{ at: 1, handle: 1, kind: 1, a: 0 }, { at: 2, handle: 1, kind: HELD, a: 1, payload: bytes("lost") }, { at: 9, handle: 1, kind: HELD, a: 1, payload: bytes("kept") }, { at: 9, handle: 1, kind: END, a: 1 }] },
    );
    expect(out.stdout).toBe("exit\ndata kept\nend\n");
  });
});
