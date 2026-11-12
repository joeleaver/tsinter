/* The fetch init type names a project's own tsc gets from lib.dom: a
 * tsconfig with no `lib` (paperclip's: target ES2023, types ["node"])
 * defaults to the target's FULL lib, DOM included, so `BodyInit` and
 * `HeadersInit` resolve there. scriptc's programs pin the es2025 floor
 * plus the project's listed non-ES libs (SEMANTICS.md S130), so this file
 * declares them, and joins the program (the lowering world AND preflight's
 * project world, which pins the same lib) only when that lib has no DOM
 * entry (loadProgram, libIncludesDom): an adopted dom keeps lib.dom's own
 * names, with no duplicate identifier.
 *
 * Both are the members of the program's OWN RequestInit, so a project's
 * `f(init.headers)` into a `HeadersInit` parameter keeps typechecking
 * (under its own tsc, lib.dom's RequestInit and HeadersInit agree; here
 * the RequestInit is undici's under @types/node, the fallback's slice
 * without it, and lib.dom's spelling would reject undici's HeaderRecord:
 * paperclip's http.ts). Type-only names; nothing lowers differently. */
type BodyInit = NonNullable<RequestInit["body"]>;
type HeadersInit = NonNullable<RequestInit["headers"]>;
