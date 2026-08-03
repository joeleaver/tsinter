/* Assembles one WebAssembly (GC) binary from declared parts: interned
 * types, imports, functions with bodies attached later, globals, a memory,
 * exports, and one shared passive data blob. The builder owns index-space
 * and section-order bookkeeping — the emitter above it thinks in names and
 * structure, never in offsets or section ids; the ByteWriter below it owns
 * the integer encodings. Opcode knowledge splits accordingly: the builder
 * knows the byte layout of DECLARATIONS (type/import/export entries, the
 * section framing), the emitter knows the bytes of INSTRUCTIONS.
 *
 * Two-phase functions: `declareFunc` reserves an index before any body
 * exists because bodies contain calls, and calls need the callee's index —
 * the emitter declares every function up front, then attaches bodies in a
 * second pass. `emit()` refuses a declared function with no body: that is
 * an emitter walk that silently skipped work, and validation would blame
 * a mismatched section count instead of the real bug.
 *
 * Type-section ordering: entries land in interning order, and a type can
 * only REFERENCE an earlier entry (each entry here is its own implicit
 * singleton rec group — the backend declares no subtyping and no mutual
 * recursion). Call order enforces this for free: building a ref valtype
 * requires the referenced type's index, so the referent is always interned
 * first. */
import { ByteWriter } from "./bytes.js";

export type ValType =
  | { kind: "i32" }
  | { kind: "i64" }
  | { kind: "f64" }
  | { kind: "ref"; nullable: boolean; typeIndex: number };

export const I32: ValType = { kind: "i32" };
/** No IR value maps to i64 — it exists for the emitted runtime helpers'
 * double-bit manipulation locals (toInt32, fmod). */
export const I64: ValType = { kind: "i64" };
export const F64: ValType = { kind: "f64" };

/** Array element storage: a packed byte/code-unit or a full valtype. i16
 * is what strings use (UTF-16 code units — SEMANTICS.md S002), i8 the
 * output staging path; the valtype arm is ready for ref-element arrays. */
export type StorageType = "i8" | "i16" | ValType;

function writeValType(w: ByteWriter, t: ValType): void {
  switch (t.kind) {
    case "i32":
      w.u8(0x7f);
      break;
    case "i64":
      w.u8(0x7e);
      break;
    case "f64":
      w.u8(0x7c);
      break;
    case "ref":
      w.u8(t.nullable ? 0x63 : 0x64);
      w.sleb(t.typeIndex); // heap type: a non-negative s33 type index
      break;
  }
}

function valTypeKey(t: ValType): string {
  return t.kind === "ref" ? `ref${t.nullable ? "?" : ""}:${t.typeIndex}` : t.kind;
}

function storageKey(s: StorageType): string {
  return s === "i8" || s === "i16" ? s : valTypeKey(s);
}

function writeStorage(w: ByteWriter, s: StorageType): void {
  if (s === "i8") w.u8(0x78);
  else if (s === "i16") w.u8(0x77);
  else writeValType(w, s);
}

/** One struct field: storage plus mutability, exactly the binary
 * fieldtype. */
export interface FieldType {
  storage: StorageType;
  mutable: boolean;
}

/** Subtype declaration: supertypes plus finality. Absent = the plain
 * shorthand (final, no supertypes). */
export interface SubInfo {
  supers: number[];
  final: boolean;
}

export type TypeShape =
  | { kind: "func"; params: ValType[]; results: ValType[] }
  | { kind: "array"; elem: StorageType; mutable: boolean }
  | { kind: "struct"; fields: FieldType[] };

type TypeEntry = TypeShape & { sub?: SubInfo };

interface FuncDecl {
  typeIndex: number;
  name: string;
  body: { locals: ValType[]; code: Uint8Array } | null;
}

type ExportEntry = { name: string; desc: "func" | "memory"; index: number };

export class ModuleBuilder {
  private types: TypeEntry[] = [];
  private typeIndex = new Map<string, number>();
  private imports: { module: string; name: string; typeIndex: number }[] = [];
  private funcs: FuncDecl[] = [];
  private globals: { type: ValType; mutable: boolean; init: (w: ByteWriter) => void }[] = [];
  private exports: ExportEntry[] = [];
  private memoryPages: number | null = null;
  /** Rec-group starts: type index → member count. */
  private readonly recStarts = new Map<number, number>();
  /** Functions needing ref.func (the declarative element segment). */
  private readonly funcRefs = new Set<number>();
  private blob: number[] = [];
  private blobIndex = new Map<string, number>();
  /** internData was called at all — tracked separately from blob length
   * because interning ONLY the empty string still emits array.new_data
   * against segment 0, which must then exist (empty is fine, absent is a
   * validation error). */
  private blobUsed = false;

  funcType(params: ValType[], results: ValType[]): number {
    const key = `f:${params.map(valTypeKey).join(",")}->${results.map(valTypeKey).join(",")}`;
    return this.internType(key, { kind: "func", params, results });
  }

  arrayType(elem: StorageType, mutable: boolean): number {
    const key = `a:${storageKey(elem)}:${mutable ? "m" : "c"}`;
    return this.internType(key, { kind: "array", elem, mutable });
  }

  structType(fields: FieldType[]): number {
    const key = `s:${fields.map((f) => `${storageKey(f.storage)}:${f.mutable ? "m" : "c"}`).join(",")}`;
    return this.internType(key, { kind: "struct", fields });
  }

  /** A struct SUBTYPE of `superIdx` (width subtyping — the closure envs).
   * Not interned by shape: two different capture sets may share a field
   * layout yet stay distinct declarations; callers key by meaning. */
  subStructType(key: string, fields: FieldType[], superIdx: number): number {
    const existing = this.typeIndex.get(key);
    if (existing !== undefined) return existing;
    const index = this.types.length;
    this.types.push({ kind: "struct", fields, sub: { supers: [superIdx], final: true } });
    this.typeIndex.set(key, index);
    return index;
  }

  /** A keyed OPEN struct — non-final with no supertype, the root other
   * declarations subtype (the union base). Keyed by meaning like
   * subStructType, never by shape. */
  openStructType(key: string, fields: FieldType[]): number {
    const existing = this.typeIndex.get(key);
    if (existing !== undefined) return existing;
    const index = this.types.length;
    this.types.push({ kind: "struct", fields, sub: { supers: [], final: false } });
    this.typeIndex.set(key, index);
    return index;
  }

  /** A TWO-entry recursive group (the closure-struct/function-type pair):
   * `make` receives the base index — the entries land at base and
   * base+1 and may reference each other. Interned by the caller's key. */
  recGroup2(key: string, make: (base: number) => [TypeEntry, TypeEntry]): number {
    const existing = this.typeIndex.get(key);
    if (existing !== undefined) return existing;
    const base = this.types.length;
    const [a, b] = make(base);
    this.types.push(a, b);
    this.recStarts.set(base, 2);
    this.typeIndex.set(key, base);
    return base;
  }

  /** Marks a function as ref.func-referenced — the declarative element
   * segment validation requires. */
  declareFuncRef(funcIndex: number): void {
    this.funcRefs.add(funcIndex);
  }

  private internType(key: string, entry: TypeEntry): number {
    const existing = this.typeIndex.get(key);
    if (existing !== undefined) return existing;
    const index = this.types.length;
    this.types.push(entry);
    this.typeIndex.set(key, index);
    return index;
  }

  /** Imported functions occupy the FRONT of the function index space, so
   * every import must be declared before the first defined function. */
  importFunc(module: string, name: string, typeIndex: number): number {
    if (this.funcs.length > 0) {
      throw new Error("imports must be declared before defined functions");
    }
    this.imports.push({ module, name, typeIndex });
    return this.imports.length - 1;
  }

  /** Reserves a function index; the body arrives via `setBody`. `name`
   * feeds the name custom section (trap stacks name the real function
   * instead of wasm-function[i]) — it is debug metadata, not linkage. */
  declareFunc(typeIndex: number, name: string): number {
    this.funcs.push({ typeIndex, name, body: null });
    return this.imports.length + this.funcs.length - 1;
  }

  setBody(funcIndex: number, locals: ValType[], code: Uint8Array): void {
    const decl = this.funcs[funcIndex - this.imports.length];
    if (decl === undefined) throw new Error(`setBody on undeclared function index ${funcIndex}`);
    decl.body = { locals, code };
  }

  addGlobal(type: ValType, mutable: boolean, init: (w: ByteWriter) => void): number {
    this.globals.push({ type, mutable, init });
    return this.globals.length - 1;
  }

  /** Idempotent: the memory exists once anything needs it, sized to the
   * largest minimum any caller asked for. */
  ensureMemory(minPages: number): void {
    this.memoryPages = Math.max(this.memoryPages ?? 0, minPages);
  }

  exportFunc(name: string, funcIndex: number): void {
    this.exports.push({ name, desc: "func", index: funcIndex });
  }

  exportMemory(name: string): void {
    if (this.memoryPages === null) throw new Error("exportMemory before ensureMemory");
    this.exports.push({ name, desc: "memory", index: 0 });
  }

  /** Interns bytes into the module's single passive data blob (segment 0)
   * and returns their offset. Exact-match dedup: every strLit evaluation
   * site shares one copy of its literal. */
  internData(bytes: Uint8Array): number {
    this.blobUsed = true;
    const key = Array.from(bytes, (b) => String.fromCharCode(b)).join("");
    const existing = this.blobIndex.get(key);
    if (existing !== undefined) return existing;
    const offset = this.blob.length;
    for (const b of bytes) this.blob.push(b);
    this.blobIndex.set(key, offset);
    return offset;
  }

  emit(): Uint8Array {
    const w = new ByteWriter();
    w.raw(new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]));

    if (this.types.length > 0) {
      const writeComptype = (s: ByteWriter, t: TypeEntry): void => {
        if (t.kind === "func") {
          s.u8(0x60);
          s.uleb(t.params.length);
          for (const p of t.params) writeValType(s, p);
          s.uleb(t.results.length);
          for (const r of t.results) writeValType(s, r);
        } else if (t.kind === "array") {
          s.u8(0x5e); // array comptype: fieldtype = storage + mutability
          writeStorage(s, t.elem);
          s.u8(t.mutable ? 0x01 : 0x00);
        } else {
          s.u8(0x5f); // struct comptype: vec of fieldtypes
          s.uleb(t.fields.length);
          for (const f of t.fields) {
            writeStorage(s, f.storage);
            s.u8(f.mutable ? 0x01 : 0x00);
          }
        }
      };
      const writeSubtype = (s: ByteWriter, t: TypeEntry): void => {
        if (t.sub !== undefined) {
          s.u8(t.sub.final ? 0x4f : 0x50);
          s.uleb(t.sub.supers.length);
          for (const sup of t.sub.supers) s.uleb(sup);
        }
        writeComptype(s, t);
      };
      // Rec groups count as ONE type-section entry each.
      let entryCount = 0;
      for (let i = 0; i < this.types.length; ) {
        const size = this.recStarts.get(i);
        entryCount++;
        i += size ?? 1;
      }
      w.section(1, (s) => {
        s.uleb(entryCount);
        for (let i = 0; i < this.types.length; ) {
          const size = this.recStarts.get(i);
          if (size !== undefined) {
            s.u8(0x4e);
            s.uleb(size);
            for (let k = 0; k < size; k++) writeSubtype(s, this.types[i + k]!);
            i += size;
          } else {
            writeSubtype(s, this.types[i]!);
            i += 1;
          }
        }
      });
    }

    if (this.imports.length > 0) {
      w.section(2, (s) => {
        s.uleb(this.imports.length);
        for (const imp of this.imports) {
          s.name(imp.module);
          s.name(imp.name);
          s.u8(0x00); // func import
          s.uleb(imp.typeIndex);
        }
      });
    }

    if (this.funcs.length > 0) {
      w.section(3, (s) => {
        s.uleb(this.funcs.length);
        for (const f of this.funcs) s.uleb(f.typeIndex);
      });
    }

    if (this.memoryPages !== null) {
      const pages = this.memoryPages;
      w.section(5, (s) => {
        s.uleb(1);
        s.u8(0x00); // min only, no max
        s.uleb(pages);
      });
    }

    if (this.globals.length > 0) {
      w.section(6, (s) => {
        s.uleb(this.globals.length);
        for (const g of this.globals) {
          writeValType(s, g.type);
          s.u8(g.mutable ? 0x01 : 0x00);
          g.init(s);
          s.u8(0x0b);
        }
      });
    }

    if (this.exports.length > 0) {
      w.section(7, (s) => {
        s.uleb(this.exports.length);
        for (const e of this.exports) {
          s.name(e.name);
          s.u8(e.desc === "func" ? 0x00 : 0x02);
          s.uleb(e.index);
        }
      });
    }

    // Declarative element segment: every ref.func target must be
    // pre-declared here or the instruction fails validation.
    if (this.funcRefs.size > 0) {
      const refs = [...this.funcRefs].sort((a, b) => a - b);
      w.section(9, (s) => {
        s.uleb(1);
        s.u8(0x03); // declarative, elemkind + funcidx vec
        s.u8(0x00);
        s.uleb(refs.length);
        for (const f of refs) s.uleb(f);
      });
    }

    // DataCount precedes code whenever data exists: array.new_data inside a
    // body validates against the declared segment count.
    if (this.blobUsed) w.section(12, (s) => s.uleb(1));

    if (this.funcs.length > 0) {
      w.section(10, (s) => {
        s.uleb(this.funcs.length);
        for (const f of this.funcs) {
          const body = f.body;
          if (body === null) {
            throw new Error(`function "${f.name}" was declared but never given a body`);
          }
          s.framed((entry) => {
            // Locals compress into (count, type) runs, per the format.
            const runs: { count: number; type: ValType }[] = [];
            for (const l of body.locals) {
              const last = runs[runs.length - 1];
              if (last !== undefined && valTypeKey(last.type) === valTypeKey(l)) last.count++;
              else runs.push({ count: 1, type: l });
            }
            entry.uleb(runs.length);
            for (const r of runs) {
              entry.uleb(r.count);
              writeValType(entry, r.type);
            }
            entry.raw(body.code);
            entry.u8(0x0b);
          });
        }
      });
    }

    if (this.blobUsed) {
      const blob = this.blob;
      w.section(11, (s) => {
        s.uleb(1);
        s.u8(0x01); // passive
        s.uleb(blob.length);
        s.raw(new Uint8Array(blob));
      });
    }

    // Name custom section (function names only): debug metadata so a trap's
    // stack names %init.0 instead of wasm-function[3].
    w.section(0, (s) => {
      s.name("name");
      s.u8(0x01); // function-names subsection
      s.framed((sub) => {
        sub.uleb(this.funcs.length);
        this.funcs.forEach((f, i) => {
          sub.uleb(this.imports.length + i);
          sub.name(f.name);
        });
      });
    });

    return w.bytes();
  }
}
