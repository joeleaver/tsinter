// @deferred-fences: 4
// A variadic callback (`arguments` or a rest parameter) handed to a
// builtin would receive its OBJECT and ARRAY arguments as copies here,
// where Node passes the objects themselves — a write, a push, an identity
// test or an onward flow would observe the copy. So such a callback may
// read only the argument count and the scalar positions; any other use of
// a composite position refuses by name (GH #22). The four refused
// statements below sit behind a condition Node never takes; the scalar
// reads run.
'use strict';
const objs = [{ v: 1 }, { v: 2 }];
const nums = [5, 6];
console.log(objs.map(function () { return arguments.length + ':' + arguments[1]; }).join(' '));
console.log(nums.map((...a) => a[0] * 2 + a[1]).join(','));
if (process.argv.length > 99) {
  objs.forEach(function () { arguments[0].v = arguments[0].v * 10; });
}
if (process.argv.length > 99) {
  nums.forEach((...a) => { a[2].push(7); });
}
if (process.argv.length > 99) {
  console.log(objs.map(function () { return arguments[0]; }).length);
}
if (process.argv.length > 99) {
  objs.sort(function () { return arguments[0].v - arguments[1].v; });
}
console.log(objs[0].v, objs[1].v, nums.length);
