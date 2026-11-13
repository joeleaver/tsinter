/* Library mode on the WasmGC lane: the profile, format 2
 * (docs/design/wasm-library-mode.md §2.1, Joe's ruling 2 of §9.2a).
 *
 * The profile is OPTIONAL and engine-generated (script authors never see
 * it). Its type vocabulary is WIT's, one to one, so an engine can project it
 * from the same table that projects its .d.ts and its WIT world. Without a
 * profile, every `export function` of the entry is exported, every ambient
 * module the program declares is a host import module, number crosses as
 * f64, bigint as s64 and boolean as bool.
 *
 *   {
 *     "profile_format": 2,
 *     "emission": "wasm",
 *     "name": "playweft",                         // optional, for messages
 *     "report": { "module": "pw", "name": "log", "prefix": "E " },
 *                                     // the failure sink: an import taking
 *                                     // (string) or (u32 code, string); the
 *                                     // text is prefix + the failure's line
 *     "alloc": "pw_alloc",                        // synthesized export (P2)
 *     "max_import_params": 8,                     // wasm-level arity cap (P2)
 *     "max_depth": 2000,                          // SEMANTICS.md S142
 *     "exports": { "pw_run": { "params": [["sys", "u32"], ["tick", "u64"], ["dt", "f64"]] } },
 *     "imports": { "pw": { "rand_u64": { "params": [], "result": "u64", "role": "random" } } }
 *   }
 */
import { readFileSync } from "node:fs";
import type { ScrDiagnostic } from "../diagnostics/diagnostic.js";

/** The scalar classes (one wasm value each). */
export const SCALAR_CLASSES = ["bool", "s8", "u8", "s16", "u16", "s32", "u32", "s64", "u64", "f32", "f64"] as const;
/** The pointer classes (a (ptr, len) pair; design §3.2). */
export const POINTER_CLASSES = ["string", "list<u8>", "list<s32>", "list<u32>", "list<f32>", "list<f64>"] as const;
export type WasmLibClass = (typeof SCALAR_CLASSES)[number] | (typeof POINTER_CLASSES)[number];

export function isWasmLibClass(s: unknown): s is WasmLibClass {
  return typeof s === "string" && ((SCALAR_CLASSES as readonly string[]).includes(s) || (POINTER_CLASSES as readonly string[]).includes(s));
}
export function isPointerClass(c: WasmLibClass): boolean {
  return (POINTER_CLASSES as readonly string[]).includes(c);
}

export interface WasmLibSig {
  params: { name: string; cls: WasmLibClass }[];
  result: WasmLibClass | null;
}

export interface WasmLibProfile {
  path: string;
  name: string;
  report: { module: string; name: string; prefix: string } | null;
  alloc: string | null;
  maxImportParams: number | null;
  maxDepth: number | null;
  exports: Map<string, WasmLibSig>;
  imports: Map<string, Map<string, WasmLibSig & { role: "random" | null }>>;
}

/** SEMANTICS.md S142's default: below the weakest engine column the stack
 * probe measured (docs/design/wasm-library-mode.md §10 w6). */
export const DEFAULT_MAX_DEPTH = 2000;

export function wasmProfileDiag(path: string, detail: string): ScrDiagnostic {
  return {
    code: "SC4027",
    message: `library profile invalid: ${detail}`,
    loc: { file: path, start: 0, end: 0 },
    hint: "a format-2 profile is engine-generated JSON (docs/design/wasm-library-mode.md §2.1); its classes are WIT's: bool s8 u8 s16 u16 s32 u32 s64 u64 f32 f64 string list<u8|s32|u32|f32|f64>",
  };
}

const NAME = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export function loadWasmProfile(path: string): { ok: true; profile: WasmLibProfile } | { ok: false; diagnostics: ScrDiagnostic[] } {
  const bad = (detail: string) => ({ ok: false as const, diagnostics: [wasmProfileDiag(path, detail)] });
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    return bad(`cannot read it as JSON (${(e as Error).message})`);
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return bad("the top level must be an object");
  const o = raw as Record<string, unknown>;
  const known = new Set(["profile_format", "emission", "name", "report", "alloc", "max_import_params", "max_depth", "exports", "imports"]);
  for (const k of Object.keys(o)) if (!known.has(k)) return bad(`unknown key '${k}'`);
  if (o["profile_format"] !== 2) return bad("'profile_format' must be 2");
  if (o["emission"] !== "wasm") return bad("'emission' must be \"wasm\"");
  if (o["name"] !== undefined && typeof o["name"] !== "string") return bad("'name' must be a string");
  const posInt = (k: string): number | null | string => {
    const v = o[k];
    if (v === undefined) return null;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 1_000_000) return `'${k}' must be a positive integer`;
    return v;
  };
  const maxImportParams = posInt("max_import_params");
  if (typeof maxImportParams === "string") return bad(maxImportParams);
  const maxDepth = posInt("max_depth");
  if (typeof maxDepth === "string") return bad(maxDepth);
  let alloc: string | null = null;
  if (o["alloc"] !== undefined) {
    if (typeof o["alloc"] !== "string" || !NAME.test(o["alloc"])) return bad("'alloc' must be an export name");
    alloc = o["alloc"];
  }
  const sig = (where: string, v: unknown, allowRole: boolean): (WasmLibSig & { role: "random" | null }) | string => {
    if (v === null || typeof v !== "object" || Array.isArray(v)) return `${where} must be an object`;
    const e = v as Record<string, unknown>;
    for (const k of Object.keys(e)) if (k !== "params" && k !== "result" && !(allowRole && k === "role")) return `${where} has an unknown key '${k}'`;
    if (!Array.isArray(e["params"])) return `${where}.params must be an array of [name, class] pairs`;
    const params: WasmLibSig["params"] = [];
    for (const p of e["params"] as unknown[]) {
      if (!Array.isArray(p) || p.length !== 2 || typeof p[0] !== "string") return `${where}.params must be an array of [name, class] pairs`;
      if (!isWasmLibClass(p[1])) return `${where}.params: '${String(p[1])}' is not a class`;
      params.push({ name: p[0], cls: p[1] });
    }
    let result: WasmLibClass | null = null;
    if (e["result"] !== undefined) {
      if (!isWasmLibClass(e["result"])) return `${where}.result: '${String(e["result"])}' is not a class`;
      result = e["result"];
    }
    let role: "random" | null = null;
    if (e["role"] !== undefined) {
      if (e["role"] !== "random") return `${where}.role must be "random"`;
      if (params.length !== 0 || (result !== "u64" && result !== "s64")) return `${where}: a role:"random" import takes no parameters and returns u64`;
      role = "random";
    }
    return { params, result, role };
  };
  const exports = new Map<string, WasmLibSig>();
  if (o["exports"] !== undefined) {
    if (o["exports"] === null || typeof o["exports"] !== "object" || Array.isArray(o["exports"])) return bad("'exports' must be an object");
    for (const [n, v] of Object.entries(o["exports"] as object)) {
      if (!NAME.test(n)) return bad(`export '${n}' is not a valid name`);
      const s = sig(`exports.${n}`, v, false);
      if (typeof s === "string") return bad(s);
      exports.set(n, { params: s.params, result: s.result });
    }
  }
  const imports = new Map<string, Map<string, WasmLibSig & { role: "random" | null }>>();
  if (o["imports"] !== undefined) {
    if (o["imports"] === null || typeof o["imports"] !== "object" || Array.isArray(o["imports"])) return bad("'imports' must be an object");
    for (const [m, fns] of Object.entries(o["imports"] as object)) {
      if (m === "" || m === "tsinter" || m.startsWith("node:") || m.startsWith("tsinter:")) return bad(`'${m}' cannot be a host import module`);
      if (fns === null || typeof fns !== "object" || Array.isArray(fns)) return bad(`imports.${m} must be an object`);
      const table = new Map<string, WasmLibSig & { role: "random" | null }>();
      for (const [n, v] of Object.entries(fns as object)) {
        if (!NAME.test(n)) return bad(`import '${m}.${n}' is not a valid name`);
        const s = sig(`imports.${m}.${n}`, v, true);
        if (typeof s === "string") return bad(s);
        table.set(n, s);
      }
      imports.set(m, table);
    }
  }
  const randoms = [...imports.values()].flatMap((t) => [...t.values()].filter((s) => s.role === "random"));
  if (randoms.length > 1) return bad('at most one import may have role "random"');
  let report: WasmLibProfile["report"] = null;
  if (o["report"] !== undefined) {
    const r = o["report"] as Record<string, unknown>;
    if (
      r === null || typeof r !== "object" || typeof r["module"] !== "string" || typeof r["name"] !== "string" ||
      (r["prefix"] !== undefined && typeof r["prefix"] !== "string") ||
      Object.keys(r).some((k) => k !== "module" && k !== "name" && k !== "prefix")
    ) {
      return bad("'report' must be { \"module\": ..., \"name\": ..., \"prefix\"?: ... }");
    }
    const s = imports.get(r["module"])?.get(r["name"]);
    if (s === undefined) return bad(`'report' names ${r["module"]}.${r["name"]}, which 'imports' does not declare`);
    const shape = s.params.map((p) => p.cls).join(",");
    if (s.result !== null || (shape !== "string" && shape !== "u32,string")) {
      return bad(`the report import ${r["module"]}.${r["name"]} must take (string) or (u32, string) and return nothing`);
    }
    const prefix = (r["prefix"] as string | undefined) ?? "";
    if (new TextEncoder().encode(prefix).length > 256) return bad("'report.prefix' is longer than 256 bytes of UTF-8");
    report = { module: r["module"], name: r["name"], prefix };
  }
  if (alloc !== null && exports.has(alloc)) return bad(`'alloc' names ${alloc}, which is also a TypeScript export in 'exports'`);
  return {
    ok: true,
    profile: {
      path,
      name: typeof o["name"] === "string" ? o["name"] : "profile",
      report,
      alloc,
      maxImportParams,
      maxDepth,
      exports,
      imports,
    },
  };
}
