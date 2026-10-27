// Board #281: a .js file with no import or export is an ES module when its
// nearest package.json says "type": "module" (tests/corpus/package.json
// does) — Node decides by the package type first, syntax only when the
// scope names none. The CommonJS module globals are not defined here.
console.log(typeof require, typeof __filename, typeof __dirname);
console.log(typeof this);
function f() {
  return this;
}
console.log(f() === undefined);
