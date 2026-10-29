// node sites.mjs <entry> [npmStatic,comma] > json : every reached refusal site (diagnostics + runtime fences) with file:line:col and source line
import { analyze } from "/home/joe/dev/tsinter/.claude/worktrees/agent-a16bf40c249d36838/packages/compiler/dist/index.js";
import { readFileSync } from "node:fs";
const [entry, npm] = process.argv.slice(2);
const { coverage } = analyze(entry, npm ? { npmStatic: npm.split(",") } : {});
const lineOf = (file, off) => {
  let t;
  try { t = readFileSync(file, "utf8"); } catch { return [0, 0, ""]; }
  const pre = t.slice(0, off);
  const ln = pre.split("\n").length;
  const col = off - pre.lastIndexOf("\n");
  return [ln, col, t.split("\n")[ln - 1].trim().slice(0, 160)];
};
const out = [];
for (const [kind, list] of [["diag", coverage.diagnostics ?? []], ["fence", coverage.runtimeFences ?? []]]) {
  for (const d of list) {
    const [ln, col, src] = lineOf(d.loc.file, d.loc.start);
    out.push({ kind, code: d.code, message: d.message, file: d.loc.file, line: ln, col, src });
  }
}
process.stdout.write(JSON.stringify(out, null, 1));
