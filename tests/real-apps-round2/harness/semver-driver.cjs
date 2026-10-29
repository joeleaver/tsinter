// A version-resolution CLI over semver 7.8.5 (CommonJS, as published).
//   main.cjs table                fixed table of parse/compare/satisfies/inc/coerce
//   main.cjs fuzz <seed> <n>      n random versions x ranges, checks invariants
//   main.cjs resolve <file>       "name range" lines against a fixed registry
const semver = require("./lib/index.js");
const fs = require("node:fs");

const args = process.argv.slice(2);

function table() {
  const vs = ["1.2.3", "v1.2.3", "=1.2.3", "1.2.3-alpha.1", "1.2.3-alpha.10", "1.2.3-alpha.beta", "1.2.3+build.5",
    "01.2.3", "1.2", "not a version", "  2.0.0  ", "1.2.3-0", "10.0.0-rc.1+sha.abc", "0.0.0", "999999999999999999.0.0"];
  for (const v of vs) {
    const p = semver.parse(v);
    console.log(JSON.stringify(v), "valid:", semver.valid(v), "clean:", semver.clean(v),
      p ? `maj=${p.major} min=${p.minor} pat=${p.patch} pre=${JSON.stringify(p.prerelease)} build=${JSON.stringify(p.build)}` : "null");
  }
  const sorted = semver.sort(vs.filter((v) => semver.valid(v)));
  console.log("sorted:", sorted.join(" "));
  console.log("rsorted:", semver.rsort(sorted.slice()).join(" "));
  const ranges = ["^1.2.0", "~1.2", ">=1.2.3 <2.0.0-0", "1.x || >=3.0.0", "1.2.3 - 2.3", "*", "", ">1.2.3-alpha.1", "^0.0.3", "~0.2.3", "invalid range !!"];
  for (const r of ranges) {
    let vr;
    try { vr = semver.validRange(r); } catch (e) { vr = "THROW " + e.message; }
    console.log(JSON.stringify(r), "=>", JSON.stringify(vr), "max:", semver.maxSatisfying(sorted, r), "min:", semver.minSatisfying(sorted, r),
      "sat:", sorted.filter((v) => semver.satisfies(v, r)).join(","));
  }
  for (const rel of ["major", "minor", "patch", "premajor", "preminor", "prepatch", "prerelease", "release"]) {
    console.log(rel, semver.inc("1.2.3", rel), semver.inc("1.2.3-beta.4", rel, "beta"), semver.inc("1.2.3", rel, "rc", "1"));
  }
  for (const c of ["v2", "3.1 build", "x4.5.6y", "1.2.3.4.5", "42", "", "10.20.30-pre", "v1.2.3-foo+bar"]) {
    const co = semver.coerce(c, { includePrerelease: true });
    console.log("coerce", JSON.stringify(c), co ? co.version : null);
  }
  console.log("diff", semver.diff("1.2.3", "1.3.0"), semver.diff("1.2.3", "2.0.0-pre"), semver.diff("1.2.3", "1.2.3"));
  console.log("gtr", semver.gtr("3.0.0", "^2.0.0"), "ltr", semver.ltr("1.0.0", "^2.0.0"), "outside", semver.outside("3.0.0", "^2.0.0", ">"));
  console.log("intersects", semver.intersects("^1.2.0", "~1.3.0"), semver.intersects(">2.0.0", "<1.0.0"));
  console.log("subset", semver.subset("^1.2.3", "^1.0.0"), semver.subset("^1.0.0", "^1.2.3"));
  console.log("minVersion", String(semver.minVersion(">=1.2.3 <2 || ^3.0.0")));
  console.log("simplify", semver.simplifyRange(["1.0.0", "1.1.0", "1.2.0", "2.0.0"], ">=1.0.0 <2.0.0"));
  const r = new semver.Range(">=1.2.3 <2.0.0 || 3.x");
  console.log("range set", r.set.map((cs) => cs.map((c) => c.value).join(" ")).join(" | "), "str", r.format());
  try { new semver.SemVer("bad"); } catch (e) { console.log("SemVer threw", e.constructor.name, e.message); }
  console.log("cmp", semver.cmp("1.2.3", "<", "1.2.4"), semver.compareBuild("1.0.0+2", "1.0.0+10"), semver.compareLoose("1.2.3", "v1.2.3"));
}

function fuzz(seed, n) {
  let s = seed >>> 0;
  const rnd = (k) => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return (s >>> 8) % k; };
  const pre = ["", "-alpha", "-alpha.1", "-beta.2", "-rc.10", "-0", "-x.y.z"];
  const mkV = () => `${rnd(4)}.${rnd(5)}.${rnd(6)}${pre[rnd(pre.length)]}${rnd(6) === 0 ? "+b" + rnd(9) : ""}`;
  const ops = ["^", "~", ">=", "<=", ">", "<", "=", ""];
  const mkR = () => {
    const k = rnd(3);
    const parts = [];
    for (let i = 0; i <= k; i++) {
      const sh = rnd(5);
      if (sh === 0) parts.push(`${mkV()} - ${mkV()}`);
      else if (sh === 1) parts.push(`${rnd(4)}.x`);
      else parts.push(ops[rnd(ops.length)] + mkV());
    }
    return parts.join(rnd(2) === 0 ? " " : " || ");
  };
  const vs = [];
  for (let i = 0; i < 40; i++) vs.push(mkV());
  let h = 0;
  for (let i = 0; i < n; i++) {
    const r = mkR();
    const inc = rnd(2) === 0;
    const sat = vs.filter((v) => semver.satisfies(v, r, { includePrerelease: inc }));
    const mx = semver.maxSatisfying(vs, r, { includePrerelease: inc });
    const mn = semver.minVersion(r);
    const a = vs[rnd(vs.length)], b = vs[rnd(vs.length)];
    const line = `#${i} ${r} :: ${sat.length} max=${mx} min=${mn} ${a} ${b} cmp=${semver.compare(a, b)} diff=${semver.diff(a, b)} inc=${semver.inc(a, "prerelease", "rc")}`;
    for (let j = 0; j < line.length; j++) h = (Math.imul(h, 31) + line.charCodeAt(j)) | 0;
    console.log(line);
  }
  console.log("sorted", semver.sort(vs.slice()).join(" "));
  console.log("hash", h);
}

function resolve(file) {
  const registry = { left: ["1.0.0", "1.0.1", "1.1.0", "2.0.0-beta.1", "2.0.0"], right: ["0.1.0", "0.2.0", "0.2.5", "1.0.0-rc.1"] };
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const [name, ...rest] = line.split(" ");
    const range = rest.join(" ");
    const avail = registry[name] || [];
    console.log(`${name}@${range} -> ${semver.maxSatisfying(avail, range) ?? "none"}`);
  }
}

if (args[0] === "table") table();
else if (args[0] === "fuzz") fuzz(Number(args[1]), Number(args[2]));
else if (args[0] === "resolve") resolve(args[1]);
else { console.error("usage: table|fuzz|resolve"); process.exitCode = 2; }
