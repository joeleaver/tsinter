// GH #110: a CommonJS module's member exports are values copied when each
// `exports.x = ...` statement ran. Named imports, renamed imports, the
// default import's properties and an ES facade's re-exports all read those
// copies — never the module's live locals, which bump() moves.
import lib from "./lib.cjs";
import { level, count, ox, oy, tag, tag2, late, fixed, bump, snap } from "./lib.cjs";
import { level as lvl, count as cnt } from "./lib.cjs";
import { level as fl, ox as fox, tag2 as ft, renamedCount } from "./facade.ts";
console.log(level, count, ox, oy, tag, tag2, late, fixed);
bump();
console.log(level, count, ox, oy, tag, tag2, late, fixed);
console.log(lvl, cnt, fl, fox, ft, renamedCount);
console.log(lib.level, lib.count, lib.ox, lib.oy, lib.tag, lib.tag2, lib.late, lib.fixed);
console.log(snap());
