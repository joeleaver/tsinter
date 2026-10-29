class Comparator {
  static ok(r) { return typeof r === "string" && new Range(r) !== null; }
}
module.exports = Comparator;
const Range = require("./range.cjs");
