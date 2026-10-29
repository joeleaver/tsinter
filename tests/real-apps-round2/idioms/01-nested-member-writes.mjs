// Queue #1 (6 apps / 71 sites): writes and updates through nested or untyped receivers in JS, as papaparse
// (`_results.meta.delimiter = d`, `headerCount[h]++`), semver (`src[index] = value`, `t[name] = index`) and
// peggy's pgn.js (`self.expected = e` on `Error.call(this)`) write them.
var _results;
function reset() { _results = { data: [], errors: [], meta: {} }; }
reset();
_results.meta.delimiter = ",";
_results.meta.fields = ["a"];
function countHeaders(headers) {
  const headerCount = {};
  for (const h of headers) {
    headerCount[h] = headerCount[h] || 0;
    headerCount[h]++;
  }
  return headerCount;
}
const src = [];
const t = {};
let R = 0;
function createToken(name, value) { const index = R++; t[name] = index; src[index] = value; }
createToken("NUM", "\\d+");
console.log(JSON.stringify(_results), JSON.stringify(countHeaders(["a", "b", "a"])), JSON.stringify(t), src.length);
