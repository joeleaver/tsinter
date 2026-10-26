/* node-conditions.ts pinned to Node (board #258 and its review). Every
 * nodeConditionLeaf row was probed on Node v24.18.1: a package whose
 * exports "." is the row's target, loaded with an import statement and
 * with require(). A string answer is the file Node loaded; null is Node's
 * ERR_PACKAGE_PATH_NOT_EXPORTED / ERR_INVALID_PACKAGE_TARGET (both
 * resolvers then answer nothing). */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import {
  NODE_IMPORT_CONDITIONS,
  NODE_REQUIRE_CONDITIONS,
  nodeConditionLeaf,
  nodeLoadsAsCjs,
  reduceConditionTargets,
  wrapperShapeOf,
} from "../src/frontend/node-conditions.js";

describe("nodeConditionLeaf (probed on Node v24.18.1)", () => {
  const rows: [string, unknown, string | null, string | null][] = [
    ["syntax picks import/require", { import: "./i.mjs", require: "./r.cjs" }, "./i.mjs", "./r.cjs"],
    ["module-sync listed first wins for both syntaxes", { "module-sync": "./s.mjs", import: "./i.mjs" }, "./s.mjs", "./s.mjs"],
    ["browser is not a Node condition", { browser: "./b.js", default: "./d.js" }, "./d.js", "./d.js"],
    [
      "types skipped, node recursed per syntax",
      { types: "./x.d.ts", node: { import: "./n.mjs", require: "./n.cjs" }, default: "./d.js" },
      "./n.mjs",
      "./n.cjs",
    ],
    ["an unmatched nested object falls through", { node: { browser: "./b.js" }, default: "./d.js" }, "./d.js", "./d.js"],
    ["null excludes for its syntax only", { import: null, default: "./d.js" }, null, "./d.js"],
    ["a ../ target in a fallback array falls through", ["../bad.js", "./ok.js"], "./ok.js", "./ok.js"],
    ["a node_modules segment in a fallback array falls through", ["./node_modules/x.js", "./ok.js"], "./ok.js", "./ok.js"],
    ["a .. segment is an invalid target", "./a/../ok.js", null, null],
    ["an empty fallback array exports nothing", [], null, null],
    ["default: null exports nothing", { default: null }, null, null],
    ["null in a fallback array falls through", [null, "./ok.js"], "./ok.js", "./ok.js"],
  ];
  test.for(rows)("%s", ([, target, imp, req]) => {
    expect(nodeConditionLeaf(target, NODE_IMPORT_CONDITIONS)).toBe(imp);
    expect(nodeConditionLeaf(target, NODE_REQUIRE_CONDITIONS)).toBe(req);
  });

  test("an imports-field target may be a bare specifier; an exports target may not", () => {
    expect(nodeConditionLeaf({ node: "lodash" }, NODE_IMPORT_CONDITIONS, "imports")).toBe("lodash");
    expect(nodeConditionLeaf({ node: "lodash" }, NODE_IMPORT_CONDITIONS, "exports")).toBe(null);
    expect(nodeConditionLeaf("../up.js", NODE_IMPORT_CONDITIONS, "imports")).toBe(null);
  });

  test("no match answers undefined", () => {
    expect(nodeConditionLeaf({ browser: "./b.js" }, NODE_IMPORT_CONDITIONS)).toBe(undefined);
  });
});

describe("wrapperShapeOf", () => {
  const wrapper = "/p/esm.mjs";
  const cjs = "/p/index.js";
  test("commander's esm.mjs shape (comments inside the list, optional default)", () => {
    const src = [
      "import commander from './index.js';",
      "",
      "// wrapper to provide named exports for ESM.",
      "export const {",
      "  program,",
      "  InvalidOptionArgumentError, // deprecated old name",
      "  Command,",
      "} = commander;",
    ].join("\n");
    const shape = wrapperShapeOf(src, wrapper, cjs);
    expect(shape).not.toBeNull();
    expect([...shape!.names].sort()).toEqual(["Command", "InvalidOptionArgumentError", "program"]);
    expect(shape!.hasDefault).toBe(false);
    const withDefault = wrapperShapeOf(src + "\nexport default commander;\n", wrapper, cjs);
    expect(withDefault!.hasDefault).toBe(true);
  });
  test.for([
    ["the default import names another file", "import X from './other.js';\nexport const { a } = X;"],
    ["a stray statement makes it a real module", "import X from './index.js';\nexport const { a } = X;\nexport const b = 1;"],
    ["a rename is not the plain shape", "import X from './index.js';\nexport const { a: b } = X;"],
    ["destructuring another binding", "import X from './index.js';\nconst Y = X;\nexport const { a } = Y;"],
    ["a bare specifier import", "import X from 'pkg';\nexport const { a } = X;"],
    ["no names exported", "import X from './index.js';"],
  ] as const)("not a wrapper: %s", ([, src]) => {
    expect(wrapperShapeOf(src, wrapper, cjs)).toBeNull();
  });
});

describe("nodeLoadsAsCjs and the wrapper substitution (review B1)", () => {
  const root = mkdtempSync(join(tmpdir(), "node-conditions-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const pkgOf = (name: string, files: Record<string, string>): string => {
    const dir = join(root, name);
    for (const [f, body] of Object.entries(files)) {
      mkdirSync(join(dir, f, ".."), { recursive: true });
      writeFileSync(join(dir, f), body);
    }
    return dir;
  };
  const WRAP = "import X from './index.js';\nexport const { a } = X;\n";
  const EXPORTS = { exports: { ".": { import: "./wrap.mjs", require: "./index.js" } } };

  test("a CommonJS require target takes the substitution", () => {
    const dir = pkgOf("cjs", { "package.json": "{}", "index.js": "exports.a = 1;\n", "wrap.mjs": WRAP });
    expect(nodeLoadsAsCjs(join(dir, "index.js"))).toBe(true);
    const pkg = JSON.parse(JSON.stringify(EXPORTS)) as Record<string, unknown>;
    expect(reduceConditionTargets(pkg, { keepTypes: false, wrapperPkgDir: dir })).toHaveLength(1);
    expect(pkg["exports"]).toEqual({ ".": { import: "./index.js", require: "./index.js" } });
  });
  test.for([
    ["no type, ES module syntax (Node 24 syntax detection)", { "package.json": "{}", "index.js": "export const a = 1;\nexport default { a: 2 };\n" }],
    ["root type: module", { "package.json": '{"type":"module"}', "index.js": "exports.a = 1;\n" }],
    ["import.meta in the source", { "package.json": "{}", "index.js": "exports.a = import.meta.url;\n" }],
  ] as const)("no substitution when the require target is not CommonJS: %s", ([label, files]) => {
    const dir = pkgOf(label.replace(/\W+/g, "-"), { ...files, "wrap.mjs": WRAP });
    expect(nodeLoadsAsCjs(join(dir, "index.js"))).toBe(false);
    const pkg = JSON.parse(JSON.stringify(EXPORTS)) as Record<string, unknown>;
    expect(reduceConditionTargets(pkg, { keepTypes: false, wrapperPkgDir: dir })).toHaveLength(0);
    expect(pkg["exports"]).toEqual({ ".": { import: "./wrap.mjs", require: "./index.js" } });
  });
  test("a nested package.json scope with type: module", () => {
    const dir = pkgOf("nested", {
      "package.json": "{}",
      "dist/package.json": '{"type":"module"}',
      "dist/index.js": "exports.a = 1;\n",
    });
    expect(nodeLoadsAsCjs(join(dir, "dist/index.js"))).toBe(false);
    const commonjs = pkgOf("nested-cjs", {
      "package.json": '{"type":"module"}',
      "dist/package.json": '{"type":"commonjs"}',
      "dist/index.js": "exports.a = 1;\n",
    });
    expect(nodeLoadsAsCjs(join(commonjs, "dist/index.js"))).toBe(true);
  });
  test(".cjs always, .mjs never", () => {
    expect(nodeLoadsAsCjs(join(root, "x.cjs"))).toBe(true);
    expect(nodeLoadsAsCjs(join(root, "x.mjs"))).toBe(false);
  });
});

describe("reduceConditionTargets", () => {
  test("project scopes keep a declaration answer first; imports reduce like exports", () => {
    const pkg: Record<string, unknown> = {
      exports: { ".": { types: "./index.d.ts", node: "./n.js", default: "./d.js" } },
      imports: { "#x": { node: "./n.js", default: "./d.js" }, "#y": "./y.js" },
    };
    reduceConditionTargets(pkg, { keepTypes: true });
    expect(pkg["exports"]).toEqual({ ".": { types: "./index.d.ts", import: "./n.js", require: "./n.js" } });
    expect(pkg["imports"]).toEqual({ "#x": { import: "./n.js", require: "./n.js" }, "#y": "./y.js" });
  });
  test("sugar exports (a top-level condition object) reduce as the '.' subpath", () => {
    const pkg: Record<string, unknown> = { exports: { require: "./r.cjs", import: "./i.mjs" } };
    reduceConditionTargets(pkg, { keepTypes: false });
    expect(pkg["exports"]).toEqual({ import: "./i.mjs", require: "./r.cjs" });
  });
});
