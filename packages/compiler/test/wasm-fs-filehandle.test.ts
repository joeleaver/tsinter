/* fs/promises FileHandle's refusals by name (the values themselves are
 * corpus program tests/corpus/2951-fs-filehandle.ts, Node-differential on
 * both WasmGC lanes): the streams and async iteration (the next step,
 * "not yet"), the members with no lowering, the argument forms beyond the
 * lowered ones, and the legacy C/LLVM lanes. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { compile } from "../src/index.js";

const scratch = mkdtempSync(join(tmpdir(), "tsinter-fh-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const PRE = 'import { open } from "node:fs/promises";\nasync function main(): Promise<void> {\n  const h = await open("/etc/hostname");\n';
const POST = "\n}\nvoid main();\n";

const ROWS: { id: string; src: string; want: string; backend?: "c" | "llvm" }[] = [
  { id: "readStream", src: "h.createReadStream();", want: "FileHandle.createReadStream (not yet)" },
  { id: "writeStream", src: "h.createWriteStream();", want: "FileHandle.createWriteStream (not yet)" },
  { id: "readLines", src: "h.readLines();", want: "FileHandle.readLines (not yet)" },
  { id: "readv", src: "await h.readv([Buffer.alloc(1)]);", want: "FileHandle.readv" },
  { id: "appendFile", src: 'await h.appendFile("x");', want: "FileHandle.appendFile" },
  { id: "readNoArgs", src: "await h.read();", want: "FileHandle.read with 0 arguments" },
  { id: "writeOffset", src: "await h.write(Buffer.alloc(1), 0);", want: "FileHandle.write with 2 arguments" },
  { id: "readFileLatin1", src: 'await h.readFile("latin1");', want: "FileHandle.readFile with this encoding" },
  { id: "readFileHex", src: 'await h.readFile({ encoding: "hex" });', want: "FileHandle.readFile with this encoding" },
  { id: "readFileBase64", src: 'await h.readFile("base64");', want: "FileHandle.readFile with this encoding" },
  { id: "flagsVar", src: 'const f: string = process.argv.length > 9 ? "r" : "r+";\nawait open("/etc/hostname", f);', want: "open with these flags" },
  { id: "modeVar", src: "const m = process.argv.length;\nawait open(\"/etc/hostname\", \"r\", m);", want: "open with this mode argument" },
  // Node's read/write results have a null prototype (inspect prints
  // "[Object: null prototype]"): printing or a dynamic copy refuses by name
  // (a Buffer inside a composite has no inspect lowering: that refusal
  // names it first)
  { id: "inspectRead", src: "console.log(await h.read(Buffer.alloc(1), 0, 1, 0));", want: "console.log of '{ buffer: Uint8Array; bytesRead: number }' values" },
  { id: "inspectReadText", src: 'const t = await h.write("x");\nconsole.log([t]);', want: "libCall:fh.write:null-proto-inspect" },
  { id: "inspectWrite", src: 'console.log(await h.write("x"));', want: "libCall:fh.write:null-proto-inspect" },
  { id: "dynRead", src: "const r: unknown = await h.read(Buffer.alloc(1), 0, 1, 0);\nconsole.log(typeof r);", want: "libCall:fh.read:null-proto-dyn" },
  { id: "legacyC", src: "await h.close();", want: "fs/promises FileHandle are not supported on the legacy C and LLVM backends", backend: "c" },
];

describe("FileHandle: what has no lowering refuses by name", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([id, row]) => {
    const dir = join(scratch, id);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "main.ts");
    writeFileSync(file, PRE + row.src + POST);
    const res = await compile(file, { outPath: join(dir, "p.wasm"), outDir: dir, backend: row.backend ?? "wasm" });
    expect(res.ok).toBe(false);
    expect(res.ok ? "" : res.diagnostics.map((d) => d.message).join("\n")).toContain(row.want);
  });
});
