/* The `fetch` import's host half (abi.ts, #227) over Node's OWN fetch —
 * shared by this directory's wasm-host.ts and the differential harness
 * (tests/harness/wasm-differential.test.ts runWasm), so the network half
 * of every row is Node's: the request is built with Node's Request
 * constructor (its synchronous refusals answer START with -1 and an error
 * record), sent with Node's fetch, and its head, body and failure travel
 * back as evPoll source-6 events. The module builds everything a program
 * sees (fetch.ts); this file answers plain data only. */

/** One queued host event (abi.ts evPoll's record). */
export interface FetchHostEvent {
  source: number;
  handle: number;
  kind: number;
  a: number;
  b: number;
  payload: Uint8Array;
}

export interface FetchHostDeps {
  memory: () => WebAssembly.Memory;
  /** Queue an event for the module's poll phase. */
  push: (ev: FetchHostEvent) => void;
  /** Drop every queued event the predicate selects. */
  purge: (pred: (ev: FetchHostEvent) => boolean) => void;
  /** A request starts (+1) or finishes (-1) holding the loop. */
  live: (delta: number) => void;
}

const SRC_FETCH = 6;
const EV_HEAD = 1;
const EV_BODY = 2;
const EV_FAIL = 3;

/** A UTF-16 run: u32 count, the units, zero padding to a multiple of 4. */
function runBytes(s: string): Uint8Array {
  const size = 4 + ((s.length * 2 + 3) & ~3);
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, s.length, true);
  for (let i = 0; i < s.length; i++) dv.setUint16(4 + i * 2, s.charCodeAt(i), true);
  return out;
}

function u32(n: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n >>> 0, true);
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** abi.ts's ERROR RECORD for a thrown value: name, message, hasCause,
 * then the cause's name, message and code. */
export function fetchErrorRecord(err: unknown): Uint8Array {
  const e = err as { name?: unknown; message?: unknown; cause?: unknown };
  const name = typeof e?.name === "string" ? e.name : "Error";
  const message = typeof e?.message === "string" ? e.message : String(err);
  const parts = [runBytes(name), runBytes(message)];
  const cause = e?.cause as { name?: unknown; message?: unknown; code?: unknown } | undefined;
  if (cause !== null && typeof cause === "object") {
    parts.push(
      u32(1),
      runBytes(typeof cause.name === "string" ? cause.name : "Error"),
      runBytes(typeof cause.message === "string" ? cause.message : ""),
      runBytes(typeof cause.code === "string" ? cause.code : ""),
    );
  } else {
    parts.push(u32(0));
  }
  return concat(parts);
}

/** A HEAD event's payload (abi.ts): the status text, URL and type runs,
 * then the header list as (name, value) run pairs. */
export function fetchHeadPayload(statusText: string, url: string, type: string, headers: [string, string][]): Uint8Array {
  return concat([
    runBytes(statusText),
    runBytes(url),
    runBytes(type),
    u32(headers.length),
    ...headers.flatMap(([k, v]) => [runBytes(k), runBytes(v)]),
  ]);
}

interface Pending {
  controller: AbortController;
  dead: boolean;
}

export function makeFetchHost(deps: FetchHostDeps): {
  fetchCall: (op: number, ptr: number, len: number, h: number, x: number) => number;
  /** Abort every request still running (the run is over). */
  finish: () => void;
  /** Requests still running. */
  open: () => number;
} {
  const pending = new Map<number, Pending>();
  let next = 1;
  const done = (h: number, p: Pending): void => {
    if (p.dead) return;
    p.dead = true;
    pending.delete(h);
    deps.live(-1);
  };
  const start = (ptr: number, len: number, x: number): number => {
    const mem = deps.memory();
    const dv = new DataView(mem.buffer, ptr, len);
    let at = 0;
    const readU32 = (): number => {
      const v = dv.getUint32(at, true);
      at += 4;
      return v;
    };
    const readRun = (): string => {
      const n = readU32();
      let s = "";
      for (let i = 0; i < n; i++) s += String.fromCharCode(dv.getUint16(at + i * 2, true));
      at += (n * 2 + 3) & ~3;
      return s;
    };
    const bodyKind = readU32();
    const count = readU32();
    const given = readU32();
    const method = readRun();
    const url = readRun();
    const redirect = readRun();
    const headers: [string, string][] = [];
    for (let i = 0; i < count; i++) headers.push([readRun(), readRun()]);
    let body: string | Uint8Array | undefined;
    if (bodyKind !== 0) {
      const n = readU32();
      const bytes = new Uint8Array(mem.buffer.slice(ptr + at, ptr + at + n));
      at += (n + 3) & ~3;
      body = bodyKind === 1 ? new TextDecoder().decode(bytes) : bytes;
    }
    if (at !== len) throw new Error(`fetch: a START record of ${len} bytes read ${at}`);
    const init: RequestInit = { headers };
    if ((given & 1) !== 0) init.method = method;
    if ((given & 2) !== 0) init.redirect = redirect as RequestRedirect;
    if (body !== undefined) init.body = body;
    let request: Request;
    try {
      request = new Request(url, init);
    } catch (err) {
      const rec = fetchErrorRecord(err);
      if (rec.length > x) throw new Error("fetch: an error record larger than the room the module left");
      new Uint8Array(deps.memory().buffer, ptr, rec.length).set(rec);
      return -1;
    }
    const h = next++;
    const p: Pending = { controller: new AbortController(), dead: false };
    pending.set(h, p);
    deps.live(1);
    const fail = (err: unknown): void => {
      if (p.dead) return;
      deps.push({ source: SRC_FETCH, handle: h, kind: EV_FAIL, a: 0, b: 0, payload: fetchErrorRecord(err) });
      done(h, p);
    };
    fetch(request, { signal: p.controller.signal }).then(async (res) => {
      if (p.dead) return;
      const head = fetchHeadPayload(res.statusText, res.url, res.type, [...res.headers]);
      deps.push({
        source: SRC_FETCH,
        handle: h,
        kind: EV_HEAD,
        a: res.status,
        b: (res.redirected ? 1 : 0) | (res.body === null ? 2 : 0),
        payload: head,
      });
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(await res.arrayBuffer());
      } catch (err) {
        fail(err);
        return;
      }
      if (p.dead) return;
      deps.push({ source: SRC_FETCH, handle: h, kind: EV_BODY, a: 0, b: 0, payload: bytes });
      done(h, p);
    }, fail);
    return h;
  };
  const fetchCall = (op: number, ptr: number, len: number, h: number, x: number): number => {
    if (op === 1) return start(ptr, len, x);
    if (op === 2) {
      const p = pending.get(h);
      if (p === undefined) throw new Error(`fetch: ABORT of unknown request ${h}`);
      p.controller.abort();
      deps.purge((ev) => ev.source === SRC_FETCH && ev.handle === h);
      done(h, p);
      return 0;
    }
    throw new Error(`fetch: unknown op ${op}`);
  };
  return {
    fetchCall,
    finish: () => {
      for (const [h, p] of [...pending]) {
        p.controller.abort();
        done(h, p);
      }
    },
    open: () => pending.size,
  };
}

/** Write one event record (abi.ts evPoll) at ptr: the header and the
 * payload, or -(the length needed) when cap is short. */
export function writeFetchEvent(mem: WebAssembly.Memory, ptr: number, cap: number, ev: FetchHostEvent): number {
  const need = 24 + ev.payload.length;
  if (need > cap) return -need;
  const dv = new DataView(mem.buffer, ptr, need);
  dv.setUint32(0, ev.source, true);
  dv.setUint32(4, ev.handle, true);
  dv.setUint32(8, ev.kind, true);
  dv.setUint32(12, ev.payload.length, true);
  dv.setInt32(16, ev.a, true);
  dv.setInt32(20, ev.b, true);
  new Uint8Array(mem.buffer, ptr + 24, ev.payload.length).set(ev.payload);
  return need;
}
