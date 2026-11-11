/* paperclip step 2: workspace packages whose exports name TypeScript
 * source. paperclip's CLI imports its own monorepo members
 * (`@paperclipai/shared`, `@paperclipai/db`, the adapters) through pnpm's
 * node_modules symlinks, and each member's package.json exports
 * `./src/index.ts`. Node runs those very files (their realpath is outside
 * node_modules, so type stripping applies); they are the program's own
 * source, and they now compile as program modules instead of being
 * classified as npm packages bound for the embedded engine
 * (resolve.ts workspaceSourceEntry). Every row runs under Node and on both
 * WasmGC lanes. */
import { describe, test } from "vitest";
import { checkRow, type Row, scratchDir } from "./top10-paperclip-rows.js";

const scratch = scratchDir("pc-ws-source");

const MEMBER_PKG = JSON.stringify({
  name: "@demo/shared",
  version: "1.0.0",
  type: "module",
  exports: { ".": "./src/index.ts", "./*": "./src/*.ts" },
});
const WS = {
  "package.json": JSON.stringify({ name: "ws-root", private: true, type: "module" }),
  "packages/shared/package.json": MEMBER_PKG,
  "cli/package.json": JSON.stringify({ name: "demo-cli", type: "module", dependencies: { "@demo/shared": "workspace:*" } }),
};
const LINKS = { "cli/node_modules/@demo/shared": "../../../packages/shared" };

const ROWS: Row[] = [
  {
    id: "PC2-01 named imports through the package root and a subpath export",
    nodeTypes: false,
    links: LINKS,
    files: {
      ...WS,
      "packages/shared/src/index.ts": `export { greet } from "./greet.ts";
export const VERSION = "1.2.3";`,
      "packages/shared/src/greet.ts": "export function greet(name: string): string { return `hello, ${name}`; }",
      "cli/src/main.ts": `import { greet, VERSION } from "@demo/shared";
import { greet as again } from "@demo/shared/greet";
console.log(greet("world"), VERSION, again("x"), greet === again);`,
    },
  },
  {
    id: "PC2-02 a member module evaluates once, in Node's order",
    nodeTypes: false,
    links: LINKS,
    files: {
      ...WS,
      "packages/shared/src/index.ts": `import { log } from "./log.ts";
log("shared index");
export const counter = { n: 0 };
export function bump(): number { counter.n += 1; return counter.n; }`,
      "packages/shared/src/log.ts": `export const lines: string[] = [];
export function log(s: string): void { lines.push(s); console.log("init:", s); }`,
      "cli/src/helper.ts": `import { bump } from "@demo/shared";
console.log("helper", bump());
export const fromHelper = bump();`,
      "cli/src/main.ts": `import { counter, bump } from "@demo/shared";
import { fromHelper } from "./helper.ts";
import { lines } from "@demo/shared/log";
console.log("main", fromHelper, bump(), counter.n, lines.join(","));`,
    },
  },
  {
    id: "PC2-03 classes and errors from a member keep their identity",
    nodeTypes: false,
    links: LINKS,
    files: {
      ...WS,
      "packages/shared/src/index.ts": `export class ConfigError extends Error {
  readonly key: string;
  constructor(key: string) {
    super("missing config: " + key);
    this.name = "ConfigError";
    this.key = key;
  }
}
export function need(env: Record<string, string>, key: string): string {
  const v = env[key];
  if (v === undefined) throw new ConfigError(key);
  return v;
}`,
      "cli/src/main.ts": `import { ConfigError, need } from "@demo/shared";
const env: Record<string, string> = { HOME: "/home/x" };
console.log(need(env, "HOME"));
try {
  need(env, "PORT");
} catch (e) {
  if (e instanceof ConfigError) console.log("caught", e.name, e.key, e.message);
  else throw e;
}`,
    },
  },
];

describe("paperclip: workspace packages exporting TS source (wasm lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await checkRow(scratch, row, "wasm");
  });
});

describe("paperclip: workspace packages exporting TS source (wasm-native lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await checkRow(scratch, row, "wasm-native");
  }, 600_000);
});
