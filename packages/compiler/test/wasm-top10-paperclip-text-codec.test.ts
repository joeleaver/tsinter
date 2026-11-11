/* paperclip step 3: TextEncoder / TextDecoder held as values. paperclip's
 * CLI keeps a module-level `const inlineEstimateUtf8 = new TextEncoder()`
 * and measures `encoder.encode(JSON.stringify(x)).length`; its zip writer
 * encodes file names and bodies through a local encoder. Before, only the
 * composed `new TextEncoder().encode(s)` form compiled. A default (utf-8)
 * codec is now a one-field record (its `.encoding`), and encode/decode
 * through it lower exactly like the composed forms. Rows run under Node
 * and on both WasmGC lanes, with @types/node (which declares the
 * codecs). The record is not program data: JSON text, inspection, String()
 * and conversion into 'unknown' of a codec (or a StringDecoder, the same
 * representation) refuse by name instead of printing its hidden slot. */
import { describe, test } from "vitest";
import { checkRefuses, checkRow, type Row, scratchDir } from "./top10-paperclip-rows.js";

const scratch = scratchDir("pc-text-codec");

const ROWS: Row[] = [
  {
    id: "PC3-01 a module-level encoder measures UTF-8 byte lengths",
    files: {
      "main.ts": `const inlineEstimateUtf8 = new TextEncoder();
function entryBytes(entry: string | string[]): number {
  if (typeof entry === "string") return inlineEstimateUtf8.encode(JSON.stringify(entry)).length;
  let total = 0;
  for (const e of entry) total += inlineEstimateUtf8.encode(JSON.stringify(e)).length + 2;
  return total;
}
console.log(entryBytes("héllo €"), entryBytes(["a", "ñ", "😀"]), inlineEstimateUtf8.encoding);`,
    },
  },
  {
    id: "PC3-02 a local encoder's bytes, then a decoder value round-trips them",
    files: {
      "main.ts": `function header(root: string, rel: string, content: string): number[] {
  const encoder = new TextEncoder();
  const fileName = encoder.encode(root + "/" + rel);
  const body = encoder.encode(content);
  return [fileName.length, body.length, fileName[0]!, body[body.length - 1]!];
}
console.log(header("pkg", "añb.txt", "line €\\n").join(","));
const decoder = new TextDecoder();
const bytes = new TextEncoder().encode("añb €");
console.log(decoder.decode(bytes), decoder.encoding, JSON.stringify(decoder.decode()));
const utf8 = new TextDecoder("utf-8");
console.log(utf8.decode(new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69])));`,
    },
  },
  {
    id: "PC3-03 codecs as fields and parameters",
    files: {
      "main.ts": `class Sizer {
  private readonly enc = new TextEncoder();
  size(s: string): number { return this.enc.encode(s).byteLength; }
}
function viaParam(e: InstanceType<typeof TextEncoder>, s: string): number { return e.encode(s).length; }
const sizer = new Sizer();
console.log(sizer.size("ascii"), sizer.size("ünï"), viaParam(new TextEncoder(), "€€"));`,
    },
  },
];

const REFUSALS: [string, string, string][] = [
  ["PC3-R1 JSON.stringify of an encoder", "console.log(JSON.stringify(new TextEncoder()));", "JSON.stringify of"],
  ["PC3-R2 console.log of a decoder", "const d = new TextDecoder();\nconsole.log(d);", "StringDecoder/TextEncoder/TextDecoder instances have no inspect lowering"],
  ["PC3-R3 String() of an encoder", "const e = new TextEncoder();\nconsole.log(String(e));", "string conversions of StringDecoder/TextEncoder/TextDecoder instances"],
  ["PC3-R4 an encoder into unknown", "const e = new TextEncoder();\nconst u: unknown = e;\nconsole.log(u === undefined);", "%enc"],
  ["PC3-R5 JSON.stringify of a StringDecoder", "import { StringDecoder } from \"node:string_decoder\";\nconsole.log(JSON.stringify(new StringDecoder(\"utf8\")));", "JSON.stringify of"],
];

describe("paperclip: codec instances refuse generic surfaces by name", () => {
  test.for(REFUSALS)("%s", async ([id, src, expected]) => {
    await checkRefuses(scratch, { id, files: { "main.ts": src } }, expected);
  });
});

describe("paperclip: TextEncoder/TextDecoder values (wasm lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await checkRow(scratch, row, "wasm");
  });
});

describe("paperclip: TextEncoder/TextDecoder values (wasm-native lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await checkRow(scratch, row, "wasm-native");
  }, 600_000);
});
