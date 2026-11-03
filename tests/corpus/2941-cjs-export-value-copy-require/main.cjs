// GH #110: destructured and property reads of a CommonJS module's member
// exports see the values copied at each `exports.x = ...`; bump() moves only
// the module's own locals.
const lib = require("./lib.cjs");
const { level, count, ox, tag } = require("./lib.cjs");
const { level: renamed } = require("./lib.cjs");
console.log(level, count, ox, tag, renamed);
lib.bump();
console.log(level, count, ox, tag, renamed);
console.log(lib.level, lib.count, lib.ox, lib.tag);
console.log(lib.snap());
