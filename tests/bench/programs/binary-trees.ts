// Object-heavy: the binary-trees allocation benchmark (the design study's b1).
class TreeNode {
  constructor(
    public left: TreeNode | null,
    public right: TreeNode | null,
  ) {}
}
function make(depth: number): TreeNode {
  return depth === 0 ? new TreeNode(null, null) : new TreeNode(make(depth - 1), make(depth - 1));
}
function check(t: TreeNode): number {
  return t.left === null || t.right === null ? 1 : 1 + check(t.left) + check(t.right);
}
const maxDepth = 18;
const longLived = make(maxDepth);
let total = 0;
for (let d = 4; d <= maxDepth; d += 2) {
  const iters = 1 << (maxDepth - d + 4);
  let c = 0;
  for (let i = 0; i < iters; i++) c += check(make(d));
  total += c;
  console.log(`${iters} trees of depth ${d} check: ${c}`);
}
console.log(`long lived tree of depth ${maxDepth} check: ${check(longLived)} total ${total}`);
