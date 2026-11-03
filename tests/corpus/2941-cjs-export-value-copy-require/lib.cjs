// GH #110: the same member-export forms, read through require().
let level = 1;
var count = 2;
const obj = { x: 10, y: "s" };
exports.level = level;
module.exports.count = count;
exports.ox = obj.x;
let tag = "a";
tag = "b";
exports.tag = tag;
function bump() {
  level++;
  count += 10;
  obj.x = 99;
  tag = "c";
}
exports.bump = bump;
exports.snap = function () {
  return [level, count, obj.x, tag].join(" ");
};
