// @deferred-fences: 1
// JS statements with no static lowering compile as RUNTIME fences — the
// program builds, and the fences sit untaken behind the same conditions
// Node never takes. The dual-mode number/bigint helper is the shape that
// matters: `typeof ms === 'bigint'` folds constant-false over a checked-
// dynamic parameter (no dyn box holds a bigint), so the bigint arm — whose
// literals have no lowering — folds away and the number path runs (the
// record read `multipliers.two` compiles; the untaken Proxy wrap is the
// statement that carries the deferred fence).
'use strict';

function platformScale(ms) {
  const multipliers = typeof ms === 'bigint' ? { two: 2n, four: 4n } : { two: 2, four: 4 };
  if (globalThis['__scriptc_absent__'] !== undefined) {
    return new Proxy(multipliers, {}).two * ms; // untaken: dynamic-global probes answer undefined
  }
  return ms;
}
console.log('F1', platformScale(4000) === 4000);

// Identity tokens: stdlib global function values participate in identity
// flows (the harness's knownGlobals idiom) — one global, one token.
const known = new Set([setTimeout, clearTimeout, setInterval]);
console.log('F2', known.has(setTimeout), known.has(clearInterval));

// WeakMap constructs as an opaque value; its methods live behind fences
// that never fire here.
const wm = new WeakMap();
console.log('F3', wm !== null);
// F4 (for-in over globalThis) moved to wasm-u3u4-builtins.test.ts U34B-REV-05b: it now stops by name.
