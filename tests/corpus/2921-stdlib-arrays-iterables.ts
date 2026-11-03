// Step 2B: array mutators and iterable conversions — a ring of recent
// items, a dependency graph's unique names, and a dynamic-programming table.

class History {
  private items: string[] = [];
  private readonly limit: number;
  constructor(limit: number) {
    this.limit = limit;
  }
  add(item: string): number {
    const n = this.items.unshift(item);
    if (n > this.limit) this.items.splice(this.limit, n - this.limit);
    return this.items.length;
  }
  newestLast(): string[] {
    return Array.from(this.items).reverse();
  }
}

const h = new History(3);
for (const cmd of ["ls", "cd", "pwd", "git", "make"]) console.log(h.add(cmd));
console.log(h.newestLast());

// splice with inserted items, fill, join()
const xs = [1, 2, 3, 4, 5];
console.log(xs.splice(1, 2, 20, 30, 40), xs.join());
console.log(xs.fill(0, -2).join(), [1, 2, 3].fill(7));

// unique dependency names, in first-seen order
const deps = new Map<string, string[]>([
  ["app", ["ui", "core"]],
  ["ui", ["core", "icons"]],
  ["core", []],
]);
const seen = new Set<string>(deps.keys());
for (const list of deps.values()) for (const d of list) seen.add(d);
console.log(Array.from(seen), new Set("mississippi").size, Array.from("ab😀", (c, i) => i + c));
const KINDS = ["file", "dir", "link"] as const;
const kindSet = new Set<string>(KINDS);
console.log(kindSet.has("dir"), kindSet.has("pipe"), Array.from(new Set([3, 1, 3]), (n) => n * 2));
for (const k of ["file", "dir"] as const) console.log(k.toUpperCase());

// edit distance over preallocated rows
function distance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, () => 0);
  let cur = Array.from({ length: b.length + 1 }, () => 0);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length]!;
}
console.log(distance("kitten", "sitting"), distance("", "abc"));

// own keys of an index signature
const flags: Record<string, boolean> = { verbose: true };
flags["dry"] = false;
console.log(Object.hasOwn(flags, "dry"), Object.hasOwn(flags, "toString"), Object.keys(flags));
