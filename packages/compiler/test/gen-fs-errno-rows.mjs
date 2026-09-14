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
  // INC-26 P5 (brief-p5-v3.md §3B, CP1 delta 29286fa4): the new ops' own
  // Node drivers.
  realpathSync,
  closeSync,
  fstatSync,
  readSync,
  chownSync,
  openSync,
  copyFileSync,
  statSync,
  lstatSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// INC-26 P5 (rev-26's 3B read, findings-rev26-3b-p5.txt bdbc0b6d/256, B-2
// BLOCKING): the fsp REJECTION AXIS's GENERATOR HALF — pure Node, no
// compiler dependency, driving fsp.<op> and recording that the
// rejection's own `.message` equals the sync sibling's (v3 §3B/ruling
// A-6: every twinned row asserted TWICE).
import * as fsp from "node:fs/promises";

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

// INC-26 P5 (B-2 BLOCKING): the fsp REJECTION AXIS, a SEPARATE class from
// `rows` (never mixed into it — the OP_TABLE cross-check iterates `rows`
// BY OP assuming the ordinary sync shapes; a rejection row carries no
// `syscall`/`shape` of its own, only the identity check against its own
// sync sibling's ALREADY-RECORDED message). One row per (op, fsp key,
// code) triple that HAS a sync sibling row already in `rows` by the time
// this runs (every rejection call below is made AFTER all the sync rows
// above, using the SAME scratch fixtures).
const rejectionRows = [];

/** Await `fn`, expect it to REJECT, and record whether the rejection's
 * (scrubbed) message equals the sync sibling row's own message — v3's
 * own "every row asserted twice" identity, PROVEN here rather than
 * assumed (ruling A-6). `paths` are the SAME real scratch paths the
 * sync call used, for identical scrubbing. */
async function expectRejectionRow(op, syncKey, fspKey, code, paths, fn) {
  let caught = null;
  try {
    const r = await fn();
    throw new Error(`gen-fs-errno-rows: ${fspKey} did not reject (resolved ${JSON.stringify(r)})`);
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("gen-fs-errno-rows:")) throw e;
    caught = e;
  }
  const scrubbed = scrub(caught.message, ...paths);
  const syncRow = rows.find((r) => r.op === op && r.key === syncKey && r.code === code);
  if (syncRow === undefined) {
    throw new Error(`gen-fs-errno-rows: no sync row (op=${op} key=${syncKey} code=${code}) to match ${fspKey} against — the sync row must be recorded BEFORE this call runs`);
  }
  rejectionRows.push({
    op,
    syncKey,
    fspKey,
    code,
    className: caught.constructor.name,
    matchesSync: scrubbed === syncRow.message && caught.code === code,
    rejectionMessage: scrubbed,
    syncMessage: syncRow.message,
  });
}

/** The SAME identity check for op 14's rm-on-directory SPECIAL CASE
 * (SystemError, not the ordinary code lookup) — `fsp.rm`'s own rejection
 * on a directory without `recursive`. */
async function expectSpecialRejectionRow(op, syncKey, fspKey, paths, fn) {
  let caught = null;
  try {
    const r = await fn();
    throw new Error(`gen-fs-errno-rows: ${fspKey} did not reject (resolved ${JSON.stringify(r)})`);
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("gen-fs-errno-rows:")) throw e;
    caught = e;
  }
  const scrubbed = scrub(caught.message, ...paths);
  const syncRow = rows.find((r) => r.op === op && r.key === syncKey && r.shape === "special-systemerror");
  if (syncRow === undefined) {
    throw new Error(`gen-fs-errno-rows: no special sync row (op=${op} key=${syncKey}) to match ${fspKey} against`);
  }
  rejectionRows.push({
    op,
    syncKey,
    fspKey,
    code: caught.code,
    className: caught.constructor.name,
    matchesSync: scrubbed === syncRow.message && caught.code === syncRow.code,
    rejectionMessage: scrubbed,
    syncMessage: syncRow.message,
  });
}

/** op 4 (realpathSync) ONLY (B-3, brief §6c/§7): the failing PATH in the
 * message is NOT a function of the input argument — it is the argument
 * RESOLVED (symlinks replaced, `.`/`..` applied) then TRUNCATED at the
 * first failing component under ENOENT, or reported WHOLE under ENOTDIR
 * — so the scrub target must be Node's OWN reported `e.path`, never the
 * caller's input argument (measured this session: `e.path` gives the
 * EXACT substring appearing in `e.message` in every case, including the
 * truncated one). `syscall` is read from `e.syscall` too (per-code: the
 * OP_TABLE codeOverrides ELOOP->`stat` this generator's own row must
 * agree with, not assume). */
function expectRealpathRow(op, key, fn) {
  try {
    const r = fn();
    throw new Error(`gen-fs-errno-rows: ${key} did not throw (returned ${JSON.stringify(r)})`);
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("gen-fs-errno-rows:")) throw e;
    rows.push({
      op,
      key,
      code: e.code,
      errnoLinux: e.errno,
      syscall: e.syscall ?? null,
      shape: "one-path",
      message: scrub(e.message, e.path ?? ""),
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

// ── INC-26 P5 (brief-p5-v3.md §3B/§6c, CP1 delta 29286fa4) — the twelve
// new ops. Op 2 (readdirTypesSync, D-8) and op 14 (rmRetrySync, C-2) add
// only a KEY to their P4 rows above, no new row: measured byte-identical
// text across all option shapes (probes/p5/p5-rmretry-row.out), so
// nothing further is generated for either here. ────────────────────────

// ── op 4 — realpathSync (B-3/B-4: NO placeholder — e.path is the scrub
// target; syscall is PER-CODE, `stat` under ELOOP, `lstat` elsewhere) ───
expectRealpathRow(4, "realpathSync", () => realpathSync(missing)); // ENOENT
// NOTE: realpath(join(missing,"a","b")) ALSO answers ENOENT with the
// SAME truncated <PATH> after scrubbing (e.path resolves to `missing`
// either way) — this generator's rows are keyed on (op,key,code), which
// cannot distinguish "argument already the failing component" from
// "argument truncated down to it," so a second row here would silently
// collapse onto the one above in the diff test's own (op,key,code) map.
// The TRUNCATION RULE ITSELF (B-3) is real and load-bearing — it is
// verified as its own forced-host row in wasm-host-fs-p5.test.ts (§9),
// which can assert on TWO DIFFERENT ARGUMENTS producing the SAME
// rendered path, not as a second entry in this file's row set.
expectRealpathRow(4, "realpathSync", () => realpathSync(join(file, "sub"))); // ENOTDIR, whole argument
{
  const loopA = join(root, "loop4-a");
  const loopB = join(root, "loop4-b");
  symlinkSync(loopB, loopA);
  symlinkSync(loopA, loopB);
  expectRealpathRow(4, "realpathSync", () => realpathSync(loopA)); // ELOOP, syscall override -> stat
}

// ── op 5 — readFdSync (ENCODED form; design §2: syscall is `read`
// ALWAYS, same failure shape as op 6's own readSync) ─────────────────────
{
  const buf5 = Buffer.alloc(4);
  expectRow(5, "readFdSync", [], () => readSync(999999, buf5, 0, 4, null)); // EBADF, no path
}

// ── op 6 — readSync(fd, buffer, offset, length, position) ──────────────
{
  const buf6 = Buffer.alloc(4);
  expectRow(6, "readSync", [], () => readSync(999999, buf6, 0, 4, null)); // EBADF, no path
}

// ── op 7 — statSync ──────────────────────────────────────────────────────
expectRow(7, "statSync", [missing], () => statSync(missing)); // ENOENT

// ── op 8 — lstatSync ─────────────────────────────────────────────────────
expectRow(8, "lstatSync", [missing], () => lstatSync(missing)); // ENOENT

// ── op 15 — copyFileSync (TWO-PATH shape; the EISDIR trap needs a REAL
// dest dir — copyFileSync(dir, missingParent) answers ENOENT instead,
// the missing parent wins) ────────────────────────────────────────────
expectRow(15, "copyFileSync", [missing, join(root, "cpdst")], () => copyFileSync(missing, join(root, "cpdst"))); // ENOENT (src)
expectRow(15, "copyFileSync", [dir, join(root, "cp-eisdir-dst")], () => copyFileSync(dir, join(root, "cp-eisdir-dst"))); // EISDIR — real dest parent (root) exists
// NOTE: copyFileSync(dir, join(missing,"cpdst")) — the "missing dest
// PARENT wins over EISDIR" trap (rev's own measured gotcha) — ALSO
// answers ENOENT with byte-identical scrubbed text to the first row
// above (both "ENOENT: ..., copyfile '<PATH>' -> '<PATH>'"), so a third
// row here would silently collapse under this generator's (op,key,code)
// keying, exactly as realpath's truncation case does above. The trap
// itself (WHICH CODE fires, not just the text) is verified as its own
// forced-host row in wasm-host-fs-p5.test.ts (§9).

// ── op 16 — chmodSync ────────────────────────────────────────────────────
expectRow(16, "chmodSync", [missing], () => chmodSync(missing, 0o644)); // ENOENT

// ── op 17 — chownSync ────────────────────────────────────────────────────
expectRow(17, "chownSync", [missing], () => chownSync(missing, process.getuid?.() ?? 0, process.getgid?.() ?? 0)); // ENOENT

// ── op 18 — closeSync ────────────────────────────────────────────────────
expectRow(18, "closeSync", [], () => closeSync(999999)); // EBADF, no path

// ── op 21 — openSync ─────────────────────────────────────────────────────
expectRow(21, "openSync", [missing], () => openSync(missing, "r")); // ENOENT
expectRow(21, "openSync", [dir], () => openSync(dir, "w")); // EISDIR

// ── op 22 — fstatFd(fd) — readFdSyncBytes's FIRST stage ─────────────────
expectRow(22, "readFdSyncBytes", [], () => fstatSync(999999)); // EBADF, no path

// ── op 23 — readFdInto(fd) — readFdSyncBytes's SECOND stage (same `read`
// syscall literal as op 6; a DISTINCT (op,key,code) triple even though
// the message text is byte-identical to op 6's own EBADF row) ──────────
{
  const buf23 = Buffer.alloc(4);
  expectRow(23, "readFdSyncBytes", [], () => readSync(999999, buf23, 0, 4, null)); // EBADF, no path
}

// ── INC-26 P5 (B-2 BLOCKING) — the fsp REJECTION AXIS's GENERATOR HALF.
// Every twinned (op,code) row above, re-driven through its fsp.* async
// counterpart, using the SAME scratch fixtures (root/dir/file/missing/
// missingParent/loop-a/loop-b/noperm.txt all still stand on disk — none
// of the sync tests above deleted them; rmSync's own EISDIR special case
// THROWS before deleting anything, so `sub2` also still stands). Ten
// sync-key groups (readFileSync's own 6 rows counted TWICE — once for
// fsp.readFile, once for fsp.readFileBytes, B-1's own shadow, R-5):
// 6+6+2+2+1+3+1+2+2+1 = 26 rejection rows. ─────────────────────────────

// fsp.readFile (op 1, encoded form — readFileSync's own 6 rows).
await expectRejectionRow(1, "readFileSync", "fsp.readFile", "ENOENT", [missing], () => fsp.readFile(missing, "utf8"));
await expectRejectionRow(1, "readFileSync", "fsp.readFile", "EISDIR", [], () => fsp.readFile(dir, "utf8"));
await expectRejectionRow(1, "readFileSync", "fsp.readFile", "ENOTDIR", [join(file, "y")], () => fsp.readFile(join(file, "y"), "utf8"));
if (!isRoot) {
  await expectRejectionRow(1, "readFileSync", "fsp.readFile", "EACCES", [join(root, "noperm.txt")], () => fsp.readFile(join(root, "noperm.txt"), "utf8"));
}
await expectRejectionRow(1, "readFileSync", "fsp.readFile", "ELOOP", [join(root, "loop-a")], () => fsp.readFile(join(root, "loop-a"), "utf8"));
await expectRejectionRow(1, "readFileSync", "fsp.readFile", "ENAMETOOLONG", ["x".repeat(5000)], () => fsp.readFile("x".repeat(5000), "utf8"));

// fsp.readFileBytes (op 1, Buffer form — B-1's own newly-registered key;
// SAME 6 rows, a SEPARATE fsp key from fsp.readFile above, R-5's own
// "currently count as ZERO" shadow, now fixed).
await expectRejectionRow(1, "readFileSync", "fsp.readFileBytes", "ENOENT", [missing], () => fsp.readFile(missing));
await expectRejectionRow(1, "readFileSync", "fsp.readFileBytes", "EISDIR", [], () => fsp.readFile(dir));
await expectRejectionRow(1, "readFileSync", "fsp.readFileBytes", "ENOTDIR", [join(file, "y")], () => fsp.readFile(join(file, "y")));
if (!isRoot) {
  await expectRejectionRow(1, "readFileSync", "fsp.readFileBytes", "EACCES", [join(root, "noperm.txt")], () => fsp.readFile(join(root, "noperm.txt")));
}
await expectRejectionRow(1, "readFileSync", "fsp.readFileBytes", "ELOOP", [join(root, "loop-a")], () => fsp.readFile(join(root, "loop-a")));
await expectRejectionRow(1, "readFileSync", "fsp.readFileBytes", "ENAMETOOLONG", ["x".repeat(5000)], () => fsp.readFile("x".repeat(5000)));

// fsp.writeFile (op 9, writeFileSync's own 2 rows).
await expectRejectionRow(9, "writeFileSync", "fsp.writeFile", "ENOENT", [missingParent], () => fsp.writeFile(missingParent, "x"));
await expectRejectionRow(9, "writeFileSync", "fsp.writeFile", "EISDIR", [dir], () => fsp.writeFile(dir, "x"));

// fsp.rm (op 14, rmSync's own 2 rows — the ORDINARY ENOENT row and the
// SPECIAL rm-on-directory SystemError row; rmOptsSync's own single row
// is NOT twinned, rev's own note — fsp has no rmOpts counterpart).
await expectRejectionRow(14, "rmSync", "fsp.rm", "ENOENT", [missing], () => fsp.rm(missing));
await expectSpecialRejectionRow(14, "rmSync", "fsp.rm", [join(root, "sub2")], () => fsp.rm(join(root, "sub2")));

// fsp.stat (op 7, statSync's own 1 row).
await expectRejectionRow(7, "statSync", "fsp.stat", "ENOENT", [missing], () => fsp.stat(missing));

// fsp.mkdir (op 11, mkdirSync's own 3 rows, non-recursive).
await expectRejectionRow(11, "mkdirSync", "fsp.mkdir", "EEXIST", [dir], () => fsp.mkdir(dir));
await expectRejectionRow(11, "mkdirSync", "fsp.mkdir", "ENOENT", [missingParent], () => fsp.mkdir(missingParent));
await expectRejectionRow(11, "mkdirSync", "fsp.mkdir", "ENOTDIR", [join(file, "y")], () => fsp.mkdir(join(file, "y")));

// fsp.mkdirRecursiveMode (op 11, mkdirRecursiveSync's own 1 row).
await expectRejectionRow(11, "mkdirRecursiveSync", "fsp.mkdirRecursiveMode", "ENOTDIR", [join(file, "y")], () => fsp.mkdir(join(file, "y"), { recursive: true }));

// fsp.readdir (op 2, readdirSync's own 2 rows).
await expectRejectionRow(2, "readdirSync", "fsp.readdir", "ENOENT", [missing], () => fsp.readdir(missing));
await expectRejectionRow(2, "readdirSync", "fsp.readdir", "ENOTDIR", [file], () => fsp.readdir(file));

// fsp.unlink (op 13, unlinkSync's own 2 rows).
await expectRejectionRow(13, "unlinkSync", "fsp.unlink", "ENOENT", [missing], () => fsp.unlink(missing));
await expectRejectionRow(13, "unlinkSync", "fsp.unlink", "EISDIR", [dir], () => fsp.unlink(dir));

// fsp.chmod (op 16, chmodSync's own 1 row).
await expectRejectionRow(16, "chmodSync", "fsp.chmod", "ENOENT", [missing], () => fsp.chmod(missing, 0o644));

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
  rejectionRows,
  mkdirRecursiveReturn: {
    firstCreated: scrub(String(firstCreated), root),
    secondCreated: secondCreated === undefined ? null : scrub(String(secondCreated), root),
  },
};

process.stdout.write(JSON.stringify(output, null, 2) + "\n");
