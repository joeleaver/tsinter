// A CommonJS module's default (its module.exports) re-exported under a
// name through a facade binds the same table a default import does.
import { pc } from "./facade.ts";
import direct from "./lib.cjs";
console.log(pc.green("ok"), pc.level, direct.green("d"));
