// the cycle-breaking idiom: export the class first, require dependencies at the bottom (SC1013)
class Range {
  constructor(r) { this.r = r; }
  test() { return Comparator.ok(this.r); }
}
Range.ANY = {};
module.exports = Range;
const Comparator = require("./comparator.cjs");
