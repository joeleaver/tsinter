// node --import <this file> <entry.ts> : run a TypeScript project from its unmodified SOURCE under Node.
//
// The Node oracle for the top-10 trial. Real TypeScript projects are not written for Node's own type
// stripping: they import `./x.js` meaning `./x.ts`, write `.tsx`, decorators, enums and parameter
// properties, map workspace packages to `dist/` that only their build creates, and alias paths through
// tsconfig "paths". This loader does what the project's own dev runner (tsx, vite-node, ts-node) does,
// and nothing else, so Node runs the same source tsinter compiles:
//   resolve  1. Node's own resolution first; it always wins when it succeeds.
//            2. a project file (outside node_modules) asking for ./x.js|.mjs|.cjs|.jsx that is missing:
//               the .ts|.mts|.cts|.tsx twin; an extensionless ./x: x.ts, x.tsx, x/index.ts(x).
//            3. a bare specifier that fails: the nearest tsconfig "paths" (extends chains followed), then
//               moduleResolution "bundler"'s extension probing for deep imports (lodash/merge -> merge.js).
//            4. a resolved-but-missing file inside a workspace package (realpath outside node_modules)
//               under dist|lib|out|build: the same path under src with a TS extension.
//   load     project .ts/.mts/.cts/.tsx files are transpiled with TypeScript 5.9.3 (the tsinter repo's
//            own copy, never the project's) per file, honoring the nearest tsconfig's jsx, decorator,
//            class-field and target options. Module format follows Node: .mts module, .cts commonjs,
//            otherwise package.json "type", with Node's ESM-syntax detection for typeless packages.
//            `--import <this file>?full=1` emits through one TypeScript LanguageService per tsconfig instead
//            (full-program emit, as rollup-plugin-typescript / tsc do), for sources that are not
//            isolatedModules-safe (re-exporting a type without `export type`, const enums across files).
//            A JSON import without `with { type: "json" }` (resolveJsonModule + a bundler) loads as JSON.
// No project script runs; nothing is written to the project tree.
import { registerHooks, createRequire } from "node:module";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve as presolve, extname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ts = createRequire(join(HERE, "../../../package.json"))("typescript");
const TS_EXT = /\.(m|c)?tsx?$/;
const FULL = new URL(import.meta.url).searchParams.get("full") === "1";
const isProject = (p) => !p.includes("/node_modules/");
const isFile = (p) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

// ── tsconfig (JSONC, extends) ──────────────────────────────────────────────
const cfgCache = new Map();
function readJsonc(p) {
  const text = readFileSync(p, "utf8");
  const r = ts.parseConfigFileTextToJson(p, text);
  return r.config ?? {};
}
function loadCfg(p, depth = 0) {
  if (cfgCache.has(p)) return cfgCache.get(p);
  let raw;
  try {
    raw = readJsonc(p);
  } catch {
    raw = {};
  }
  let base = { compilerOptions: {}, dir: dirname(p) };
  const exts = raw.extends === undefined ? [] : Array.isArray(raw.extends) ? raw.extends : [raw.extends];
  for (const e of exts) {
    if (depth > 8) break;
    let ep = null;
    if (e.startsWith(".") || e.startsWith("/")) ep = presolve(dirname(p), e.endsWith(".json") ? e : e + ".json");
    else {
      try {
        ep = createRequire(p).resolve(e);
      } catch {
        try {
          ep = createRequire(p).resolve(e + "/tsconfig.json");
        } catch {
          ep = null;
        }
      }
    }
    if (ep && isFile(ep)) {
      const b = loadCfg(ep, depth + 1);
      base = { compilerOptions: { ...base.compilerOptions, ...b.compilerOptions }, dir: b.dir, pathsDir: b.pathsDir };
    }
  }
  const co = raw.compilerOptions ?? {};
  const merged = { compilerOptions: { ...base.compilerOptions, ...co }, dir: dirname(p), pathsDir: base.pathsDir };
  // "paths" resolve against baseUrl, else against the tsconfig that declares them
  if (co.paths !== undefined || co.baseUrl !== undefined) merged.pathsDir = presolve(dirname(p), co.baseUrl ?? ".");
  cfgCache.set(p, merged);
  return merged;
}
const nearestCache = new Map();
function nearestCfg(dir) {
  if (nearestCache.has(dir)) return nearestCache.get(dir);
  let d = dir, found = null;
  for (;;) {
    const c = join(d, "tsconfig.json");
    if (isFile(c)) {
      found = loadCfg(c);
      break;
    }
    const up = dirname(d);
    if (up === d) break;
    d = up;
  }
  nearestCache.set(dir, found);
  return found;
}

// ── resolution fallbacks ───────────────────────────────────────────────────
function tsTwin(p) {
  if (isFile(p)) return p;
  const m = /\.(m|c)?jsx?$/.exec(p);
  if (m) {
    const stem = p.slice(0, -m[0].length);
    const c = m[1] ?? "";
    for (const e of [`.${c}ts`, `.${c}tsx`, ".ts", ".tsx", ".d.ts"].filter((e) => e !== ".d.ts")) if (isFile(stem + e)) return stem + e;
  }
  for (const e of [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs"]) if (isFile(p + e)) return p + e;
  for (const e of ["index.ts", "index.tsx", "index.mts", "index.js"]) if (isFile(join(p, e))) return join(p, e);
  return null;
}
function viaPaths(spec, parentPath) {
  const cfg = nearestCfg(dirname(parentPath));
  const paths = cfg?.compilerOptions?.paths;
  if (!paths) return null;
  for (const [pat, targets] of Object.entries(paths)) {
    let star = null;
    if (pat.includes("*")) {
      const [pre, post] = pat.split("*");
      if (spec.startsWith(pre) && spec.endsWith(post) && spec.length >= pre.length + post.length) star = spec.slice(pre.length, spec.length - post.length);
      else continue;
    } else if (pat !== spec) continue;
    for (const t of targets) {
      const p = presolve(cfg.pathsDir ?? cfg.dir, star === null ? t : t.replace("*", star));
      const hit = tsTwin(p);
      if (hit) return hit;
    }
  }
  return null;
}
function distToSrc(p) {
  const m = /^(.*?)\/(dist|lib|out|build)\/(.*)$/.exec(p);
  if (!m) return null;
  const rest = m[3].replace(/\.d\.(m|c)?ts$/, ".$1ts").split("/");
  // dist/x.js, dist/esm/x.js, dist/cjs/src/x.js ... -> src/x.ts (drop leading build-flavor dirs)
  for (let drop = 0; drop < Math.min(rest.length, 3); drop++) {
    const tail = rest.slice(drop).join("/");
    for (const sub of ["src/", ""]) {
      const hit = tsTwin(`${m[1]}/${sub}${tail}`);
      if (hit) return hit;
    }
  }
  return null;
}

registerHooks({
  resolve(spec, ctx, next) {
    const parentPath = ctx.parentURL?.startsWith("file:") ? fileURLToPath(ctx.parentURL) : null;
    let first;
    try {
      const r = next(spec, ctx);
      if (!r.url.startsWith("file:") || isFile(fileURLToPath(r.url))) return r;
      first = new Error(`resolved to a missing file: ${r.url}`);
      const hit = isProject(realpathSafe(fileURLToPath(r.url))) ? distToSrc(fileURLToPath(r.url)) : null;
      if (hit) return { url: pathToFileURL(hit).href, shortCircuit: true };
    } catch (e) {
      first = e;
    }
    if (parentPath && isProject(parentPath)) {
      let hit = null;
      if (spec.startsWith("./") || spec.startsWith("../") || spec === "." || spec === "..") hit = tsTwin(presolve(dirname(parentPath), spec));
      else if (spec.startsWith("/")) hit = tsTwin(spec);
      else if (!spec.startsWith("node:") && !spec.includes(":")) hit = viaPaths(spec, parentPath);
      if (hit) return { url: pathToFileURL(hit).href, shortCircuit: true };
      // moduleResolution "bundler": an extensionless deep import of an installed package (lodash/merge)
      if (!spec.startsWith(".") && !spec.startsWith("/") && !spec.includes(":") && spec.split("/").length > (spec.startsWith("@") ? 2 : 1)) {
        for (const suffix of [".js", "/index.js", ".mjs", ".cjs"]) {
          try {
            const r = next(spec + suffix, ctx);
            if (!r.url.startsWith("file:") || isFile(fileURLToPath(r.url))) return r;
          } catch {
            /* try the next suffix */
          }
        }
      }
    }
    // a bare workspace specifier whose exports point at an unbuilt dist/
    const msg = String(first?.message ?? "");
    const mm = /Cannot find (?:module|package) '([^']+)'/.exec(msg);
    if (mm) {
      const p = mm[1].startsWith("file:") ? fileURLToPath(mm[1]) : mm[1];
      if (p.startsWith("/") && isProject(realpathSafe(p))) {
        const real = realpathSafe(p);
        const hit = distToSrc(real) ?? tsTwin(real);
        if (hit) return { url: pathToFileURL(hit).href, shortCircuit: true };
      }
    }
    throw first;
  },
  load(url, ctx, next) {
    if (!url.startsWith("file:")) return next(url, ctx);
    const p = fileURLToPath(url);
    // bundler-style JSON imports (no `with { type: "json" }`), as resolveJsonModule + a bundler allow
    if (p.endsWith(".json") && ctx.importAttributes?.type !== "json" && ctx.format !== "commonjs") {
      return next(url, { ...ctx, importAttributes: { ...ctx.importAttributes, type: "json" } });
    }
    if (!TS_EXT.test(p) || p.endsWith(".d.ts") || !isProject(realpathSafe(p))) return next(url, ctx);
    const src = readFileSync(p, "utf8");
    const format = formatOf(p, src);
    const cfg = nearestCfg(dirname(p));
    const co = cfg?.compilerOptions ?? {};
    if (FULL && cfg) return { format, source: requireShim(format, fullEmit(cfg, p, format)), shortCircuit: true };
    const out = ts.transpileModule(src, {
      fileName: p,
      compilerOptions: {
        target: ts.ScriptTarget.ES2023,
        module: format === "module" ? ts.ModuleKind.ESNext : ts.ModuleKind.CommonJS,
        esModuleInterop: true,
        sourceMap: false,
        inlineSourceMap: false,
        verbatimModuleSyntax: false,
        isolatedModules: true,
        experimentalDecorators: co.experimentalDecorators === true,
        emitDecoratorMetadata: co.emitDecoratorMetadata === true,
        useDefineForClassFields: co.useDefineForClassFields !== false,
        jsx: jsxOf(co.jsx),
        ...(co.jsxImportSource ? { jsxImportSource: co.jsxImportSource } : {}),
        ...(co.jsxFactory ? { jsxFactory: co.jsxFactory } : {}),
        ...(co.jsxFragmentFactory ? { jsxFragmentFactory: co.jsxFragmentFactory } : {}),
      },
    });
    return { format, source: requireShim(format, out.outputText), shortCircuit: true };
  },
});

// realpath of a path that may not exist: the nearest existing ancestor's realpath + the rest
function realpathSafe(p) {
  let head = p, tail = "";
  for (;;) {
    try {
      return realpathSync(head) + tail;
    } catch {
      const up = dirname(head);
      if (up === head) return p;
      tail = head.slice(up.length) + tail;
      head = up;
    }
  }
}
function jsxOf(j) {
  switch (String(j ?? "").toLowerCase()) {
    case "react": return ts.JsxEmit.React;
    case "react-jsxdev": return ts.JsxEmit.ReactJSXDev;
    case "preserve": return ts.JsxEmit.Preserve;
    default: return ts.JsxEmit.ReactJSX;
  }
}
const typeCache = new Map();
function pkgType(dir) {
  if (typeCache.has(dir)) return typeCache.get(dir);
  let t = null;
  const pj = join(dir, "package.json");
  if (isFile(pj)) {
    try {
      t = JSON.parse(readFileSync(pj, "utf8")).type ?? "none";
    } catch {
      t = "none";
    }
  } else {
    const up = dirname(dir);
    t = up === dir ? "none" : pkgType(up);
  }
  typeCache.set(dir, t);
  return t;
}
function formatOf(p, src) {
  if (p.endsWith(".mts")) return "module";
  if (p.endsWith(".cts")) return "commonjs";
  const t = pkgType(dirname(p));
  if (t === "module") return "module";
  if (t === "commonjs") return "commonjs";
  // typeless package: Node's syntax detection (ESM syntax -> module)
  return /^\s*(import|export)\b|^\s*import\s*\(|\bimport\.meta\b|^\s*await\b/m.test(src) ? "module" : "commonjs";
}

// An ES module that calls require() (bundled sources mix the two; rollup's commonjs plugin and vite
// resolve them): give it the module-local require its bundler would, via createRequire.
function requireShim(format, js) {
  if (format !== "module" || !/\brequire\s*\(/.test(js) || /\b(const|let|var|function)\s+require\b/.test(js)) return js;
  return `import { createRequire as __top10CreateRequire } from "node:module"; const require = __top10CreateRequire(import.meta.url);\n` + js;
}

// ── full-program emit (?full=1) ─────────────────────────────────────────────
const services = new Map();
function fullEmit(cfg, file, format) {
  const key = cfg.dir + "|" + format;
  let svc = services.get(key);
  if (!svc) {
    const parsed = ts.parseJsonConfigFileContent(readJsonc(join(cfg.dir, "tsconfig.json")), ts.sys, cfg.dir);
    const options = {
      ...parsed.options,
      target: ts.ScriptTarget.ES2023,
      module: format === "module" ? ts.ModuleKind.ESNext : ts.ModuleKind.CommonJS,
      noEmit: false, emitDeclarationOnly: false, declaration: false, declarationMap: false, composite: false,
      sourceMap: false, inlineSourceMap: false, isolatedModules: false, verbatimModuleSyntax: false, noEmitOnError: false,
      esModuleInterop: true, incremental: false,
    };
    const files = new Set();
    const host = {
      getScriptFileNames: () => [...files],
      getScriptVersion: () => "1",
      getScriptSnapshot: (f) => (isFile(f) ? ts.ScriptSnapshot.fromString(readFileSync(f, "utf8")) : undefined),
      getCurrentDirectory: () => cfg.dir,
      getCompilationSettings: () => options,
      getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
      fileExists: ts.sys.fileExists, readFile: ts.sys.readFile, readDirectory: ts.sys.readDirectory,
      directoryExists: ts.sys.directoryExists, getDirectories: ts.sys.getDirectories,
    };
    svc = { ls: ts.createLanguageService(host, ts.createDocumentRegistry()), files };
    services.set(key, svc);
  }
  svc.files.add(file);
  const out = svc.ls.getEmitOutput(file).outputFiles.find((o) => /\.(m|c)?js$/.test(o.name));
  if (!out) throw new Error(`node-src-loader: no emit for ${file}`);
  return out.text;
}
