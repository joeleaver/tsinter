/* INC-26 pass P2 (brief-p2-v2.md 89fd68aa §3D; design-host-v7.txt cccf7d6e
 * §10(i)) — THE THREE-WAY ORACLE. For every case in BOTH committed files
 * (packages/runtime/test/path-cases.txt, the win32 corpus, and
 * path-cases-posix.txt, the posix corpus this pass landed in 3C):
 *   column 1 = Node's path.posix/path.win32, computed IN-PROCESS, right
 *              here, from the DECODED case-file arguments — never the
 *              C's answer and never the case file's own expected column
 *              (the same circularity one step removed, rev-26's own
 *              framing). The case files supply INPUTS only.
 *   column 2 = the C driver's answer (a NEW print-all driver, embedded
 *              below and compiled to a throwaway scratch binary at test
 *              time — never committed to the repo; it is NOT test_path.c,
 *              which stays hard-coded to its own N-over-N assertion per
 *              brief §3C and cannot be reused here since its `check()`
 *              caps printed detail at 40 mismatches, far short of the
 *              ~78k cases this file drives).
 *   column 3 = the EMITTED MODULE's answer, from a REAL wasm binary
 *              compiled through this package's own `compile()` (backend:
 *              "wasm") — the same PathBuilder this pass built in 3A.
 *
 * FRAMING (rev-26's three traps, folded from the pre-read):
 *   (1) Fields riding argv into the wasm driver are hex-encoded in MY OWN
 *       scheme — 4 hex digits per UTF-16 CODE UNIT (not the case files'
 *       own UTF-8-byte-hex; see hexEncodeArgv/hexDecodeArgv below and the
 *       driver's matching hx()/xh()) — because the vocabulary DELIBERATELY
 *       contains literal tabs and newlines (gen-posix-cases.mjs's atoms
 *       include String.fromCharCode(9)/(10)), and a raw tab used as MY
 *       OWN field separator would collide with that content. UTF-16-code-
 *       unit hex only ever emits [0-9a-f], so tab-joining encoded fields
 *       is safe, and decoding needs no UTF-8 logic in the wasm driver
 *       (String.fromCharCode + parseInt(_, 16) are both tier-native —
 *       Number.prototype.toString(radix) is NOT reachable statically from
 *       user code, SC2012, so the driver's own hex ENCODE side is written
 *       by hand from bitwise ops, never .toString(16)).
 *   (2) The harness asserts EXACTLY ONE stdout line per case in a batch —
 *       a module that traps or stops early must read as N MISSING
 *       results, never as zero mismatches (checkBatchOutput below).
 *   (3) Every mismatch prints the op and every field in hex (both the
 *       case-file's original UTF-8-byte-hex AND the decoded string's own
 *       JSON form, for readability).
 *
 * REPORT PER OP PER FAMILY: the 38214/39948 combined totals hide that
 * five win32 ops (join4, join5, resolve3 among them) have a small case
 * count vs normalize's thousands — the tally at the end of each family's
 * test breaks pass/fail down by op, never just a single combined count.
 *
 * SECOND-CWD ROWS get their OWN instantiation (a cwd snapshot is captured
 * ONCE per module instance, D2/P1) — proving `resolve`/`win32Resolve`
 * read whatever the HOST reports at instantiation time, not a constant
 * baked from the "/" instantiation every other row in this file uses.
 */
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as nodePosix from "node:path/posix";
import * as nodeWin32 from "node:path/win32";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { compile } from "../src/index.js";

const execFileAsync = promisify(execFile);
const runtimeTestDir = join(import.meta.dirname, "../../runtime/test");
const runtimeSrcDir = join(import.meta.dirname, "../../runtime/src");

let scratch: string;
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "tsinter-wasm-path-oracle-"));
});
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

/* ── case-file decoding (Node side, plain JS — no tier restrictions) ──── */

function hexToBytesStr(h: string): string {
  if (h === "-") return "";
  return Buffer.from(h, "hex").toString("utf8");
}

/** MY OWN argv scheme: 4 hex digits per UTF-16 code unit — matches the
 * driver's hx()/xh() exactly (see the embedded driver sources below). */
function toArgvHex(s: string): string {
  if (s.length === 0) return "-";
  let out = "";
  for (let i = 0; i < s.length; i++) out += s.charCodeAt(i).toString(16).padStart(4, "0");
  return out;
}
function fromArgvHex(h: string): string {
  if (h === "-") return "";
  let out = "";
  for (let i = 0; i < h.length; i += 4) out += String.fromCharCode(parseInt(h.slice(i, i + 4), 16));
  return out;
}

interface CaseRow {
  readonly lineNo: number;
  readonly rawOp: string; // as printed in the file, e.g. "p:join2" or "join2"
  readonly op: string; // rawOp with any "p:" prefix stripped
  readonly posix: boolean;
  readonly args: readonly string[]; // decoded (real JS strings)
}

function parseCaseFile(text: string): CaseRow[] {
  const rows: CaseRow[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.length === 0) continue;
    const fields = line.split("\t");
    const rawOp = fields[0]!;
    const isP = rawOp.startsWith("p:");
    const op = isP ? rawOp.slice(2) : rawOp;
    // fields[1..length-2] are args; the LAST field is the case file's own
    // expected column — read the count only (never its value).
    const args = fields.slice(1, fields.length - 1).map(hexToBytesStr);
    rows.push({ lineNo: i + 1, rawOp, op, posix: isP, args });
  }
  return rows;
}

/* ── column 1: Node's own answer, computed in-process ───────────────────
 * Both generators (gen-path-cases.mjs, gen-posix-cases.mjs) chdir("/")
 * BEFORE calling Node, so every cwd-consulting op's committed expectation
 * was computed under cwd="/" — but the vitest PROCESS running THIS file
 * has its own real cwd (the worktree), and it must never chdir (a shared
 * side effect on every other suite in the run). Instead, use the same
 * cwd-independent trick as the second-cwd test below: `resolve(from)`
 * under a hypothetical cwd C is `resolve(C, from)` computed under the
 * REAL cwd, since resolve scans its arguments right-to-left and stops at
 * the first absolute one — prepending "/" as resolve's own leftmost
 * argument reproduces "cwd was /" exactly, with no process-wide chdir.
 * `relative(a,b)` is cwd-independent ONCE its two arguments are already
 * absolute (it only touches cwd through its own internal two resolve()
 * calls), so pre-resolving both sides under "/" and handing relative()
 * the now-absolute results is the same trick applied twice.
 * win32.toNamespacedPath ALSO resolves internally (scr_path.c's
 * scr_path_win32_to_namespaced_path); posix's does not (a pure
 * passthrough, scr_path_to_namespaced_path). */
const FORCED_CWD = "/";

/** win32.toNamespacedPath, computed under FORCED_CWD instead of the real
 * process cwd. This is a FAITHFUL REIMPLEMENTATION (from Node's own
 * `toNamespacedPath` source, read directly), not the "pre-resolve then
 * call toNamespacedPath" trick used elsewhere in this file — that trick
 * is WRONG here specifically: toNamespacedPath's own `resolvedPath.length
 * <= 2` fallback returns the ORIGINAL argument, and pre-resolving before
 * the call substitutes the resolved value for "original", corrupting
 * exactly that fallback (confirmed empirically: real Node's own
 * `toNamespacedPath(resolve("/","."))` gives "\\", but the true forced-
 * cwd-"/" answer, `toNamespacedPath(".")` under a REAL cwd of "/", is
 * ".", not "\\" — the difference IS the fallback). So this reimplements
 * the whole function, using the resolve-prepend trick ONLY for its own
 * internal `win32.resolve(path)` call, exactly where Node's real source
 * uses the real cwd. */
function win32ToNamespacedPathForced(path: string): string {
  if (path.length === 0) return path;
  const resolvedPath = nodeWin32.resolve(FORCED_CWD, path);
  if (resolvedPath.length <= 2) return path;
  if (resolvedPath.charCodeAt(0) === 0x5c /* \ */) {
    if (resolvedPath.charCodeAt(1) === 0x5c /* \ */) {
      const code = resolvedPath.charCodeAt(2);
      if (code !== 0x3f /* ? */ && code !== 0x2e /* . */) {
        return `\\\\?\\UNC\\${resolvedPath.slice(2)}`;
      }
    }
  } else {
    const c0 = resolvedPath.charCodeAt(0);
    const isDeviceRoot = (c0 >= 0x41 && c0 <= 0x5a) || (c0 >= 0x61 && c0 <= 0x7a);
    if (isDeviceRoot && resolvedPath.charCodeAt(1) === 0x3a /* : */ && resolvedPath.charCodeAt(2) === 0x5c /* \ */) {
      return `\\\\?\\${resolvedPath}`;
    }
  }
  return resolvedPath;
}

function nodeAnswer(ns: typeof nodePosix, op: string, args: readonly string[]): string {
  const isWin32 = ns === nodeWin32;
  switch (op) {
    case "normalize":
      return ns.normalize(args[0]!);
    case "dirname":
      return ns.dirname(args[0]!);
    case "basename":
      return ns.basename(args[0]!, "");
    case "basenameSuffix":
      return ns.basename(args[0]!, args[1]!);
    case "extname":
      return ns.extname(args[0]!);
    case "toNamespacedPath":
      return isWin32 ? win32ToNamespacedPathForced(args[0]!) : ns.toNamespacedPath(args[0]!);
    case "isAbsolute":
      return String(ns.isAbsolute(args[0]!));
    case "relative": {
      const rfrom = ns.resolve(FORCED_CWD, args[0]!);
      const rto = ns.resolve(FORCED_CWD, args[1]!);
      return ns.relative(rfrom, rto);
    }
    default:
      if (op.startsWith("join")) return ns.join(...args);
      if (op.startsWith("resolve")) return ns.resolve(FORCED_CWD, ...args);
      throw new Error(`nodeAnswer: unknown op ${op}`);
  }
}

/* ── column 2: the C driver — a NEW print-all program, never committed.
 * Reuses test_path.c's own hex codec (a ~15-line utility, not scr_path.c
 * itself) and the SAME op dispatch shape as test_path_both.c's `p:` arm,
 * but PRINTS every result unconditionally instead of asserting against
 * an expected field — test_path.c's check() caps detail at 40 mismatches
 * by design (brief §3C's own driver, unchanged), which cannot serve a
 * three-way diff over ~78k combined cases. */
function cDriverSource(): string {
  return `
#include "${join(runtimeSrcDir, "scr_runtime.h")}"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#define MAX_FIELD 8192
#define MAX_ARGS 8

static int hex_val(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}
static size_t hex_decode(const char *hex, char *out) {
  if (strcmp(hex, "-") == 0) return 0;
  size_t n = strlen(hex);
  if (n % 2 != 0 || n / 2 > MAX_FIELD) return (size_t)-1;
  for (size_t i = 0; i < n; i += 2) {
    int hi = hex_val(hex[i]), lo = hex_val(hex[i + 1]);
    if (hi < 0 || lo < 0) return (size_t)-1;
    out[i / 2] = (char)((hi << 4) | lo);
  }
  return n / 2;
}
static void hex_print(const char *bytes, size_t len) {
  if (len == 0) { fputc('-', stdout); return; }
  for (size_t i = 0; i < len; i++) printf("%02x", (unsigned char)bytes[i]);
}
static ScrArr *pack_args(ScrStr **args, int argc) {
  ScrArr *arr = scr_arr_new(SCR_ELEM_STR, argc);
  for (int i = 0; i < argc; i++) scr_arr_push_ref(arr, scr_str_retain(args[i]));
  return arr;
}

int main(int argc, char **argv) {
  if (argc < 2) { fputs("usage: oracle_driver <cases-file>\\n", stderr); return 2; }
  FILE *f = fopen(argv[1], "r");
  if (!f) { perror("fopen"); return 2; }
  if (chdir("/") != 0) { fputs("chdir failed\\n", stderr); return 2; }
  char line[MAX_FIELD * 2 * (MAX_ARGS + 2)];
  while (fgets(line, sizeof line, f)) {
    size_t linelen = strlen(line);
    while (linelen > 0 && (line[linelen - 1] == '\\n' || line[linelen - 1] == '\\r')) line[--linelen] = 0;
    if (linelen == 0) continue;
    char *fields[MAX_ARGS + 2];
    int nfields = 0;
    char *cursor = line;
    while (nfields < MAX_ARGS + 2) {
      fields[nfields++] = cursor;
      char *tab = strchr(cursor, '\\t');
      if (!tab) break;
      *tab = 0;
      cursor = tab + 1;
    }
    if (nfields < 2) { fprintf(stderr, "bad line: %s\\n", line); return 2; }
    const char *op = fields[0];
    int nargs = nfields - 2; /* the last field is the case file's expected column, IGNORED here */
    static char argbuf[MAX_ARGS][MAX_FIELD];
    ScrStr *args[MAX_ARGS];
    int badhex = 0;
    for (int i = 0; i < nargs; i++) {
      size_t n = hex_decode(fields[1 + i], argbuf[i]);
      if (n == (size_t)-1) { badhex = 1; n = 0; }
      args[i] = scr_str_new(argbuf[i], n);
    }
    if (badhex) { fprintf(stderr, "bad hex arg on line\\n"); return 2; }

    ScrStr *result = NULL;
    int posix = 0;
    if (op[0] == 'p' && op[1] == ':') { posix = 1; op += 2; }
    if (posix) {
      if (strcmp(op, "normalize") == 0) result = scr_path_normalize(args[0]);
      else if (strcmp(op, "dirname") == 0) result = scr_path_dirname(args[0]);
      else if (strcmp(op, "basename") == 0) {
        ScrStr *empty = scr_str_new("", 0);
        result = scr_path_basename(args[0], empty);
        scr_str_release(empty);
      } else if (strcmp(op, "basenameSuffix") == 0) result = scr_path_basename(args[0], args[1]);
      else if (strcmp(op, "extname") == 0) result = scr_path_extname(args[0]);
      else if (strcmp(op, "toNamespacedPath") == 0) result = scr_path_to_namespaced_path(args[0]);
      else if (strcmp(op, "isAbsolute") == 0) {
        const char *s = scr_path_is_absolute(args[0]) ? "true" : "false";
        hex_print(s, strlen(s));
        fputc('\\n', stdout);
        for (int i = 0; i < nargs; i++) scr_str_release(args[i]);
        continue;
      } else if (strncmp(op, "join", 4) == 0) {
        ScrArr *pack = pack_args(args, nargs);
        result = scr_path_join(pack);
        scr_arr_release(pack);
      } else if (strncmp(op, "resolve", 7) == 0) {
        ScrArr *pack = pack_args(args, nargs);
        result = scr_path_resolve(pack);
        scr_arr_release(pack);
      } else if (strcmp(op, "relative") == 0) result = scr_path_relative(args[0], args[1]);
      else { fprintf(stderr, "unknown posix op: %s\\n", op); return 2; }
    } else {
      if (strcmp(op, "normalize") == 0) result = scr_path_win32_normalize(args[0]);
      else if (strcmp(op, "dirname") == 0) result = scr_path_win32_dirname(args[0]);
      else if (strcmp(op, "basename") == 0) {
        ScrStr *empty = scr_str_new("", 0);
        result = scr_path_win32_basename(args[0], empty);
        scr_str_release(empty);
      } else if (strcmp(op, "basenameSuffix") == 0) result = scr_path_win32_basename(args[0], args[1]);
      else if (strcmp(op, "extname") == 0) result = scr_path_win32_extname(args[0]);
      else if (strcmp(op, "toNamespacedPath") == 0) result = scr_path_win32_to_namespaced_path(args[0]);
      else if (strcmp(op, "isAbsolute") == 0) {
        const char *s = scr_path_win32_is_absolute(args[0]) ? "true" : "false";
        hex_print(s, strlen(s));
        fputc('\\n', stdout);
        for (int i = 0; i < nargs; i++) scr_str_release(args[i]);
        continue;
      } else if (strncmp(op, "join", 4) == 0) {
        ScrArr *pack = pack_args(args, nargs);
        result = scr_path_win32_join(pack);
        scr_arr_release(pack);
      } else if (strncmp(op, "resolve", 7) == 0) {
        ScrArr *pack = pack_args(args, nargs);
        result = scr_path_win32_resolve(pack);
        scr_arr_release(pack);
      } else if (strcmp(op, "relative") == 0) result = scr_path_win32_relative(args[0], args[1]);
      else { fprintf(stderr, "unknown op: %s\\n", op); return 2; }
    }
    if (result != NULL) {
      hex_print(result->data, result->len);
      scr_str_release(result);
    } else {
      fputc('-', stdout);
    }
    fputc('\\n', stdout);
    for (int i = 0; i < nargs; i++) scr_str_release(args[i]);
  }
  fclose(f);
  return 0;
}
`;
}

let cDriverBin: string;
beforeAll(async () => {
  const cPath = join(scratch, "oracle_driver.c");
  await writeFile(cPath, cDriverSource());
  cDriverBin = join(scratch, "oracle_driver");
  await execFileAsync("clang", [
    "-std=c11", "-O2", "-Wall", "-Wextra",
    "-o", cDriverBin,
    cPath,
    join(runtimeSrcDir, "scr_path.c"),
    join(runtimeSrcDir, "scr_string.c"),
    join(runtimeSrcDir, "scr_number.c"),
    join(runtimeSrcDir, "scr_array.c"),
    join(runtimeSrcDir, "scr_bytes.c"),
    join(runtimeSrcDir, "scr_error.c"),
    join(runtimeSrcDir, "scr_exception.c"),
    join(runtimeSrcDir, "scr_object.c"),
    join(runtimeSrcDir, "scr_cycle.c"),
    ...(process.platform === "linux" ? ["-D_GNU_SOURCE", "-lm"] : []),
  ]);
});

async function runCDriver(casesFilePath: string): Promise<string[]> {
  const { stdout } = await execFileAsync(cDriverBin, [casesFilePath], { maxBuffer: 1 << 28 });
  const lines = stdout.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.map(hexToBytesStr);
}

/* ── column 3: the emitted module — compiled ONCE per family ──────────── */

const DRIVER_PREAMBLE = `
function hexDigit(n: number): string {
  if (n < 10) return String.fromCharCode(48 + n);
  return String.fromCharCode(87 + n);
}
function toHex4(n: number): string {
  return hexDigit((n >> 12) & 0xf) + hexDigit((n >> 8) & 0xf) + hexDigit((n >> 4) & 0xf) + hexDigit(n & 0xf);
}
function hx(h: string): string {
  if (h === "-") return "";
  let s = "";
  for (let i = 0; i < h.length; i = i + 4) {
    s = s + String.fromCharCode(parseInt(h.slice(i, i + 4), 16));
  }
  return s;
}
function xh(s: string): string {
  if (s.length === 0) return "-";
  let out = "";
  for (let i = 0; i < s.length; i = i + 1) {
    out = out + toHex4(s.charCodeAt(i));
  }
  return out;
}
`;

function posixDriverSource(): string {
  return `
import * as p from "node:path/posix";
${DRIVER_PREAMBLE}
const n = process.argv.length;
for (let i = 1; i < n; i = i + 1) {
  const raw = process.argv[i];
  const parts = raw.split("\\t");
  const op = parts[0];
  let result = "";
  if (op === "normalize") result = p.normalize(hx(parts[1]));
  else if (op === "dirname") result = p.dirname(hx(parts[1]));
  else if (op === "basename") result = p.basename(hx(parts[1]), "");
  else if (op === "basenameSuffix") result = p.basename(hx(parts[1]), hx(parts[2]));
  else if (op === "extname") result = p.extname(hx(parts[1]));
  else if (op === "toNamespacedPath") result = p.toNamespacedPath(hx(parts[1]));
  else if (op === "isAbsolute") result = String(p.isAbsolute(hx(parts[1])));
  else if (op === "relative") result = p.relative(hx(parts[1]), hx(parts[2]));
  else if (op === "join0") result = p.join();
  else if (op === "join1") result = p.join(hx(parts[1]));
  else if (op === "join2") result = p.join(hx(parts[1]), hx(parts[2]));
  else if (op === "join3") result = p.join(hx(parts[1]), hx(parts[2]), hx(parts[3]));
  else if (op === "join4") result = p.join(hx(parts[1]), hx(parts[2]), hx(parts[3]), hx(parts[4]));
  else if (op === "join5") result = p.join(hx(parts[1]), hx(parts[2]), hx(parts[3]), hx(parts[4]), hx(parts[5]));
  else if (op === "resolve0") result = p.resolve();
  else if (op === "resolve1") result = p.resolve(hx(parts[1]));
  else if (op === "resolve2") result = p.resolve(hx(parts[1]), hx(parts[2]));
  else if (op === "resolve3") result = p.resolve(hx(parts[1]), hx(parts[2]), hx(parts[3]));
  console.log(xh(result));
}
`;
}

function win32DriverSource(): string {
  return `
import * as w from "node:path/win32";
${DRIVER_PREAMBLE}
const n = process.argv.length;
for (let i = 1; i < n; i = i + 1) {
  const raw = process.argv[i];
  const parts = raw.split("\\t");
  const op = parts[0];
  let result = "";
  if (op === "normalize") result = w.normalize(hx(parts[1]));
  else if (op === "dirname") result = w.dirname(hx(parts[1]));
  else if (op === "basename") result = w.basename(hx(parts[1]), "");
  else if (op === "basenameSuffix") result = w.basename(hx(parts[1]), hx(parts[2]));
  else if (op === "extname") result = w.extname(hx(parts[1]));
  else if (op === "toNamespacedPath") result = w.toNamespacedPath(hx(parts[1]));
  else if (op === "isAbsolute") result = String(w.isAbsolute(hx(parts[1])));
  else if (op === "relative") result = w.relative(hx(parts[1]), hx(parts[2]));
  else if (op === "join0") result = w.join();
  else if (op === "join1") result = w.join(hx(parts[1]));
  else if (op === "join2") result = w.join(hx(parts[1]), hx(parts[2]));
  else if (op === "join3") result = w.join(hx(parts[1]), hx(parts[2]), hx(parts[3]));
  else if (op === "join4") result = w.join(hx(parts[1]), hx(parts[2]), hx(parts[3]), hx(parts[4]));
  else if (op === "join5") result = w.join(hx(parts[1]), hx(parts[2]), hx(parts[3]), hx(parts[4]), hx(parts[5]));
  else if (op === "resolve0") result = w.resolve();
  else if (op === "resolve1") result = w.resolve(hx(parts[1]));
  else if (op === "resolve2") result = w.resolve(hx(parts[1]), hx(parts[2]));
  else if (op === "resolve3") result = w.resolve(hx(parts[1]), hx(parts[2]), hx(parts[3]));
  console.log(xh(result));
}
`;
}

async function compileDriver(src: string, name: string): Promise<string> {
  const file = join(scratch, `${name}.ts`);
  await writeFile(file, src);
  const res = await compile(file, { outPath: `${file}.wasm`, outDir: scratch, dynamic: false, backend: "wasm" });
  if (!res.ok) throw new Error(`${name} refused: ${JSON.stringify(res.diagnostics)}`);
  return res.binaryPath;
}

/* ── the forced host (cwd "/" for both oracles' chdir("/"); own copy,
 * per §4 — never wasm-host.ts's shared instantiate) ───────────────────── */

function writeUtf16(memory: WebAssembly.Memory, s: string, ptr: number, cap: number): number {
  if (s.length > cap) return s.length;
  const view = new Uint16Array(memory.buffer, ptr, s.length);
  for (let i = 0; i < s.length; i++) view[i] = s.charCodeAt(i);
  return s.length;
}

async function runBatch(binaryPath: string, argv: readonly string[], cwd: string): Promise<string[]> {
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
        if (kind === 0) return argv.length;
        return 0;
      },
      exit(code: number): void {
        throw new Error(`unexpected exit(${code})`);
      },
    },
  });
  memory = instance.exports["memory"] as WebAssembly.Memory;
  (instance.exports["_start"] as () => void)();
  const out = Buffer.concat(chunks).toString("utf8");
  const lines = out.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.map(fromArgvHex);
}

/* ── the three-way run, per family ─────────────────────────────────────── */

interface Tally {
  count: number;
  pass: number;
  fail: number;
}

async function threeWay(
  familyName: "posix" | "win32",
  casesFilePath: string,
  ns: typeof nodePosix,
  moduleBinary: string,
  batchSize: number,
): Promise<{ tallies: Map<string, Tally>; mismatches: string[] }> {
  const text = await readFile(casesFilePath, "utf8");
  const rows = parseCaseFile(text);

  // column 2: the C driver, one pass over the whole file (no batching —
  // it never uses check()'s capped MISMATCH path, so nothing throttles it).
  const cAnswers = await runCDriver(casesFilePath);
  expect(cAnswers.length, `C driver: exactly one output line per input line (${familyName})`).toBe(rows.length);

  const tallies = new Map<string, Tally>();
  const mismatches: string[] = [];
  const bump = (op: string, ok: boolean) => {
    const t = tallies.get(op) ?? { count: 0, pass: 0, fail: 0 };
    t.count++;
    if (ok) t.pass++;
    else t.fail++;
    tallies.set(op, t);
  };

  for (let start = 0; start < rows.length; start += batchSize) {
    const batch = rows.slice(start, start + batchSize);
    const argv = ["scriptc", ...batch.map((r) => [r.op, ...r.args.map(toArgvHex)].join("\t"))];
    const moduleAnswers = await runBatch(moduleBinary, argv, "/");
    // Trap #2 (rev-26): a batch that stopped early is N MISSING results,
    // not zero mismatches — assert the count BEFORE indexing into it.
    expect(
      moduleAnswers.length,
      `module: exactly one output line per case in batch starting at row ${start} (${familyName})`,
    ).toBe(batch.length);

    for (let k = 0; k < batch.length; k++) {
      const row = batch[k]!;
      const expected = nodeAnswer(ns, row.op, row.args);
      const c = cAnswers[start + k]!;
      const m = moduleAnswers[k]!;
      const ok = c === expected && m === expected;
      bump(row.rawOp, ok);
      if (!ok && mismatches.length < 40) {
        // Trap #3 (rev-26): every mismatch prints op + fields in hex.
        mismatches.push(
          `line ${row.lineNo} ${row.rawOp}(${row.args.map(toArgvHex).join(",")}) ` +
            `node=${JSON.stringify(expected)}/${toArgvHex(expected)} ` +
            `c=${JSON.stringify(c)}/${toArgvHex(c)} ` +
            `module=${JSON.stringify(m)}/${toArgvHex(m)}`,
        );
      }
    }
  }
  return { tallies, mismatches };
}

function formatReport(familyName: string, tallies: Map<string, Tally>): string {
  const lines = [`${familyName} per-op report:`];
  for (const op of Array.from(tallies.keys()).sort()) {
    const t = tallies.get(op)!;
    lines.push(`  ${op}: ${t.pass}/${t.count} (fail=${t.fail})`);
  }
  return lines.join("\n");
}

describe("wasm path.ts three-way oracle (Node in-process vs C driver vs emitted module)", () => {
  let posixModule: string;
  let win32Module: string;
  beforeAll(async () => {
    posixModule = await compileDriver(posixDriverSource(), "posix-driver");
    win32Module = await compileDriver(win32DriverSource(), "win32-driver");
  }, 60_000);

  test(
    "posix: every path-cases-posix.txt row agrees Node == C == module",
    async () => {
      const { tallies, mismatches } = await threeWay(
        "posix",
        join(runtimeTestDir, "path-cases-posix.txt"),
        nodePosix,
        posixModule,
        1000,
      );
      const totalCases = Array.from(tallies.values()).reduce((s, t) => s + t.count, 0);
      const totalPass = Array.from(tallies.values()).reduce((s, t) => s + t.pass, 0);
      console.log(formatReport("posix", tallies));
      console.log(`posix TOTAL: ${totalPass}/${totalCases}`);
      expect(mismatches.join("\n")).toBe("");
      expect(totalPass).toBe(totalCases);
      expect(totalCases).toBe(41448);
    },
    120_000,
  );

  test(
    "win32: every path-cases.txt row agrees Node == C == module",
    async () => {
      const { tallies, mismatches } = await threeWay(
        "win32",
        join(runtimeTestDir, "path-cases.txt"),
        nodeWin32,
        win32Module,
        1000,
      );
      const totalCases = Array.from(tallies.values()).reduce((s, t) => s + t.count, 0);
      const totalPass = Array.from(tallies.values()).reduce((s, t) => s + t.pass, 0);
      console.log(formatReport("win32", tallies));
      console.log(`win32 TOTAL: ${totalPass}/${totalCases}`);
      expect(mismatches.join("\n")).toBe("");
      expect(totalPass).toBe(totalCases);
      expect(totalCases).toBe(38214);
    },
    120_000,
  );

  // SECOND-CWD ROWS: a cwd snapshot is captured ONCE per module instance
  // (D2/P1) — resolve/win32Resolve must read WHATEVER the host reports at
  // instantiation, not a value baked in from the "/" instantiation every
  // row above uses. Each family's rows run in their OWN instantiation
  // (own runBatch call) under a DIFFERENT forced cwd; the same trick as
  // Node's own oracle (prepending the alternate cwd as resolve's own
  // leftmost argument is mathematically identical to resolving under
  // that cwd, since resolve scans right-to-left and stops at the first
  // absolute segment — the standard way to test resolve without an
  // actual chdir) proves the two must agree only if the snapshot is real.
  test("second-cwd rows: resolve reads the per-instance snapshot, not a constant", async () => {
    const SECOND_CWD_POSIX = "/tmp/x";
    const SECOND_CWD_WIN32 = "C:\\Users\\x";
    interface Row {
      op: string;
      args: readonly string[];
    }
    const posixRows: Row[] = [
      { op: "resolve0", args: [] },
      { op: "resolve1", args: ["sub/dir"] },
      { op: "resolve1", args: ["."] },
      { op: "resolve2", args: ["a", "b"] },
      { op: "resolve2", args: ["..", "c"] },
      { op: "resolve3", args: ["a", "b", "c"] },
    ];
    const win32Rows: Row[] = [
      { op: "resolve0", args: [] },
      { op: "resolve1", args: ["sub\\dir"] },
      { op: "resolve1", args: ["."] },
      { op: "resolve2", args: ["a", "b"] },
      { op: "resolve2", args: ["..", "c"] },
      { op: "resolve3", args: ["a", "b", "c"] },
    ];

    const posixArgv = ["scriptc", ...posixRows.map((r) => [r.op, ...r.args.map(toArgvHex)].join("\t"))];
    const posixModuleAnswers = await runBatch(posixModule, posixArgv, SECOND_CWD_POSIX);
    expect(posixModuleAnswers.length).toBe(posixRows.length);
    for (let i = 0; i < posixRows.length; i++) {
      const expected = nodePosix.resolve(SECOND_CWD_POSIX, ...posixRows[i]!.args);
      expect(posixModuleAnswers[i], `posix ${posixRows[i]!.op}(${posixRows[i]!.args.join(",")})`).toBe(expected);
      // negative control: the SAME row must NOT match the "/" snapshot's
      // answer unless the two cwds coincidentally agree (they never do
      // here) — proving the module actually read SECOND_CWD, not "/".
      const rootExpected = nodePosix.resolve("/", ...posixRows[i]!.args);
      expect(posixModuleAnswers[i]).not.toBe(rootExpected);
    }

    const win32Argv = ["scriptc", ...win32Rows.map((r) => [r.op, ...r.args.map(toArgvHex)].join("\t"))];
    const win32ModuleAnswers = await runBatch(win32Module, win32Argv, SECOND_CWD_WIN32);
    expect(win32ModuleAnswers.length).toBe(win32Rows.length);
    for (let i = 0; i < win32Rows.length; i++) {
      const expected = nodeWin32.resolve(SECOND_CWD_WIN32, ...win32Rows[i]!.args);
      expect(win32ModuleAnswers[i], `win32 ${win32Rows[i]!.op}(${win32Rows[i]!.args.join(",")})`).toBe(expected);
    }
  });

  // PERMANENT ROW (rev-26 findings addendum, binding): every OTHER program in
  // this file calls resolve/win32Resolve somewhere too, which ALSO reaches
  // the cwd snapshot and so ALSO trips hostStrReachable's "found" flag —
  // meaning none of them can, by themselves, prove that hostStrReachable's
  // OWN "path.relative"/"path.win32Relative" entries (added to fix defect
  // #1: a relative()-only program crashed at COMPILE TIME with "tsinter.
  // hostStr was never imported") are what is actually doing the work. A
  // program that calls ONLY relative()/win32Relative() — no resolve, no
  // argv/env/cwd/platform read anywhere else — is the ONLY shape that
  // isolates this: if hostStrReachable's relative-specific entries were
  // ever silently removed again, THIS is the test that would start failing
  // (at compile time, not a value mismatch), while every batched row above
  // would keep passing right through the regression.
  test("relative-only programs (no resolve/argv/env/cwd/platform anywhere else) still compile and match Node", async () => {
    const posixSrc = `
import * as p from "node:path/posix";
console.log(p.relative("/a/b/c", "/a/d"));
`;
    const posixFile = join(scratch, "posix-relative-only.ts");
    await writeFile(posixFile, posixSrc);
    const posixRes = await compile(posixFile, {
      outPath: `${posixFile}.wasm`,
      outDir: scratch,
      dynamic: false,
      backend: "wasm",
    });
    if (!posixRes.ok) throw new Error(`posix relative-only refused: ${JSON.stringify(posixRes.diagnostics)}`);
    const posixOut = await runRelativeOnly(posixRes.binaryPath);
    expect(posixOut).toBe(nodePosix.relative("/a/b/c", "/a/d"));

    const win32Src = `
import * as w from "node:path/win32";
console.log(w.relative("C:\\\\a\\\\b\\\\c", "C:\\\\a\\\\d"));
`;
    const win32File = join(scratch, "win32-relative-only.ts");
    await writeFile(win32File, win32Src);
    const win32Res = await compile(win32File, {
      outPath: `${win32File}.wasm`,
      outDir: scratch,
      dynamic: false,
      backend: "wasm",
    });
    if (!win32Res.ok) throw new Error(`win32 relative-only refused: ${JSON.stringify(win32Res.diagnostics)}`);
    const win32Out = await runRelativeOnly(win32Res.binaryPath);
    expect(win32Out).toBe(nodeWin32.relative("C:\\a\\b\\c", "C:\\a\\d"));
  });
});

/** A minimal host for the relative-only permanent row. The PROGRAM never
 * touches argv/env/platform, but resolveHelper (which relative() calls
 * internally on BOTH its arguments) reads the cwd snapshot UNCONDITIONALLY
 * as the very first thing it does — even when every argument turns out to
 * be absolute and the snapshot is never actually needed for the final
 * answer — so this host must still answer kind=3 (cwd) with a real string,
 * never -1, or cwdSnapshotHelper's own read would be servicing a "no such
 * datum" answer for a fact that always exists on a real host. argv/env/
 * platform (kinds 0/1/2/4) are never reached by this program and answer -1
 * (unreachable, not exercised — hostStr/hostNum must still exist as
 * IMPORTS, which is the whole point of this row: hostStrReachable firing
 * for a relative()-only program is what declares them in the first place). */
async function runRelativeOnly(binaryPath: string): Promise<string> {
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
      hostStr(kind: number, _index: number, ptr: number, cap: number): number {
        if (kind === 3) return writeUtf16(memory!, "/unused-cwd", ptr, cap);
        return -1;
      },
      hostNum(): number {
        return 0;
      },
      exit(code: number): void {
        throw new Error(`unexpected exit(${code})`);
      },
    },
  });
  memory = instance.exports["memory"] as WebAssembly.Memory;
  (instance.exports["_start"] as () => void)();
  return Buffer.concat(chunks).toString("utf8").trim();
}
