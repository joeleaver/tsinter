/* Test helper: bytecode from the one regex compiler (regex-compiler.ts, run
 * in-process by regex-buildtime.ts) — what the interpreter tests feed
 * exec(). Flags may be the RegExp flags text or the per-flag booleans the
 * retired TypeScript assembler took. */
import { compileRegex } from "../src/backend/wasm/regex-buildtime.js";

export interface RegexFlags {
  global: boolean;
  ignoreCase: boolean;
  multiLine: boolean;
  dotAll: boolean;
  unicode: boolean;
  sticky: boolean;
}

export function flagText(f: Partial<RegexFlags>): string {
  return (f.global ? "g" : "") + (f.ignoreCase ? "i" : "") + (f.multiLine ? "m" : "") + (f.dotAll ? "s" : "") + (f.unicode ? "u" : "") + (f.sticky ? "y" : "");
}

export interface Compiled {
  bytes: Uint8Array;
  captureCount: number;
  groupNames: string[] | null;
  source: string;
  flags: string;
}

/** The compiled regex; throws when the compiler rejects or fences it. */
export function compiled(pattern: string, flags: string | Partial<RegexFlags>): Compiled {
  const text = typeof flags === "string" ? flags : flagText(flags);
  const r = compileRegex(pattern, text);
  if (r.kind !== "ok") throw new Error(`regex-compile: /${pattern}/${text} did not compile: ${JSON.stringify(r)}`);
  return r;
}

/** Whether the compiler builds the pattern (no SyntaxError, no fence). */
export function compiles(pattern: string, flags: string | Partial<RegexFlags>): boolean {
  return compileRegex(pattern, typeof flags === "string" ? flags : flagText(flags)).kind === "ok";
}
