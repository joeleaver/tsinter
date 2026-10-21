/* INC-29 U1 — the FORCED-HOST rows for node:net: a real compile()d program
 * run through wasm-host.ts's event drive against a SCRIPTED netCall (each
 * op's answer and reply record) and a SCRIPTED evPoll queue (source 2), on
 * the virtual clock — never a real socket. Each row scripts what the host
 * hands back and asserts what the module makes of it, or records what the
 * module asks and asserts that. Handles, ports and addresses are
 * deliberately not a real host's. Rows that open real sockets live in
 * tests/harness/wasm-differential.test.ts. Every row names the single edit
 * that would make it fail. */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { runWasm, runWasmToTrap, type HostOverrides, type HostRun } from "./wasm-host.js";

let scratch: string;
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "tsinter-wasm-host-net-u1-"));
});
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

let seq = 0;
async function buildProgram(src: string, ext = "ts"): Promise<string> {
  const file = join(scratch, `p${seq++}.${ext}`);
  await writeFile(file, src);
  const res = await compile(file, { outPath: `${file}.wasm`, outDir: scratch, dynamic: false, backend: "wasm" });
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message} (${res.diagnostics[0]?.code})`);
  return res.binaryPath;
}

/* The ops and kinds (abi.ts netCall, evPoll source 2). */
const ACCEPT = 1;
const CONNECT = 2;
const DATA = 3;
const EOF = 4;
const READ_ERROR = 5;
const WRITE_DONE = 6;

const RESOLVE_DONE = 8;

/** One scripted event, deliverable once the drive's clock reaches `at`. */
interface ScriptedEvent {
  at: number;
  source?: number;
  handle: number;
  kind: number;
  a?: number;
  payload?: number[];
  /** The host's poll phase ends just before this event (it was read in a
   * later host iteration): delivered at the module's next poll. */
  nextPhase?: boolean;
}

/** One LISTEN answer: the handle (or -errno with the failing stage). */
interface ListenReply {
  answer: number;
  stage?: number;
  port?: number;
}

interface Script {
  listens?: ListenReply[];
  connects?: number[];
  resolves?: number[];
  writes?: number[];
  shutdowns?: number[];
  events?: ScriptedEvent[];
}

interface Trace {
  /** Every netCall, in order, as a short line. */
  ops: string[];
}

function run16(dv: DataView, off: number): { text: string; next: number } {
  const n = dv.getUint32(off, true);
  let text = "";
  for (let i = 0; i < n; i++) text += String.fromCharCode(dv.getUint16(off + 4 + 2 * i, true));
  return { text, next: off + 4 + ((2 * n + 3) & ~3) };
}

function runBytes(s: string): number[] {
  const out = [s.length & 0xff, (s.length >> 8) & 0xff, 0, 0];
  for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i) & 0xff, s.charCodeAt(i) >> 8);
  while (out.length % 4 !== 0) out.push(0);
  return out;
}

function u32(v: number): number[] {
  return [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff];
}

/** ACCEPT's / CONNECT's peer payload. */
function peer(family: number, port: number, address: string): number[] {
  return [...u32(family), ...u32(port), ...runBytes(address)];
}

/** RESOLVE_DONE's payload. */
function addrs(list: [number, string][]): number[] {
  return [...u32(list.length), ...list.flatMap(([f, a]) => [...u32(f), ...runBytes(a)])];
}

function bytes(s: string): number[] {
  return [...Buffer.from(s, "utf8")];
}

/** The scripted host. Unscripted answers: LISTEN succeeds (handles from
 * 100, port 4321, the request's own family and address), CONNECT answers
 * handles from 200, RESOLVE from 300, WRITE 0 (done), SHUTDOWN 0
 * (pending), everything else 0. evPoll serves `events` whose time has
 * come, oldest first, with abi.ts's short-buffer answer; the drive's
 * +Infinity jumps to the next event's time. */
function forced(script: Script): { overrides: HostOverrides; trace: Trace } {
  let memory: WebAssembly.Memory | null = null;
  let clock = 0;
  const listens = [...(script.listens ?? [])];
  const connects = [...(script.connects ?? [])];
  const resolves = [...(script.resolves ?? [])];
  const writes = [...(script.writes ?? [])];
  const shutdowns = [...(script.shutdowns ?? [])];
  const events = [...(script.events ?? [])];
  const trace: Trace = { ops: [] };
  let nextListen = 100;
  let nextConnect = 200;
  let nextResolve = 300;
  const imports: Record<string, unknown> = {
    netCall(op: number, ptr: number, len: number, h: number, x: number): number {
      const dv = new DataView(memory!.buffer);
      switch (op) {
        case 1: {
          const port = dv.getUint32(ptr, true);
          const family = dv.getUint32(ptr + 4, true);
          const flags = dv.getUint32(ptr + 8, true);
          const backlog = dv.getUint32(ptr + 12, true);
          const { text: address } = run16(dv, ptr + 16);
          trace.ops.push(`listen ${address}:${port}/${family} flags=${flags} backlog=${backlog}`);
          const r = listens.shift() ?? { answer: nextListen++ };
          dv.setUint32(ptr, r.answer > 0 ? 0 : (r.stage ?? 2), true);
          dv.setUint32(ptr + 4, r.port ?? 4321, true);
          dv.setUint32(ptr + 8, family, true);
          new Uint8Array(memory!.buffer, ptr + 12).set(runBytes(address));
          return r.answer;
        }
        case 2: {
          const port = dv.getUint32(ptr, true);
          const family = dv.getUint32(ptr + 4, true);
          const { text: address } = run16(dv, ptr + 8);
          trace.ops.push(`connect ${address}:${port}/${family}`);
          return connects.shift() ?? nextConnect++;
        }
        case 3:
          trace.ops.push(`start ${h}`);
          return 0;
        case 4:
          trace.ops.push(`stop ${h}`);
          return 0;
        case 5:
          trace.ops.push(`write ${h} ${JSON.stringify(Buffer.from(new Uint8Array(memory!.buffer, ptr, len)).toString("utf8"))}`);
          return writes.shift() ?? 0;
        case 6:
          trace.ops.push(`shutdown ${h}`);
          return shutdowns.shift() ?? 0;
        case 7:
          trace.ops.push(`close ${h}`);
          return 0;
        case 8:
          trace.ops.push(`nodelay ${h} ${x}`);
          return 0;
        case 9: {
          const family = dv.getUint32(ptr, true);
          const hints = dv.getUint32(ptr + 4, true);
          const { text: name } = run16(dv, ptr + 8);
          trace.ops.push(`resolve ${name}/${family}/${hints}`);
          return resolves.shift() ?? nextResolve++;
        }
        default:
          throw new Error(`forced host: netCall op ${op}`);
      }
    },
    evPoll(ptr: number, cap: number): number {
      const ev = events[0];
      if (ev === undefined || ev.at > clock) return 0;
      // abi.ts evPoll: a host ends a poll phase at its own iteration
      // boundary; `nextPhase` scripts one before this event.
      if (ev.nextPhase === true) {
        ev.nextPhase = false;
        return 0;
      }
      const payload = ev.payload ?? [];
      const need = 24 + payload.length;
      if (cap < need) return -need;
      events.shift();
      const dv = new DataView(memory!.buffer, ptr, need);
      dv.setUint32(0, ev.source ?? 2, true);
      dv.setUint32(4, ev.handle, true);
      dv.setUint32(8, ev.kind, true);
      dv.setUint32(12, payload.length, true);
      dv.setInt32(16, ev.a ?? 0, true);
      dv.setInt32(20, 0, true);
      new Uint8Array(memory!.buffer, ptr + 24, payload.length).set(payload);
      return need;
    },
    now: (): number => clock,
  };
  const overrides: HostOverrides = {
    imports,
    onInstance: (instance) => {
      memory = instance.exports["memory"] as WebAssembly.Memory;
    },
    onIdle: () => events[0]?.at,
    onJump: (to) => {
      clock = to;
    },
  };
  return { overrides, trace };
}

async function run(src: string, script: Script, ext = "ts"): Promise<{ out: HostRun; trace: Trace }> {
  const path = await buildProgram(src, ext);
  const { overrides, trace } = forced(script);
  const out = await runWasm(path, overrides);
  return { out, trace };
}

async function runToTrap(src: string, script: Script, ext = "ts"): Promise<{ out: HostRun; trace: Trace }> {
  const path = await buildProgram(src, ext);
  const { overrides, trace } = forced(script);
  const out = await runWasmToTrap(path, overrides);
  return { out, trace };
}

/** A server that logs its connections' data and end, and its own close. */
const ECHO_SERVER =
  'import * as net from "node:net";\nconst s = net.createServer((sock) => {\n  console.log("connection", sock.remoteAddress);\n  sock.on("data", (d: Buffer) => console.log("data", JSON.stringify(d.toString())));\n  sock.on("end", () => console.log("end"));\n  sock.on("finish", () => console.log("finish"));\n  sock.on("close", () => {\n    console.log("close");\n    s.close();\n  });\n});\ns.listen(0, () => console.log("listening", s.address().port));\nsetImmediate(() => console.log("immediate"));\n';

describe("INC-29 U1 node:net — forced-host rows", () => {
  test("N1-FH-01 a listen with no host asks for '::' (family 6, backlog 511) and answers the bound port; 'listening' on a nextTick, before an immediate — SINGLE-EDIT: the bound port read from the request instead of the reply", async () => {
    const src = 'import * as net from "node:net";\nconst s = net.createServer();\ns.listen(0, () => {\n  console.log("listening", s.address().port);\n  s.close(() => console.log("closed"));\n});\nsetImmediate(() => console.log("immediate"));\n';
    const { out, trace } = await run(src, { listens: [{ answer: 7, port: 5555 }] });
    expect(trace.ops).toEqual(["listen :::0/6 flags=0 backlog=511", "close 7"]);
    expect(out.stdout).toBe("listening 5555\nclosed\nimmediate\n");
  });
  test("N1-FH-02 a '::' bind failure falls back to '0.0.0.0' (family 4); a listen-stage failure does not — SINGLE-EDIT: the fallback taken on a listen-stage failure", async () => {
    const src = 'import * as net from "node:net";\nconst s = net.createServer();\ns.on("error", (e) => console.log("error", e.message, (e as NodeJS.ErrnoException).code));\ns.listen(8080, () => {\n  console.log("listening", s.address().port);\n  s.close();\n});\n';
    const a = await run(src, { listens: [{ answer: -97, stage: 1 }, { answer: 9, port: 8080 }] });
    expect(a.trace.ops).toEqual(["listen :::8080/6 flags=0 backlog=511", "listen 0.0.0.0:8080/4 flags=0 backlog=511", "close 9"]);
    expect(a.out.stdout).toBe("listening 8080\n");
    const b = await run(src, { listens: [{ answer: -98, stage: 2 }] });
    expect(b.trace.ops).toEqual(["listen :::8080/6 flags=0 backlog=511"]);
    expect(b.out.stdout).toBe("error listen EADDRINUSE: address already in use :::8080 EADDRINUSE\n");
  });
  test("N1-FH-03 a listen-stage failure on an IP host names that host (UVExceptionWithHostPort; port 0 shows none); an unknown errno renders libuv's 'unknown error' — SINGLE-EDIT: the port shown when it is 0", async () => {
    const src = 'import * as net from "node:net";\nfunction listen(port: number, host: string): void {\n  const s = net.createServer();\n  s.on("error", (e) => console.log("error", e.message, (e as NodeJS.ErrnoException).code));\n  s.listen(port, host);\n}\nlisten(0, "127.0.0.1");\nlisten(99, "::1");\n';
    const { out, trace } = await run(src, { listens: [{ answer: -13, stage: 1 }, { answer: -4000, stage: 2 }] });
    expect(trace.ops).toEqual(["listen 127.0.0.1:0/4 flags=0 backlog=511", "listen ::1:99/6 flags=0 backlog=511"]);
    expect(out.stdout).toBe("error listen EACCES: permission denied 127.0.0.1 EACCES\nerror listen Unknown system error -4000: unknown error ::1:99 Unknown system error -4000\n");
  });
  test("N1-FH-04 isIP: an IP literal listens at once with its own family (on lookup's nextTick), anything else is a RESOLVE — exactly Node's net.isIP over the same strings — SINGLE-EDIT: the IPv6 '::' count limit off by one", async () => {
    const hosts = [
      "127.0.0.1", "0.0.0.0", "255.255.255.255", "256.1.1.1", "1.2.3", "1.2.3.4.5", "01.2.3.4", "1.2.3.04", "1.2.3.4 ", " 1.2.3.4", "1..3.4",
      "::", "::1", "1::", "1::2", "1:2:3:4:5:6:7:8", "1:2:3:4:5:6:7:8:9", "1:2:3:4:5:6:7::", "::1:2:3:4:5:6:7", "::1:2:3:4:5:6:7:8",
      "1:::2", ":1", "1:", "1::2:", "::ffff:1.2.3.4", "1:2:3:4:5:6:1.2.3.4", "1:2:3:4:5:6:7:1.2.3.4", "1:2:3:4:5::1.2.3.4", "1:2:3:4:5:6::1.2.3.4",
      "1.2.3.4::", "::1.2.3.4:1", "fe80::1%eth0", "fe80::1%", "fe80::1%e%0", "fe80::1%a:b.c-d", "12345::", "abcd::ef01", "ABCD::EF01", "g::1",
      "localhost", "example.com", "", "1:2:3:4:5:6:7:8%z", "::%1",
    ];
    const src = `import * as net from "node:net";\nconst hosts: string[] = ${JSON.stringify(hosts.filter((h) => h !== ""))};\nconst servers: net.Server[] = [];\nfor (const h of hosts) {\n  const s = net.createServer();\n  s.on("error", () => {});\n  s.listen(0, h);\n  servers.push(s);\n}\nsetTimeout(() => {\n  for (const s of servers) s.close();\n}, 5);\n`;
    // One failed lookup answer per name Node itself would look up (a module
    // that disagrees asks for a different number of lookups, and fails).
    const resolveEvents: ScriptedEvent[] = [];
    const names = hosts.filter((h) => h !== "" && isIP(h) === 0);
    for (let i = 0; i < names.length; i++) resolveEvents.push({ at: 1, handle: 300 + i, kind: RESOLVE_DONE, a: -3008 });
    const { trace } = await run(src, { events: resolveEvents });
    const resolved = new Set(trace.ops.filter((o) => o.startsWith("resolve ")).map((o) => o.slice(8, o.indexOf("/0/0"))));
    const listened = new Map(
      trace.ops
        .filter((o) => o.startsWith("listen "))
        .map((o) => {
          const m = /^listen (.*):0\/(\d) /.exec(o)!;
          return [m[1]!, Number(m[2])] as const;
        }),
    );
    for (const h of hosts.filter((x) => x !== "")) {
      const got = resolved.has(h) ? 0 : listened.get(h);
      expect(got, h).toBe(isIP(h));
    }
  });
  test("N1-FH-05 an ACCEPT is 'connection' with the payload's peer; the constructor's read(0) starts reading; DATA chunks keep their boundaries; EOF is 'end', then the write side ends (SHUTDOWN, completed in the next pending pass), 'finish', the destroy (CLOSE) and 'close' in the closing phase — SINGLE-EDIT: allowHalfOpen read as true", async () => {
    const { out, trace } = await run(ECHO_SERVER, {
      listens: [{ answer: 7, port: 5555 }],
      events: [
        { at: 1, handle: 7, kind: ACCEPT, a: 8, payload: peer(4, 40000, "10.9.8.7") },
        { at: 2, handle: 8, kind: DATA, payload: bytes("ab") },
        { at: 2, handle: 8, kind: DATA, payload: bytes("cd") },
        { at: 3, handle: 8, kind: EOF },
      ],
    });
    expect(out.stdout).toBe('listening 5555\nimmediate\nconnection 10.9.8.7\ndata "ab"\ndata "cd"\nend\nfinish\nclose\n');
    expect(trace.ops).toEqual(["listen :::0/6 flags=0 backlog=511", "start 8", "shutdown 8", "close 8", "close 7"]);
  });
  test("N1-FH-06 a WRITE the host takes at once completes on the next tick; one it answers pending completes at its WRITE_DONE — SINGLE-EDIT: a pending write treated as done", async () => {
    const src = "'use strict';\nconst net = require('net');\nfunction wrap(fn) { return function () { return fn.apply(this, arguments); }; }\nconst c = net.connect(80, '10.0.0.1');\nconst s = wrap(function (x) { return x; })(c);\nc.on('connect', function () {\n  s.write('one', function (err) { console.log('cb one', err); });\n  s.write('two', function (err) { console.log('cb two', err); c.destroy(); });\n  process.nextTick(function () { console.log('tick'); });\n});\nc.on('error', function (e) { console.log('error', e.message); });\n";
    const { out, trace } = await run(src, {
      writes: [0, 1],
      events: [
        { at: 1, handle: 200, kind: CONNECT, payload: peer(4, 80, "10.0.0.1") },
        { at: 5, handle: 200, kind: WRITE_DONE },
      ],
    }, "cjs");
    // The writes come from the 'connect' listener, before afterConnect's
    // own read(0) starts the reads.
    expect(trace.ops.slice(0, 4)).toEqual(["connect 10.0.0.1:80/4", 'write 200 "one"', 'write 200 "two"', "start 200"]);
    expect(out.stdout).toBe("cb one null\ntick\ncb two null\n");
  });
  test("N1-FH-07 a failed WRITE_DONE is 'error' (write EPIPE, code EPIPE) and the destroy — SINGLE-EDIT: the write status ignored", async () => {
    const src = 'import * as net from "node:net";\nconst c = net.connect(80, "10.0.0.1", () => c.write("x"));\nc.on("error", (e) => console.log("error", e.message, (e as NodeJS.ErrnoException).code));\nc.on("close", () => console.log("close", c.destroyed));\n';
    const { out, trace } = await run(src, {
      writes: [1],
      events: [
        { at: 1, handle: 200, kind: CONNECT, payload: peer(4, 80, "10.0.0.1") },
        { at: 2, handle: 200, kind: WRITE_DONE, a: -32 },
      ],
    });
    expect(out.stdout).toBe("error write EPIPE EPIPE\nclose true\n");
    expect(trace.ops).toContain("close 200");
  });
  test("N1-FH-08 a failed CONNECT_DONE is 'error' (connect ECONNREFUSED <address>:<port>), then 'close'; a READ_ERROR is 'error' (read ECONNRESET) — SINGLE-EDIT: the attempt's address taken from the host's peer payload", async () => {
    const src = 'import * as net from "node:net";\nfor (const port of [80, 81]) {\n  const c = net.connect(port, "10.1.2.3");\n  c.on("error", (e) => console.log(port, "error", e.message, (e as NodeJS.ErrnoException).code));\n  c.on("close", () => console.log(port, "close"));\n}\n';
    const { out } = await run(src, {
      events: [
        { at: 1, handle: 200, kind: CONNECT, a: -111 },
        { at: 2, handle: 201, kind: CONNECT, payload: peer(4, 81, "10.1.2.3") },
        { at: 3, handle: 201, kind: READ_ERROR, a: -104 },
      ],
    });
    expect(out.stdout).toBe("80 error connect ECONNREFUSED 10.1.2.3:80 ECONNREFUSED\n80 close\n81 error read ECONNRESET ECONNRESET\n81 close\n");
  });
  test("N1-FH-09 a lookup asks getaddrinfo with ADDRCONFIG (32); its failures read getaddrinfo ENOTFOUND <host> (EAI_NONAME and EAI_NODATA) and getaddrinfo EAI_AGAIN <host> — SINGLE-EDIT: EAI_NODATA left as its own name", async () => {
    const src = 'import * as net from "node:net";\nfor (const host of ["no.such.host", "nodata.host", "flaky.host"]) {\n  const c = net.connect(80, host);\n  c.on("error", (e) => console.log("error", e.message, (e as NodeJS.ErrnoException).code));\n}\n';
    const { out, trace } = await run(src, {
      events: [
        { at: 1, handle: 300, kind: RESOLVE_DONE, a: -3008 },
        { at: 1, handle: 301, kind: RESOLVE_DONE, a: -3007 },
        { at: 1, handle: 302, kind: RESOLVE_DONE, a: -3001 },
      ],
    });
    expect(trace.ops).toEqual(["resolve no.such.host/0/32", "resolve nodata.host/0/32", "resolve flaky.host/0/32"]);
    expect(out.stdout).toBe("error getaddrinfo ENOTFOUND no.such.host ENOTFOUND\nerror getaddrinfo ENOTFOUND nodata.host ENOTFOUND\nerror getaddrinfo EAI_AGAIN flaky.host EAI_AGAIN\n");
  });
  test("N1-FH-10 several addresses are tried one after another, the families alternating from the first's; each failed attempt's handle is closed before the next; all failing is an AggregateError (empty message, the first error's code) — SINGLE-EDIT: the families not alternated", async () => {
    const src = 'import * as net from "node:net";\nconst c = net.connect(80, "multi.host");\nc.on("error", (e) => console.log("error", e.name, JSON.stringify(e.message), (e as NodeJS.ErrnoException).code));\nc.on("close", () => console.log("close"));\n';
    const { out, trace } = await run(src, {
      events: [
        { at: 1, handle: 300, kind: RESOLVE_DONE, payload: addrs([[6, "::1"], [6, "::2"], [4, "127.0.0.1"], [6, "::1"]]) },
        { at: 2, handle: 200, kind: CONNECT, a: -111 },
        { at: 3, handle: 201, kind: CONNECT, a: -101 },
        { at: 4, handle: 202, kind: CONNECT, a: -111 },
      ],
    });
    expect(trace.ops).toEqual(["resolve multi.host/0/32", "connect ::1:80/6", "close 200", "connect 127.0.0.1:80/4", "close 201", "connect ::2:80/6", "close 202"]);
    expect(out.stdout).toBe('error AggregateError "" ECONNREFUSED\nclose\n');
  });
  test("N1-FH-11 a later address that connects ends the attempts: 'connect' with that address as remoteAddress — SINGLE-EDIT: the failed attempt's handle kept for the socket", async () => {
    const src = 'import * as net from "node:net";\nconst c = net.connect(80, "multi.host", () => {\n  console.log("connect", c.remoteAddress);\n  c.destroy();\n});\n';
    const { out, trace } = await run(src, {
      events: [
        { at: 1, handle: 300, kind: RESOLVE_DONE, payload: addrs([[6, "::1"], [4, "127.0.0.1"]]) },
        { at: 2, handle: 200, kind: CONNECT, a: -111 },
        { at: 3, handle: 201, kind: CONNECT, payload: peer(4, 80, "127.0.0.1") },
      ],
    });
    expect(out.stdout).toBe("connect 127.0.0.1\n");
    expect(trace.ops).toEqual(["resolve multi.host/0/32", "connect ::1:80/6", "close 200", "connect 127.0.0.1:80/4", "close 201"]);
  });
  test("N1-FH-12 a handle closed in a poll callback runs its close callback in the closing phase: after the check phase's immediate, before a timer of the next iteration — SINGLE-EDIT: the closing phase run before the check phase", async () => {
    const src = 'import * as net from "node:net";\nconst c = net.connect(80, "10.0.0.1", () => {\n  c.destroy();\n  setImmediate(() => console.log("immediate"));\n  setTimeout(() => console.log("timer"), 0);\n  process.nextTick(() => console.log("tick"));\n});\nc.on("close", () => console.log("close"));\n';
    const { out } = await run(src, { events: [{ at: 1, handle: 200, kind: CONNECT, payload: peer(4, 80, "10.0.0.1") }] });
    expect(out.stdout).toBe("tick\nimmediate\nclose\ntimer\n");
  });
  test("N1-FH-13 a full readable buffer (64 KiB, no reader) stops the host's reads (READ_STOP); a 'data' listener's resume starts them again — SINGLE-EDIT: push's answer ignored", async () => {
    const src = 'import * as net from "node:net";\nconst c = net.connect(80, "10.0.0.1");\nlet n = 0;\nsetTimeout(() => {\n  c.on("data", (d: Buffer) => { n += d.length; });\n  c.on("end", () => { console.log("got", n); c.destroy(); });\n}, 50);\n';
    const big = Array.from({ length: 40000 }, (_, i) => 97 + (i % 26));
    const { out, trace } = await run(src, {
      events: [
        { at: 1, handle: 200, kind: CONNECT, payload: peer(4, 80, "10.0.0.1") },
        { at: 2, handle: 200, kind: DATA, payload: big },
        { at: 2, handle: 200, kind: DATA, payload: big },
        { at: 60, handle: 200, kind: DATA, payload: big },
        { at: 60, handle: 200, kind: EOF },
      ],
    });
    expect(trace.ops).toEqual(["connect 10.0.0.1:80/4", "start 200", "stop 200", "start 200", "close 200"]);
    expect(out.stdout).toBe("got 120000\n");
  });
  test("N1-FH-14 setNoDelay before the connect is applied by afterConnect (NODELAY 1); a repeat with the same value sends nothing — SINGLE-EDIT: kSetNoDelay not consulted at connect", async () => {
    const src = 'import * as net from "node:net";\nconst c = net.connect(80, "10.0.0.1");\nc.setNoDelay();\nc.on("connect", () => {\n  c.setNoDelay(true);\n  c.setNoDelay(false);\n  c.destroy();\n});\n';
    const { trace } = await run(src, { events: [{ at: 1, handle: 200, kind: CONNECT, payload: peer(4, 80, "10.0.0.1") }] });
    expect(trace.ops).toEqual(["connect 10.0.0.1:80/4", "nodelay 200 1", "nodelay 200 0", "close 200"]);
  });
  test("N1-FH-15 the checked-dynamic handle's unmodelled members are named Errors, caught: a property read, an event name, destroy(err), a method — SINGLE-EDIT: an unmodelled property answering undefined", async () => {
    const src = "'use strict';\nconst net = require('net');\nfunction wrap(fn) { return function () { return fn.apply(this, arguments); }; }\nconst c = net.connect(80, '10.0.0.1');\nconst s = wrap(function (x) { return x; })(c);\nfor (const f of [() => s.remotePort, () => s.on('timeout', function () {}), () => s.destroy(new Error('x')), () => s.ref()]) {\n  try { f(); console.log('ok'); } catch (e) { console.log(e.name, e.message); }\n}\nc.destroy();\n";
    const { out } = await run(src, {}, "cjs");
    expect(out.stdout).toBe(
      "Error reading the property 'remotePort' of a net handle is not supported yet\nError 'on' for the event 'timeout' on a net handle is not supported yet\nError destroy(err) on a net handle is not supported yet\nError 'ref' on a net handle is not supported yet\n",
    );
  });
  test("N1-FH-16 a record the module cannot read is the named trap: a source other than net, an unknown kind, a WRITE answer out of range — SINGLE-EDIT: the source check dropped", async () => {
    const src = 'import * as net from "node:net";\nconst c = net.connect(80, "10.0.0.1", () => c.write("x"));\n';
    for (const script of [
      { events: [{ at: 1, source: 1, handle: 200, kind: CONNECT }] },
      { events: [{ at: 1, handle: 200, kind: 42 }] },
      { writes: [2], events: [{ at: 1, handle: 200, kind: CONNECT, payload: peer(4, 80, "10.0.0.1") }] },
    ] as Script[]) {
      const { out } = await runToTrap(src, script);
      expect(out.stderr).toContain("netCall: host failure");
    }
  });
  test("N1-FH-17 an ACCEPT for a handle the module never opened is the named trap — SINGLE-EDIT: an unknown handle's event dropped silently", async () => {
    const { out } = await runToTrap(ECHO_SERVER, { listens: [{ answer: 7 }], events: [{ at: 1, handle: 99, kind: ACCEPT, a: 8, payload: peer(4, 1, "1.1.1.1") }] });
    expect(out.stderr).toContain("netCall: host failure");
  });
  test("N1-FH-19 an accepted SHUTDOWN completes in the next pending pass, after the poll and before the check phase: 'finish' (with its nextTick) before an immediate queued beside end(), with no event from the host — SINGLE-EDIT: the post-poll pending passes dropped", async () => {
    const src = 'import * as net from "node:net";\nconst c = net.connect(80, "10.0.0.1", () => {\n  c.end();\n  setImmediate(() => console.log("imm"));\n  console.log("connect");\n});\nc.on("finish", () => {\n  console.log("finish");\n  process.nextTick(() => console.log("finish tick"));\n  c.destroy();\n});\nc.on("close", () => console.log("close"));\n';
    const { out, trace } = await run(src, { events: [{ at: 1, handle: 200, kind: CONNECT, payload: peer(4, 80, "10.0.0.1") }] });
    expect(out.stdout).toBe("connect\nfinish\nfinish tick\nimm\nclose\n");
    expect(trace.ops).toEqual(["connect 10.0.0.1:80/4", "shutdown 200", "start 200", "close 200"]);
  });
  test("N1-FH-20 a SHUTDOWN issued from a timer completes in the next iteration's pending pass, before that iteration's poll events — SINGLE-EDIT: the pre-poll pending pass dropped", async () => {
    const src = 'import * as net from "node:net";\nconst c = net.connect(80, "10.0.0.1");\nc.on("connect", () => {\n  setTimeout(() => {\n    console.log("timer");\n    c.end();\n  }, 5);\n});\nc.on("data", (d: Buffer) => console.log("data", d.toString()));\nc.on("finish", () => console.log("finish"));\nc.on("end", () => {\n  console.log("end");\n  c.destroy();\n});\n';
    const { out } = await run(src, {
      events: [
        { at: 1, handle: 200, kind: CONNECT, payload: peer(4, 80, "10.0.0.1") },
        { at: 6, handle: 200, kind: DATA, payload: bytes("x"), nextPhase: true },
        { at: 6, handle: 200, kind: EOF },
      ],
    });
    expect(out.stdout).toBe("timer\nfinish\ndata x\nend\n");
  });
  test("N1-FH-21 a SHUTDOWN answer of 1 is the named trap (uv_shutdown answers 0 or a negative errno); ENOTCONN is Node's synchronous finish — SINGLE-EDIT: an answer of 1 read as done", async () => {
    const src = 'import * as net from "node:net";\nconst c = net.connect(80, "10.0.0.1", () => {\n  c.end();\n  console.log("ended");\n});\nc.on("finish", () => {\n  console.log("finish");\n  c.destroy();\n});\n';
    const ev = [{ at: 1, handle: 200, kind: CONNECT, payload: peer(4, 80, "10.0.0.1") }];
    const { out } = await runToTrap(src, { shutdowns: [1], events: ev });
    expect(out.stderr).toContain("netCall: host failure");
    const ok = await run(src, { shutdowns: [-107], events: ev });
    expect(ok.out.stdout).toBe("ended\nfinish\n");
  });
  test("N1-FH-22 the closing phase runs the handle closed last first (uv__make_close_pending pushes onto the list's head) — SINGLE-EDIT: the closing list walked oldest first", async () => {
    const src = 'import * as net from "node:net";\nconst a = net.connect(80, "10.0.0.1");\nconst b = net.connect(81, "10.0.0.1");\nconst c = net.connect(82, "10.0.0.1");\na.on("close", () => console.log("close a"));\nb.on("close", () => console.log("close b"));\nc.on("close", () => console.log("close c"));\na.destroy();\nb.destroy();\nc.destroy();\n';
    const { out } = await run(src, {});
    expect(out.stdout).toBe("close c\nclose b\nclose a\n");
  });
  test("N1-FH-18 S087 (h): close(cb) on a checked-dynamic server that is not listening is a named Error, where Node hands cb ERR_SERVER_NOT_RUNNING; close() with no callback is not fenced — SINGLE-EDIT: the not-listening fence dropped", async () => {
    const src = "'use strict';\nconst net = require('net');\nfunction wrap(fn) { return function () { return fn.apply(this, arguments); }; }\nconst srv = net.createServer();\nconst s = wrap(function (x) { return x; })(srv);\ntry { s.close(function (e) { console.log('cb', e && e.code); }); console.log('ok'); } catch (e) { console.log(e.name, e.message); }\ns.close();\nconsole.log('closed without cb');\n";
    const { out, trace } = await run(src, {}, "cjs");
    expect(out.stdout).toBe("Error close(cb) while not listening on a net handle is not supported yet\nclosed without cb\n");
    expect(trace.ops).toEqual([]);
  });
});
