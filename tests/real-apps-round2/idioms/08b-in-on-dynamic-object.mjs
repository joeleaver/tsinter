// The same idiom in JS refuses in the wasm BACKEND (SC3001 libCall:dyn.hasKey): expr-eval's only build error.
const fns = { sin: 1, cos: 2 };
function isFn(name, expr) { return name in expr.functions; }
console.log(isFn("sin", { functions: fns }), isFn("tan", { functions: fns }));
