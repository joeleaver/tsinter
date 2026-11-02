// GH #91: `k in obj` with a RUNTIME key on untyped (dynamic) JavaScript values —
// own members (one holding undefined or null included), numeric keys as their
// strings, arrays' length and canonical indices, a member added later, a parsed
// object, and expr-eval's function-table lookup.
function has(k, o) { return k in o; }

const fns = { sin: 1, cos: 2, u: undefined, n: null, 0: "zero", 12: "twelve" };
console.log(has("sin", fns), has("tan", fns), has("u", fns), has("n", fns));
console.log(has(0, fns), has("0", fns), has(12, fns), has(1, fns), has("12", fns));

const arr = [10, 20, 30];
console.log(has("length", arr), has(0, arr), has(2, arr), has(3, arr), has("1", arr), has("01", arr), has("-1", arr), has("x", arr));
console.log(has(-1, arr), has(1.5, arr), has("2", []));

const nested = { functions: { sin: (x) => x } };
const names = ["sin", "cos", "sqrt"];
console.log(names.map((n) => has(n, nested.functions)).join(","));

// a member added later
const o = {};
const key = "late";
console.log(has(key, o));
o[key] = 1;
console.log(has(key, o));

// a parsed object
const parsed = JSON.parse('{"alpha":1,"beta":{"gamma":[1,2]}}');
for (const name of ["alpha", "beta", "gamma"]) console.log(name, has(name, parsed));
console.log(has("gamma", parsed.beta), has("1", parsed.beta.gamma), has("2", parsed.beta.gamma));

// expr-eval's shape: a table lookup in a loop
function isFn(name, expr) { return name in expr.functions; }
const env = { functions: { min: (a, b) => (a < b ? a : b), max: (a, b) => (a > b ? a : b) } };
let found = 0;
for (const n of ["min", "max", "avg", "min"]) if (isFn(n, env)) found++;
console.log("found", found);
