// Board #281 (review B2): a .js file under a "type": "module" scope is an ES
// module even with no import/export, so a require() nested in a block or a
// function never loads there — Node throws ReferenceError ("require is not
// defined in ES module scope") when it runs, catchable. Every spelling
// refuses by name; none silently loads.
try {
  const p = require("node:path");
  console.log("loaded", p.join("a", "b"));
} catch (e) {
  console.log("caught", e.name);
}
function late() {
  return require("node:os").EOL;
}
console.log(typeof late);
