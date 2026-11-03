#!/usr/bin/env node
// Analyzes one survey target. Spawned by run.mjs, one process per target.
//   node worker.mjs <npm|repo> <id>
// Reads plan raw/<stratum>/<id>.plan.json (written by plan.mjs), appends one JSON record per finished
// entry to raw/<stratum>/<id>.jsonl, and skips entries already there (so a killed worker just resumes).
//
// Two load-time hooks adjust the compiler's dist in memory. The repo is not changed:
//  1. node:vm is replaced with a stub that throws. `comptime(fn)` is an ambient global that the compiler
//     evaluates in node:vm during lowering, and surveyed code is never to be executed.
//  2. analyze() is told to lower as the WasmGC lanes do (undefSlots, hostFetch, targetPlatform host).
//     Stock analyze() lowers for the C/LLVM lanes, whose refusal set differs from the wasm lanes'.
//  3. Stratum "repogate" only: checker errors no longer stop analyze() at preflight, so entries that a
//     missing dependency or ambient .d.ts stopped still get lowered. Types are degraded there, so
//     those sites are kept apart (kind G in collate.py) and crashes there are not counted as compiler bugs.
import { registerHooks } from "node:module";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "../../..");
const DIST = join(REPO, "packages/compiler/dist/index.js");
const PAST_GATE = process.argv[2] === "repogate";
const FENCE_SET = 'new Set(["SC1010", "SC1012", "SC1013", "SC1014", "SC1015"])';
const VM_STUB = "data:text/javascript,const no=()=>{throw new Error('survey: compile-time evaluation disabled')};export default{Script:no,createContext:no,runInContext:no,runInNewContext:no,runInThisContext:no,compileFunction:no,isContext:no};";
const ANALYZE_LOWER = "coverage: true,\n            targetPlatform: buildTargetPlatform(),";
registerHooks({
  resolve(spec, ctx, next) {
    if ((spec === "node:vm" || spec === "vm") && ctx.parentURL?.includes("/packages/compiler/dist/")) return { url: VM_STUB, shortCircuit: true };
    return next(spec, ctx);
  },
  load(url, ctx, next) {
    const r = next(url, ctx);
    if (url.endsWith("packages/compiler/dist/index.js")) {
      const s = String(r.source);
      if (!s.includes(ANALYZE_LOWER)) throw new Error("analyze() lowering options moved; update the worker hook");
      let patched = s.replace(ANALYZE_LOWER, 'coverage: true, hostFetch: true, undefSlots: true, targetPlatform: "host",');
      if (PAST_GATE) {
        if (!patched.includes(FENCE_SET)) throw new Error("analyze() preflight gate moved; update the worker hook");
        patched = patched.replace(FENCE_SET, 'new Set(["SC1010", "SC1012", "SC1013", "SC1014", "SC1015", "SC0001", "SC0002"])');
      }
      return { ...r, source: patched };
    }
    return r;
  },
});

const { analyze, compile } = await import(DIST);
const ts = createRequire(join(REPO, "packages/compiler/package.json"))("typescript5");
const CACHE = process.env.SURVEY_CACHE ?? join(process.env.HOME, ".cache/tsinter-dl/survey");
const [stratum, id] = process.argv.slice(2);
const dir = join(process.env.SURVEY_RAW ?? join(CACHE, "raw"), stratum);
const plan = JSON.parse(readFileSync(join(dir, `${id}.plan.json`), "utf8"));
const out = join(dir, `${id}.jsonl`);
const done = new Set(existsSync(out) ? readFileSync(out, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).entry) : []);
const SITE_CAP = 30000;
const WASM_OUT = join(CACHE, "tmp", `${stratum}-${id}`);

/* ── source facts for a site, computed without keeping the source ─────── */
const KEEP = new Set(("prototype module exports require this call apply bind arguments typeof define window self global globalThis constructor __proto__ " +
  "Object Array Function Symbol Promise Map Set Date RegExp Error JSON Math Number String Boolean BigInt Reflect Proxy process Buffer new delete in of instanceof " +
  "function class extends super return await yield async const let var if else for while do switch case throw try catch void null undefined true false length").split(" "));
export function shapeOf(text) {
  return text.slice(0, 90).replace(/\s+/g, " ")
    .replace(/\/\/.*$/g, "")
    .replace(/(["'`])(?:\\.|(?!\1).)*\1?/g, '""')
    .replace(/\b0x[0-9a-fA-F]+\b|\b\d[\d_.eE]*n?\b/g, "0")
    .replace(/[A-Za-z_$][\w$]*/g, (w) => (KEEP.has(w) ? w : "_"))
    .slice(0, 60);
}
const sourceCache = new Map();
function sourceOf(file) {
  let c = sourceCache.get(file);
  if (c !== undefined) return c;
  c = null;
  try {
    const text = readFileSync(file, "utf8");
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, /x$/.test(file) ? ts.ScriptKind.TSX : file.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS);
    const starts = [0];
    for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
    c = { text, sf, starts };
  } catch { c = null; }
  if (sourceCache.size > 400) sourceCache.clear();
  sourceCache.set(file, c);
  return c;
}
/** 0 inside a function body; 1 module top level, unconditional; 2 top level under if/try/ternary/&&.
 * A directly-called function expression (IIFE) does not count as a function. Indicative only. */
function initLevel(sf, pos) {
  let level = 1;
  const walk = (n, iife) => {
    let found;
    ts.forEachChild(n, (ch) => {
      if (found !== undefined || pos < ch.pos || pos >= ch.end) return;
      found = ch;
    });
    if (!found) return;
    const fnLike = ts.isFunctionLike(found) || ts.isClassStaticBlockDeclaration?.(found);
    if (fnLike) {
      const called = iife === found;
      if (!called) { level = 0; return; }
    }
    if (ts.isIfStatement(n) || ts.isTryStatement(n) || ts.isConditionalExpression(n) || (ts.isBinaryExpression(n) && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken].includes(n.operatorToken.kind))) level = 2;
    let next;
    if (ts.isCallExpression(found)) {
      let c = found.expression;
      while (ts.isParenthesizedExpression(c)) c = c.expression;
      if (ts.isPropertyAccessExpression(c) && ["call", "apply"].includes(c.name.text)) { c = c.expression; while (ts.isParenthesizedExpression(c)) c = c.expression; }
      if (ts.isFunctionExpression(c) || ts.isArrowFunction(c)) next = c;
    } else if (iife && (ts.isParenthesizedExpression(found) || ts.isPropertyAccessExpression(found))) next = iife;
    walk(found, next ?? (found.kind === ts.SyntaxKind.ExpressionStatement ? undefined : iife));
  };
  walk(sf, undefined);
  return level;
}
function site(kind, d) {
  const loc = d.loc ?? { file: "", start: 0, end: 0 };
  const rec = { k: kind, c: d.code, m: String(d.message).slice(0, 400), f: loc.file };
  const s = loc.file ? sourceOf(loc.file) : null;
  if (s) {
    let lo = 0, hi = s.starts.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (s.starts[m] <= loc.start) lo = m; else hi = m - 1; }
    rec.l = lo + 1;
    rec.o = loc.start;
    rec.s = shapeOf(s.text.slice(loc.start, Math.min(loc.end > loc.start ? loc.end : loc.start + 60, loc.start + 90)));
    try { rec.t = initLevel(s.sf, loc.start); } catch { rec.t = -1; }
  }
  return rec;
}

function analyzeEntry(e) {
  const started = Date.now();
  const r = { entry: e.name, kind: e.kind };
  if (e.text !== undefined) writeFileSync(e.wrapper, e.text);
  const npmStatic = e.npmStatic?.length ? e.npmStatic : undefined;
  try {
    const { coverage: c } = analyze(e.wrapper, npmStatic ? { npmStatic } : {});
    r.preflightFailed = !!c.preflightFailed;
    r.stats = c.stats;
    r.unreachedStats = c.unreached?.stats;
    r.npm = c.npmStatic?.filter((s) => s.status !== "static").map((s) => ({ p: s.package, st: s.status, d: String(s.detail ?? "").slice(0, 300) }));
    const lists = [["D", c.diagnostics ?? []], ["F", c.runtimeFences ?? []], ["U", c.unreached?.diagnostics ?? []]];
    r.sites = [];
    for (const [kind, list] of lists) for (const d of list) if (r.sites.length < SITE_CAP) r.sites.push(site(kind, d));
    r.sitesTotal = lists.reduce((a, [, l]) => a + l.length, 0);
  } catch (err) {
    r.crash = { message: String(err?.message ?? err).slice(0, 500), stack: String(err?.stack ?? "").split("\n").slice(1, 5).map((x) => x.trim().replace(/^at /, "").replace(/\(?file:.*\/dist\//, "(").slice(0, 100)) };
  }
  r.ms = Date.now() - started;
  return r;
}

/* Runs the real wasm build (no execution of its output) so the verdict includes backend-only SC3001
 * refusals and exactly what `build` would say on the reached program. */
async function compileEntry(e) {
  const started = Date.now();
  mkdirSync(WASM_OUT, { recursive: true });
  const npmStatic = e.npmStatic?.length ? e.npmStatic : undefined;
  try {
    const r = await compile(e.wrapper, { backend: "wasm", outPath: join(WASM_OUT, "m.wasm"), outDir: WASM_OUT, dynamic: false, ...(npmStatic ? { npmStatic } : {}) });
    return { ok: !!r.ok, ms: Date.now() - started, sites: (r.diagnostics ?? []).slice(0, 2000).map((d) => site("B", d)) };
  } catch (err) {
    return { ok: false, ms: Date.now() - started, sites: [], crash: { message: String(err?.message ?? err).slice(0, 500), stack: String(err?.stack ?? "").split("\n").slice(1, 5).map((x) => x.trim().replace(/^at /, "").replace(/\(?file:.*\/dist\//, "(").slice(0, 100)) } };
  } finally {
    rmSync(WASM_OUT, { recursive: true, force: true });
  }
}

for (const e of plan.entries) {
  if (done.has(e.name)) continue;
  process.stdout.write(`start ${e.name}\n`);
  const r = analyzeEntry(e);
  if (e.compile && !r.crash) { process.stdout.write(`compile ${e.name}\n`); r.compile = await compileEntry(e); }
  appendFileSync(out, JSON.stringify(r) + "\n");
  process.stdout.write(`done ${e.name}\n`);
}
// Own files clean: does the package still come back clean with its dependency closure compiled too?
if (plan.tree && !done.has("<tree>")) {
  const own = readFileSync(out, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const clean = own.every((r) => !r.crash && !r.preflightFailed && !(r.compile && !r.compile.ok) && (r.sites ?? []).every((s) => s.c === "SC2013"));
  if (clean) {
    process.stdout.write("start <tree>\n");
    const r = analyzeEntry({ name: "<tree>", kind: "tree", wrapper: plan.tree.wrapper, npmStatic: plan.tree.npmStatic });
    appendFileSync(out, JSON.stringify(r) + "\n");
    process.stdout.write("done <tree>\n");
  }
}
process.stdout.write("finished\n");
process.exit(0);
