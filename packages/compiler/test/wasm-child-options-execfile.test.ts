/* child_process option records as values: the promisified execFile.
 * paperclip's command runner (`(cmd, args, options) => execFileAsync(cmd,
 * args, { ...options, encoding: "utf8" })`, its options typed
 * `Parameters<typeof execFileAsync>[2]` — @types/node's ExecFileOptions)
 * and the shapes around it: a literal, a typed record value and a spread
 * with an override; cwd and env; utf8 against Buffer output; the
 * rejection's properties (SEMANTICS.md S134); a timeout's kill; a present
 * AbortSignal, which this build stops at by name.
 *
 * The rows run real children, so they run on the wasm-native lane (the
 * in-process wasm test host scripts cpCall); the wasm lane checks that
 * each row builds. Every row is a project with @types/node, as paperclip
 * is. */
import { describe, test } from "vitest";
import { checkBuilds, checkFenced, checkFencedLine, checkRefuses, checkRow, type Row, scratchDir } from "./top10-paperclip-rows.js";

const scratch = scratchDir("child-options-execfile");

const PRELUDE = `import { execFile, type ExecFileException, type ExecFileOptions } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);`;

/** Prints an exec rejection's message and members (signal only where the
 * caller says Node has one: @types/node types it as a string, and Node's
 * null there is a fenced read). */
const SHOW = `function show(tag: string, e: unknown, withSignal: boolean): void {
  if (!(e instanceof Error)) {
    console.log(tag, "not an error");
    return;
  }
  const x = e as ExecFileException;
  console.log(tag, JSON.stringify(e.message), x.code, x.killed, withSignal ? x.signal : "-", JSON.stringify(String(x.cmd)), JSON.stringify(String(x.stdout)), JSON.stringify(String(x.stderr)));
}`;

const ROWS: Row[] = [
  {
    id: "CO-EF-01 paperclip's CommandRunner: the options parameter spread under an encoding override",
    files: {
      "main.ts": `${PRELUDE}
type CommandRunner = (file: string, args: string[], options?: Parameters<typeof execFileAsync>[2]) => Promise<{ stdout: string; stderr: string }>;
const defaultRunner: CommandRunner = (cmd, args, options) => execFileAsync(cmd, args, { ...options, encoding: "utf8" });
async function main(): Promise<void> {
  console.log(JSON.stringify(await defaultRunner("/bin/sh", ["-c", "pwd; echo err >&2"], { cwd: "/" })));
  console.log(JSON.stringify(await defaultRunner("/bin/echo", ["no", "options"])));
  console.log(JSON.stringify(await defaultRunner("/bin/sh", ["-c", "echo $CO_X"], { env: { PATH: process.env.PATH, CO_X: "from-env" } })));
  console.log(JSON.stringify(await defaultRunner("/bin/echo", ["null"], null)));
  try {
    await defaultRunner("/bin/sh", ["-c", "echo partial; echo why >&2; exit 7"]);
  } catch (e) {
    const x = e as ExecFileException;
    console.log("failed", x.code, JSON.stringify(String(x.stdout)), JSON.stringify(String(x.stderr)), JSON.stringify(String(x.cmd)));
  }
}
main();`,
    },
  },
  {
    id: "CO-EF-02 the same options as a literal, a typed record value, and a spread with an override",
    files: {
      "main.ts": `${PRELUDE}
async function main(): Promise<void> {
  const lit = await execFileAsync("/bin/sh", ["-c", "pwd; echo $CO_Y"], { cwd: "/tmp", env: { CO_Y: "y" }, encoding: "utf8" });
  console.log("literal", JSON.stringify(lit));
  const opts: ExecFileOptions = { cwd: "/tmp", env: { CO_Y: "y" } };
  const val = await execFileAsync("/bin/sh", ["-c", "pwd; echo $CO_Y"], opts);
  console.log("value", typeof val.stdout === "string" ? JSON.stringify(val.stdout) : "buffer");
  const spread = await execFileAsync("/bin/sh", ["-c", "pwd; echo $CO_Y"], { ...opts, cwd: "/", encoding: "utf8" });
  console.log("spread", JSON.stringify(spread));
  const over = await execFileAsync("/bin/sh", ["-c", "echo $CO_Y"], { ...opts, env: { CO_Y: "overridden" }, encoding: "utf8" });
  console.log("override", JSON.stringify(over.stdout));
}
main();`,
    },
  },
  {
    id: "CO-EF-03 cwd (a string and a file: URL, a non-file URL rejecting) and env (a process.env spread, undefined entries dropped)",
    files: {
      "main.ts": `${PRELUDE}
async function main(): Promise<void> {
  const env: NodeJS.ProcessEnv = { ...process.env, CO_A: "a", CO_B: undefined };
  const o: ExecFileOptions = { env, cwd: "/" };
  const r = await execFileAsync("/bin/sh", ["-c", "echo \${CO_A-unset} \${CO_B-unset}; pwd"], { ...o, encoding: "utf8" });
  console.log(JSON.stringify(r.stdout));
  const u = await execFileAsync("/bin/pwd", [], { ...o, cwd: new URL("file:///tmp"), encoding: "utf8" });
  console.log(JSON.stringify(u.stdout));
  try {
    await execFileAsync("/bin/pwd", [], { ...o, cwd: new URL("https://example.invalid/tmp") });
  } catch (e) {
    console.log((e as NodeJS.ErrnoException).code, e instanceof Error ? e.message : "?");
  }
  try {
    await execFileAsync("/bin/pwd", [], { ...o, cwd: "/nonexistent-co-dir" });
  } catch (e) {
    console.log((e as NodeJS.ErrnoException).code, e instanceof Error ? e.message : "?");
  }
}
main();`,
    },
  },
  {
    id: "CO-EF-04 encoding utf8 against Buffer output (literal, value, union-typed result, invalid UTF-8 bytes)",
    files: {
      "main.ts": `${PRELUDE}
async function main(): Promise<void> {
  const cmd = ["-c", "printf 'h\\\\303\\\\251\\\\377'; printf 'e\\\\303\\\\251' >&2"];
  const b = await execFileAsync("/bin/sh", cmd, { encoding: "buffer" });
  console.log("buffer", b.stdout.length, Array.from(b.stdout).join(","), b.stderr.toString("hex"));
  const s = await execFileAsync("/bin/sh", cmd, { encoding: "utf8" });
  console.log("utf8", JSON.stringify(s.stdout), s.stdout.length, JSON.stringify(s.stderr));
  const asNull: ExecFileOptions = { encoding: null };
  const n = await execFileAsync("/bin/sh", cmd, asNull);
  console.log("null", typeof n.stdout === "string" ? "string" : Array.from(n.stdout).join(","));
  const plain: ExecFileOptions = {};
  const d = await execFileAsync("/bin/sh", cmd, plain);
  console.log("default", typeof d.stdout === "string" ? JSON.stringify(d.stdout) : "buffer");
  try {
    await execFileAsync("/bin/sh", ["-c", "printf 'o\\\\377'; printf 'x\\\\303\\\\251' >&2; exit 2"], { encoding: "buffer" });
  } catch (e) {
    const x = e as ExecFileException;
    console.log("failed", JSON.stringify(x.message), x.code);
  }
}
main();`,
    },
  },
  {
    id: "CO-EF-05 the rejections' shape: an exit status, a signal death, a spawn failure, an unknown kill signal",
    files: {
      "main.ts": `${PRELUDE}
${SHOW}
async function main(): Promise<void> {
  const o: ExecFileOptions = { cwd: "/" };
  try {
    await execFileAsync("/bin/sh", ["-c", "echo out; echo err >&2; exit 3"], o);
  } catch (e) {
    show("exit", e, false);
  }
  try {
    await execFileAsync("/bin/sh", ["-c", "echo out; kill -INT $$"], { ...o, encoding: "utf8" });
  } catch (e) {
    show("sigint", e, true);
  }
  try {
    await execFileAsync("co-no-such-binary", ["a", "b"], o);
  } catch (e) {
    show("enoent", e, false);
  }
  try {
    await execFileAsync("/bin/echo", [], { ...o, killSignal: "SIGNOPE" as NodeJS.Signals });
  } catch (e) {
    show("badkill", e, false);
  }
  try {
    await execFileAsync("/bin/echo", [], { ...o, killSignal: 99 });
  } catch (e) {
    show("badkillnum", e, false);
  }
  try {
    await execFileAsync("/bin/sh", ["-c", "exit 4"], { ...o, encoding: "buffer" });
  } catch (e) {
    const x = e as ExecFileException;
    console.log("buffer-exit", x.code, x.killed);
  }
}
main();`,
    },
  },
  {
    id: "CO-EF-06 timeout: the default SIGTERM, a SIGKILL name and number, a child that outlives no timeout",
    files: {
      "main.ts": `${PRELUDE}
${SHOW}
async function main(): Promise<void> {
  const o: ExecFileOptions = { timeout: 200 };
  try {
    await execFileAsync("/bin/sh", ["-c", "echo started; sleep 5"], o);
  } catch (e) {
    show("term", e, true);
  }
  try {
    await execFileAsync("/bin/sleep", ["5"], { ...o, killSignal: "SIGKILL" });
  } catch (e) {
    show("kill", e, true);
  }
  try {
    await execFileAsync("/bin/sleep", ["5"], { ...o, killSignal: 9 });
  } catch (e) {
    show("kill9", e, true);
  }
  const fast = await execFileAsync("/bin/echo", ["in time"], { ...o, timeout: 5000, encoding: "utf8" });
  console.log("fast", JSON.stringify(fast.stdout));
}
main();`,
    },
  },
  {
    id: "CO-EF-07 a shell (true, a path) with the command in the file name",
    files: {
      "main.ts": `${PRELUDE}
${SHOW}
async function main(): Promise<void> {
  const o: ExecFileOptions = { shell: true };
  const a = await execFileAsync("echo one $((1 + 1))", [], { ...o, encoding: "utf8" });
  console.log(JSON.stringify(a.stdout));
  const b = await execFileAsync("echo $0", [], { shell: "/bin/sh", encoding: "utf8" });
  console.log(JSON.stringify(b.stdout));
  const c = await execFileAsync("/bin/echo", ["no", "shell"], { shell: false, encoding: "utf8" });
  console.log(JSON.stringify(c.stdout));
  try {
    await execFileAsync("exit 5", [], o);
  } catch (e) {
    show("shell-exit", e, false);
  }
}
main();`,
    },
  },
  {
    id: "CO-EF-08 an absent or undefined signal runs as Node does",
    files: {
      "main.ts": `${PRELUDE}
async function run(o: ExecFileOptions): Promise<void> {
  const r = await execFileAsync("/bin/echo", ["ran"], { ...o, encoding: "utf8" });
  console.log(r.stdout.trim());
}
async function main(): Promise<void> {
  await run({});
  await run({ signal: undefined });
}
main();`,
    },
  },
];

const FENCES: { row: Row; prefix: string; fence: string }[] = [
  {
    row: {
      id: "CO-EF-F1 a present AbortSignal stops the program by name (Node honors it)",
      files: {
        "main.ts": `${PRELUDE}
async function run(o: ExecFileOptions): Promise<void> {
  const r = await execFileAsync("/bin/echo", ["ran"], { ...o, encoding: "utf8" });
  console.log(r.stdout.trim());
}
async function main(): Promise<void> {
  await run({ signal: undefined });
  await run({ signal: AbortSignal.timeout(5000) });
}
main();`,
      },
    },
    prefix: "ran\n",
    fence: "'the promisified execFile option 'signal'' is typed by @types/node but has no scriptc lowering yet",
  },
  {
    row: {
      id: "CO-EF-F2 a uid stops the program by name",
      files: {
        "main.ts": `${PRELUDE}
async function main(): Promise<void> {
  console.log("before");
  const o: ExecFileOptions = { uid: 12345 };
  const r = await execFileAsync("/bin/echo", ["ran"], { ...o, encoding: "utf8" });
  console.log(r.stdout.trim());
}
main();`,
      },
    },
    prefix: "before\n",
    fence: "'the promisified execFile option 'uid'' is typed by @types/node but has no scriptc lowering yet",
  },
  {
    row: {
      id: "CO-EF-F3 a shell with an arguments list stops by name (Node prints DEP0190 with its pid)",
      files: {
        "main.ts": `${PRELUDE}
async function main(): Promise<void> {
  console.log("before");
  const r = await execFileAsync("echo", ["a", "b"], { shell: true, encoding: "utf8" });
  console.log(r.stdout.trim());
}
main();`,
      },
    },
    prefix: "before\n",
    fence: "'the promisified execFile with the shell option and an arguments list",
  },
  {
    row: {
      id: "CO-EF-F4 an exec error's null signal read through its string type stops by name",
      files: {
        "main.ts": `${PRELUDE}
async function main(): Promise<void> {
  try {
    await execFileAsync("/bin/sh", ["-c", "exit 1"]);
  } catch (e) {
    const x = e as ExecFileException;
    console.log("code", x.code);
    console.log("signal", x.signal);
  }
}
main();`,
      },
    },
    prefix: "code 1\n",
    fence: "'the exec error member 'signal' holding a value outside its declared type",
  },
  {
    row: {
      id: "CO-EF-F5 an encoding Node decodes other than utf8 stops by name",
      files: {
        "main.ts": `${PRELUDE}
async function main(): Promise<void> {
  console.log("before");
  const o: ExecFileOptions = { encoding: "hex" };
  const r = await execFileAsync("/bin/echo", ["x"], o);
  console.log(typeof r.stdout === "string" ? r.stdout : "buffer");
}
main();`,
      },
    },
    prefix: "before\n",
    fence: "'the promisified execFile with an encoding other than",
  },
];

// SEMANTICS.md S134 (b): Node answers Buffers for a PRESENT `encoding`
// key holding undefined and strings for an absent one; a typed record
// cannot tell the two apart, so a present key that holds undefined stops.
const ENC_UNDEFINED = "'an explicit 'encoding' that may be undefined in the async exec options";
FENCES.push(
  {
    row: {
      id: "CO-EF-F6 an encoding written into the options literal that holds undefined stops by name; one holding utf8 runs",
      files: {
        "main.ts": `${PRELUDE}
async function main(): Promise<void> {
  const set: BufferEncoding | undefined = Math.random() > 2 ? undefined : "utf8";
  const a = await execFileAsync("/bin/echo", ["a"], { encoding: set });
  console.log("a", typeof a.stdout === "string" ? JSON.stringify(a.stdout) : "buffer");
  const unset: BufferEncoding | undefined = Math.random() > 2 ? "utf8" : undefined;
  const o: ExecFileOptions = { cwd: "/" };
  const c = await execFileAsync("/bin/echo", ["c"], { ...o, encoding: unset });
  console.log("c", typeof c.stdout === "string" ? JSON.stringify(c.stdout) : "buffer");
}
main();`,
      },
    },
    prefix: 'a "a\\n"\n',
    fence: ENC_UNDEFINED,
  },
  {
    row: {
      id: "CO-EF-F7 an options const whose encoding key is present and holds undefined stops by name at the call",
      files: {
        "main.ts": `${PRELUDE}
async function main(): Promise<void> {
  const o: ExecFileOptions = { cwd: "/" };
  const r0 = await execFileAsync("/bin/echo", ["absent"], o);
  console.log(typeof r0.stdout === "string" ? JSON.stringify(r0.stdout) : "buffer");
  const unset: string | undefined = Math.random() > 2 ? "utf8" : undefined;
  const held = { ...o, encoding: unset };
  const r = await execFileAsync("/bin/echo", ["present"], held);
  console.log(typeof r.stdout === "string" ? JSON.stringify(r.stdout) : "buffer");
}
main();`,
      },
    },
    prefix: '"absent\\n"\n',
    fence: ENC_UNDEFINED,
  },
  {
    row: {
      id: "CO-EF-F8 a literal encoding: undefined stops by name (Node answers Buffers)",
      files: {
        "main.ts": `${PRELUDE}
async function main(): Promise<void> {
  console.log("before");
  const r = await execFileAsync("/bin/echo", ["x"], { encoding: undefined });
  console.log(typeof r.stdout === "string" ? "string" : "buffer");
}
main();`,
      },
    },
    prefix: "before\n",
    fence: ENC_UNDEFINED,
  },
);

// The fence names its own call's line, not the first call sharing the
// options type (the reader helpers are interned per call site).
FENCES.push({
  row: {
    id: "CO-EF-F9 a fence names the line of its own call when an earlier call shares the options type",
    files: {
      "main.ts": `${PRELUDE}
async function main(): Promise<void> {
  const ok: ExecFileOptions = { cwd: "/" };
  console.log(JSON.stringify((await execFileAsync("/bin/echo", ["a"], { ...ok, encoding: "utf8" })).stdout));
  const uid: ExecFileOptions = { uid: 12345 };
  console.log(JSON.stringify((await execFileAsync("/bin/echo", ["b"], { ...uid, encoding: "utf8" })).stdout));
}
main();`,
    },
  },
  prefix: '"a\\n"\n',
  fence: "'the promisified execFile option 'uid'' is typed by @types/node but has no scriptc lowering yet [SC2020 at ",
});

describe("child_process option records as values — the promisified execFile", () => {
  test("CO-EF-F9b the fence's line is its own call's (main.ts:8)", async () => {
    await checkFencedLine(scratch, FENCES.find((f) => f.row.id.startsWith("CO-EF-F9"))!.row, "main.ts:8]");
  }, 60_000);
  test("CO-EF-R1 a member write of an encoding that may be undefined onto exec options refuses by name", () =>
    checkRefuses(scratch, {
      id: "CO-EF-R1",
      files: {
        "main.ts": `${PRELUDE}
async function main(e?: string): Promise<void> {
  const o: ExecFileOptions = { cwd: "/" };
  o.encoding = e;
  const r = await execFileAsync("/bin/echo", ["x"], o);
  console.log(typeof r.stdout === "string" ? "string" : "buffer");
}
main();`,
      },
    }, "an explicit 'encoding' that may be undefined in the async exec options"), 60_000);
  for (const row of ROWS) {
    test(`${row.id} (wasm-native)`, () => checkRow(scratch, row, "wasm-native"), 60_000);
    test(`${row.id} builds on wasm`, () => checkBuilds(scratch, row, "wasm"), 60_000);
  }
  for (const { row, prefix, fence } of FENCES) {
    test(`${row.id} (wasm-native)`, () => checkFenced(scratch, row, "wasm-native", prefix, fence), 60_000);
  }
});
