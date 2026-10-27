/* The local-time-zone matrix (SEMANTICS.md S113): compiled programs run on
 * every lane under several TZ values and must print what Node prints under
 * the same TZ. The corpus runs under the machine's one zone; this file is
 * what shows local time FOLLOWS the zone — a DST gap and overlap, half-hour
 * and 45-minute zones, local mean time before 1900 (seconds kept), a zone
 * ICU does not know, an unset and an empty TZ, and the TZ shapes ICU reads
 * differently from the C library (prefixes, fixed names, POSIX strings).
 *
 * Lanes: Node (the oracle, a child with the TZ); the c and llvm binaries (a
 * child with the TZ — the C library's zone); the WasmGC module, run in this
 * process by the shared test host, whose tzCall answers from this process's
 * own Date — so this file sets process.env.TZ around each wasm run (Node
 * re-reads its zone on the assignment) and puts it back.
 *
 * The engine program (Date inside __island_eval) runs on c and llvm only:
 * the WasmGC tier's engine still answers local time in UTC (S103 (e)) until
 * its localtime is wired to tzCall.
 *
 * Children run under LC_ALL=C: Node's zone NAMES follow the locale, the
 * native lanes print the English ones (S113). */
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { compile } from "@tsinter/compiler";
import { runWasm } from "../../packages/compiler/test/wasm-host.js";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const islandShim = join(repoRoot, "tests/harness/island-shim.mjs");
const sanitize = process.env["SCRIPTC_SAN"] === "1";

/** "-" = TZ unset (the machine's zone). */
const ZONES = [
  "America/Chicago",
  "Asia/Kolkata",
  "Australia/Lord_Howe",
  "Europe/London",
  "UTC",
  "America/St_Johns",
  "Pacific/Chatham",
  "Asia/Kathmandu",
  "Invalid/Zone",
  "",
  "-",
  // TZ values ICU reads differently from the C library (S113): prefixes
  // ICU strips, names it fixes at the C library's standard offset, POSIX
  // strings it replaces with the system zone.
  "posix/Asia/Tokyo",
  "right/Asia/Tokyo",
  ":Asia/Tokyo",
  ":/etc/localtime",
  "/usr/share/zoneinfo/Asia/Tokyo",
  "UTC+3",
  "GMT-2",
  "JST-9",
  "<+0330>-3:30",
  "EST5EDT,M3.2.0,M11.1.0",
  "EST5EDT",
  "Asia/Tokyo/",
];

// The static tier: offset-less date-times are local time (date.parseGetTime).
const STATIC_SRC = `const rows = [
  "2020-03-08T02:30:00", "2020-03-08T03:30:00", "2020-11-01T01:30:00", "2020-11-01T02:00:00",
  "2020-03-29T01:30:00", "2020-10-25T01:30:00", "2020-10-04T02:15:00", "2020-04-05T01:45:00",
  "2020-04-05T02:50:00", "2020-09-27T02:50:00", "1880-01-01T00:00:00", "1800-06-15T12:34:56.789",
  "1970-01-01T00:00", "2020-06-01T24:00", "2020-06-01T24:00:01", "+275760-09-12T23:00",
  "+275760-09-13T00:00", "-271821-04-20T00:00", "-271821-04-19T23:59", "2150-07-01T12:00",
  "2020-06-01T12:00Z", "2020-06-01",
];
for (const s of rows) console.log(s, new Date(s).getTime());
`;

// The engine: every local-time Date surface the island has.
const ENGINE_SRC = `// @dynamic
console.log(__island_eval(\`
var out = [];
var show = function (l, f) { var v; try { v = f(); } catch (e) { v = "THROW " + e.name; } out.push(l + " " + String(v)); };
[0, 1579089600000, 1594814400000, -2840097600000, -846633600000, -5364662400000, 5752857600000, 1604212200000, 1583656200000].forEach(function (t) {
  var d = new Date(t);
  show("toString", function () { return d.toString(); });
  show("tzo", function () { return d.getTimezoneOffset(); });
  show("fields", function () { return [d.getFullYear(), d.getMonth(), d.getDate(), d.getDay(), d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds()].join(":"); });
  show("timeString", function () { return d.toTimeString(); });
  show("dateString", function () { return d.toDateString(); });
});
["2020-03-08T02:30:00", "2020-11-01T01:30:00", "2020-10-04T02:15:00", "2020-04-05T01:45:00", "1880-01-01T00:00:00", "2020-06-01T24:00", "Jan 1 2020", "2020/06/01 12:00"].forEach(function (s) {
  show("parse " + s, function () { return Date.parse(s); });
});
show("ctor gap", function () { return new Date(2020, 2, 8, 2, 30).getTime(); });
show("ctor overlap", function () { return new Date(2020, 10, 1, 1, 30).getTime(); });
show("ctor lmt", function () { return new Date(1880, 0, 1).getTime(); });
show("setHours", function () { var d = new Date(Date.UTC(2020, 5, 1)); d.setHours(3); return d.getTime(); });
show("setMinutes gap", function () { var d = new Date(2020, 2, 8, 1, 0); d.setMinutes(90); return d.getTime(); });
out.join("\\\\n");
\`));
`;

let work: string;
const bins: Record<string, Partial<Record<"c" | "llvm" | "wasm", string>>> = {};

async function build(name: string, src: string, dynamic: boolean, lanes: ("c" | "llvm" | "wasm")[]): Promise<void> {
  const file = join(work, `${name}.ts`);
  writeFileSync(file, src);
  bins[name] = {};
  for (const backend of lanes) {
    const outDir = join(work, `${name}-${backend}`);
    mkdirSync(outDir, { recursive: true });
    const res = await compile(file, {
      outPath: join(outDir, backend === "wasm" ? `${name}.wasm` : name),
      outDir,
      backend,
      dynamic,
      sanitize: backend === "wasm" ? false : sanitize,
    });
    if (!res.ok) throw new Error(`${name} (${backend}) refused: ${res.diagnostics.map((d) => d.message).join("; ")}`);
    bins[name]![backend] = res.binaryPath;
  }
}

function childEnv(tz: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, LC_ALL: "C" };
  if (tz === "-") delete env["TZ"];
  else env["TZ"] = tz;
  return env;
}

async function runChild(cmd: string, args: string[], tz: string): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, { encoding: "utf8", env: childEnv(tz) });
    return stdout + stderr;
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: unknown };
    return `${e.stdout ?? ""}${e.stderr ?? ""}[exit ${String(e.code)}]`;
  }
}

async function runWasmUnder(path: string, tz: string): Promise<string> {
  const had = Object.prototype.hasOwnProperty.call(process.env, "TZ");
  const saved = process.env["TZ"];
  if (tz === "-") delete process.env["TZ"];
  else process.env["TZ"] = tz;
  try {
    const r = await runWasm(path);
    return r.stdout + r.stderr + (r.exitCode !== 0 ? `[exit ${r.exitCode}]` : "");
  } finally {
    if (had) process.env["TZ"] = saved;
    else delete process.env["TZ"];
  }
}

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), "tsinter-tz-matrix-"));
  await build("static", STATIC_SRC, false, ["c", "llvm", "wasm"]);
  await build("engine", ENGINE_SRC, true, ["c", "llvm"]);
}, 600_000);

afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

describe(`local time follows the zone on every lane (S113)${sanitize ? ", sanitized" : ""}`, () => {
  for (const name of ["static", "engine"]) {
    for (const tz of ZONES) {
      test(`${name} under TZ=${tz === "-" ? "(unset)" : JSON.stringify(tz)}`, async () => {
        const want = await runChild(
          "node",
          ["--experimental-transform-types", "--disable-warning=ExperimentalWarning", "--import", islandShim, join(work, `${name}.ts`)],
          tz,
        );
        expect(want).not.toMatch(/\[exit/);
        for (const [lane, path] of Object.entries(bins[name]!)) {
          const got = lane === "wasm" ? await runWasmUnder(path, tz) : await runChild(path, [], tz);
          expect(`${lane}:\n${got}`).toBe(`${lane}:\n${want}`);
        }
      }, 120_000);
    }
  }
});
