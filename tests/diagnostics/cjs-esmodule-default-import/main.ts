// Board #279: the default import of a CommonJS module that sets
// __esModule. Node binds it to module.exports (an object here); the
// checker's interop types it as exports.default (a string). Every
// reference refuses by name — the bare value, a member read, the
// `{ default as x }` spelling and a re-export hop — where it used to
// read exports.default silently. The named import stays fine.
import W, { label } from "./m.cjs";
import { default as D } from "./m.cjs";
import R from "./mid.ts";

const w: any = W;
console.log(label, typeof w);
console.log(W.length);
console.log(D);
console.log(R);
