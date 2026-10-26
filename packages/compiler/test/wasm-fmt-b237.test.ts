/* Boards #237 and #239 — focused rows for the two front-end mechanisms
 * (every lane shares them; these rows run the wasm lane, the corpus
 * programs 2746 and 2747 pin all three lanes against Node).
 *
 * #237: a RUNTIME format string's specifier meeting an argument whose
 * conversion the tier has no lowering for refuses BY NAME at run time
 * (SEMANTICS.md S099) — only when that specifier actually consumes that
 * argument; the same argument under a supported specifier, or as a rest
 * argument, prints Node's text. #239: a checked-dynamic size runs
 * validateNumber's type gate (ERR_INVALID_ARG_TYPE) before the range
 * check. ONE test PER ROW, each its own compile. Expected Node lines are
 * inlined from `node --experimental-transform-types` runs of the same
 * snippets (v24.18.1); refusal lines are this tier's own fence text. */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { runWasm } from "./wasm-host.js";

let scratch: string;
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "tsinter-wasm-fmt-b237-"));
});
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function runRow(name: string, src: string, ext: "ts" | "js" = "ts"): Promise<string> {
  const entry = join(scratch, `${name}.${ext}`);
  await writeFile(entry, `${src}\n`);
  const res = await compile(entry, { outPath: join(scratch, `${name}.wasm`), outDir: scratch, backend: "wasm" });
  if (!res.ok) throw new Error(`${name} refused: ${res.diagnostics[0]?.message}`);
  const { stdout } = await runWasm(res.binaryPath);
  return stdout.toString();
}

const J = 'function j(s: string): string { return [s].join(""); }';
const fence = (what: string): string =>
  `caught '${what}' is part of the standard library types but has no scriptc lowering yet [SC2020]`;

test("FMT-FENCE-01: %o over an array-carrying argument refuses by name when it meets it", async () => {
  const out = await runRow("fence01", [
    J,
    "const arr = [1, \"two\", { three: 3 }];",
    "try { console.log(j(\"%o\"), arr); } catch (e) { console.log(\"caught\", (e as Error).message); }",
    "console.log(j(\"%o %s\"), 1, arr);",
    "console.log(j(\"%s\"), arr);",
    "console.log(j(\"none\"), arr);",
  ].join("\n"));
  expect(out).toBe([
    fence("util.format %o over arrays"),
    "1 [ 1, 'two', [Object] ]",
    "[ 1, 'two', [Object] ]",
    "none [ 1, 'two', { three: 3 } ]",
    "",
  ].join("\n"));
});

test("FMT-FENCE-02: %s of a function value refuses (Node prints its source); %O and the rest form print", async () => {
  const out = await runRow("fence02", [
    J,
    "const f = (): number => 1;",
    "try { console.log(j(\"%s\"), f); } catch (e) { console.log(\"caught\", (e as Error).message); }",
    "console.log(j(\"fn\"), f);",
    "console.log(j(\"%O\"), [1]);",
    "try { console.log(j(\"%d\"), [1]); } catch (e) { console.log(\"caught\", (e as Error).message); }",
    "console.log(j(\"%j\"), [1]);",
  ].join("\n"));
  expect(out).toBe([
    fence("util.format %s of function values (Node's %s prints the function's source text)"),
    "fn [Function: f]",
    "[ 1 ]",
    fence("util.format %d of 'number[]' values"),
    "[1]",
    "",
  ].join("\n"));
});

test("FMT-UTIL-01: util.format over a runtime string (formerly the SC2020 compile fence)", async () => {
  const out = await runRow("util01", [
    "import * as util from \"node:util\";",
    J,
    "console.log(util.format(j(\"x%sy%d\"), \"Q\", 5, \"extra\"));",
    "console.log(util.format(j(\"%o|%O|%j|%i|%f|%c|%%\"), 1, 2, 3, 4, 5, \"css\"));",
    "console.log(util.formatWithOptions({}, j(\"%s%%\"), 7));",
  ].join("\n"));
  expect(out).toBe(["xQy5 extra", "1|2|3|4|5||%", "7%", ""].join("\n"));
});

test("FMT-GUARD-01: specifiers past the last argument stay as written; %% collapses on both sides of the guard", async () => {
  const out = await runRow("guard01", [
    J,
    "console.log(j(\"%s %s %s\"), \"one\");",
    "console.log(j(\"%s|%%|%s|%%\"), \"a\");",
    "console.log(j(\"%c%d\"), \"x\");",
  ].join("\n"));
  expect(out).toBe(["one %s %s", "a|%|%s|%", "%d", ""].join("\n"));
});

test("FMT-ORDER-01: every argument evaluates once, in order, before the scan", async () => {
  const out = await runRow("order01", [
    J,
    "let n = 0;",
    "function next(): string { n++; return `v${n}`; }",
    "console.log(j(\"%s|%c|%s\"), next(), next(), next(), next());",
    "console.log(n);",
  ].join("\n"));
  expect(out).toBe(["v1||v3 v4", "4", ""].join("\n"));
});

test("FMT-DYN-01: %d / %i / %f over checked-dynamic values take Number / ToString per runtime kind; an own valueOf refuses", async () => {
  const out = await runRow("dyn01", [
    J,
    "function v(fmt: any, a: any): void { console.log(fmt, a, a, a); }",
    "const vals: any = JSON.parse('[\"17\", \"\", true, null, {}, [], [5], [1, 2], \"-0\"]');",
    "for (let i = 0; i < 9; i++) v(\"%d|%i|%f\", vals[i]);",
    "const o: any = JSON.parse('{\"a\": 1, \"n\": \"%d\"}');",
    "console.log(j(\"%d|%s\"), o.n, o);",
    "try { console.log(j(\"%d\"), JSON.parse('{\"valueOf\": 1}')); } catch (e) { console.log(\"caught\", (e as Error).message); }",
  ].join("\n"));
  expect(out).toBe([
    "17|17|17",
    "0|NaN|NaN",
    "1|NaN|NaN",
    "0|NaN|NaN",
    "NaN|NaN|NaN",
    "0|NaN|NaN",
    "5|5|5",
    "NaN|1|1",
    "-0|-0|-0",
    "NaN|{ a: 1, n: '%d' }",
    fence("util.format %d of a value with its own valueOf"),
    "",
  ].join("\n"));
});

test("ALLOC-DYN-01: a checked-dynamic size's type gate is ERR_INVALID_ARG_TYPE; allocUnsafeSlow (JS sources only) validates alike", async () => {
  const out = await runRow("allocdyn01", [
    "'use strict';",
    "function show(l, f) { try { const b = f(); console.log(l, 'ok', b.length); } catch (e) { console.log(l, e.name, String(e.code), e.message); } }",
    "function a(n) { return Buffer.alloc(n); }",
    "show('str', () => a('5'));",
    "show('obj', () => a({}));",
    "show('und', () => a(undefined));",
    "show('num', () => a(2));",
    "show('neg', () => a(-2));",
    "show('slow', () => Buffer.allocUnsafeSlow(3));",
    "show('slowneg', () => Buffer.allocUnsafeSlow(-3));",
  ].join("\n"), "js");
  expect(out).toBe([
    "str TypeError ERR_INVALID_ARG_TYPE The \"size\" argument must be of type number. Received type string ('5')",
    "obj TypeError ERR_INVALID_ARG_TYPE The \"size\" argument must be of type number. Received an instance of Object",
    "und TypeError ERR_INVALID_ARG_TYPE The \"size\" argument must be of type number. Received undefined",
    "num ok 2",
    "neg RangeError ERR_OUT_OF_RANGE The value of \"size\" is out of range. It must be >= 0 && <= 9007199254740991. Received -2",
    "slow ok 3",
    "slowneg RangeError ERR_OUT_OF_RANGE The value of \"size\" is out of range. It must be >= 0 && <= 9007199254740991. Received -3",
    "",
  ].join("\n"));
});
