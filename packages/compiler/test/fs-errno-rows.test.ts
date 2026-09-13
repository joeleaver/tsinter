/* INC-26 pass P4 (design-host-v7.txt §6.3, brief-p4-v2.md §3B, DECISIONS.md
 * P4-J1) — THE CHECK LANDS WITH THE DATA (P2-B-2's own shape): re-runs
 * gen-fs-errno-rows.mjs in a fresh process and diffs its output against the
 * COMMITTED fs-errno-rows.json. The placeholder substitution the generator
 * performs (every real scratch path -> "<PATH>", mkdtemp's own template
 * kept as "<PATH>XXXXXX") is what makes this diff PATH-INDEPENDENT despite
 * every run using a fresh mkdtemp directory — otherwise this test would
 * never pass twice in a row.
 *
 * ROOT POLICY IS AN ASSERTION, NOT A SKIP (L-3): if the CURRENT run's uid
 * class differs from the COMMITTED file's, this test FAILS with a message
 * naming both classes — EACCES rows exist only in the non-root class, and
 * a silent class mismatch would silently drop or gain those rows in a way
 * nothing else here would notice.
 *
 * fs.ts's OWN hand-written module table (its exported `OP_TABLE`/`CODES`)
 * is CHECKED AGAINST these SAME rows below — NOT a chain (rev-26's 3B
 * read P-3's own warning: "the module's table checked against the
 * generator's output alone, when the generator is checked against Node,
 * is a chain, not two instruments — every link inherits the first link's
 * error"). `OP_TABLE`/`CODES` are written from measurement independently
 * of this file's own committed rows (fs.ts's own header states as much);
 * this test is what makes that claim CHECKABLE rather than asserted. The
 * FORCED-HOST tests (wasm-host-fs-p4.test.ts, 3H) additionally exercise
 * the table end-to-end through a real compiled module — a THIRD
 * instrument, checking that the table is not merely well-FORMED but
 * actually WIRED into the emitted code. */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { CODES as MODULE_CODES, OP_TABLE } from "../src/backend/wasm/fs.js";

const GEN_PATH = join(import.meta.dirname, "gen-fs-errno-rows.mjs");
const COMMITTED_PATH = join(import.meta.dirname, "fs-errno-rows.json");

interface FsErrnoRow {
  op: number;
  key: string;
  code: string;
  errnoLinux: number | null;
  syscall: string | null;
  shape: string;
  message: string | null;
  className: string | null;
}

interface FsErrnoRowsFile {
  header: { generator: string; nodeVersion: string; platform: string; uidClass: "root" | "non-root" };
  rows: FsErrnoRow[];
  mkdirRecursiveReturn: { firstCreated: string; secondCreated: string | null };
}

function runGenerator(): FsErrnoRowsFile {
  const out = execFileSync(process.execPath, [GEN_PATH], { encoding: "utf8" });
  return JSON.parse(out) as FsErrnoRowsFile;
}

describe("fs-errno-rows: the generator matches the committed file", () => {
  const committed = JSON.parse(readFileSync(COMMITTED_PATH, "utf8")) as FsErrnoRowsFile;
  const fresh = runGenerator();

  test("the committed file parses and is non-empty", () => {
    expect(Array.isArray(committed.rows)).toBe(true);
    expect(committed.rows.length).toBeGreaterThan(0);
  });

  test("ROOT POLICY: the current run's uid class matches the committed file's (L-3 — an assertion, not a skip)", () => {
    expect(fresh.header.uidClass, `committed file was generated under uid class "${committed.header.uidClass}"; this run is "${fresh.header.uidClass}" — EACCES rows differ by class, so the committed file must be regenerated under the SAME class before this diff means anything`).toBe(
      committed.header.uidClass,
    );
  });

  test("every row in the committed file reproduces byte-for-byte (message included) from a fresh run", () => {
    // Rows are compared as a SET keyed on (op,key,code) — order is not
    // load-bearing (the generator's own internal ordering is incidental),
    // but every (op,key,code) triple in the committed file must have an
    // IDENTICAL row in a fresh run, and vice versa (no row silently
    // vanishes or gains an unannounced sibling).
    const keyOf = (r: FsErrnoRow): string => `${r.op}:${r.key}:${r.code}`;
    const committedByKey = new Map(committed.rows.map((r) => [keyOf(r), r]));
    const freshByKey = new Map(fresh.rows.map((r) => [keyOf(r), r]));

    const missingFromFresh = [...committedByKey.keys()].filter((k) => !freshByKey.has(k));
    const newInFresh = [...freshByKey.keys()].filter((k) => !committedByKey.has(k));
    expect({ missingFromFresh, newInFresh }).toEqual({ missingFromFresh: [], newInFresh: [] });

    for (const [k, committedRow] of committedByKey) {
      const freshRow = freshByKey.get(k)!;
      expect(freshRow, `row ${k}`).toEqual(committedRow);
    }
  });

  test("mkdirSync recursive's fenced return value reproduces (K-3/S073's second sentence)", () => {
    expect(fresh.mkdirRecursiveReturn.secondCreated).toBeNull();
    expect(committed.mkdirRecursiveReturn.secondCreated).toBeNull();
    // The FIRST-created path's SHAPE (placeholder + the literal suffix
    // mkdirSync appended) is what is load-bearing, not the scratch prefix.
    expect(fresh.mkdirRecursiveReturn.firstCreated.endsWith("/rec")).toBe(true);
    expect(committed.mkdirRecursiveReturn.firstCreated.endsWith("/rec")).toBe(true);
  });

  test("row-shape sanity: existsSync (op 19) is EXCLUDED entirely, never an empty row (L-2/A-9)", () => {
    expect(committed.rows.some((r) => r.key === "existsSync")).toBe(false);
    expect(fresh.rows.some((r) => r.key === "existsSync")).toBe(false);
  });

  test("the four transcription traps (L-2), read directly off the committed rows", () => {
    const find = (op: number, key: string, code: string): FsErrnoRow | undefined =>
      committed.rows.find((r) => r.op === op && r.key === key && r.code === code);

    // (a) EISDIR is `read`/NO PATH for readFileSync, `open`/WITH the path
    // for write/append.
    const readEisdir = find(1, "readFileSync", "EISDIR");
    expect(readEisdir?.syscall).toBe("read");
    expect(readEisdir?.shape).toBe("no-path");
    const writeEisdir = find(9, "writeFileSync", "EISDIR");
    expect(writeEisdir?.syscall).toBe("open");
    expect(writeEisdir?.shape).toBe("one-path");
    const appendEisdir = find(10, "appendFileSync", "EISDIR");
    expect(appendEisdir?.syscall).toBe("open");
    expect(appendEisdir?.shape).toBe("one-path");

    // (b) the syscall literal is the INTERNAL op, never the JS call name.
    expect(find(14, "rmSync", "ENOENT")?.syscall).toBe("lstat");
    expect(find(2, "readdirSync", "ENOENT")?.syscall).toBe("scandir");
    expect(find(3, "mkdtempSync", "ENOENT")?.syscall).toBe("mkdtemp");

    // (c) mkdtemp's path is the TEMPLATE, not the argument.
    expect(find(3, "mkdtempSync", "ENOENT")?.message).toBe("ENOENT: no such file or directory, mkdtemp '<PATH>XXXXXX'");

    // (d) existsSync excluded — covered by its own test above.
  });

  test("the rm-on-directory SPECIAL CASE (S073's second sentence) is a SystemError, not a plain Error", () => {
    const special = committed.rows.find((r) => r.op === 14 && r.key === "rmSync" && r.shape === "special-systemerror");
    expect(special?.className).toBe("SystemError");
    expect(special?.code).toBe("ERR_FS_EISDIR");
    expect(special?.message).toBe("Path is a directory: rm returned EISDIR (is a directory) <PATH>");
  });
});

describe("fs.ts's OWN table (OP_TABLE/CODES) cross-checked against the committed rows (rev-26's 3B read P-3)", () => {
  const committed = JSON.parse(readFileSync(COMMITTED_PATH, "utf8")) as FsErrnoRowsFile;

  // Six of the fourteen ordinary codes are NOT reachable from ordinary P4-
  // key inputs (N-2's own "D10 inversion" record) — the generator, which
  // only drives REAL fs operations, cannot manufacture EPERM/EBADF/
  // EMFILE/ENOSPC/EINVAL/EROFS without root, a depleted fd table, or a
  // read-only filesystem; those six get FORCED rows in 3H's own file
  // instead, which is the correct instrument for a code no ordinary input
  // reaches (design's own inversion of the D10 argument). ELOOP and
  // ENAMETOOLONG, conversely, ARE reachable (this generator constructs
  // both, via a symlink loop and an overlong path) and — per delta-3e
  // (e4da1096) R-1, ERRATUM E-P4-3 — are NOW among fs.ts's own named
  // codes (13/14, appended): they render Node's own exact wording, never
  // fall to the UNKNOWN arm on ordinary readFileSync inputs. They are
  // therefore NOT listed here — they belong in the ORDINARY reachable
  // set the test below checks, like any other code the generator hits.
  const CODES_NOT_REACHED_BY_GENERATOR: ReadonlySet<string> = new Set(["EPERM", "EBADF", "EMFILE", "ENOSPC", "EINVAL", "EROFS"]);

  test("every ORDINARY-INPUT-REACHABLE code in fs.ts's table matches a row's own code exactly (no transposition, no typo)", () => {
    const rowCodes = new Set(committed.rows.map((r) => r.code).filter((c) => c !== "ERR_FS_EISDIR"));
    for (const [name] of MODULE_CODES) {
      if (CODES_NOT_REACHED_BY_GENERATOR.has(name)) continue;
      expect(rowCodes.has(name), `fs.ts's CODES table names "${name}", which no committed row uses`).toBe(true);
    }
  });

  test("the six codes ordinary inputs cannot reach are named, not silently absent", () => {
    const rowCodes = new Set(committed.rows.map((r) => r.code));
    for (const name of CODES_NOT_REACHED_BY_GENERATOR) {
      expect(rowCodes.has(name), `${name} WAS reached by the generator — the exclusion list is stale, update it`).toBe(false);
    }
  });

  test("every committed row's code is EITHER one of fs.ts's fourteen OR the rm-special ERR_FS_EISDIR — never an UNKNOWN-arm code masquerading as a named one (delta-3e R-1: ELOOP/ENAMETOOLONG are NOW named, codes 13/14 — no more carve-out)", () => {
    const moduleCodeNames = new Set(MODULE_CODES.map(([name]) => name));
    for (const row of committed.rows) {
      if (row.shape === "special-systemerror") {
        expect(row.code).toBe("ERR_FS_EISDIR");
        continue;
      }
      expect(moduleCodeNames.has(row.code), `row op=${row.op} key=${row.key} has code "${row.code}", which is not one of fs.ts's fourteen`).toBe(true);
    }
  });

  test("every OP_TABLE entry's (syscall, shape) matches the committed rows for every code that row reaches, INCLUDING the op-1 EISDIR override", () => {
    for (const entry of OP_TABLE) {
      const rowsForOp = committed.rows.filter((r) => r.op === entry.op && r.shape !== "special-systemerror");
      expect(rowsForOp.length, `op ${entry.op} (${entry.keys.join("/")}) has no committed rows to check against`).toBeGreaterThan(0);
      for (const row of rowsForOp) {
        const isEisdirOverride = entry.eisdirOverride !== null && row.code === "EISDIR";
        const expectedSyscall = isEisdirOverride ? entry.eisdirOverride!.syscall : entry.syscall;
        const expectedShape = isEisdirOverride ? entry.eisdirOverride!.shape : entry.shape;
        const rowShape = row.shape === "no-path" ? "no" : row.shape === "one-path" ? "one" : row.shape;
        expect(row.syscall, `op ${entry.op} code ${row.code}: syscall`).toBe(expectedSyscall);
        expect(rowShape, `op ${entry.op} code ${row.code}: shape`).toBe(expectedShape);
      }
    }
  });

  test("op 14's rm-on-directory SPECIAL CASE is NOT part of OP_TABLE's ordinary (syscall,shape) — it is checked separately, by design", () => {
    const op14 = OP_TABLE.find((e) => e.op === 14)!;
    expect(op14.eisdirOverride).toBeNull();
    // The special row exists in the committed rows but under its OWN
    // shape tag, excluded from the loop above by construction.
    const special = committed.rows.find((r) => r.op === 14 && r.shape === "special-systemerror");
    expect(special).toBeDefined();
  });
});
