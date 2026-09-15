// Object-literal accessors, the EFFECT contract: the getter body runs once
// per property read at the read's evaluation position, the setter once per
// write — counts and ORDER are Node's exactly. Covers reads as operands
// (left-to-right), reads in template literals and call arguments, the
// compound-assignment get→rhs→set order, ++/--, short-circuit operands
// that never read, destructuring's pattern-order getter calls, and a
// throwing getter caught at the read site. Node is the oracle.

let trace: string[] = [];
let n = 5;
const cell = {
  get v() { trace.push("get"); return n; },
  set v(x: number) { trace.push(`set:${x}`); n = x; },
};

// operands evaluate left to right: get, get
console.log(cell.v + cell.v);
// template pieces in order
console.log(`v=${cell.v}!`);
// call arguments in order
console.log(Math.max(cell.v, 6), trace.join(","));

trace = [];
// compound assignment: get once, rhs, set once
cell.v += 2;
console.log(trace.join(","));
trace = [];
cell.v++;
--cell.v;
console.log(trace.join(","), cell.v);

// short-circuit: the right getter never runs when the left decides
trace = [];
const flags = {
  get no() { trace.push("no"); return false; },
  get yes() { trace.push("yes"); return true; },
};
console.log(flags.no && flags.yes, flags.yes || flags.no, trace.join(","));

// destructuring reads pattern-left-to-right, one getter call each
let seq = 0;
const pair = {
  get first() { seq++; return `f${seq}`; },
  get second() { seq++; return `s${seq}`; },
};
const { second, first } = pair;
console.log(first, second, seq);

// a throwing getter throws at the READ, catchable there
const risky = {
  get boom(): number { throw new Error("no value"); },
};
try {
  console.log(risky.boom);
} catch (e) {
  console.log("caught:", (e as Error).message);
}

// getter results feed ordinary control flow
const gate = {
  get open() { return n > 5; },
};
if (gate.open) console.log("open", n);
else console.log("closed", n);

// a loop hammering both halves — per-iteration counts stay exact
let hits = 0;
const acc = {
  get count() { hits++; return hits; },
  set count(v: number) { hits = v; },
};
let total = 0;
for (let i = 0; i < 5; i++) {
  total += acc.count;
  if (i === 2) acc.count = 10;
}
console.log(total, hits);
