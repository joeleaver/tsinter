// deepStrictEqual over CROSSED-COLUMN cyclic pairs — the axis 2693
// never varies (its cycles sit behind an array field, landing every
// comparison at depth 3+; this file puts the cycle on a DIRECT record
// field so a crossed pair lands at depth 2, where Node is still on its
// a/b two-slot fast path). Gate finding F-1 (increment 23): fix round
// F1 applied the general set-of-values rule from the very first
// comparison, which wrongly answers UNEQUAL on a depth-2 pair that
// reuses a value from the OTHER column of an earlier pair — Node's
// real rule (SEMANTICS.md S056) is PAIR semantics at depth 2, not the
// set rule, and WALKS it instead.
//
// interface Y { x: Y | null }; y.x=y (self-cyclic); b={x:y}; a={x:b};
// c={x:a}. Comparing a vs b puts (b,y) at depth 2 (both orders); Node
// WALKS it and finds b.x=y === y.x=y -> EQUAL, in EITHER of Node's two
// real modes (S056's table: this row agrees fresh and post-overflow).
// Comparing c vs a puts (b,y) at depth 3 instead (one more hop) — once
// the memo has promoted to a set, "b present, y absent" answers
// UNEQUAL — but ONLY in Node's POST-overflow mode; a truly FRESH Node
// process (plain recursion, no memo yet) answers EQUAL here (S056's
// registered divergence, Joe's option A: this tier runs the memo
// always, matching Node's post-overflow behavior deterministically).
//
// A FRESH `node` process would print EQUAL for the crossed-d3 checks
// below and diverge from this tier — so this file opens with a
// period-mismatched ring pair (ring(2) vs ring(4), 2693's own trigger
// shape) BEFORE the crossed checks: comparing mismatched periods by
// PLAIN recursion (Node's pre-overflow pass has no memo) revisits the
// same pair forever without ever hitting `val1 === val2`, so it
// genuinely stack-overflows in Node — which rebinds Node's own process
// to memo-always for the REST of this script (own-measured, node
// v24.18.1: re-run the crossed-d3 checks with and without this trigger
// — THREW only with it). Every check below therefore runs under
// Node's OWN post-overflow behavior, the same one this tier always
// uses, so this is a genuine byte-exact match, not a workaround. This
// ordering (the primer FIRST) is load-bearing for the sibling shapes
// below too — keep it.
//
// Fix round F3 (gate re-cert finding R-1): the divergence class above
// has a SECOND route that does not need depth-3 nesting at all — a
// depth-2 pair whose set was promoted by an EARLIER SIBLING's own walk
// (SEMANTICS.md S056's sibling-B row). `interface T { p: T | null; q:
// T | null }` puts BOTH siblings at depth 2 (immediate children of one
// top pair): sibling 1's pair is (ta.p, tb.p); sibling 2's is (ta.q,
// tb.q) = (tb, w), where `w` is a FRESH object structurally equal to
// `tb`. Whether sibling 1's own walk reaches depth 3 and promotes the
// set changes sibling 2's ANSWER, not just its path — sibling-A (below)
// keeps sibling 1 shallow (no promotion, EQUAL); sibling-B deepens it
// (promotes, THREW under Option A, matching Node's own POST-overflow
// column exactly, same as the crossed-d3 rows above).
import assert from "node:assert";

interface Node { label: string; next: Node[] }
function ring(n: number): Node {
  const nodes: Node[] = [];
  for (let i = 0; i < n; i++) nodes.push({ label: "x", next: [] });
  for (let i = 0; i < n; i++) nodes[i]!.next.push(nodes[(i + 1) % n]!);
  return nodes[0]!;
}
function ringVerdict(x: Node, y: Node): string {
  try {
    assert.deepStrictEqual(x, y);
    return "EQUAL";
  } catch {
    return "THREW";
  }
}
console.log("trigger-2v4", ringVerdict(ring(2), ring(4)));

interface Y { x: Y | null }
function yVerdict(p: Y, q: Y): string {
  try {
    assert.deepStrictEqual(p, q);
    return "EQUAL";
  } catch {
    return "THREW";
  }
}
const y: Y = { x: null };
y.x = y;
const b: Y = { x: y };
const a: Y = { x: b };
const c: Y = { x: a };
console.log("crossed-d2-a-vs-b", yVerdict(a, b));
console.log("crossed-d2-b-vs-a", yVerdict(b, a));
console.log("crossed-d3-c-vs-a", yVerdict(c, a));
console.log("crossed-d3-a-vs-c", yVerdict(a, c));

interface T { p: T | null; q: T | null }
function tVerdict(x: T, y2: T): string {
  try {
    assert.deepStrictEqual(x, y2);
    return "EQUAL";
  } catch {
    return "THREW";
  }
}
const leaf = (): T => ({ p: null, q: null });
const deep = (): T => ({ p: leaf(), q: null });

// SHAPE A (control): sibling 1 (the "p" field pair) stays shallow — its
// own walk never reaches depth 3, so the set is never promoted, and
// sibling 2's pair (tb, w) meets the depth-2 PAIR rules and WALKS.
{
  const w: T = { p: leaf(), q: null };
  w.q = w;
  const tb: T = { p: leaf(), q: w };
  const ta: T = { p: leaf(), q: tb };
  console.log("sibling-A-no-promote", tVerdict(ta, tb));
}
// SHAPE B: sibling 1 is one level deeper, so ITS OWN walk reaches depth
// 3 and promotes the set — sibling 2's IDENTICAL pair (tb, w) now meets
// the set rule instead: tb present, w absent -> exactly one -> UNEQUAL.
{
  const w: T = { p: deep(), q: null };
  w.q = w;
  const tb: T = { p: deep(), q: w };
  const ta: T = { p: deep(), q: tb };
  console.log("sibling-B-promotes", tVerdict(ta, tb));
}
console.log("done");
