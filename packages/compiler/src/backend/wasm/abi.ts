/* The .wasm artifact's embedding contract — the ONE list a host has to
 * satisfy, shared by the emitter (which mints the names into the binary)
 * and every host that instantiates one (the differential harness today,
 * `tsinter run` and embedders tomorrow). A name change here is an ABI
 * break for every host, so nothing else may spell these strings.
 *
 * The surface is deliberately minimal and WASI-shaped without being WASI:
 * console output is the only capability the tier needs yet, so the module
 * imports exactly one function and exports its entry plus the memory the
 * host reads output from.
 *
 *   (import "tsinter" "write" (func (param i32 i32 i32)))
 *     write(fd, ptr, len): the host writes len bytes at ptr from the
 *     exported memory to fd (1 = stdout, 2 = stderr), synchronously —
 *     the module reuses the staging region the moment the call returns.
 *
 *   (export "_start" (func))    — the program; run it once.
 *   (export "memory" (memory))  — where write's bytes live.
 */

export const IMPORT_MODULE = "tsinter";
export const IMPORT_WRITE = "write";
export const EXPORT_ENTRY = "_start";
export const EXPORT_MEMORY = "memory";

export const FD_STDOUT = 1;
export const FD_STDERR = 2;
