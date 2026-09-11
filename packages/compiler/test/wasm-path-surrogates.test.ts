/* INC-26 pass P2 (brief-p2-v2.md 89fd68aa §3E; design-host-v7.txt cccf7d6e
 * §5.1, R-11) — THE UTF-16-NATIVE SURROGATE ROW SET. Lone surrogates
 * cannot cross the hex case-file format 3C/3D use (Buffer.from(s,"utf8")
 * substitutes U+FFFD, "EF BF BD", for an unpaired surrogate — the C
 * driver's own hex codec is UTF-8-based and CANNOT carry one either, so
 * neither the committed case files nor the C driver can participate in
 * this file at all; every row here is Node-versus-module ONLY, and says
 * so at each op).
 *
 * THE WITNESS FIRST (rev-26): P1 proved the ENV channel carries a lone
 * surrogate intact (wasm-host-process.test.ts's own precedent); ARGV
 * doing the same is an INFERENCE until actually measured — this file's
 * first row instantiates a module that does nothing but echo argv[1]'s
 * own code units back, proving the forced host's argv delivers a lone
 * high surrogate to the module as the SAME code unit, by INDEX, before
 * any path function is asked to do anything with one.
 *
 * ASSERT BY INDEX, NEVER THE RENDERED STRING: printing a result that
 * contains a lone surrogate through this tier's OWN `write` syscall
 * would hit the exact same UTF-8 substitution problem the case files
 * have (the runtime's stdout path is UTF-8). So the driver never prints
 * a path STRING — for every op it prints the result's `.length` and
 * each `charCodeAt(i)` as a plain decimal integer (ASCII digits only,
 * lossless through UTF-8), and this file compares that decimal sequence
 * against Node's own `result.charCodeAt(i)` sequence, index by index.
 *
 * SHAPE: one row per (family, key) x (lone high surrogate, lone low
 * surrogate, surrogate at a separator boundary) = 9 keys x 2 families x
 * 3 sub-cases = 54, plus the one witness row = 55.
 *
 * cwd-consulting ops (resolve, relative) use the SAME resolve-prepend
 * trick as wasm-path-oracle.test.ts (own copy — this file's host is its
 * own, never shared, matching every other forced-host test in this
 * package) to stay comparable to a forced module cwd without chdir'ing
 * the real process.
 */
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as nodePosix from "node:path/posix";
import * as nodeWin32 from "node:path/win32";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { compile } from "../src/index.js";

let scratch: string;
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "tsinter-wasm-path-surrogates-"));
});
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

const HIGH = "\uD800"; // a lone high surrogate, standalone
const LOW = "\uDC00"; // a lone low surrogate, standalone
const FORCED_CWD_POSIX = "/";
const FORCED_CWD_WIN32 = "C:\\Users\\x";

/** win32.toNamespacedPath under a forced cwd — copied from
 * wasm-path-oracle.test.ts's own derivation (see that file's comment for
 * why the naive "pre-resolve then call" trick is wrong here: the
 * function's own `resolvedPath.length<=2` fallback returns the ORIGINAL
 * argument, which a pre-resolve substitutes away). Re-derived here
 * rather than imported — this file's host/helpers are its own, matching
 * every other forced-host test in this package. */
function win32ToNamespacedPathForced(path: string): string {
  if (path.length === 0) return path;
  const resolvedPath = nodeWin32.resolve(FORCED_CWD_WIN32, path);
  if (resolvedPath.length <= 2) return path;
  if (resolvedPath.charCodeAt(0) === 0x5c) {
    if (resolvedPath.charCodeAt(1) === 0x5c) {
      const code = resolvedPath.charCodeAt(2);
      if (code !== 0x3f && code !== 0x2e) return `\\\\?\\UNC\\${resolvedPath.slice(2)}`;
    }
  } else {
    const c0 = resolvedPath.charCodeAt(0);
    const isDeviceRoot = (c0 >= 0x41 && c0 <= 0x5a) || (c0 >= 0x61 && c0 <= 0x7a);
    if (isDeviceRoot && resolvedPath.charCodeAt(1) === 0x3a && resolvedPath.charCodeAt(2) === 0x5c) {
      return `\\\\?\\${resolvedPath}`;
    }
  }
  return resolvedPath;
}

interface Row {
  readonly family: "posix" | "win32";
  readonly key: string; // the op string the driver dispatches on
  readonly sub: "high" | "low" | "boundary";
  readonly args: readonly string[]; // raw JS strings, may contain a lone surrogate
  readonly node: () => string | boolean;
}

function buildRows(): Row[] {
  const rows: Row[] = [];
  for (const family of ["posix", "win32"] as const) {
    const ns = family === "posix" ? nodePosix : nodeWin32;
    const sep = family === "posix" ? "/" : "\\";
    const otherArg = family === "posix" ? "b" : "b";
    for (const sub of ["high", "low", "boundary"] as const) {
      const surrogate = sub === "high" ? HIGH : sub === "low" ? LOW : `a${sep}${HIGH}${sep}b`;
      rows.push({ family, key: "normalize", sub, args: [surrogate], node: () => ns.normalize(surrogate) });
      rows.push({ family, key: "dirname", sub, args: [surrogate], node: () => ns.dirname(surrogate) });
      rows.push({
        family,
        key: "basename",
        sub,
        args: [surrogate, ""],
        node: () => ns.basename(surrogate, ""),
      });
      rows.push({ family, key: "extname", sub, args: [surrogate], node: () => ns.extname(surrogate) });
      rows.push({
        family,
        key: "isAbsolute",
        sub,
        args: [surrogate],
        node: () => ns.isAbsolute(surrogate),
      });
      rows.push({
        family,
        key: "toNamespacedPath",
        sub,
        args: [surrogate],
        node: () =>
          family === "win32"
            ? win32ToNamespacedPathForced(surrogate)
            : nodePosix.toNamespacedPath(surrogate),
      });
      rows.push({
        family,
        key: "relative",
        sub,
        args: [surrogate, otherArg],
        node: () => {
          const cwd = family === "posix" ? FORCED_CWD_POSIX : FORCED_CWD_WIN32;
          const rfrom = ns.resolve(cwd, surrogate);
          const rto = ns.resolve(cwd, otherArg);
          return ns.relative(rfrom, rto);
        },
      });
      rows.push({ family, key: "join", sub, args: [surrogate, otherArg], node: () => ns.join(surrogate, otherArg) });
      rows.push({
        family,
        key: "resolve",
        sub,
        args: [surrogate],
        node: () => {
          const cwd = family === "posix" ? FORCED_CWD_POSIX : FORCED_CWD_WIN32;
          return ns.resolve(cwd, surrogate);
        },
      });
    }
  }
  return rows;
}

/* ── the driver: raw argv in, decimal code units out (never a rendered
 * string) ─────────────────────────────────────────────────────────────
 * argv[1] = op discriminator (plain ASCII, always well-formed). For
 * "argvWitness", argv[2] is echoed verbatim, code unit by code unit.
 * Otherwise argv[2.."] are the op's own string arguments, raw (no hex
 * anywhere in this file). */
function driverSource(family: "posix" | "win32"): string {
  const ns = family === "posix" ? "posix" : "win32";
  const path = family === "posix" ? "node:path/posix" : "node:path/win32";
  return `
import * as ns from "${path}";
function dump(s: string): void {
  let out = "" + s.length;
  for (let i = 0; i < s.length; i = i + 1) {
    out = out + "," + s.charCodeAt(i);
  }
  console.log(out);
}
function dumpBool(b: boolean): void {
  console.log(b ? "T" : "F");
}
const op = process.argv[1];
if (op === "argvWitness") {
  dump(process.argv[2]);
} else if (op === "normalize") {
  dump(ns.normalize(process.argv[2]));
} else if (op === "dirname") {
  dump(ns.dirname(process.argv[2]));
} else if (op === "basename") {
  dump(ns.basename(process.argv[2], process.argv[3]));
} else if (op === "extname") {
  dump(ns.extname(process.argv[2]));
} else if (op === "isAbsolute") {
  dumpBool(ns.isAbsolute(process.argv[2]));
} else if (op === "toNamespacedPath") {
  dump(ns.toNamespacedPath(process.argv[2]));
} else if (op === "relative") {
  dump(ns.relative(process.argv[2], process.argv[3]));
} else if (op === "join") {
  dump(ns.join(process.argv[2], process.argv[3]));
} else if (op === "resolve") {
  dump(ns.resolve(process.argv[2]));
}
`;
}

async function compileDriver(family: "posix" | "win32"): Promise<string> {
  const file = join(scratch, `${family}-surrogate-driver.ts`);
  await writeFile(file, driverSource(family));
  const res = await compile(file, { outPath: `${file}.wasm`, outDir: scratch, dynamic: false, backend: "wasm" });
  if (!res.ok) throw new Error(`${family} surrogate driver refused: ${JSON.stringify(res.diagnostics)}`);
  return res.binaryPath;
}

function writeUtf16(memory: WebAssembly.Memory, s: string, ptr: number, cap: number): number {
  if (s.length > cap) return s.length;
  const view = new Uint16Array(memory.buffer, ptr, s.length);
  for (let i = 0; i < s.length; i++) view[i] = s.charCodeAt(i);
  return s.length;
}

/** Runs ONE case, ONE instantiation (surrogate rows are rare and each
 * one matters individually — no batching here, unlike 3D). Returns the
 * driver's raw stdout line (either "T"/"F" for isAbsolute, or
 * "len,code0,code1,...").*/
async function runOne(binaryPath: string, argv: readonly string[], cwd: string): Promise<string> {
  const bytes = await readFile(binaryPath);
  const chunks: Buffer[] = [];
  let memory: WebAssembly.Memory | null = null;
  const { instance } = await WebAssembly.instantiate(bytes, {
    tsinter: {
      write(fd: number, ptr: number, len: number): void {
        if (fd === 1) chunks.push(Buffer.from(new Uint8Array(memory!.buffer, ptr, len)));
      },
      now: (): number => 0,
      seed: (): bigint => 0n,
      wallClock: (): number => 0,
      hostStr(kind: number, index: number, ptr: number, cap: number): number {
        switch (kind) {
          case 0:
            return index >= 0 && index < argv.length ? writeUtf16(memory!, argv[index]!, ptr, cap) : -1;
          case 3:
            return writeUtf16(memory!, cwd, ptr, cap);
          case 4:
            return writeUtf16(memory!, "linux", ptr, cap);
          default:
            return -1;
        }
      },
      hostNum(kind: number): number {
        return kind === 0 ? argv.length : 0;
      },
      exit(code: number): void {
        throw new Error(`unexpected exit(${code})`);
      },
    },
  });
  memory = instance.exports["memory"] as WebAssembly.Memory;
  (instance.exports["_start"] as () => void)();
  const out = Buffer.concat(chunks).toString("utf8").trim();
  const lines = out.split("\n");
  expect(lines.length, `exactly one output line for argv=${JSON.stringify(argv)}`).toBe(1);
  return lines[0]!;
}

function parseDump(line: string): number[] {
  const parts = line.split(",").map(Number);
  const len = parts[0]!;
  const codes = parts.slice(1);
  expect(codes.length, `dump line declares length ${len} but has ${codes.length} code units: ${line}`).toBe(len);
  return codes;
}

function nodeCodeUnits(s: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i));
  return out;
}

describe("wasm path.ts UTF-16-native surrogate rows (Node vs module ONLY — the C driver cannot carry a lone surrogate through its hex codec, and is not consulted by any row in this file)", () => {
  let posixBin: string;
  let win32Bin: string;
  beforeAll(async () => {
    posixBin = await compileDriver("posix");
    win32Bin = await compileDriver("win32");
  }, 30_000);

  test("WITNESS: a lone high surrogate survives argv into the module intact, by code-unit index", async () => {
    const line = await runOne(posixBin, ["scriptc", "argvWitness", HIGH], "/");
    const codes = parseDump(line);
    expect(codes).toEqual([0xd800]);
  });

  test("WITNESS: a lone low surrogate survives argv into the module intact, by code-unit index", async () => {
    const line = await runOne(posixBin, ["scriptc", "argvWitness", LOW], "/");
    const codes = parseDump(line);
    expect(codes).toEqual([0xdc00]);
  });

  const rows = buildRows();
  expect(rows.length).toBe(54);

  for (const row of rows) {
    test(`${row.family} ${row.key} (${row.sub} surrogate) — Node vs module only, by code-unit index`, async () => {
      const bin = row.family === "posix" ? posixBin : win32Bin;
      const cwd = row.family === "posix" ? FORCED_CWD_POSIX : FORCED_CWD_WIN32;
      const argv = ["scriptc", row.key, ...row.args];
      const line = await runOne(bin, argv, cwd);
      const expected = row.node();
      if (typeof expected === "boolean") {
        expect(line).toBe(expected ? "T" : "F");
      } else {
        const moduleCodes = parseDump(line);
        const nodeCodes = nodeCodeUnits(expected);
        expect(moduleCodes, `${row.family} ${row.key} ${row.sub}: node=${JSON.stringify(nodeCodes)}`).toEqual(
          nodeCodes,
        );
      }
    });
  }
});
