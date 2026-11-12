#!/usr/bin/env node
// Diagnostic probe: the exact refusal sites of a few surveyed packages, with each site's syntactic context.
//   node probe.mjs <id…>               one child process per package, JSON lines on stdout
//   SURVEY_PROBE_ANALYZE=n                    also analyze() the first n sweep entries, with and without sharedDynamic
// Same safety hooks as worker.mjs: node:vm is stubbed (comptime() never evaluates third-party code) and
// nothing is installed or run; the wasm output is written to a temp dir and deleted.
// Output carries third-party source lines: keep it out of the repo (the scratchpad), commit only counts.
import { registerHooks } from "node:module";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "../../..");
const CACHE = process.env.SURVEY_CACHE ?? join(process.env.HOME, ".cache/tsinter-dl/survey");
const RAW = process.env.SURVEY_RAW ?? join(CACHE, "raw");
const ids = process.argv.slice(2);

if (process.env.SURVEY_PROBE_CHILD === undefined) {
  for (const id of ids) {
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), id], {
      env: { ...process.env, SURVEY_PROBE_CHILD: "1" }, encoding: "utf8", timeout: 900_000, maxBuffer: 1 << 28,
    });
    process.stdout.write(r.stdout ?? "");
    if (r.status !== 0) process.stdout.write(JSON.stringify({ id, childFailed: r.status, signal: r.signal, stderr: String(r.stderr).slice(-2000) }) + "\n");
  }
  process.exit(0);
}

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
      if (!s.includes(ANALYZE_LOWER)) throw new Error("analyze() lowering options moved; update probe.mjs");
      // globalThis.__probeShared toggles sharedDynamic per call.
      return { ...r, source: s.replace(ANALYZE_LOWER, 'coverage: true, hostFetch: true, undefSlots: true, sharedDynamic: globalThis.__probeShared !== false, targetPlatform: "host",') };
    }
    return r;
  },
});
const { analyze, compile } = await import(join(REPO, "packages/compiler/dist/index.js"));
const ts = createRequire(join(REPO, "packages/compiler/package.json"))("typescript5");

const id = ids[0];
const plan = JSON.parse(readFileSync(join(RAW, "npm", `${id}.plan.json`), "utf8"));
const primary = plan.entries.find((e) => e.compile) ?? plan.entries[0];
const out = (o) => process.stdout.write(JSON.stringify({ id, ...o }) + "\n");

const files = new Map();
function sf(file) {
  if (!files.has(file)) {
    let v = null;
    try {
      const text = readFileSync(file, "utf8");
      v = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS);
    } catch {}
    files.set(file, v);
  }
  return files.get(file);
}
/** The innermost node covering [start, end), then its context up the tree (parens/casts skipped). */
function context(file, start, end) {
  const s = sf(file);
  if (!s) return null;
  let node = s;
  for (;;) {
    let next;
    ts.forEachChild(node, (ch) => { if (next === undefined && ch.getStart(s) <= start && end <= ch.end && ch.end > start) next = ch; });
    if (!next) break;
    node = next;
  }
  const chain = [];
  let n = node;
  for (let i = 0; n && i < 6; i++, n = n.parent) {
    let k = ts.SyntaxKind[n.kind];
    if (ts.isVariableDeclarationList(n)) k += (n.flags & ts.NodeFlags.Const) ? "(const)" : (n.flags & ts.NodeFlags.Let) ? "(let)" : "(var)";
    if (ts.isBinaryExpression(n)) k += `(${ts.tokenToString(n.operatorToken.kind)};lhs=${ts.SyntaxKind[n.left.kind]})`;
    if (ts.isCallExpression(n)) k += `(callee=${ts.SyntaxKind[n.expression.kind]})`;
    chain.push(k);
  }
  const { line } = s.getLineAndCharacterOfPosition(start);
  return { line: line + 1, node: ts.SyntaxKind[node.kind], chain, text: s.text.split("\n")[line].trim().slice(0, 200), js: !/\.[cm]?ts$/.test(file) };
}
function site(d) {
  const loc = d.loc ?? { file: "", start: 0, end: 0 };
  return { code: d.code, at: loc.start, msg: String(d.message), file: loc.file.replace(/^.*\/node_modules\//, ""), ctx: loc.file ? context(loc.file, loc.start, loc.end) : null };
}

const npmStatic = primary.npmStatic?.length ? primary.npmStatic : undefined;
const TMP = join(CACHE, "tmp", `probe-${id}-${process.pid}`);
mkdirSync(TMP, { recursive: true });
const t0 = Date.now();
try {
  globalThis.__probeShared = true;
  const r = await compile(primary.wrapper, { backend: "wasm", outPath: join(TMP, "m.wasm"), outDir: TMP, dynamic: false, ...(npmStatic ? { npmStatic } : {}) });
  out({ phase: "compile", entry: primary.name, ok: !!r.ok, ms: Date.now() - t0, n: (r.diagnostics ?? []).length, sites: (r.diagnostics ?? []).slice(0, 400).map(site) });
} catch (err) {
  out({ phase: "compile", entry: primary.name, crash: String(err?.stack ?? err).slice(0, 1500) });
} finally {
  rmSync(TMP, { recursive: true, force: true });
}
const nA = Number(process.env.SURVEY_PROBE_ANALYZE ?? 0);
const COPY = /would (be|hold) a COPY where JavaScript shares the object/;
for (const e of plan.entries.slice(0, nA)) {
  const row = { phase: "analyze", entry: e.name };
  for (const shared of [false, true]) {
    globalThis.__probeShared = shared;
    try {
      const { coverage: c } = analyze(e.wrapper, e.npmStatic?.length ? { npmStatic: e.npmStatic } : {});
      const all = [...(c.diagnostics ?? []), ...(c.runtimeFences ?? [])];
      const own = all.filter((d) => (d.loc?.file ?? "").includes(`/node_modules/${plan.name}/`));
      row[shared ? "shared" : "old"] = { D: (c.diagnostics ?? []).length, F: (c.runtimeFences ?? []).length, copy: own.filter((d) => COPY.test(d.message)).length,
        copySites: shared ? own.filter((d) => COPY.test(d.message)).slice(0, 60).map(site) : undefined };
    } catch (err) {
      row[shared ? "shared" : "old"] = { crash: String(err?.message ?? err).slice(0, 300) };
    }
  }
  out(row);
}
// SURVEY_PROBE_FENCES=1: every diagnostic and deferred fence of the first entry (sharedDynamic on).
if (process.env.SURVEY_PROBE_FENCES === "1") {
  globalThis.__probeShared = true;
  const { coverage: c } = analyze(primary.wrapper, npmStatic ? { npmStatic } : {});
  out({ phase: "fences", D: (c.diagnostics ?? []).map(site), F: (c.runtimeFences ?? []).map(site) });
}
process.exit(0);
