/* The benchmark set's wasm host: the smallest host contract (abi.ts) a
 * pure-compute benchmark module needs — `tsinter.write` — with no Node
 * API in it, so the same file serves a browser page. A module importing
 * anything else is not a pure-compute benchmark: instantiate() refuses it,
 * naming the imports (such a program is marked node-only in the manifest).
 *
 *   const { run } = await import("./wasm-host.mjs");
 *   const { exitCode } = await run(bytes, (fd, u8) => ...);
 *
 * Exit: 0, or 1 for a trap (the wasm lane's outcome for an uncaught
 * error); `_status` answers for a top-level-await module. */
const SUPPORTED = new Set(["write"]);

export async function run(bytes, write) {
  const mod = await WebAssembly.compile(bytes);
  const extra = WebAssembly.Module.imports(mod).filter((i) => i.module !== "tsinter" || !SUPPORTED.has(i.name));
  if (extra.length > 0) throw new Error(`bench wasm host: the module imports ${extra.map((i) => `${i.module}.${i.name}`).join(", ")} — not a pure-compute benchmark`);
  let memory = null;
  const inst = await WebAssembly.instantiate(mod, {
    tsinter: {
      write(fd, ptr, len) {
        write(fd, new Uint8Array(memory.buffer, ptr, len).slice());
      },
    },
  });
  memory = inst.exports.memory;
  try {
    inst.exports._start();
    // an event-loop module: pump _loop on a real clock (pure compute
    // benchmarks have no timers, so this ends at once)
    if (typeof inst.exports._loop === "function") {
      const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
      for (let due = inst.exports._loop(now()); due >= 0; due = inst.exports._loop(now())) {
        const wait = due - now();
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      }
    }
    return { exitCode: typeof inst.exports._status === "function" ? inst.exports._status() : 0 };
  } catch (e) {
    if (e instanceof WebAssembly.RuntimeError || e instanceof RangeError) {
      write(2, new TextEncoder().encode(`${e.name}: ${e.message}\n`));
      return { exitCode: 1 };
    }
    throw e;
  }
}
