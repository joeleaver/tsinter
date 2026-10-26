/* The island ENGINE image: the prebuilt quickjs-ng + isl_core.c module
 * (packages/runtime/vendor/quickjs-ng-wasm/engine.wasm, built by
 * scripts/build-engine-wasm.mjs with `wasm-ld --emit-relocs`), parsed into
 * the parts ModuleBuilder.attachEngine splices into a program's own
 * module. Only programs that reach the engine (`__island_eval` today) ever
 * load it: every other module is byte-identical to a build without this
 * file.
 *
 * WHY RELOCATIONS: the merged module re-numbers every engine function,
 * type and global (ours occupy the front of each index space), and an
 * instruction's index immediates are LEBs inside the code section. With
 * --emit-relocs, wasm-ld leaves every such immediate PADDED TO 5 BYTES and
 * records its offset in `reloc.CODE`, so re-indexing is an in-place
 * overwrite of exactly those bytes — no instruction decoder, no body
 * re-encoding, no size changes. Memory addresses and table slots are NOT
 * touched: the engine keeps memory 0 and table 0 with its own layout.
 *
 * THE FORMAT CHECK: everything this file relies on is asserted while
 * parsing, and any surprise is an EngineFormatError naming what differed —
 * a relocated immediate that is not a 5-byte LEB, a reloc type outside the
 * known set, a second table or memory, a passive data segment, an import
 * that is not a function, an f32/v128 value type, a start section. The
 * artifact pins the toolchain (wasm-ld 21); this check is what notices a
 * rebuild with a different one before it can produce a wrong module. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { ValType } from "./module.js";

/** The Node globals the engine does not have yet (SEMANTICS.md S103 (b)),
 * as the BUILT engine reports them (engine-fence.json beside the artifact,
 * written by scripts/build-engine-wasm.mjs from Node's own global names
 * minus the engine's): isl_core.c makes each one a getter that throws a
 * named error at run time, and an `__island_eval` whose visible source
 * text references one refuses at build time instead. */
let fencedCache: ReadonlySet<string> | null = null;
export function engineFencedGlobals(): ReadonlySet<string> {
  if (fencedCache !== null) return fencedCache;
  const path = join(dirname(engineArtifactPath()), "engine-fence.json");
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { fenced?: unknown };
  if (!Array.isArray(parsed.fenced) || !parsed.fenced.every((n) => typeof n === "string")) {
    throw new EngineFormatError(`${path} is not a { "fenced": string[] } record`);
  }
  fencedCache = new Set(parsed.fenced as string[]);
  return fencedCache;
}

/** The identifiers a piece of JS source text uses in REFERENCE position:
 * outside string literals and comments, and not a property name (after
 * `.` / `?.`, or a `name:` key). A cheap scanner, not a parser: a regex
 * literal or an object-literal shorthand still counts its words, which
 * can only over-refuse (the run-time fence stays the backstop for text
 * the compiler cannot see). Template literals count their `${...}`
 * expressions and skip their text. */
export function referencedIdentifiers(text: string): string[] {
  const out: string[] = [];
  const n = text.length;
  let i = 0;
  // Template nesting: each entry is the brace depth at which a `${` opened.
  const tmpl: number[] = [];
  let depth = 0;
  let prevSignificant = "";
  const isStart = (c: string): boolean => /[A-Za-z_$]/.test(c);
  const isPart = (c: string): boolean => /[A-Za-z0-9_$]/.test(c);
  const skipTemplateText = (): void => {
    // At a template's text: runs to the closing backtick or a `${`.
    while (i < n) {
      const c = text[i]!;
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === "`") {
        i++;
        return;
      }
      if (c === "$" && text[i + 1] === "{") {
        i += 2;
        tmpl.push(depth);
        depth++;
        return;
      }
      i++;
    }
  };
  while (i < n) {
    const c = text[i]!;
    if (c === "/" && text[i + 1] === "/") {
      while (i < n && text[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const e = text.indexOf("*/", i + 2);
      i = e < 0 ? n : e + 2;
      continue;
    }
    if (c === "'" || c === '"') {
      i++;
      while (i < n && text[i] !== c) i += text[i] === "\\" ? 2 : 1;
      i++;
      prevSignificant = "s";
      continue;
    }
    if (c === "`") {
      i++;
      skipTemplateText();
      prevSignificant = "s";
      continue;
    }
    if (c === "{") {
      depth++;
      i++;
      prevSignificant = c;
      continue;
    }
    if (c === "}") {
      depth--;
      i++;
      if (tmpl.length > 0 && tmpl[tmpl.length - 1] === depth) {
        tmpl.pop();
        skipTemplateText();
        prevSignificant = "s";
      } else {
        prevSignificant = c;
      }
      continue;
    }
    if (isStart(c)) {
      let j = i + 1;
      while (j < n && isPart(text[j]!)) j++;
      const word = text.slice(i, j);
      let k = j;
      while (k < n && /\s/.test(text[k]!)) k++;
      const isKey = text[k] === ":" && text[k + 1] !== ":" && (prevSignificant === "{" || prevSignificant === ",");
      if (prevSignificant !== "." && !isKey) out.push(word);
      prevSignificant = "w";
      i = j;
      continue;
    }
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (/[0-9]/.test(c)) {
      while (i < n && /[0-9A-Za-z_.]/.test(text[i]!)) i++;
      prevSignificant = "n";
      continue;
    }
    // `?.` is member access like `.`; a lone `.` too (`...` spreads are
    // followed by an identifier in reference position, so they reset).
    if (c === "." && text[i + 1] === "." && text[i + 2] === ".") {
      i += 3;
      prevSignificant = "op";
      continue;
    }
    if (c === "?" && text[i + 1] === "." && !/[0-9]/.test(text[i + 2] ?? "")) {
      i += 2;
      prevSignificant = ".";
      continue;
    }
    prevSignificant = c;
    i++;
  }
  return out;
}

/** The first fenced global a piece of eval source references, or null. */
export function fencedGlobalIn(text: string): string | null {
  const fenced = engineFencedGlobals();
  for (const word of referencedIdentifiers(text)) if (fenced.has(word)) return word;
  return null;
}

export class EngineFormatError extends Error {
  constructor(message: string) {
    super(`island engine artifact: ${message}`);
    this.name = "EngineFormatError";
  }
}

export interface EngineFuncType {
  params: ValType[];
  results: ValType[];
}

/** One index-space relocation to patch: an engine index at `offset` in
 * the code-section payload, always a 5-byte padded ULEB. */
export interface EngineReloc {
  space: "func" | "type" | "global" | "table";
  offset: number;
  index: number;
}

export interface EngineImage {
  types: EngineFuncType[];
  /** Engine function imports (all of them come first in the engine's own
   * function index space). */
  imports: { module: string; name: string; type: number }[];
  /** Engine-defined functions' type indices, in engine order. */
  funcTypes: number[];
  tableMin: number;
  tableMax: number | null;
  memoryMin: number;
  globals: { type: ValType; mutable: boolean; init: Uint8Array }[];
  /** Exported engine functions by name → engine function index. */
  exports: Map<string, number>;
  /** The one active element segment for table 0. */
  elemOffset: Uint8Array;
  elemFuncs: number[];
  /** The code-section payload (count included) and each body's byte range
   * in it (size prefix included). */
  code: Uint8Array;
  bodies: { start: number; end: number }[];
  relocs: EngineReloc[];
  /** Active data segments for memory 0, each entry's bytes verbatim. */
  dataSegments: Uint8Array[];
  /** Function names (engine function index → name), from its name section. */
  names: Map<number, string>;
}

class Reader {
  pos: number;
  constructor(
    readonly b: Uint8Array,
    pos = 0,
    readonly end = b.length,
  ) {
    this.pos = pos;
  }
  u8(): number {
    if (this.pos >= this.end) throw new EngineFormatError(`truncated at byte ${this.pos}`);
    return this.b[this.pos++]!;
  }
  uleb(): number {
    let result = 0;
    let shift = 0;
    for (;;) {
      const x = this.u8();
      result += (x & 0x7f) * 2 ** shift;
      shift += 7;
      if ((x & 0x80) === 0) return result;
      if (shift > 35) throw new EngineFormatError(`over-long LEB at byte ${this.pos}`);
    }
  }
  name(): string {
    const n = this.uleb();
    const s = new TextDecoder().decode(this.b.subarray(this.pos, this.pos + n));
    this.pos += n;
    return s;
  }
  /** A constant expression, returned WITHOUT its `end`. Only the MVP
   * numeric consts and global.get may appear in the engine's. */
  constExpr(): Uint8Array {
    const start = this.pos;
    const op = this.u8();
    if (op === 0x41) this.uleb(); // i32.const (sleb — same byte length)
    else if (op === 0x42) this.uleb();
    else if (op === 0x44) this.pos += 8;
    else throw new EngineFormatError(`unexpected constant-expression opcode 0x${op.toString(16)}`);
    const body = this.b.slice(start, this.pos);
    if (this.u8() !== 0x0b) throw new EngineFormatError("constant expression longer than one instruction");
    return body;
  }
}

function valType(code: number): ValType {
  switch (code) {
    case 0x7f:
      return { kind: "i32" };
    case 0x7e:
      return { kind: "i64" };
    case 0x7c:
      return { kind: "f64" };
    default:
      throw new EngineFormatError(`value type 0x${code.toString(16)} (only i32/i64/f64 are spliced)`);
  }
}

/* reloc type numbers (tool-conventions Linking.md). The index-space
 * relocations are rewritten; the address/slot ones are kept verbatim
 * (memory 0 and table 0 keep the engine's own layout). */
const R_FUNCTION_INDEX_LEB = 0;
const R_TABLE_INDEX_SLEB = 1;
const R_MEMORY_ADDR_LEB = 3;
const R_MEMORY_ADDR_SLEB = 4;
const R_TYPE_INDEX_LEB = 6;
const R_GLOBAL_INDEX_LEB = 7;
const R_MEMORY_ADDR_REL_SLEB = 11;
const R_TABLE_NUMBER_LEB = 20;
const KEPT_CODE_RELOCS = new Set([R_TABLE_INDEX_SLEB, R_MEMORY_ADDR_LEB, R_MEMORY_ADDR_SLEB, R_MEMORY_ADDR_REL_SLEB]);
/* Types whose record carries an addend. */
const WITH_ADDEND = new Set([3, 4, 5, 8, 9, 11, 14, 15, 16, 17, 21, 22, 23]);

export function parseEngine(bytes: Uint8Array): EngineImage {
  const r = new Reader(bytes);
  const magic = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
  for (const m of magic) if (r.u8() !== m) throw new EngineFormatError("not a wasm 1.0 binary");
  const sections: { id: number; name: string | null; start: number; end: number }[] = [];
  while (r.pos < bytes.length) {
    const id = r.u8();
    const size = r.uleb();
    const start = r.pos;
    let name: string | null = null;
    if (id === 0) name = new Reader(bytes, start, start + size).name();
    sections.push({ id, name, start, end: start + size });
    r.pos = start + size;
  }
  const sec = (id: number): { start: number; end: number } | undefined => sections.find((s) => s.id === id);
  const custom = (name: string): { start: number; end: number } | undefined =>
    sections.find((s) => s.id === 0 && s.name === name);
  for (const s of sections) {
    if (s.id === 8) throw new EngineFormatError("a start section (the engine is a reactor; _initialize is called explicitly)");
    if (s.id === 12) throw new EngineFormatError("a DataCount section (passive data is not spliced)");
    if (s.id === 13) throw new EngineFormatError("a tag section (the tier emits no EH)");
  }

  // Types: plain MVP function types only.
  const types: EngineFuncType[] = [];
  {
    const s = sec(1);
    if (s === undefined) throw new EngineFormatError("no type section");
    const t = new Reader(bytes, s.start, s.end);
    const n = t.uleb();
    for (let i = 0; i < n; i++) {
      const form = t.u8();
      if (form !== 0x60) throw new EngineFormatError(`type ${i} is not a plain function type (form 0x${form.toString(16)})`);
      const params: ValType[] = [];
      const np = t.uleb();
      for (let k = 0; k < np; k++) params.push(valType(t.u8()));
      const results: ValType[] = [];
      const nr = t.uleb();
      for (let k = 0; k < nr; k++) results.push(valType(t.u8()));
      types.push({ params, results });
    }
  }

  const imports: EngineImage["imports"] = [];
  {
    const s = sec(2);
    if (s !== undefined) {
      const t = new Reader(bytes, s.start, s.end);
      const n = t.uleb();
      for (let i = 0; i < n; i++) {
        const module = t.name();
        const name = t.name();
        const kind = t.u8();
        if (kind !== 0x00) throw new EngineFormatError(`import ${module}.${name} is not a function (kind ${kind})`);
        imports.push({ module, name, type: t.uleb() });
      }
    }
  }

  const funcTypes: number[] = [];
  {
    const s = sec(3);
    if (s === undefined) throw new EngineFormatError("no function section");
    const t = new Reader(bytes, s.start, s.end);
    const n = t.uleb();
    for (let i = 0; i < n; i++) funcTypes.push(t.uleb());
  }

  let tableMin = 0;
  let tableMax: number | null = null;
  {
    const s = sec(4);
    if (s === undefined) throw new EngineFormatError("no table section");
    const t = new Reader(bytes, s.start, s.end);
    if (t.uleb() !== 1) throw new EngineFormatError("more than one table");
    if (t.u8() !== 0x70) throw new EngineFormatError("table 0 is not a funcref table");
    const flags = t.u8();
    tableMin = t.uleb();
    if (flags === 0x01) tableMax = t.uleb();
    else if (flags !== 0x00) throw new EngineFormatError(`table limits flags ${flags}`);
  }

  let memoryMin = 0;
  {
    const s = sec(5);
    if (s === undefined) throw new EngineFormatError("no memory section");
    const t = new Reader(bytes, s.start, s.end);
    if (t.uleb() !== 1) throw new EngineFormatError("more than one memory");
    const flags = t.u8();
    if (flags !== 0x00) throw new EngineFormatError(`memory limits flags ${flags} (expected min-only, unshared)`);
    memoryMin = t.uleb();
  }

  const globals: EngineImage["globals"] = [];
  {
    const s = sec(6);
    if (s !== undefined) {
      const t = new Reader(bytes, s.start, s.end);
      const n = t.uleb();
      for (let i = 0; i < n; i++) {
        const type = valType(t.u8());
        const mut = t.u8();
        globals.push({ type, mutable: mut === 1, init: t.constExpr() });
      }
    }
  }

  const exports = new Map<string, number>();
  {
    const s = sec(7);
    if (s !== undefined) {
      const t = new Reader(bytes, s.start, s.end);
      const n = t.uleb();
      for (let i = 0; i < n; i++) {
        const name = t.name();
        const kind = t.u8();
        const idx = t.uleb();
        if (kind === 0x00) exports.set(name, idx);
      }
    }
  }

  let elemOffset: Uint8Array = new Uint8Array([0x41, 0x01]);
  const elemFuncs: number[] = [];
  {
    const s = sec(9);
    if (s === undefined) throw new EngineFormatError("no element section");
    const t = new Reader(bytes, s.start, s.end);
    if (t.uleb() !== 1) throw new EngineFormatError("more than one element segment");
    const flags = t.uleb();
    if (flags !== 0) throw new EngineFormatError(`element segment flags ${flags} (expected 0: active, table 0, funcref)`);
    elemOffset = t.constExpr();
    const n = t.uleb();
    for (let i = 0; i < n; i++) elemFuncs.push(t.uleb());
  }

  const dataSegments: Uint8Array[] = [];
  {
    const s = sec(11);
    if (s !== undefined) {
      const t = new Reader(bytes, s.start, s.end);
      const n = t.uleb();
      for (let i = 0; i < n; i++) {
        const start = t.pos;
        const flags = t.uleb();
        if (flags !== 0) throw new EngineFormatError(`data segment ${i} flags ${flags} (expected 0: active, memory 0)`);
        t.constExpr();
        const len = t.uleb();
        t.pos += len;
        dataSegments.push(bytes.slice(start, t.pos));
      }
    }
  }

  const codeSec = sec(10);
  if (codeSec === undefined) throw new EngineFormatError("no code section");
  const code = bytes.slice(codeSec.start, codeSec.end);
  const bodies: EngineImage["bodies"] = [];
  {
    const t = new Reader(code);
    const n = t.uleb();
    if (n !== funcTypes.length) throw new EngineFormatError(`code count ${n} != function count ${funcTypes.length}`);
    for (let i = 0; i < n; i++) {
      const start = t.pos;
      const size = t.uleb();
      t.pos += size;
      bodies.push({ start, end: t.pos });
    }
    if (t.pos !== code.length) throw new EngineFormatError("trailing bytes after the last function body");
  }

  // reloc.CODE: every index-space immediate, checked to be a 5-byte LEB.
  const relocs: EngineReloc[] = [];
  {
    const s = custom("reloc.CODE");
    if (s === undefined) throw new EngineFormatError("no reloc.CODE section (not linked with --emit-relocs?)");
    const t = new Reader(bytes, s.start, s.end);
    t.name();
    const target = t.uleb();
    const codeIndex = sections.indexOf(sections.find((x) => x.id === 10)!);
    if (target !== codeIndex) throw new EngineFormatError(`reloc.CODE targets section ${target}, not the code section (${codeIndex})`);
    const n = t.uleb();
    for (let i = 0; i < n; i++) {
      const type = t.u8();
      const offset = t.uleb();
      const index = t.uleb();
      if (WITH_ADDEND.has(type)) t.uleb();
      let space: EngineReloc["space"] | null = null;
      if (type === R_FUNCTION_INDEX_LEB) space = "func";
      else if (type === R_TYPE_INDEX_LEB) space = "type";
      else if (type === R_GLOBAL_INDEX_LEB) space = "global";
      else if (type === R_TABLE_NUMBER_LEB) space = "table";
      else if (!KEPT_CODE_RELOCS.has(type)) throw new EngineFormatError(`unknown code relocation type ${type}`);
      if (space === null) continue;
      // The relocated immediate must be EXACTLY a 5-byte padded LEB: the
      // in-place rewrite depends on it.
      for (let k = 0; k < 4; k++) {
        if ((code[offset + k]! & 0x80) === 0) {
          throw new EngineFormatError(`${space} index at code offset ${offset} is a ${k + 1}-byte LEB, not 5`);
        }
      }
      if ((code[offset + 4]! & 0x80) !== 0) throw new EngineFormatError(`${space} index at code offset ${offset} is longer than 5 bytes`);
      // The relocation's symbol index is not the wasm index (it names a
      // linking symbol); the wasm index is what the bytes encode.
      void index;
      relocs.push({ space, offset, index: readUleb5(code, offset) });
    }
  }

  // Function names (debug metadata, carried into the merged name section).
  const names = new Map<number, string>();
  {
    const s = custom("name");
    if (s !== undefined) {
      const t = new Reader(bytes, s.start, s.end);
      t.name();
      while (t.pos < s.end) {
        const sub = t.u8();
        const size = t.uleb();
        const end = t.pos + size;
        if (sub === 1) {
          const n = t.uleb();
          for (let i = 0; i < n; i++) {
            const idx = t.uleb();
            names.set(idx, t.name());
          }
        }
        t.pos = end;
      }
    }
  }

  return {
    types,
    imports,
    funcTypes,
    tableMin,
    tableMax,
    memoryMin,
    globals,
    exports,
    elemOffset,
    elemFuncs,
    code,
    bodies,
    relocs,
    dataSegments,
    names,
  };
}

function readUleb5(b: Uint8Array, at: number): number {
  let v = 0;
  for (let k = 0; k < 5; k++) v += (b[at + k]! & 0x7f) * 2 ** (7 * k);
  return v;
}

/** Overwrites a 5-byte padded ULEB in place. */
export function writeUleb5(b: Uint8Array, at: number, v: number): void {
  if (v < 0 || v >= 2 ** 32) throw new Error(`index ${v} does not fit a 5-byte LEB`);
  for (let k = 0; k < 5; k++) {
    const x = Math.floor(v / 2 ** (7 * k)) & 0x7f;
    b[at + k] = k < 4 ? x | 0x80 : x;
  }
}

let cached: EngineImage | null = null;
let pathOverride: string | null = null;

/** Tests only: load the artifact from another path (null restores the
 * checked-in one); drops every cache. */
export function setEngineArtifactPathForTests(path: string | null): void {
  pathOverride = path;
  cached = null;
  fencedCache = null;
}

/** The checked-in artifact's path. */
export function engineArtifactPath(): string {
  if (pathOverride !== null) return pathOverride;
  const require = createRequire(import.meta.url);
  return join(dirname(require.resolve("@tsinter/runtime/package.json")), "vendor", "quickjs-ng-wasm", "engine.wasm");
}

/** The parsed artifact, verified against its recorded sha256 once per
 * process. */
export function loadEngine(): EngineImage {
  if (cached !== null) return cached;
  const path = engineArtifactPath();
  const bytes = readFileSync(path);
  const want = readFileSync(`${path}.sha256`, "utf8").split(/\s+/)[0];
  const have = createHash("sha256").update(bytes).digest("hex");
  if (want !== have) {
    throw new EngineFormatError(`${path} does not match engine.wasm.sha256 (have ${have}, recorded ${want ?? "nothing"})`);
  }
  cached = parseEngine(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  return cached;
}
