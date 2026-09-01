/* INC-24 P1, CP3: live invocation of the CP1 bcsize tool as the
 * lre_compile byte-comparison ORACLE (design §6.1/§9.2 — "the strongest
 * available gate: it turns 'did we port the compiler correctly' from a
 * semantic question into a byte comparison"). bcsize already dumps FULL
 * lre_compile output (8-byte header + bytecode, hex, no separator) per
 * pattern via a TSV-in/TSV-out protocol — this just batches a whole
 * corpus through ONE subprocess call rather than one per pattern.
 *
 * The compiled binary lives OUT OF REPO (durable build dir, same as
 * CP1's own bcsize-validation record) since it's a build-time C tool,
 * not a repo/CI artifact — see findings-p1-v1.txt's CP1 section for why.
 * Rebuilt fresh here (not assumed present) so a stale binary can never
 * silently diverge from the vendored source it links. */
import { execFileSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const BUILD_DIR = "/home/joe/.claude/projects/-home-joe-dev-tsinter/inc24-work/inc24/impl-p1/build/bcsize";
const BCSIZE_C = "/home/joe/.claude/projects/-home-joe-dev-tsinter/inc24-work/inc24/des/probes/bcsize/bcsize.c";
const VENDOR = "/home/joe/dev/tsinter/.claude/worktrees/inc24-impl/packages/runtime/vendor/quickjs-ng";
const BIN = join(BUILD_DIR, "bcsize");
const LOCK_PATH = join(BUILD_DIR, "bcsize.lock");
const TMP_BIN = join(BUILD_DIR, "bcsize.tmp");
const SOURCES = [BCSIZE_C, join(VENDOR, "libregexp.c"), join(VENDOR, "libunicode.c"), join(VENDOR, "libregexp.h"), join(VENDOR, "libunicode.h")];

function sourceMtimeMax(): number {
  let max = 0;
  for (const p of SOURCES) {
    if (existsSync(p)) {
      const mtime = statSync(p).mtimeMs;
      if (mtime > max) max = mtime;
    }
  }
  return max;
}

function binaryIsFresh(): boolean {
  return existsSync(BIN) && statSync(BIN).mtimeMs > sourceMtimeMax();
}

/** A synchronous sleep via Atomics.wait on a throwaway SharedArrayBuffer
 * — Node has no synchronous timer, and spawning a `sleep` subprocess per
 * poll would itself add contention to the exact resource this function
 * exists to protect. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Build-once guard, hardened against PARALLEL test-file workers racing
 * gcc against the SAME out-of-repo binary (rev-24's finding: a full-
 * suite run showed transient bytecode mismatches that did not reproduce
 * in isolation or on a repeat run — diagnosed as concurrent rebuilds of
 * this exact binary stepping on each other, not a regex-engine bug; see
 * findings-p1-v1.txt). `built` alone (a plain module-level boolean) was
 * NOT sufficient: vitest gives each test FILE its own module instance,
 * so `built` never survives across files running in the SAME worker
 * pool — every file's own ensureBuilt() independently saw `built=false`
 * and tried to rebuild, all writing to the SAME BIN path concurrently.
 *
 * Fix, in two layers: (1) a FRESHNESS CHECK (binary mtime vs every
 * source file's mtime) — once ONE process has built the binary, every
 * OTHER process's ensureBuilt() takes this fast path and never touches
 * gcc at all, which is what actually eliminates the race in the common
 * case (the binary from an earlier session, or from a `git status`-
 * clean vendor tree, is already fresh far more often than not). (2) for
 * the genuine cold-build case, an EXCLUSIVE-CREATE lockfile (`wx` —
 * atomically fails if the file already exists, a real cross-process
 * mutex, not a check-then-act race) so only ONE process's gcc actually
 * runs; the rest poll for the lock to clear, then re-check freshness
 * instead of racing their own build. The actual gcc invocation writes
 * to a TEMP path and RENAMES it into place — POSIX rename is atomic, so
 * no reader (including a process that skipped the lock because it saw
 * the binary as already fresh, in a narrow window) can ever observe a
 * partially-written binary. */
let built = false;
function ensureBuilt(): void {
  if (built) return;
  mkdirSync(BUILD_DIR, { recursive: true });

  if (binaryIsFresh()) {
    built = true;
    return;
  }

  let haveLock = false;
  try {
    closeSync(openSync(LOCK_PATH, "wx"));
    haveLock = true;
  } catch {
    haveLock = false;
  }

  if (!haveLock) {
    // Someone else is building. Wait for the lock to clear, then trust
    // the freshness check — do NOT race our own gcc invocation against
    // theirs.
    const deadline = Date.now() + 60_000;
    while (existsSync(LOCK_PATH) && Date.now() < deadline) sleepSync(100);
    if (binaryIsFresh()) {
      built = true;
      return;
    }
    // The other builder appears to have crashed or vanished without
    // producing a fresh binary (lock cleared, still stale) — fall
    // through and try to build it ourselves rather than hang forever.
  }

  try {
    execFileSync("gcc", ["-O2", "-I", VENDOR, "-o", TMP_BIN, BCSIZE_C, join(VENDOR, "libregexp.c"), join(VENDOR, "libunicode.c"), "-lm"]);
    renameSync(TMP_BIN, BIN); // atomic — no reader ever sees a partial write
  } finally {
    if (haveLock) {
      try {
        unlinkSync(LOCK_PATH);
      } catch {
        // already gone — fine, another process's cleanup or a manual clear
      }
    }
  }
  built = true;
}

export interface LreCompileResult {
  bytes: Uint8Array;
  captures: number;
}

/** Encodes a JS string BY UTF-16 CODE UNIT (charCodeAt, not codePointAt)
 * — every code unit 0x0000-0xFFFF, INCLUDING lone/paired surrogates
 * (0xD800-0xDFFF), gets its own independent UTF-8-style byte sequence
 * (1/2/3 bytes), with NO surrogate-pair combining. This is what
 * lre_compile's own UTF-8 decoder expects for a NON-unicode pattern:
 * verified empirically against the live binary — a raw astral literal
 * (e.g. the claim corpus's bare 😀 pattern, no /u) fed as STANDARD UTF-8
 * (which Node's default string->Buffer conversion produces, auto-
 * combining the surrogate pair into one 4-byte sequence) makes
 * lre_compile reject it with "malformed unicode char"; the SAME
 * pattern, byte-for-byte per-code-unit-encoded instead, compiles
 * successfully into two REOP_char emissions (one per surrogate) —
 * exactly matching this port's own parser distinction (getClassAtom's
 * codePointAt-vs-charCodeAt split by isUnicode, regex-charclass.ts). */
function encodeWtf8PerCodeUnit(s: string): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const cu = s.charCodeAt(i);
    if (cu < 0x80) {
      bytes.push(cu);
    } else if (cu < 0x800) {
      bytes.push(0xc0 | (cu >> 6), 0x80 | (cu & 0x3f));
    } else {
      bytes.push(0xe0 | (cu >> 12), 0x80 | ((cu >> 6) & 0x3f), 0x80 | (cu & 0x3f));
    }
  }
  return bytes;
}

/** Encodes one (pattern, flags) TSV row as raw bytes, choosing the
 * encoding lre_compile actually wants for THIS row: standard UTF-8
 * (Buffer's own encoder, which auto-combines a valid surrogate pair
 * into a single 4-byte astral sequence) when `flags` includes `u` —
 * unicode mode wants FULL CODEPOINTS; encodeWtf8PerCodeUnit (no pair-
 * combining) otherwise — non-unicode mode wants each UTF-16 code unit
 * independently, matching non-u JS semantics. `flags` itself is ASCII
 * always (g/i/m/s/u/y), so it's encoded the same way regardless. */
function encodeTsvRow(pattern: string, flags: string): number[] {
  const patternBytes = flags.includes("u") ? [...Buffer.from(pattern, "utf8")] : encodeWtf8PerCodeUnit(pattern);
  const flagsBytes = [...Buffer.from(flags, "utf8")];
  return [...patternBytes, 0x09 /* \t */, ...flagsBytes, 0x0a /* \n */];
}

/** Compiles a batch of (pattern, flags) pairs through the REAL
 * lre_compile via bcsize, one subprocess call for the whole batch.
 * Returns a Map keyed by `${pattern} ${flags}` (an embedded tab in
 * a pattern would otherwise collide with the TSV format — none of this
 * port's patterns do, but the key format makes that assumption explicit
 * rather than silent) to the reference's exact output bytes (header +
 * bytecode, no trailer — this port's own generated corpus never uses
 * named captures YET, so the group-names trailer is out of scope for
 * this first oracle cut; revisit when CP3 reaches named groups). `null`
 * for a pattern bcsize reports ERR on (should never happen for this
 * port's in-scope corpus; a null surfaces as a hard test failure, not a
 * silent skip). */
export function lreCompileBatch(cases: readonly { pattern: string; flags: string }[]): Map<string, LreCompileResult | null> {
  ensureBuilt();
  // A raw byte Buffer, not a joined string encoded once — different
  // rows can need DIFFERENT encodings (encodeTsvRow's own doc), so each
  // row's bytes are built independently and concatenated. The output
  // side still safely `.toString("utf8")`s the WHOLE response: `\t`/`\n`
  // never appear inside a valid OR WTF-8-malformed-as-UTF8 sequence, so
  // column/line splitting stays correct even where an echoed non-u
  // astral pattern's bytes decode as U+FFFD replacement characters —
  // only the hex bytecode column (never touched by this encoding
  // question) is actually read back into results.
  const input = Buffer.from(cases.flatMap((c) => encodeTsvRow(c.pattern, c.flags)));
  const output = execFileSync(BIN, [], { input, maxBuffer: 64 * 1024 * 1024 }).toString("utf8");
  const results = new Map<string, LreCompileResult | null>();
  const lines = output.split("\n").filter((l) => l.length > 0);
  let i = 0;
  for (const { pattern, flags } of cases) {
    const key = `${pattern} ${flags}`;
    const line = lines[i++];
    if (line === undefined) {
      results.set(key, null);
      continue;
    }
    if (line.startsWith("ERR\t")) {
      results.set(key, null);
      continue;
    }
    const cols = line.split("\t");
    const capturesCol = cols[2]; // "captures=N"
    const hex = cols[3];
    if (capturesCol === undefined || hex === undefined) {
      results.set(key, null);
      continue;
    }
    const captures = Number(capturesCol.replace("captures=", ""));
    const bytes = new Uint8Array(hex.length / 2);
    for (let b = 0; b < bytes.length; b++) bytes[b] = parseInt(hex.substr(b * 2, 2), 16);
    results.set(key, { bytes, captures });
  }
  return results;
}

/** Single-pattern convenience wrapper over lreCompileBatch. */
export function lreCompile(pattern: string, flags: string): LreCompileResult | null {
  return lreCompileBatch([{ pattern, flags }]).get(`${pattern} ${flags}`) ?? null;
}

/** Archives one canary run's raw output for the record, mirroring CP1's
 * own bcsize-validation-out-hex archival discipline. Called explicitly
 * from a test, never as an import-time side effect. */
export function archiveCanaryRun(): void {
  ensureBuilt();
  const canary = lreCompile("a", "");
  if (canary) {
    writeFileSync(
      "/home/joe/.claude/projects/-home-joe-dev-tsinter/inc24-work/inc24/impl-p1/cp3-oracle-canary-v1.txt",
      `/a/ (no flags) via live lre_compile, ${canary.bytes.length} bytes, captures=${canary.captures}\n` +
        [...canary.bytes].map((b) => b.toString(16).padStart(2, "0")).join(""),
    );
  }
}
