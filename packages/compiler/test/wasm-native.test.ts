/* The wasm-native lane's host and runner, end to end (native-runner N0
 * review): small programs built with `backend: "wasm-native"` must match
 * the Node oracle where the host decides —
 *  - a path holding U+0000 never reaches a syscall: every fs key throws
 *    Node's TypeError ERR_INVALID_ARG_VALUE (the module's own validation)
 *    and existsSync answers false, so rmSync("d\0x") cannot remove "d" and
 *    writeFileSync("w.txt\0.js") cannot write "w.txt";
 *  - copyFileSync(a, a) leaves the file alone (libuv's same-file check);
 *  - a SIGSEGV the process sends itself kills it as it kills Node (the
 *    runner's fault handler re-raises a signal no access raised);
 *  - (phase N1) the event sources' host keeps nothing the program
 *    released: the runner's WN_FD_AUDIT line after children, pipes,
 *    sockets, watches and signal subscriptions came and went.
 * Each program runs in its own temporary directory, the oracle first. */
import { execFile, execFileSync } from "node:child_process";
import { chmodSync, globSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { compile } from "../src/index.js";

const run = promisify(execFile);

interface Out {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: string | null;
}
async function exec(cmd: string, args: string[], cwd: string): Promise<Out> {
  const p = run(cmd, args, { cwd, encoding: "utf8" });
  p.child.stdin?.end();
  try {
    const r = await p;
    return { stdout: r.stdout, stderr: r.stderr, code: 0, signal: null };
  } catch (e) {
    const x = e as { stdout?: string; stderr?: string; code?: number; signal?: string };
    return { stdout: x.stdout ?? "", stderr: x.stderr ?? "", code: typeof x.code === "number" ? x.code : null, signal: x.signal ?? null };
  }
}

async function both(src: string): Promise<{ node: Out; native: Out }> {
  const dir = mkdtempSync(join(tmpdir(), "tsinter-wasm-native-"));
  try {
    const file = join(dir, "main.ts");
    writeFileSync(file, src);
    const res = await compile(file, { outPath: join(dir, "out", "program"), outDir: join(dir, "out"), backend: "wasm-native" });
    if (!res.ok) throw new Error(res.diagnostics.map((d) => d.message).join("\n"));
    const nodeDir = mkdtempSync(join(dir, "node-"));
    const nativeDir = mkdtempSync(join(dir, "native-"));
    // no core files: a signal death would otherwise spend seconds dumping
    const node = await exec("/bin/sh", ["-c", 'ulimit -c 0; exec "$0" "$1"', process.execPath, file], nodeDir);
    const native = await exec("/bin/sh", ["-c", 'ulimit -c 0; exec "$0"', res.binaryPath], nativeDir);
    return { node, native };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("the wasm-native lane's host, end to end against Node", () => {
  test("a path holding U+0000: every fs key throws Node's ERR_INVALID_ARG_VALUE, existsSync answers false, nothing is touched", async () => {
    const src = `import * as fs from "node:fs";
fs.mkdirSync("d");
fs.writeFileSync("d/keep.txt", "keep");
fs.writeFileSync("a.txt", "a");
const tries: [string, () => unknown][] = [
  ["rmSync", () => fs.rmSync("d\\0junk", { recursive: true, force: true })],
  ["writeFileSync", () => fs.writeFileSync("w.txt\\0.js", "x")],
  ["appendFileSync", () => fs.appendFileSync("w.txt\\0.js", "x")],
  ["readFileSync", () => fs.readFileSync("a.txt\\0", "utf8")],
  ["readdirSync", () => fs.readdirSync("d\\0x")],
  ["mkdirSync", () => fs.mkdirSync("m\\0x")],
  ["mkdtempSync", () => fs.mkdtempSync("t\\0x")],
  ["rmdirSync", () => fs.rmdirSync("d\\0x")],
  ["unlinkSync", () => fs.unlinkSync("a.txt\\0x")],
  ["statSync", () => fs.statSync("a.txt\\0x")],
  ["lstatSync", () => fs.lstatSync("a.txt\\0x")],
  ["realpathSync", () => fs.realpathSync("a.txt\\0x")],
  ["accessSync", () => fs.accessSync("a.txt\\0x")],
  ["chmodSync", () => fs.chmodSync("a.txt\\0x", 0o644)],
  ["copyFileSync src", () => fs.copyFileSync("a.txt\\0x", "b.txt")],
  ["copyFileSync dest", () => fs.copyFileSync("a.txt", "b.txt\\0x")],
  ["openSync", () => fs.openSync("a.txt\\0x", "r")],
];
for (const [name, f] of tries) {
  try {
    f();
    console.log(name, "returned");
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    console.log(name, err.code, err.message);
  }
}
console.log("exists", fs.existsSync("a.txt\\0zz"), fs.existsSync("d"), fs.existsSync("d/keep.txt"), fs.existsSync("w.txt"), fs.existsSync("b.txt"));
`;
    const { node, native } = await both(src);
    expect(node.code).toBe(0);
    expect(native.stdout).toBe(node.stdout);
    expect(native.code).toBe(0);
  });

  test("copyFileSync(a, a) leaves the file as it was (libuv checks for the same file before truncating)", async () => {
    const src = `import * as fs from "node:fs";
fs.writeFileSync("a.txt", "hello world\\n");
fs.copyFileSync("a.txt", "a.txt");
console.log(JSON.stringify(fs.readFileSync("a.txt", "utf8")));
fs.writeFileSync("b.txt", "other");
fs.copyFileSync("a.txt", "b.txt");
console.log(JSON.stringify(fs.readFileSync("b.txt", "utf8")));
`;
    const { node, native } = await both(src);
    expect(native.stdout).toBe(node.stdout);
    expect(native.stdout).toContain("hello world");
  });

  // Two programs: the wasm tier does not build node:net beside an
  // asynchronous spawn in one module (net:with-spawn).
  const auditPrograms: [string, string, string][] = [
    [
      "children (spawnSync and spawn with a piped stdout), watches and signal subscriptions",
      `import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
let syncOk = 0;
for (let i = 0; i < 30; i++) {
  const r = spawnSync("/bin/sh", ["-c", "echo x"]);
  if (r.status === 0 && r.stdout.toString() === "x\\n") syncOk++;
}
console.log("sync", syncOk);
let asyncOk = 0;
function child(n: number): void {
  if (n === 0) {
    console.log("async", asyncOk);
    watchesAndSignals();
    return;
  }
  const c = spawn("/bin/sh", ["-c", "echo y"], { stdio: ["ignore", "pipe", "ignore"] });
  let got = "";
  let ended = false;
  let exited = false;
  const next = (): void => {
    if (!ended || !exited) return;
    if (got === "y\\n") asyncOk++;
    child(n - 1);
  };
  c.stdout?.on("data", (d: Buffer) => {
    got += d.toString();
  });
  c.stdout?.on("end", () => {
    ended = true;
    next();
  });
  c.on("exit", () => {
    exited = true;
    next();
  });
}
function watchesAndSignals(): void {
  fs.writeFileSync("w.txt", "x");
  for (let i = 0; i < 20; i++) {
    const w = fs.watch("w.txt");
    w.close();
  }
  const h = (): void => {};
  for (let i = 0; i < 20; i++) {
    process.on("SIGTERM", h);
    process.off("SIGTERM", h);
  }
  console.log("done");
}
child(30);
`,
      "sync 30\nasync 30\ndone\n",
    ],
    [
      "a server and thirty connections to it",
      `import * as net from "node:net";
const server = net.createServer((s) => {
  s.on("data", (d) => s.end(d));
});
server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  let left = 30;
  let ok = 0;
  const one = (): void => {
    if (left-- === 0) {
      console.log("tcp", ok);
      server.close();
      return;
    }
    const c = net.connect(port, "127.0.0.1", () => {
      c.write("ping");
    });
    c.on("data", (d) => {
      if (d.toString() === "ping") ok++;
    });
    c.on("close", one);
  };
  one();
});
`,
      "tcp 30\n",
    ],
  ];
  for (const [what, src, expected] of auditPrograms) {
    test(`the host keeps nothing the program released — ${what}, each opened and closed many times, leave no descriptor and no registration behind (WN_FD_AUDIT)`, async () => {
      process.env["WN_FD_AUDIT"] = "1";
      try {
        const { node, native } = await both(src);
        expect(node.stdout).toBe(expected);
        expect(native.stdout).toBe(node.stdout);
        expect(native.code).toBe(0);
        expect(native.stderr).toBe("wn-audit: fds 0 live 0 queued 0\n");
      } finally {
        delete process.env["WN_FD_AUDIT"];
      }
    });
  }

  test("board #323: a cached executable that is not whole (empty, not executable, or not what was recorded) is rebuilt, never reused", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tsinter-wasm-native-cache-"));
    const saved = process.env["SCRIPTC_CACHE_DIR"];
    const savedNo = process.env["SCRIPTC_NO_CACHE"];
    process.env["SCRIPTC_CACHE_DIR"] = join(dir, "cas");
    delete process.env["SCRIPTC_NO_CACHE"];
    try {
      const file = join(dir, "main.ts");
      writeFileSync(file, `console.log("cached ${Date.now()}-${Math.random()}");\n`);
      const build = async (): Promise<string> => {
        const res = await compile(file, { outPath: join(dir, "out", "program"), outDir: join(dir, "out"), backend: "wasm-native" });
        if (!res.ok) throw new Error(res.diagnostics.map((d) => d.message).join("\n"));
        return res.binaryPath;
      };
      const first = await build();
      const want = (await exec(first, [], dir)).stdout;
      expect(want).toMatch(/^cached /);
      const entries = globSync(join(dir, "cas", "wnbin", "*", "*")).filter((p) => !p.endsWith(".ok"));
      expect(entries.length).toBe(1);
      const entry = entries[0]!;
      for (const breakIt of [
        () => writeFileSync(entry, ""),
        () => {
          writeFileSync(entry, readFileSync(first).subarray(0, 4096));
          chmodSync(entry, 0o755);
        },
        () => chmodSync(entry, 0o644),
      ]) {
        breakIt();
        const again = await build();
        const r = await exec(again, [], dir);
        expect(r.stdout).toBe(want);
        expect(r.code).toBe(0);
      }
    } finally {
      if (saved === undefined) delete process.env["SCRIPTC_CACHE_DIR"];
      else process.env["SCRIPTC_CACHE_DIR"] = saved;
      if (savedNo !== undefined) process.env["SCRIPTC_NO_CACHE"] = savedNo;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the host keeps nothing the program released — thirty fetches (each a connection, a parser and a request record), and ten refused, leave no descriptor and no registration behind (WN_FD_AUDIT)", async () => {
    const { createServer } = await import("node:http");
    const server = createServer((q, r) => r.end(`ok ${q.url}`));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    const closed = createServer();
    await new Promise<void>((r) => closed.listen(0, "127.0.0.1", r));
    const dead = (closed.address() as { port: number }).port;
    await new Promise<void>((r) => closed.close(() => r()));
    process.env["WN_FD_AUDIT"] = "1";
    try {
      const src = `async function main(): Promise<void> {
  let ok = 0;
  for (let i = 0; i < 30; i++) {
    const r = await fetch("http://127.0.0.1:${port}/" + i);
    if ((await r.text()) === "ok /" + i) ok++;
  }
  let refused = 0;
  for (let i = 0; i < 10; i++) {
    try {
      await fetch("http://127.0.0.1:${dead}/");
    } catch {
      refused++;
    }
  }
  console.log("fetch", ok, refused);
}
main();
`;
      const { node, native } = await both(src);
      expect(node.stdout).toBe("fetch 30 10\n");
      expect(native.stdout).toBe(node.stdout);
      expect(native.code).toBe(0);
      expect(native.stderr).toBe("wn-audit: fds 0 live 0 queued 0\n");
    } finally {
      delete process.env["WN_FD_AUDIT"];
      server.close();
    }
  });

  test("fetch links undici's own parser: the vendored llhttp wasm is the very module this Node's fetch instantiates (lib/llhttp/llhttp-wasm.js)", async () => {
    const { UNDICI_VERSION, UNDICI_LLHTTP_SHA256, undiciLlhttpWasm } = await import("../src/backend/wasm/undici-llhttp.js");
    const { createHash } = await import("node:crypto");
    expect(createHash("sha256").update(undiciLlhttpWasm()).digest("hex")).toBe(UNDICI_LLHTTP_SHA256);
    // the Node the oracle runs: its bundled undici carries the same bytes
    expect(process.versions["undici"]).toBe(UNDICI_VERSION);
    const natives = (process as unknown as { binding(n: string): Record<string, string> }).binding("natives");
    const m = /var require_llhttp_wasm = __commonJS\(\{[\s\S]*?var wasmBase64 = "([A-Za-z0-9+/=]+)"/.exec(natives["internal/deps/undici/undici"] ?? "");
    expect(m).not.toBeNull();
    expect(createHash("sha256").update(Buffer.from(m![1]!, "base64")).digest("hex")).toBe(UNDICI_LLHTTP_SHA256);
  });

  test("a SIGSEGV the process sends itself kills it, as it kills Node", async () => {
    const src = `console.log("before");
process.kill(process.pid, "SIGSEGV");
console.log("after");
`;
    const { node, native } = await both(src);
    expect(node.signal).toBe("SIGSEGV");
    expect(native.signal).toBe(node.signal);
    expect(native.stdout).toBe(node.stdout);
  });
});

/* The cross plumbing (per-target caches and executables, the pinned
 * triple): a Linux target builds through zig cc with its own runner
 * objects; a macOS or Windows target refuses by name — the runner's host
 * is not ported there yet (SEMANTICS.md S118 (b)). One module for every OS:
 * the wasm bytes do not depend on the target. */
describe("the wasm-native lane under a cross target", () => {
  const zig = (() => {
    try {
      execFileSync("zig", ["version"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  })();
  async function withTarget<T>(target: string, body: () => Promise<T>): Promise<T> {
    const prev = [process.env["SCRIPTC_CC"], process.env["SCRIPTC_TARGET"]];
    process.env["SCRIPTC_CC"] = "zigcc";
    process.env["SCRIPTC_TARGET"] = target;
    try {
      return await body();
    } finally {
      if (prev[0] === undefined) delete process.env["SCRIPTC_CC"];
      else process.env["SCRIPTC_CC"] = prev[0];
      if (prev[1] === undefined) delete process.env["SCRIPTC_TARGET"];
      else process.env["SCRIPTC_TARGET"] = prev[1];
    }
  }
  test.skipIf(!zig)("aarch64-linux-gnu links an aarch64 ELF executable; the module is the host build's, byte for byte; macOS and Windows refuse by name", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tsinter-wn-cross-"));
    try {
      const file = join(dir, "main.ts");
      writeFileSync(file, `import * as path from "node:path";\nconsole.log(process.platform, path.join("a", "b"));\n`);
      const host = await compile(file, { outPath: join(dir, "h", "p"), outDir: join(dir, "h"), backend: "wasm-native" });
      if (!host.ok) throw new Error(host.diagnostics.map((d) => d.message).join("\n"));
      const cross = await withTarget("aarch64-linux-gnu.2.36", () => compile(file, { outPath: join(dir, "x", "p"), outDir: join(dir, "x"), backend: "wasm-native" }));
      if (!cross.ok) throw new Error(cross.diagnostics.map((d) => d.message).join("\n"));
      const elf = readFileSync(cross.binaryPath);
      expect(elf.subarray(0, 4)).toEqual(Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
      expect(elf.readUInt16LE(18)).toBe(0xb7); // e_machine EM_AARCH64
      expect(readFileSync(join(dir, "x", "main.wasm"))).toEqual(readFileSync(join(dir, "h", "main.wasm")));
      for (const t of ["aarch64-macos", "x86_64-windows-gnu"]) {
        const r = await withTarget(t, () => compile(file, { outPath: join(dir, t, "p"), outDir: join(dir, t), backend: "wasm-native" }));
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.diagnostics[0]!.message).toMatch(/runner's host is not yet ported to (darwin|win32) .*\(wasm-native:target\)$/);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 600_000);
});
