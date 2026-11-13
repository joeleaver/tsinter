/* Library mode on the WasmGC lane, frontend side: which module specifiers
 * are HOST modules (their functions become wasm imports), and the host
 * functions the lowering resolved, with their classes.
 *
 * One build sets the state (setLibHost) for the duration of its frontend
 * run; index.ts clears it in a finally. Outside library mode it is null and
 * nothing here runs (the provenance-registry precedent).
 *
 * Host modules:
 *   - with a profile: exactly the profile's `imports` keys;
 *   - without: every ambient `declare module "<name>"` with an exact name
 *     in the program's own declaration files (not node_modules, not the
 *     compiler's bundled declarations), that is not a Node builtin. */
import { dirname } from "node:path";
import * as ts from "./ts7/adapter.js";
import { ambientDtsPath } from "./shared.js";
import type { IrWasmLib, IrWasmLibClass } from "../ir/nodes.js";
import type { WasmLibProfile } from "../library/wasm-profile.js";

export type HostImport = IrWasmLib["imports"][number];

export class LibHostState {
  /** Host functions in first-resolution order (profile-less builds), keyed
   * "module.name". */
  readonly used = new Map<string, HostImport>();
  private declared: Set<string> | null = null;

  constructor(readonly profile: WasmLibProfile | null) {}

  /** Is `spec` a host module? `program` supplies the ambient declarations
   * for a profile-less build. */
  isHostModule(spec: string, program: ts.Program | null): boolean {
    if (this.profile !== null) return this.profile.imports.has(spec);
    if (spec.startsWith("node:") || spec.startsWith("tsinter:")) return false;
    if (this.declared === null) {
      if (program === null) return false;
      this.declared = declaredHostModules(program);
    }
    return this.declared.has(spec);
  }

  /** Every host import a build may call, in a stable order: the profile's
   * in declaration order, else the ones the lowering resolved. */
  imports(): HostImport[] {
    if (this.profile === null) return [...this.used.values()];
    const out: HostImport[] = [];
    for (const [module, fns] of this.profile.imports) {
      for (const [name, sig] of fns) {
        out.push({ module, name, params: sig.params.map((p) => p.cls as IrWasmLibClass), result: sig.result as IrWasmLibClass | null, role: sig.role });
      }
    }
    return out;
  }
}

/** packages/compiler/ (the ambient dir's parent), slash-normalized. */
const compilerRoot = dirname(dirname(ambientDtsPath())).replace(/\\/g, "/") + "/";

/** Exact-name ambient module declarations in the program's own .d.ts files. */
function declaredHostModules(program: ts.Program): Set<string> {
  const out = new Set<string>();
  for (const sf of program.getSourceFiles()) {
    if (!sf.isDeclarationFile) continue;
    const f = sf.fileName.replace(/\\/g, "/");
    // The compiler's own declarations (its ambient dir: the Node fallback
    // and overrides), @types and every other package, the default libs.
    if (f.includes("/node_modules/") || f.startsWith(compilerRoot) || /\/lib\.[^/]*\.d\.ts$/.test(f)) continue;
    for (const s of sf.statements) {
      if (!ts.isModuleDeclaration(s) || !ts.isStringLiteral(s.name)) continue;
      const name = s.name.text;
      if (name.includes("*") || name.startsWith("node:") || name.startsWith("tsinter:")) continue;
      out.add(name);
    }
  }
  return out;
}

let current: LibHostState | null = null;

export function setLibHost(s: LibHostState | null): void {
  current = s;
}

export function libHost(): LibHostState | null {
  return current;
}
