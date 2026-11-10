/* Running one program on Node and on tsinter's lanes, and classifying
 * the outcome. Loaded inside a worker (worker.mjs), which runs under
 * `node --experimental-transform-types --import ./ts-resolve.mjs` so that
 * it can use the repo's own shared wasm test host
 * (packages/compiler/test/wasm-host.ts) — the same driver the GH-row unit
 * tests use — and the built compiler (packages/compiler/dist).
 *
 * Classes, per lane:
 *   match       stdout, stderr and exit code equal Node's
 *   refused     a named compile diagnostic (not SC9001), or a run-time
 *               fence (`tsinter: unsupported: …`, exit 1) whose stdout is
 *               a prefix of Node's
 *   divergence  anything else that ran: a SILENT divergence
 *   crash       SC9001, the compiler throwing, an invalid module, a bare
 *               trap, a host error, a native signal
 *   invalid     the program itself is bad: Node failed, or tsc rejected it
 *               (a generator bug, never a tsinter finding) */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export const ROOT = fileURLToPath(new URL("../../", import.meta.url));

let compileFn = null;
let host = null;
async function load() {
  if (compileFn === null) {
    const dist = join(ROOT, "packages/compiler/dist/index.js");
    if (!existsSync(dist)) throw new Error(`no built compiler at ${dist}: run pnpm build first`);
    compileFn = (await import(dist)).compile;
    host = await import(join(ROOT, "packages/compiler/test/wasm-host.ts"));
  }
}

const NODE_TIMEOUT = 20_000;

export function runNode(file) {
  const r = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", file], {
    encoding: "utf8", input: "", timeout: NODE_TIMEOUT, maxBuffer: 64 << 20,
  });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", exitCode: r.status ?? -1, timedOut: r.error?.code === "ETIMEDOUT" };
}

const FENCE = /^tsinter: unsupported: (.*)$/m;

function fenceCode(stderr) {
  const m = FENCE.exec(stderr);
  if (!m) return null;
  const c = /\[(SC\d{4})\b/.exec(m[1]);
  return c ? c[1] : "fence";
}

const tokens = (s) => s.split(/[\s,:;{}[\]()]+/).filter((t) => t !== "");

function multisetMinus(a, b) {
  const m = new Map();
  for (const t of b) m.set(t, (m.get(t) ?? 0) + 1);
  const left = [];
  for (const t of a) {
    const n = m.get(t) ?? 0;
    if (n > 0) m.set(t, n - 1);
    else left.push(t);
  }
  return left;
}

/** What kind of difference: the same tokens in another ORDER, tokens
 * MISSING from tsinter's output, EXTRA tokens in it, or different VALUES
 * (judged over the one print holding the first differing line, so a
 * reordered multi-line print still reads as an order difference). The
 * minimizer keeps it fixed, so a key-order bug cannot shrink into a
 * dropped-key bug. */
const LABEL = /^#\d+:[A-Za-z0-9-]+/;

/** The lines of the print holding line i: from the last labeled line at
 * or above it to the next labeled line. */
function printAt(lines, i) {
  let lo = Math.min(i, lines.length);
  while (lo > 0 && !LABEL.test(lines[lo] ?? "")) lo--;
  let hi = lo + 1;
  while (hi < lines.length && !LABEL.test(lines[hi])) hi++;
  return lines.slice(lo, hi).join("\n");
}

export function diffNature(a, b, i) {
  const ta = tokens(printAt(a.split("\n"), i));
  const tb = tokens(printAt(b.split("\n"), i));
  const missing = multisetMinus(ta, tb);
  const extra = multisetMinus(tb, ta);
  if (missing.length === 0 && extra.length === 0) return "order";
  if (extra.length === 0) return "missing";
  if (missing.length === 0) return "extra";
  return "value";
}

/** The first line where the two stdouts differ, with the label
 * (`#<snippet>:<observer>`) of the line that should have been printed. */
export function firstDiff(a, b) {
  const al = a.split("\n");
  const bl = b.split("\n");
  for (let i = 0; i < Math.max(al.length, bl.length); i++) {
    if (al[i] !== bl[i]) {
      // A multi-line print belongs to the last labeled line at or above it.
      let m = null;
      for (let j = i; j >= 0 && m === null; j--) m = /^#(\d+):([A-Za-z0-9-]+)/.exec(al[j] ?? "") ?? /^#(\d+):([A-Za-z0-9-]+)/.exec(bl[j] ?? "");
      return { line: i, node: al[i] ?? null, got: bl[i] ?? null, snippet: m ? Number(m[1]) : null, observer: m ? m[2] : "unlabeled", nature: diffNature(a, b, i) };
    }
  }
  return null;
}

/** The generator's snippet (`// snippet N:` marker) holding offset `pos`
 * of `text`. */
function snippetAt(text, pos) {
  const before = text.slice(0, pos);
  const i = before.lastIndexOf("// snippet ");
  if (i < 0) return null;
  const m = /^\/\/ snippet (\d+)/.exec(text.slice(i));
  return m ? Number(m[1]) : null;
}

function lineOffset(text, line) {
  const ls = text.split("\n");
  let pos = 0;
  for (let i = 0; i < line - 1 && i < ls.length; i++) pos += ls[i].length + 1;
  return pos;
}

/** Where a refusal sits, for pruning: its snippet, and the text of the
 * top-level statement holding it when that statement declares nothing
 * (an observer or a write), so the driver can drop just that statement. */
function placeRefusal(text, pos, isJs) {
  const snippet = snippetAt(text, pos);
  if (snippet === null) return null;
  const sf = ts.createSourceFile(isJs ? "main.js" : "main.ts", text, ts.ScriptTarget.Latest, true, isJs ? ts.ScriptKind.JS : ts.ScriptKind.TS);
  const st = sf.statements.find((x) => x.getStart(sf) <= pos && pos < x.getEnd());
  const droppable = st !== undefined && !isJs && (ts.isExpressionStatement(st) || ts.isBlock(st) || ts.isIfStatement(st) || ts.isForOfStatement(st) || ts.isTryStatement(st));
  return { snippet, stmt: droppable ? st.getText(sf) : null };
}

function placeAll(file, positions) {
  const text = readFileSync(file, "utf8");
  const out = [];
  for (const pos of positions) {
    const p = pos === null ? null : placeRefusal(text, pos, file.endsWith(".js"));
    if (p === null) return null;
    out.push(p);
  }
  return out;
}

function classifyRun(node, got, lane) {
  if (got.exitCode === 0 && got.stdout === node.stdout && got.stderr === node.stderr && node.exitCode === 0) return { cls: "match" };
  const code = fenceCode(got.stderr);
  if (code !== null && got.exitCode !== 0) {
    if (node.stdout.startsWith(got.stdout)) {
      const m = /\[SC\d{4} at [^\]]*?:(\d+)\]/.exec(got.stderr);
      return { cls: "refused", kind: "fence", code, msg: FENCE.exec(got.stderr)[1].slice(0, 200), fenceLine: m ? Number(m[1]) : null };
    }
    return { cls: "divergence", kind: "before-fence", code, diff: firstDiff(node.stdout, got.stdout) };
  }
  if (got.trap && got.stderr.trim() === "") return { cls: "crash", kind: "bare-trap", stdoutPrefix: node.stdout.startsWith(got.stdout) };
  if (got.signal) return { cls: "crash", kind: `signal ${got.signal}` };
  if (lane === "wasm-native" && got.exitCode !== 0 && /RuntimeError/.test(got.stderr) && !/Uncaught/.test(got.stderr)) {
    return { cls: "crash", kind: "native-trap", stderr0: got.stderr.split("\n")[0] };
  }
  if (got.exitCode !== 0) return { cls: "divergence", kind: "throws", stderr0: got.stderr.split("\n")[0], diff: firstDiff(node.stdout, got.stdout) };
  if (got.stdout !== node.stdout) return { cls: "divergence", kind: "stdout", diff: firstDiff(node.stdout, got.stdout) };
  return { cls: "divergence", kind: "stderr", stderr0: got.stderr.split("\n")[0] };
}

async function runWasmLane(binary) {
  try {
    const r = await host.runWasm(binary);
    return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode };
  } catch (e) {
    if (e instanceof WebAssembly.CompileError || e instanceof WebAssembly.LinkError) {
      return { hostError: `${e.constructor.name}: ${String(e.message).split("\n")[0]}`, invalidModule: true };
    }
    if (!(e instanceof WebAssembly.RuntimeError)) return { hostError: `${e?.constructor?.name}: ${String(e?.message ?? e).split("\n")[0]}` };
    const trapMsg = String(e.message);
    try {
      const r = await host.runWasmToTrap(binary);
      return { stdout: r.stdout, stderr: r.stderr, exitCode: 1, trap: trapMsg };
    } catch (e2) {
      return { hostError: `rerun: ${String(e2?.message ?? e2).split("\n")[0]}` };
    }
  }
}

function runNativeLane(binary) {
  const r = spawnSync(binary, [], { encoding: "utf8", input: "", timeout: NODE_TIMEOUT, maxBuffer: 64 << 20 });
  if (r.error?.code === "ETIMEDOUT") return { hostError: "timeout", timeout: true };
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", exitCode: r.status ?? 1, signal: r.signal ?? null };
}

/** Compile `file` for `lane` into `dir` and classify against `node`. */
export async function runLane(file, dir, lane, node) {
  await load();
  mkdirSync(dir, { recursive: true });
  let res;
  const t0 = Date.now();
  try {
    res = await compileFn(file, { outPath: join(dir, lane === "wasm" ? "p.wasm" : "prog"), outDir: dir, backend: lane, dynamic: false });
  } catch (e) {
    return { cls: "crash", kind: "compiler-throw", msg: String(e?.stack ?? e).split("\n").slice(0, 3).join(" | ") };
  }
  const compileMs = Date.now() - t0;
  if (!res.ok) {
    const ds = res.diagnostics ?? [];
    const codes = [...new Set(ds.map((d) => String(d.code)))];
    const first = ds[0] ? `${ds[0].code} ${String(ds[0].message).split("\n")[0]}` : "no diagnostic";
    if (codes.includes("SC9001")) return { cls: "crash", kind: "ice", codes, msg: ds.find((d) => d.code === "SC9001")?.message?.split("\n")[0] };
    if (codes.includes("SC0001")) return { cls: "invalid", kind: "tsc", codes, msg: first };
    const msgs = ds.map((d) => `${d.code} ${String(d.message).split("\n")[0]}`);
    const places = placeAll(file, ds.map((d) => (d.loc && d.loc.file === file ? d.loc.start : null)));
    return { cls: "refused", kind: "compile", codes, msg: first, msgs, compileMs, places };
  }
  const got = lane === "wasm" ? await runWasmLane(res.binaryPath) : runNativeLane(res.binaryPath);
  if (got.hostError) {
    if (got.timeout) return { cls: "crash", kind: "timeout", compileMs };
    return { cls: "crash", kind: got.invalidModule ? "invalid-module" : "host-error", msg: got.hostError, compileMs };
  }
  const c = classifyRun(node, got, lane);
  if (c.cls === "refused") {
    c.msgs = [`${c.code} ${c.msg}`];
    c.places = c.fenceLine != null ? placeAll(file, [lineOffset(readFileSync(file, "utf8"), c.fenceLine)]) : null;
    if (c.places === null) {
      // A fence with no location: blame the snippet of the first line Node
      // printed and tsinter did not.
      const missed = node.stdout.split("\n")[got.stdout.split("\n").length - 1] ?? "";
      const m = /^#(\d+):/.exec(missed);
      if (m) c.places = [{ snippet: Number(m[1]), stmt: null }];
    }
  }
  return { ...c, compileMs, got: { stdout: got.stdout, stderr: got.stderr, exitCode: got.exitCode } };
}

/** Run one program directory (holding `main.ts` or `main.js`). */
export async function runCase(dir, entryName, lanes) {
  const file = join(dir, entryName);
  const node = runNode(file);
  if (node.timedOut) return { node, invalid: "node timed out", lanes: {} };
  if (node.exitCode !== 0 || node.stderr !== "") return { node, invalid: `node exit ${node.exitCode}: ${node.stderr.split("\n").find((l) => /Error/.test(l)) ?? node.stderr.split("\n")[0]}`, lanes: {} };
  // A print naming the program's own path (an error's stack) cannot match
  // from any other directory, so it can't be compared or minimized.
  if (node.stdout.includes(dir)) return { node, invalid: "node output names the program path (a stack trace?)", lanes: {} };
  const out = {};
  for (const lane of lanes) out[lane] = await runLane(file, join(dir, lane), lane, node);
  return { node, lanes: out };
}
