/* The wasm backend's refusal: an IR construct outside the current tier.
 * `kind` is a stable machine-readable tag ("stmt:switch", "expr:closure",
 * "global:string", "libCall:console.log", ...) — the differential harness
 * histograms the next increment's queue from it. Its OWN kind namespace,
 * disjoint from the LLVM backend's: the two tiers grow independently and
 * their histograms are never comparable, so nothing should ever join them.
 * Never catch-and-continue: any refusal aborts the whole module.
 *
 * Unlike the LLVM refusal there is no fallback lane to catch this. The
 * wasm backend is an EXPLICIT pin only (a .wasm module is not a native
 * executable — there is nothing for the C backend to stand in for), so
 * compile() surfaces every refusal as diagnostic SC3001 unconditionally.
 * Its own module so the emitter and the shape tables to come can both
 * throw it without an import cycle. */
import type { SrcLoc } from "../../ir/nodes.js";

export class WasmUnsupportedError extends Error {
  constructor(
    readonly kind: string,
    readonly loc?: SrcLoc,
  ) {
    super(
      `the wasm backend does not support this construct yet (${kind}); ` +
        `build with the LLVM backend (the default) or the reference C backend (--backend c)`,
    );
    this.name = "WasmUnsupportedError";
  }
}
