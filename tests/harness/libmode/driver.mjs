/* The library-mode driver (docs/design/wasm-library-mode.md §8.1): runs a
 * row's drive script against one column and prints every observable line.
 *
 *   node --experimental-transform-types --import ./loader.mjs driver.mjs \
 *        node <rowdir> <entry> <drive.txt>
 *   node driver.mjs v8 <rowdir> <module.wasm> <drive.txt> <contract.json>
 *
 * host.c is the wasmtime column's port of the v8 half of this file.
 *
 * The drive script, one command per line (# starts a comment):
 *   call <export> [<cls>:<value> ...] [-> <cls>]
 *   repeat <n> <export> [<cls>:<value> ...] [-> <cls>]   ($i is the 0-based round)
 *   dump                                                 (the host's state)
 * Values: numbers in JS syntax (NaN, -0, Infinity, 0x..), bigints as
 * decimal, bool as true/false, string as a JSON string literal, a list as
 * a JSON array of numbers.
 *
 * The boundary contract the node column reproduces (and the module emits):
 *   - the first export call (whichever) runs module evaluation and a drain
 *     first; every call runs its body, then a drain (a profile-less module
 *     also exports an empty `_initialize`, the WASI reactor name);
 *   - a failure reports (code, text) through the profile's report import,
 *     leaves the text in the error buffer, and traps; the instance is then
 *     poisoned and every later call fails with code 4. */
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createHost, defaultClass, render, roundTrip } from "./host.mjs";
import { createMemory } from "./memory.mjs";

export const CODE_UNCAUGHT = 1;
export const CODE_FENCE = 2;
export const CODE_DEPTH = 3;
export const CODE_POISONED = 4;

const lines = [];
const out = (s) => lines.push(s);
const flushOut = () => process.stdout.write(lines.length > 0 ? lines.join("\n") + "\n" : "");

export function parseDrive(text) {
  const cmds = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/(^|\s)#.*$/, "").trim();
    if (line === "") continue;
    const toks = line.match(/\S+:"(?:[^"\\]|\\.)*"|\S+/g);
    const op = toks.shift();
    if (op === "dump") {
      cmds.push({ op });
      continue;
    }
    const times = op === "repeat" ? Number(toks.shift()) : 1;
    if (op !== "call" && op !== "repeat") throw new Error(`drive: unknown command ${op}`);
    const name = toks.shift();
    let result = null;
    const arrow = toks.indexOf("->");
    if (arrow >= 0) {
      result = toks[arrow + 1];
      toks.splice(arrow);
    }
    const args = toks.map((t) => {
      const i = t.indexOf(":");
      return { cls: t.slice(0, i), text: t.slice(i + 1) };
    });
    cmds.push({ op: "call", name, args, result, times });
  }
  return cmds;
}

export function argValue(cls, text, round) {
  const t = text.replace(/\$i/g, String(round));
  switch (cls) {
    case "f64":
    case "f32":
      return cls === "f32" ? Math.fround(Number(t)) : Number(t);
    case "s32":
    case "u32":
      return Number(t);
    case "s64":
    case "u64":
      return BigInt(t);
    case "bool":
      return t === "true";
    case "string":
      return JSON.parse(t);
    case "list<u8>":
      return new Uint8Array(JSON.parse(t));
    case "list<s32>":
      return new Int32Array(JSON.parse(t));
    case "list<u32>":
      return new Uint32Array(JSON.parse(t));
    case "list<f32>":
      return new Float32Array(JSON.parse(t));
    default:
      throw new Error(`drive: class ${cls} has no literal form`);
  }
}

/** The text a value thrown out of an export reports (the module's
 * %w.err.renderUncaught, SEMANTICS.md S007/S140). */
export function uncaughtText(e, head = "Uncaught ") {
  if (e instanceof Error) return `${head}${String(e)}`;
  if (e === null || (typeof e !== "object" && typeof e !== "function")) return `${head}${String(e)}`;
  // SEMANTICS.md S007's spellings: a class instance renders as Node's
  // String(), a value of the dynamic world (an object literal, an array)
  // as "[object]".
  const proto = Object.getPrototypeOf(e);
  if (proto === Object.prototype || proto === null || Array.isArray(e)) return `${head}[object]`;
  return `${head}[object Object]`;
}

/** The boundary check for a value leaving TypeScript in class `cls`
 * (SEMANTICS.md S143): null when it fits, else the fence text's tail. */
export function outboundMisfit(cls, v) {
  const range = (lo, hi) => (typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi ? null : String(v));
  switch (cls) {
    case "s32":
      return range(-2147483648, 2147483647);
    case "u32":
      return range(0, 4294967295);
    case "s64":
      return BigInt.asIntN(64, v) === v ? null : String(v);
    case "u64":
      return BigInt.asUintN(64, v) === v ? null : String(v);
    default:
      return null;
  }
}

/** The error buffer's text, as the module builds it (SEMANTICS.md S140):
 * the failure's line plus "\n", UTF-8 (a lone surrogate is U+FFFD), cut at
 * the buffer's 4,096 bytes, then one trailing newline dropped. */
const ERR_CAP = 4096;
export function bufferText(line) {
  const bytes = new TextEncoder().encode(line.toWellFormed() + "\n").subarray(0, ERR_CAP);
  const end = bytes.length > 0 && bytes[bytes.length - 1] === 0x0a ? bytes.length - 1 : bytes.length;
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes.subarray(0, end));
}

class Failure {
  constructor(code, text) {
    this.code = code;
    this.text = bufferText(text);
  }
}

function hostModulesOf(rowDir, profile) {
  if (profile !== null) return Object.keys(profile.imports ?? {});
  const names = new Set();
  for (const f of readdirRec(rowDir)) {
    if (!f.endsWith(".d.ts")) continue;
    for (const m of readFileSync(f, "utf8").matchAll(/declare\s+module\s+"([^"]+)"/g)) names.add(m[1]);
  }
  return [...names];
}

function readdirRec(dir) {
  const { readdirSync, statSync } = globalThisFs;
  const outFiles = [];
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) outFiles.push(...readdirRec(p));
    else outFiles.push(p);
  }
  return outFiles;
}
const globalThisFs = await import("node:fs");

function loadProfile(rowDir) {
  try {
    return JSON.parse(readFileSync(join(rowDir, "profile.json"), "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

/** SEMANTICS.md S146 in the node column: the observation points the module
 * canonicalizes — DataView and Buffer float writes (typed-array element
 * stores cannot be hooked; rows observe NaN bits through these). */
function canonicalizeNaNWrites() {
  const wrap = (proto, name, valueArg) => {
    const orig = proto[name];
    proto[name] = function (...a) {
      if (typeof a[valueArg] === "number" && Number.isNaN(a[valueArg])) a[valueArg] = NaN;
      return orig.apply(this, a);
    };
  };
  for (const n of ["setFloat32", "setFloat64"]) wrap(DataView.prototype, n, 1);
  for (const n of ["writeFloatLE", "writeFloatBE", "writeDoubleLE", "writeDoubleBE"]) wrap(Buffer.prototype, n, 0);
}

/** ── the node column ─────────────────────────────────────────────────── */
async function runNode(rowDir, entry, drivePath, contract) {
  canonicalizeNaNWrites();
  // Constant exports (the compiler's contract marks them) answer without
  // module evaluation; once the module is evaluated, each constant is
  // checked against the real export (a mismatch prints, and fails the row).
  // Their values come from Node itself: a throwaway process evaluates the
  // module and calls the export (this instance's evaluation stays untouched).
  const constants = new Map();
  for (const e of (contract?.exports ?? []).filter((x) => x.constant === true)) {
    const here = new URL(".", import.meta.url).href;
    const script =
      `const { createHost } = await import(${JSON.stringify(here + "host.mjs")});` +
      `const { createMemory } = await import(${JSON.stringify(here + "memory.mjs")});` +
      `globalThis.__libmem = createMemory((t) => { throw new Error(t); });` +
      `const h = createHost(() => {}, () => globalThis.__libmem.bytes);` +
      `globalThis.__libhost = { bind: (m, n) => (...a) => (h.table[n].params[0] === "*" ? h.table[n].fn("f64", a[0]) : h.table[n].fn(...a)) };` +
      `Math.random = () => 0.5;` +
      `const m = await import(${JSON.stringify(pathToFileURL(resolve(entry)).href)}); const v = m[${JSON.stringify(e.name)}]();` +
      `process.stdout.write(Object.is(v, -0) ? "-0" : JSON.stringify(v));`;
    const r = spawnSync(process.execPath, [...process.execArgv, "--input-type=module", "-e", script], { encoding: "utf8", env: process.env });
    if (r.status !== 0) throw new Error(`node column: evaluating constant export ${e.name} failed:\n${r.stderr}`);
    constants.set(e.name, r.stdout === "-0" ? -0 : JSON.parse(r.stdout));
  }
  const constantChecks = [];
  const profile = loadProfile(rowDir);
  const report = profile?.report ?? null;
  const memory = createMemory((text) => {
    throw new Failure(CODE_FENCE, text);
  });
  globalThis.__libmem = memory;
  const host = createHost(out, () => memory.bytes);
  const classesOf = (mod, name) => profile?.imports?.[mod]?.[name] ?? null;
  // The boundary in JS: each import checks what leaves TypeScript and hands
  // back what the module's view of the host's answer would be.
  globalThis.__libhost = {
    bind(mod, name) {
      const imp = host.table[name];
      if (imp === undefined) throw new Error(`host has no ${mod}.${name}`);
      const decl = classesOf(mod, name);
      return (...args) => {
        const conv = args.map((a, i) => {
          const cls = decl !== null ? decl.params[i][1] : defaultClass(a);
          const bad = outboundMisfit(cls, a);
          if (bad !== null) throw new Failure(CODE_FENCE, `tsinter: argument ${i + 1} of ${mod}.${name} is not a ${cls}: ${bad}`);
          // SEMANTICS.md S146: a NaN crosses as the canonical NaN; S144: the
          // host sees UTF-8, so a lone surrogate arrives as U+FFFD
          const v = (cls === "f64" || cls === "f32") && Number.isNaN(a) ? NaN : a;
          if (cls === "list<f32>" || cls === "list<f64>") return { cls, v: Array.from(v, (x) => (Number.isNaN(x) ? NaN : x)) };
          return { cls, v: cls === "f32" ? Math.fround(v) : cls === "string" ? v.toWellFormed() : v };
        });
        const r = imp.params[0] === "*" ? imp.fn(conv[0].cls, conv[0].v) : imp.fn(...conv.map((c) => c.v));
        if (imp.result === null) return undefined;
        const rcls = decl !== null ? (decl.result ?? null) : imp.result === "u64" || imp.result === "s64" ? "s64" : imp.result === "bool" ? "bool" : "f64";
        return rcls === null ? undefined : roundTrip(rcls, r);
      };
    },
  };
  // SEMANTICS.md S141: Math.random is the host's stream.
  const rnd = profile !== null ? Object.entries(profile.imports ?? {}).flatMap(([m, fs]) => Object.entries(fs).filter(([, f]) => f.role === "random").map(([n]) => [m, n]))[0] : undefined;
  Math.random = () => {
    if (rnd === undefined) throw new Error("node column: Math.random with no role:random import");
    const x = BigInt.asUintN(64, BigInt(host.table[rnd[1]].fn()));
    return Number(x >> 11n) * (1 / 2 ** 53);
  };
  let rejection = null;
  process.on("unhandledRejection", (reason) => {
    if (rejection === null) rejection = reason;
  });
  const drain = async () => {
    await new Promise((r) => setImmediate(r));
    if (rejection !== null) {
      const r = rejection;
      rejection = null;
      throw new Failure(CODE_UNCAUGHT, uncaughtText(r, "Unhandled promise rejection: "));
    }
  };
  let mod = null;
  let poisoned = false;
  const fail = (name, f) => {
    if (report !== null) {
      const imp = host.table[report.name];
      const text = (report.prefix ?? "") + f.text;
      if (imp.params.length === 2) imp.fn(f.code, text);
      else imp.fn(text);
    }
    out(`${name} trapped`);
    out(`error ${render("string", f.text)}`);
    poisoned = true;
  };
  const call = async (name, args, resCls) => {
    // A constant export answers on any instance, stopped or not.
    if (constants.has(name) && resCls !== null) {
      if (mod === null) constantChecks.push(name);
      out(`${name} -> ${render(resCls, roundTrip(resCls, constants.get(name)))}`);
      return;
    }
    if (poisoned) return fail(name, new Failure(CODE_POISONED, `tsinter: ${name}: the instance stopped at an earlier failure`));
    try {
      // Module evaluation runs at the start of the FIRST export call,
      // whichever export it is — under Node the module is evaluated before
      // any export can be called.
      // The scratch arena is this call's before module evaluation runs (the
      // module decodes its arguments first, then resets it).
      memory.reset();
      if (mod === null) {
        mod = await importEntry(entry);
        await drain();
        for (const c of constantChecks.splice(0)) {
          if (mod[c]() !== constants.get(c)) out(`constant export ${c} answered ${String(mod[c]())}, not its contract value ${String(constants.get(c))}`);
        }
      }
      const fn = mod[name];
      let r;
      if (fn !== undefined) {
        try {
          r = fn(...args.map((a) => (typeof a === "string" ? a.toWellFormed() : a)));
        } catch (e) {
          if (e instanceof Failure) throw e;
          throw new Failure(CODE_UNCAUGHT, uncaughtText(e));
        }
      } else if (name !== "_initialize") {
        throw new Error(`node column: the entry exports no ${name}`);
      }
      await drain();
      if (resCls !== null) {
        const bad = outboundMisfit(resCls, r);
        if (bad !== null) throw new Failure(CODE_FENCE, `tsinter: the result of ${name} is not a ${resCls}: ${bad}`);
        out(`${name} -> ${render(resCls, roundTrip(resCls, r))}`);
        // a pointer result's buffer comes from the heap (S147)
        if (resCls === "string") memory.putResult(name, new TextEncoder().encode(r.toWellFormed()).length);
        else if (resCls.startsWith("list<")) memory.putResult(name, r.byteLength);
      }
    } catch (e) {
      if (!(e instanceof Failure)) throw e;
      fail(name, e);
    }
  };
  for (const cmd of parseDrive(readFileSync(drivePath, "utf8"))) {
    if (cmd.op === "dump") host.dump();
    else for (let i = 0; i < cmd.times; i++) await call(cmd.name, cmd.args.map((a) => argValue(a.cls, a.text, i)), cmd.result);
  }
  flushOut();
  void hostModulesOf;
}

/** Module evaluation errors surface from import(); they are the init
 * export's uncaught exception. */
async function importEntry(entry) {
  try {
    return await import(pathToFileURL(resolve(entry)).href);
  } catch (e) {
    throw new Failure(CODE_UNCAUGHT, uncaughtText(e));
  }
}

/** ── the v8 column ───────────────────────────────────────────────────── */
async function runV8(wasmPath, drivePath, contract) {
  const bytes = readFileSync(wasmPath);
  let inst = null;
  const mem = () => new Uint8Array(inst.exports.memory.buffer);
  const host = createHost(out, mem);
  const dec = new TextDecoder("utf-8", { ignoreBOM: true });
  const imports = {};
  for (const imp of contract.imports) {
    const impl = host.table[imp.name];
    if (impl === undefined) throw new Error(`host has no ${imp.module}.${imp.name}`);
    (imports[imp.module] ??= {})[imp.name] = (...raw) => {
      const vals = [];
      let k = 0;
      for (const cls of imp.params) {
        if (cls === "string" || cls.startsWith("list<")) {
          const p = raw[k++] >>> 0;
          const n = raw[k++] >>> 0;
          vals.push({ cls, v: cls === "string" ? dec.decode(mem().subarray(p, p + n)) : readList(mem(), cls, p, n) });
        } else {
          vals.push({ cls, v: fromWasm(cls, raw[k++]) });
        }
      }
      const r = impl.params[0] === "*" ? impl.fn(vals[0].cls, vals[0].v) : impl.fn(...vals.map((x) => x.v));
      if (imp.result === null) return undefined;
      return toWasm(imp.result, r);
    };
  }
  const { instance } = await WebAssembly.instantiate(bytes, imports);
  inst = instance;
  const ex = inst.exports;
  const errorText = () => {
    const p = ex.tsinter_error_ptr() >>> 0;
    const n = ex.tsinter_error_len() >>> 0;
    return dec.decode(mem().subarray(p, p + n));
  };
  for (const cmd of parseDrive(readFileSync(drivePath, "utf8"))) {
    if (cmd.op === "dump") {
      host.dump();
      continue;
    }
    for (let i = 0; i < cmd.times; i++) {
      const fn = ex[cmd.name];
      if (typeof fn !== "function") throw new Error(`v8 column: the module exports no ${cmd.name}`);
      const args = [];
      for (const a of cmd.args) {
        const v = argValue(a.cls, a.text, i);
        if (a.cls === "string" || a.cls.startsWith("list<")) {
          const b = a.cls === "string" ? new TextEncoder().encode(v) : new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
          const p = ex[contract.alloc](b.length) >>> 0;
          mem().set(b, p);
          args.push(p, a.cls === "string" ? b.length : v.length);
        } else args.push(toWasm(a.cls, v));
      }
      let r;
      try {
        r = fn(...args);
      } catch (e) {
        // A trap, or V8's own stack overflow (a JS RangeError the module
        // cannot catch: wasm has no exception handling here; the instance
        // stops at its next call, S140/S142)
        if (!(e instanceof WebAssembly.RuntimeError) && !(e instanceof RangeError)) throw e;
        out(`${cmd.name} trapped`);
        out(`error ${render("string", errorText())}`);
        continue;
      }
      if (cmd.result === "string") {
        const p = ex[`${cmd.name}_result_ptr`]() >>> 0;
        const n = ex[`${cmd.name}_result_len`]() >>> 0;
        out(`${cmd.name} -> ${render("string", dec.decode(mem().subarray(p, p + n)))}`);
      } else if (cmd.result !== null && cmd.result.startsWith("list<")) {
        const p = ex[`${cmd.name}_result_ptr`]() >>> 0;
        const n = ex[`${cmd.name}_result_len`]() >>> 0;
        out(`${cmd.name} -> ${render(cmd.result, readList(mem(), cmd.result, p, n))}`);
      } else if (cmd.result !== null) out(`${cmd.name} -> ${render(cmd.result, fromWasm(cmd.result, r))}`);
    }
  }
  flushOut();
}

function fromWasm(cls, v) {
  switch (cls) {
    case "u32":
      return v >>> 0;
    case "s32":
      return v | 0;
    case "u64":
      return BigInt.asUintN(64, v);
    case "s64":
      return BigInt.asIntN(64, v);
    case "bool":
      return v !== 0;
    case "f32":
    case "f64":
      return v;
    default:
      throw new Error(`fromWasm: ${cls}`);
  }
}

function toWasm(cls, v) {
  switch (cls) {
    case "bool":
      return v ? 1 : 0;
    case "s64":
    case "u64":
      return BigInt.asIntN(64, BigInt(v));
    default:
      return Number(v);
  }
}

function readList(m, cls, p, n) {
  const dv = new DataView(m.buffer, m.byteOffset);
  const elem = cls.slice(5, -1);
  const size = elem === "u8" ? 1 : elem === "f64" ? 8 : 4;
  const outArr = [];
  for (let i = 0; i < n; i++) {
    const at = p + i * size;
    outArr.push(elem === "u8" ? dv.getUint8(at) : elem === "u32" ? dv.getUint32(at, true) : elem === "s32" ? dv.getInt32(at, true) : elem === "f32" ? dv.getFloat32(at, true) : dv.getFloat64(at, true));
  }
  return outArr;
}

const [mode, ...rest] = process.argv.slice(2);
if (mode === "node") await runNode(rest[0], rest[1], rest[2], rest[3] !== undefined ? JSON.parse(readFileSync(rest[3], "utf8")) : null);
else if (mode === "v8") await runV8(rest[1], rest[2], JSON.parse(readFileSync(rest[3], "utf8")));
else if (mode !== undefined) throw new Error(`driver: unknown mode ${mode}`);
