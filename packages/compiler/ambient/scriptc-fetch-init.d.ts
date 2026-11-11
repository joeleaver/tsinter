/* scriptc's lowering-program declarations of lib.dom's fetch init names.
 * Loaded only when the program has no lib.dom (a project that lists `dom`
 * in its tsconfig `lib` gets lib.dom's own, SEMANTICS.md S130). */

/* The fetch init type names a project's own tsc gets from lib.dom: a
 * tsconfig with no `lib` (paperclip's: target ES2023, types ["node"])
 * defaults to the target's FULL lib, DOM included, so `BodyInit` and
 * `HeadersInit` resolve there. scriptc's lowering program pins lib.es2025
 * (no DOM), so they are declared here. HeadersInit is lib.dom's own
 * definition (Headers is declared in every world). BodyInit is the body
 * member of the program's own RequestInit (lib.dom's names Blob, FormData
 * and ReadableStream, which only @types/node declares): undici's BodyInit
 * under @types/node, the fallback's slice without it. Type-only names;
 * nothing lowers differently. Here rather than in scriptc.d.ts because
 * preflight's project world may load lib.dom, where these would collide; and
 * not at all when the adopted lib includes dom (program.ts). */
type BodyInit = NonNullable<RequestInit["body"]>;
type HeadersInit = [string, string][] | Record<string, string> | Headers;
