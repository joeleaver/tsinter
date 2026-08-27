// deepStrictEqual over same-labeled cyclic structures of DIFFERENT
// period: Node's real cycle memo (a SET OF VALUES currently on the
// comparison stack, not a set of pairs) answers equal ONLY when the
// periods match, and throws for every mismatch — including exact
// multiples (a 2-node ring vs a 4-node ring), not just coprime periods
// (2 vs 3). A simpler "this (a,b) pair is already open" pair-memo
// wrongly answers equal for every one of these (by pigeonhole, any two
// same-labeled finite cycles eventually revisit some already-open
// pair regardless of whether the cycles are isomorphic) — increment
// 23's own cross-lane fix, all three backends.
import assert from "node:assert";

interface Node { label: string; next: Node[] }

function ring(n: number): Node {
  const nodes: Node[] = [];
  for (let i = 0; i < n; i++) nodes.push({ label: "x", next: [] });
  for (let i = 0; i < n; i++) nodes[i]!.next.push(nodes[(i + 1) % n]!);
  return nodes[0]!;
}

function verdict(a: Node, b: Node): string {
  try {
    assert.deepStrictEqual(a, b);
    return "EQUAL";
  } catch {
    return "THREW";
  }
}

console.log("1v1", verdict(ring(1), ring(1)));
console.log("1v2", verdict(ring(1), ring(2)));
console.log("2v2", verdict(ring(2), ring(2)));
console.log("2v4", verdict(ring(2), ring(4)));
console.log("2v3", verdict(ring(2), ring(3)));
console.log("3v3", verdict(ring(3), ring(3)));

// A shared subtree (two branches of one structure pointing at the SAME
// child, not a cycle) must still compare equal against an independently
// built structural twin — both values present at the second visit to
// the shared child answers EQUAL, exactly like a genuine cycle would.
interface Tree { label: string; kids: Tree[] }
const sharedChild: Tree = { label: "leaf", kids: [] };
const withSharedChild: Tree = { label: "root", kids: [sharedChild, sharedChild] };
const twinChildA: Tree = { label: "leaf", kids: [] };
const twinChildB: Tree = { label: "leaf", kids: [] };
const withTwinChildren: Tree = { label: "root", kids: [twinChildA, twinChildB] };
try {
  assert.deepStrictEqual(withSharedChild, withTwinChildren);
  console.log("shared-subtree", "EQUAL");
} catch {
  console.log("shared-subtree", "THREW");
}

console.log("done");
