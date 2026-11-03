// GH #110: an ES module importing a CommonJS module's member exports by
// name reads the values copied at each `exports.x = ...`.
import lib, { level, count, ox, bump } from "./lib.cjs";
bump();
console.log(level, count, ox, lib.level, lib.count, lib.ox);
