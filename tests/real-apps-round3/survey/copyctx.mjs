#!/usr/bin/env node
// The dyn:copy family (SEMANTICS.md S125 (c) / S115 (d) copy refusals) by syntactic slot, from the raw records.
//   node copyctx.mjs [stratum] > copyctx.json
// For every own-package COPY site (deduplicated by file, offset and message across entries), the site's file is
// parsed and the slot the value lands in is named: a const/let/var binding, a destructuring pattern, a return, a
// call argument, a field or element write, a literal member, a cast. Only counts leave this script: no source
// text, no paths. Kind B (the first entry's real wasm build) is kept apart from the analyze() sweep (D/F/U).
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { HERE, RAW, readJsonl } from "./lib.mjs";

const ts = createRequire(join(HERE, "../../../packages/compiler/package.json"))("typescript5");
const stratum = process.argv[2] ?? "npm";
const dir = join(RAW, stratum);
const COPY = /would (be|hold) a COPY where JavaScript shares the object/;

function direction(m) {
  if (/^a dynamic \('unknown', 'any' or 'object'\) value checked into /.test(m)) return "dyn->typed";
  if (/^a '.*' value converted to a dynamic \(/s.test(m) || / value converted to a dynamic \(/.test(m)) return "typed->dyn";
  if (/^a function crossing into a dynamic value, its result/.test(m)) return "fn-in:result";
  if (/^a function crossing into a dynamic value, its parameter/.test(m)) return "fn-in:param";
  if (/function crossing (into|out of) a dynamic value \(its composite/.test(m)) return "fn:by-type";
  if (/ value where '.*' is expected/.test(m)) return "typed->typed(width)";
  return "other";
}
function why(m) {
  const w = /COPY where JavaScript shares the object, and (the program [a-z ]+?)(,| \(|$)/.exec(m);
  return w ? w[1] : "(truncated)";
}
const files = new Map();
function sourceFile(f) {
  if (!files.has(f)) {
    let v = null;
    try { v = ts.createSourceFile(f, readFileSync(f, "utf8"), ts.ScriptTarget.Latest, true, /\.[cm]?ts$/.test(f) ? ts.ScriptKind.TS : ts.ScriptKind.JS); } catch {}
    if (files.size > 200) files.clear();
    files.set(f, v);
  }
  return files.get(f);
}
const SKIP = (n) => ts.isParenthesizedExpression(n) || ts.isNonNullExpression(n) || ts.isConditionalExpression(n) ||
  (ts.isBinaryExpression(n) && [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.CommaToken].includes(n.operatorToken.kind));
/** The slot the value at [start, …) lands in. */
function slot(sf, start) {
  let node = sf;
  for (;;) {
    let next;
    ts.forEachChild(node, (ch) => { if (next === undefined && ch.getStart(sf) <= start && start < ch.end) next = ch; });
    if (!next) break;
    node = next;
    if (node.getStart(sf) === start && ts.isExpression(node)) break;
  }
  let n = node;
  while (n.parent && SKIP(n.parent) && !(ts.isConditionalExpression(n.parent) && n.parent.condition === n)) n = n.parent;
  const p = n.parent;
  if (!p) return "other";
  const fnVal = ts.isFunctionExpression(node) || ts.isArrowFunction(node) ? "fn-literal:" : "";
  let s;
  if (ts.isVariableDeclaration(p) && p.initializer === n) {
    const fl = ts.getCombinedNodeFlags(p);
    s = !ts.isIdentifier(p.name) ? "destructure" : fl & ts.NodeFlags.Const ? "decl:const" : fl & ts.NodeFlags.Let ? "decl:let" : "decl:var";
  } else if (ts.isBindingElement(p) || ts.isArrayBindingPattern(p) || ts.isObjectBindingPattern(p) || (ts.isVariableDeclaration(p) && p.name === n)) s = "destructure";
  else if (ts.isForOfStatement(p) || ts.isForInStatement(p)) s = "for-of/in";
  else if (ts.isReturnStatement(p) || (ts.isArrowFunction(p) && p.body === n)) s = "return";
  else if (ts.isCallExpression(p) || ts.isNewExpression(p)) {
    if (p.expression === n) s = "callee";
    else s = ts.isIdentifier(p.expression) ? "arg:direct-call" : "arg:other-call";
  } else if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.EqualsToken && p.right === n) {
    s = ts.isIdentifier(p.left) ? "assign:binding" : ts.isElementAccessExpression(p.left) ? "assign:element" : "assign:field";
  } else if (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p) || ts.isSpreadAssignment(p)) s = "literal:member";
  else if (ts.isArrayLiteralExpression(p) || ts.isSpreadElement(p)) s = "literal:element";
  else if (ts.isAsExpression(p) || ts.isTypeAssertionExpression?.(p)) s = "cast";
  else if (ts.isPropertyAccessExpression(p) || ts.isElementAccessExpression(p)) s = "member-read";
  else if (ts.isBinaryExpression(p)) s = "operand";
  else s = "other:" + ts.SyntaxKind[p.kind];
  return fnVal + s;
}

const seen = new Set();
const agg = new Map(); // key -> { sites, pkgs:Set }
const add = (key, pkg) => { let a = agg.get(key); if (!a) agg.set(key, (a = { sites: 0, pkgs: new Set() })); a.sites++; a.pkgs.add(pkg); };
for (const fn of readdirSync(dir).filter((f) => f.endsWith(".jsonl"))) {
  const id = fn.slice(0, -".jsonl".length);
  let plan;
  try { plan = JSON.parse(readFileSync(join(dir, `${id}.plan.json`), "utf8")); } catch { plan = { name: id.includes("__") ? "@" + id.replace("__", "/") : id }; }
  const own = (f) => stratum !== "npm" ? !f.includes("/node_modules/") : f.split("/node_modules/").pop().startsWith(plan.name + "/");
  for (const r of readJsonl(join(dir, `${id}.jsonl`))) {
    const lists = [...(r.sites ?? []).map((s) => ["sweep", s]), ...(r.compile?.sites ?? []).map((s) => ["build", s])];
    for (const [where, s] of lists) {
      if (!COPY.test(s.m) && !/^a dynamic \('unknown', 'any' or 'object'\) value checked into |value converted to a dynamic \(|function crossing (into|out of) a dynamic value/.test(s.m)) continue;
      if (!s.f || !own(s.f)) continue;
      const k = `${where}\0${s.f}\0${s.o}\0${s.m}`;
      if (seen.has(k)) continue;
      seen.add(k);
      const sf = sourceFile(s.f);
      const js = !/\.[cm]?ts$/.test(s.f);
      const sl = sf && s.o !== undefined ? slot(sf, s.o) : "(no source)";
      add([where, direction(s.m), sl, js ? "js" : "ts", why(s.m)].join("\t"), plan.name);
    }
  }
}
const rows = [...agg].map(([k, v]) => { const [where, dir, slotKind, lang, reason] = k.split("\t"); return { where, dir, slot: slotKind, lang, why: reason, sites: v.sites, pkgs: v.pkgs.size, pkgList: [...v.pkgs].sort() }; });
rows.sort((a, b) => b.sites - a.sites);
process.stdout.write(JSON.stringify(rows, null, 1) + "\n");
