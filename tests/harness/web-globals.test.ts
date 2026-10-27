/* The island's web-platform globals — the scriptc-ONLY half of the story.
 * Value behavior is differential (the web-streams npm fixture runs against
 * Node's real WHATWG streams); what lives here is what Node CANNOT oracle:
 * the fences. The island implements the subset the AI-SDK/eventsource-parser
 * paths exercise and rejects the rest with clear errors instead of silently
 * misbehaving — these tests pin the fence messages so the subset statement
 * in SEMANTICS.md stays honest.
 *
 * SCRIPTC_SAN=1 builds with ASan + the RC audit; the island's counting
 * allocator asserts zero live engine allocations at teardown.
 *
 * Phase 2 E2: the globals are ONE text (packages/runtime/src/
 * scr_web_prelude.h) evaluated by the native island AND by the WasmGC
 * tier's engine, so every row runs on both lanes (the wasm arm in the
 * plain lane only — sanitizing is a native concept) and must print the
 * same thing. The globals neither lane has (WritableStream, FormData,
 * WebSocket) are a named fence on both (SEMANTICS.md S103 (b)).
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { compile } from "@tsinter/compiler";
import { runWasm } from "../../packages/compiler/test/wasm-host.js";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const cacheDir = join(repoRoot, "node_modules/.cache/scriptc-tests");
const sanitize = process.env["SCRIPTC_SAN"] === "1";

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

type Lane = "native" | "wasm";

/** Compiles an inline --dynamic program and runs it (nonzero exit ok). */
async function compileAndRun(lane: Lane, name: string, source: string): Promise<RunResult> {
  const key = createHash("sha256")
    .update(source)
    .update(sanitize ? "san" : "plain")
    .update(lane)
    .digest("hex")
    .slice(0, 16);
  const outDir = join(cacheDir, `web-${key}`);
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `${name}.ts`);
  writeFileSync(file, source);
  if (lane === "wasm") {
    const result = await compile(file, { outPath: join(outDir, `${name}.wasm`), outDir, backend: "wasm", dynamic: true });
    if (!result.ok) {
      throw new Error("web-globals program refused on wasm:\n" + result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    }
    const r = await runWasm(result.binaryPath);
    return { stdout: String(r.stdout), stderr: String(r.stderr), exitCode: r.exitCode };
  }
  // Deliberately NO backend pin: these are flagless-user-shaped --dynamic
  // builds, so the suite rides the release default (LLVM where the tier
  // claims the program, the transparent C fallback where it refuses). The
  // fence MESSAGES asserted below come from the island runtime the two
  // backends share, so they are lane-invariant by construction.
  const result = await compile(file, {
    outPath: join(outDir, name),
    outDir,
    sanitize,
    dynamic: true,
  });
  if (!result.ok) {
    throw new Error(
      "web-globals program failed to compile:\n" +
        result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"),
    );
  }
  try {
    const { stdout, stderr } = await execFileAsync(result.binaryPath, [], { encoding: "utf8" });
    return { stdout, stderr, exitCode: 0 };
  } catch (err) {
    const e = err as { code?: unknown; stdout?: string; stderr?: string };
    if (typeof e.code !== "number") throw err;
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", exitCode: e.code };
  }
}

/** Evaluates island code that must produce a one-line string. */
async function islandEval(lane: Lane, name: string, js: string): Promise<string> {
  const r = await compileAndRun(lane, name, `console.log(__island_eval(${JSON.stringify(js)}));\n`);
  expect(r.exitCode).toBe(0);
  expect(r.stderr).toBe("");
  return r.stdout.trimEnd();
}

const lanes: Lane[] = sanitize ? ["native"] : ["native", "wasm"];

for (const lane of lanes)
describe(`island web globals (scriptc-only, ${lane}${sanitize ? ", sanitized" : ""})`, () => {
  test("the subset is present; the fenced-by-absence globals are not", async () => {
    const out = await islandEval(
      lane,
      "web-presence",
      `[
        typeof ReadableStream, typeof TransformStream, typeof TextEncoder,
        typeof TextDecoder, typeof TextDecoderStream, typeof URLSearchParams,
        typeof btoa, typeof atob, typeof Headers, typeof crypto, typeof console,
        typeof Blob, typeof File, typeof Event, typeof EventTarget, typeof CustomEvent,
        typeof structuredClone, typeof DOMException, typeof AbortController,
        typeof AbortSignal, typeof MessageChannel, typeof Request, typeof Response,
        ...['Writable' + 'Stream', 'Form' + 'Data', 'Web' + 'Socket'].map((n) => {
          try { return typeof globalThis[n]; } catch (e) { return 'fenced'; }
        }),
      ].join(' ')`,
    );
    // Blob/File and the Event triple joined the subset when the vercel
    // CLI's graph started loading undici (its fileapi classes extend
    // Event and buffer.Blob at LOAD); structuredClone joined with the
    // globals lane (the HTML StructuredSerialize subset, cycles
    // included); WritableStream/FormData/WebSocket are in neither lane:
    // a named fence on both (SEMANTICS.md S103 (b); their names are
    // spelled by concatenation so the wasm build-time fence lets the row
    // build).
    expect(out).toBe(
      "function function function function function function " +
        "function function function object object " +
        "function function function function function " +
        "function function function function function function function " +
        "fenced fenced fenced",
    );
  });

  test("structuredClone clones deep (cycles included) and validates options like Node", async () => {
    const out = await islandEval(
      lane,
      "web-structured-clone",
      `(() => {
        const grab = (f) => { try { return String(f()); } catch (e) { return e.name + '/' + (e.code || '') + ': ' + e.message; } };
        const cyc = { n: 1 }; cyc.self = cyc;
        const cloned = structuredClone(cyc);
        const m = structuredClone(new Map([['k', [1, 2]]]));
        const dx = structuredClone(new DOMException('t', 'DataCloneError'));
        return [
          cloned !== cyc && cloned.self === cloned && cloned.n === 1,
          m.get('k').join(','),
          dx.name + ':' + dx.message + ':' + (dx instanceof DOMException),
          grab(() => structuredClone()),
          grab(() => structuredClone(undefined, '')),
          grab(() => structuredClone(undefined, { transfer: '' })),
          grab(() => structuredClone({}, { transfer: { *[Symbol.iterator]() {} } })) === '[object Object]',
          grab(() => structuredClone(() => {})),
        ].join(' | ');
      })()`,
    );
    expect(out).toBe(
      [
        "true",
        "1,2",
        "DataCloneError:t:true",
        'TypeError/ERR_MISSING_ARGS: The "The value argument must be specified" argument must be specified',
        "TypeError/ERR_INVALID_ARG_TYPE: Failed to execute 'structuredClone': Options cannot be converted to a dictionary",
        "TypeError/ERR_INVALID_ARG_TYPE: Failed to execute 'structuredClone': transfer in Options cannot be converted to sequence.",
        "true",
        "DataCloneError/25: () => {} could not be cloned.",
      ].join(" | "),
    );
  });

  test("MessageChannel/MessagePort are globals; every way to start delivery is fenced by name (S108 (h))", async () => {
    const out = await islandEval(
      lane,
      "web-messagechannel",
      `(() => {
        const grab = (f) => { try { f(); return 'no-throw'; } catch (e) { return e.message; } };
        const ch = new MessageChannel();
        ch.port1.postMessage({ a: [1, 2] });
        return [
          typeof MessageChannel, typeof MessagePort, ch.port2 instanceof MessagePort, ch.port2 instanceof EventTarget,
          grab(() => { ch.port2.onmessage = () => {}; }),
          grab(() => ch.port2.start()),
          grab(() => ch.port2.addEventListener('message', () => {})),
          grab(() => ch.port2.on('message', () => {})),
          grab(() => ch.port2.addEventListener('other', () => {})),
          grab(() => ch.port1.close()),
        ].join(' | ');
      })()`,
    );
    const fence = (what: string): string => `MessagePort ${what} is not supported in the scriptc island (no task source delivers port messages)`;
    expect(out).toBe(
      [
        "function", "function", "true", "true",
        fence("message delivery (onmessage)"), fence("message delivery (start)"), fence("'message' events"), fence("'message' events"),
        "no-throw", "no-throw",
      ].join(" | "),
    );
  });

  test("tee, pipeTo, BYOB readers, and byte streams are fenced with clear errors", async () => {
    const out = await islandEval(
      lane,
      "web-fences",
      `(() => {
        const grab = (f) => { try { f(); return 'no-throw'; } catch (e) { return e.message; } };
        return [
          grab(() => new ReadableStream().tee()),
          grab(() => new ReadableStream().pipeTo({})),
          grab(() => new ReadableStream().getReader({ mode: 'byob' })),
          grab(() => new ReadableStream({ type: 'bytes' })),
        ].join(' | ');
      })()`,
    );
    expect(out).toBe(
      [
        "ReadableStream.tee is not supported in the scriptc island",
        "ReadableStream.pipeTo is not supported in the scriptc island (use pipeThrough or a reader)",
        "BYOB readers are not supported in the scriptc island",
        "byte streams (type: 'bytes') are not supported in the scriptc island",
      ].join(" | "),
    );
  });

  test("TextDecoder is utf-8 only; base64 rejects like the platform", async () => {
    const out = await islandEval(
      lane,
      "web-encoder-fences",
      `(() => {
        const grab = (f) => { try { f(); return 'no-throw'; } catch (e) { return e.name + ': ' + e.message; } };
        return [
          grab(() => new TextDecoder('latin1')),
          grab(() => atob('a')),
          grab(() => atob('a$==')),
          grab(() => btoa('é😀')),
        ].join(' | ');
      })()`,
    );
    expect(out).toBe(
      [
        "RangeError: the scriptc island's TextDecoder supports utf-8 only (got 'latin1')",
        "InvalidCharacterError: The string to be decoded is not correctly encoded.",
        "InvalidCharacterError: Invalid character",
        "InvalidCharacterError: Invalid character",
      ].join(" | "),
    );
  });

  /* ── Node-differential rows (phase 2 E2 review): each snippet's answer
   * is compared with Node's own, computed live in this process — the
   * snippet evaluated the way the corpus oracle does (String((0, eval)(js))). */
  const differential = (name: string, js: string): void => {
    test(`matches Node: ${name}`, async () => {
      const node = String((0, eval)(js));
      const out = await islandEval(lane, `web-diff-${name.replace(/[^a-z0-9]+/gi, "-")}`, js);
      expect(out).toBe(node);
    });
  };
  const GRAB = `const grab = (f) => { try { const v = f(); return typeof v === 'string' ? JSON.stringify(v) : String(v); } catch (e) { return 'THROW ' + Object.prototype.toString.call(e) + ' ' + e.name + ' ' + e.code + ' ' + (e instanceof DOMException) + ' ' + (e instanceof Error) + ': ' + e.message; } };`;
  differential(
    "URLSearchParams decodes and encodes by code point; inputs are USVStrings",
    `(() => { ${GRAB} return [
      grab(() => new URLSearchParams('k=😀').get('k')),
      grab(() => new URLSearchParams('😀=5&k=a%F0%9F%98%80b€').toString()),
      grab(() => { const p = new URLSearchParams(); p.append('k', '\\ud800'); p.set('\\udc00', 'x'); return JSON.stringify([...p]); }),
      grab(() => new URLSearchParams('a=%F0%9F%98%80&b=%ED%A0%80&c=%FF&%&%zz=%41&+%2B=%20+').toString()),
      grab(() => new URLSearchParams([['k', '\\ud800x\\udc00']]).toString()),
      grab(() => new URLSearchParams(123).toString()),
      grab(() => new URLSearchParams({ a: 1, b: null }).toString()),
      grab(() => { const p = new URLSearchParams('z=1&a=2&é=3&😀=5&￿=6&a=7&Z=8'); p.sort(); return p.toString(); }),
    ].join(' | '); })()`,
  );
  differential(
    "URLSearchParams keeps its state private; iterators are live and tagged",
    `(() => { ${GRAB} return [
      grab(() => { const p = new URLSearchParams('a=1'); return JSON.stringify(p) + Object.keys(p).length + Object.getOwnPropertyNames(p).length; }),
      grab(() => { const p = new URLSearchParams('a=1&b=2&c=3'); const r = []; for (const [k] of p) { r.push(k); if (k === 'a') p.delete('a'); } return r.join(); }),
      grab(() => { const p = new URLSearchParams('a=1'); const it = p.entries(); p.append('b', '2'); return JSON.stringify([...it]); }),
      grab(() => { const p = new URLSearchParams('a=1'); return [p[Symbol.iterator] === p.entries, Object.prototype.toString.call(p), Object.prototype.toString.call(p.keys()), typeof p.keys()[Symbol.iterator], p.size].join(); }),
      grab(() => Object.getOwnPropertyNames(URLSearchParams.prototype).join()),
    ].join(' | '); })()`,
  );
  differential(
    "URLSearchParams validates arguments as Node does",
    `(() => { ${GRAB} return [
      grab(() => new URLSearchParams('a=1').get()),
      grab(() => new URLSearchParams('a=1').append('x')),
      grab(() => new URLSearchParams('a=1').set('x')),
      grab(() => new URLSearchParams('a=1').delete()),
      grab(() => new URLSearchParams(['ab'])),
      grab(() => new URLSearchParams([['a', 1, 2]])),
      grab(() => new URLSearchParams([null])),
      grab(() => URLSearchParams.prototype.size),
      grab(() => URLSearchParams.prototype.get.call({}, 'a')),
      grab(() => new URLSearchParams('a=1').forEach(5)),
      grab(() => new URLSearchParams('a=1').keys().next.call({})),
    ].join(' | '); })()`,
  );
  differential(
    "structuredClone of errors and of uncloneables",
    `(() => { ${GRAB} const show = (e) => { const c = structuredClone(e); return [Object.prototype.toString.call(c), c.constructor.name, c.name, JSON.stringify(c.message), 'cause' in c ? JSON.stringify(c.cause) : '-', typeof c.stack, c.stack === e.stack, Object.keys(c).length].join(','); }; return [
      grab(() => show(new RangeError('boom'))),
      grab(() => show(new TypeError('t', { cause: { a: [1] } }))),
      grab(() => { const e = new Error('m'); e.name = 'Custom'; e.extra = 5; return show(e); }),
      grab(() => { const e = new Error('m'); e.name = 'TypeError'; return show(e); }),
      grab(() => show(new AggregateError([1], 'agg'))),
      grab(() => { const o = { e: new Error('q') }; o.f = o.e; const c = structuredClone(o); return c.e === c.f; }),
      grab(() => structuredClone(() => 1)),
      grab(() => structuredClone(Symbol('x'))),
      grab(() => { const d = structuredClone(new DOMException('m', 'NotFoundError')); return [d.name, d.message, d.code, d instanceof DOMException].join(); }),
    ].join(' | '); })()`,
  );
  differential(
    "Headers yields each set-cookie, validates like undici",
    `(() => { ${GRAB} return [
      grab(() => { const h = new Headers({ 'Content-Type': 'a', 'X-B': '1' }); h.append('x-b', '2'); h.append('set-cookie', 'a'); h.append('Set-Cookie', 'b'); h.append('cookie', 'c1'); h.append('cookie', 'c2'); return [...h].map((p) => p.join(':')).join(';') + '|' + h.get('set-cookie') + '|' + JSON.stringify(h.getSetCookie()) + '|' + [...h.keys()].join(); }),
      grab(() => new Headers().append('bad name', 'x')),
      grab(() => new Headers().append('x', 'a\\nb')),
      grab(() => new Headers().get('bad name')),
      grab(() => new Headers().append('x')),
      grab(() => new Headers().set('x', 'é€')),
      grab(() => new Headers(5)),
      grab(() => new Headers([['a']])),
      grab(() => { const h = new Headers([['b', ' 2 '], ['a', '1']]); const r = []; h.forEach((v, k) => r.push(k + '=' + v)); return r.join() + Object.prototype.toString.call(h) + Object.prototype.toString.call(h.entries()); }),
      grab(() => Headers.prototype.get.call({}, 'a')),
    ].join(' | '); })()`,
  );
  differential(
    "base64 and crypto errors are Node's DOMExceptions; DOMException is Node's",
    `(() => { ${GRAB} return [
      grab(() => btoa('€')), grab(() => btoa()), grab(() => btoa(null)),
      grab(() => atob('a')), grab(() => atob('a!')), grab(() => atob('a=')), grab(() => atob('YQ=')), grab(() => atob('a===')),
      grab(() => atob('YQ\\t\\n\\f\\r==')), grab(() => atob('YR==')), grab(() => atob('ab=c')), grab(() => atob('aaaaa')), grab(() => atob()),
      grab(() => crypto.getRandomValues(new Float64Array(2))), grab(() => crypto.getRandomValues(new Uint8Array(65537))),
      grab(() => crypto.getRandomValues()), grab(() => { const f = crypto.getRandomValues; return f(new Uint8Array(2)); }),
      grab(() => crypto.getRandomValues([1])), grab(() => crypto.getRandomValues(new DataView(new ArrayBuffer(2)))),
      grab(() => new Crypto()), grab(() => Object.prototype.toString.call(crypto)),
      grab(() => [new DOMException('m', 'NotFoundError').code, new DOMException('m').name, new DOMException('m') instanceof Error, DOMException.NOT_FOUND_ERR, DOMException.prototype.DATA_CLONE_ERR, new DOMException('x', 'ValidationError').code, String(new DOMException('msg', 'SyntaxError')), Object.prototype.toString.call(new DOMException()), Object.keys(new DOMException('a')).length].join()),
      grab(() => { const d = new DOMException('m', { name: 'AbortError', cause: 7 }); return d.name + d.code + d.cause; }),
      grab(() => Object.getOwnPropertyDescriptor(DOMException.prototype, 'name').get.call({})),
    ].join(' | '); })()`,
  );
  differential(
    "TextEncoder.encodeInto, TextDecoder labels and argument checks",
    `(() => { ${GRAB} return [
      grab(() => JSON.stringify(new TextEncoder().encodeInto('a😀é', new Uint8Array(4)))),
      grab(() => { const u = new Uint8Array(10); return JSON.stringify(new TextEncoder().encodeInto('a😀é\\ud800', u)) + [...u]; }),
      grab(() => JSON.stringify(new TextEncoder().encodeInto('é€', new Uint8Array(2)))),
      grab(() => new TextEncoder().encodeInto('a', [])), grab(() => new TextEncoder().encodeInto(5, new Uint8Array(1))),
      grab(() => new TextEncoder().encode(null).join()), grab(() => new TextEncoder().encode(undefined).length),
      grab(() => ['utf8', 'UTF-8', ' utf-8 ', 'unicode-1-1-utf-8', 'unicode11utf8', 'unicode20utf8', 'x-unicode20utf8', undefined].map((l) => new TextDecoder(l).encoding).join()),
      grab(() => new TextDecoder('bogus')), grab(() => new TextDecoder(null)),
      grab(() => new TextDecoder('utf-8', 5)), grab(() => new TextDecoder().decode(new Uint8Array([0x41]), 5)),
      grab(() => new TextDecoder().decode('abc')), grab(() => new TextDecoder().decode(new Uint8Array([0x41]), { stream: true }) + new TextDecoder().decode('x', { stream: true })),
      grab(() => new TextDecoder().decode(new SharedArrayBuffer(2))),
      grab(() => new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array([0xff]))),
      grab(() => [new TextDecoder('utf-8', { fatal: 1, ignoreBOM: 'yes' }).fatal, new TextDecoder('utf-8', null).fatal].join()),
      grab(() => Object.getOwnPropertyDescriptor(TextDecoder.prototype, 'encoding').get.call({})),
      grab(() => TextEncoder.prototype.encode.call({})),
    ].join(' | '); })()`,
  );
  differential(
    "Symbol.toStringTag of the web classes",
    `(() => { const t = (o) => Object.prototype.toString.call(o); const ts = new TransformStream(); return [
      t(new TextEncoder()), t(new TextDecoder()), t(new URLSearchParams()), t(new URLSearchParams().values()), t(new Event('x')), t(new CustomEvent('x')),
      t(new EventTarget()), t(new AbortController()), t(AbortSignal.abort()), t(console), t(new Headers()), t(new Headers().keys()),
      t(new Request('http://x/')), t(new Response()), t(new Blob()), t(new File([], 'f')), t(new DOMException()), t(new ReadableStream()), t(ts),
      t(new MessageEvent('m')), t(new MessageChannel()), t(new MessageChannel().port1), t(crypto),
    ].join(' '); })()`,
  );
  differential(
    "the globals' property shapes",
    `(() => ['TextEncoder', 'URLSearchParams', 'atob', 'btoa', 'structuredClone', 'crypto', 'Crypto', 'DOMException', 'Headers', 'ReadableStream', 'MessagePort', 'Event'].map((n) => { const d = Object.getOwnPropertyDescriptor(globalThis, n); return n + ':' + ('get' in d ? 'accessor' : 'data') + d.enumerable + d.configurable; }).join(' '))()`,
  );
  differential(
    "builtins the engine has and Node 24 does not are gone",
    `[typeof Math.sumPrecise, typeof Map.prototype.getOrInsert, typeof WeakMap.prototype.getOrInsertComputed, typeof globalThis.InternalError, typeof Uint8Array.fromBase64, typeof Uint8Array.prototype.toHex, typeof ArrayBuffer.prototype.transferToImmutable, typeof Iterator.concat, 'fileName' in Function.prototype, 'lineNumber' in Function.prototype].join()`,
  );

  differential(
    "the classes' state is invisible to Object.keys and JSON.stringify",
    `[new Event('x'), new CustomEvent('x', { detail: 1 }), new Response('b'), new Request('http://x/'), new AbortController(), AbortSignal.abort(), new Blob(['a']), new File(['a'], 'f'), new Headers({ a: '1' }), new URLSearchParams('a=1'), new TextDecoder(), new EventTarget()].map((o) => JSON.stringify(o) + Object.keys(o).length).join(' ')`,
  );

  differential(
    "structuredClone follows V8's serializer",
    `(() => { const out = []; const t = (n, f) => { try { out.push(n + ' OK ' + f()); } catch (e) { out.push(n + ' THROW ' + e.name + ' ' + e.constructor.name + ' ' + JSON.stringify(e.message) + ' ' + e.code); } };
      const sc = structuredClone, tag = (o) => Object.prototype.toString.call(o);
      t('weak', () => tag(sc(new WeakMap()))); t('weakset', () => tag(sc(new WeakSet()))); t('weakref', () => tag(sc(new WeakRef({}))));
      t('promise', () => tag(sc(Promise.resolve(1)))); t('proxy', () => tag(sc(new Proxy({ a: 1 }, {})))); t('proxyarr', () => tag(sc(new Proxy([1], {}))));
      t('gen', () => tag(sc((function* () {})()))); t('iter', () => tag(sc([].values()))); t('mapiter', () => tag(sc(new Map().entries())));
      t('finreg', () => tag(sc(new FinalizationRegistry(() => {}))));
      t('headers', () => sc(new Headers())); t('usp', () => sc(new URLSearchParams('a=1'))); t('resp', () => sc(new Response('x'))); t('req', () => sc(new Request('http://x/')));
      t('port', () => sc(new MessageChannel().port1)); t('rs', () => sc(new ReadableStream())); t('ts', () => sc(new TransformStream()));
      t('symwrap', () => sc(Object(Symbol('q')))); t('fn', () => sc(function foo() { return 1; })); t('arrow', () => sc(() => 1)); t('sym', () => sc(Symbol()));
      t('args', () => sc((function () { return arguments; })(1))); t('global', () => sc(globalThis));
      t('wrappers', () => [new Number(5), new String('ab'), new Boolean(false), Object(5n)].map((w) => { const c = sc(w); return tag(c) + c.valueOf(); }).join());
      t('shared', () => { const d = new Date(0), r = /x/g; r.lastIndex = 3; const c = sc({ a: d, b: d, r, s: r }); return (c.a === c.b) + ' ' + (c.r === c.s) + c.r.lastIndex + c.r.flags; });
      t('views', () => { const b = new ArrayBuffer(8); const c = sc({ x: new Uint8Array(b, 2, 3), y: new Uint16Array(b), z: b, d: new DataView(b, 1, 4) }); return [c.x.buffer === c.y.buffer, c.z === c.x.buffer, c.d.buffer === c.z, c.x.byteOffset, c.x.length, c.y.length, c.d.byteOffset, c.d.byteLength].join(); });
      t('resizable', () => { const c = sc(new ArrayBuffer(4, { maxByteLength: 16 })); return c.resizable + ' ' + c.maxByteLength + ' ' + c.byteLength; });
      t('arrprops', () => { const a = [1, , 3]; a.x = 'y'; a[10] = 5; const c = sc(a); return JSON.stringify(Object.keys(c)) + c.length + (1 in c); });
      t('protos', () => { class A { constructor() { this.v = 1; } } class B extends Array {} class M extends Map {} class D extends Date {} class U extends Uint8Array {} const o = Object.create(null); o.q = 1; return [Object.getPrototypeOf(sc(new A())) === Object.prototype, Object.getPrototypeOf(sc(B.from([1]))) === Array.prototype, Object.getPrototypeOf(sc(new M())) === Map.prototype, Object.getPrototypeOf(sc(new D(5))) === Date.prototype, Object.getPrototypeOf(sc(new U(1))) === Uint8Array.prototype, Object.getPrototypeOf(sc(o)) === Object.prototype].join(); });
      t('blob', () => { const b = new Blob(['ab'], { type: 'text/x' }); const c = sc(b); return (c === b) + tag(c) + c.size + c.type; });
      t('file', () => { const f = new File(['ab'], 'n', { lastModified: 3 }); const c = sc(f); return (c === f) + tag(c) + c.name + c.lastModified; });
      t('plainhosts', () => [new Event('x'), new TextEncoder(), AbortSignal.abort()].map((o) => tag(sc(o))).join());
      t('getters', () => { let n = 0; const o = { get a() { n++; return 5; } }; const c = sc(o); return n + ' ' + Object.getOwnPropertyDescriptor(c, 'a').value; });
      t('errname', () => { const e = new Error('m'); Object.defineProperty(e, 'name', { get() { return 'TypeError'; } }); return sc(e).name; });
      t('errmsg', () => { const e = new Error(); e.message = 5; return JSON.stringify(sc(e).message); });
      t('stack5', () => { const e = new Error('m'); e.stack = 5; return typeof e.stack + e.stack + Object.keys(e).length; });
      t('xfer-obj', () => sc({}, { transfer: [{}] })); t('xfer-prim', () => sc(1, { transfer: [1] }));
      t('xfer-dup', () => { const a = new ArrayBuffer(2); return sc(a, { transfer: [a, a] }); });
      t('xfer-views', () => { const a = new ArrayBuffer(4); const u = new Uint8Array(a); u[1] = 7; const r = sc({ u, a }, { transfer: [a] }); return [r.u[1], r.u.buffer === r.a, a.byteLength, u.length, a.detached].join(); });
      t('xfer-detached', () => { const a = new ArrayBuffer(2); a.transfer(); return sc(a); });
      t('xfer-detached2', () => { const a = new ArrayBuffer(2); a.transfer(); return sc(1, { transfer: [a] }); });
      t('xfer-notin', () => { const a = new ArrayBuffer(2); return sc(5, { transfer: [a] }) + ' ' + a.byteLength; });
      t('xfer-resz', () => { const a = new ArrayBuffer(2, { maxByteLength: 8 }); const r = sc(a, { transfer: [a] }); return r.resizable + ' ' + r.maxByteLength; });
      return out.join('\\n'); })()`,
  );
  differential(
    "Event, EventTarget and AbortSignal behave as Node's",
    `(() => { ${GRAB} return [
      grab(() => { const e = new Event('x', { cancelable: true }); e.bubbles = true; e.returnValue = false; return [e.bubbles, e.defaultPrevented, e.returnValue, e.cancelBubble, e.eventPhase, e.isTrusted, typeof e.timeStamp, JSON.stringify(e), Object.keys(e).length].join(); }),
      grab(() => { const e = new Event('a'); e.initEvent('b', true, true); e.cancelBubble = true; return e.type + e.bubbles + e.cancelable + e.cancelBubble; }),
      grab(() => { const e = new Event('a'); e._type = 'clobbered'; return e.type; }),
      grab(() => new Event()), grab(() => new Event('x', 5)), grab(() => new CustomEvent()), grab(() => Object.getOwnPropertyDescriptor(Event.prototype, 'type').get.call({})),
      grab(() => { const t = new EventTarget(); const r = []; const f = (e) => r.push(e.type + e.eventPhase + (e.currentTarget === t) + e.composedPath().length); t.addEventListener('x', f); t.addEventListener('x', f); t.addEventListener('x', { handleEvent: (e) => r.push('h') }); t.addEventListener('x', () => r.push('once'), { once: true }); t.dispatchEvent(new Event('x')); t.dispatchEvent(new Event('x')); t.removeEventListener('x', f); t.dispatchEvent(new Event('x')); return r.join(); }),
      grab(() => { const t = new EventTarget(); const ac = new AbortController(); const r = []; t.addEventListener('x', () => r.push(1), { signal: ac.signal }); t.dispatchEvent(new Event('x')); ac.abort(); t.dispatchEvent(new Event('x')); return r.join(); }),
      grab(() => { const t = new EventTarget(); const r = []; t.addEventListener('x', (e) => { e.stopImmediatePropagation(); r.push(1); }); t.addEventListener('x', () => r.push(2)); return t.dispatchEvent(new Event('x', { cancelable: true })) + r.join(); }),
      grab(() => { const t = new EventTarget(); t.addEventListener('x', (e) => e.preventDefault(), { passive: true }); const e = new Event('x', { cancelable: true }); return t.dispatchEvent(e) + ' ' + e.defaultPrevented; }),
      grab(() => new EventTarget().dispatchEvent({ type: 'x' })), grab(() => new EventTarget().addEventListener('x')),
      grab(() => { const t = new EventTarget(); const e = new Event('x'); let inner; t.addEventListener('x', () => { try { t.dispatchEvent(e); } catch (err) { inner = err.code + ' ' + err.message; } }); t.dispatchEvent(e); return inner; }),
      grab(() => { const ac = new AbortController(); const r = []; ac.signal.onabort = (e) => r.push('on:' + e.type + e.isTrusted); ac.signal.addEventListener('abort', (e) => r.push('l:' + (e.target === ac.signal))); ac.abort('why'); ac.abort('again'); return r.join() + ac.signal.reason + ac.signal.aborted + typeof ac.signal.onabort; }),
      grab(() => { const a = new AbortController(), b = new AbortController(); const any = AbortSignal.any([a.signal, b.signal]); const r = []; any.addEventListener('abort', () => r.push(any.reason)); b.abort('B'); a.abort('A'); return r.join() + any.aborted; }),
      grab(() => { const ac = new AbortController(); ac._signal = null; return ac.signal instanceof AbortSignal; }),
      grab(() => new AbortSignal()), grab(() => AbortSignal.abort().reason.name), grab(() => AbortSignal.timeout(-1)), grab(() => AbortSignal.timeout('5')),
      grab(() => { const b = new Blob(['abc']); b._bytes = null; return b.size; }),
      grab(() => { const r = new Response('x', { status: 201 }); r._status = 500; return r.status + r.type + Response.error().type + Response.error().status + Response.redirect('http://a/', 301).headers.get('location') + Response.redirect('http://a/', 301).status; }),
      grab(() => Response.redirect('http://a/', 200)),
      grab(() => { const q = new Request('http://x/'); return [q.cache, q.credentials, q.destination, q.duplex, q.integrity, q.keepalive, q.mode, q.redirect, q.referrer, q.referrerPolicy, q.isHistoryNavigation, q.isReloadNavigation].join(); }),
      grab(() => new MessageEvent('m', { data: 1, origin: 'o', lastEventId: 'l' }).source + new MessageEvent('m').data + new MessageEvent('m', { data: 2 }).data),
      grab(() => new MessagePort()),
      grab(() => { const d = new TextDecoderStream(); return (d instanceof TransformStream) + Object.prototype.toString.call(d) + d.encoding + (d.readable instanceof ReadableStream); }),
    ].join(' | '); })()`,
  );
  differential(
    "the web classes' shapes",
    `['TextEncoder','TextDecoder','TextDecoderStream','URLSearchParams','ReadableStream','TransformStream','Headers','Blob','File','Event','EventTarget','CustomEvent','DOMException','AbortController','AbortSignal','MessageEvent','Response','Crypto','SubtleCrypto'].map(n => { const C = globalThis[n]; const p = C.prototype; const d = (o, k) => { const x = Object.getOwnPropertyDescriptor(o, k); return k + (x.get ? 'g' : '') + (x.set ? 's' : '') + (x.enumerable ? 'E' : ''); }; return n + '(' + C.length + ') proto[' + Object.getOwnPropertyNames(p).sort().map(k => d(p, k)).join(',') + '] static[' + Object.getOwnPropertyNames(C).filter(k => !/^[A-Z_]+$/.test(k)).sort().join(',') + '] parent=' + (Object.getPrototypeOf(p) && Object.getPrototypeOf(p).constructor.name) + ' tag=' + p[Symbol.toStringTag]; }).join('\\n')`,
  );
  differential(
    "TextDecoder refuses the replacement labels as Node does",
    `(() => { ${GRAB} return ['replacement', 'iso-2022-kr', 'csiso2022kr', 'hz-gb-2312', 'iso-2022-cn', 'iso-2022-cn-ext'].map((l) => grab(() => new TextDecoder(l))).join(' | '); })()`,
  );

  differential(
    "structuredClone snapshots keys and entries and creates its properties, as V8 does",
    `(() => { ${GRAB} const dump = (v) => { if (v === null || typeof v !== 'object') return typeof v === 'string' ? JSON.stringify(v) : String(v); const tag = Object.prototype.toString.call(v).slice(8, -1); if (v instanceof Map || v instanceof Set) return tag + '[' + [...v].map((e) => Array.isArray(e) ? e.map(dump).join('=>') : dump(e)).join(',') + ']'; const keys = Reflect.ownKeys(v).filter((k) => typeof k === 'string' && k !== 'length'); return tag + (Array.isArray(v) ? '(' + v.length + ')' : '') + '{' + keys.map((k) => k + ':' + dump(v[k])).join(',') + '}'; }; const sc = structuredClone; return [
      grab(() => dump(sc((() => { const a = [1, 2, 3]; Object.defineProperty(a, 0, { get() { a.length = 1; return 'g'; }, enumerable: true }); return a; })()))),
      grab(() => dump(sc((() => { const a = [1, 2, 3]; Object.defineProperty(a, 0, { get() { delete a[2]; return 'g'; }, enumerable: true }); return a; })()))),
      grab(() => dump(sc((() => { const a = [1, 2, 3]; Object.defineProperty(a, 0, { get() { a.push(9); a.x = 1; return 'g'; }, enumerable: true }); return a; })()))),
      grab(() => dump(sc((() => { const a = [{ get x() { a.push(9); a.y = 1; return 1; } }, 2]; return a; })()))),
      grab(() => dump(sc((() => { const a = [{ get x() { delete a[1]; return 1; } }, 2, 3]; return a; })()))),
      grab(() => dump(sc((() => { const a = [1, 2]; Object.defineProperty(a, 1, { value: 2, enumerable: false }); return a; })()))),
      grab(() => dump(sc((() => { const o = { get a() { delete o.b; o.z = 1; return 1; }, b: 2, c: 3 }; return o; })()))),
      grab(() => dump(sc((() => { const o = { get a() { Object.defineProperty(o, 'b', { enumerable: false }); return 1; }, b: 2, c: 3 }; return o; })()))),
      grab(() => dump(sc((() => { const m = new Map([[1, { get x() { m.set(2, 'late'); m.delete(3); return 1; } }], [3, 3]]); return m; })()))),
      grab(() => dump(sc((() => { const s = new Set([{ get x() { s.add(2); s.delete(3); return 1; } }, 3]); return s; })()))),
      grab(() => { const r = sc(JSON.parse('{"__proto__": {"polluted": 1}}')); return [r.polluted, Object.getPrototypeOf(r) === Object.prototype, Object.hasOwn(r, '__proto__')].join(); }),
      grab(() => { let hit = 0; Object.defineProperty(Object.prototype, 'qq', { set(v) { hit++; }, configurable: true }); try { const r = sc({ qq: 1 }); return hit + ':' + Object.hasOwn(r, 'qq'); } finally { delete Object.prototype.qq; } }),
      grab(() => { let hit = 0; Object.defineProperty(Array.prototype, '1', { set(v) { hit++; }, configurable: true }); try { const r = sc([1, 2]); return hit + ':' + Object.hasOwn(r, '1'); } finally { delete Array.prototype[1]; } }),
      grab(() => { const b = new ArrayBuffer(8); const u = new Uint8Array(b, 4); sc(b, { transfer: [b] }); return dump(sc(u)); }),
      grab(() => { const b = new ArrayBuffer(8, { maxByteLength: 8 }); const u = new DataView(b, 4); b.resize(2); return dump(sc(u)); }),
      grab(() => { const b = new ArrayBuffer(8, { maxByteLength: 8 }); const u = new Uint8Array(b, 4); b.resize(2); return dump(sc({ u })); }),
      grab(() => { const b = new ArrayBuffer(8, { maxByteLength: 8 }); const u = new Uint8Array(b, 4, 4); b.resize(6); return dump(sc(u)); }),
      grab(() => { const b = new ArrayBuffer(8, { maxByteLength: 8 }); const u = new Uint8Array(b); b.resize(2); return sc(u).length; }),
      grab(() => sc(new MessageEvent('m'))),
    ].join(' | '); })()`,
  );
  differential(
    "MessagePort.postMessage checks its transfer list and detaches what it transfers, as Node does",
    `(() => { ${GRAB} const mk = () => new MessageChannel(); const r = [];
      for (const f of [(p) => p.postMessage(), (p) => p.postMessage(1, 5), (p) => p.postMessage(1, 'ab'), (p) => p.postMessage(1, { transfer: 5 }), (p) => p.postMessage(1, { transfer: null }), (p) => p.postMessage(1, { transfer: {} }), (p) => p.postMessage(1, [5]), (p) => p.postMessage(1, [{}]), (p) => p.postMessage(1, [p]), (p) => p.postMessage(1, null), (p) => p.postMessage(1, {}), (p) => p.postMessage(1, [], 3), () => MessagePort.prototype.postMessage.call({}, 1)]) {
        const { port1, port2 } = mk(); r.push(grab(() => { f(port1); return 'ok'; }) + ':' + grab(() => Object.keys((() => { try { f(port1); } catch (e) { return e; } return {}; })()).join())); port1.close(); }
      r.push(grab(() => { const { port1 } = mk(); const b = new ArrayBuffer(4); port1.postMessage(b, [b]); const c = new ArrayBuffer(3); port1.postMessage(c, { transfer: [c] }); const d = new ArrayBuffer(2); port1.close(); port1.postMessage(d, [d]); return [b.byteLength, b.detached, c.detached, d.detached].join(); }));
      r.push(grab(() => { const { port1 } = mk(); const b = new ArrayBuffer(4); try { port1.postMessage(() => 1, [b]); } catch (e) { return e.message + ',' + b.detached; } finally { port1.close(); } }));
      r.push(grab(() => { const { port1 } = mk(); const b = new ArrayBuffer(4); try { port1.postMessage(1, [b, b]); } catch (e) { return e.name + ':' + e.message + ',' + b.detached; } finally { port1.close(); } }));
      return r.join(' | '); })()`,
  );
  differential(
    "Request, Response, MessageEvent and ReadableStream.from validate as Node does",
    `(() => { ${GRAB} const why = (f) => { try { f(); return 'ok'; } catch (e) { return e.name + ':' + e.code + ':' + e.message + ':' + (e.cause ? e.cause.name + '/' + e.cause.code + '/' + e.cause.message + '/' + e.cause.input : ''); } }; return [
      ...[() => Response.redirect('not a url'), () => Response.redirect('/rel'), () => Response.redirect('/rel', 200), () => new Request('/rel'), () => new Request('http://u:p@a/'), () => new Request('http://:@a/'), () => new Response('x', { status: 204 }), () => new Response('x', { status: 304 }), () => new Response('', { status: 205 }), () => new Response(null, { status: 204 }), () => new Response(undefined, { status: 205 })].map(why),
      grab(() => Response.redirect('http://a/b').headers.get('location')),
      grab(() => { const e = new MessageEvent('m', { ports: [] }); return Object.isFrozen(e.ports) + ',' + (e.ports === e.ports); }),
      ...[() => new MessageEvent(), () => new MessageEvent('m', { source: 5 }), () => new MessageEvent('m', { source: 'a' }), () => new MessageEvent('m', { ports: 5 }), () => new MessageEvent('m', { ports: [5] }), () => new MessageEvent('m', { ports: 'ab' }), () => new MessageEvent('m', { ports: null }), () => new MessageEvent('m', { ports: {} }), () => new MessageEvent('m', { ports: 5, source: 5 }), () => new MessageEvent('m', 5), () => new MessageEvent('m', null)].map(why),
      grab(() => { const e = new MessageEvent('m', { data: 1 }); const n = e.initMessageEvent('n', true, true, 'D', 'O', 'L', null, []); return [e.type, e.bubbles, e.data, e.origin, e.lastEventId, n.type, n.bubbles, n.data, n.origin, n.lastEventId, n instanceof MessageEvent, n === e].join(); }),
      why(() => new MessageEvent('m').initMessageEvent()),
      grab(() => { const e = new MessageEvent('m'); return [e.data, e.origin, e.lastEventId, e.source, e.ports.length].join(); }),
      grab(() => { const { port1 } = new MessageChannel(); const e = new MessageEvent('m', { source: port1, ports: [port1] }); port1.close(); return (e.source === port1) + ',' + (e.ports[0] === port1); }),
      ...[5, null, undefined, 'ab', Symbol('q')].map((v) => why(() => ReadableStream.from(v))),
      why(() => ReadableStream.from({ [Symbol.iterator]() { return 5; } })),
      why(() => new Event(Symbol())),
      why(() => new EventTarget().addEventListener('x', () => {}, { signal: { aborted: false } })),
    ].join(' | '); })()`,
  );
  differential(
    "an error's stack assignment stores as V8's setter does",
    `(() => { ${GRAB} return [
      grab(() => { const e = Object.freeze(new Error('m')); e.stack = 'x'; return e.stack; }),
      grab(() => { 'use strict'; const e = Object.freeze(new Error('m')); e.stack = 'x'; return e.stack; }),
      grab(() => { const e = Object.preventExtensions(new Error('m')); e.stack = 'x'; return e.stack; }),
      grab(() => { const o = {}; Object.setPrototypeOf(o, new Error('p')); o.stack = 'x'; return [o.stack, Object.hasOwn(o, 'stack')].join(); }),
      grab(() => { const o = Object.create(Error.prototype); o.stack = 'x'; return [o.stack, Object.hasOwn(o, 'stack'), Object.keys(o)].join(); }),
      grab(() => { const e = new TypeError('m'); e.stack = { o: 1 }; return typeof e.stack + JSON.stringify(e.stack); }),
      grab(() => { class E extends Error { constructor() { super('m'); this.stack = 'custom'; } } return new E().stack; }),
      grab(() => { const e = new Error('m'); e.stack = 'S'; return Object.keys(e).join() + ':' + JSON.stringify(e) + ':' + structuredClone(e).stack; }),
      grab(() => { const e = new Error('m'); Object.defineProperty(e, 'stack', { value: 'D', writable: false }); e.stack = 'x'; return e.stack; }),
    ].join(' | '); })()`,
  );

  test("where the island parts from Node: stack ownership, URLs kept as written, timeStamp's clock (S108 (i), (k))", async () => {
    const out = await islandEval(
      lane,
      "web-registered-parts",
      `(() => { const e = new Error('m'); const before = Object.hasOwn(e, 'stack'); e.stack = 5; const d = Object.getOwnPropertyDescriptor(e, 'stack'); delete e.stack; const t = new Event('x').timeStamp; return [before, d === undefined, e.stack, new Request('http://a').url, new Request('http:').url, typeof t, t >= 0, t < 600000].join(); })()`,
    );
    expect(out).toBe("false,true,5,http://a,http:,number,true,true");
  });

  test("island promise jobs drain at the exit checkpoint with no static async work (board #272)", async () => {
    const r = await compileAndRun(lane, `web-jobs-${lane}`, `__island_eval("new Response('body').text().then((t) => console.log('got', t)); Promise.resolve().then(() => console.log('job')); 0");\nconsole.log("end");\n`);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("end\njob\ngot body\n");
  });

  test("Node globals' members the engine lacks are fenced by name (S108 (i), (g))", async () => {
    const out = await islandEval(
      lane,
      "web-engine-fences",
      `(() => { const grab = (f) => { try { return String(f()); } catch (e) { return e.message; } }; return [grab(() => RegExp.$1), grab(() => RegExp.lastMatch), grab(() => { RegExp.input = 'x'; }), grab(() => crypto.subtle.digest('SHA-256', new Uint8Array(1))), grab(() => typeof crypto.subtle + Object.prototype.toString.call(crypto.subtle))].join(' | '); })()`,
    );
    expect(out).toBe(
      [...["RegExp.$1", "RegExp.lastMatch", "RegExp.input", "crypto.subtle.digest"].map((k) => `${k} inside the scriptc island is not supported yet`), "object[object SubtleCrypto]"].join(" | "),
    );
  });

  test("console formats primitives as Node does and writes lone surrogates as U+FFFD", async () => {
    const js = [
      "console.log('a\\ud800b\\udc00c');",
      "console.log(-0, 0, 5n, Symbol('s'), null, undefined, true, 1e21, 'str');",
      "console.log('%s|%d|%i|%f|%j|%o|%O|%c|%%|%x', -0, '42.5', '42.5', '1.5e3', { a: [1] }, 'q\\'s', 'it', 'css', 'extra', 9);",
      "console.log('%s %s', 5n, Symbol('t'));",
      "console.log('%d %i', 7n, Symbol('u'));",
      "console.log('%d|%d|%d|%d|%i|%f|%f', [], {}, new Date(7), { valueOf() { return 9; } }, { toString() { return '12.9'; } }, { toString() { return '2.5'; } }, Symbol('f'));",
      "console.log('%s|%s|%s', class A { toString() { return 'cls'; } }, new (class B { toString() { return 'inst'; } })(), function named() { return 1; });",
      "console.log('%j %j %j', undefined, (() => { const o = {}; o.o = o; return o; })(), 'q');",
      "console.log('%o|%O|%s', 'it\\'s', 'a\\nb', Symbol.iterator);",
      "console.log('100%');",
      "console.group('G'); console.log('in\\nner'); console.group(); console.error('deep'); console.groupEnd(); console.groupEnd(); console.log('out');",
      "console.count(); console.count(); console.count('x'); console.countReset(); console.count();",
      "console.assert(true, 'no'); console.assert(false, 'yes %d', 3); console.assert(0); console.assert(0, { a: 1 }.a);",
      "console.info('i'); console.debug('d'); console.warn('w'); console.profile(); console.profileEnd(); console.timeStamp(); console.clear();",
    ].join(" ");
    const r = await compileAndRun(lane, `web-console-${lane}`, `__island_eval(${JSON.stringify(js + " 0")});\n`);
    const node = await execFileAsync(process.execPath, ["-e", js], { encoding: "utf8" });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(node.stdout);
    expect(r.stderr).toBe(node.stderr);
  });

  test("console methods that need the wall clock, V8's stack or Node's classes are fenced by name (S108 (a))", async () => {
    const out = await islandEval(
      lane,
      "web-console-fences",
      `(() => { const grab = (f) => { try { f(); return 'no-throw'; } catch (e) { return e.message; } }; return ['time', 'timeEnd', 'timeLog', 'trace', 'Console', 'context', 'createTask'].map((k) => grab(() => console[k]('x'))).concat([grab(() => console.countReset('never'))]).join(' | '); })()`,
    );
    const fence = (k: string): string => `console.${k} inside the scriptc island is not supported yet (SEMANTICS.md S108)`;
    expect(out).toBe(
      [...["time", "timeEnd", "timeLog", "trace", "Console", "context", "createTask"].map(fence), fence("countReset (of a label never counted)")].join(" | "),
    );
  });

  test("the island's performance.now() reads the static side's clock origin (S108 (m))", async () => {
    // Before: the engine's own performance counted from the engine
    // context's creation, so an island reading taken after a static one
    // came out SMALLER (the engine boots after the program starts).
    const r = await compileAndRun(
      lane,
      "web-perf-origin",
      [
        `let s = 0; for (let i = 0; i < 2000000; i++) s += i;`,
        `const a = performance.now();`,
        `const b = Number(__island_eval("performance.now()"));`,
        `const c = performance.now();`,
        `console.log(a <= b && b <= c, s > 0, __island_eval("typeof performance.timeOrigin + ' ' + Object.keys(performance).length"));`,
      ].join("\n"),
    );
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe("true true number 0\n");
  });

  test("crypto bridges the runtime's CSPRNG: v4 UUIDs, real fills, spec limits", async () => {
    const out = await islandEval(
      lane,
      "web-crypto",
      `(() => {
        const u = crypto.randomUUID();
        const shape = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(u);
        const a = new Uint8Array(32);
        const r = crypto.getRandomValues(a);
        let filled = false;
        for (let i = 0; i < a.length; i++) if (a[i] !== 0) filled = true;
        const distinct = crypto.randomUUID() !== u;
        let quota = 'no-throw';
        try { crypto.getRandomValues(new Uint8Array(65537)); } catch (e) { quota = e.name; }
        let mismatch = 'no-throw';
        try { crypto.getRandomValues(new Float64Array(2)); } catch (e) { mismatch = e.name; }
        return [shape, r === a, filled, distinct, quota, mismatch].join(' ');
      })()`,
    );
    expect(out).toBe("true true true true QuotaExceededError TypeMismatchError");
  });

  // The prelude's Date patch: quickjs-ng stops at the GMT offset; Node
  // appends the parenthesized timezone name. Shape-asserted here — the
  // machine's zone decides the name; tz-matrix.test.ts compares it with
  // Node's under several zones (SEMANTICS.md S113).
  test("Date#toString/#toTimeString carry the timezone-name suffix Node prints", async () => {
    const out = await islandEval(
      lane,
      "web-date-tzname",
      `(() => {
        const full = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) [A-Z][a-z]{2} \\d{2} \\d{4} \\d{2}:\\d{2}:\\d{2} GMT[+-]\\d{4} \\(.+\\)$/;
        const time = /^\\d{2}:\\d{2}:\\d{2} GMT[+-]\\d{4} \\(.+\\)$/;
        const d = new Date(0);
        return [
          full.test(d.toString()) ? 'suffixed' : 'BAD:' + d.toString(),
          full.test(String(d)) ? 'suffixed' : 'BAD:' + String(d),
          time.test(d.toTimeString()) ? 'suffixed' : 'BAD:' + d.toTimeString(),
          String(new Date(NaN)),
          new Date(NaN).toTimeString(),
        ].join(' | ');
      })()`,
    );
    expect(out).toBe("suffixed | suffixed | suffixed | Invalid Date | Invalid Date");
  });
});
