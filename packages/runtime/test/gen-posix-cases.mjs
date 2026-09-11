// M-19: generate path.POSIX oracle cases with NODE as the oracle, in the exact
// wire format packages/runtime/test/test_path.c reads, with every op prefixed
// "p:" so my extended driver routes it to the scr_path_* (posix) family.
// The repo's committed path-cases.txt is win32-ONLY — this is the missing half.
// Both sides chdir("/") so the cwd-consulting ops are deterministic.
// M-19 ADDENDUM (impl-26-p2, 3C delta from the lead/rev-26 leg 6): the
// arity-extremes section near the end of this file (join0/join1/join4/
// join5/resolve0, ≥300 cases each) — the committed win32 file has only
// ONE case for each of those five arities, and the lowering reshapes
// exactly those arities, so this generator is the mitigation §3D needs.
import { posix } from "node:path";
import { stdout } from "node:process";
process.chdir("/");
const TAB = String.fromCharCode(9);
const hex = (s) => { const b = Buffer.from(s, "utf8"); return b.length ? b.toString("hex") : "-"; };
const lines = [];
const emit = (op, args, result) => lines.push(["p:" + op, ...args.map(hex), hex(result)].join(TAB));
const one = (op, fn, args) => { let r; try { r = fn(...args); } catch { return; } emit(op, args, typeof r === "boolean" ? String(r) : r); };

const atoms = [
  "", ".", "..", "/", "//", "///", "a", "ab", "a.b", ".a", "..a", "a..", "...",
  "a/", "/a", "/a/", "a//b", "a/./b", "a/../b", "./a", "../a", "a/..", "a/.",
  "/a/b", "/a/b/", "a/b/c", "/./", "/../", "/a/../b", "//a//b//", "a/b/../../c",
  ".hidden", ".hidden.txt", "file.", "file..", ".tar.gz", "x.tar.gz",
  " ", " /a", "a b/c d", String.fromCharCode(9), String.fromCharCode(10),
  "é", "日本", "🌍",
  "/".repeat(8), "a".repeat(200), "/" + "a/".repeat(40) + "b",
  "../../..", "/../../..", "..//..", "./././.", "/.hidden/", "-", "--",
];
for (const p of atoms) {
  one("normalize", posix.normalize, [p]);
  one("dirname", posix.dirname, [p]);
  one("basename", posix.basename, [p]);
  one("extname", posix.extname, [p]);
  one("isAbsolute", posix.isAbsolute, [p]);
  one("toNamespacedPath", posix.toNamespacedPath, [p]);
  one("resolve1", posix.resolve, [p]);
  one("join1", posix.join, [p]);
}
const sufs = ["", ".txt", ".TXT", "b", "bbb", "longer-than-path", "a/b", "/", ".", ".."];
for (const p of atoms) for (const s of sufs) one("basenameSuffix", posix.basename, [p, s]);
const seg = atoms.slice(0, 34);
for (const a of seg) for (const b of seg) { one("join2", posix.join, [a, b]); one("resolve2", posix.resolve, [a, b]); }
for (const a of seg.slice(0, 14)) for (const b of seg.slice(0, 14)) for (const c of seg.slice(0, 14)) {
  one("join3", posix.join, [a, b, c]); one("resolve3", posix.resolve, [a, b, c]);
}
for (const a of seg) for (const b of seg) one("relative", posix.relative, [a, b]);
one("join0", posix.join, []); one("resolve0", posix.resolve, []);

let s = 20260910 >>> 0;
const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
const pieces = ["/", "//", ".", "..", "a", "bb", ".c", "d.", "e.f", " ", "..g", "h..", "é", "🌍"];
const fuzz = [];
for (let i = 0; i < 4000; i++) {
  let p = "";
  const n = 1 + Math.floor(rnd() * 7);
  for (let k = 0; k < n; k++) p += pieces[Math.floor(rnd() * pieces.length)];
  fuzz.push(p);
}
for (const p of fuzz) {
  one("normalize", posix.normalize, [p]);
  one("dirname", posix.dirname, [p]);
  one("basename", posix.basename, [p]);
  one("extname", posix.extname, [p]);
  one("isAbsolute", posix.isAbsolute, [p]);
  one("resolve1", posix.resolve, [p]);
}
for (let i = 0; i + 1 < fuzz.length; i += 2) {
  one("join2", posix.join, [fuzz[i], fuzz[i + 1]]);
  one("resolve2", posix.resolve, [fuzz[i], fuzz[i + 1]]);
  one("relative", posix.relative, [fuzz[i], fuzz[i + 1]]);
}
// M-19 ADDENDUM (lead 3C delta, crossing-safe, rev-26 leg 6): the
// committed win32 file (path-cases.txt) has exactly ONE case each for
// join0/join1/join4/join5/resolve0 — the lowering reshapes exactly those
// arities, so THIS generator must be DENSE there instead, since it is
// the mitigation §3D leans on for that gap. join0/resolve0 are constant
// functions (join() === "."; resolve() === the cwd, always "/" here) —
// there is no distinct-input axis to vary, so "≥300 cases" here means
// 300 repeated exercises of that exact 0-ary call/pack shape (harmless
// duplicates, not padding for its own sake: the point is driver/dispatch
// volume at that arity, not answer diversity, which cannot exist for a
// nullary function). join1/join4/join5 DO vary — continuing the SAME
// seeded rnd()/pieces stream the fuzz section above already established
// (not a fresh seed), so the whole file stays one reproducible run.
for (let i = 0; i < 300; i++) {
  one("join0", posix.join, []);
  one("resolve0", posix.resolve, []);
}
const pick = (n) => {
  let p = "";
  const k = 1 + Math.floor(rnd() * 7);
  for (let j = 0; j < k; j++) p += pieces[Math.floor(rnd() * pieces.length)];
  return p;
};
for (let i = 0; i < 300; i++) one("join1", posix.join, [pick()]);
for (let i = 0; i < 300; i++) one("join4", posix.join, [pick(), pick(), pick(), pick()]);
for (let i = 0; i < 300; i++) one("join5", posix.join, [pick(), pick(), pick(), pick(), pick()]);

stdout.write(lines.join(String.fromCharCode(10)) + String.fromCharCode(10));
process.stderr.write(lines.length + " posix cases" + String.fromCharCode(10));
