// GH #110: `exports.x = <expr>` copies the VALUE at the statement — later
// writes to the local it named never reach the export table. Every member
// form: a let, a var, a property chain, a reassigned local, an export
// written twice, and a function the importer calls to move the locals.
let level = 1;
var count = 2;
let tag = "a";
const obj = { x: 10, y: "s" };
exports.level = level;
module.exports.count = count;
exports.ox = obj.x;
module.exports.oy = obj.y;
exports.tag = tag;
tag = "b";
exports.tag2 = tag;
let late = 1;
exports.late = late;
exports.late = late + 100;
const fixed = "const";
exports.fixed = fixed;
function bump() {
  level++;
  count += 10;
  obj.x = 99;
  obj.y = "t";
  late = 7;
  tag = "c";
}
exports.bump = bump;
exports.snap = function () {
  return [level, count, obj.x, obj.y, late, tag].join(" ");
};
