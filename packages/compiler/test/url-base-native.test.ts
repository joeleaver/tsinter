/* SEMANTICS.md S096 — a URL base and the URL statics on the native lanes.
 * The wasm tier resolves `new URL(input, base)` and answers `URL.parse` /
 * `URL.canParse` like Node (wasm-url-u3.test.ts's URL-BASE rows). The c
 * and llvm lanes parse a base first — a base their subset parser rejects
 * is Node's Invalid URL, unless it holds a byte outside that subset
 * (non-ASCII, '%', '[' or ']'), which throws the gap Error instead — then
 * throw a catchable Error naming the gap; URL.parse and URL.canParse, with
 * or without a base, always throw their own named Error (the subset
 * parser's null / false could be silently wrong). One row per lane, plain
 * and sanitized; inputs are computed, not literals, so the refcounts are
 * real. */
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { compile } from "../src/index.js";

const execFileAsync = promisify(execFile);

let scratch: string;
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "tsinter-url-base-native-"));
});
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

const SOURCE = `
const k = String(Math.floor(Math.random() * 0));
const show = (f: () => string): void => {
  try {
    console.log("ret " + f());
  } catch (e) {
    console.log(e instanceof TypeError ? "TypeError " + e.message : e instanceof Error ? "Error " + e.message : "?");
  }
};
const good = "http://h" + k + "/a/";
const bad = "bad" + k;
show(() => new URL("x" + k, bad).href);
show(() => new URL("x" + k, good).href);
show(() => new URL("x" + k, new URL(good)).href);
show(() => new URL("http://x/" + k, undefined).href);
show(() => new URL("x" + k, "http://\\u00f1" + k + "/").href);
show(() => new URL("x" + k, "http://[::" + k + "]/").href);
show(() => String(URL.canParse(good)));
show(() => { const p = URL.parse(bad); return p === null ? "null" : p.href; });
show(() => String(URL.canParse("x" + k, bad)));
show(() => { const p = URL.parse("x" + k, good); return p === null ? "null" : p.href; });
`;
const GAP = "Error resolving a URL against a base is not supported on this lane yet";
const STATICS = "Error URL.parse and URL.canParse are not supported on this lane yet";
/* Node v24.18.1: TypeError Invalid URL; ret http://h0/a/x0 twice;
 * ret http://x/0; ret http://xn--0-qga/x0; ret http://[::]/x0; ret true;
 * ret null; ret false; ret http://h0/a/x0. Lines 1 and 4 are Node's; the
 * others are this lane's named Errors. */
const EXPECTED = [
  "TypeError Invalid URL",
  GAP,
  GAP,
  "ret http://x/0",
  GAP,
  GAP,
  STATICS,
  STATICS,
  STATICS,
  STATICS,
].join("\n") + "\n";

describe("SEMANTICS.md S096: a URL base and the URL statics on the native lanes", () => {
  for (const backend of ["c", "llvm"] as const) {
    for (const sanitize of [false, true]) {
      test(`URL-BASE-NATIVE ${backend}${sanitize ? " (sanitized)" : ""}: an in-subset bad base is Node's Invalid URL; an out-of-subset base (IDNA, IPv6) and a parseable one throw the named gap Error — Node resolves them — and URL.parse / URL.canParse throw their named Error — Node answers a URL, null or a boolean — SINGLE-EDIT: scr_url_new_base skipping its base parse, or scr_url_parse answering NULL`, async () => {
        const entry = join(scratch, `p-${backend}-${sanitize}.ts`);
        await writeFile(entry, SOURCE);
        const res = await compile(entry, { outPath: `${entry}.bin`, outDir: scratch, backend, sanitize });
        if (!res.ok) throw new Error(`refused: ${res.diagnostics.map((d) => `${d.code} ${d.message}`).join("; ")}`);
        const { stdout, stderr } = await execFileAsync(res.binaryPath);
        expect(stderr).toBe("");
        expect(stdout).toBe(EXPECTED);
      }, 180000);
    }
  }
});
