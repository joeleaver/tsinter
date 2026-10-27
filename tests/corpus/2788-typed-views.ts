// @dynamic
// Typed composites shared with dynamic code (SEMANTICS.md S115): a typed
// array, tuple or record in an `any` slot is a live view of the static
// value — identity, mutation from either side, nested values, records —
// and island values enter typed storage only when fresh.

interface Task {
  id: number;
  title: string;
  tags: string[];
  meta: { done: boolean; score: number };
}

const tasks: Task[] = [
  { id: 1, title: "write", tags: ["doc"], meta: { done: false, score: 1 } },
  { id: 2, title: "test", tags: [], meta: { done: true, score: 3 } },
];

// Dynamic code that edits whatever it is handed.
function tagAll(list: any[], tag: string): void {
  for (const t of list) t.tags.push(tag);
}
function finish(task: any): void {
  task.meta.done = true;
  task.meta.score = task.meta.score * 10;
}

tagAll(tasks, "v1");
finish(tasks[0]);
console.log("tags:", tasks.map((t) => t.tags.join("+")).join(" | "));
console.log("meta:", tasks[0].meta.done, tasks[0].meta.score);

// Identity: two crossings of one value are one value.
const a: any = tasks;
const b: any = tasks;
const first: any = tasks[0];
console.log("identity:", a === b, a[0] === first, a[0] === a[1], a.indexOf(first), a.includes(tasks[1]));

// Mutation from the typed side is seen through the view.
tasks.push({ id: 3, title: "ship", tags: ["rel"], meta: { done: false, score: 0 } });
tasks[1].title = "test!";
console.log("view:", a.length, a[2].title, a[1].title, JSON.stringify(a[2].tags));

// Array methods on the view write the typed array.
a.sort((x: any, y: any) => y.id - x.id);
console.log("sorted:", tasks.map((t) => t.id).join(","));
const removed = a.splice(1, 1);
console.log("spliced:", removed[0].id, tasks.map((t) => t.id).join(","), removed[0] === tasks[0]);
a.reverse();
console.log("reversed:", tasks.map((t) => t.id).join(","));

// Tuples and index-signature records.
const range: [number, number] = [1, 5];
const rv: any = range;
rv[1] = rv[1] * 2;
console.log("tuple:", range[0], range[1], Array.isArray(rv), rv.length);
const totals: Record<string, number> = { a: 1 };
const tv: any = totals;
tv.b = 2;
tv.a = tv.a + tv.b;
console.log("record:", JSON.stringify(totals), Object.keys(totals).join(","));

// Printing a view prints the static value.
console.log(a[0]);
console.log(rv, tv);

// Fresh island values enter typed storage.
const parsed: Task[] = JSON.parse('[{"id":9,"title":"x","tags":["p"],"meta":{"done":false,"score":2}}]');
parsed[0].tags.push("q");
const doubled: number[] = [...a.map((t: any) => t.id * 2)];
console.log("fresh:", parsed[0].tags.join(","), doubled.join(","));
