/* #227 — fetch() on the WasmGC tier (fetch.ts, abi.ts `fetch`): the rows
 * the differential harness's fixtures do not reach. FX-01 runs a body
 * larger than the module's first poll buffer through this directory's
 * REAL fetch host (wasm-host.ts over Node's own fetch, a node:http server
 * in this process). FX-02 and FX-03 script the import and evPoll: a
 * failure after the head rejects the body reader with the host's error
 * and cause, and a record out of the contract's shapes is the named trap.
 * Expected lines are inlined; FX-01's is computed from the payload the
 * server sends (Node's answer for the same program, measured). */
import { createServer, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { runWasm, runWasmToTrap } from "./wasm-host.js";
import { fetchErrorRecord, fetchHeadPayload, writeFetchEvent, type FetchHostEvent } from "./wasm-fetch-host.js";

let scratch: string;
let server: Server;
let base = "";
const big = "0123456789abcdef".repeat(4096) + "é";
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "tsinter-wasm-fetch-"));
  server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end(req.url === "/big" ? big : "small");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (addr === null || typeof addr !== "object") throw new Error("no address");
  base = `http://127.0.0.1:${addr.port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(scratch, { recursive: true, force: true });
});

async function build(id: string, src: string): Promise<string> {
  const entry = join(scratch, `${id}.ts`);
  await writeFile(entry, src);
  const res = await compile(entry, { outPath: join(scratch, `${id}.wasm`), outDir: scratch, backend: "wasm", dynamic: false });
  if (!res.ok) throw new Error(`${id} refused: ${res.diagnostics.map((d) => d.message).join(" | ")}`);
  return res.binaryPath;
}

test("FX-01 a body larger than the module's first poll buffer: the module grows the buffer to the length the host asks for and reads the event whole — SINGLE-EDIT: fetch.ts pollHelper's capacity growth", async () => {
  const path = await build(
    "fx01",
    `async function main(): Promise<void> {\n  const r = await fetch(${JSON.stringify(base + "/big")});\n  const t: string = await r.text();\n  console.log(t.length, t.slice(0, 4), t.slice(-2));\n}\nmain();\n`,
  );
  const run = await runWasm(path);
  expect(run.stdout).toBe(`${big.length} 0123 fé\n`);
  expect(run.stderr).toBe("");
  expect(run.exitCode).toBe(0);
}, 60000);

/** A scripted fetch host: START answers handle 1 and queues `events`; the
 * event drive asks onIdle for the next one. */
function scripted(events: FetchHostEvent[]): Parameters<typeof runWasm>[1] {
  let memory: WebAssembly.Memory | null = null;
  const queue: FetchHostEvent[] = [];
  let clock = 0;
  return {
    onInstance: (instance) => {
      memory = instance.exports["memory"] as WebAssembly.Memory;
    },
    onIdle: (now) => (queue.length > 0 ? now : undefined),
    imports: {
      fetch(op: number): number {
        if (op !== 1) throw new Error(`unexpected op ${op}`);
        queue.push(...events);
        return 1;
      },
      evPoll(ptr: number, cap: number): number {
        const ev = queue[0];
        if (ev === undefined) return 0;
        const n = writeFetchEvent(memory!, ptr, cap, ev);
        if (n > 0) queue.shift();
        return n;
      },
      now: (): number => clock++,
    },
  };
}

const failAfterHead = `async function main(): Promise<void> {
  const r = await fetch("http://example.invalid/x");
  console.log("head", r.status, r.ok);
  try {
    const t: string = await r.text();
    console.log("text", t);
  } catch (e) {
    if (e instanceof Error) console.log("body", e.name, e.message);
    const u: unknown = e;
    const c = (u as { cause: { name: string; message: string; code: string } }).cause;
    console.log("cause", c.name, c.message, c.code);
  }
}
main();
`;

test("FX-02 a FAIL after the HEAD rejects the body reader with the host's error, its cause carrying name, message and code (SEMANTICS.md S098 (c)) — SINGLE-EDIT: fetch.ts failFn's after-head arm", async () => {
  const path = await build("fx02", failAfterHead);
  const run = await runWasm(
    path,
    scripted([
      { source: 6, handle: 1, kind: 1, a: 200, b: 0, payload: fetchHeadPayload("OK", "http://example.invalid/x", "basic", []) },
      {
        source: 6,
        handle: 1,
        kind: 3,
        a: 0,
        b: 0,
        payload: fetchErrorRecord(Object.assign(new TypeError("terminated"), { cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }) })),
      },
    ]),
  );
  expect(run.stdout).toBe("head 200 true\nbody TypeError terminated\ncause Error other side closed UND_ERR_SOCKET\n");
  expect(run.exitCode).toBe(0);
}, 60000);

test("FX-03 a host record out of the contract's shapes (a BODY before any HEAD) is the named trap 'fetch: host failure' — SINGLE-EDIT: fetch.ts eventFn's state check", async () => {
  const path = await build("fx03", failAfterHead);
  const run = await runWasmToTrap(path, scripted([{ source: 6, handle: 1, kind: 2, a: 0, b: 0, payload: new Uint8Array([104, 105]) }]));
  expect(run.stdout).toBe("");
  expect(run.stderr).toContain("fetch: host failure");
}, 60000);
