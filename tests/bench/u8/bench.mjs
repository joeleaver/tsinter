// node tests/bench/u8/bench.mjs [--runs 5] [--lanes node,wasm,wasm-native] [--only b2,len] [--out dir]
//
// The U8 loop timings (docs/design/u8-dynamic-speed.md §2): for each probe of
// gen.mjs, builds its 5,000-round form (20M operations) and its 0-round form on
// each lane, checks each lane's output against Node's, and prints the median
// loop time, the 5,000-round run minus the 0-round run, so parsing,
// instantiation and start-up cancel out. For people to read, never a CI gate:
// the CI speed checks count boxes (wasm-u8a-loop.test.ts).
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import ts from "typescript";

const repo = join(import.meta.dirname, "../..", "..");
const { values } = parseArgs({
  options: {
    runs: { type: "string", default: "5" },
    lanes: { type: "string", default: "node,wasm,wasm-native" },
    only: { type: "string" },
    out: { type: "string", default: join(repo, "node_modules/.cache/tsinter-u8-bench") },
  },
});
const RUNS = Math.max(1, Number(values.runs));
const lanes = values.lanes.split(",");
const only = values.only?.split(",");
const cli = join(repo, "packages/cli/dist/main.js");
const host = join(repo, "tests/bench/run-wasm.mjs");
for (const [variant, rounds] of [["hi", 5000], ["lo", 0]]) {
  execFileSync(process.execPath, [join(import.meta.dirname, "gen.mjs"), String(rounds), join(values.out, variant)]);
}
const names = readdirSync(join(values.out, "hi"))
  .filter((f) => f.endsWith(".ts") || f.endsWith(".js"))
  .map((f) => f.slice(0, -3))
  .filter((n) => !only || only.includes(n));

/* the command line per lane, or { refused } */
function prep(variant, name) {
  // a probe is TypeScript (transpiled for Node) or, U8d's, JavaScript
  const tsFile = join(values.out, variant, `${name}.ts`);
  const isJs = existsSync(join(values.out, variant, `${name}.js`));
  const file = isJs ? join(values.out, variant, `${name}.js`) : tsFile;
  const js = join(values.out, variant, `${name}.mjs`);
  const src = readFileSync(file, "utf8");
  writeFileSync(js, isJs ? src : ts.transpileModule(src, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText);
  const r = { node: [process.execPath, [js]] };
  for (const lane of ["wasm", "wasm-native"]) {
    if (!lanes.includes(lane)) continue;
    const out = join(values.out, variant, `${name}.${lane === "wasm" ? "wasm" : "native"}`);
    try {
      execFileSync(process.execPath, [cli, "build", "--backend", lane, file, "-o", out], { stdio: "pipe" });
      r[lane] = lane === "wasm" ? [process.execPath, [host, out]] : [out, []];
    } catch (e) {
      r[lane] = { refused: String(e.stderr ?? e.message).split("\n").slice(0, 3).join(" | ") };
    }
  }
  return r;
}

function time([cmd, args]) {
  const t0 = process.hrtime.bigint();
  const p = spawnSync(cmd, args, { encoding: "utf8" });
  return { ms: Number(process.hrtime.bigint() - t0) / 1e6, out: p.stdout, code: p.status, err: p.stderr };
}
const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

for (const n of names) {
  const hi = prep("hi", n);
  const lo = prep("lo", n);
  const row = [n.padEnd(6)];
  let expect = null;
  for (const l of lanes) {
    if (!hi[l] || hi[l].refused) {
      row.push(`${l}=REFUSED(${hi[l]?.refused})`);
      continue;
    }
    const w = time(hi[l]);
    if (l === "node") expect = w.out;
    if (w.code !== 0 || w.out !== expect) {
      row.push(`${l}=MISMATCH(${w.code} ${w.err.split("\n")[0]})`);
      continue;
    }
    time(lo[l]);
    const a = [];
    const b = [];
    for (let k = 0; k < RUNS; k++) {
      a.push(time(hi[l]).ms);
      b.push(time(lo[l]).ms);
    }
    row.push(`${l}=${(med(a) - med(b)).toFixed(1)}ms (tot ${med(a).toFixed(0)}, base ${med(b).toFixed(0)})`);
  }
  console.log(row.join("  "));
}
