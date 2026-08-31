// Variadic JS functions and function-instance properties: zero-param
// bodies reading `arguments` (the mustCall wrapper's shape), spelled
// ...args rest params, JS arity through boxed calls, computed record
// keys with runtime values, dyn strict equality, dyn member ++, and
// Object.defineProperties onto a function value (the property table
// lives on the closure, so every reference sees it).
'use strict';

// (Array.isArray(arguments) answers true here where Node says false —
// the checked-dynamic tree carries a real array; SEMANTICS.md — so it stays unprobed.)
function collect() {
  return `n=${arguments.length} first=${arguments[0]}`;
}
const c = collect;
console.log(c());
console.log(c('a'));
console.log(c(1, 2, 3));

function tail(head, ...rest) {
  return `${head} then ${rest.length}: ${rest.join(',')}`;
}
const t = tail;
console.log(t('x'));
console.log(t('x', 1));
console.log(t('x', 1, 2, 3));

// Computed keys evaluate at runtime, in source order; later duplicate
// keys win; `in` answers presence, ++ writes through the checked-dynamic tree.
function build(field, n) {
  const rec = { [field]: n, actual: 0, [field + '2']: n * 2 };
  rec.actual++;
  rec.actual += 4;
  return rec;
}
const r = build('exact', 3);
console.log('exact' in r, 'minimum' in r, r.exact, r.exact2, r.actual);
console.log(r.actual === 5, r.exact !== r.exact2);

// defineProperties over a function value: name/length become readable
// own properties. Both reads here are GET-shaped, so `enumerable`
// (honoured on the wasm lane since increment 23 P4 — SEMANTICS.md
// S016's amendment) makes no observable difference either way; the C
// lane stores every descriptor visibly regardless of the flag.
function target() { return arguments.length; }
const wrapped = target;
Object.defineProperties(wrapped, {
  name: { value: 'renamed', writable: false, enumerable: false, configurable: true },
  extra: { value: 41, writable: true, enumerable: true, configurable: true },
});
console.log('name', wrapped.name, 'extra', wrapped.extra);
console.log('still callable', wrapped(9, 8));

console.log('done');
