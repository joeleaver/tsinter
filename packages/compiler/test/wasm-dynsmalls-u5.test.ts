/* INC-27 unit U5 — the dyn smalls. Rows for the dynamic-value constructs
 * the WasmGC tier now lowers (emitter.ts, dyn.ts, inspect.ts):
 *   - a caught or `unknown` value narrowed by `instanceof Error` and then
 *     read as an Error — the narrowed value is the thrown instance itself;
 *   - DOMException: construction with zero, one or two arguments and with an
 *     options bag (whose name is converted to a string, an absent one reading
 *     "undefined"), the numeric `code` derived from the current name by the
 *     legacy table (0 for any other name), `cause` present, absent or
 *     explicitly undefined, String/template/concatenation, the dynamic view,
 *     and util.inspect's stackless bracket form. Board #187 is fixed: a
 *     DOMException thrown by atob or btoa reads `.code` as its number. A
 *     write to a DOMException's getter-only name, message or code — directly
 *     or through Object.assign — refuses by name (board #198);
 *   - structuredClone over the dynamic tree: deep, a shared child and a cycle
 *     kept as Node keeps them, errors and DOMExceptions as fresh instances,
 *     Node's option checks and DataCloneError; a function is a named refusal;
 *   - spread arguments in a call (`f(...xs)`) and variadic Object.assign's
 *     source pack, with V8's TypeError texts, which depend on the spread's
 *     position; a target that is not a plain object refuses by name (the
 *     two-argument form keeps board #193's answer);
 *   - Object.create(null) through the dynamic readers; converting one to a
 *     primitive (String, a template, `+`, join, a computed key) refuses by
 *     name, and `o.toString()` throws Node's TypeError;
 *   - board #196 is fixed: when a module with top-level await fails, the
 *     failure is reported at the first microtask drain that observes it,
 *     before an unrelated rejection's unhandledRejection listener or a
 *     queued nextTick runs. Node also lets a few already-queued microtasks
 *     run after the failure while this tier drains the whole queue (board
 *     #197); no row here depends on that count.
 *
 * Every expected line below is an INLINED literal: a run row's stdout is a
 * real Node v24 run (`node --experimental-transform-types` for .ts, plain
 * `node` otherwise) of the SAME source, byte for byte; a refusal row's
 * diagnostics and survey are this tier's own named refusal. Nothing outside
 * this repository is read at test time; corpus rows read tests/corpus
 * through a relative path. Row classes, in file order: DYNCHECK, DOMEX,
 * DOMEX-WRITE, DOMEX-INSPECT, NOT-LIFTED, ORDER, CLONE, UNCLONE, SPREAD,
 * ASSIGN, PACK, NULLPROTO, CORPUS.
 *
 * Rows that assert THIS TIER's answer instead of a Node run state Node's
 * answer beside them and name the reason: a registered divergence
 * (SEMANTICS.md S025, S021, S027 — the inspect rows compare against Node's
 * output for the same program with every stack cleared), a board, an
 * existing named fence, or a named refusal of this unit. A trap row's
 * stderr is the tier's report line (S007 for an uncaught exception, S010
 * for an unhandled rejection, which is how a failing top-level-await
 * module reports); a trap is this tier's exit 1. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { runWasm, runWasmToTrap } from "./wasm-host.js";

let scratch: string;
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "tsinter-wasm-dynsmalls-u5-"));
  // A row compiles in a directory whose package.json matches its source:
  // .ts and .mjs rows in an ES-module directory, .cjs rows in a CommonJS one.
  await mkdir(join(scratch, "esm"));
  await mkdir(join(scratch, "cjs"));
  await writeFile(join(scratch, "esm", "package.json"), '{"type":"module"}\n');
  await writeFile(join(scratch, "cjs", "package.json"), '{"type":"commonjs"}\n');
});
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

/** A `// @dynamic` head builds with --dynamic (the differential harness's
 * own rule). */
function isDynamic(src: string): boolean {
  return /^\/\/ @dynamic\s*$/m.test(src.split("\n", 2).join("\n"));
}

function dirFor(ext: string): string {
  return join(scratch, ext === "cjs" ? "cjs" : "esm");
}

/** Each row's source is written byte for byte as it was run under Node. */
async function build(id: string, src: string, ext: string): Promise<{ entry: string; res: Awaited<ReturnType<typeof compile>> }> {
  const dir = dirFor(ext);
  const entry = join(dir, `${id}.${ext}`);
  await writeFile(entry, src);
  const res = await compile(entry, { outPath: join(dir, `${id}.wasm`), outDir: dir, backend: "wasm", dynamic: isDynamic(src) });
  return { entry, res };
}

/** The row's own path in its output (a fence message) reads `<ROW>`. */
async function runRow(id: string, src: string, ext: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const { entry, res } = await build(id, src, ext);
  if (!res.ok) throw new Error(`${id} refused: ${res.diagnostics.map((d) => d.message).join(" | ")}`);
  const run = await runWasm(res.binaryPath);
  return { stdout: String(run.stdout).split(entry).join("<ROW>"), stderr: String(run.stderr), exitCode: run.exitCode };
}

/** A row expecting an uncaught trap: runWasmToTrap asserts the trap and
 * reports what was printed before it. The row's own path reads `<ROW>`. */
async function runRowTrap(id: string, src: string, ext: string): Promise<{ stdout: string; stderr: string }> {
  const { entry, res } = await build(id, src, ext);
  if (!res.ok) throw new Error(`${id} refused: ${res.diagnostics.map((d) => d.message).join(" | ")}`);
  const run = await runWasmToTrap(res.binaryPath);
  return { stdout: String(run.stdout), stderr: String(run.stderr).split(entry).join("<ROW>") };
}

async function refuseRow(id: string, src: string, ext: string): Promise<{ diagnostics: string[]; survey: string[] }> {
  const { entry, res } = await build(id, src, ext);
  if (res.ok) throw new Error(`${id} compiled but was expected to refuse`);
  return {
    diagnostics: [...new Set(res.diagnostics.map((d) => `${d.code}: ${d.message}`.split(entry).join("<ROW>")))].sort(),
    survey: [...(res.wasmSurvey ?? [])].sort(),
  };
}

/** A multi-file row expecting a trap: every file in its own directory, the
 * entry is main.ts. */
async function runRowDirTrap(id: string, files: Record<string, string>): Promise<{ stdout: string; stderr: string }> {
  const dir = join(scratch, "esm", id);
  await mkdir(dir);
  for (const [name, src] of Object.entries(files)) await writeFile(join(dir, name), src);
  const res = await compile(join(dir, "main.ts"), { outPath: join(dir, "main.wasm"), outDir: dir, backend: "wasm", dynamic: isDynamic(files["main.ts"]!) });
  if (!res.ok) throw new Error(`${id} refused: ${res.diagnostics.map((d) => d.message).join(" | ")}`);
  const run = await runWasmToTrap(res.binaryPath);
  let stderr = String(run.stderr);
  for (const name of Object.keys(files)) stderr = stderr.split(join(dir, name)).join("<ROW>");
  return { stdout: String(run.stdout), stderr };
}

async function compileCorpus(id: string, relPath: string) {
  const entry = fileURLToPath(new URL(`../../../tests/corpus/${relPath}`, import.meta.url));
  const src = await readFile(entry, "utf8");
  const res = await compile(entry, { outPath: join(scratch, `${id}.wasm`), outDir: scratch, backend: "wasm", dynamic: isDynamic(src) });
  return { entry, res };
}

async function runCorpusRow(id: string, relPath: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const { res } = await compileCorpus(id, relPath);
  if (!res.ok) throw new Error(`${id} refused: ${res.diagnostics.map((d) => d.message).join(" | ")}`);
  const run = await runWasm(res.binaryPath);
  return { stdout: String(run.stdout), stderr: String(run.stderr), exitCode: run.exitCode };
}

async function runCorpusRowTrap(id: string, relPath: string): Promise<{ stdout: string; stderr: string }> {
  const { res } = await compileCorpus(id, relPath);
  if (!res.ok) throw new Error(`${id} refused: ${res.diagnostics.map((d) => d.message).join(" | ")}`);
  const run = await runWasmToTrap(res.binaryPath);
  return { stdout: String(run.stdout), stderr: String(run.stderr) };
}

// ----------------------------------------------------------------------
// DYNCHECK — a caught or unknown value narrowed by `instanceof Error` and read as an Error

test("R01 DYNCHECK: every Error kind and a non-Error through an instanceof Error narrow (everything printed)", async () => {
  const src = "function show(u: unknown): void {\n  if (u instanceof Error) console.log(`E name=${u.name} msg=${u.message} str=${String(u)}`);\n  else console.log(`other ${typeof u}`);\n}\ntry { throw new Error(\"a\"); } catch (e) { show(e); }\ntry { throw new TypeError(\"b\"); } catch (e) { show(e); }\ntry { throw new RangeError(\"\"); } catch (e) { show(e); }\ntry { throw new SyntaxError(\"s\"); } catch (e) { show(e); }\ntry { throw \"str\"; } catch (e) { show(e); }\ntry { throw 7; } catch (e) { show(e); }\nshow(null);\nshow(undefined);\nshow({ message: \"fake\" });\nclass Custom extends Error { constructor(m: string) { super(m); this.name = \"Custom\"; } }\ntry { throw new Custom(\"c\"); } catch (e) { show(e); }\n";
  const { stdout, stderr, exitCode } = await runRow("R01", src, "ts");
  expect(stdout).toBe("E name=Error msg=a str=Error: a\nE name=TypeError msg=b str=TypeError: b\nE name=RangeError msg= str=RangeError\nE name=SyntaxError msg=s str=SyntaxError: s\nother string\nother number\nother object\nother undefined\nother object\nE name=Custom msg=c str=Custom: c\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("R02 DYNCHECK: the narrowed value is the thrown instance itself (identity across two crossings)", async () => {
  const src = "const orig = new TypeError(\"id\");\nlet held: unknown = null;\ntry { throw orig; } catch (e) { held = e; }\nif (held instanceof Error) {\n  console.log(held === orig, held.name, held.message);\n}\nconst again: unknown = held;\nif (again instanceof Error) console.log(again === orig);\n";
  const { stdout, stderr, exitCode } = await runRow("R02", src, "ts");
  expect(stdout).toBe("true TypeError id\ntrue\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("R03 DYNCHECK: a narrowed Error returned from a function keeps its identity", async () => {
  const src = "function asErr(u: unknown): Error | null {\n  return u instanceof Error ? u : null;\n}\nconst e = new RangeError(\"r\");\nlet got: unknown = null;\ntry { throw e; } catch (x) { got = x; }\nconst back = asErr(got);\nconsole.log(back === e, back?.message, asErr(\"s\") === null);\n";
  const { stdout, stderr, exitCode } = await runRow("R03", src, "ts");
  expect(stdout).toBe("true r true\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("R04 DYNCHECK: SEMANTICS.md S025: a parsed object carrying the reserved error key narrows as an Error", async () => {
  const src = "const u: unknown = JSON.parse('{\"%error\":true,\"name\":\"TypeError\",\"message\":\"alien\"}');\nif (u instanceof Error) console.log(`E ${u.name} ${u.message} ${String(u)}`);\nelse console.log(\"not an error\");\n";
  // This tier's answer (SEMANTICS.md S025); Node prints "not an error\n".
  const { stdout, stderr, exitCode } = await runRow("R04", src, "ts");
  expect(stdout).toBe("E TypeError alien TypeError: alien\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("R04b DYNCHECK: SEMANTICS.md S025: a parsed object carrying the reserved error key narrows twice to the same cached Error", async () => {
  const src = "function asErr(u: unknown): Error | null {\n  return u instanceof Error ? u : null;\n}\nconst u: unknown = JSON.parse('{\"%error\":true,\"name\":\"TypeError\",\"message\":\"alien\"}');\nconsole.log(asErr(u) === asErr(u));\n";
  // This pins SEMANTICS.md S025's identity: the tier narrows the object to one cached Error, so both calls return the same instance. Node prints the same true for a different reason: the object is not an Error there, so both calls return null.
  const { stdout, stderr, exitCode } = await runRow("R04b", src, "ts");
  expect(stdout).toBe("true\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("R05 DYNCHECK: a DOMException narrowed as an Error", async () => {
  const src = "function show(u: unknown): void {\n  if (u instanceof Error) console.log(`E ${u.name} | ${u.message} | ${String(u)}`);\n  else console.log(\"other\");\n}\ntry { atob(\"*\"); } catch (e) { show(e); }\ntry { btoa(\"Ā\"); } catch (e) { show(e); }\nshow(new DOMException(\"m\", \"AbortError\"));\n";
  const { stdout, stderr, exitCode } = await runRow("R05", src, "ts");
  expect(stdout).toBe("E InvalidCharacterError | Invalid character | InvalidCharacterError: Invalid character\nE InvalidCharacterError | Invalid character | InvalidCharacterError: Invalid character\nE AbortError | m | AbortError: m\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("R06 DYNCHECK: a DOMException narrowed as an Error, then its fields", async () => {
  const src = "function show(u: unknown): void {\n  if (u instanceof Error) console.log(u.name, u.message, String(u));\n}\ntry { btoa(\"Ā\"); } catch (e) { show(e); }\n";
  const { stdout, stderr, exitCode } = await runRow("R06", src, "ts");
  expect(stdout).toBe("InvalidCharacterError Invalid character InvalidCharacterError: Invalid character\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("R07 DYNCHECK: not lifted: an instanceof TypeError narrow on unknown stays a front-end refusal (board #189)", async () => {
  const src = "function show(u: unknown): void {\n  if (u instanceof TypeError) console.log(`TE ${u.message}`);\n  else console.log(\"not TE\");\n}\ntry { throw new TypeError(\"t\"); } catch (e) { show(e); }\ntry { throw new Error(\"e\"); } catch (e) { show(e); }\n";
  const { diagnostics, survey } = await refuseRow("R07", src, "ts");
  expect(survey).toEqual([]);
  expect(diagnostics).toEqual(["SC9001: internal compiler error: in show: fieldGet receiver: expected object, got dyn — please report this"]);
});

test("R08 DYNCHECK: not lifted: instanceof a user class on unknown stays a named front-end refusal", async () => {
  const src = "class Box { v = 3; }\nfunction show(u: unknown): void {\n  if (u instanceof Box) console.log(`Box ${u.v}`);\n  else console.log(\"not Box\");\n}\nshow(new Box());\nshow(1);\n";
  const { diagnostics, survey } = await refuseRow("R08", src, "ts");
  expect(survey).toEqual([]);
  expect(diagnostics).toEqual(["SC1090: 'instanceof Box' on 'unknown' values (only the Error classes answer — test 'instanceof Error' and read '.name') are not supported yet","SC1101: converting typed values to 'unknown' is not supported yet"]);
});

test("R09 DYNCHECK: not lifted: a checked cast of unknown to Error stays a named front-end refusal", async () => {
  const src = "function msg(u: unknown): string {\n  try { return (u as Error).message; } catch (e) { return \"threw \" + String(e); }\n}\nconsole.log(msg(new TypeError(\"t\")));\nconsole.log(msg(JSON.parse('\"x\"')));\nconsole.log(msg(JSON.parse('{\"a\":1}')));\n";
  const { diagnostics, survey } = await refuseRow("R09", src, "ts");
  expect(survey).toEqual([]);
  expect(diagnostics).toEqual(["SC1090: a checked cast of 'unknown' to 'Error' (a dynamic value can only be validated against JSON-representable types: number, string, boolean, records, arrays, and unions of those) is not supported yet"]);
});

// ----------------------------------------------------------------------
// DOMEX — construction, the derived numeric code, cause, conversions, the dynamic view

test("R10 DOMEX: construction with zero, one and two arguments (everything printed)", async () => {
  const src = "'use strict';\nconst all = [\n  new DOMException(),\n  new DOMException(\"m1\"),\n  new DOMException(\"m2\", \"AbortError\"),\n  new DOMException(\"m3\", \"Whatever\"),\n  new DOMException(undefined, undefined),\n  new DOMException(\"m5\", undefined),\n  new DOMException(5, null),\n  new DOMException(null, 7),\n  new DOMException(\"\", \"DOMException\"),\n];\nfor (const e of all) console.log(JSON.stringify([e.name, e.message, e.code, \"cause\" in e]));\n";
  const { stdout, stderr, exitCode } = await runRow("R10", src, "cjs");
  expect(stdout).toBe("[\"Error\",\"\",0,false]\n[\"Error\",\"m1\",0,false]\n[\"AbortError\",\"m2\",20,false]\n[\"Whatever\",\"m3\",0,false]\n[\"Error\",\"\",0,false]\n[\"Error\",\"m5\",0,false]\n[\"null\",\"5\",0,false]\n[\"7\",\"null\",0,false]\n[\"DOMException\",\"\",0,false]\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("R11 DOMEX: the options bag: name, cause present, absent and explicitly undefined", async () => {
  const src = "'use strict';\nconst all = [\n  new DOMException(\"a\", { name: \"NotFoundError\", cause: 42 }),\n  new DOMException(\"b\", { name: \"AbortError\" }),\n  new DOMException(\"c\", { cause: \"only\" }),\n  new DOMException(\"d\", { cause: undefined }),\n  new DOMException(\"e\", { cause: null }),\n  new DOMException(\"f\", {}),\n  new DOMException(\"g\", { name: \"X\", cause: { deep: [1] } }),\n];\nfor (const e of all) console.log(JSON.stringify([String(e.name), e.message, e.code, \"cause\" in e, e.cause === undefined, String(e.cause)]));\nconsole.log(JSON.stringify(all[6].cause));\n";
  const { stdout, stderr, exitCode } = await runRow("R11", src, "cjs");
  expect(stdout).toBe("[\"NotFoundError\",\"a\",8,true,false,\"42\"]\n[\"AbortError\",\"b\",20,false,true,\"undefined\"]\n[\"undefined\",\"c\",0,true,false,\"only\"]\n[\"undefined\",\"d\",0,true,true,\"undefined\"]\n[\"undefined\",\"e\",0,true,false,\"null\"]\n[\"undefined\",\"f\",0,false,true,\"undefined\"]\n[\"X\",\"g\",0,true,false,\"[object Object]\"]\n{\"deep\":[1]}\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("R12 DOMEX: an options bag's name is converted to a string, an absent one reading \"undefined\"", async () => {
  const src = "'use strict';\nfor (const o of [{}, { name: undefined }, { name: null }, { name: 5 }, { name: \"\" }, { name: \"AbortError\" }, { cause: 1 }]) {\n  const e = new DOMException(\"m\", o);\n  console.log(typeof e.name, JSON.stringify(e.name), e.code, \"cause\" in e);\n}\n";
  const { stdout, stderr, exitCode } = await runRow("R12", src, "cjs");
  expect(stdout).toBe("string \"undefined\" 0 false\nstring \"undefined\" 0 false\nstring \"null\" 0 false\nstring \"5\" 0 false\nstring \"\" 0 false\nstring \"AbortError\" 20 false\nstring \"undefined\" 0 true\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("R13 DOMEX: the numeric code of every legacy name, other names and the default name", async () => {
  const src = "'use strict';\nconst names = [\"IndexSizeError\",\"DOMStringSizeError\",\"HierarchyRequestError\",\"WrongDocumentError\",\"InvalidCharacterError\",\"NoDataAllowedError\",\"NoModificationAllowedError\",\"NotFoundError\",\"NotSupportedError\",\"InUseAttributeError\",\"InvalidStateError\",\"SyntaxError\",\"InvalidModificationError\",\"NamespaceError\",\"InvalidAccessError\",\"ValidationError\",\"TypeMismatchError\",\"SecurityError\",\"NetworkError\",\"AbortError\",\"URLMismatchError\",\"QuotaExceededError\",\"TimeoutError\",\"InvalidNodeTypeError\",\"DataCloneError\",\"EncodingError\",\"NotReadableError\",\"UnknownError\",\"ConstraintError\",\"DataError\",\"TransactionInactiveError\",\"ReadOnlyError\",\"VersionError\",\"OperationError\",\"NotAllowedError\",\"Whatever\",\"Error\",\"abortError\",\"ABORTERROR\",\"AbortError \",\"\"];\nfor (const n of names) console.log(n + \"=\" + new DOMException(\"m\", n).code);\nconsole.log(new DOMException(\"m\").code, new DOMException(\"m\", { name: \"TimeoutError\" }).code);\n";
  const { stdout, stderr, exitCode } = await runRow("R13", src, "cjs");
  expect(stdout).toBe("IndexSizeError=1\nDOMStringSizeError=0\nHierarchyRequestError=3\nWrongDocumentError=4\nInvalidCharacterError=5\nNoDataAllowedError=0\nNoModificationAllowedError=7\nNotFoundError=8\nNotSupportedError=9\nInUseAttributeError=10\nInvalidStateError=11\nSyntaxError=12\nInvalidModificationError=13\nNamespaceError=14\nInvalidAccessError=15\nValidationError=0\nTypeMismatchError=17\nSecurityError=18\nNetworkError=19\nAbortError=20\nURLMismatchError=21\nQuotaExceededError=22\nTimeoutError=23\nInvalidNodeTypeError=24\nDataCloneError=25\nEncodingError=0\nNotReadableError=0\nUnknownError=0\nConstraintError=0\nDataError=0\nTransactionInactiveError=0\nReadOnlyError=0\nVersionError=0\nOperationError=0\nNotAllowedError=0\nWhatever=0\nError=0\nabortError=0\nABORTERROR=0\nAbortError =0\n=0\n0 23\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("R14 DOMEX: String, toString, template and concatenation of a DOMException", async () => {
  const src = "'use strict';\n// Derived: the JSON.stringify line of the original is a front-end fence of its own, so it is not here.\nconst e = new DOMException(\"boom\", \"AbortError\");\nconsole.log(String(e), e.toString(), `${e}`, \"\" + e);\nconsole.log(e instanceof DOMException, e instanceof Error, typeof e);\nconst n = new DOMException(\"\", \"NotFoundError\");\nconsole.log(String(n), String(new DOMException()), String(new DOMException(\"only msg\")));\n";
  const { stdout, stderr, exitCode } = await runRow("R14", src, "cjs");
  expect(stdout).toBe("AbortError: boom AbortError: boom AbortError: boom AbortError: boom\ntrue true object\nNotFoundError Error Error: only msg\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("R15 DOMEX: a DOMException thrown and caught keeps name, code, message and cause", async () => {
  const src = "'use strict';\nfunction f() { throw new DOMException(\"inner\", \"TimeoutError\"); }\ntry { f(); } catch (e) { console.log(e.name, e.code, e.message, e instanceof DOMException, \"cause\" in e); }\ntry { throw new DOMException(\"c\", { name: \"AbortError\", cause: \"why\" }); } catch (e) { console.log(e.cause, \"cause\" in e, e.code); }\n";
  const { stdout, stderr, exitCode } = await runRow("R15", src, "cjs");
  expect(stdout).toBe("TimeoutError 23 inner true false\nwhy true 20\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("R16 DOMEX: board #187: atob and btoa failures read name, code and message as Node does", async () => {
  const src = "'use strict';\nfor (const f of [() => atob(\"*\"), () => atob(\"a\"), () => atob(\"abcde\"), () => btoa(\"Ā\"), () => btoa(\"😀\")]) {\n  try { f(); console.log(\"no throw\"); } catch (e) { console.log(e.name, e.code, e.message, e instanceof DOMException, e instanceof Error, String(e)); }\n}\n";
  const { stdout, stderr, exitCode } = await runRow("R16", src, "cjs");
  expect(stdout).toBe("InvalidCharacterError 5 Invalid character true true InvalidCharacterError: Invalid character\nInvalidCharacterError 5 The string to be decoded is not correctly encoded. true true InvalidCharacterError: The string to be decoded is not correctly encoded.\nInvalidCharacterError 5 The string to be decoded is not correctly encoded. true true InvalidCharacterError: The string to be decoded is not correctly encoded.\nInvalidCharacterError 5 Invalid character true true InvalidCharacterError: Invalid character\nInvalidCharacterError 5 Invalid character true true InvalidCharacterError: Invalid character\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("R17 DOMEX: board #187: an invalid atob input throws InvalidCharacterError with code 5", async () => {
  const src = "'use strict';\ntry { atob(\"*\"); } catch (e) { console.log(e.name, e.code, e instanceof DOMException, e.message); }\n";
  const { stdout, stderr, exitCode } = await runRow("R17", src, "cjs");
  expect(stdout).toBe("InvalidCharacterError 5 true Invalid character\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("R18 DOMEX: SEMANTICS.md S021: a caught atob error logged whole prints its enumerable members, code included", async () => {
  const src = "'use strict';\ntry { atob(\"*\"); } catch (e) { console.log(e); }\n";
  // This tier's answer (SEMANTICS.md S021); Node prints "DOMException [InvalidCharacterError]: Invalid character" and its stack.
  const { stdout, stderr, exitCode } = await runRow("R18", src, "cjs");
  expect(stdout).toBe("{\n  '%error': true,\n  name: 'InvalidCharacterError',\n  message: 'Invalid character',\n  code: 5\n}\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("R19 DOMEX: a statically typed DOMException", async () => {
  const src = "const e = new DOMException(\"t\", \"AbortError\");\nconsole.log(e.name, e.message, e.code, e instanceof Error, String(e));\nconst f = new DOMException(\"u\", { name: \"X\", cause: 1 });\nconsole.log(f.name, f.code, \"cause\" in f);\n";
  const { stdout, stderr, exitCode } = await runRow("R19", src, "ts");
  expect(stdout).toBe("AbortError t 20 true AbortError: t\nX 0 true\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("R20 DOMEX: a DOMException crossing into a dynamic value and into an array", async () => {
  const src = "'use strict';\n// Derived: the original's Object.keys line is a front-end fence of its own, so it is not here.\nfunction take(x) { return [x.name, x.code, \"cause\" in x, x.cause, x.message]; }\nconst a = new DOMException(\"m\", \"AbortError\");\nconst b = new DOMException(\"m\", { name: \"DataError\", cause: 5 });\nconsole.log(JSON.stringify(take(a)), JSON.stringify(take(b)));\nconst arr = [a, b];\nconsole.log(arr[0].code, arr[1].cause, arr[0] === a);\n";
  const { stdout, stderr, exitCode } = await runRow("R20", src, "cjs");
  expect(stdout).toBe("[\"AbortError\",20,false,null,\"m\"] [\"DataError\",0,true,5,\"m\"]\n20 5 true\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("R21 DOMEX: message and name argument conversions", async () => {
  const src = "'use strict';\n// Derived: the original's second loop mixed argument kinds in one array (a front-end fence); the names are one call each.\nfor (const m of [undefined, null, 0, true, \"s\", [1, 2], { a: 1 }]) {\n  const e = new DOMException(m, \"AbortError\");\n  console.log(JSON.stringify(e.message));\n}\nconsole.log(JSON.stringify(new DOMException(\"m\", null).name));\nconsole.log(JSON.stringify(new DOMException(\"m\", 0).name));\nconsole.log(JSON.stringify(new DOMException(\"m\", false).name));\nconsole.log(JSON.stringify(new DOMException(\"m\", [1]).name));\n";
  const { stdout, stderr, exitCode } = await runRow("R21", src, "cjs");
  expect(stdout).toBe("\"\"\n\"null\"\n\"0\"\n\"true\"\n\"s\"\n\"1,2\"\n\"[object Object]\"\n\"null\"\n\"0\"\n\"false\"\n\"undefined\"\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("R23 DOMEX: not lifted: writing name or message of a DOMException is a named compile-time refusal", async () => {
  const src = "'use strict';\nconst e = new DOMException(\"m\", \"AbortError\");\ntry { e.name = \"NotFoundError\"; console.log(\"wrote\", e.name, e.code); } catch (x) { console.log(x.name, x.message); }\ntry { e.message = \"z\"; console.log(\"wrote\", e.message); } catch (x) { console.log(x.name, x.message); }\n";
  const { diagnostics, survey } = await refuseRow("R23", src, "cjs");
  expect(survey).toEqual(["fieldSet:domexception:message","fieldSet:domexception:name"]);
  expect(diagnostics).toEqual(["SC3001: the wasm backend does not support this construct yet (fieldSet:domexception:name); build with the LLVM backend (the default) or the reference C backend (--backend c)"]);
});

test("R26 DOMEX: SEMANTICS.md S007: an uncaught DOMException traps with the tier's report line", async () => {
  const src = "'use strict';\nconsole.log(\"before\");\nthrow new DOMException(\"fatal\", \"AbortError\");\n";
  const { stdout, stderr } = await runRowTrap("R26", src, "cjs");
  expect(stdout).toBe("before\n");
  expect(stderr).toBe("Uncaught AbortError: fatal\n");
});

test("R27 DOMEX: String and template of a caught DOMException and a caught atob error", async () => {
  const src = "'use strict';\ntry { throw new DOMException(\"m\", \"AbortError\"); } catch (e) { console.log(String(e), `${e}`); }\ntry { atob(\"*\"); } catch (e) { console.log(String(e)); }\n";
  const { stdout, stderr, exitCode } = await runRow("R27", src, "cjs");
  expect(stdout).toBe("AbortError: m AbortError: m\nInvalidCharacterError: Invalid character\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

// ----------------------------------------------------------------------
// DOMEX-WRITE — board #198: a DOMException's getter-only name, message and code written through a dynamic value — a member write or an Object.assign put — refuse by name (an uncaught named error), where Node throws a TypeError in strict code and ignores a direct write in sloppy code; an ordinary Error keeps this tier's answer (board #199)

test("W01 DOMEX-WRITE: strict writes to a caught DOMException's name, message and code refuse by name", async () => {
  const src = "'use strict';\nconst d = new DOMException(\"m\", \"AbortError\");\ntry { throw d; } catch (e) {\n  try { e.name = \"X\"; console.log(\"wrote\", e.name, e.code); } catch (x) { console.log(\"threw\", x instanceof TypeError); }\n  try { e.message = \"Z\"; console.log(\"wrote\", e.message); } catch (x) { console.log(\"threw\", x instanceof TypeError); }\n  try { e.code = 9; console.log(\"wrote\", e.code); } catch (x) { console.log(\"threw\", x instanceof TypeError); }\n}\nconsole.log(d.name, d.message, d.code);\nfunction w(x) { x.name = \"Q\"; return x.name; }\ntry { console.log(w(d)); } catch (x) { console.log(\"threw\", x instanceof TypeError); }\n";
  // A named refusal (board #198); Node prints "threw true\nthrew true\nthrew true\nAbortError m 20\nthrew true\n" and exits 0.
  const { stdout, stderr } = await runRowTrap("W01", src, "cjs");
  expect(stdout).toBe("");
  expect(stderr).toBe("Uncaught Error: writing a DOMException's name is not supported yet (Node's name is getter-only)\n");
});

test("W02 DOMEX-WRITE: sloppy writes to caught DOMExceptions refuse by name where Node ignores them", async () => {
  const src = "try { atob(\"*\"); } catch (e) {\n  e.name = \"X\"; console.log(\"after\", e.name, e.code);\n}\nconst d = new DOMException(\"m\", \"AbortError\");\ntry { throw d; } catch (e) { e.message = \"z\"; console.log(\"after2\", e.message, e.name); }\n";
  // A named refusal (board #198); Node prints "after InvalidCharacterError 5\nafter2 m AbortError\n" and exits 0.
  const { stdout, stderr } = await runRowTrap("W02", src, "cjs");
  expect(stdout).toBe("");
  expect(stderr).toBe("Uncaught Error: writing a DOMException's name is not supported yet (Node's name is getter-only)\n");
});

test("W03 DOMEX-WRITE: board #198: strict writes to a caught atob DOMException refuse by name", async () => {
  const src = "'use strict';\ntry { atob(\"*\"); } catch (e) {\n  try { e.name = \"X\"; console.log(\"wrote\", e.name, e.code); } catch (x) { console.log(\"threw\", x instanceof TypeError); }\n  try { e.message = \"Z\"; console.log(\"wrote\", e.message); } catch (x) { console.log(\"threw\", x instanceof TypeError); }\n  try { e.code = 9; console.log(\"wrote\", e.code); } catch (x) { console.log(\"threw\", x instanceof TypeError); }\n}\ntry { throw new TypeError(\"t\"); } catch (e) { e.name = \"R\"; e.message = \"M\"; console.log(e.name, e.message, String(e)); }\n";
  // A named refusal (board #198); Node prints "threw true\nthrew true\nthrew true\nR M R: M\n" and exits 0.
  const { stdout, stderr } = await runRowTrap("W03", src, "cjs");
  expect(stdout).toBe("");
  expect(stderr).toBe("Uncaught Error: writing a DOMException's name is not supported yet (Node's name is getter-only)\n");
});

test("W04 DOMEX-WRITE: a strict write through an untyped parameter refuses by name", async () => {
  const src = "'use strict';\nconst d = new DOMException(\"m\", \"AbortError\");\nfunction w(x) { x.name = \"Q\"; return x.name; }\nconsole.log(\"before\");\ntry { console.log(w(d)); } catch (x) { console.log(\"threw\", x instanceof TypeError); }\nconsole.log(d.name);\n";
  // A named refusal (board #198); Node prints "before\nthrew true\nAbortError\n" and exits 0.
  const { stdout, stderr } = await runRowTrap("W04", src, "cjs");
  expect(stdout).toBe("before\n");
  expect(stderr).toBe("Uncaught Error: writing a DOMException's name is not supported yet (Node's name is getter-only)\n");
});

test("W05 DOMEX-WRITE: a sloppy write through an untyped parameter refuses by name", async () => {
  const src = "const d = new DOMException(\"m\", \"AbortError\");\nfunction w(x) { x.message = \"Q\"; return x.message; }\nconsole.log(\"before\");\nconsole.log(w(d));\n";
  // A named refusal (board #198); Node prints "before\nm\n" and exits 0.
  const { stdout, stderr } = await runRowTrap("W05", src, "cjs");
  expect(stdout).toBe("before\n");
  expect(stderr).toBe("Uncaught Error: writing a DOMException's message is not supported yet (Node's message is getter-only)\n");
});

test("W06 DOMEX-WRITE: a write in a .catch handler meets the existing named assignment fence", async () => {
  const src = "'use strict';\nPromise.reject(new DOMException(\"m\", \"AbortError\")).catch((e) => {\n  try { e.code = 9; console.log(\"wrote\", e.code); } catch (x) { console.log(\"threw\", x instanceof TypeError, x.message); }\n});\nconsole.log(\"sync\");\n";
  // This tier's answer (the existing SC1090 run-time fence on member assignment, every lane); Node prints "sync\nthrew true Cannot set property code of  which has only a getter\n".
  const { stdout, stderr, exitCode } = await runRow("W06", src, "cjs");
  expect(stdout).toBe("sync\nthrew false assignment to non-variables are not supported yet [SC1090 at <ROW>:3]\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("W07 DOMEX-WRITE: an Error-typed binding holding a DOMException: the name write refuses by name", async () => {
  const src = "let a: Error = new Error(\"a\");\na.message = \"b\";\nconsole.log(a.message);\ntry { atob(\"*\"); } catch (e) { console.log(\"atob threw\"); }\nlet d: Error = new DOMException(\"m\", \"AbortError\");\nconsole.log(\"before\");\nd.name = \"X\";\nconsole.log(\"after\", d.name);\nexport {};\n";
  const { stdout, stderr } = await runRowTrap("W07", src, "ts");
  expect(stdout).toBe("b\natob threw\nbefore\n");
  expect(stderr).toBe("Uncaught Error: writing a DOMException's name is not supported yet (Node's name is getter-only)\n");
});

test("W08 DOMEX-WRITE: an Error-typed parameter holding a DOMException: the message write refuses by name", async () => {
  const src = "function f(e: Error): void { e.message = \"changed\"; }\ntry { atob(\"*\"); } catch (e) { console.log(\"x\"); }\nconst plain = new Error(\"p\");\nf(plain);\nconsole.log(plain.message);\nconst d = new DOMException(\"m\", \"AbortError\");\nconsole.log(\"before\");\nf(d);\nconsole.log(\"after\", d.message);\nexport {};\n";
  const { stdout, stderr } = await runRowTrap("W08", src, "ts");
  expect(stdout).toBe("x\nchanged\nbefore\n");
  expect(stderr).toBe("Uncaught Error: writing a DOMException's message is not supported yet (Node's message is getter-only)\n");
});

test("W09 DOMEX-WRITE: control, board #199: strict writes to an ordinary caught Error keep this tier's answer", async () => {
  const src = "'use strict';\nconst d = new DOMException(\"m\", \"AbortError\");\nconsole.log(d.code);\ntry { throw new TypeError(\"t\"); } catch (e) { e.name = \"R\"; e.message = \"M\"; console.log(e.name, e.message, String(e)); }\nfunction w(x) { x.message = \"Q\"; return x.message; }\ntry { throw new Error(\"p\"); } catch (e) { console.log(w(e)); }\n";
  // This tier's answer (board #199); Node prints "20\nR M R: M\nQ\n".
  const { stdout, stderr, exitCode } = await runRow("W09", src, "cjs");
  expect(stdout).toBe("20\nR M TypeError: t\nQ\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("W10 DOMEX-WRITE: control, board #199: sloppy writes to an ordinary caught Error keep this tier's answer", async () => {
  const src = "const d = new DOMException(\"m\", \"AbortError\");\nconsole.log(d.code);\ntry { throw new TypeError(\"t\"); } catch (e) { e.name = \"R\"; e.message = \"M\"; console.log(e.name, e.message, String(e)); }\nfunction w(x) { x.message = \"Q\"; return x.message; }\ntry { throw new Error(\"p\"); } catch (e) { console.log(w(e)); }\n";
  // This tier's answer (board #199); Node prints "20\nR M R: M\nQ\n".
  const { stdout, stderr, exitCode } = await runRow("W10", src, "cjs");
  expect(stdout).toBe("20\nR M TypeError: t\nQ\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("X01 DOMEX-WRITE: Object.assign of a name onto a caught DOMException refuses by name", async () => {
  const src = "'use strict';\nconst d = new DOMException(\"m\", \"AbortError\");\nlet e = null;\ntry { throw d; } catch (x) { e = x; }\ntry { Object.assign(e, { name: \"X\" }); console.log(\"assigned2\", e.name, e.code); } catch (x) { console.log(\"threw2\", x instanceof TypeError); }\ntry { Object.assign(e, ...[{ message: \"Z\" }]); console.log(\"assignedN\", e.message); } catch (x) { console.log(\"threwN\", x instanceof TypeError); }\nconsole.log(d.name, d.message);\n";
  // A named refusal (board #198); Node prints "threw2 true\nthrewN true\nAbortError m\n" and exits 0.
  const { stdout, stderr } = await runRowTrap("X01", src, "cjs");
  expect(stdout).toBe("");
  expect(stderr).toBe("Uncaught Error: writing a DOMException's name is not supported yet (Node's name is getter-only)\n");
});

test("X02 DOMEX-WRITE: Object.assign of a message from a spread source onto a caught DOMException refuses by name", async () => {
  const src = "'use strict';\nconst d = new DOMException(\"m\", \"AbortError\");\nlet e = null;\ntry { throw d; } catch (x) { e = x; }\nconsole.log(\"before\");\ntry { Object.assign(e, ...[{ message: \"Z\" }]); console.log(\"assignedN\", e.message); } catch (x) { console.log(\"threwN\", x instanceof TypeError); }\n";
  // A named refusal (board #198); Node prints "before\nthrewN true\n" and exits 0.
  const { stdout, stderr } = await runRowTrap("X02", src, "cjs");
  expect(stdout).toBe("before\n");
  expect(stderr).toBe("Uncaught Error: writing a DOMException's message is not supported yet (Node's message is getter-only)\n");
});

test("X03 DOMEX-WRITE: board #198: sloppy Object.assign of a code onto a caught atob DOMException refuses by name", async () => {
  const src = "try { atob(\"*\"); } catch (e) {\n  Object.assign(e, { code: 9 });\n  console.log(\"after\", e.code, e.name);\n}\n";
  // A named refusal (board #198). Node's stdout is the same, and Node exits 1 with "TypeError: Cannot set property code of  which has only a getter".
  const { stdout, stderr } = await runRowTrap("X03", src, "cjs");
  expect(stdout).toBe("");
  expect(stderr).toBe("Uncaught Error: writing a DOMException's code is not supported yet (Node's code is getter-only)\n");
});

test("X04 DOMEX-WRITE: Object.assign of an unrelated key then a code onto a caught DOMException refuses at the code", async () => {
  const src = "'use strict';\nconst d = new DOMException(\"m\", \"AbortError\");\nlet e = null;\ntry { throw d; } catch (x) { e = x; }\nconsole.log(\"before\");\ntry { Object.assign(e, { k: 1, code: 9 }); console.log(\"assigned\", e.code); } catch (x) { console.log(\"threw\", x instanceof TypeError); }\n";
  // A named refusal (board #198); Node prints "before\nthrew true\n" and exits 0.
  const { stdout, stderr } = await runRowTrap("X04", src, "cjs");
  expect(stdout).toBe("before\n");
  expect(stderr).toBe("Uncaught Error: writing a DOMException's code is not supported yet (Node's code is getter-only)\n");
});

test("X05 DOMEX-WRITE: control: an unrelated key assigns onto a caught TypeError and a caught DOMException", async () => {
  const src = "'use strict';\ntry { throw new TypeError(\"t\"); } catch (e) {\n  Object.assign(e, { extra: 1 });\n  console.log(e.extra, e.name, String(e));\n}\nconst d = new DOMException(\"m\", \"AbortError\");\nlet h = null;\ntry { throw d; } catch (x) { h = x; }\nObject.assign(h, { extra: 2 });\nconsole.log(h.extra, h.name);\n";
  const { stdout, stderr, exitCode } = await runRow("X05", src, "cjs");
  expect(stdout).toBe("1 TypeError TypeError: t\n2 AbortError\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("X06 DOMEX-WRITE: control: name and message assign onto a caught ordinary Error, plain and spread", async () => {
  const src = "'use strict';\nlet e = null;\ntry { throw new TypeError(\"t\"); } catch (x) { e = x; }\nObject.assign(e, { name: \"X\" });\nconsole.log(e.name, e.message);\nObject.assign(e, ...[{ message: \"Z\" }]);\nconsole.log(e.name, e.message);\nconst d = new DOMException(\"m\", \"AbortError\");\nconsole.log(d.code);\n";
  const { stdout, stderr, exitCode } = await runRow("X06", src, "cjs");
  expect(stdout).toBe("X t\nX Z\n20\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("X07 DOMEX-WRITE: control: a module that builds a DOMException assigns name, message and code onto a plain object", async () => {
  const src = "'use strict';\nconst d = new DOMException(\"m\", \"AbortError\");\nconst t = JSON.parse('{\"a\":1}');\nObject.assign(t, JSON.parse('{\"name\":\"n\",\"message\":\"m\",\"code\":3}'));\nconsole.log(JSON.stringify(t), d.name, d.code);\n";
  const { stdout, stderr, exitCode } = await runRow("X07", src, "cjs");
  expect(stdout).toBe("{\"a\":1,\"name\":\"n\",\"message\":\"m\",\"code\":3} AbortError 20\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

// ----------------------------------------------------------------------
// DOMEX-INSPECT — util.inspect's bracket form (expected lines: Node's output for the same program with every error's stack cleared, SEMANTICS.md S027)

test("R24 DOMEX-INSPECT: SEMANTICS.md S027: the bracket form per name, empty message, cause, nesting and the options-bag name", async () => {
  const src = "'use strict';\nconst util = require(\"node:util\");\nconst mk = [\n  () => new DOMException(\"m\", \"AbortError\"),\n  () => new DOMException(\"m\", \"NotAllowedError\"),\n  () => new DOMException(\"x\"),\n  () => new DOMException(\"m\", \"MyDOMError\"),\n  () => new DOMException(\"m\", \"abortError\"),\n  () => new DOMException(\"m\", \"Whatever\"),\n  () => new DOMException(\"m\", \"Abort\"),\n  () => new DOMException(\"m\", \"DOMException\"),\n  () => new DOMException(),\n  () => new DOMException(\"\", \"AbortError\"),\n  () => new DOMException(\"m\", { name: \"NotFoundError\", cause: 42 }),\n  () => new DOMException(\"m\", { name: \"NotFoundError\", cause: undefined }),\n  () => new DOMException(\"m\", {}),\n  () => new DOMException(\"m\", { cause: null }),\n];\nfor (const f of mk) console.log(util.inspect(f()));\nconsole.log(util.inspect({ e: new DOMException(\"boom\", \"AbortError\") }));\nconsole.log(util.inspect([new DOMException(\"boom\", \"AbortError\")]));\n";
  // Node's live output adds each error's stack (SEMANTICS.md S027); this is Node's output for the
  // same program with every stack cleared.
  const { stdout, stderr, exitCode } = await runRow("R24", src, "cjs");
  expect(stdout).toBe("[DOMException [AbortError]: m]\n[DOMException [NotAllowedError]: m]\n[DOMException [Error]: x]\n[DOMException [MyDOMError]: m]\n[DOMException [abortError]: m]\n[Whatever: m]\n[Abort: m]\n[DOMException: m]\n[DOMException [Error]]\n[DOMException [AbortError]]\n[DOMException [NotFoundError]: m] { [cause]: 42 }\n[DOMException [NotFoundError]: m] { [cause]: undefined }\n[undefined: m]\n[undefined: m] { [cause]: null }\n{ e: [DOMException [AbortError]: boom] }\n[ [DOMException [AbortError]: boom] ]\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("R25 DOMEX-INSPECT: SEMANTICS.md S027: console.log of a DOMException", async () => {
  const src = "'use strict';\nconsole.log(new DOMException(\"boom\", \"AbortError\"));\n";
  // Node's live output adds each error's stack (SEMANTICS.md S027); this is Node's output for the
  // same program with every stack cleared.
  const { stdout, stderr, exitCode } = await runRow("R25", src, "cjs");
  expect(stdout).toBe("[DOMException [AbortError]: boom]\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("R25b DOMEX-INSPECT: beyond the inspect depth a DOMException with a cause collapses to [DOMException]", async () => {
  const src = "'use strict';\nconst util = require(\"node:util\");\nconsole.log(util.inspect({ a: { b: { c: new DOMException(\"m\", { name: \"AbortError\", cause: 1 }) } } }));\nconsole.log(util.inspect({ a: { b: { c: new DOMException(\"m\", { name: \"Whatever\", cause: 1 }) } } }));\nconsole.log(util.inspect({ a: { b: { c: new DOMException(\"m\", { cause: 1 }) } } }));\ntry { atob(\"*\"); } catch (e) { console.log(util.inspect({ a: { b: { c: [e] } } })); }\n";
  const { stdout, stderr, exitCode } = await runRow("R25b", src, "cjs");
  expect(stdout).toBe("{ a: { b: { c: [DOMException] } } }\n{ a: { b: { c: [DOMException] } } }\n{ a: { b: { c: [DOMException] } } }\n{ a: { b: { c: [Array] } } }\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

// ----------------------------------------------------------------------
// NOT-LIFTED — shapes that keep refusing by name

test("R90n NOT-LIFTED: a Float32Array and a Uint32Array boxed into any keep refusing by name", async () => {
  const src = "// @dynamic\nconst words = new Uint32Array([7, 900000001]);\nconst hw: any = words;\nconsole.log(`${hw.length}`, `${hw[1]}`, `${hw.constructor.name}`);\nconst floats = new Float32Array([1.5, -0.25]);\nconst hf: any = floats;\nconsole.log(`${hf.length}`, `${hf[1]}`, `${hf.constructor.name}`);\n";
  const { diagnostics, survey } = await refuseRow("R90n", src, "ts");
  expect(survey).toEqual(["dynFrom:bytes:f32","dynFrom:bytes:u32"]);
  expect(diagnostics).toEqual(["SC3001: the wasm backend does not support this construct yet (dynFrom:bytes:u32); build with the LLVM backend (the default) or the reference C backend (--backend c)"]);
});

test("R91n NOT-LIFTED: the readers of a boxed Uint32Array and Float32Array keep refusing by name", async () => {
  const src = "// @dynamic\nconst hw: any = new Uint32Array([7, 4294967295, 0]);\nconst hf: any = new Float32Array([1.5, -0.25, 0.1]);\nconsole.log(`${hw.length} ${hw[0]} ${hw[1]} ${hw[5]} ${typeof hw} ${hw.constructor.name}`);\nconsole.log(`${hf.length} ${hf[0]} ${hf[1]} ${hf[2]} ${typeof hf} ${hf.constructor.name}`);\nconsole.log(`${String(hw)} | ${String(hf)}`);\nconsole.log(`${JSON.stringify(hw)} | ${JSON.stringify(hf)}`);\nconsole.log(`${hw === hw} ${hf === hw}`);\n";
  const { diagnostics, survey } = await refuseRow("R91n", src, "ts");
  expect(survey).toEqual(["dynFrom:bytes:f32","dynFrom:bytes:u32"]);
  expect(diagnostics).toEqual(["SC3001: the wasm backend does not support this construct yet (dynFrom:bytes:u32); build with the LLVM backend (the default) or the reference C backend (--backend c)"]);
});

test("R94 NOT-LIFTED: an Int32Array boxed into any keeps refusing by name", async () => {
  const src = "// @dynamic\nconst hi: any = new Int32Array([-1, 2]);\nconsole.log(`${hi.length} ${hi[0]} ${hi.constructor.name}`);\n";
  const { diagnostics, survey } = await refuseRow("R94", src, "ts");
  expect(survey).toEqual(["dynFrom:bytes:i32"]);
  expect(diagnostics).toEqual(["SC3001: the wasm backend does not support this construct yet (dynFrom:bytes:i32); build with the LLVM backend (the default) or the reference C backend (--backend c)"]);
});

test("R95 LIFTED (INC-29 U1): corpus 2596's property-type throw is built — the program compiles, and its output is pinned in the differential's INC-29 U1 block", async () => {
  const { res } = await compileCorpus("R95", "2596-net-arg-ladders.cjs");
  expect(res.ok).toBe(true);
});

// ----------------------------------------------------------------------
// ORDER — board #196: a failing top-level-await module against unrelated rejections, listeners and ticks

test("O01 ORDER: a synchronous module throw beats an earlier unrelated rejection's listener", async () => {
  const src = "process.on(\"unhandledRejection\", (reason) => {\n  console.log(\"listener\", typeof reason);\n});\nconsole.log(\"start\");\nvoid Promise.reject(new Error(\"unrelated\"));\nif (false) await Promise.resolve();\nthrow new Error(\"module failed\");\n\nexport {};\n";
  const { stdout, stderr } = await runRowTrap("O01", src, "ts");
  expect(stdout).toBe("start\n");
  expect(stderr).toBe("Unhandled promise rejection: Error: module failed\n");
});

test("O02 ORDER: a module throw after an await", async () => {
  const src = "process.on(\"unhandledRejection\", (reason) => {\n  console.log(\"listener\", typeof reason);\n});\nconsole.log(\"start\");\nvoid Promise.reject(new Error(\"unrelated\"));\nawait Promise.resolve();\nconsole.log(\"after await\");\nthrow new Error(\"module failed\");\n\nexport {};\n";
  const { stdout, stderr } = await runRowTrap("O02", src, "ts");
  expect(stdout).toBe("start\nafter await\n");
  expect(stderr).toBe("Unhandled promise rejection: Error: module failed\n");
});

test("O03 ORDER: the unrelated rejection created after the await", async () => {
  const src = "process.on(\"unhandledRejection\", (reason) => {\n  console.log(\"listener\", typeof reason);\n});\nconsole.log(\"start\");\nawait Promise.resolve();\nvoid Promise.reject(new Error(\"unrelated\"));\nthrow new Error(\"module failed\");\n\nexport {};\n";
  const { stdout, stderr } = await runRowTrap("O03", src, "ts");
  expect(stdout).toBe("start\n");
  expect(stderr).toBe("Unhandled promise rejection: Error: module failed\n");
});

test("O04 ORDER: control: a module failing on a later tick lets the listener run first", async () => {
  const src = "process.on(\"unhandledRejection\", (reason) => {\n  console.log(\"listener\", typeof reason);\n});\nconsole.log(\"start\");\nvoid Promise.reject(new Error(\"unrelated\"));\nawait new Promise<void>((_r, reject) => { setTimeout(() => reject(new Error(\"module failed\")), 5); });\n\nexport {};\n";
  const { stdout, stderr } = await runRowTrap("O04", src, "ts");
  expect(stdout).toBe("start\nlistener object\n");
  expect(stderr).toBe("Unhandled promise rejection: Error: module failed\n");
});

test("O05 ORDER: no listener: the report names the module's error, not the unrelated one", async () => {
  const src = "console.log(\"start\");\nvoid Promise.reject(new Error(\"unrelated\"));\nif (false) await Promise.resolve();\nthrow new Error(\"module failed\");\n\nexport {};\n";
  const { stdout, stderr } = await runRowTrap("O05", src, "ts");
  expect(stdout).toBe("start\n");
  expect(stderr).toBe("Unhandled promise rejection: Error: module failed\n");
});

test("O07 ORDER: a rejectionHandled listener beside it", async () => {
  const src = "process.on(\"unhandledRejection\", (reason) => {\n  console.log(\"listener\", typeof reason);\n});\nprocess.on(\"rejectionHandled\", () => {\n  console.log(\"handled\");\n});\nconsole.log(\"start\");\nconst p = Promise.reject(new Error(\"unrelated\"));\nsetTimeout(() => { p.catch(() => {}); }, 1);\nif (false) await Promise.resolve();\nthrow new Error(\"module failed\");\n\nexport {};\n";
  const { stdout, stderr } = await runRowTrap("O07", src, "ts");
  expect(stdout).toBe("start\n");
  expect(stderr).toBe("Unhandled promise rejection: Error: module failed\n");
});

test("O08 ORDER: an .mjs entry", async () => {
  const src = "process.on(\"unhandledRejection\", (reason) => {\n  console.log(\"listener\", typeof reason);\n});\nconsole.log(\"start\");\nvoid Promise.reject(new Error(\"unrelated\"));\nif (false) await Promise.resolve();\nthrow new Error(\"module failed\");\n";
  const { stdout, stderr } = await runRowTrap("O08", src, "mjs");
  expect(stdout).toBe("start\n");
  expect(stderr).toBe("Unhandled promise rejection: Error: module failed\n");
});

test("O09 ORDER: control: a module without top-level await throwing synchronously", async () => {
  const src = "process.on(\"unhandledRejection\", (reason) => {\n  console.log(\"listener\", typeof reason);\n});\nconsole.log(\"start\");\nvoid Promise.reject(new Error(\"unrelated\"));\nthrow new Error(\"module failed\");\n\nexport {};\n";
  const { stdout, stderr } = await runRowTrap("O09", src, "ts");
  expect(stdout).toBe("start\n");
  expect(stderr).toBe("Uncaught Error: module failed\n");
});

test("O10 ORDER: control: a module with top-level await that does not fail still runs the listener", async () => {
  const src = "process.on(\"unhandledRejection\", (reason) => {\n  console.log(\"listener\", typeof reason);\n});\nconsole.log(\"start\");\nvoid Promise.reject(new Error(\"unrelated\"));\nif (false) await Promise.resolve();\nconsole.log(\"end\");\n\nexport {};\n";
  const { stdout, stderr, exitCode } = await runRow("O10", src, "ts");
  expect(stdout).toBe("start\nend\nlistener object\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("O11 ORDER: a statically imported dependency with top-level await fails", async () => {
  const files = {"main.ts":"import \"./listener.ts\";\nimport \"./bad.ts\";\nconsole.log(\"main body\");\n","listener.ts":"process.on(\"unhandledRejection\", (reason) => {\n  console.log(\"listener\", typeof reason);\n});\nvoid Promise.reject(new Error(\"unrelated\"));\nconsole.log(\"listener armed\");\n","bad.ts":"console.log(\"bad\");\nif (false) await Promise.resolve();\nthrow new Error(\"dependency failed\");\n\nexport {};\n"};
  const { stdout, stderr } = await runRowDirTrap("O11", files);
  expect(stdout).toBe("listener armed\nbad\n");
  expect(stderr).toBe("Unhandled promise rejection: Error: dependency failed\n");
});

test("O12 ORDER: the module fails by awaiting a rejected promise", async () => {
  const src = "process.on(\"unhandledRejection\", (reason) => {\n  console.log(\"listener\", typeof reason);\n});\nconsole.log(\"start\");\nvoid Promise.reject(new Error(\"unrelated\"));\nawait Promise.reject(new Error(\"module failed\"));\n\nexport {};\n";
  const { stdout, stderr } = await runRowTrap("O12", src, "ts");
  expect(stdout).toBe("start\n");
  expect(stderr).toBe("Unhandled promise rejection: Error: module failed\n");
});

test("O13 ORDER: two unrelated rejections", async () => {
  const src = "process.on(\"unhandledRejection\", (reason) => {\n  console.log(\"listener\", typeof reason);\n});\nconsole.log(\"start\");\nvoid Promise.reject(new Error(\"u1\"));\nvoid Promise.reject(new Error(\"u2\"));\nif (false) await Promise.resolve();\nthrow new Error(\"module failed\");\n\nexport {};\n";
  const { stdout, stderr } = await runRowTrap("O13", src, "ts");
  expect(stdout).toBe("start\n");
  expect(stderr).toBe("Unhandled promise rejection: Error: module failed\n");
});

test("O14 ORDER: a nextTick queued before the failure does not run", async () => {
  const src = "process.on(\"unhandledRejection\", (reason) => {\n  console.log(\"listener\", typeof reason);\n});\nprocess.nextTick(() => console.log(\"tick\"));\nconsole.log(\"start\");\nvoid Promise.reject(new Error(\"unrelated\"));\nif (false) await Promise.resolve();\nthrow new Error(\"module failed\");\n\nexport {};\n";
  const { stdout, stderr } = await runRowTrap("O14", src, "ts");
  expect(stdout).toBe("start\n");
  expect(stderr).toBe("Unhandled promise rejection: Error: module failed\n");
});

test("O15 ORDER: a nextTick and no listener", async () => {
  const src = "process.nextTick(() => console.log(\"tick\"));\nconsole.log(\"start\");\nvoid Promise.reject(new Error(\"unrelated\"));\nif (false) await Promise.resolve();\nthrow new Error(\"module failed\");\n\nexport {};\n";
  const { stdout, stderr } = await runRowTrap("O15", src, "ts");
  expect(stdout).toBe("start\n");
  expect(stderr).toBe("Unhandled promise rejection: Error: module failed\n");
});

test("O16 ORDER: a microtask queued before the failure runs, the ticks do not", async () => {
  const src = "process.on(\"unhandledRejection\", (reason) => {\n  console.log(\"listener\", typeof reason);\n});\nprocess.nextTick(() => console.log(\"tick\"));\nconsole.log(\"start\");\nvoid Promise.reject(new Error(\"unrelated\"));\nawait Promise.resolve();\nqueueMicrotask(() => console.log(\"late micro\"));\nprocess.nextTick(() => console.log(\"late tick\"));\nthrow new Error(\"module failed\");\n\nexport {};\n";
  const { stdout, stderr } = await runRowTrap("O16", src, "ts");
  expect(stdout).toBe("start\nlate micro\n");
  expect(stderr).toBe("Unhandled promise rejection: Error: module failed\n");
});

test("Q18 ORDER: a failure in a later checkpoint with a tick and a listener", async () => {
  const src = "process.on(\"unhandledRejection\", (r) => { console.log(\"listener\", typeof r); });\nconsole.log(\"start\");\nawait new Promise<void>((res) => { setTimeout(res, 0); });\nconsole.log(\"after timer\");\nprocess.nextTick(() => { console.log(\"tick\"); });\nvoid Promise.reject(new Error(\"unrelated\"));\nthrow new Error(\"module failed\");\nexport {};\n";
  const { stdout, stderr } = await runRowTrap("Q18", src, "ts");
  expect(stdout).toBe("start\nafter timer\n");
  expect(stderr).toBe("Unhandled promise rejection: Error: module failed\n");
});

test("Q19 ORDER: a failure in a later checkpoint with a listener and no tick", async () => {
  const src = "process.on(\"unhandledRejection\", (r) => { console.log(\"listener\", typeof r); });\nconsole.log(\"start\");\nawait new Promise<void>((res) => { setTimeout(res, 0); });\nconsole.log(\"after timer\");\nvoid Promise.reject(new Error(\"unrelated\"));\nthrow new Error(\"module failed\");\nexport {};\n";
  const { stdout, stderr } = await runRowTrap("Q19", src, "ts");
  expect(stdout).toBe("start\nafter timer\n");
  expect(stderr).toBe("Unhandled promise rejection: Error: module failed\n");
});

test("Q20 ORDER: a failure in a later checkpoint with a tick and no listener", async () => {
  const src = "console.log(\"start\");\nawait new Promise<void>((res) => { setTimeout(res, 0); });\nconsole.log(\"after timer\");\nprocess.nextTick(() => { console.log(\"tick\"); });\nvoid Promise.reject(new Error(\"unrelated\"));\nthrow new Error(\"module failed\");\nexport {};\n";
  const { stdout, stderr } = await runRowTrap("Q20", src, "ts");
  expect(stdout).toBe("start\nafter timer\n");
  expect(stderr).toBe("Unhandled promise rejection: Error: module failed\n");
});

// ----------------------------------------------------------------------
// CLONE — structuredClone per value kind: deep, with sharing and cycles kept, and Node's option checks

test("R30 CLONE: a value tree of every JSON kind clones deep (everything printed)", async () => {
  const src = "'use strict';\nconst c = (x) => structuredClone(x);\nconst src = JSON.parse('{\"n\":-0.5,\"s\":\"\\\\u00e9\\\\ud83d\\\\ude00\",\"b\":false,\"z\":null,\"a\":[[],{},[1,[2,[3]]]],\"o\":{\"\":1,\"k\":{\"deep\":true}}}');\nconst out = c(src);\nconsole.log(JSON.stringify(out));\nconsole.log(out.a[2][1][1][0], out.o[\"\"], out.s.length);\n";
  const { stdout, stderr, exitCode } = await runRow("R30", src, "cjs");
  expect(stdout).toBe("{\"n\":-0.5,\"s\":\"é😀\",\"b\":false,\"z\":null,\"a\":[[],{},[1,[2,[3]]]],\"o\":{\"\":1,\"k\":{\"deep\":true}}}\n3 1 3\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("R31 CLONE: primitives clone as themselves, -0 and NaN included", async () => {
  const src = "'use strict';\nconst c = (x) => structuredClone(x);\nconsole.log(c(1), c(-0), 1 / c(-0), c(NaN), c(\"s\"), c(true), c(null), c(undefined), c(\"\"));\n";
  const { stdout, stderr, exitCode } = await runRow("R31", src, "cjs");
  expect(stdout).toBe("1 -0 -Infinity NaN s true null undefined \n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("R32 CLONE: a parsed tree clones deep and apart from its source", async () => {
  const src = "'use strict';\nconst c = (x) => structuredClone(x);\nconst src = JSON.parse('{\"a\":[1,\"x\",null,{\"b\":true}],\"n\":{\"m\":{\"k\":[[]]}}}');\nconst out = c(src);\nconsole.log(JSON.stringify(out), out !== src, out.a !== src.a, out.n.m !== src.n.m);\nout.a.push(9); console.log(src.a.length, out.a.length);\nconsole.log(Object.keys(out).join(\",\"));\n";
  const { stdout, stderr, exitCode } = await runRow("R32", src, "cjs");
  expect(stdout).toBe("{\"a\":[1,\"x\",null,{\"b\":true}],\"n\":{\"m\":{\"k\":[[]]}}} true true true\n4 5\na,n\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("R33 CLONE: a child shared by two parents stays shared in the clone", async () => {
  const src = "'use strict';\nconst src = JSON.parse('{\"p\":{\"v\":1},\"arr\":[]}');\nsrc.q = src.p;\nsrc.arr.push(src.p);\nsrc.arr.push(src.p);\nconst out = structuredClone(src);\nout.p.v = 2;\nconsole.log(out.q.v, out.arr[0].v, out.arr[1].v, src.p.v);\n";
  const { stdout, stderr, exitCode } = await runRow("R33", src, "cjs");
  expect(stdout).toBe("2 2 2 1\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("R34 CLONE: object and array cycles clone as cycles", async () => {
  const src = "'use strict';\nconst a = JSON.parse('{\"name\":\"a\"}');\na.self = a;\nconst out = structuredClone(a);\nout.name = \"z\";\nconsole.log(out.self.name, out.self.self.name, a.name);\nconst arr = JSON.parse(\"[1]\");\narr.push(arr);\nconst o2 = structuredClone(arr);\no2[0] = 5;\nconsole.log(o2[1][0], o2[1][1][0], o2.length, arr[0]);\n";
  const { stdout, stderr, exitCode } = await runRow("R34", src, "cjs");
  expect(stdout).toBe("z z a\n5 5 2 1\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("R34b CLONE: a shared child and a self-cycle in one clone", async () => {
  const src = "'use strict';\nconst a = JSON.parse('{\"x\":{\"k\":1}}');\na.y = a.x;\na.self = a;\nconst c = structuredClone(a);\nc.x.k = 7;\nc.self.tag = \"t\";\nconsole.log(c.y.k, c.tag, a.x.k, String(a.tag));\n";
  const { stdout, stderr, exitCode } = await runRow("R34b", src, "cjs");
  expect(stdout).toBe("7 t 1 undefined\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("R35 CLONE: the clone's keys keep the source's order", async () => {
  const src = "'use strict';\nconst src = { b: 1, a: 2, 2: \"two\", 1: \"one\" };\nconsole.log(Object.keys(structuredClone(src)).join(\",\"));\n";
  const { stdout, stderr, exitCode } = await runRow("R35", src, "cjs");
  expect(stdout).toBe("1,2,b,a\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("R36 CLONE: errors clone as fresh instances of their class", async () => {
  const src = "'use strict';\nconst c = (x) => structuredClone(x);\nconst e = c(new TypeError(\"t\"));\nconsole.log(e instanceof TypeError, e instanceof Error, e.name, e.message, String(e));\nconst r = c(new RangeError(\"r\"));\nconsole.log(r.name, r instanceof RangeError);\nconst plain = c(new Error(\"p\"));\nconsole.log(plain.name, plain.message, plain instanceof Error);\n";
  const { stdout, stderr, exitCode } = await runRow("R36", src, "cjs");
  expect(stdout).toBe("true true TypeError t TypeError: t\nRangeError true\nError p true\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("R37 CLONE: a DOMException through a dynamic value clones without its cause", async () => {
  const src = "'use strict';\nconst c = (x) => structuredClone(x);\nconst d = c(new DOMException(\"m\", { name: \"AbortError\", cause: 1 }));\nconsole.log(d instanceof DOMException, d.name, d.code, d.message, \"cause\" in d);\ntry { atob(\"*\"); } catch (e) { const k = c(e); console.log(k instanceof DOMException, k.name, k.code, k.message); }\n";
  const { stdout, stderr, exitCode } = await runRow("R37", src, "cjs");
  expect(stdout).toBe("true AbortError 20 m false\ntrue InvalidCharacterError 5 Invalid character\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("R38 CLONE: the options argument's checks and their errors", async () => {
  const src = "'use strict';\nconst c = (v, o) => structuredClone(v, o);\nconst cases = [undefined, null, {}, { transfer: [] }, { transfer: undefined }, \"\", 1, true, { transfer: 1 }, { transfer: null }, { transfer: \"ab\" }, { transfer: [1] }, { transfer: [{}] }];\nfor (const o of cases) {\n  try { const r = c({ k: 1 }, o); console.log(\"ok\", JSON.stringify(r)); }\n  catch (e) { console.log(e.name, e.code, e.message); }\n}\n";
  const { stdout, stderr, exitCode } = await runRow("R38", src, "cjs");
  expect(stdout).toBe("ok {\"k\":1}\nok {\"k\":1}\nok {\"k\":1}\nok {\"k\":1}\nok {\"k\":1}\nTypeError ERR_INVALID_ARG_TYPE Failed to execute 'structuredClone': Options cannot be converted to a dictionary\nTypeError ERR_INVALID_ARG_TYPE Failed to execute 'structuredClone': Options cannot be converted to a dictionary\nTypeError ERR_INVALID_ARG_TYPE Failed to execute 'structuredClone': Options cannot be converted to a dictionary\nTypeError ERR_INVALID_ARG_TYPE Failed to execute 'structuredClone': transfer in Options cannot be converted to sequence.\nTypeError ERR_INVALID_ARG_TYPE Failed to execute 'structuredClone': transfer in Options cannot be converted to sequence.\nTypeError ERR_INVALID_ARG_TYPE Failed to execute 'structuredClone': transfer in Options cannot be converted to sequence.\nTypeError ERR_INVALID_ARG_TYPE Failed to execute 'structuredClone': transfer in Options[0] is not an object.\nDataCloneError 25 Found invalid value in transferList.\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("R39 CLONE: structuredClone() with no argument", async () => {
  const src = "'use strict';\ntry { structuredClone(); } catch (e) { console.log(e.name, e.code, e.message); }\n";
  const { stdout, stderr, exitCode } = await runRow("R39", src, "cjs");
  expect(stdout).toBe("TypeError ERR_MISSING_ARGS The \"The value argument must be specified\" argument must be specified\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("R40 CLONE: a transfer list naming the value itself", async () => {
  const src = "'use strict';\nconst o = { a: 1 };\ntry { structuredClone(o, { transfer: [o] }); } catch (e) { console.log(e.name, e.code, e.message); }\nconst arr = [1];\ntry { structuredClone(arr, { transfer: [arr] }); } catch (e) { console.log(e.name, e.code, e.message); }\n";
  const { stdout, stderr, exitCode } = await runRow("R40", src, "cjs");
  expect(stdout).toBe("DataCloneError 25 Found invalid value in transferList.\nDataCloneError 25 Found invalid value in transferList.\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("R41 CLONE: a null-prototype object clones as an ordinary object", async () => {
  const src = "'use strict';\nconst o = Object.create(null);\no.a = 1;\nconst out = structuredClone(o);\nconsole.log(out.a, JSON.stringify(out), out);\n";
  const { stdout, stderr, exitCode } = await runRow("R41", src, "cjs");
  expect(stdout).toBe("1 {\"a\":1} { a: 1 }\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("R42 CLONE: a Uint8Array clones as a fresh copy and a Buffer as a plain Uint8Array", async () => {
  const src = "'use strict';\nconst c = (x) => structuredClone(x);\nconst u = new Uint8Array([1, 2, 3]);\nconst out = c(u);\nconsole.log(out instanceof Uint8Array, String(out), out.length);\nu[0] = 9;\nconsole.log(out[0], u[0]);\nconst ob = c(Buffer.from(\"hi\"));\nconsole.log(ob instanceof Uint8Array, String(ob));\n";
  const { stdout, stderr, exitCode } = await runRow("R42", src, "cjs");
  expect(stdout).toBe("true 1,2,3 3\n1 9\ntrue 104,105\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("R42b CLONE: a Buffer held in a dynamic value clones to a plain Uint8Array", async () => {
  const src = "'use strict';\nconst util = require(\"node:util\");\nconst { Writable } = require(\"node:stream\");\nfunction wrap(f) { return f; }\nconst w = new Writable({\n  write: wrap(function (chunk, enc, cb) {\n    console.log(util.inspect(chunk), util.inspect(structuredClone(chunk)));\n    cb();\n  }),\n});\nw.write(\"hi\");\nw.end();\n";
  const { stdout, stderr, exitCode } = await runRow("R42b", src, "cjs");
  expect(stdout).toBe("<Buffer 68 69> Uint8Array(2) [ 104, 105 ]\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("R42c CLONE: SEMANTICS.md S037, board #206: the clone of a Buffer-typed value renders as a Buffer", async () => {
  const src = "'use strict';\nconst util = require(\"node:util\");\nconst { Writable } = require(\"node:stream\");\nconst w = new Writable({\n  write(chunk, enc, cb) {\n    console.log(util.inspect(structuredClone(chunk)));\n    cb();\n  },\n});\nw.write(\"hi\");\nw.end();\n";
  // This tier's answer (SEMANTICS.md S037, board #206: the clone is typed as its Buffer-typed argument); Node prints "Uint8Array(2) [ 104, 105 ]\n".
  const { stdout, stderr, exitCode } = await runRow("R42c", src, "cjs");
  expect(stdout).toBe("<Buffer 68 69>\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("R49 CLONE: a record-typed argument takes the same clone", async () => {
  const src = "const src = { a: [1, 2], b: \"x\" };\nconst c = structuredClone(src);\nc.a.push(3);\nconsole.log(JSON.stringify(src), JSON.stringify(c));\n";
  const { stdout, stderr, exitCode } = await runRow("R49", src, "ts");
  expect(stdout).toBe("{\"a\":[1,2],\"b\":\"x\"} {\"a\":[1,2,3],\"b\":\"x\"}\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("R22 CLONE: a typed DOMException clones with its name and message, and the options are checked", async () => {
  const src = "'use strict';\nconst e = new DOMException(\"t\", { name: \"DataCloneError\", cause: 3 });\nconst c = structuredClone(e);\nconsole.log(c.name, c.code, c.message, \"cause\" in c, c.cause, c === e, c instanceof DOMException);\nconst d = structuredClone(new DOMException(\"u\", \"Whatever\"));\nconsole.log(d.name, d.code, d.message);\ntry { structuredClone(e, { transfer: [e] }); } catch (x) { console.log(x.name, x.code, x.message); }\ntry { structuredClone(e, { transfer: 1 }); } catch (x) { console.log(x.name, x.code, x.message); }\ntry { structuredClone(e, \"\"); } catch (x) { console.log(x.name, x.code, x.message); }\n";
  const { stdout, stderr, exitCode } = await runRow("R22", src, "cjs");
  expect(stdout).toBe("DataCloneError 25 t false undefined false true\nWhatever 0 u\nDataCloneError 25 Found invalid value in transferList.\nTypeError ERR_INVALID_ARG_TYPE Failed to execute 'structuredClone': transfer in Options cannot be converted to sequence.\nTypeError ERR_INVALID_ARG_TYPE Failed to execute 'structuredClone': Options cannot be converted to a dictionary\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

// ----------------------------------------------------------------------
// UNCLONE — values that do not clone: Node's DataCloneError, a named refusal, or an existing fence

test("R43 UNCLONE: a function is a named refusal", async () => {
  const src = "'use strict';\nconst c = (x) => structuredClone(x);\ntry { c(() => 1); console.log(\"cloned\"); } catch (e) { console.log(e.name, e.code, e.message); }\n";
  // This tier's answer (a named refusal: Node's DataCloneError message embeds the function's source text); Node prints "DataCloneError 25 () => 1 could not be cloned.\n".
  const { stdout, stderr, exitCode } = await runRow("R43", src, "cjs");
  expect(stdout).toBe("Error undefined structuredClone of a function value is not supported yet\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("R44 UNCLONE: a promise throws DataCloneError", async () => {
  const src = "'use strict';\nconst c = (x) => structuredClone(x);\ntry { c(Promise.resolve(1)); console.log(\"cloned\"); } catch (e) { console.log(e.name, e.code, e.message); }\n";
  const { stdout, stderr, exitCode } = await runRow("R44", src, "cjs");
  expect(stdout).toBe("DataCloneError 25 #<Promise> could not be cloned.\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("R45 UNCLONE: a typed promise, alone and nested, throws DataCloneError", async () => {
  const src = "'use strict';\nconst p = Promise.resolve(1);\nconst c = (x) => structuredClone(x);\ntry { c(p); } catch (e) { console.log(e.name, e.code, e.message); }\ntry { c({ p }); } catch (e) { console.log(e.name, e.code, e.message); }\n";
  const { stdout, stderr, exitCode } = await runRow("R45", src, "cjs");
  expect(stdout).toBe("DataCloneError 25 #<Promise> could not be cloned.\nDataCloneError 25 #<Promise> could not be cloned.\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("R46 UNCLONE: a symbol stops at its crossing into a dynamic value", async () => {
  const src = "'use strict';\nconst c = (x) => structuredClone(x);\ntry { c(Symbol(\"s\")); } catch (e) { console.log(e.name, e.message); }\n";
  // This tier's answer (the existing SC1101 crossing fence); Node prints "DataCloneError Symbol(s) could not be cloned.\n".
  const { stdout, stderr, exitCode } = await runRow("R46", src, "cjs");
  expect(stdout).toBe("Error converting typed values to 'unknown' is not supported yet [SC1101 at <ROW>:3]\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("R47 UNCLONE: Date, RegExp, Map and Set stop at their existing fences", async () => {
  const src = "'use strict';\nconst c = (x) => structuredClone(x);\nconst d = c(new Date(0)); console.log(d instanceof Date, d.getTime());\nconst r = c(/a+/g); console.log(r.source, r.flags);\nconst m = c(new Map([[1, 2]])); console.log(m.get(1));\nconst s = c(new Set([3])); console.log(s.has(3));\n";
  // This tier's answer (the existing SC2020 fence); Node prints "true 0\na+ g\n2\ntrue\n" and exits 0.
  const { stdout, stderr } = await runRowTrap("R47", src, "cjs");
  expect(stdout).toBe("");
  expect(stderr).toBe("Uncaught Error: 'new Date' is part of the standard library types but has no scriptc lowering yet [SC2020 at <ROW>:3]\n");
});

test("R48 UNCLONE: a class instance stops at its crossing", async () => {
  const src = "'use strict';\nclass P { constructor() { this.x = 1; } }\nconst c = (x) => structuredClone(x);\nconst o = c(new P());\nconsole.log(o instanceof P, o.x, JSON.stringify(o));\n";
  // This tier's answer (the existing SC1101 crossing fence); Node prints "false 1 {\"x\":1}\n" and exits 0.
  const { stdout, stderr } = await runRowTrap("R48", src, "cjs");
  expect(stdout).toBe("");
  expect(stderr).toBe("Uncaught Error: converting typed values to 'unknown' is not supported yet [SC1101 at <ROW>:4]\n");
});

// ----------------------------------------------------------------------
// SPREAD — a call's spread arguments, and V8's TypeError texts by position

test("R50 SPREAD: array spreads in every argument position (everything printed)", async () => {
  const src = "'use strict';\nfunction f(...a) { return a.length + \":\" + a.join(\"|\"); }\nconst fw = (...args) => f(...args);\nconst g = (x, ...rest) => f(x, ...rest);\nconst xs = [1, 2];\nconsole.log(fw(...xs));\nconsole.log(fw(0, ...xs));\nconsole.log(fw(...xs, 3));\nconsole.log(fw(...xs, ...xs));\nconsole.log(fw(...[]));\nconsole.log(g(9, ...xs));\nconsole.log(fw(...[[1, 2], [3]]));\n";
  const { stdout, stderr, exitCode } = await runRow("R50", src, "cjs");
  expect(stdout).toBe("2:1|2\n3:0|1|2\n3:1|2|3\n4:1|2|1|2\n0:\n3:9|1|2\n2:1,2|3\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("R51 SPREAD: strings spread by code point", async () => {
  const src = "'use strict';\nfunction f(...a) { return a.length + \":\" + a.join(\"|\"); }\nconst fw = (...args) => f(...args);\nconsole.log(fw(...\"abc\"));\nconsole.log(fw(...\"a\\u{1F600}b\"));\nconsole.log(fw(...\"\\uD83D\"));\nconsole.log(fw(...\"x\\uDE00y\"));\nconsole.log(fw(...\"\"));\n";
  const { stdout, stderr, exitCode } = await runRow("R51", src, "cjs");
  expect(stdout).toBe("3:a|b|c\n3:a|😀|b\n1:�\n3:x|�|y\n0:\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("R52 SPREAD: missing array slots spread as undefined", async () => {
  const src = "'use strict';\nfunction f(...a) { return a.length + \":\" + a.map((x) => String(x)).join(\"|\"); }\nconst fw = (...args) => f(...args);\nconst h = JSON.parse(\"[]\");\nh[2] = \"z\";\nconsole.log(fw(...h));\nconsole.log(fw(...JSON.parse(\"[1,null,3]\")));\n";
  const { stdout, stderr, exitCode } = await runRow("R52", src, "cjs");
  expect(stdout).toBe("3:undefined|undefined|z\n3:1|null|3\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("R53 SPREAD: a spread feeds more or fewer arguments than declared", async () => {
  const src = "'use strict';\nfunction two(a, b) { return String(a) + \",\" + String(b); }\nconst fw = (...args) => two(...args);\nconsole.log(fw(), fw(1), fw(1, 2), fw(1, 2, 3));\nconsole.log(fw.length, two.length);\n";
  const { stdout, stderr, exitCode } = await runRow("R53", src, "cjs");
  expect(stdout).toBe("undefined,undefined 1,undefined 1,2 1,2\n0 2\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("R54 SPREAD: evaluation order around a spread, and a throwing spread", async () => {
  const src = "'use strict';\nconst log = [];\nconst t = (k, v) => { log.push(k); return v; };\nfunction f(...a) { log.push(\"call\"); return a.length; }\nconst fw = (...args) => t(\"callee\", f)(t(\"x\", 1), ...t(\"s\", args), t(\"y\", 2));\nconsole.log(fw(7, 8), log.join(\",\"));\nconst bad = (v) => { const g = (...args) => f(...args); try { return g(t(\"a\", 1), ...v, t(\"b\", 2)); } catch (e) { return e.message; } };\nconsole.log(bad(null), log.join(\",\"));\n";
  const { stdout, stderr, exitCode } = await runRow("R54", src, "cjs");
  expect(stdout).toBe("4 callee,x,s,y,call\nobject null is not iterable (cannot read property Symbol(Symbol.iterator)) callee,x,s,y,call,a\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("R55 SPREAD: spreading values that are not iterable", async () => {
  const src = "'use strict';\nfunction f(...a) { return a.length; }\nfunction probe(v) { const g = (...args) => f(...args); try { return g(...v); } catch (e) { return e.message; } }\nfor (const v of [true, 0, -1.5, { length: 2, 0: \"a\" }, () => 1, \"\", \"xy\"]) console.log(probe(v));\n";
  const { stdout, stderr, exitCode } = await runRow("R55", src, "cjs");
  expect(stdout).toBe("Spread syntax requires ...iterable[Symbol.iterator] to be a function\nSpread syntax requires ...iterable[Symbol.iterator] to be a function\nSpread syntax requires ...iterable[Symbol.iterator] to be a function\nSpread syntax requires ...iterable[Symbol.iterator] to be a function\nSpread syntax requires ...iterable[Symbol.iterator] to be a function\n0\n2\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("R56 SPREAD: a rest array forwarded by spread", async () => {
  const src = "'use strict';\nfunction f(...a) { return a.length + \":\" + a.join(\"|\"); }\nfunction viaArgs() { return f(...arguments); }\nconsole.log(viaArgs(1, 2, 3));\n";
  const { stdout, stderr, exitCode } = await runRow("R56", src, "cjs");
  expect(stdout).toBe("3:1|2|3\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("R57 SPREAD: a Uint8Array spreads by element", async () => {
  const src = "'use strict';\nfunction f(...a) { return a.length + \":\" + a.join(\"|\"); }\nfunction probe(v) { const g = (...args) => f(...args); return g(...v); }\nconsole.log(probe(new Uint8Array([5, 6])));\nconsole.log(probe(Buffer.from(\"hi\")));\n";
  const { stdout, stderr, exitCode } = await runRow("R57", src, "cjs");
  expect(stdout).toBe("2:5|6\n2:104|105\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("R58 SPREAD: nested spreads through forwarding functions", async () => {
  const src = "'use strict';\nconst first = (x) => x;\nconst fw = (...args) => first(...args);\nconsole.log(fw(...[[\"nested\"], \"tail\"]));\nconsole.log(fw(...[{ k: 1 }]));\nconst chain = (...a) => fw(...a);\nconsole.log(chain(7, 8));\n";
  const { stdout, stderr, exitCode } = await runRow("R58", src, "cjs");
  expect(stdout).toBe("[ 'nested' ]\n{ k: 1 }\n7\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("R59 SPREAD: the TypeError text by the spread's position", async () => {
  const src = "'use strict';\nfunction f(...a) { return a.length; }\nfunction p1(v) { const g = (...args) => f(...args); try { return g(...v); } catch (e) { return e.message; } }\nfunction p2(v) { const g = (...args) => f(...args); try { return g(1, ...v); } catch (e) { return e.message; } }\nfunction p3(v) { const g = (...args) => f(...args); try { return g(...v, 1); } catch (e) { return e.message; } }\nfor (const v of [null, undefined, 5, {}, false]) console.log(p1(v), \"|\", p2(v), \"|\", p3(v));\n";
  const { stdout, stderr, exitCode } = await runRow("R59", src, "cjs");
  expect(stdout).toBe("v is not iterable (cannot read property null) | v is not iterable (cannot read property null) | object null is not iterable (cannot read property Symbol(Symbol.iterator))\nv is not iterable (cannot read property undefined) | v is not iterable (cannot read property undefined) | undefined is not iterable (cannot read property Symbol(Symbol.iterator))\nSpread syntax requires ...iterable[Symbol.iterator] to be a function | Spread syntax requires ...iterable[Symbol.iterator] to be a function | number 5 is not iterable (cannot read property Symbol(Symbol.iterator))\nSpread syntax requires ...iterable[Symbol.iterator] to be a function | Spread syntax requires ...iterable[Symbol.iterator] to be a function | object is not iterable (cannot read property Symbol(Symbol.iterator))\nSpread syntax requires ...iterable[Symbol.iterator] to be a function | Spread syntax requires ...iterable[Symbol.iterator] to be a function | boolean false is not iterable (cannot read property Symbol(Symbol.iterator))\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("R60 SPREAD: several spreads in one call", async () => {
  const src = "'use strict';\nfunction f(...a) { return a.length; }\nfunction two(v, w) { const g = (...args) => f(...args); try { return g(...v, ...w); } catch (e) { return e.message; } }\nconsole.log(two([1], null));\nconsole.log(two(null, [1]));\nconsole.log(two([1], 5));\nconsole.log(two([1, 2], \"ab\"));\n";
  const { stdout, stderr, exitCode } = await runRow("R60", src, "cjs");
  expect(stdout).toBe("object null is not iterable (cannot read property Symbol(Symbol.iterator))\nobject null is not iterable (cannot read property Symbol(Symbol.iterator))\nnumber 5 is not iterable (cannot read property Symbol(Symbol.iterator))\n4\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("R61 SPREAD: a promise and other values in a spread", async () => {
  const src = "'use strict';\nfunction f(...a) { return a.length; }\nfunction probe(v) { const g = (...args) => f(...args); try { return g(...v); } catch (e) { return e.message; } }\nconsole.log(probe(Promise.resolve(1)));\nconsole.log(probe(new Error(\"x\")));\nconsole.log(probe(JSON.parse('{\"length\":1,\"0\":\"z\"}')));\n";
  const { stdout, stderr, exitCode } = await runRow("R61", src, "cjs");
  expect(stdout).toBe("Spread syntax requires ...iterable[Symbol.iterator] to be a function\nSpread syntax requires ...iterable[Symbol.iterator] to be a function\nSpread syntax requires ...iterable[Symbol.iterator] to be a function\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("R62 SPREAD: the spread is flattened before the callee is tested", async () => {
  const src = "'use strict';\nfunction p(fn, a) { try { return fn(...a); } catch (e) { return e.message; } }\nconsole.log(p(5, [1]));\nconsole.log(p(5, null));\nconsole.log(p(undefined, [1]));\nconsole.log(p((x, y) => x + y, [2, 3]));\n";
  const { stdout, stderr, exitCode } = await runRow("R62", src, "cjs");
  expect(stdout).toBe("fn is not a function\na is not iterable (cannot read property null)\nfn is not a function\n5\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("R63 SPREAD: a rest parameter spread in the second position", async () => {
  const src = "'use strict';\nfunction decl(a, b, c) { return [a, b, c].map((v) => String(v)).join(\",\"); }\nconst fLead = (x, ...rest) => decl(x, ...rest);\nconsole.log(fLead(1), fLead(1, 2), fLead(1, 2, 3, 4));\nconst fMixed = (...args) => decl(...args, 7);\nconsole.log(fMixed(), fMixed(1), fMixed(1, 2, 3));\n";
  const { stdout, stderr, exitCode } = await runRow("R63", src, "cjs");
  expect(stdout).toBe("1,undefined,undefined 1,2,undefined 1,2,3\n7,undefined,undefined 1,7,undefined 1,2,3\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("R64 SPREAD: a spread reads the array as it is at the call", async () => {
  const src = "'use strict';\nfunction f(...a) { a.push(99); return a.length; }\nconst src = [1, 2];\nfunction fw(xs) { const g = (...args) => f(...args); return g(...xs); }\nconsole.log(fw(src), src.length, JSON.stringify(src));\n";
  const { stdout, stderr, exitCode } = await runRow("R64", src, "cjs");
  expect(stdout).toBe("3 2 [1,2]\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("R65 SPREAD: a Set stops at its crossing into a dynamic value", async () => {
  const src = "'use strict';\nfunction f(...a) { return a.length; }\nfunction probe(v) { const g = (...args) => f(...args); try { return g(...v); } catch (e) { return e.name + \": \" + e.message; } }\nconsole.log(probe(new Set([1, 2, 2])));\n";
  // This tier's answer (the existing SC1101 crossing fence); Node prints "2\n" and exits 0.
  const { stdout, stderr } = await runRowTrap("R65", src, "cjs");
  expect(stdout).toBe("");
  expect(stderr).toBe("Uncaught Error: converting typed values to 'unknown' is not supported yet [SC1101 at <ROW>:4]\n");
});

test("R66 SPREAD: a Map stops at its crossing into a dynamic value", async () => {
  const src = "'use strict';\nfunction f(...a) { return a.length; }\nfunction probe(v) { const g = (...args) => f(...args); try { return g(...v); } catch (e) { return e.name + \": \" + e.message; } }\nconsole.log(probe(new Map([[1, 2]])));\n";
  // This tier's answer (the existing SC1101 crossing fence); Node prints "1\n" and exits 0.
  const { stdout, stderr } = await runRowTrap("R66", src, "cjs");
  expect(stdout).toBe("");
  expect(stderr).toBe("Uncaught Error: converting typed values to 'unknown' is not supported yet [SC1101 at <ROW>:4]\n");
});

test("R67 SPREAD: a generator stops at its crossing into a dynamic value", async () => {
  const src = "'use strict';\nfunction f(...a) { return a.length; }\nfunction* gen() { yield 1; yield 2; }\nfunction probe(v) { const g = (...args) => f(...args); try { return g(...v); } catch (e) { return e.name + \": \" + e.message; } }\nconsole.log(probe(gen()));\n";
  // This tier's answer (the existing SC1101 crossing fence); Node prints "2\n" and exits 0.
  const { stdout, stderr } = await runRowTrap("R67", src, "cjs");
  expect(stdout).toBe("");
  expect(stderr).toBe("Uncaught Error: converting typed values to 'unknown' is not supported yet [SC1101 at <ROW>:5]\n");
});

test("R68 SPREAD: the spread TypeErrors of a forwarding call", async () => {
  const src = "'use strict';\nfunction f(...a) { return a.length; }\nfor (const v of [5, null, undefined, {}]) { try { console.log(f(...v)); } catch (e) { console.log(e.name, e.message); } }\n";
  const { stdout, stderr, exitCode } = await runRow("R68", src, "cjs");
  expect(stdout).toBe("TypeError Spread syntax requires ...iterable[Symbol.iterator] to be a function\nTypeError v is not iterable (cannot read property null)\nTypeError v is not iterable (cannot read property undefined)\nTypeError Spread syntax requires ...iterable[Symbol.iterator] to be a function\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

// ----------------------------------------------------------------------
// ASSIGN — Object.assign over a source pack; a target that is not a plain object refuses by name

test("R70 ASSIGN: Object.assign with zero, one and many sources (everything printed)", async () => {
  const src = "'use strict';\nconst t0 = JSON.parse('{\"t\":0}');\nconsole.log(Object.assign(t0) === t0, JSON.stringify(Object.assign(t0)));\nconsole.log(JSON.stringify(Object.assign({}, JSON.parse('{\"a\":1}'))));\nconsole.log(JSON.stringify(Object.assign({}, JSON.parse('{\"a\":1}'), JSON.parse('{\"b\":2}'), JSON.parse('{\"a\":3}'))));\nconst srcs = JSON.parse('[{\"x\":1},{\"y\":2},{\"x\":3}]');\nconsole.log(JSON.stringify(Object.assign({}, ...srcs)));\nconsole.log(JSON.stringify(Object.assign({}, ...srcs, ...srcs)));\n";
  const { stdout, stderr, exitCode } = await runRow("R70", src, "cjs");
  expect(stdout).toBe("true {\"t\":0}\n{\"a\":1}\n{\"a\":3,\"b\":2}\n{\"x\":3,\"y\":2}\n{\"x\":3,\"y\":2}\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("R71 ASSIGN: nullish, scalar, string and array sources", async () => {
  const src = "'use strict';\nconst vals = JSON.parse('[null, 5, true, \"ab\", [7, 8], {\"z\": 1}]');\nconsole.log(JSON.stringify(Object.assign({}, ...vals)));\nconsole.log(JSON.stringify(Object.assign({}, \"xyz\")));\nconsole.log(JSON.stringify(Object.assign({}, ...[\"ab\"])));\n";
  const { stdout, stderr, exitCode } = await runRow("R71", src, "cjs");
  expect(stdout).toBe("{\"0\":7,\"1\":8,\"z\":1}\n{\"0\":\"x\",\"1\":\"y\",\"2\":\"z\"}\n{\"0\":\"a\",\"1\":\"b\"}\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("R72 ASSIGN: a plain object target, and nullish targets", async () => {
  const src = "'use strict';\nconst seed = JSON.parse('{\"s\":0}');\nconst r = Object.assign(seed, ...JSON.parse('[{\"0\":9},{\"k\":1}]'));\nconsole.log(JSON.stringify(r), JSON.stringify(seed), r.k);\nfunction probe(t) { try { return typeof Object.assign(t, ...[{ a: 1 }]); } catch (e) { return e.message; } }\nconsole.log(probe(null), probe(undefined));\n";
  const { stdout, stderr, exitCode } = await runRow("R72", src, "cjs");
  expect(stdout).toBe("{\"0\":9,\"s\":0,\"k\":1} {\"0\":9,\"s\":0,\"k\":1} 1\nCannot convert undefined or null to object Cannot convert undefined or null to object\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

// ----------------------------------------------------------------------
// PACK — the source pack's evaluation order and its spread texts

test("R73 PACK: sources evaluate once, in order", async () => {
  const src = "'use strict';\nconst order = [];\nconst p = (k, v) => { order.push(k); return v; };\nconst r = Object.assign(p(\"t\", {}), p(\"a\", { a: 1 }), ...p(\"s\", [{ b: 2 }, { c: 3 }]), p(\"z\", { z: 4 }));\nconsole.log(order.join(\",\"), JSON.stringify(r));\n";
  const { stdout, stderr, exitCode } = await runRow("R73", src, "cjs");
  expect(stdout).toBe("t,a,s,z {\"a\":1,\"b\":2,\"c\":3,\"z\":4}\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

// ----------------------------------------------------------------------
// ASSIGN — Object.assign over a source pack; a target that is not a plain object refuses by name

test("R74 ASSIGN: later sources win and keep the first key's position", async () => {
  const src = "'use strict';\nconst r = Object.assign({ b: 0 }, ...JSON.parse('[{\"a\":1,\"b\":1},{\"c\":2,\"a\":3}]'));\nconsole.log(Object.keys(r).join(\",\"), JSON.stringify(r));\nconst n = Object.assign({}, ...JSON.parse('[{\"2\":\"x\",\"1\":\"y\",\"b\":\"z\"}]'));\nconsole.log(Object.keys(n).join(\",\"));\n";
  const { stdout, stderr, exitCode } = await runRow("R74", src, "cjs");
  expect(stdout).toBe("b,a,c {\"b\":1,\"a\":3,\"c\":2}\n1,2,b\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

// ----------------------------------------------------------------------
// PACK — the source pack's evaluation order and its spread texts

test("R75 PACK: the iterator-path spread texts for each kind", async () => {
  const src = "'use strict';\nfunction pm(v) { try { return JSON.stringify(Object.assign({}, ...v, { t: 1 })); } catch (e) { return e.message; } }\nfor (const v of [[{ a: 1 }], \"ab\", null, undefined, 3, true, {}, () => 1]) console.log(pm(v));\n";
  const { stdout, stderr, exitCode } = await runRow("R75", src, "cjs");
  expect(stdout).toBe("{\"a\":1,\"t\":1}\n{\"0\":\"b\",\"t\":1}\nobject null is not iterable (cannot read property Symbol(Symbol.iterator))\nundefined is not iterable (cannot read property Symbol(Symbol.iterator))\nnumber 3 is not iterable (cannot read property Symbol(Symbol.iterator))\nboolean true is not iterable (cannot read property Symbol(Symbol.iterator))\nobject is not iterable (cannot read property Symbol(Symbol.iterator))\nfunction is not iterable (cannot read property Symbol(Symbol.iterator))\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("R76 PACK: the apply-path spread texts for each kind", async () => {
  const src = "'use strict';\nfunction pl(v) { try { return JSON.stringify(Object.assign({}, ...v)); } catch (e) { return e.message; } }\nfor (const v of [[{ a: 1 }], \"ab\", null, undefined, 3, true, {}, () => 1]) console.log(pl(v));\n";
  const { stdout, stderr, exitCode } = await runRow("R76", src, "cjs");
  expect(stdout).toBe("{\"a\":1}\n{\"0\":\"b\"}\nv is not iterable (cannot read property null)\nv is not iterable (cannot read property undefined)\nSpread syntax requires ...iterable[Symbol.iterator] to be a function\nSpread syntax requires ...iterable[Symbol.iterator] to be a function\nSpread syntax requires ...iterable[Symbol.iterator] to be a function\nSpread syntax requires ...iterable[Symbol.iterator] to be a function\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

// ----------------------------------------------------------------------
// ASSIGN — Object.assign over a source pack; a target that is not a plain object refuses by name

test("R77 ASSIGN: plain sources only", async () => {
  const src = "'use strict';\nconst out = Object.assign({}, { a: 1 }, { b: 2 });\nconsole.log(JSON.stringify(out));\nconst tgt = JSON.parse('{\"x\":0}');\nconst out2 = Object.assign(tgt, JSON.parse('{\"y\":1}'));\nconsole.log(out2 === tgt, JSON.stringify(out2));\n";
  const { stdout, stderr, exitCode } = await runRow("R77", src, "cjs");
  expect(stdout).toBe("{\"a\":1,\"b\":2}\ntrue {\"x\":0,\"y\":1}\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("R78 ASSIGN: array, function and Uint8Array targets refuse by name", async () => {
  const src = "'use strict';\nfunction t(x) { try { const r = Object.assign(x, ...[{ a: 1 }]); return typeof r + \":\" + JSON.stringify(r); } catch (e) { return e.message; } }\nconsole.log(t([1]));\nconsole.log(t(() => 0));\nconsole.log(t(new Uint8Array(1)));\n";
  // This tier's answer (a named refusal; the two-argument form keeps board #193's answer); Node prints "object:[1]\nfunction:undefined\nobject:{\"0\":0,\"a\":1}\n".
  const { stdout, stderr, exitCode } = await runRow("R78", src, "cjs");
  expect(stdout).toBe("Object.assign onto a non-plain-object target is not supported yet\nObject.assign onto a non-plain-object target is not supported yet\nObject.assign onto a non-plain-object target is not supported yet\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("R79 ASSIGN: a null-prototype object as target and as source", async () => {
  const src = "'use strict';\nconst np = Object.create(null);\nnp.a = 1;\nconst plain = Object.assign({}, ...[np]);\nconsole.log(JSON.stringify(plain), plain);\nconst t = Object.assign(Object.create(null), ...[{ b: 2 }]);\nconsole.log(t);\n";
  const { stdout, stderr, exitCode } = await runRow("R79", src, "cjs");
  expect(stdout).toBe("{\"a\":1} { a: 1 }\n[Object: null prototype] { b: 2 }\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("A01 ASSIGN: an array target of the spread form refuses by name", async () => {
  const src = "'use strict';\nconst arrT = JSON.parse(\"[1,2]\");\nconst r = Object.assign(arrT, ...JSON.parse('[{\"0\":9}]'));\nconsole.log(JSON.stringify(r), JSON.stringify(arrT));\nfunction probe(t) { try { return typeof Object.assign(t, ...[{ a: 1 }]); } catch (e) { return e.message; } }\nconsole.log(probe(5), probe(\"s\"), probe(true));\n";
  // This tier's answer (a named refusal; the two-argument form keeps board #193's answer); Node prints "[9,2] [9,2]\nobject object object\n" and exits 0.
  const { stdout, stderr } = await runRowTrap("A01", src, "cjs");
  expect(stdout).toBe("");
  expect(stderr).toBe("Uncaught Error: Object.assign onto a non-plain-object target is not supported yet\n");
});

test("A02 ASSIGN: control, board #193: the two-argument form on array and scalar targets", async () => {
  const src = "'use strict';\nconst arrT = JSON.parse(\"[1,2]\");\nconst r = Object.assign(arrT, JSON.parse('{\"0\":9}'));\nconsole.log(JSON.stringify(r), JSON.stringify(arrT));\nfunction probe(t) { return typeof Object.assign(t, JSON.parse('{\"a\":1}')); }\nconsole.log(probe(5), probe(\"s\"), probe(true));\n";
  // This tier's answer (board #193); Node prints "[9,2] [9,2]\nobject object object\n".
  const { stdout, stderr, exitCode } = await runRow("A02", src, "cjs");
  expect(stdout).toBe("[1,2] [1,2]\nnumber string boolean\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("A04 ASSIGN: board #205: a typed record spread as the source projects the result onto the record's keys", async () => {
  const src = "'use strict';\nconst src = { z: 2 };\nconst a = Object.assign(JSON.parse('{\"a\":1}'), ...[src]);\nconsole.log(JSON.stringify(a));\n";
  // This tier's answer (board #205: the result is a fresh copy projected onto the source record's keys); Node prints "{\"a\":1,\"z\":2}\n".
  const { stdout, stderr, exitCode } = await runRow("A04", src, "cjs");
  expect(stdout).toBe("{\"z\":2}\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("A03 ASSIGN: a Uint8Array held in a variable as a spread source", async () => {
  const src = "'use strict';\nconst u = new Uint8Array([4, 5]);\nconst srcs = [u];\nconst r = Object.assign({}, ...srcs);\nconsole.log(JSON.stringify(r));\nconsole.log(JSON.stringify(Object.assign({}, u)));\n";
  const { stdout, stderr, exitCode } = await runRow("A03", src, "cjs");
  expect(stdout).toBe("{\"0\":4,\"1\":5}\n{\"0\":4,\"1\":5}\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

// ----------------------------------------------------------------------
// NULLPROTO — Object.create(null) through the readers, and its named ToString refusal

test("R80 NULLPROTO: inspect of null-prototype objects, nested and past the depth (everything printed)", async () => {
  const src = "'use strict';\nconst e = Object.create(null);\nconsole.log(e, [e], { e });\nconst d = { a: { b: { c: Object.create(null) } } };\nconsole.log(d);\nd.a.b.c.x = 1;\nconsole.log(d);\nconst n = Object.create(null);\nn.inner = Object.create(null);\nn.inner.v = [1, 2];\nconsole.log(n);\n";
  const { stdout, stderr, exitCode } = await runRow("R80", src, "cjs");
  expect(stdout).toBe("[Object: null prototype] {} [ [Object: null prototype] {} ] { e: [Object: null prototype] {} }\n{ a: { b: { c: [Object: null prototype] {} } } }\n{ a: { b: { c: [Object: null prototype] } } }\n[Object: null prototype] {\n  inner: [Object: null prototype] { v: [ 1, 2 ] }\n}\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("R81 NULLPROTO: into JSON and typed readers", async () => {
  const src = "'use strict';\nconst o = Object.create(null);\no.n = 1;\nconst s = JSON.stringify({ wrap: o, list: [o] });\nconsole.log(s, JSON.parse(s).wrap.n);\nconsole.log(JSON.stringify(o, null, 2));\n";
  const { stdout, stderr, exitCode } = await runRow("R81", src, "cjs");
  expect(stdout).toBe("{\"wrap\":{\"n\":1},\"list\":[{\"n\":1}]} 1\n{\n  \"n\": 1\n}\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("R82 NULLPROTO: array methods over null-prototype elements", async () => {
  const src = "'use strict';\nconst o = Object.create(null);\no.a = 1;\nconst arr = [o, o];\nconsole.log(arr.map((x) => x.a).join(\",\"), arr.indexOf(o), arr.includes(o));\n";
  const { stdout, stderr, exitCode } = await runRow("R82", src, "cjs");
  expect(stdout).toBe("1,1 0 true\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("R83 NULLPROTO: deep equality against plain and null-prototype objects", async () => {
  const src = "'use strict';\nconst assert = require(\"node:assert\");\nconst a = Object.create(null);\na.k = [1, { z: 2 }];\nconst b = Object.create(null);\nb.k = [1, { z: 2 }];\nassert.deepStrictEqual(a, b);\ntry { assert.deepStrictEqual(a, JSON.parse('{\"k\":[1,{\"z\":2}]}')); } catch (e) { console.log(e.message.split(\"\\n\").slice(0, 6).join(\"|\")); }\ntry { assert.notDeepStrictEqual(a, b); } catch (e) { console.log(e.message.split(\"\\n\")[0]); }\nconsole.log(\"ok\");\n";
  const { stdout, stderr, exitCode } = await runRow("R83", src, "cjs");
  expect(stdout).toBe("Expected values to be strictly deep-equal:|+ actual - expected||+ [Object: null prototype] {|- {|    k: [\nExpected \"actual\" not to be strictly deep-equal to:\nok\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("R84 NULLPROTO: keys, values, entries, typeof, in and hasOwn", async () => {
  const src = "'use strict';\nconst o = Object.create(null);\no.a = 1;\no[\"b c\"] = \"x\";\nconsole.log(o);\nconsole.log(typeof o, o === o, JSON.stringify(o), Object.keys(o).join(\",\"), Object.values(o).join(\",\"), JSON.stringify(Object.entries(o)));\n";
  const { stdout, stderr, exitCode } = await runRow("R84", src, "cjs");
  expect(stdout).toBe("[Object: null prototype] { a: 1, 'b c': 'x' }\nobject true {\"a\":1,\"b c\":\"x\"} a,b c 1,x [[\"a\",1],[\"b c\",\"x\"]]\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("R85 NULLPROTO: member reads, including the names Object.prototype would supply", async () => {
  const src = "'use strict';\nconst o = Object.create(null);\no.a = 1;\nconsole.log(o.toString === undefined, o.constructor === undefined, o.__proto__ === undefined, typeof o.hasOwnProperty);\n";
  const { stdout, stderr, exitCode } = await runRow("R85", src, "cjs");
  expect(stdout).toBe("true true true undefined\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("R86 NULLPROTO: o.toString() throws Node's TypeError", async () => {
  const src = "'use strict';\nconst o = Object.create(null);\no.v = 1;\nfunction call(x) { try { return x.toString(); } catch (e) { return e.name + \": \" + e.message; } }\nconsole.log(call(o));\nconst holder = { inner: o };\ntry { holder.inner.toString(); } catch (e) { console.log(e.message); }\nconsole.log(call(JSON.parse('{\"v\":1}')));\n";
  const { stdout, stderr, exitCode } = await runRow("R86", src, "cjs");
  expect(stdout).toBe("TypeError: x.toString is not a function\nholder.inner.toString is not a function\n[object Object]\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("R87a NULLPROTO: String(o) refuses by name", async () => {
  const src = "'use strict';\nconst o = Object.create(null);\no.k = 1;\nconsole.log(\"before\");\ntry { console.log(String(o)); } catch (e) { console.log(e.name, e.message); }\n";
  // This tier's answer (the named ToString refusal); Node prints "before\nTypeError Cannot convert object to primitive value\n" and exits 0.
  const { stdout, stderr } = await runRowTrap("R87a", src, "cjs");
  expect(stdout).toBe("before\n");
  expect(stderr).toBe("Uncaught Error: converting a null-prototype object (Object.create(null)) to a primitive value is not supported yet\n");
});

test("R87b NULLPROTO: a template refuses by name", async () => {
  const src = "'use strict';\nconst o = Object.create(null);\no.k = 1;\nconsole.log(\"before\");\ntry { console.log(`${o}`); } catch (e) { console.log(e.name, e.message); }\n";
  // This tier's answer (the named ToString refusal); Node prints "before\nTypeError Cannot convert object to primitive value\n" and exits 0.
  const { stdout, stderr } = await runRowTrap("R87b", src, "cjs");
  expect(stdout).toBe("before\n");
  expect(stderr).toBe("Uncaught Error: converting a null-prototype object (Object.create(null)) to a primitive value is not supported yet\n");
});

test("R87c NULLPROTO: o + \"\" refuses by name", async () => {
  const src = "'use strict';\nconst o = Object.create(null);\no.k = 1;\nconsole.log(\"before\");\ntry { console.log(o + \"\"); } catch (e) { console.log(e.name, e.message); }\n";
  // This tier's answer (the named ToString refusal); Node prints "before\nTypeError Cannot convert object to primitive value\n" and exits 0.
  const { stdout, stderr } = await runRowTrap("R87c", src, "cjs");
  expect(stdout).toBe("before\n");
  expect(stderr).toBe("Uncaught Error: converting a null-prototype object (Object.create(null)) to a primitive value is not supported yet\n");
});

test("R87d NULLPROTO: \"x\" + o refuses by name", async () => {
  const src = "'use strict';\nconst o = Object.create(null);\no.k = 1;\nconsole.log(\"before\");\ntry { console.log(\"x\" + o); } catch (e) { console.log(e.name, e.message); }\n";
  // This tier's answer (the named ToString refusal); Node prints "before\nTypeError Cannot convert object to primitive value\n" and exits 0.
  const { stdout, stderr } = await runRowTrap("R87d", src, "cjs");
  expect(stdout).toBe("before\n");
  expect(stderr).toBe("Uncaught Error: converting a null-prototype object (Object.create(null)) to a primitive value is not supported yet\n");
});

test("R87e NULLPROTO: [o].join() refuses by name", async () => {
  const src = "'use strict';\nconst o = Object.create(null);\no.k = 1;\nconsole.log(\"before\");\ntry { console.log([o].join()); } catch (e) { console.log(e.name, e.message); }\n";
  // This tier's answer (the named ToString refusal); Node prints "before\nTypeError Cannot convert object to primitive value\n" and exits 0.
  const { stdout, stderr } = await runRowTrap("R87e", src, "cjs");
  expect(stdout).toBe("before\n");
  expect(stderr).toBe("Uncaught Error: converting a null-prototype object (Object.create(null)) to a primitive value is not supported yet\n");
});

test("R87f NULLPROTO: a nested array's toString refuses by name", async () => {
  const src = "'use strict';\nconst o = Object.create(null);\no.k = 1;\nconsole.log(\"before\");\ntry { console.log([1, [o]].toString()); } catch (e) { console.log(e.name, e.message); }\n";
  // This tier's answer (the named ToString refusal); Node prints "before\nTypeError Cannot convert object to primitive value\n" and exits 0.
  const { stdout, stderr } = await runRowTrap("R87f", src, "cjs");
  expect(stdout).toBe("before\n");
  expect(stderr).toBe("Uncaught Error: converting a null-prototype object (Object.create(null)) to a primitive value is not supported yet\n");
});

test("R87g NULLPROTO: a template of a caught null-prototype object refuses by name", async () => {
  const src = "'use strict';\ntry { throw Object.create(null); } catch (e) { console.log(`T ${e}`); }\n";
  const { stdout, stderr } = await runRowTrap("R87g", src, "cjs");
  expect(stdout).toBe("");
  expect(stderr).toBe("Uncaught Error: converting a null-prototype object (Object.create(null)) to a primitive value is not supported yet\n");
});

test("R87h NULLPROTO: String of a caught null-prototype object refuses by name", async () => {
  const src = "'use strict';\ntry { throw Object.create(null); } catch (e) { console.log(\"S\", String(e)); }\n";
  const { stdout, stderr } = await runRowTrap("R87h", src, "cjs");
  expect(stdout).toBe("");
  expect(stderr).toBe("Uncaught Error: converting a null-prototype object (Object.create(null)) to a primitive value is not supported yet\n");
});

test("R87i NULLPROTO: a template in a .catch handler over a rejected null-prototype object", async () => {
  const src = "'use strict';\nPromise.reject(Object.create(null)).catch((e) => console.log(`R ${e}`));\n";
  const { stdout, stderr } = await runRowTrap("R87i", src, "cjs");
  expect(stdout).toBe("");
  expect(stderr).toBe("Uncaught Error: converting a null-prototype object (Object.create(null)) to a primitive value is not supported yet\n");
});

test("R87j NULLPROTO: control: a caught plain object reads [object Object]", async () => {
  const src = "'use strict';\ntry { throw { a: 1 }; } catch (e) { console.log(`T ${e}`); console.log(String(e)); }\n";
  const { stdout, stderr, exitCode } = await runRow("R87j", src, "cjs");
  expect(stdout).toBe("T [object Object]\n[object Object]\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("R87k NULLPROTO: concatenation with a caught null-prototype object refuses by name", async () => {
  const src = "'use strict';\ntry { throw Object.create(null); } catch (e) { try { console.log(\"C \" + e); } catch (x) { console.log(\"x\"); } }\n";
  // This tier's answer (the named ToString refusal, uncatchable where Node's TypeError is caught); Node prints "x\n" and exits 0.
  const { stdout, stderr } = await runRowTrap("R87k", src, "cjs");
  expect(stdout).toBe("");
  expect(stderr).toBe("Uncaught Error: converting a null-prototype object (Object.create(null)) to a primitive value is not supported yet\n");
});

test("R87l NULLPROTO: [e].join() over a caught null-prototype object refuses by name", async () => {
  const src = "'use strict';\ntry { throw Object.create(null); } catch (e) { console.log([e].join()); }\n";
  const { stdout, stderr } = await runRowTrap("R87l", src, "cjs");
  expect(stdout).toBe("");
  expect(stderr).toBe("Uncaught Error: converting a null-prototype object (Object.create(null)) to a primitive value is not supported yet\n");
});

test("R87m NULLPROTO: control: a rejected plain object through a .catch handler", async () => {
  const src = "'use strict';\nPromise.reject(JSON.parse('{\"a\":1}')).catch((e) => console.log(`R ${e}`, String(e)));\n";
  const { stdout, stderr, exitCode } = await runRow("R87m", src, "cjs");
  expect(stdout).toBe("R [object Object] [object Object]\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("R88 NULLPROTO: o.toString() throws; hasOwnProperty and valueOf meet the existing method fence", async () => {
  const src = "'use strict';\nconst o = Object.create(null);\nfor (const f of [() => o.toString(), () => o.hasOwnProperty(\"a\"), () => o.valueOf()]) {\n  try { console.log(f()); } catch (e) { console.log(e.name, e.message); }\n}\n";
  // This tier's answer (the existing SC1090 method-call fence on lines 2 and 3); Node prints "TypeError o.toString is not a function\nTypeError o.hasOwnProperty is not a function\nTypeError o.valueOf is not a function\n".
  const { stdout, stderr, exitCode } = await runRow("R88", src, "cjs");
  expect(stdout).toBe("TypeError o.toString is not a function\nError method calls like 'o.hasOwnProperty' is not supported yet [SC1090 at <ROW>:3]\nError method calls like 'o.valueOf' is not supported yet [SC1090 at <ROW>:3]\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("R89 NULLPROTO: a null-prototype object as a computed key refuses by name", async () => {
  const src = "'use strict';\nconst o = Object.create(null);\nconst q = JSON.parse('{\"k\":1}');\ntry { console.log(q[o]); } catch (e) { console.log(e.name, e.message); }\ntry { console.log(Number(o)); } catch (e) { console.log(e.name, e.message); }\ntry { console.log(o * 2); } catch (e) { console.log(e.name, e.message); }\n";
  // This tier's answer (the named ToString refusal); Node prints "TypeError Cannot convert object to primitive value\nTypeError Cannot convert object to primitive value\nTypeError Cannot convert object to primitive value\n" and exits 0.
  const { stdout, stderr } = await runRowTrap("R89", src, "cjs");
  expect(stdout).toBe("");
  expect(stderr).toBe("Uncaught Error: converting a null-prototype object (Object.create(null)) to a primitive value is not supported yet\n");
});

test("R89b NULLPROTO: board #204: a folded String(e) === undefined never converts", async () => {
  const src = "'use strict';\ntry { throw Object.create(null); } catch (e) { console.log('S', String(e) === undefined); }\n";
  // This tier's answer (board #204: the comparison is folded to false before String(e) runs, where Node's String(e) throws a TypeError and the program exits 1); Node prints "".
  const { stdout, stderr, exitCode } = await runRow("R89b", src, "cjs");
  expect(stdout).toBe("S false\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

// ----------------------------------------------------------------------
// CORPUS — full stdout and exit code

test("C01 CORPUS: 1554 a caught value flowing into unknown", async () => {
  const { stdout, stderr, exitCode } = await runCorpusRow("C01", "1554-caught-into-unknown.ts");
  expect(stdout).toBe("ok\nhandled: <boom>\nname=Error str=Error: boom\nhandled: <bad type>\nname=TypeError str=TypeError: bad type\nhandled: <>\nname=RangeError str=RangeError\nhandled: <plain string>\nstring len=12\nhandled: <42>\nnumber 43\nhandled: <false>\nboolean f\nhandled: <[object Object]>\ntruthy other\nhandled: <custom failure>\nname=CustomError str=CustomError: custom failure\nstored\ndone\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("C02 CORPUS: 2281 DOMException from atob and btoa", async () => {
  const { stdout, stderr, exitCode } = await runCorpusRow("C02", "2281-domexception-atob-btoa.cjs");
  expect(stdout).toBe("function function function\nYWJj abcd  abcd\née 3\nabc no cause 0 false true\nabc true foo\n5 InvalidCharacterError: m true true\n\"Error\" \"\" 0\nInvalidCharacterError 5 Invalid character\nInvalidCharacterError 5 The string to be decoded is not correctly encoded.\nok\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("C03 CORPUS: 2283 structuredClone", async () => {
  const { stdout, stderr, exitCode } = await runCorpusRow("C03", "2283-structured-clone.cjs");
  expect(stdout).toBe("{\"a\":[1,\"x\",null],\"b\":{\"c\":true}}\n{\"n\":1,\"arr\":[1,2]} {\"n\":1,\"arr\":[1,2,3]}\nDataCloneError 25 t true true\ntrue,false,true\nfalse,true,true\nok\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("C04 CORPUS: 2567 rest parameters forwarded by spread", async () => {
  const { stdout, stderr, exitCode } = await runCorpusRow("C04", "2567-rest-spread-forward.js");
  expect(stdout).toBe("12\n7\n11\n78\n19\n47\n12\nundefined\na\n[ 'nested' ]\ncaught: Spread syntax requires ...iterable[Symbol.iterator] to be a function\ncaught: v is not iterable (cannot read property null)\ncaught: v is not iterable (cannot read property undefined)\ncaught: Spread syntax requires ...iterable[Symbol.iterator] to be a function\ndone\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("C05 CORPUS: 2586 Object.assign over a spread source pack", async () => {
  const { stdout, stderr, exitCode } = await runCorpusRow("C05", "2586-object-assign-spread.js");
  expect(stdout).toBe("{\"semi\":{\"default\":true},\"tabWidth\":{\"default\":2},\"core\":1}\nsemi,tabWidth,core\ntrue {\"seed\":0,\"a\":1,\"b\":2}\n{\"k\":4}\n{\"0\":10,\"1\":20,\"z\":9}\n{\"solo\":1}\ncaught: object null is not iterable (cannot read property Symbol(Symbol.iterator))\n{\"keep\":0}\ncaught: v is not iterable (cannot read property null)\ncaught: v is not iterable (cannot read property undefined)\ncaught: Spread syntax requires ...iterable[Symbol.iterator] to be a function\ncaught: Spread syntax requires ...iterable[Symbol.iterator] to be a function\ncaught: object null is not iterable (cannot read property Symbol(Symbol.iterator))\ncaught: undefined is not iterable (cannot read property Symbol(Symbol.iterator))\ncaught: number 42 is not iterable (cannot read property Symbol(Symbol.iterator))\ncaught: boolean true is not iterable (cannot read property Symbol(Symbol.iterator))\ncaught: object is not iterable (cannot read property Symbol(Symbol.iterator))\nt,s1,sp,s2\ncaught: Cannot convert undefined or null to object\ndone\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("C06 CORPUS: 2589 Object.create(null)", async () => {
  const { stdout, stderr, exitCode } = await runCorpusRow("C06", "2589-object-create-null.cjs");
  expect(stdout).toBe("[Object: null prototype] {}\nobject {} \n[Object: null prototype] { x: 1, 'with space': 'v' }\n{ wrapped: [Object: null prototype] { x: 1, 'with space': 'v' } }\n{\"x\":1,\"with space\":\"v\"} x,with space\ntrue true false\n1 undefined\ncaught: o.toString is not a function\n3 1 {\"a\":3,\"b\":1}\nDSE: Expected values to be strictly deep-equal:|+ actual - expected||+ {}\n{ a: { b: { c: [Object: null prototype] {} } } }\n{ a: { b: { c: [Object: null prototype] } } }\ndone\n");
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
});

test("C07 CORPUS: 2654 a top-level-await failure beside an unrelated rejection", async () => {
  // The trap is this tier's exit 1 (the differential harness maps a trap to exit 1; Node exits 1 here).
  const { stdout, stderr } = await runCorpusRowTrap("C07", "2654-top-level-await-unrelated-rejection.ts");
  expect(stdout).toBe("before rejections\nunhandled other\n");
  expect(stderr).toBe("Unhandled promise rejection: Error: top\n");
});

test("C08 CORPUS: 2663 a failing top-level-await dependency", async () => {
  // The trap is this tier's exit 1 (the differential harness maps a trap to exit 1; Node exits 1 here).
  const { stdout, stderr } = await runCorpusRowTrap("C08", "2663-top-level-await-dependency-errors/main.ts");
  expect(stdout).toBe("listener armed\nasync bad\nsync bad\n");
  expect(stderr).toBe("Unhandled promise rejection: Error: sync dependency failed\n");
});

test("C09 CORPUS: 2664 a top-level-await failure in the same checkpoint as an unrelated rejection", async () => {
  // The trap is this tier's exit 1 (the differential harness maps a trap to exit 1; Node exits 1 here).
  const { stdout, stderr } = await runCorpusRowTrap("C09", "2664-top-level-await-same-checkpoint-rejection.ts");
  expect(stdout).toBe("");
  expect(stderr).toBe("Unhandled promise rejection: Error: module failed\n");
});
