#!/usr/bin/env node
/* INC-26 pass P4 (design-host-v7.txt §6.3, brief-p4-v2.md §3B) — GENERATES
 * fs-errno-rows.json by driving `node:fs` against every P4 op's reachable
 * failure, in a fresh mkdtemp directory, on THIS machine's real filesystem.
 * NODE IS THE ORACLE (CLAUDE.md) — this file's OUTPUT is what fs.ts's
 * hand-written module table is CHECKED against (A-3's two instruments);
 * it is never transcribed from design-host-v7.txt's own §6.3 table (the
 * design's own text: "the table below is the DESIGN's statement of the
 * shape and the rule; it is not the artefact P4 pins against").
 *
 * THE FOUR TRANSCRIPTION TRAPS this generator exists to catch mechanically
 * (rev-26's fserrno-p4.out 4f383ce6, independently re-measured by impl-26-p4
 * this pass, cp1-plan-p4.txt §8): (a) EISDIR is `read`/NO PATH for
 * readFileSync and `open`/WITH the path for writeFile/appendFile — the ONE
 * op-1-specific exception in the whole op×code matrix; (b) rmSync's syscall
 * literal is `lstat`, readdirSync's is `scandir` — the INTERNAL op, never
 * the JS call name; (c) mkdtempSync's path is the TEMPLATE (prefix +
 * "XXXXXX"), never the raw argument; (d) existsSync NEVER THROWS and is
 * EXCLUDED here entirely, never emitted as an empty row.
 *
 * ROOT POLICY IS AN ASSERTION, NOT A SKIP (L-3): this file's header records
 * `process.getuid()`'s CLASS ("root" | "non-root"); fs-errno-rows.test.ts
 * FAILS if the current run's class differs from the committed file's —
 * EACCES rows exist ONLY in the non-root class.
 *
 * THE PLACEHOLDER: every row's `message` has its real, ephemeral scratch
 * path(s) substituted with the literal string "<PATH>" (mkdtempSync's own
 * template keeps its "XXXXXX" suffix visible: "<PATH>XXXXXX") — this is
 * what makes the committed file's diff test path-independent (P2-B-2's own
 * shape) despite every run using a FRESH mkdtemp directory.
 *
 * Run directly: `node gen-fs-errno-rows.mjs` prints the rows array to
 * stdout as JSON (fs-errno-rows.test.ts captures this and diffs it against
 * the committed fs-errno-rows.json; this file itself never writes the
 * committed file — that is a manual `node gen-fs-errno-rows.mjs >
 * fs-errno-rows.json` step, done once per intentional change and committed
 * like any other source file). */
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  mkdirSync,
  rmdirSync,
  unlinkSync,
  readdirSync,
  accessSync,
  symlinkSync,
  chmodSync,
  constants,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PLACEHOLDER = "<PATH>";

/** Substitute every occurrence of each real path (LONGEST first, so a path
 * that is a prefix of another substitutes correctly) with the placeholder. */
function scrub(message, ...paths) {
  const sorted = [...paths].filter((p) => typeof p === "string" && p.length > 0).sort((a, b) => b.length - a.length);
  let out = message;
  for (const p of sorted) out = out.split(p).join(PLACEHOLDER);
  return out;
}

const rows = [];

/** Run `fn`, expect it to THROW, and record one row. `paths` are the real
 * scratch paths this call used, for message scrubbing — pass the TEMPLATE
 * PREFIX (not the full template) for mkdtemp so "XXXXXX" stays visible. */
function expectRow(op, key, paths, fn) {
  try {
    const r = fn();
    throw new Error(`gen-fs-errno-rows: ${key} did not throw (returned ${JSON.stringify(r)})`);
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("gen-fs-errno-rows:")) throw e;
    const shape = paths.length === 0 ? "no-path" : paths.length === 1 ? "one-path" : "two-path";
    rows.push({
      op,
      key,
      code: e.code,
      errnoLinux: e.errno,
      syscall: e.syscall ?? null,
      shape,
      message: scrub(e.message, ...paths),
      className: e.constructor.name,
    });
  }
}

/** Same shape, for the rm-on-directory SPECIAL CASE (S073's second
 * sentence): Node throws a DIFFERENT error class here (SystemError, not a
 * plain Error), and this row is marked `shape: "special-systemerror"` so
 * fs.ts's own table treats it OUTSIDE the ordinary (op,code) lookup. */
function expectSpecialRow(op, key, paths, fn) {
  try {
    const r = fn();
    throw new Error(`gen-fs-errno-rows: ${key} did not throw (returned ${JSON.stringify(r)})`);
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("gen-fs-errno-rows:")) throw e;
    rows.push({
      op,
      key,
      code: e.code,
      errnoLinux: e.errno ?? null,
      syscall: e.syscall ?? null,
      shape: "special-systemerror",
      message: scrub(e.message, ...paths),
      className: e.constructor.name,
    });
  }
}

const root = mkdtempSync(join(tmpdir(), "fs-errno-gen-"));
const dir = join(root, "sub");
mkdirSync(dir);
const file = join(root, "f.txt");
writeFileSync(file, "x");
const missing = join(root, "nope");
const missingParent = join(root, "nope", "y");

const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

// ── op 1 — readFileSync ─────────────────────────────────────────────────
expectRow(1, "readFileSync", [missing], () => readFileSync(missing));
expectRow(1, "readFileSync", [], () => readFileSync(dir)); // EISDIR: read, NO PATH
expectRow(1, "readFileSync", [join(file, "y")], () => readFileSync(join(file, "y"))); // ENOTDIR
if (!isRoot) {
  const noPerm = join(root, "noperm.txt");
  writeFileSync(noPerm, "x");
  chmodSync(noPerm, 0o000);
  expectRow(1, "readFileSync", [noPerm], () => readFileSync(noPerm)); // EACCES
} else {
  rows.push({ op: 1, key: "readFileSync", code: "EACCES", errnoLinux: 13, syscall: "open", shape: "SKIPPED-ROOT", message: null, className: null });
}
{
  const a = join(root, "loop-a");
  const b = join(root, "loop-b");
  symlinkSync(b, a);
  symlinkSync(a, b);
  expectRow(1, "readFileSync", [join(root, "loop-a")], () => readFileSync(join(root, "loop-a"))); // ELOOP
}
expectRow(1, "readFileSync", ["x".repeat(5000)], () => readFileSync("x".repeat(5000))); // ENAMETOOLONG

// ── op 2 — readdirSync ──────────────────────────────────────────────────
expectRow(2, "readdirSync", [missing], () => readdirSync(missing));
expectRow(2, "readdirSync", [file], () => readdirSync(file));

// ── op 3 — mkdtempSync (the TEMPLATE message rule) ──────────────────────
{
  const prefix = join(missing, "p-");
  expectRow(3, "mkdtempSync", [prefix], () => mkdtempSync(prefix));
}

// ── op 9 — writeFileSync ────────────────────────────────────────────────
expectRow(9, "writeFileSync", [missingParent], () => writeFileSync(missingParent, "x"));
expectRow(9, "writeFileSync", [dir], () => writeFileSync(dir, "x")); // EISDIR: open, WITH path

// ── op 10 — appendFileSync ───────────────────────────────────────────────
expectRow(10, "appendFileSync", [missingParent], () => appendFileSync(missingParent, "x"));
expectRow(10, "appendFileSync", [dir], () => appendFileSync(dir, "x")); // EISDIR: open, WITH path

// ── op 11 — mkdirSync (recursive=0) and mkdirRecursiveSync (recursive=1) ─
expectRow(11, "mkdirSync", [dir], () => mkdirSync(dir)); // EEXIST
expectRow(11, "mkdirSync", [missingParent], () => mkdirSync(missingParent)); // ENOENT
expectRow(11, "mkdirSync", [join(file, "y")], () => mkdirSync(join(file, "y")));
expectRow(11, "mkdirRecursiveSync", [join(file, "y")], () => mkdirSync(join(file, "y"), { recursive: true })); // ENOTDIR

// ── op 12 — rmdirSync ────────────────────────────────────────────────────
expectRow(12, "rmdirSync", [missing], () => rmdirSync(missing));
expectRow(12, "rmdirSync", [file], () => rmdirSync(file));
{
  const nonEmpty = join(root, "ne");
  mkdirSync(nonEmpty);
  writeFileSync(join(nonEmpty, "z"), "z");
  expectRow(12, "rmdirSync", [nonEmpty], () => rmdirSync(nonEmpty));
}

// ── op 13 — unlinkSync (S-1: BUILT, reached by no P4 program) ──────────
expectRow(13, "unlinkSync", [missing], () => unlinkSync(missing));
// unlinkSync's EISDIR carries the path (measured: unlike readFileSync's
// op-1 EISDIR exception, unlinkSync's does NOT drop it) — pass [dir] so
// the placeholder substitution is correct, never assumed no-path.
expectRow(13, "unlinkSync", [dir], () => unlinkSync(dir));

// ── op 14 — rmSync / rmOptsSync ─────────────────────────────────────────
expectRow(14, "rmSync", [missing], () => rmSync(missing)); // ENOENT, syscall lstat
{
  const dir2 = join(root, "sub2");
  mkdirSync(dir2);
  expectSpecialRow(14, "rmSync", [dir2], () => rmSync(dir2)); // SPECIAL: SystemError ERR_FS_EISDIR
}
// rmOptsSync shares op 14 with rmSync (the SAME wasm-level dispatch, two
// frontend keys per the (recursive,force) bool arity) — one row proving
// the shared op number produces the IDENTICAL row shape from the OTHER key.
expectRow(14, "rmOptsSync", [missing], () => rmSync(missing, { recursive: false, force: false }));
{
  // force=true swallows ENOENT silently — proves the NON-throwing branch,
  // not a row (recorded as a note, not an error row).
  rmSync(join(root, "definitely-not-there"), { force: true });
}

// ── op 20 — accessSync ──────────────────────────────────────────────────
expectRow(20, "accessSync", [missing], () => accessSync(missing));
if (!isRoot) {
  const roFile = join(root, "ro.txt");
  writeFileSync(roFile, "x");
  chmodSync(roFile, 0o444);
  expectRow(20, "accessSync", [roFile], () => accessSync(roFile, constants.W_OK));
} else {
  rows.push({ op: 20, key: "accessSync", code: "EACCES", errnoLinux: 13, syscall: "access", shape: "SKIPPED-ROOT", message: null, className: null });
}

// ── mkdirSync recursive's fenced return value (K-3/S073's second
// sentence) — NOT an error row, recorded for the register's own evidence,
// under a separate top-level key so the diff test does not confuse it
// with an (op,code) row. ─────────────────────────────────────────────────
const recPath = join(root, "rec", "a", "b");
const firstCreated = mkdirSync(recPath, { recursive: true });
const secondCreated = mkdirSync(recPath, { recursive: true });

const header = {
  generator: "gen-fs-errno-rows.mjs",
  nodeVersion: process.version,
  platform: process.platform,
  uidClass: isRoot ? "root" : "non-root",
};

const output = {
  header,
  rows,
  mkdirRecursiveReturn: {
    firstCreated: scrub(String(firstCreated), root),
    secondCreated: secondCreated === undefined ? null : scrub(String(secondCreated), root),
  },
};

process.stdout.write(JSON.stringify(output, null, 2) + "\n");
