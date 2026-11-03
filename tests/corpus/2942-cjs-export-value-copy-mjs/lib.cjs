let level = 1;
var count = 2;
const obj = { x: 10 };
exports.level = level;
module.exports.count = count;
exports.ox = obj.x;
function bump() {
  level++;
  count++;
  obj.x++;
}
exports.bump = bump;
