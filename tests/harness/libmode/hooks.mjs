/* Module hooks for the node column (loader.mjs registers them). */
import { createHost } from "./host.mjs";

let hosts = [];
const names = Object.keys(createHost(() => {}, () => null).table);

export function initialize(data) {
  hosts = data.hosts;
}

export async function resolve(specifier, context, next) {
  if (hosts.includes(specifier)) return { url: `libhost:${specifier}`, shortCircuit: true };
  return next(specifier, context);
}

export async function load(url, context, next) {
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
