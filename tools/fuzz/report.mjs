/* The campaign report (markdown): stats, then one section per bucket with
 * its minimized repro and the Node vs tsinter outputs. */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { known } from "./known.mjs";

const fence = (s, lang = "") => "```" + lang + "\n" + s.replace(/```/g, "ˋˋˋ") + (s.endsWith("\n") ? "" : "\n") + "```";
const clip = (s, n = 40) => {
  const ls = String(s ?? "").split("\n");
  return ls.length > n ? [...ls.slice(0, n), `… (${ls.length - n} more lines)`].join("\n") : String(s ?? "");
};

export function writeReport(out, { args, lanes, stats, refusalCodes, refusalMsgs, invalidSamples, buckets, unminimized }) {
  const L = [];
  L.push("# tsinter differential fuzz report", "");
  L.push(`- seeds ${stats.seeds[0]}..${stats.seeds[1]}, lang ${args.lang}, lanes ${lanes.join(", ")}, ${stats.fuzzSeconds}s of fuzzing, ${args.jobs} workers`);
  L.push(`- programs generated: ${stats.programs}; rejected by tsc: ${stats.tscRejected}; Node failed: ${stats.invalid}`);
  L.push(`- reruns after pruning a refused snippet: ${stats.prunedRuns}; snippets in the final programs: ${stats.snippetsRun}`, "");
  L.push("Counts are per program, on its final (pruned) run.", "");
  L.push("| lane | match | refused | DIVERGENCE | crash | invalid |", "|---|---|---|---|---|---|");
  for (const l of lanes) {
    const s = stats.perLane[l];
    L.push(`| ${l} | ${s.match} | ${s.refused} | ${s.divergence} | ${s.crash} | ${s.invalid} |`);
  }
  L.push("");
  const codes = Object.entries(refusalCodes).sort((a, b) => b[1] - a[1]);
  if (codes.length > 0) L.push("Refusals by code: " + codes.map(([c, n]) => `${c} ×${n}`).join(", "), "");
  const msgs = Object.entries(refusalMsgs ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 25);
  if (msgs.length > 0) {
    L.push("<details><summary>Top refusal messages (every run, before pruning)</summary>", "");
    for (const [m, n] of msgs) L.push(`- ×${n} ${m}`);
    L.push("", "</details>", "");
  }
  if (invalidSamples.length > 0) {
    L.push("<details><summary>Invalid programs (generator noise), first few</summary>", "");
    for (const s of invalidSamples) L.push(`- seed ${s.seed}: ${s.why}`);
    L.push("", "</details>", "");
  }
  const sorted = [...buckets].sort((a, b) => (a.res.cls === b.res.cls ? b.count - a.count : a.res.cls === "divergence" ? -1 : 1));
  L.push(`## Buckets (${sorted.length})`, "");
  L.push("| # | class | kind | observer | nature | programs | lanes | known? |", "|---|---|---|---|---|---|---|---|");
  sorted.forEach((b, i) => {
    const k = known(b);
    b.knownAs = k;
    L.push(`| ${i + 1} | ${b.res.cls} | ${b.res.kind} | ${b.res.diff?.observer ?? "-"} | ${b.res.diff?.nature ?? "-"} | ${b.count} | ${b.lanes.join(",")} | ${k ?? "**new?**"} |`);
  });
  L.push("");
  sorted.forEach((b, i) => {
    const r = b.res;
    L.push(`### ${i + 1}. ${r.cls}: ${r.kind}${r.diff ? ` at \`${r.diff.observer}\` (${r.diff.nature})` : ""}${r.msg ? ` — ${r.msg}` : ""}`, "");
    L.push(`- signature: \`${b.sig}\``);
    L.push(`- programs: ${b.count} (seeds ${b.seeds.slice(0, 8).join(", ")}${b.seeds.length > 8 ? ", …" : ""}); lanes: ${b.lanes.join(", ")}; lang: ${b.lang}${b.knownAs ? `; known: ${b.knownAs}` : ""}`);
    L.push(`- features: ${b.feats.join(" ")}`, "");
    L.push(fence((b.ran ?? b.source).trim(), b.lang === "js" ? "js" : "ts"), "");
    if (r.diff) {
      L.push(`First differing line (${r.diff.line + 1}):`, "", fence(`node:    ${r.diff.node}\ntsinter: ${r.diff.got}`), "");
    }
    if (b.node) L.push("Node:", "", fence(clip(b.node.stdout + (b.node.stderr ? "\n[stderr]\n" + b.node.stderr : "") + `\n[exit ${b.node.exitCode}]`)), "");
    if (r.got) L.push("tsinter:", "", fence(clip(r.got.stdout + (r.got.stderr ? "\n[stderr]\n" + r.got.stderr : "") + `\n[exit ${r.got.exitCode}]`)), "");
  });
  if (unminimized.length > 0) {
    L.push("## Pre-buckets not minimized (over --max-minimize)", "");
    for (const u of unminimized) L.push(`- \`${u.key}\` ×${u.count} (seeds ${u.seeds.join(", ")})`);
  }
  const path = join(out, "report.md");
  writeFileSync(path, L.join("\n") + "\n");
  return path;
}
