/* SEMANTICS.md S132: code generation from strings is disallowed — the
 * `Function` constructor (called or with `new`, through any alias) and
 * `eval` throw Node's catchable `EvalError: Code generation from strings
 * disallowed for this context`. The oracle is Node run WITH
 * `--disallow-code-generation-from-strings`, so every row is exact. */
import { defineRows, type Row } from "./u3u4-rows.js";

const FLAG = ["--disallow-code-generation-from-strings"];

const ROWS: Row[] = [
  { id: "S132-01 the allowsEval feature probe answers false", nodeArgs: FLAG, src: `let ok;\ntry { const F = Function; new F(""); ok = true; } catch (_) { ok = false; }\nconsole.log(ok);` },
  { id: "S132-02 Function and new Function throw EvalError, catchably", nodeArgs: FLAG, src: `for (const make of [() => new Function("return 1"), () => Function("a", "return a"), () => new Function()]) {\n  try { make(); console.log("compiled"); } catch (e) { console.log(e.name, e.message, e instanceof Error); }\n}` },
  { id: "S132-03 the arguments convert to strings first", nodeArgs: FLAG, src: `const arg = { toString() { console.log("toString ran"); return "x"; } };\ntry { new Function(arg, "return x"); } catch (e) { console.log(e.name); }` },
  { id: "S132-04 eval throws whatever its argument", nodeArgs: FLAG, src: `for (const v of ["1 + 1", 2, undefined]) {\n  try { console.log(eval(v)); } catch (e) { console.log(e.name, e.message); }\n}` },
  { id: "S132-05 the Function constructor as a value", nodeArgs: FLAG, src: `const F = Function;\nconsole.log(typeof F, F.name, F === Function);` },
  { id: "S132-06 in TypeScript", entry: "main.ts", nodeArgs: FLAG, src: `let ok: boolean;\ntry { const F = Function; new F(""); ok = true; } catch (_) { ok = false; }\nconsole.log(ok);\ntry { Function("a", "return a"); } catch (e) { console.log((e as Error).name, (e as Error).message); }` },
  { id: "S132-08 an indirect eval throws the same EvalError", nodeArgs: FLAG, src: `try { (0, eval)("1"); } catch (e) { console.log(e.name, e.message); }` },
  { id: "S132-09 Function's own members stop by name (length, name)", nodeArgs: FLAG, src: `console.log(Function.length, Function.name);`, fence: { text: /'Function\.length' \(a member of the Function constructor, SEMANTICS\.md S132\) is not supported yet \[SC1090/, stdout: "" } },
  { id: "S132-10 Function.prototype stops by name", nodeArgs: FLAG, src: `console.log(typeof Function.prototype);`, fence: { text: /'Function\.prototype' \(a member of the Function constructor, SEMANTICS\.md S132\) is not supported yet \[SC1090/, stdout: "" } },
  { id: "S132-11 Function.call, apply and bind throw the EvalError", nodeArgs: FLAG, src: `try { Function.call(null, "return 1"); } catch (e) { console.log(e.name, e.message); }\ntry { Function.apply(null, ["return 1"]); } catch (e) { console.log(e.name, e.message); }\ntry { Function.bind(null)("x"); } catch (e) { console.log(e.name, e.message); }` },
  { id: "S132-12 Function.prototype.constructor stops by name", nodeArgs: FLAG, src: `try { Function.prototype.constructor("return 1"); } catch (e) { console.log(e.name, e.message); }`, fence: { text: /'Function\.prototype\.constructor' is part of the standard library types but has no scriptc lowering yet/, stdout: "" } },
  { id: "S132-13 the Function value: name and length as Node's, its prototype stops by name", nodeArgs: FLAG, src: `const F = Function;\nconsole.log(F.name, F.length, typeof F, F === Function);\ntry { new F("return 1"); } catch (e) { console.log(e.name); }\nconsole.log(typeof F.prototype);`, fence: { text: /Function\.prototype read through the Function constructor taken as a value is not supported yet/, stdout: "Function 1 function true\nEvalError\n" } },
  { id: "S132-14 a Function.prototype member read (not called) off the Function value stops by name", nodeArgs: FLAG, src: `const F = Function;\nconsole.log(typeof F, F.name);\nconsole.log(typeof F.call, typeof F.toString, typeof F.constructor, F.constructor === Function, typeof F.apply);`, fence: { text: /reading 'call' of a function held as a dynamic value \(a Function\.prototype member\) is not supported yet/, stdout: "function Function\n" } },
  { id: "S132-15 ... toString, hasOwnProperty, valueOf held in a binding", nodeArgs: FLAG, src: `const F = Function;\nconst t = F.toString;\nconsole.log(t === undefined);`, fence: { text: /reading 'toString' of a function held as a dynamic value/, stdout: "" } },
  { id: "S132-07 an uncaught one ends the program (S007's rendering of Node's report)", nodeArgs: FLAG, uncaught: "EvalError: Code generation from strings disallowed for this context", src: `console.log("before");\nnew Function("x");\nconsole.log("never");` },
];

defineRows("S132: code generation from strings", ROWS);
