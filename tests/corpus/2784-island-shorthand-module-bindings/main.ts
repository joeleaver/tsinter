// @dynamic
/// <reference path="./decl.d.ts" />
// A package typed only by a SHORTHAND ambient module (`declare module
// "esmodpkg";`) imported three ways at once: the default, a named export
// and the namespace are three distinct bindings (the checker answers the
// one module symbol for all of them). The package is CommonJS that sets
// __esModule — imported from ESM, Node binds the default to module.exports
// itself, not exports.default (board #279's island half).
import W, { label } from "esmodpkg";
import * as NS from "esmodpkg";
const w: any = W;
const ns: any = NS;
console.log(typeof w, String(label), typeof ns);
console.log(String(w.label), String(w.extra), String(w.default));
console.log(String(ns.label), typeof ns.default, String(ns.default.default));
console.log(String(ns.__esModule), String(ns["module.exports"] === ns.default), String(ns["module.exports"] === w));
