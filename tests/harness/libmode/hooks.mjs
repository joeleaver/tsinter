/* Module hooks for the node column (loader.mjs registers them). */
import { createHost } from "./host.mjs";

let hosts = [];
const names = Object.keys(createHost(() => {}, () => null).table);

export function initialize(data) {
  hosts = data.hosts;
}

export async function resolve(specifier, context, next) {
  if (specifier === "tsinter:memory") return { url: "libmem:", shortCircuit: true };
  if (hosts.includes(specifier)) return { url: `libhost:${specifier}`, shortCircuit: true };
  return next(specifier, context);
}

export async function load(url, context, next) {
  if (url === "libmem:") {
    return { format: "module", source: "export const mem = globalThis.__libmem.mem;\n", shortCircuit: true };
  }
  if (url.startsWith("libhost:")) {
    const mod = url.slice("libhost:".length);
    const source =
      "const h = globalThis.__libhost;\n" +
      names.map((n) => `export const ${n} = h.bind(${JSON.stringify(mod)}, ${JSON.stringify(n)});`).join("\n") +
      "\n";
    return { format: "module", source, shortCircuit: true };
  }
  return next(url, context);
}
