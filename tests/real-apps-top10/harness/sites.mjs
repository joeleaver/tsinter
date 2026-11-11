// node sites.mjs <entry> [npmStatic,comma|auto] > json      (SITES_PAST_GATE=1: past the type-check gate)
// Round 3's sites.mjs (../../real-apps-round3/harness/sites.mjs) plus two things: "auto" passes
// npmStatic: "auto", and SITES_PAST_GATE=1 applies the survey worker's "repogate" hook (checker errors
// SC0001/SC0002 no longer stop analyze() at preflight, so the language sites behind a type error are
// listed too; those sites carry gate: true, since types are degraded there).
// Every reached refusal site of one app (compile diagnostics D, deferred runtime fences F), with
// file:line:col, the source line, and the survey's anonymized shape (so blockers.py can classify it
// with tests/real-apps-round3/survey/families.py). analyze() is told to lower as the WasmGC lanes
// do, exactly like the survey's worker.mjs (stock analyze() lowers for the legacy C/LLVM lanes).
import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const PAST_GATE = process.env.SITES_PAST_GATE === "1";
const FENCE_SET = 'new Set(["SC1010", "SC1012", "SC1013", "SC1014", "SC1015"])';
const ANALYZE_LOWER = "coverage: true,\n            targetPlatform: buildTargetPlatform(),";
registerHooks({
  load(url, ctx, next) {
    const r = next(url, ctx);
    if (url.endsWith("packages/compiler/dist/index.js")) {
      const s = String(r.source);
      if (!s.includes(ANALYZE_LOWER)) throw new Error("analyze() lowering options moved; update sites.mjs (and survey/worker.mjs)");
      let patched = s.replace(ANALYZE_LOWER, 'coverage: true, hostFetch: true, undefSlots: true, targetPlatform: "host",');
      if (PAST_GATE) {
        if (!patched.includes(FENCE_SET)) throw new Error("analyze() preflight gate moved; update sites.mjs (and survey/worker.mjs)");
        patched = patched.replace(FENCE_SET, 'new Set(["SC1010", "SC1012", "SC1013", "SC1014", "SC1015", "SC0001", "SC0002"])');
      }
      return { ...r, source: patched };
    }
    return r;
  },
});
const { analyze } = await import(join(REPO, "packages/compiler/dist/index.js"));

// survey/worker.mjs shapeOf, verbatim
const KEEP = new Set(("prototype module exports require this call apply bind arguments typeof define window self global globalThis constructor __proto__ " +
  "Object Array Function Symbol Promise Map Set Date RegExp Error JSON Math Number String Boolean BigInt Reflect Proxy process Buffer new delete in of instanceof " +
  "function class extends super return await yield async const let var if else for while do switch case throw try catch void null undefined true false length").split(" "));
function shapeOf(text) {
  return text.slice(0, 90).replace(/\s+/g, " ")
    .replace(/\/\/.*$/g, "")
    .replace(/(["'`])(?:\\.|(?!\1).)*\1?/g, '""')
    .replace(/\b0x[0-9a-fA-F]+\b|\b\d[\d_.eE]*n?\b/g, "0")
    .replace(/[A-Za-z_$][\w$]*/g, (w) => (KEEP.has(w) ? w : "_"))
    .slice(0, 60);
}

const [entry, npm] = process.argv.slice(2);
const { coverage } = analyze(entry, npm === "auto" ? { npmStatic: "auto" } : npm ? { npmStatic: npm.split(",") } : {});
const texts = new Map();
const textOf = (f) => {
  if (!texts.has(f)) {
    try { texts.set(f, readFileSync(f, "utf8")); } catch { texts.set(f, null); }
  }
  return texts.get(f);
};
const out = [];
for (const [kind, list] of [["D", coverage.diagnostics ?? []], ["F", coverage.runtimeFences ?? []]]) {
  for (const d of list) {
    const loc = d.loc ?? { file: "", start: 0, end: 0 };
    const t = textOf(loc.file);
    let line = 0, col = 0, src = "", shape = "";
    if (t !== null) {
      const pre = t.slice(0, loc.start);
      line = pre.split("\n").length;
      col = loc.start - pre.lastIndexOf("\n");
      src = t.split("\n")[line - 1].trim().slice(0, 160);
      shape = shapeOf(t.slice(loc.start, Math.min(loc.end > loc.start ? loc.end : loc.start + 60, loc.start + 90)));
    }
    out.push({ kind, code: d.code, message: d.message, file: loc.file, line, col, src, shape });
  }
}
process.stdout.write(JSON.stringify(out, null, 1));
