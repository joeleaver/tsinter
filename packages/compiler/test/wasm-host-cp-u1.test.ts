/* INC-28 U1 — the FORCED-HOST rows for child_process's synchronous surface:
 * a real compile()d program run against a SCRIPTED `cpCall` (abi.ts), never
 * a real child. Each row scripts the result record the host would hand
 * back (status, signal number, errCode, the two streams' bytes) and asserts
 * what the module makes of it — or records the request the module sends
 * and asserts its fields. The values are deliberately not a real host's:
 * a row that reads the real host and compares to the real host proves
 * nothing (wasm-host-fs-p4.test.ts's rule). Rows that run real children
 * live in tests/harness/wasm-differential.test.ts. Every row names the
 * single edit that would make it fail. */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { compile } from "../src/index.js";

let scratch: string;
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "tsinter-wasm-host-cp-u1-"));
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

/** The request record as the module wrote it (abi.ts layout). */
interface Request {
  stdinMode: number;
  stdoutMode: number;
  stderrMode: number;
  killSignal: number;
  timeoutMs: number;
  maxBufferMode: number;
  file: string;
  argv: string[];
  cwd: string;
  env: [string, string][];
  input: number[];
  len: number;
}

/** One scripted child result, or a negative RUN status. */
interface Scripted {
  hasStatus?: number;
  status?: number;
  signal?: number;
  errCode?: number;
  stdout?: number[];
  stderr?: number[];
}

interface ForcedHost {
  /** Answers each RUN; a number is RUN's own (negative) answer. */
  run?: (req: Request) => Scripted | number;
  /** META's answer override (default 32). */
  metaAnswer?: number;
  /** READ's answer override (default the stream's length). */
  readAnswer?: (which: number, len: number) => number;
  /** Module env served through hostStr/hostNum. */
  env?: [string, string][];
  /** Omit the cpCall import altogether. */
  noCpCall?: boolean;
}

interface ForcedRun {
  stdout: string;
  stderr: string;
  /** Raw bytes per fd, in write order. */
  writes: { fd: number; bytes: number[] }[];
  requests: Request[];
  /** Every cpCall in order, as "op:h" strings. */
  ops: string[];
  trapped: boolean;
}

function decodeRequest(mem: WebAssembly.Memory, ptr: number, len: number): Request {
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
  const inputLen = u32();
  const input: number[] = [];
  for (let i = 0; i < inputLen; i++) input.push(dv.getUint8(off + i));
  return {
    stdinMode: dv.getUint32(0, true),
    stdoutMode: dv.getUint32(4, true),
    stderrMode: dv.getUint32(8, true),
    killSignal: dv.getUint32(12, true),
    timeoutMs: dv.getFloat64(16, true),
    maxBufferMode: dv.getUint32(24, true),
    file,
    argv,
    cwd,
    env,
    input,
    len: off + inputLen,
  };
}

async function runForced(binaryPath: string, host: ForcedHost = {}): Promise<ForcedRun> {
  const writes: { fd: number; bytes: number[] }[] = [];
  const requests: Request[] = [];
  const ops: string[] = [];
  const results = new Map<number, Scripted>();
  let next = 0;
  let memory: WebAssembly.Memory | null = null;
  const env = host.env ?? [];
  const writeUtf16 = (s: string, ptr: number, cap: number): number => {
    if (s.length > cap) return s.length;
    const dv = new DataView(memory!.buffer, ptr, 2 * s.length);
    for (let i = 0; i < s.length; i++) dv.setUint16(2 * i, s.charCodeAt(i), true);
    return s.length;
  };
  const tsinter: Record<string, unknown> = {
    write(fd: number, ptr: number, len: number): void {
      writes.push({ fd, bytes: [...new Uint8Array(memory!.buffer, ptr, len)] });
    },
    now: (): number => 0,
    seed: (): bigint => 0n,
    wallClock: (): number => 0,
    hostStr(kind: number, index: number, ptr: number, cap: number): number {
      if (kind === 0) return index === 0 ? writeUtf16("scriptc", ptr, cap) : index === 1 ? writeUtf16("/forced/module.wasm", ptr, cap) : -1;
      if (kind === 1) return index < env.length ? writeUtf16(env[index]![0], ptr, cap) : -1;
      if (kind === 2) return index < env.length ? writeUtf16(env[index]![1], ptr, cap) : -1;
      if (kind === 3) return writeUtf16("/forced/cwd", ptr, cap);
      if (kind === 4) return writeUtf16("linux", ptr, cap);
      throw new Error(`hostStr: unscripted kind ${kind}`);
    },
    hostNum(kind: number): number {
      if (kind === 0) return 2;
      if (kind === 1) return env.length;
      throw new Error(`hostNum: unscripted kind ${kind}`);
    },
    exit(code: number): void {
      throw new Error(`exit(${code})`);
    },
  };
  if (!host.noCpCall) {
    tsinter["cpCall"] = (op: number, ptr: number, len: number, h: number, which: number): number => {
      ops.push(`${op}:${op === 1 ? "-" : h}`);
      const mem = memory!;
      if (op === 1) {
        const req = decodeRequest(mem, ptr, len);
        requests.push(req);
        const answer = host.run ? host.run(req) : {};
        if (typeof answer === "number") return answer;
        results.set(next, answer);
        return next++;
      }
      const r = results.get(h);
      if (r === undefined) throw new Error(`cpCall: unknown handle ${h}`);
      if (op === 2) {
        const dv = new DataView(mem.buffer, ptr, 32);
        dv.setUint32(0, r.hasStatus ?? 1, true);
        dv.setFloat64(4, r.status ?? 0, true);
        dv.setUint32(12, r.signal ?? 0, true);
        dv.setInt32(16, r.errCode ?? 0, true);
        dv.setUint32(20, (r.stdout ?? []).length, true);
        dv.setUint32(24, (r.stderr ?? []).length, true);
        dv.setUint32(28, 0, true);
        return host.metaAnswer ?? 32;
      }
      if (op === 3) {
        const bytes = which === 1 ? (r.stdout ?? []) : (r.stderr ?? []);
        new Uint8Array(mem.buffer, ptr, bytes.length).set(bytes);
        return host.readAnswer ? host.readAnswer(which, bytes.length) : bytes.length;
      }
      if (op === 4) {
        results.delete(h);
        return 0;
      }
      throw new Error(`cpCall: unknown op ${op}`);
    };
  }
  const { instance } = await WebAssembly.instantiate(await readFile(binaryPath), { tsinter });
  memory = instance.exports["memory"] as WebAssembly.Memory;
  let trapped = false;
  try {
    (instance.exports["_start"] as () => void)();
    const tick = instance.exports["_tick"] as ((now: number) => number) | undefined;
    if (tick !== undefined) {
      let clock = 0;
      for (let turns = 0; ; turns++) {
        if (turns > 100_000) throw new Error("pump did not settle");
        const due = tick(clock);
        if (due < 0) break;
        clock = Math.max(clock, due);
      }
    }
  } catch (err) {
    if (!(err instanceof WebAssembly.RuntimeError)) throw err;
    trapped = true;
  }
  const text = (fd: number): string =>
    Buffer.from(writes.filter((w) => w.fd === fd).flatMap((w) => w.bytes)).toString("utf8");
  return { stdout: text(1), stderr: text(2), writes, requests, ops, trapped };
}

const SHOW_RESULT = `
const show = (r: ReturnType<typeof spawnSync>): void => {
  console.log("status=" + r.status, "signal=" + r.signal, "error=" + (r.error === undefined ? "undefined" : r.error.message), "code=" + (r.error as NodeJS.ErrnoException | undefined)?.code, "out=" + JSON.stringify(r.stdout), "err=" + JSON.stringify(r.stderr));
};
`;

describe("INC-28 U1 child_process — forced-host rows (spawnSync family)", () => {
  test("F-01 cp.spawnSync sends the default header, the file and arguments, no cwd, and the module's OWN environment (a write included, a NUL cut) — SINGLE-EDIT: the env not sent, or the NUL cut removed", async () => {
    const wasm = await buildProgram(
      'import { spawnSync } from "node:child_process";\nprocess.env.ADDED = "w\\u0000x";\nconsole.log(spawnSync("/bin/echo", ["a", "b\\uD800"]).status);\n',
    );
    const r = await runForced(wasm, { env: [["PATH", "/forced/bin"], ["K", "V"]], run: () => ({ hasStatus: 1, status: 0 }) });
    expect(r.requests).toHaveLength(1);
    const q = r.requests[0]!;
    expect([q.stdinMode, q.stdoutMode, q.stderrMode, q.killSignal, q.timeoutMs, q.maxBufferMode]).toEqual([0, 0, 0, 15, 0, 0]);
    expect([q.file, q.argv, q.cwd, q.env, q.input]).toEqual([
      "/bin/echo",
      ["a", "b\uD800"],
      "",
      [
        ["PATH", "/forced/bin"],
        ["K", "V"],
        ["ADDED", "w"],
      ],
      [],
    ]);
    expect(r.stdout).toBe("0\n");
  });

  test("F-02 cp.spawnSyncOpts sends timeout, SIGKILL as 9 and the tuple's modes (stdin 'ignore' reads as pipe, inherit 2, pipe 0) — SINGLE-EDIT: stdoutMode and stderrMode swapped in the writer", async () => {
    const wasm = await buildProgram(
      'import { spawnSync } from "node:child_process";\nconsole.log(spawnSync("x", [], { timeout: 1500, killSignal: "SIGKILL", stdio: ["ignore", "inherit", "pipe"] }).status);\n',
    );
    const r = await runForced(wasm, { run: () => ({ hasStatus: 1, status: 0 }) });
    const q = r.requests[0]!;
    expect([q.stdinMode, q.stdoutMode, q.stderrMode, q.killSignal, q.timeoutMs, q.maxBufferMode]).toEqual([0, 2, 0, 9, 1500, 0]);
  });

  test("F-03 cp.spawnSyncStdioStr maps the runtime string: 'pipe' 0/0/0, 'ignore' 3/1/1 (stdin /dev/null), 'inherit' 2/2/2 — SINGLE-EDIT: 'ignore' mapped to stdin 0", async () => {
    const wasm = await buildProgram(
      'import { spawnSync } from "node:child_process";\nconst run = (s: "pipe" | "ignore" | "inherit") => spawnSync("x", [], { stdio: s, timeout: 5 }).status;\nconsole.log(run("pipe"), run("ignore"), run("inherit"));\n',
    );
    const r = await runForced(wasm, { run: () => ({ hasStatus: 1, status: 0 }) });
    expect(r.requests.map((q) => [q.stdinMode, q.stdoutMode, q.stderrMode, q.timeoutMs])).toEqual([
      [0, 0, 0, 5],
      [3, 1, 1, 5],
      [2, 2, 2, 5],
    ]);
  });

  const codes = [
    "ENOENT",
    "EACCES",
    "EPERM",
    "ENOTDIR",
    "ENOEXEC",
    "ELOOP",
    "ENAMETOOLONG",
    "E2BIG",
    "ENOMEM",
    "EAGAIN",
    "EIO",
    "EINVAL",
    "ETIMEDOUT",
    "EPIPE",
    "ENOBUFS",
  ];
  codes.forEach((code, i) => {
    test(`F-${String(8 + i).padStart(2, "0")} errCode ${i + 1} renders spawnSync's error "spawnSync f ${code}" with code ${code} — SINGLE-EDIT: the module's code table rotated`, async () => {
      const wasm = await buildProgram('import { spawnSync } from "node:child_process";\n' + SHOW_RESULT + 'show(spawnSync("f", [], { encoding: "utf8" }));\n');
      const r = await runForced(wasm, { run: () => ({ hasStatus: 0, errCode: i + 1 }) });
      expect(r.stdout).toBe(`status=null signal=null error=spawnSync f ${code} code=${code} out="" err=""\n`);
    });
  });

  test("F-23 an errno outside the table that libuv names renders Node's name: -(256+18) → EXDEV — SINGLE-EDIT: the errno-name map lookup removed", async () => {
    const wasm = await buildProgram('import { spawnSync } from "node:child_process";\n' + SHOW_RESULT + 'show(spawnSync("f", [], { encoding: "utf8" }));\n');
    const r = await runForced(wasm, { run: () => ({ hasStatus: 0, errCode: -(256 + 18) }) });
    expect(r.stdout).toBe('status=null signal=null error=spawnSync f EXDEV code=EXDEV out="" err=""\n');
  });

  test("F-23b an errno libuv does not name renders Node's 'Unknown system error -<n>': -(256+4000) — SINGLE-EDIT: the unknown text changed", async () => {
    const wasm = await buildProgram('import { spawnSync } from "node:child_process";\n' + SHOW_RESULT + 'show(spawnSync("f", [], { encoding: "utf8" }));\n');
    const r = await runForced(wasm, { run: () => ({ hasStatus: 0, errCode: -(256 + 4000) }) });
    expect(r.stdout).toBe('status=null signal=null error=spawnSync f Unknown system error -4000 code=Unknown system error -4000 out="" err=""\n');
  });

  test("F-24 a status AND an error together (a child that trapped the timeout's signal and exited 7): both are read — SINGLE-EDIT: the status dropped when errCode is set", async () => {
    const wasm = await buildProgram('import { spawnSync } from "node:child_process";\n' + SHOW_RESULT + 'show(spawnSync("f", [], { encoding: "utf8", timeout: 10 }));\n');
    const r = await runForced(wasm, { run: () => ({ hasStatus: 1, status: 7, errCode: 13, stdout: [0x6f] }) });
    expect(r.stdout).toBe('status=7 signal=null error=spawnSync f ETIMEDOUT code=ETIMEDOUT out="o" err=""\n');
  });

  test("F-25 a signal AND an error together (ENOBUFS): status null, signal SIGTERM, error ENOBUFS — SINGLE-EDIT: the signal dropped when errCode is set", async () => {
    const wasm = await buildProgram('import { spawnSync } from "node:child_process";\n' + SHOW_RESULT + 'show(spawnSync("f", [], { encoding: "utf8" }));\n');
    const r = await runForced(wasm, { run: () => ({ hasStatus: 0, signal: 15, errCode: 15 }) });
    expect(r.stdout).toBe('status=null signal=SIGTERM error=spawnSync f ENOBUFS code=ENOBUFS out="" err=""\n');
  });

  test("F-26 every signal number 1..31 is named as Node names it (first os.constants.signals key per number) — SINGLE-EDIT: the signal table shifted by one", async () => {
    const wasm = await buildProgram(
      'import { spawnSync } from "node:child_process";\nconst names: string[] = [];\nfor (let i = 1; i <= 31; i++) names.push(`${spawnSync("f", []).signal}`);\nconsole.log(names.join(" "));\n',
    );
    let n = 0;
    const r = await runForced(wasm, { run: () => ({ hasStatus: 0, signal: ++n }) });
    expect(r.stdout).toBe(
      "SIGHUP SIGINT SIGQUIT SIGILL SIGTRAP SIGABRT SIGBUS SIGFPE SIGKILL SIGUSR1 SIGSEGV SIGUSR2 SIGPIPE SIGALRM SIGTERM SIGSTKFLT SIGCHLD SIGCONT SIGSTOP SIGTSTP SIGTTIN SIGTTOU SIGURG SIGXCPU SIGXFSZ SIGVTALRM SIGPROF SIGWINCH SIGIO SIGPWR SIGSYS\n",
    );
  });

  test("F-27 a negative RUN answer is a named trap, never a result — SINGLE-EDIT: the host-failure check after RUN removed", async () => {
    const wasm = await buildProgram('import { spawnSync } from "node:child_process";\nconsole.log("before");\nconsole.log(spawnSync("f").status);\nconsole.log("after");\n');
    const r = await runForced(wasm, { run: () => -1 });
    expect(r.trapped).toBe(true);
    expect(r.stdout).toBe("before\n");
    expect(r.stderr).toContain("cpCall: host failure");
  });

  test("F-28 a META answer other than 32 and a READ answer other than the stream's length are named traps — SINGLE-EDIT: either check removed", async () => {
    const wasm = await buildProgram('import { spawnSync } from "node:child_process";\nconsole.log(JSON.stringify(spawnSync("f", [], { encoding: "utf8" }).stdout));\n');
    const meta = await runForced(wasm, { metaAnswer: 31, run: () => ({ hasStatus: 1, status: 0 }) });
    expect(meta.trapped).toBe(true);
    expect(meta.stderr).toContain("cpCall: host failure");
    const read = await runForced(wasm, { readAnswer: (_w, len) => len - 1, run: () => ({ hasStatus: 1, status: 0, stdout: [0x61, 0x62] }) });
    expect(read.trapped).toBe(true);
    expect(read.stderr).toContain("cpCall: host failure");
  });

  test("F-29 every RUN is followed by META, a READ per NON-EMPTY stream only, and exactly one FREE; a validation throw makes no RUN at all — SINGLE-EDIT: FREE skipped", async () => {
    const wasm = await buildProgram(
      'import { spawnSync } from "node:child_process";\nspawnSync("a");\nspawnSync("b", [], { encoding: "utf8" });\ntry { spawnSync("c\\u0000"); } catch { console.log("caught"); }\nspawnSync("d", [], { encoding: "utf8" });\n',
    );
    const r = await runForced(wasm, { run: (q) => (q.file === "b" ? { hasStatus: 1, status: 0, stdout: [0x6f], stderr: [0x65] } : { hasStatus: 1, status: 0 }) });
    expect(r.ops).toEqual(["1:-", "2:0", "4:0", "1:-", "2:1", "3:1", "3:1", "4:1", "1:-", "2:2", "4:2"]);
    expect(r.stdout).toBe("caught\n");
  });

  test("F-30 a module reaching child_process fails to instantiate when the host does not supply cpCall: a LinkError naming it (SEMANTICS.md S004) — SINGLE-EDIT: the import made optional", async () => {
    const wasm = await buildProgram('import { spawnSync } from "node:child_process";\nconsole.log(spawnSync("f").status);\n');
    await expect(runForced(wasm, { noCpCall: true })).rejects.toThrow(/cpCall/);
  });

  test("F-31 captured bytes decode as UTF-8 with U+FFFD per maximal subpart; an empty stream reads \"\" — SINGLE-EDIT: the decoder replaced by a byte copy", async () => {
    const wasm = await buildProgram(
      'import { spawnSync } from "node:child_process";\nconst r = spawnSync("f", [], { encoding: "utf8" });\nconst c: number[] = [];\nfor (let i = 0; i < r.stdout.length; i++) c.push(r.stdout.charCodeAt(i));\nconsole.log(r.stdout.length, c.join(","), JSON.stringify(r.stderr));\n',
    );
    const r = await runForced(wasm, { run: () => ({ hasStatus: 1, status: 0, stdout: [0x61, 0xff, 0xc3, 0xa9, 0xe2, 0x82, 0x62] }) });
    expect(r.stdout).toBe('5 97,65533,233,65533,98 ""\n');
  });

  test("F-32 an inherited stream's bytes are written RAW to the module's own fd, right after the child and before the program's next write — SINGLE-EDIT: the inherit write dropped or decoded", async () => {
    const wasm = await buildProgram(
      'import { spawnSync } from "node:child_process";\nconsole.log("p1");\nconst r = spawnSync("f", [], { encoding: "utf8", stdio: ["pipe", "inherit", "inherit"] });\nconsole.log("p2", JSON.stringify(r.stdout), JSON.stringify(r.stderr));\n',
    );
    const r = await runForced(wasm, { run: () => ({ hasStatus: 1, status: 0, stdout: [0xff, 0x0a], stderr: [0x65, 0x0a] }) });
    const stdoutBytes = r.writes.filter((w) => w.fd === 1).flatMap((w) => w.bytes);
    expect(Buffer.from(stdoutBytes).toString("latin1")).toBe('p1\n\xff\np2 "" ""\n');
    expect(r.stderr).toBe("e\n");
  });
});

describe("INC-28 U1 child_process — forced-host rows (exec family)", () => {
  test("F-04 execSync sends /bin/sh -c <command>, the input's UTF-8 bytes (a lone surrogate as EF BF BD), the replacement env uncut, stderr captured with the echo, maxBuffer unbounded — SINGLE-EDIT: the replacement env merged with the module map, or maxBuffer mode 0", async () => {
    const wasm = await buildProgram(
      'import { execSync } from "node:child_process";\nconsole.log(JSON.stringify(execSync("cat", { encoding: "utf8", input: "a\\uD800", env: { R: "1" } })));\n',
    );
    const r = await runForced(wasm, { env: [["PATH", "/forced/bin"]], run: () => ({ hasStatus: 1, status: 0, stdout: [0x6f, 0x6b], stderr: [0x45] }) });
    const q = r.requests[0]!;
    expect([q.stdinMode, q.stdoutMode, q.stderrMode, q.killSignal, q.timeoutMs, q.maxBufferMode]).toEqual([1, 0, 0, 15, 0, 1]);
    expect([q.file, q.argv, q.cwd, q.env, q.input]).toEqual(["/bin/sh", ["-c", "cat"], "", [["R", "1"]], [0x61, 0xef, 0xbf, 0xbd]]);
    expect(r.stdout).toBe('"ok"\n');
    expect(r.stderr).toBe("E");
  });

  test("F-05 execFileSync's stdio modes: 'inherit' on stdin (2), stdout ignored (1), stderr inherited (2), no echo; cwd sent; the module's env when no env option — SINGLE-EDIT: the IR's stdout mode mapped as-is", async () => {
    const wasm = await buildProgram(
      'import { execFileSync } from "node:child_process";\nexecFileSync("f", ["x"], { stdio: ["inherit", "ignore", "inherit"], cwd: "/w", timeout: 7 });\nconsole.log("done");\n',
    );
    const r = await runForced(wasm, { env: [["K", "V"]], run: () => ({ hasStatus: 1, status: 0, stderr: [0x21] }) });
    const q = r.requests[0]!;
    expect([q.stdinMode, q.stdoutMode, q.stderrMode, q.timeoutMs, q.maxBufferMode, q.cwd, q.env]).toEqual([2, 1, 2, 7, 1, "/w", [["K", "V"]]]);
    expect(r.stderr).toBe("!");
    expect(r.stdout).toBe("done\n");
  });

  test("F-06 promisified execFile sends stdin at end-of-file, both outputs captured, maxBuffer unbounded, the cwd, the replacement env — SINGLE-EDIT: maxBuffer mode 0 for the async form", async () => {
    const wasm = await buildProgram(
      'import { execFile } from "node:child_process";\nimport { promisify } from "node:util";\nconst run = promisify(execFile);\nasync function main(): Promise<void> {\n  const { stdout, stderr } = await run("f", ["a"], { cwd: "/c", env: { E: "e" }, timeout: 9 });\n  console.log(stdout, stderr);\n}\nmain();\n',
    );
    const r = await runForced(wasm, { run: () => ({ hasStatus: 1, status: 0, stdout: [0x6f], stderr: [0x65] }) });
    const q = r.requests[0]!;
    expect([q.stdinMode, q.stdoutMode, q.stderrMode, q.killSignal, q.timeoutMs, q.maxBufferMode, q.cwd, q.env, q.argv]).toEqual([0, 0, 0, 15, 9, 1, "/c", [["E", "e"]], ["a"]]);
    expect(r.stdout).toBe("o e\n");
  });

  test("F-07 the echo is written raw to fd 2 before the throw's message is printed — SINGLE-EDIT: the echo moved after the throw", async () => {
    const wasm = await buildProgram(
      'import { execFileSync } from "node:child_process";\ntry {\n  execFileSync("f", [], { encoding: "utf8" });\n} catch (e) {\n  console.error("caught:", e instanceof Error ? e.message : "?");\n}\n',
    );
    const r = await runForced(wasm, { run: () => ({ hasStatus: 1, status: 2, stderr: [0xff, 0x0a] }) });
    const err = Buffer.from(r.writes.filter((w) => w.fd === 2).flatMap((w) => w.bytes));
    // The echo (raw FF), then console.error's line: the message's tail is the
    // DECODED stderr (U+FFFD, written as EF BF BD) and console.error's own
    // newline follows the tail's.
    expect(err.toString("latin1")).toBe("\xff\ncaught: Command failed: f\n\xef\xbf\xbd\n\n");
  });

  test("F-24b the exec family with a status AND an error: execFileSync throws the errno (ETIMEDOUT wins over status 7); the promisified form resolves on status 0 and rejects on 7 — SINGLE-EDIT: the async form treating ETIMEDOUT as an error", async () => {
    const wasm = await buildProgram(
      'import { execFile, execFileSync } from "node:child_process";\nimport { promisify } from "node:util";\nconst run = promisify(execFile);\ntry { execFileSync("f", [], { stdio: "pipe", timeout: 5 }); } catch (e) { console.log("sync:", e instanceof Error ? e.message : "?", `${(e as NodeJS.ErrnoException).code}`); }\nasync function main(): Promise<void> {\n  for (const t of [1, 2]) {\n    try {\n      const { stdout } = await run("g", [], { timeout: t });\n      console.log("async resolved", JSON.stringify(stdout));\n    } catch (e) {\n      if (e instanceof Error) console.log("async rejected", JSON.stringify(e.message));\n    }\n  }\n}\nmain();\n',
    );
    const statuses = [7, 0, 7];
    let k = 0;
    const r = await runForced(wasm, { run: () => ({ hasStatus: 1, status: statuses[k++]!, errCode: 13 }) });
    expect(r.stdout).toBe('sync: spawnSync f ETIMEDOUT ETIMEDOUT\nasync resolved ""\nasync rejected "Command failed: g\\n"\n');
  });

  test("F-23c an errno outside the table through the promisified form renders 'spawn <file> <Node's name>' with code — SINGLE-EDIT: the async message prefix changed", async () => {
    const wasm = await buildProgram(
      'import { execFile } from "node:child_process";\nimport { promisify } from "node:util";\nconst run = promisify(execFile);\nasync function main(): Promise<void> {\n  try { await run("f", []); } catch (e) { if (e instanceof Error) console.log(e.message, `${(e as NodeJS.ErrnoException).code}`); }\n}\nmain();\n',
    );
    const r = await runForced(wasm, { run: () => ({ hasStatus: 0, errCode: -(256 + 18) }) });
    expect(r.stdout).toBe("spawn f EXDEV EXDEV\n");
  });
});
