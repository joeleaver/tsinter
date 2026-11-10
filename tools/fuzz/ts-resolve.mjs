/* A resolve hook so plain Node (with --experimental-transform-types) can
 * load the repo's test-host .ts files, which import siblings as `./x.js`.
 * Loaded with `node --import ./tools/fuzz/ts-resolve.mjs`.
 *
 * The shared test host (packages/compiler/test/wasm-host.ts) imports
 * `expect` from vitest for one assertion; outside the vitest runner that
 * import throws, so it resolves to vitest-stub.mjs instead. */
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "vitest") return next(new URL("./vitest-stub.mjs", import.meta.url).href, context);
    if (specifier.endsWith(".js") && (specifier.startsWith(".") || specifier.startsWith("/")) && context.parentURL?.startsWith("file:")) {
      const url = new URL(specifier, context.parentURL);
      const p = fileURLToPath(url);
      if (!existsSync(p) && existsSync(p.slice(0, -3) + ".ts")) {
        return next(url.href.slice(0, -3) + ".ts", context);
      }
    }
    return next(specifier, context);
  },
});
