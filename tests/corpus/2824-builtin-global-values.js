// @deferred-fences: 2
// A builtin global taken as a VALUE in a JavaScript source (GH #74).
// typeof answers Node's own "object" / "function" for every spelling;
// identity uses — ===, truthiness, the knownGlobals Set's membership
// tests — answer exactly. Any other use (an argument to a user function,
// a stored value) has no runtime object behind it here, so the statement
// refuses by name instead of handing the callee a string: the two such
// statements below sit behind a condition Node never takes, and stay
// runtime fences that never fire.
'use strict';
console.log(typeof process, typeof Math, typeof console, typeof JSON, typeof globalThis);
console.log(typeof globalThis.process, typeof setTimeout, typeof Symbol);
const p = process;
console.log(typeof p, typeof p.cwd);

const known = new Set([setTimeout, clearTimeout, Math, process]);
console.log(known.has(Math), known.has(process), known.has(JSON));
known.add(console);
console.log(known.has(console), known.has(globalThis.process));

const g = globalThis.Math;
console.log(g === Math, Math !== JSON, !!process, Math ? 'truthy' : 'falsy');

function show(label, v) {
  console.log(label, typeof v);
}
if (process.argv.length > 99) {
  show('process', process);
}
if (process.argv.length > 99) {
  console.log({ m: Math });
}
console.log('done');
