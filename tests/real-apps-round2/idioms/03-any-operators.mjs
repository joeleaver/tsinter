// Queue #2 (5 apps / 42 sites): operators on any-typed values in JS (peggy, semver, expr-eval, papaparse, matchit).
// Fences (deferred, runtime): line 4 SC2011 `|` on any; line 8 SC1043 "comparing non-number, non-string values"
// (`k-- > 0` with k any). papaparse's `this._rowCount += results.data.length` reports the same SC1043 text.
function parse(options, n) {
  let pos = options.pos | 0;
  let count = options.count;
  count += n;
  let k = n;
  while (k-- > 0) pos++;
  return [pos, count === 3, (pos >>> 0) | 1];
}
console.log(parse({ pos: 2, count: 0 }, 3).join(","));
