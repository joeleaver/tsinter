#!/usr/bin/env node
/* Generates packages/runtime/src/scr_zone_names.h — the native lanes' table
 * of the zone names Node prints in Date#toString ("(Central Standard
 * Time)"), SEMANTICS.md S113. Node's name is ICU's long display name of the
 * zone for standard or daylight time (V8's ICUTimezoneCache::LocalTimezone,
 * en-US under a C/POSIX/English locale), chosen by ICU's DST flag; a native
 * binary has no ICU, so it reads the C library's DST flag (tm_isdst) and
 * this table maps (zone, flag) to the name Node prints.
 *
 * The table is MEASURED, not transcribed: for every zone name the system
 * tzdata knows (/usr/share/zoneinfo/tzdata.zi, Zones and Links) and every
 * zone Intl lists, this script sets process.env.TZ (Node re-reads its zone)
 * and reads String(new Date(t)) at noon UTC of every day from 1970 to 2037
 * — every instant V8 decides a name at (it maps the others to an
 * "equivalent" instant in that range first) — and pairs each name with the
 * C library's tm_isdst for the same zone and instant (a small C helper this
 * script compiles with `cc`). Each flag maps to the name Node printed most
 * often with it; the minority samples (a zone whose C library flag and ICU
 * flag disagree for some period — the tzdata versions differ, or the zone
 * has negative DST in one data format and not the other) are counted and
 * printed, and the header records them per zone.
 *
 *   node scripts/gen-zone-names.mjs           # rewrite the header
 *   node scripts/gen-zone-names.mjs --check   # require byte-identity
 *
 * Run it with the pinned Node (v24.18.1) under LC_ALL=C. */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outPath = join(root, "packages/runtime/src/scr_zone_names.h");
const check = process.argv.includes("--check");

for (const v of ["LC_ALL", "LC_MESSAGES", "LANG"]) {
  const val = process.env[v];
  if (val !== undefined && val !== "" && !/^(C|POSIX|en_US)([._@].*)?$/.test(val)) {
    throw new Error(`run under an English or C locale (${v}=${val}): Node's zone names follow the locale`);
  }
}

const zi = readFileSync("/usr/share/zoneinfo/tzdata.zi", "utf8");
const tzVersion = /^# version (\S+)/m.exec(zi)?.[1] ?? "?";
const ids = new Set();
for (const line of zi.split("\n")) {
  const f = line.split(/\s+/);
  if (f[0] === "Z") ids.add(f[1]);
  else if (f[0] === "L") ids.add(f[2]);
}
for (const z of Intl.supportedValuesOf("timeZone")) ids.add(z);
const zones = [...ids].sort();

// Noon UTC of every day, 1970-01-01 .. 2037-12-31.
const samples = [];
for (let t = Date.UTC(1970, 0, 1, 12); t < Date.UTC(2038, 0, 1); t += 86400000) samples.push(t);

const work = mkdtempSync(join(tmpdir(), "gen-zone-names-"));
let flags;
try {
  writeFileSync(
    join(work, "isdst.c"),
    `#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <time.h>
int main(int argc, char **argv) {
  long long first = atoll(argv[1]), step = atoll(argv[2]), count = atoll(argv[3]);
  for (int a = 4; a < argc; a++) {
    setenv("TZ", argv[a], 1);
    tzset();
    for (long long i = 0; i < count; i++) {
      time_t t = (time_t)((first + i * step) / 1000);
      struct tm tm;
      putchar(localtime_r(&t, &tm) != NULL && tm.tm_isdst > 0 ? '1' : '0');
    }
    putchar('\\n');
  }
  return 0;
}
`,
  );
  execFileSync("cc", ["-O1", "-o", join(work, "isdst"), join(work, "isdst.c")]);
  const out = execFileSync(join(work, "isdst"), [String(samples[0]), "86400000", String(samples.length), ...zones], {
    encoding: "utf8",
    maxBuffer: 1 << 30,
  });
  flags = out.split("\n");
} finally {
  rmSync(work, { recursive: true, force: true });
}

const savedTz = process.env.TZ;
const names = new Map(); // name -> index
const nameIndex = (n) => {
  if (!names.has(n)) names.set(n, names.size);
  return names.get(n);
};
const rows = [];
const residue = [];
for (let zi2 = 0; zi2 < zones.length; zi2++) {
  const id = zones[zi2];
  process.env.TZ = id;
  const counts = [new Map(), new Map()];
  const zf = flags[zi2];
  for (let i = 0; i < samples.length; i++) {
    const s = String(new Date(samples[i]));
    const name = s.slice(s.indexOf("(") + 1, -1);
    const m = counts[zf[i] === "1" ? 1 : 0];
    m.set(name, (m.get(name) ?? 0) + 1);
  }
  const pick = (m) => [...m.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0];
  const std = pick(counts[0]);
  const dst = pick(counts[1]);
  // A flag the C library never raised in range keeps the other flag's name.
  const stdName = std ? std[0] : dst[0];
  const dstName = dst ? dst[0] : stdName;
  let minority = 0;
  for (const [m, chosen] of [[counts[0], stdName], [counts[1], dstName]]) {
    for (const [n, c] of m) if (n !== chosen) minority += c;
  }
  if (minority > 0) residue.push(`${id}: ${minority}`);
  rows.push({ id, std: nameIndex(stdName), dst: nameIndex(dstName), minority });
}
if (savedTz === undefined) delete process.env.TZ;
else process.env.TZ = savedTz;

const cstr = (s) => JSON.stringify(s).replace(/[\u0080-￿]/g, (ch) => [...Buffer.from(ch, "utf8")].map((b) => `\\x${b.toString(16)}`).join("") + '""');
let h = `/* GENERATED by scripts/gen-zone-names.mjs — do not edit.
 * Node ${process.version} (ICU ${process.versions.icu}, CLDR ${process.versions.cldr}, tz ${process.versions.tz}),
 * C library DST flags from tzdata ${tzVersion}; ${zones.length} zones, ${names.size} names.
 * Each zone's name for tm_isdst 0 and 1 (SEMANTICS.md S113); a zone whose
 * C library flag disagreed with ICU's for some sampled days carries that
 * day count in \`minority\` (the days whose name the table cannot match).
 * Minority zones: ${residue.length === 0 ? "none" : residue.length}. */
#ifndef SCR_ZONE_NAMES_H
#define SCR_ZONE_NAMES_H

static const char *const scr_zone_name_strs[${names.size}] = {
`;
for (const n of names.keys()) h += `  ${cstr(n)},\n`;
h += `};

typedef struct {
  const char *id;
  unsigned short std_name, dst_name;
  unsigned short minority;
} ScrZoneName;

/* Sorted by id (strcmp order) for bsearch. */
static const ScrZoneName scr_zone_names[${rows.length}] = {
`;
rows.sort((a, b) => (Buffer.compare(Buffer.from(a.id), Buffer.from(b.id))));
for (const r of rows) h += `  {${cstr(r.id)}, ${r.std}, ${r.dst}, ${Math.min(r.minority, 65535)}},\n`;
h += `};

#endif /* SCR_ZONE_NAMES_H */
`;

if (check) {
  const have = readFileSync(outPath, "utf8");
  if (have !== h) {
    console.error(`${outPath} does not reproduce`);
    process.exit(1);
  }
  console.log(`${outPath} reproduces byte-identically`);
} else {
  writeFileSync(outPath, h);
  console.log(`wrote ${outPath}: ${rows.length} zones, ${names.size} names; minority zones: ${residue.join(", ") || "none"}`);
}
