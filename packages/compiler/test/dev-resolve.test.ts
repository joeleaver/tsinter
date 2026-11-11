/* Dev-runner resolution and the adopted tsconfig type surface (SEMANTICS.md
 * S130), on small synthetic fixtures (no third-party code).
 *
 * The oracle for multi-package projects is Node running the source under
 * tests/real-apps-top10/harness/node-src-loader.mjs. Every run row below
 * runs the fixture under that loader AND compiles it on the wasm lane, and
 * requires the same stdout and exit code; the resolver rows pin
 * dev-resolve.ts's answers (the loader's rules) directly. */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { clearDevResolveCaches, devResolve } from "../src/frontend/dev-resolve.js";
import { scanDevGraph } from "../src/frontend/dev-graph.js";
import { runWasm } from "./wasm-host.js";

const LOADER = join(dirname(fileURLToPath(import.meta.url)), "../../../tests/real-apps-top10/harness/node-src-loader.mjs");
const scratch = mkdtempSync(join(tmpdir(), "tsinter-dev-resolve-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** Writes a fixture tree: path → content (a "->target" content is a
 * symlink, the workspace install's shape). */
let treeCount = 0;
function tree(name: string, files: Record<string, string>): string {
  const root = join(scratch, `${name}-${treeCount++}`);
  for (const [rel, content] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    if (content.startsWith("->")) symlinkSync(content.slice(2), p, "dir");
    else writeFileSync(p, content);
  }
  clearDevResolveCaches();
  return root;
}

const json = (v: unknown): string => JSON.stringify(v, null, 1) + "\n";

/** A workspace: app imports @ws/lib, whose package.json main/types/exports
 * name a dist/ that was never built, and @ws/built, whose dist/ exists. */
function workspace(): string {
  return tree("ws", {
    "package.json": json({ name: "ws-root", private: true, type: "module", workspaces: ["packages/*"] }),
    "packages/app/package.json": json({ name: "app", type: "module", dependencies: { "@ws/lib": "*", "@ws/built": "*" } }),
    "packages/app/src/main.ts": [
      'import { greet, VERSION } from "@ws/lib";',
      'import { twice } from "@ws/lib/util";',
      'console.log(greet("dev"), VERSION, twice(21));',
      "",
    ].join("\n"),
    "packages/greet/package.json": json({
      name: "@ws/lib",
      type: "module",
      main: "./dist/index.js",
      types: "./dist/index.d.ts",
      exports: {
        ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
        "./*": { types: "./dist/*.d.ts", import: "./dist/*.js" },
      },
    }),
    "packages/greet/src/index.ts": 'export const VERSION = "1.0";\nexport function greet(who: string): string {\n  return `hello ${who}`;\n}\n',
    "packages/greet/src/util.ts": "export function twice(n: number): number {\n  return n * 2;\n}\n",
    "packages/built/package.json": json({ name: "@ws/built", type: "module", exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } } }),
    "packages/built/dist/index.js": 'export function built() { return "built"; }\n',
    "packages/built/dist/index.d.ts": "export declare function built(): string;\n",
    "packages/built/src/index.ts": 'export function built(): string {\n  return "from-src";\n}\n',
    "node_modules/@ws/lib": "->../../packages/greet",
    "node_modules/@ws/built": "->../../packages/built",
  });
}

/** The repo's vendored, pinned @types/node (tests/fixtures/node-types). */
const NODE_TYPES_MODULES = join(dirname(fileURLToPath(import.meta.url)), "../../../tests/fixtures/node-types/node_modules");

/** A tsconfig with paths (an extends chain), a non-ES lib and an included
 * global declaration file; with @types/node installed (a symlink to the
 * vendored copy) unless `nodeTypes` is false. */
function aliased(nodeTypes = true): string {
  return tree("alias", {
    ...(nodeTypes
      ? { "node_modules/@types/node": "->" + join(NODE_TYPES_MODULES, "@types/node"), "node_modules/undici-types": "->" + join(NODE_TYPES_MODULES, "undici-types") }
      : {}),
    // A types-only package the tsconfig lists in "types": its global joins.
    "node_modules/build-env/package.json": json({ name: "build-env", version: "1.0.0", types: "index.d.ts" }),
    "node_modules/build-env/index.d.ts": "type BuildMode = \"dev\" | \"prod\";\n",
    "package.json": json({ name: "alias-proj", type: "module" }),
    "tsconfig.base.json": json({ compilerOptions: { strict: true, baseUrl: ".", paths: { "@lib/*": ["src/lib/*"], cfg: ["src/config"] } } }),
    "tsconfig.json": json({ extends: "./tsconfig.base.json", compilerOptions: { lib: ["es2022", "dom"], types: ["node", "build-env"] }, include: ["src", "types"] }),
    "types/global.d.ts": "type Level = 1 | 2 | 3;\n",
    "src/config.ts": 'const level: Level = 3;\nexport const config = { name: "alias", level };\n',
    "src/lib/math.ts": "export function add(a: number, b: number): number {\n  return a + b;\n}\n",
    "src/main.ts": [
      'import { add } from "@lib/math";',
      'import { config } from "cfg";',
      "export type Mount = (el: HTMLElement | null) => void;",
      // lib.dom's own BodyInit (scriptc's fetch-init declarations stand down).
      "export type Body = BodyInit | HeadersInit;",
      'const mode: BuildMode = "dev";',
      "console.log(add(2, 3), config.name, config.level, mode);",
      "",
    ].join("\n"),
  });
}

function nodeRun(entry: string): { stdout: string; status: number | null; stderr: string } {
  const r = spawnSync(process.execPath, ["--import", "file://" + LOADER, entry], { encoding: "utf8", cwd: dirname(entry) });
  return { stdout: r.stdout, status: r.status, stderr: r.stderr };
}

async function wasmRun(entry: string): Promise<{ stdout: string; exitCode: number }> {
  const out = join(dirname(entry), "out.wasm");
  const res = await compile(entry, { outPath: out, outDir: dirname(entry), backend: "wasm" });
  if (!res.ok) throw new Error(`refused: ${res.diagnostics.map((d) => `${d.code} ${d.message}`).join(" | ")}`);
  const run = await runWasm(res.binaryPath);
  return { stdout: run.stdout, exitCode: run.exitCode };
}

describe("devResolve: the loader's rules", () => {
  test("a workspace package whose exports name unbuilt dist/ resolves to its src twin", () => {
    const root = workspace();
    const from = join(root, "packages/app/src/main.ts");
    expect(devResolve(from, "@ws/lib")).toEqual({ file: join(root, "packages/greet/src/index.ts"), rule: "workspace-source" });
    expect(devResolve(from, "@ws/lib/util")).toEqual({ file: join(root, "packages/greet/src/util.ts"), rule: "workspace-source" });
  });

  test("a workspace package whose own exports name TypeScript source is program source (Node's answer, transpiled)", () => {
    const root = tree("ws-src", {
      "packages/app/main.ts": 'import "@ws/src";\n',
      "packages/srcpkg/package.json": json({ name: "@ws/src", type: "module", exports: { ".": "./src/index.ts" } }),
      "packages/srcpkg/src/index.ts": "export {};\n",
      "packages/app/node_modules/@ws/src": "->../../../srcpkg",
    });
    expect(devResolve(join(root, "packages/app/main.ts"), "@ws/src")).toEqual({ file: join(root, "packages/srcpkg/src/index.ts"), rule: "workspace-source" });
  });

  test("Node's own answer wins: a built workspace package, a builtin, a relative specifier", () => {
    const root = workspace();
    const from = join(root, "packages/app/src/main.ts");
    expect(devResolve(from, "@ws/built")).toBeNull();
    expect(devResolve(from, "node:fs")).toBeNull();
    expect(devResolve(from, "fs")).toBeNull();
    expect(devResolve(from, "./x.js")).toBeNull();
  });

  test("nothing installed and no alias: no answer (Node's refusal stands)", () => {
    const root = workspace();
    expect(devResolve(join(root, "packages/app/src/main.ts"), "@ws/nope")).toBeNull();
    expect(devResolve(join(root, "packages/app/src/main.ts"), "@ws/lib/missing")).toBeNull();
  });

  test("tsconfig paths through an extends chain, against the declaring config's baseUrl", () => {
    const root = aliased();
    const from = join(root, "src/main.ts");
    expect(devResolve(from, "@lib/math")).toEqual({ file: join(root, "src/lib/math.ts"), rule: "paths" });
    expect(devResolve(from, "cfg")).toEqual({ file: join(root, "src/config.ts"), rule: "paths" });
    expect(devResolve(from, "@lib/none")).toBeNull();
  });

  test("an alias never applies to an importer inside node_modules", () => {
    const root = tree("alias-nm", {
      "tsconfig.json": json({ compilerOptions: { paths: { "x/*": ["src/*"] } } }),
      "src/a.ts": "export const a = 1;\n",
      "node_modules/dep/index.ts": 'import { a } from "x/a";\n',
    });
    expect(devResolve(join(root, "node_modules/dep/index.ts"), "x/a")).toBeNull();
    expect(devResolve(join(root, "src/b.ts"), "x/a")).toEqual({ file: join(root, "src/a.ts"), rule: "paths" });
  });

  test("a package with no exports: an unbuilt main maps for both syntaxes; no main maps only under ESM", () => {
    const root = tree("legacy", {
      "packages/app/main.ts": 'import "@ws/legacy";\n',
      "packages/legacy/package.json": json({ name: "@ws/legacy", main: "./dist/index.js" }),
      "packages/legacy/src/index.ts": "export {};\n",
      "packages/app/node_modules/@ws/legacy": "->../../../legacy",
      "packages/nomain/package.json": json({ name: "@ws/nomain" }),
      "packages/nomain/index.ts": "export {};\n",
      "packages/app/node_modules/@ws/nomain": "->../../../nomain",
    });
    const from = join(root, "packages/app/main.ts");
    // Node 24 names the main entry it could not load, for both syntaxes.
    const legacy = { file: join(root, "packages/legacy/src/index.ts"), rule: "workspace-source" };
    expect(devResolve(from, "@ws/legacy")).toEqual(legacy);
    expect(devResolve(from, "@ws/legacy", "require")).toEqual(legacy);
    // No main: ESM names '<pkg>/index.js' (its TypeScript twin answers);
    // CommonJS names only the specifier, so nothing maps.
    expect(devResolve(from, "@ws/nomain")).toEqual({ file: join(root, "packages/nomain/index.ts"), rule: "workspace-source" });
    expect(devResolve(from, "@ws/nomain", "require")).toBeNull();
  });
});

describe("scanDevGraph: the checker's exact paths", () => {
  test("every dev-runner specifier of the graph, no conflicts", () => {
    const root = workspace();
    const g = scanDevGraph([join(root, "packages/app/src/main.ts")]);
    expect(g.conflicts).toEqual([]);
    expect(g.paths).toEqual({
      "@ws/lib": [join(root, "packages/greet/src/index.ts")],
      "@ws/lib/util": [join(root, "packages/greet/src/util.ts")],
    });
  });

  test("two packages mapping one alias text to their own files conflict", () => {
    const root = tree("conflict", {
      "a/tsconfig.json": json({ compilerOptions: { paths: { "@/*": ["./*"] } } }),
      "a/main.ts": 'import { v } from "@/src/v";\nimport { w } from "../b/w";\nconsole.log(v, w);\n',
      "a/src/v.ts": 'export const v = "a";\n',
      "b/tsconfig.json": json({ compilerOptions: { paths: { "@/*": ["./*"] } } }),
      "b/w.ts": 'import { v } from "@/src/v";\nexport const w = v;\n',
      "b/src/v.ts": 'export const v = "b";\n',
    });
    const g = scanDevGraph([join(root, "a/main.ts")]);
    expect(g.paths).toEqual({});
    expect(g.conflicts.map((c) => c.spec)).toEqual(["@/src/v"]);
    expect(new Set(g.conflicts[0]!.sites.map((s) => s.answer))).toEqual(new Set([join(root, "a/src/v.ts"), join(root, "b/src/v.ts")]));
  });
});

describe("compiled like the loader runs it (wasm lane)", () => {
  test("workspace sources: a dist-pointing package compiles from its src", async () => {
    const entry = join(workspace(), "packages/app/src/main.ts");
    const node = nodeRun(entry);
    expect(node.stderr).toBe("");
    expect(node.stdout).toBe("hello dev 1.0 42\n");
    expect(await wasmRun(entry)).toEqual({ stdout: node.stdout, exitCode: 0 });
  }, 120_000);

  test("tsconfig paths, lib dom, a types package and an included global .d.ts", async () => {
    const entry = join(aliased(), "src/main.ts");
    const node = nodeRun(entry);
    expect(node.stderr).toBe("");
    expect(node.stdout).toBe("5 alias 3 dev\n");
    expect(await wasmRun(entry)).toEqual({ stdout: node.stdout, exitCode: 0 });
  }, 120_000);

  test("an included .d.ts that augments an installed package's module (rea's frida-bindings.d.ts shape)", async () => {
    const project = (include: string[]): string =>
      tree("augment", {
        "package.json": json({ name: "augment-proj", type: "module" }),
        "tsconfig.json": json({ compilerOptions: { strict: true }, include }),
        // A types-only installed package; the project's own declaration
        // file adds a member to its module.
        "node_modules/bindings/package.json": json({ name: "bindings", version: "1.0.0", types: "index.d.ts" }),
        "node_modules/bindings/index.d.ts": "export interface Script {\n  name: string;\n}\n",
        "src/bindings-ext.d.ts": 'import "bindings";\ndeclare module "bindings" {\n  interface Message {\n    kind: "send" | "error";\n  }\n}\n',
        "src/main.ts": 'import type { Message } from "bindings";\nexport function kindOf(m: Message): string {\n  return m.kind;\n}\nconsole.log("ok");\n',
      });
    const diags = async (root: string): Promise<{ code: string; message: string }[]> => {
      const res = await compile(join(root, "src/main.ts"), { outPath: join(root, "out.wasm"), outDir: root, backend: "wasm" });
      return res.ok ? [] : res.diagnostics.map((d) => ({ code: d.code, message: d.message }));
    };
    // With the declaration file included, the type check passes: whatever
    // remains is the lowering's (the package's types run in the island).
    expect((await diags(project(["src"]))).filter((d) => d.code === "SC0001")).toEqual([]);
    // Without it, the augmented member does not exist.
    const without = await diags(project(["src/main.ts"]));
    expect(without.some((d) => d.code === "SC0001" && d.message.includes("'Message'"))).toBe(true);
  }, 120_000);

  test("without @types/node the project's DOM lib is not adopted: its names fail the type check by name", async () => {
    const root = aliased(false);
    const entry = join(root, "src/main.ts");
    const res = await compile(entry, { outPath: join(root, "out.wasm"), outDir: root, backend: "wasm" });
    expect(res.ok).toBe(false);
    expect(res.diagnostics.map((d) => d.message)).toContain("Cannot find name 'HTMLElement'.");
  }, 120_000);

  test("a conflicting alias refuses by name (SC1010) at its import sites", async () => {
    const root = tree("conflict-run", {
      "a/tsconfig.json": json({ compilerOptions: { strict: true, paths: { "@/*": ["./*"] } } }),
      "a/package.json": json({ type: "module" }),
      "a/main.ts": 'import { v } from "@/src/v";\nimport { w } from "../b/w.ts";\nconsole.log(v, w);\n',
      "a/src/v.ts": 'export const v = "a";\n',
      "b/tsconfig.json": json({ compilerOptions: { strict: true, paths: { "@/*": ["./*"] } } }),
      "b/w.ts": 'import { v } from "@/src/v";\nexport const w = v;\n',
      "b/src/v.ts": 'export const v = "b";\n',
    });
    const entry = join(root, "a/main.ts");
    expect(nodeRun(entry).stdout).toBe("a b\n");
    const res = await compile(entry, { outPath: join(root, "out.wasm"), outDir: root, backend: "wasm" });
    expect(res.ok).toBe(false);
    const named = res.diagnostics.filter((d) => d.code === "SC1010" && d.message.includes("'@/src/v' import"));
    expect(named.map((d) => (d.loc as { file: string }).file).sort()).toEqual([entry, join(root, "b/w.ts")]);
  }, 120_000);
});
