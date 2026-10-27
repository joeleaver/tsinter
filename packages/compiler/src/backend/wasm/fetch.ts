/* fetch() on the WasmGC tier (#227) through ONE host import, `fetch`
 * (abi.ts). The host does the network half with its own fetch and answers
 * plain data only — a request goes out as (method, URL, redirect mode,
 * header pairs, body bytes) and comes back as (status, statusText, url,
 * redirected, header list, body bytes) or an error's (name, message, cause
 * name / message / code). Everything a program sees is built here: the
 * promise fetch() returns, the Response / Headers / AbortSignal /
 * ArrayBuffer values (dyn HANDLEs, tags 7..10, the node:net precedent:
 * every member this surface does not model throws a named Error), the
 * body readers and their "Body is unusable" TypeError, "fetch failed" and
 * its cause, AbortSignal.timeout's unref'd timer and the TimeoutError it
 * rejects with. SEMANTICS.md S098 registers what is the host's answer.
 *
 * THE EVENT SOURCE. A fetch module is an event module (abi.ts evPoll):
 * source 6 carries a request's HEAD (fetch() fulfils), its BODY (every
 * byte, decoded by the host; the body readers settle) or a FAIL (fetch()
 * rejects before a HEAD, the body readers after one). A request holds the
 * loop from START until its BODY or FAIL is delivered, or the module
 * aborts it. Streaming (Response.body), Blob, FormData, clone() and the
 * Request / Headers / Response constructors are not modelled. */
import { A, Fn, type X } from "./asm.js";
import { Code } from "./code.js";
import { DK, DYN_KIND, DYN_NUM, DYN_REF, type DynBuilder } from "./dyn.js";
import { F64, I32, ModuleBuilder, type ValType } from "./module.js";

export interface FetchDeps {
  dyn: () => DynBuilder;
  strRef: () => ValType;
  strType: () => number;
  lit: (c: Code, s: string) => void;
  concat: () => number;
  strEq: () => number;
  f64ToStr: () => number;
  /** The `fetch` import (abi.ts), or null in a module that only reaches
   * the AbortSignal statics (no request can exist there). */
  fetchCallFunc: () => number | null;
  evPollFunc: () => number;
  ensureCapacity: (c: Code, need: () => void) => void;
  stageCursor: () => number;
  namedTrap: (c: Code, message: string) => void;
  bytesType: () => number;
  bufType: () => number;
  /** `(string) -> bytes`, UTF-8 (lone surrogates as U+FFFD). */
  strToUtf8: () => number;
  /** `(bytes) -> string`, UTF-8 with a leading BOM stripped. */
  textDecode: () => number;
  /** `(string) -> dyn`, JSON.parse (a SyntaxError pending on failure). */
  jsonParse: () => number;
  promRef: () => ValType;
  promMint: () => number;
  promSettle: () => number;
  exc: () => { kindG: number; f64G: number; refG: number; preG: number };
  cellClear: (c: Code) => void;
  reportUncaught: () => number;
  checkpoint: (c: Code) => void;
  errT: () => number;
  /** class:fetchCause — errT's fields then `cause` (errRef). */
  causeT: () => number;
  vtGlobal: (className: string) => number;
  /** Push the i32 preorder position of the error the caller pushes. */
  errPre: (c: Code, pushErr: () => void) => void;
  setCellError: (c: Code, className: string, name: string, pushMessage: (c: Code) => void, code: string | null) => void;
  /** `(dyn message, dyn name) -> errRef`, new DOMException. */
  domexNew: () => number;
  voidClos: () => { clos: number; fn: number };
  setTimeoutHandle: () => number;
  unrefTimer: () => number;
  /** `(f64) -> string`, ERR_OUT_OF_RANGE's "Received" rendering. */
  numReceived: () => number;
  excObjTag: number;
  excRefTag: number;
  /** Units G1-G3 (hostev.ts): `(base, len)`, a record of a host-event
   * source, with its own listeners, death check and checkpoint. */
  foreign?: () => number;
}

/* dyn HANDLE tags (DYN_NUM). net.ts owns 1-2 and http.ts 3-6. */
export const TAG_RESPONSE = 7;
export const TAG_HEADERS = 8;
export const TAG_SIGNAL = 9;
export const TAG_ARRAYBUFFER = 10;
export const FETCH_CLASS_NAMES: readonly (readonly [number, string])[] = [
  [TAG_RESPONSE, "Response"],
  [TAG_HEADERS, "Headers"],
  [TAG_SIGNAL, "AbortSignal"],
  [TAG_ARRAYBUFFER, "ArrayBuffer"],
];

/* The import's ops (abi.ts). */
const OP_START = 1;
const OP_ABORT = 2;

/* evPoll source 6's kinds (hostev.ts owns 3-5). */
const SRC_FETCH = 6;
const EV_HEAD = 1;
const EV_BODY = 2;
const EV_FAIL = 3;
const EV_HEADER_BYTES = 24;
const EV_FIRST_CAPACITY = 1024;
/* The room a START leaves at ptr for a synchronous failure's reply. */
const REPLY_ROOM = 16384;
const HOST_FAILURE = "fetch: host failure";

/* $req */
const R_H = 0;
const R_P = 1;
const R_RESP = 2;
const R_STATE = 3; // 0 awaiting the head, 1 awaiting the body, 2 finished

/* $resp */
const S_STATUS = 0;
const S_STATUSTEXT = 1;
const S_URL = 2;
const S_REDIRECTED = 3;
const S_NULLBODY = 4;
const S_HDRS = 5;
const S_BODYST = 6; // 0 pending, 1 ready, 2 failed
const S_BODY = 7;
const S_ERR = 8; // the failure (an error object)
const S_USED = 9;
const S_WAITP = 10;
const S_WAITK = 11;
const S_TYPE = 12;

/* $hdrs */
const H_NAMES = 0;
const H_VALUES = 1;
const H_N = 2;

/* $sig */
const G_ABORTED = 0;
const G_REASON = 1;
const G_LIS = 2;
const G_LISN = 3;

/* the body readers */
const K_TEXT = 0;
const K_JSON = 1;
const K_ARRAYBUFFER = 2;
const K_BYTES = 3;

/* RequestInit members the module does not model: present and not
 * undefined, each is a named Error. */
const UNMODELLED_INIT = [
  "cache",
  "credentials",
  "integrity",
  "keepalive",
  "mode",
  "referrer",
  "referrerPolicy",
  "window",
  "duplex",
  "priority",
  "dispatcher",
];

export class FetchBuilder {
  private readonly fns = new Map<string, number>();
  private readonly types = new Map<string, number>();
  private globalsField: {
    table: number;
    live: number;
    cap: number;
  } | null = null;

  constructor(
    private readonly mb: ModuleBuilder,
    private readonly deps: FetchDeps,
  ) {}

  /* ── plumbing ──────────────────────────────────────────────────────── */

  private fn(name: string, params: ValType[], results: ValType[], build: (f: Fn, $: A) => void): number {
    const hit = this.fns.get(name);
    if (hit !== undefined) return hit;
    const idx = this.mb.declareFunc(this.mb.funcType(params, results), `%w.fetch.${name}`);
    this.fns.set(name, idx);
    const f = new Fn(params.length);
    build(f, new A(f));
    this.mb.setBody(idx, f.locals, f.c.bytes());
    return idx;
  }

  private type(name: string, make: () => number): number {
    const hit = this.types.get(name);
    if (hit !== undefined) return hit;
    const t = make();
    this.types.set(name, t);
    return t;
  }

  private ref(typeIndex: number): ValType {
    return { kind: "ref", nullable: true, typeIndex };
  }

  private get dyn(): DynBuilder {
    return this.deps.dyn();
  }

  private get dynRef(): ValType {
    return this.dyn.dynRef();
  }

  private get strRef(): ValType {
    return this.deps.strRef();
  }

  private get errRef(): ValType {
    return this.ref(this.deps.errT());
  }

  private get bytesRef(): ValType {
    return this.ref(this.deps.bytesType());
  }

  private lit($: A, s: string): X {
    return () => this.deps.lit($.c, s);
  }

  private cat($: A, a: X, b: X): X {
    return $.call(this.deps.concat(), a, b);
  }

  private streq($: A, a: X, b: X): X {
    return $.call(this.deps.strEq(), a, b);
  }

  private kind($: A, d: X): X {
    return $.get(this.dyn.dynT(), DYN_KIND, d);
  }

  private isKind($: A, d: X, k: number): X {
    return $.eq(this.kind($, d), $.i(k));
  }

  private isHandle($: A, d: X, tag: number): X {
    return $.andThen(this.isKind($, d, DK.HANDLE), $.deq($.get(this.dyn.dynT(), DYN_NUM, d), $.d(tag)));
  }

  private payload($: A, T: number, d: X): X {
    return $.cast(T, $.get(this.dyn.dynT(), DYN_REF, d));
  }

  private strOf($: A, d: X): X {
    return $.flatCast(this.deps.strType(), $.get(this.dyn.dynT(), DYN_REF, d));
  }

  private boxHandle($: A, tag: number, ref: X): X {
    return $.new_(this.dyn.dynT(), $.i(DK.HANDLE), $.d(tag), ref);
  }

  private boxStr($: A, s: X): X {
    return () => this.dyn.boxStr($.c, () => s());
  }

  private boxBool($: A, b: X): X {
    return () => this.dyn.boxBool($.c, () => b());
  }

  private boxNum($: A, n: X): X {
    return () => this.dyn.boxNum($.c, () => n());
  }

  private undef($: A): X {
    return $.g(this.dyn.undefinedGlobal());
  }

  private boxPromise($: A, p: X): X {
    return $.new_(this.dyn.dynT(), $.i(DK.PROMISE), $.d(0), p);
  }

  /** Fill the exception cell with a fresh `className` error. */
  private throwErr($: A, className: string, name: string, msg: X, code: string | null = null): void {
    this.deps.setCellError($.c, className, name, () => msg(), code);
  }

  private pending($: A): X {
    return $.g(this.deps.exc().kindG);
  }

  /* ── types ─────────────────────────────────────────────────────────── */

  strArrT(): number {
    return this.type("strArr", () => this.mb.arrayType(this.strRef, true));
  }

  hdrsT(): number {
    return this.type("hdrs", () =>
      this.mb.structType([
        { storage: this.ref(this.strArrT()), mutable: false }, // H_NAMES
        { storage: this.ref(this.strArrT()), mutable: false }, // H_VALUES
        { storage: I32, mutable: false }, // H_N
        { storage: I32, mutable: false }, // a marker (shape distinctness)
      ]),
    );
  }

  reqT(): number {
    return this.type("req", () =>
      this.mb.structType([
        { storage: I32, mutable: false }, // R_H
        { storage: this.deps.promRef(), mutable: false }, // R_P
        { storage: { kind: "ref", nullable: true, typeIndex: this.respT() }, mutable: true }, // R_RESP
        { storage: I32, mutable: true }, // R_STATE
        { storage: F64, mutable: false }, // a marker (shape distinctness)
      ]),
    );
  }

  respT(): number {
    return this.type("resp", () =>
      this.mb.structType([
        { storage: F64, mutable: false }, // S_STATUS
        { storage: this.strRef, mutable: false }, // S_STATUSTEXT
        { storage: this.strRef, mutable: false }, // S_URL
        { storage: I32, mutable: false }, // S_REDIRECTED
        { storage: I32, mutable: false }, // S_NULLBODY
        { storage: this.ref(this.hdrsT()), mutable: false }, // S_HDRS
        { storage: I32, mutable: true }, // S_BODYST
        { storage: this.bytesRef, mutable: true }, // S_BODY
        { storage: this.errRef, mutable: true }, // S_ERR
        { storage: I32, mutable: true }, // S_USED
        { storage: this.deps.promRef(), mutable: true }, // S_WAITP
        { storage: I32, mutable: true }, // S_WAITK
        { storage: this.strRef, mutable: false }, // S_TYPE
      ]),
    );
  }

  private reqArrT(): number {
    return this.type("reqArr", () => this.mb.arrayType(this.ref(this.reqT()), true));
  }

  sigT(): number {
    return this.type("sig", () =>
      this.mb.structType([
        { storage: I32, mutable: true }, // G_ABORTED
        { storage: this.errRef, mutable: true }, // G_REASON
        { storage: this.ref(this.reqArrT()), mutable: true }, // G_LIS
        { storage: I32, mutable: true }, // G_LISN
        { storage: I32, mutable: false }, // a marker (shape distinctness)
        { storage: I32, mutable: false },
      ]),
    );
  }

  abT(): number {
    return this.type("ab", () =>
      this.mb.structType([
        { storage: this.bytesRef, mutable: false },
        { storage: F64, mutable: false }, // a marker (shape distinctness)
        { storage: F64, mutable: false },
      ]),
    );
  }

  /** The timer closure: the void closure plus the signal it aborts. */
  private sigClosT(): number {
    return this.type("sigClos", () => {
      const pair = this.deps.voidClos();
      return this.mb.subStructType(
        "%w.fetch.sigClos",
        [
          { storage: { kind: "ref", nullable: false, typeIndex: pair.fn }, mutable: false },
          { storage: this.ref(this.sigT()), mutable: false },
        ],
        pair.clos,
      );
    });
  }

  private g(): NonNullable<FetchBuilder["globalsField"]> {
    if (this.globalsField === null) {
      const arr = this.reqArrT();
      this.globalsField = {
        table: this.mb.addGlobal(this.ref(arr), true, (w) => {
          w.u8(0xd0);
          w.sleb(arr);
        }),
        live: this.mb.addGlobal(I32, true, (w) => {
          w.u8(0x41);
          w.sleb(0);
        }),
        cap: this.mb.addGlobal(I32, true, (w) => {
          w.u8(0x41);
          w.sleb(EV_FIRST_CAPACITY);
        }),
      };
    }
    return this.globalsField;
  }

  /** The i32 global counting requests that hold the loop. */
  liveGlobal(): number {
    return this.g().live;
  }

  /* ── linear memory ─────────────────────────────────────────────────── */

  private loadU32($: A, addr: X): X {
    return () => {
      const c = $.c;
      addr();
      c.i32Load16U();
      addr();
      c.i32Const(2);
      c.i32Add();
      c.i32Load16U();
      c.i32Const(16);
      c.i32Shl();
      c.i32Or();
    };
  }

  private storeU32($: A, addr: X, v: X): void {
    addr();
    v();
    $.c.i32Store();
  }

  /** The stage base: the cursor rounded up to 4. */
  private base($: A): X {
    return $.and($.add($.g(this.deps.stageCursor()), $.i(3)), $.i(-4));
  }

  /** The byte size of one UTF-16 run for string `s`. */
  private runSize($: A, s: X): X {
    return $.add($.and($.add($.mul($.alen(s), $.i(2)), $.i(3)), $.i(-4)), $.i(4));
  }

  /** `(s, ptr) -> next` — write one UTF-16 run. */
  private writeRunFn(): number {
    return this.fn("writeRun", [this.strRef, I32], [I32], (f, $) => {
      const N = f.local(I32);
      const I = f.local(I32);
      $.put(N, $.alen($.l(0)));
      this.storeU32($, $.l(1), $.l(N));
      $.for(I, $.i(0), $.l(N), () => {
        $.do($.add($.add($.l(1), $.i(4)), $.shl($.l(I), $.i(1))), $.agetU(this.deps.strType(), $.l(0), $.l(I)));
        $.c.i32Store16();
      });
      $.do(this.runSize($, $.l(0)), $.l(1));
      $.c.i32Add();
    });
  }

  /** `(ptr) -> string` — the UTF-16 run at ptr. */
  private readRunFn(): number {
    return this.fn("readRun", [I32], [this.strRef], (f, $) => {
      const N = f.local(I32);
      const I = f.local(I32);
      const S = f.local(this.strRef);
      $.put(N, this.loadU32($, $.l(0)));
      $.put(S, $.anew(this.deps.strType(), $.l(N)));
      $.for(I, $.i(0), $.l(N), () => {
        $.aset(this.deps.strType(), $.l(S), $.l(I), () => {
          $.do($.add($.add($.l(0), $.i(4)), $.shl($.l(I), $.i(1))));
          $.c.i32Load16U();
        });
      });
      $.ret($.l(S));
    });
  }

  /** `(ptr) -> next` — the address after the run at ptr. */
  private runEndFn(): number {
    return this.fn("runEnd", [I32], [I32], (f, $) => {
      $.do($.add($.add($.l(0), $.i(4)), $.and($.add($.mul(this.loadU32($, $.l(0)), $.i(2)), $.i(3)), $.i(-4))));
    });
  }

  /** `(ptr, len) -> bytes` — a fresh copy of [ptr, ptr + len). */
  private bytesAtFn(): number {
    return this.fn("bytesAt", [I32, I32], [this.bytesRef], (f, $) => {
      const B = f.local(this.ref(this.deps.bufType()));
      const I = f.local(I32);
      $.put(B, $.anew(this.deps.bufType(), $.l(1)));
      $.for(I, $.i(0), $.l(1), () => {
        $.aset(this.deps.bufType(), $.l(B), $.l(I), () => {
          $.do($.add($.l(0), $.l(I)));
          $.c.i32Load8U();
        });
      });
      $.do($.l(B));
      $.c.refAsNonNull();
      $.do($.i(0), $.l(1));
      $.c.structNew(this.deps.bytesType());
    });
  }

  /** `(bytes) -> bytes` — a fresh copy (a Uint8Array the program may
   * write must not alias the body). */
  private bytesCopyFn(): number {
    return this.fn("bytesCopy", [this.bytesRef], [this.bytesRef], (f, $) => {
      const BT = this.deps.bytesType();
      const BUF = this.deps.bufType();
      const B = f.local(this.ref(BUF));
      const N = f.local(I32);
      $.put(N, $.get(BT, 2, $.l(0)));
      $.put(B, $.anew(BUF, $.l(N)));
      $.do($.l(B), $.i(0), $.get(BT, 0, $.l(0)), $.get(BT, 1, $.l(0)), $.l(N));
      $.c.arrayCopy(BUF, BUF);
      $.do($.l(B));
      $.c.refAsNonNull();
      $.do($.i(0), $.l(N));
      $.c.structNew(BT);
    });
  }

  /** The import, where fetch() is built (never null there). */
  private importFn(): number {
    const fc = this.deps.fetchCallFunc();
    if (fc === null) throw new Error("wasm emitter bug: fetch() reached without the fetch import");
    return fc;
  }

  private trap($: A): void {
    this.deps.namedTrap($.c, HOST_FAILURE);
  }

  /* ── promises ──────────────────────────────────────────────────────── */

  /** Fulfil p with the dyn value. */
  private resolveDyn($: A, p: X, v: X): void {
    $.run(this.deps.promSettle(), p, $.i(this.deps.excRefTag), $.d(0), v, $.i(-1), $.i(1));
  }

  /** Reject p with the error object. */
  private rejectErr($: A, p: X, err: X): void {
    $.run(this.rejectFn(), p, err);
  }

  /** `(p, err)` */
  private rejectFn(): number {
    return this.fn("reject", [this.deps.promRef(), this.errRef], [], (f, $) => {
      $.run(
        this.deps.promSettle(),
        $.l(0),
        $.i(this.deps.excObjTag),
        $.d(0),
        $.l(1),
        $.raw((c) => this.deps.errPre(c, () => c.localGet(1))),
        $.i(2),
      );
    });
  }

  /** Reject p with the pending exception, and clear the cell. */
  private rejectCell($: A, p: X): void {
    const e = this.deps.exc();
    $.run(this.deps.promSettle(), p, $.g(e.kindG), $.g(e.f64G), $.g(e.refG), $.g(e.preG), $.i(2));
    this.deps.cellClear($.c);
  }

  /** A builtin error value of `className`, message `msg`, no code. */
  private newErr($: A, className: string, name: string, msg: X): X {
    return $.new_(this.deps.errT(), $.g(this.deps.vtGlobal(className)), this.lit($, name), msg, $.nul(this.deps.strType()));
  }

  /* ── the error a host answers ──────────────────────────────────────── */

  /** `(name, message, code) -> errRef` — the builtin class Node would
   * have built for that name (TypeError, RangeError, SyntaxError), else an
   * Error carrying the name. An empty code is none. */
  private errByNameFn(): number {
    return this.fn("errByName", [this.strRef, this.strRef, this.strRef], [this.errRef], (f, $) => {
      const CODE = f.local(this.strRef);
      $.put(CODE, $.sel(this.strRef, $.eq($.alen($.l(2)), $.i(0)), $.nul(this.deps.strType()), $.l(2)));
      for (const cls of ["TypeError", "RangeError", "SyntaxError"]) {
        $.if(this.streq($, $.l(0), this.lit($, cls)), () =>
          $.ret($.new_(this.deps.errT(), $.g(this.deps.vtGlobal(`%${cls}`)), $.l(0), $.l(1), $.l(CODE))),
        );
      }
      $.do($.new_(this.deps.errT(), $.g(this.deps.vtGlobal("%Error")), $.l(0), $.l(1), $.l(CODE)));
    });
  }

  /** `(ptr) -> errRef` — the error record at ptr: name run, message run,
   * u32 hasCause, then the cause's name, message and code runs. */
  private readErrorFn(): number {
    return this.fn("readError", [I32], [this.errRef], (f, $) => {
      const P = f.local(I32);
      const NAME = f.local(this.strRef);
      const MSG = f.local(this.strRef);
      const CN = f.local(this.strRef);
      const CM = f.local(this.strRef);
      const CC = f.local(this.strRef);
      const CAUSE = f.local(this.errRef);
      const TOP = f.local(this.errRef);
      const readRun = this.readRunFn();
      const runEnd = this.runEndFn();
      $.put(P, $.l(0));
      $.put(NAME, $.call(readRun, $.l(P)));
      $.put(P, $.call(runEnd, $.l(P)));
      $.put(MSG, $.call(readRun, $.l(P)));
      $.put(P, $.call(runEnd, $.l(P)));
      $.if($.eq(this.loadU32($, $.l(P)), $.i(0)), () =>
        $.ret($.call(this.errByNameFn(), $.l(NAME), $.l(MSG), $.anew(this.deps.strType(), $.i(0)))),
      );
      $.put(P, $.add($.l(P), $.i(4)));
      $.put(CN, $.call(readRun, $.l(P)));
      $.put(P, $.call(runEnd, $.l(P)));
      $.put(CM, $.call(readRun, $.l(P)));
      $.put(P, $.call(runEnd, $.l(P)));
      $.put(CC, $.call(readRun, $.l(P)));
      $.put(CAUSE, $.call(this.errByNameFn(), $.l(CN), $.l(CM), $.l(CC)));
      // The outer error, its class chosen by name, re-built as a carrier
      // of the cause (class:fetchCause subtypes the builtin error).
      $.put(TOP, $.call(this.errByNameFn(), $.l(NAME), $.l(MSG), $.anew(this.deps.strType(), $.i(0))));
      const ET = this.deps.errT();
      $.do($.new_(this.deps.causeT(), $.get(ET, 0, $.l(TOP)), $.get(ET, 1, $.l(TOP)), $.get(ET, 2, $.l(TOP)), $.get(ET, 3, $.l(TOP)), $.l(CAUSE)));
    });
  }

  /* ── fetch(input, init) ────────────────────────────────────────────── */

  /** `(d) -> i32`: 1 when d is undefined (absent) — the member reads. */
  private isUndef($: A, d: X): X {
    return $.orElse($.isNull(d), this.isKind($, d, DK.UNDEF));
  }

  /** `(obj, key) -> dyn | null` — an OBJ init's member. */
  private member($: A, obj: X, key: string): X {
    return $.call(this.dyn.objGet(), obj, this.lit($, key));
  }

  /** `%w.fetch.start(input, init) -> dyn` — fetch(): the promise box, or
   * null with an error pending (an input or init form not modelled). */
  startFn(): number {
    const dynRefT = this.dynRef;
    return this.fn("start", [dynRefT, dynRefT], [dynRefT], (f, $) => {
      const dyn = this.dyn;
      const STRARR = this.strArrT();
      const P = f.local(this.deps.promRef());
      const O = f.local(dyn.objRef());
      const V = f.local(dynRefT);
      const METHOD = f.local(this.strRef);
      const URL = f.local(this.strRef);
      const REDIR = f.local(this.strRef);
      const BKIND = f.local(I32);
      const BODY = f.local(this.bytesRef);
      const SIG = f.local(this.ref(this.sigT()));
      const NAMES = f.local(this.ref(STRARR));
      const VALUES = f.local(this.ref(STRARR));
      const N = f.local(I32);
      const I = f.local(I32);
      const NEED = f.local(I32);
      const BASE = f.local(I32);
      const PTR = f.local(I32);
      const H = f.local(I32);
      const REQ = f.local(this.ref(this.reqT()));
      // Which of method (bit 0) and redirect (bit 1) the init gave: an
      // empty string is a value the host checks, not its default.
      const GIVEN = f.local(I32);
      const BT = this.deps.bytesType();
      const fence = (what: string): void => {
        this.throwErr($, "%Error", "Error", this.lit($, `fetch() ${what} is not supported yet`));
        $.ret($.nul(dyn.dynT()));
      };
      // The input: a string (Node also takes a URL or a Request).
      $.if($.not(this.isKind($, $.l(0), DK.STR)), () => fence("with an input that is not a string"));
      $.put(URL, this.strOf($, $.l(0)));
      $.put(METHOD, $.anew(this.deps.strType(), $.i(0)));
      $.put(REDIR, $.anew(this.deps.strType(), $.i(0)));
      $.put(NAMES, $.anew(STRARR, $.i(0)));
      $.put(VALUES, $.anew(STRARR, $.i(0)));
      // The init: absent, or an object.
      $.if($.not(this.isUndef($, $.l(1))), () => {
        $.if($.not(this.isKind($, $.l(1), DK.OBJ)), () => fence("with an init that is not a plain object"));
        $.put(O, $.raw((c) => dyn.objPayload(c, (x) => x.localGet(1))));
        for (const key of UNMODELLED_INIT) {
          $.put(V, this.member($, $.l(O), key));
          $.if($.not(this.isUndef($, $.l(V))), () => fence(`with the init member '${key}'`));
        }
        // method
        $.put(V, this.member($, $.l(O), "method"));
        $.if($.not(this.isUndef($, $.l(V))), () => {
          $.if($.not(this.isKind($, $.l(V), DK.STR)), () => fence("with a method that is not a string"));
          $.put(METHOD, this.strOf($, $.l(V)));
          $.put(GIVEN, $.or($.l(GIVEN), $.i(1)));
        });
        // redirect
        $.put(V, this.member($, $.l(O), "redirect"));
        $.if($.not(this.isUndef($, $.l(V))), () => {
          $.if($.not(this.isKind($, $.l(V), DK.STR)), () => fence("with a redirect mode that is not a string"));
          $.put(REDIR, this.strOf($, $.l(V)));
          $.put(GIVEN, $.or($.l(GIVEN), $.i(2)));
        });
        // headers: a plain object, or a Headers value
        $.put(V, this.member($, $.l(O), "headers"));
        $.if($.not(this.isUndef($, $.l(V))), () => {
          $.if(
            this.isHandle($, $.l(V), TAG_HEADERS),
            () => {
              const HT = this.hdrsT();
              $.put(NAMES, $.get(HT, H_NAMES, this.payload($, HT, $.l(V))));
              $.put(VALUES, $.get(HT, H_VALUES, this.payload($, HT, $.l(V))));
              $.put(N, $.get(HT, H_N, this.payload($, HT, $.l(V))));
            },
            () => {
              $.if($.not(this.isKind($, $.l(V), DK.OBJ)), () => fence("with headers that are not a plain object or a Headers value"));
              const E = f.local(dyn.arrRef());
              const PAIR = f.local(dyn.arrRef());
              $.put(E, $.cast(this.dynArrVecType(), $.get(dyn.dynT(), DYN_REF, $.call(dyn.objWalk(), $.l(V), $.i(2)))));
              $.put(N, $.raw((c) => dyn.arrLen(c, (x) => x.localGet(E))));
              $.put(NAMES, $.anew(STRARR, $.l(N)));
              $.put(VALUES, $.anew(STRARR, $.l(N)));
              $.for(I, $.i(0), $.l(N), () => {
                $.put(PAIR, $.raw((c) => {
                  dyn.arrAt(c, (x) => x.localGet(E), (x) => x.localGet(I));
                  c.structGet(dyn.dynT(), DYN_REF);
                  c.refCast(this.dynArrVecType());
                }));
                $.aset(STRARR, $.l(NAMES), $.l(I), this.strOf($, $.raw((c) => dyn.arrAt(c, (x) => x.localGet(PAIR), (x) => x.i32Const(0)))));
                $.aset(STRARR, $.l(VALUES), $.l(I), $.call(dyn.toStr(), $.raw((c) => dyn.arrAt(c, (x) => x.localGet(PAIR), (x) => x.i32Const(1)))));
              });
            },
          );
        });
        // body: a string or bytes
        $.put(V, this.member($, $.l(O), "body"));
        $.if($.not($.orElse(this.isUndef($, $.l(V)), this.isKind($, $.l(V), DK.NULL))), () => {
          $.if(
            this.isKind($, $.l(V), DK.STR),
            () => {
              $.put(BKIND, $.i(1));
              $.put(BODY, $.call(this.deps.strToUtf8(), this.strOf($, $.l(V))));
            },
            () => {
              $.if($.not(this.isKind($, $.l(V), DK.BYTES)), () => fence("with a body that is not a string or bytes"));
              $.put(BKIND, $.i(2));
              $.put(BODY, $.raw((c) => dyn.bytesPayloadBytes(c, (x) => x.localGet(V))));
            },
          );
        });
        // signal: an AbortSignal value
        $.put(V, this.member($, $.l(O), "signal"));
        $.if($.not($.orElse(this.isUndef($, $.l(V)), this.isKind($, $.l(V), DK.NULL))), () => {
          $.if($.not(this.isHandle($, $.l(V), TAG_SIGNAL)), () => fence("with a signal that is not an AbortSignal"));
          $.put(SIG, this.payload($, this.sigT(), $.l(V)));
        });
      });
      $.put(P, $.call(this.deps.promMint()));
      // An aborted signal: rejected with its reason, no request.
      $.if($.andThen($.notNull($.l(SIG)), $.get(this.sigT(), G_ABORTED, $.l(SIG))), () => {
        this.rejectErr($, $.l(P), $.get(this.sigT(), G_REASON, $.l(SIG)));
        $.ret(this.boxPromise($, $.l(P)));
      });
      // The request record's size, then the record.
      $.put(NEED, $.add($.add($.add($.i(12), this.runSize($, $.l(METHOD))), this.runSize($, $.l(URL))), this.runSize($, $.l(REDIR))));
      $.for(I, $.i(0), $.l(N), () => {
        $.put(NEED, $.add($.add($.l(NEED), this.runSize($, $.aget(STRARR, $.l(NAMES), $.l(I)))), this.runSize($, $.aget(STRARR, $.l(VALUES), $.l(I)))));
      });
      $.if($.notNull($.l(BODY)), () => {
        $.put(NEED, $.add($.l(NEED), $.add($.i(4), $.and($.add($.get(BT, 2, $.l(BODY)), $.i(3)), $.i(-4)))));
      });
      $.if($.lt($.l(NEED), $.i(REPLY_ROOM)), () => $.put(NEED, $.i(REPLY_ROOM)));
      this.deps.ensureCapacity($.c, () => $.do($.add($.l(NEED), $.i(3))));
      $.put(BASE, this.base($));
      this.storeU32($, $.l(BASE), $.l(BKIND));
      this.storeU32($, $.add($.l(BASE), $.i(4)), $.l(N));
      this.storeU32($, $.add($.l(BASE), $.i(8)), $.l(GIVEN));
      const writeRun = this.writeRunFn();
      $.put(PTR, $.call(writeRun, $.l(METHOD), $.add($.l(BASE), $.i(12))));
      $.put(PTR, $.call(writeRun, $.l(URL), $.l(PTR)));
      $.put(PTR, $.call(writeRun, $.l(REDIR), $.l(PTR)));
      $.for(I, $.i(0), $.l(N), () => {
        $.put(PTR, $.call(writeRun, $.aget(STRARR, $.l(NAMES), $.l(I)), $.l(PTR)));
        $.put(PTR, $.call(writeRun, $.aget(STRARR, $.l(VALUES), $.l(I)), $.l(PTR)));
      });
      $.if($.notNull($.l(BODY)), () => {
        this.storeU32($, $.l(PTR), $.get(BT, 2, $.l(BODY)));
        $.put(PTR, $.add($.l(PTR), $.i(4)));
        $.for(I, $.i(0), $.get(BT, 2, $.l(BODY)), () => {
          $.do($.add($.l(PTR), $.l(I)), $.agetU(this.deps.bufType(), $.get(BT, 0, $.l(BODY)), $.add($.get(BT, 1, $.l(BODY)), $.l(I))));
          $.c.i32Store8();
        });
        $.put(PTR, $.add($.l(PTR), $.and($.add($.get(BT, 2, $.l(BODY)), $.i(3)), $.i(-4))));
      });
      $.put(H, $.call(this.importFn(), $.i(OP_START), $.l(BASE), $.sub($.l(PTR), $.l(BASE)), $.i(0), $.l(NEED)));
      // A request the host refuses at once (Node's Request constructor
      // throws inside fetch): rejected now, with the host's error.
      $.if($.eq($.l(H), $.i(-1)), () => {
        this.rejectErr($, $.l(P), $.call(this.readErrorFn(), $.l(BASE)));
        $.ret(this.boxPromise($, $.l(P)));
      });
      $.if($.lt($.l(H), $.i(1)), () => {
        this.trap($);
        $.ret($.nul(dyn.dynT()));
      });
      $.put(REQ, $.new_(this.reqT(), $.l(H), $.l(P), $.nul(this.respT()), $.i(0), $.d(0)));
      $.run(this.tableSetFn(), $.l(H), $.l(REQ));
      $.gput(this.g().live, $.add($.g(this.g().live), $.i(1)));
      $.if($.notNull($.l(SIG)), () => $.run(this.sigListenFn(), $.l(SIG), $.l(REQ)));
      $.do(this.boxPromise($, $.l(P)));
    });
  }

  /** The dyn ARR payload's vector struct type. */
  private dynArrVecType(): number {
    const t = this.dyn.arrRef();
    if (t.kind !== "ref") throw new Error("fetch: the dyn array is not a reference type");
    return t.typeIndex;
  }

  /* ── the request table ─────────────────────────────────────────────── */

  /** `(h, req)` — grows by copy; a null req clears. */
  private tableSetFn(): number {
    return this.fn("tableSet", [I32, this.ref(this.reqT())], [], (f, $) => {
      const AT = this.reqArrT();
      const T = this.g().table;
      const NEW = f.local(this.ref(AT));
      const N = f.local(I32);
      $.if($.orElse($.isNull($.g(T)), $.geU($.l(0), $.alen($.g(T)))), () => {
        $.put(N, $.add($.shl($.l(0), $.i(1)), $.i(8)));
        $.put(NEW, $.anew(AT, $.l(N)));
        $.if($.notNull($.g(T)), () => {
          $.do($.l(NEW), $.i(0), $.g(T), $.i(0), $.alen($.g(T)));
          $.c.arrayCopy(AT, AT);
        });
        $.gput(T, $.l(NEW));
      });
      $.aset(AT, $.g(T), $.l(0), $.l(1));
    });
  }

  /** `(h) -> req | null` */
  private tableGetFn(): number {
    return this.fn("tableGet", [I32], [this.ref(this.reqT())], (f, $) => {
      const T = this.g().table;
      $.if($.orElse($.isNull($.g(T)), $.geU($.l(0), $.alen($.g(T)))), () => $.ret($.nul(this.reqT())));
      $.do($.aget(this.reqArrT(), $.g(T), $.l(0)));
    });
  }

  /** `(req)` — the request no longer holds the loop or its handle. */
  private finishFn(): number {
    return this.fn("finish", [this.ref(this.reqT())], [], (f, $) => {
      $.if($.eq($.get(this.reqT(), R_STATE, $.l(0)), $.i(2)), () => $.ret());
      $.set(this.reqT(), R_STATE, $.l(0), $.i(2));
      $.run(this.tableSetFn(), $.get(this.reqT(), R_H, $.l(0)), $.nul(this.reqT()));
      $.gput(this.g().live, $.sub($.g(this.g().live), $.i(1)));
    });
  }

  /* ── the poll phase ────────────────────────────────────────────────── */

  /** `%w.fetch.poll()` — every queued host event, oldest first, each
   * followed by the death check and a checkpoint. */
  pollHelper(): number {
    return this.fn("poll", [], [], (f, $) => {
      const c = $.c;
      const BASE = f.local(I32);
      const LEN = f.local(I32);
      const PLEN = f.local(I32);
      const g = this.g();
      c.block();
      c.loop();
      this.deps.ensureCapacity(c, () => $.do($.add($.g(g.cap), $.i(3))));
      $.put(BASE, this.base($));
      $.put(LEN, $.call(this.deps.evPollFunc(), $.l(BASE), $.g(g.cap)));
      $.do($.not($.l(LEN)));
      c.brIf(1);
      $.if($.lt($.l(LEN), $.i(0)), () => {
        $.if($.le($.sub($.i(0), $.l(LEN)), $.g(g.cap)), () => this.trap($));
        $.gput(g.cap, $.sub($.i(0), $.l(LEN)));
        c.br(1);
      });
      $.if($.ne(this.loadU32($, $.l(BASE)), $.i(SRC_FETCH)), () => {
        const foreign = this.deps.foreign;
        if (foreign !== undefined) {
          $.run(foreign(), $.l(BASE), $.l(LEN));
          c.br(1);
        } else {
          this.trap($);
        }
      });
      $.put(PLEN, this.loadU32($, $.add($.l(BASE), $.i(12))));
      $.if($.ne($.l(LEN), $.add($.l(PLEN), $.i(EV_HEADER_BYTES))), () => this.trap($));
      $.run(
        this.eventFn(),
        this.loadU32($, $.add($.l(BASE), $.i(8))),
        this.loadU32($, $.add($.l(BASE), $.i(4))),
        this.loadU32($, $.add($.l(BASE), $.i(16))),
        this.loadU32($, $.add($.l(BASE), $.i(20))),
        $.add($.l(BASE), $.i(EV_HEADER_BYTES)),
        $.l(PLEN),
      );
      $.if(this.pending($), () => $.run(this.deps.reportUncaught()));
      this.deps.checkpoint(c);
      c.br(0);
      c.end();
      c.end();
    });
  }

  /** `(kind, h, a, b, ptr, len)` — one source-6 event. */
  private eventFn(): number {
    return this.fn("event", [I32, I32, I32, I32, I32, I32], [], (f, $) => {
      const KIND = 0, H = 1, A_ = 2, B_ = 3, PTR = 4, LEN = 5;
      const REQ = f.local(this.ref(this.reqT()));
      const RESP = f.local(this.ref(this.respT()));
      const RT = this.reqT();
      const ST = this.respT();
      $.put(REQ, $.call(this.tableGetFn(), $.l(H)));
      $.if($.orElse($.isNull($.l(REQ)), $.eq($.get(RT, R_STATE, $.l(REQ)), $.i(2))), () => {
        this.trap($);
        $.ret();
      });
      $.if($.eq($.l(KIND), $.i(EV_HEAD)), () => {
        $.if($.ne($.get(RT, R_STATE, $.l(REQ)), $.i(0)), () => {
          this.trap($);
          $.ret();
        });
        $.put(RESP, $.call(this.readHeadFn(), $.l(A_), $.l(B_), $.l(PTR)));
        $.set(RT, R_RESP, $.l(REQ), $.l(RESP));
        $.set(RT, R_STATE, $.l(REQ), $.i(1));
        this.resolveDyn($, $.get(RT, R_P, $.l(REQ)), this.boxHandle($, TAG_RESPONSE, $.l(RESP)));
        $.ret();
      });
      $.if($.eq($.l(KIND), $.i(EV_BODY)), () => {
        $.if($.ne($.get(RT, R_STATE, $.l(REQ)), $.i(1)), () => {
          this.trap($);
          $.ret();
        });
        $.put(RESP, $.get(RT, R_RESP, $.l(REQ)));
        $.set(ST, S_BODY, $.l(RESP), $.call(this.bytesAtFn(), $.l(PTR), $.l(LEN)));
        $.set(ST, S_BODYST, $.l(RESP), $.i(1));
        $.run(this.finishFn(), $.l(REQ));
        $.run(this.deliverFn(), $.l(RESP));
        $.ret();
      });
      $.if($.eq($.l(KIND), $.i(EV_FAIL)), () => {
        $.run(this.failFn(), $.l(REQ), $.call(this.readErrorFn(), $.l(PTR)));
        $.ret();
      });
      this.trap($);
    });
  }

  /** `(req, err)` — the request fails: fetch() rejects before its head,
   * the body readers after it. */
  private failFn(): number {
    return this.fn("fail", [this.ref(this.reqT()), this.errRef], [], (f, $) => {
      const RT = this.reqT();
      const ST = this.respT();
      const RESP = f.local(this.ref(ST));
      $.if($.eq($.get(RT, R_STATE, $.l(0)), $.i(2)), () => $.ret());
      $.if(
        $.eq($.get(RT, R_STATE, $.l(0)), $.i(0)),
        () => this.rejectErr($, $.get(RT, R_P, $.l(0)), $.l(1)),
        () => {
          $.put(RESP, $.get(RT, R_RESP, $.l(0)));
          $.set(ST, S_ERR, $.l(RESP), $.l(1));
          $.set(ST, S_BODYST, $.l(RESP), $.i(2));
        },
      );
      $.run(this.finishFn(), $.l(0));
      $.if($.notNull($.l(RESP)), () => $.run(this.deliverFn(), $.l(RESP)));
    });
  }

  /** `(status, flags, ptr) -> resp` — a HEAD's payload: statusText run,
   * url run, type run, u32 n, n (name, value) run pairs. flags bit 0 = redirected,
   * bit 1 = a null body. */
  private readHeadFn(): number {
    return this.fn("readHead", [I32, I32, I32], [this.ref(this.respT())], (f, $) => {
      const STRARR = this.strArrT();
      const P = f.local(I32);
      const ST = f.local(this.strRef);
      const URL = f.local(this.strRef);
      const TYPE = f.local(this.strRef);
      const N = f.local(I32);
      const I = f.local(I32);
      const NAMES = f.local(this.ref(STRARR));
      const VALUES = f.local(this.ref(STRARR));
      const readRun = this.readRunFn();
      const runEnd = this.runEndFn();
      $.put(P, $.l(2));
      $.put(ST, $.call(readRun, $.l(P)));
      $.put(P, $.call(runEnd, $.l(P)));
      $.put(URL, $.call(readRun, $.l(P)));
      $.put(P, $.call(runEnd, $.l(P)));
      $.put(TYPE, $.call(readRun, $.l(P)));
      $.put(P, $.call(runEnd, $.l(P)));
      $.put(N, this.loadU32($, $.l(P)));
      $.put(P, $.add($.l(P), $.i(4)));
      $.put(NAMES, $.anew(STRARR, $.l(N)));
      $.put(VALUES, $.anew(STRARR, $.l(N)));
      $.for(I, $.i(0), $.l(N), () => {
        $.aset(STRARR, $.l(NAMES), $.l(I), $.call(readRun, $.l(P)));
        $.put(P, $.call(runEnd, $.l(P)));
        $.aset(STRARR, $.l(VALUES), $.l(I), $.call(readRun, $.l(P)));
        $.put(P, $.call(runEnd, $.l(P)));
      });
      $.do(
        $.new_(
          this.respT(),
          $.i2d($.l(0)),
          $.l(ST),
          $.l(URL),
          $.and($.l(1), $.i(1)),
          $.ne($.and($.l(1), $.i(2)), $.i(0)),
          $.new_(this.hdrsT(), $.l(NAMES), $.l(VALUES), $.l(N), $.i(0)),
          $.i(0),
          $.nul(this.deps.bytesType()),
          $.nul(this.deps.errT()),
          $.i(0),
          $.nul(this.promT()),
          $.i(0),
          $.l(TYPE),
        ),
      );
    });
  }

  private promT(): number {
    const t = this.deps.promRef();
    if (t.kind !== "ref") throw new Error("fetch: the promise is not a reference type");
    return t.typeIndex;
  }

  /* ── the body readers ──────────────────────────────────────────────── */

  /** `(resp)` — settle the waiting body reader, if any, once the body is
   * complete or failed. */
  private deliverFn(): number {
    return this.fn("deliver", [this.ref(this.respT())], [], (f, $) => {
      const ST = this.respT();
      const P = f.local(this.deps.promRef());
      $.if($.orElse($.isNull($.get(ST, S_WAITP, $.l(0))), $.eq($.get(ST, S_BODYST, $.l(0)), $.i(0))), () => $.ret());
      $.put(P, $.get(ST, S_WAITP, $.l(0)));
      $.set(ST, S_WAITP, $.l(0), $.nul(this.promT()));
      $.run(this.settleReaderFn(), $.l(0), $.l(P), $.get(ST, S_WAITK, $.l(0)));
    });
  }

  /** `(resp, p, kind)` — settle reader promise p from a complete (or
   * failed) body. */
  private settleReaderFn(): number {
    return this.fn("settleReader", [this.ref(this.respT()), this.deps.promRef(), I32], [], (f, $) => {
      const ST = this.respT();
      const dyn = this.dyn;
      const B = f.local(this.bytesRef);
      const V = f.local(this.dynRef);
      $.if($.eq($.get(ST, S_BODYST, $.l(0)), $.i(2)), () => {
        this.rejectErr($, $.l(1), $.get(ST, S_ERR, $.l(0)));
        $.ret();
      });
      $.put(B, $.get(ST, S_BODY, $.l(0)));
      $.if($.eq($.l(2), $.i(K_TEXT)), () => {
        this.resolveDyn($, $.l(1), this.boxStr($, $.call(this.deps.textDecode(), $.l(B))));
        $.ret();
      });
      $.if($.eq($.l(2), $.i(K_JSON)), () => {
        $.put(V, $.call(this.deps.jsonParse(), $.call(this.deps.textDecode(), $.l(B))));
        $.if(this.pending($), () => {
          this.rejectCell($, $.l(1));
          $.ret();
        });
        this.resolveDyn($, $.l(1), $.l(V));
        $.ret();
      });
      $.if($.eq($.l(2), $.i(K_ARRAYBUFFER)), () => {
        this.resolveDyn($, $.l(1), this.boxHandle($, TAG_ARRAYBUFFER, $.new_(this.abT(), $.l(B), $.d(0), $.d(0))));
        $.ret();
      });
      this.resolveDyn(
        $,
        $.l(1),
        $.raw((c) =>
          dyn.boxBytes(c, (x) =>
            dyn.pushNewBytesPayload(
              x,
              (y) => {
                y.localGet(B);
                y.call(this.bytesCopyFn());
              },
              (y) => y.i32Const(0),
            ),
          ),
        ),
      );
    });
  }

  /** `(resp, kind) -> dyn` — text() / json() / arrayBuffer() / bytes():
   * a promise box. A used body rejects with Node's TypeError; a null body
   * reads as empty and is never marked used. */
  private consumeFn(): number {
    return this.fn("consume", [this.ref(this.respT()), I32], [this.dynRef], (f, $) => {
      const ST = this.respT();
      const P = f.local(this.deps.promRef());
      $.put(P, $.call(this.deps.promMint()));
      $.if($.get(ST, S_USED, $.l(0)), () => {
        this.rejectErr($, $.l(P), this.newErr($, "%TypeError", "TypeError", this.lit($, "Body is unusable: Body has already been read")));
        $.ret(this.boxPromise($, $.l(P)));
      });
      $.if($.not($.get(ST, S_NULLBODY, $.l(0))), () => $.set(ST, S_USED, $.l(0), $.i(1)));
      $.if(
        $.ne($.get(ST, S_BODYST, $.l(0)), $.i(0)),
        () => $.run(this.settleReaderFn(), $.l(0), $.l(P), $.l(1)),
        () => {
          $.set(ST, S_WAITP, $.l(0), $.l(P));
          $.set(ST, S_WAITK, $.l(0), $.l(1));
        },
      );
      $.do(this.boxPromise($, $.l(P)));
    });
  }

  /* ── AbortSignal ───────────────────────────────────────────────────── */

  /** `(sig, req)` — the signal will abort req. */
  private sigListenFn(): number {
    return this.fn("sigListen", [this.ref(this.sigT()), this.ref(this.reqT())], [], (f, $) => {
      const GT = this.sigT();
      const AT = this.reqArrT();
      const NEW = f.local(this.ref(AT));
      const N = f.local(I32);
      $.put(N, $.get(GT, G_LISN, $.l(0)));
      $.if($.orElse($.isNull($.get(GT, G_LIS, $.l(0))), $.geU($.l(N), $.alen($.get(GT, G_LIS, $.l(0))))), () => {
        $.put(NEW, $.anew(AT, $.add($.shl($.l(N), $.i(1)), $.i(4))));
        $.if($.notNull($.get(GT, G_LIS, $.l(0))), () => {
          $.do($.l(NEW), $.i(0), $.get(GT, G_LIS, $.l(0)), $.i(0), $.l(N));
          $.c.arrayCopy(AT, AT);
        });
        $.set(GT, G_LIS, $.l(0), $.l(NEW));
      });
      $.aset(AT, $.get(GT, G_LIS, $.l(0)), $.l(N), $.l(1));
      $.set(GT, G_LISN, $.l(0), $.add($.l(N), $.i(1)));
    });
  }

  /** `(sig, reason)` — abort: every request still running is aborted at
   * the host and rejects with the reason, fetch() before its head and the
   * body readers after it. */
  private sigAbortFn(): number {
    return this.fn("sigAbort", [this.ref(this.sigT()), this.errRef], [], (f, $) => {
      const GT = this.sigT();
      const RT = this.reqT();
      const I = f.local(I32);
      const REQ = f.local(this.ref(RT));
      $.if($.get(GT, G_ABORTED, $.l(0)), () => $.ret());
      $.set(GT, G_ABORTED, $.l(0), $.i(1));
      $.set(GT, G_REASON, $.l(0), $.l(1));
      $.for(I, $.i(0), $.get(GT, G_LISN, $.l(0)), () => {
        $.put(REQ, $.aget(this.reqArrT(), $.get(GT, G_LIS, $.l(0)), $.l(I)));
        $.if($.ne($.get(RT, R_STATE, $.l(REQ)), $.i(2)), () => {
          // A module without fetch() has no request to abort (no listener
          // was ever added), so it carries no ABORT and no import.
          const fc = this.deps.fetchCallFunc();
          if (fc !== null) $.drop($.call(fc, $.i(OP_ABORT), $.i(0), $.i(0), $.get(RT, R_H, $.l(REQ)), $.i(0)));
          $.run(this.failFn(), $.l(REQ), $.l(1));
        });
      });
      $.set(GT, G_LISN, $.l(0), $.i(0));
      $.set(GT, G_LIS, $.l(0), $.nul(this.reqArrT()));
    });
  }

  /** The timer callback: `(clos)`. */
  private sigTimerFn(): number {
    const pair = this.deps.voidClos();
    const hit = this.fns.get("sigTimer");
    if (hit !== undefined) return hit;
    const idx = this.mb.declareFunc(pair.fn, "%w.fetch.sigTimer");
    this.fns.set("sigTimer", idx);
    const f = new Fn(1);
    const $ = new A(f);
    $.run(
      this.sigAbortFn(),
      $.get(this.sigClosT(), 1, $.cast(this.sigClosT(), $.l(0))),
      $.call(this.deps.domexNew(), this.boxStr($, this.lit($, "The operation was aborted due to timeout")), this.boxStr($, this.lit($, "TimeoutError"))),
    );
    this.mb.setBody(idx, f.locals, f.c.bytes());
    return idx;
  }

  private newSig($: A): X {
    return $.new_(this.sigT(), $.i(0), $.nul(this.deps.errT()), $.nul(this.reqArrT()), $.i(0), $.i(0), $.i(0));
  }

  /** `%w.fetch.timeout(delay) -> dyn` — AbortSignal.timeout(delay):
   * validateUint32(delay, 'delay'), then an unref'd timer that aborts the
   * signal with a TimeoutError DOMException. */
  timeoutFn(): number {
    return this.fn("timeout", [this.dynRef], [this.dynRef], (f, $) => {
      const D = f.local(F64);
      const SIG = f.local(this.ref(this.sigT()));
      const dyn = this.dyn;
      $.if($.not(this.isKind($, $.l(0), DK.NUM)), () => {
        this.throwErr(
          $,
          "%TypeError",
          "TypeError",
          this.cat($, this.lit($, 'The "delay" argument must be of type number. Received '), $.call(dyn.specificType(), $.l(0))),
          "ERR_INVALID_ARG_TYPE",
        );
        $.ret($.nul(dyn.dynT()));
      });
      $.put(D, $.get(dyn.dynT(), DYN_NUM, $.l(0)));
      // Number.isInteger: finite and equal to its truncation.
      $.if($.not($.raw((c) => {
        c.localGet(D);
        c.localGet(D);
        c.f64Trunc();
        c.f64Eq();
        c.localGet(D);
        c.f64Abs();
        c.f64Const(Infinity);
        c.f64Ne();
        c.i32And();
      })), () => {
        this.throwErr(
          $,
          "%RangeError",
          "RangeError",
          this.cat($, this.lit($, 'The value of "delay" is out of range. It must be an integer. Received '), $.call(this.deps.numReceived(), $.l(D))),
          "ERR_OUT_OF_RANGE",
        );
        $.ret($.nul(dyn.dynT()));
      });
      $.if($.either($.dlt($.l(D), $.d(0)), $.dgt($.l(D), $.d(4294967295))), () => {
        this.throwErr(
          $,
          "%RangeError",
          "RangeError",
          this.cat($, this.lit($, 'The value of "delay" is out of range. It must be >= 0 && <= 4294967295. Received '), $.call(this.deps.numReceived(), $.l(D))),
          "ERR_OUT_OF_RANGE",
        );
        $.ret($.nul(dyn.dynT()));
      });
      $.put(SIG, this.newSig($));
      const fn = this.sigTimerFn();
      this.mb.declareFuncRef(fn);
      $.drop(
        $.call(
          this.deps.unrefTimer(),
          $.call(
            this.deps.setTimeoutHandle(),
            $.raw((c) => {
              c.refFunc(fn);
              c.localGet(SIG);
              c.structNew(this.sigClosT());
            }),
            $.l(D),
          ),
        ),
      );
      $.do(this.boxHandle($, TAG_SIGNAL, $.l(SIG)));
    });
  }

  /** `%w.fetch.abortNow() -> dyn` — AbortSignal.abort(): already aborted,
   * its reason an AbortError DOMException. */
  abortNowFn(): number {
    return this.fn("abortNow", [], [this.dynRef], (f, $) => {
      const SIG = f.local(this.ref(this.sigT()));
      $.put(SIG, this.newSig($));
      $.run(
        this.sigAbortFn(),
        $.l(SIG),
        $.call(this.deps.domexNew(), this.boxStr($, this.lit($, "This operation was aborted")), this.boxStr($, this.lit($, "AbortError"))),
      );
      $.do(this.boxHandle($, TAG_SIGNAL, $.l(SIG)));
    });
  }

  /* ── the handle surface (dyn keyGet / invoke) ──────────────────────── */

  /** `(d, key) -> dyn` — a property of a Response, Headers, AbortSignal
   * or ArrayBuffer; anything else a named Error. */
  keyGetFn(): number {
    return this.fn("keyGet", [this.dynRef, this.strRef], [this.dynRef], (f, $) => {
      const dyn = this.dyn;
      const ST = this.respT();
      const R = f.local(this.ref(ST));
      const G = f.local(this.ref(this.sigT()));
      const is = (key: string): X => this.streq($, $.l(1), this.lit($, key));
      const tag = $.get(dyn.dynT(), DYN_NUM, $.l(0));
      $.if($.deq(tag, $.d(TAG_RESPONSE)), () => {
        $.put(R, this.payload($, ST, $.l(0)));
        $.if(is("status"), () => $.ret(this.boxNum($, $.get(ST, S_STATUS, $.l(R)))));
        $.if(is("ok"), () =>
          $.ret(this.boxBool($, $.both($.dge($.get(ST, S_STATUS, $.l(R)), $.d(200)), $.dle($.get(ST, S_STATUS, $.l(R)), $.d(299))))),
        );
        $.if(is("statusText"), () => $.ret(this.boxStr($, $.get(ST, S_STATUSTEXT, $.l(R)))));
        $.if(is("url"), () => $.ret(this.boxStr($, $.get(ST, S_URL, $.l(R)))));
        $.if(is("redirected"), () => $.ret(this.boxBool($, $.get(ST, S_REDIRECTED, $.l(R)))));
        $.if(is("type"), () => $.ret(this.boxStr($, $.get(ST, S_TYPE, $.l(R)))));
        $.if(is("bodyUsed"), () => $.ret(this.boxBool($, $.get(ST, S_USED, $.l(R)))));
        $.if(is("headers"), () => $.ret(this.boxHandle($, TAG_HEADERS, $.get(ST, S_HDRS, $.l(R)))));
        $.if(is("body"), () => {
          this.throwErr($, "%Error", "Error", this.lit($, "Response.body (a ReadableStream) is not supported yet"));
          $.ret($.nul(dyn.dynT()));
        });
        this.throwErr($, "%Error", "Error", this.cat($, this.cat($, this.lit($, "reading the property '"), $.l(1)), this.lit($, "' of a Response is not supported yet")));
        $.ret($.nul(dyn.dynT()));
      });
      $.if($.deq(tag, $.d(TAG_SIGNAL)), () => {
        $.put(G, this.payload($, this.sigT(), $.l(0)));
        $.if(is("aborted"), () => $.ret(this.boxBool($, $.get(this.sigT(), G_ABORTED, $.l(G)))));
        $.if(is("reason"), () =>
          $.ret($.sel(this.dynRef, $.get(this.sigT(), G_ABORTED, $.l(G)), $.call(dyn.fromError(), $.get(this.sigT(), G_REASON, $.l(G))), this.undef($))),
        );
        this.throwErr($, "%Error", "Error", this.cat($, this.cat($, this.lit($, "reading the property '"), $.l(1)), this.lit($, "' of an AbortSignal is not supported yet")));
        $.ret($.nul(dyn.dynT()));
      });
      $.if($.deq(tag, $.d(TAG_ARRAYBUFFER)), () => {
        $.if(is("byteLength"), () => $.ret(this.boxNum($, $.i2d($.get(this.deps.bytesType(), 2, $.get(this.abT(), 0, this.payload($, this.abT(), $.l(0))))))));
        this.throwErr($, "%Error", "Error", this.cat($, this.cat($, this.lit($, "reading the property '"), $.l(1)), this.lit($, "' of an ArrayBuffer is not supported yet")));
        $.ret($.nul(dyn.dynT()));
      });
      this.throwErr($, "%Error", "Error", this.cat($, this.cat($, this.lit($, "reading the property '"), $.l(1)), this.lit($, "' of a Headers value is not supported yet")));
      $.do($.nul(dyn.dynT()));
    });
  }

  private static readonly RESPONSE_METHODS: Record<string, number> = {
    text: K_TEXT,
    json: K_JSON,
    arrayBuffer: K_ARRAYBUFFER,
    bytes: K_BYTES,
  };

  private static readonly HEADERS_METHODS = ["get", "has", "getSetCookie", "forEach", "set", "append", "delete"];

  private static readonly FENCED_METHODS: Record<string, string> = {
    blob: "Response.blob() (Blob) is not supported yet",
    formData: "Response.formData() (FormData) is not supported yet",
    clone: "Response.clone() is not supported yet",
    getReader: "a ReadableStream reader is not supported yet",
  };

  /** The dispatch function for `d.<method>(...args)` on a fetch value, or
   * null when no fetch value has that member. */
  invokeFn(method: string): number | null {
    const kind = FetchBuilder.RESPONSE_METHODS[method];
    const isHdr = FetchBuilder.HEADERS_METHODS.includes(method);
    const fenced = FetchBuilder.FENCED_METHODS[method];
    if (kind === undefined && !isHdr && fenced === undefined) return null;
    const dyn = this.dyn;
    const arrRefT = dyn.arrRef();
    return this.fn(`invoke:${method}`, [this.dynRef, arrRefT, this.strRef], [this.dynRef], (f, $) => {
      const tag = $.get(dyn.dynT(), DYN_NUM, $.l(0));
      const otherwise = (): void => {
        this.throwErr($, "%Error", "Error", this.lit($, `'${method}' on this fetch value is not supported yet`));
        $.ret($.nul(dyn.dynT()));
      };
      if (fenced !== undefined) {
        this.throwErr($, "%Error", "Error", this.lit($, fenced));
        $.ret($.nul(dyn.dynT()));
        return;
      }
      if (kind !== undefined) {
        $.if($.dne(tag, $.d(TAG_RESPONSE)), otherwise);
        $.ret($.call(this.consumeFn(), this.payload($, this.respT(), $.l(0)), $.i(kind)));
        return;
      }
      $.if($.dne(tag, $.d(TAG_HEADERS)), otherwise);
      $.ret($.call(this.headersFn(method), this.payload($, this.hdrsT(), $.l(0)), $.l(1), $.l(0)));
    });
  }

  /** `(args, i) -> dyn` — argument i, undefined past the end. */
  private argFn(): number {
    const dyn = this.dyn;
    return this.fn("arg", [dyn.arrRef(), I32], [this.dynRef], (f, $) => {
      $.if($.geU($.l(1), $.raw((c) => dyn.arrLen(c, (x) => x.localGet(0)))), () => $.ret(this.undef($)));
      $.do($.raw((c) => dyn.arrAt(c, (x) => x.localGet(0), (x) => x.localGet(1))));
    });
  }

  /** `(d) -> string | null` — webidl's ByteString conversion: ToString,
   * then every code unit <= 255 (Node's text); null with the TypeError
   * pending. */
  private byteStringFn(): number {
    return this.fn("byteString", [this.dynRef], [this.strRef], (f, $) => {
      const S = f.local(this.strRef);
      const I = f.local(I32);
      const U = f.local(I32);
      const SA = this.deps.strType();
      $.put(S, $.call(this.dyn.toStr(), $.l(0)));
      $.if(this.pending($), () => $.ret($.nul(SA)));
      $.for(I, $.i(0), $.alen($.l(S)), () => {
        $.put(U, $.agetU(SA, $.l(S), $.l(I)));
        $.if($.gtU($.l(U), $.i(255)), () => {
          this.throwErr(
            $,
            "%TypeError",
            "TypeError",
            this.cat(
              $,
              this.cat(
                $,
                this.cat($, this.lit($, "Cannot convert argument to a ByteString because the character at index "), $.call(this.deps.f64ToStr(), $.i2d($.l(I)))),
                this.cat($, this.lit($, " has a value of "), $.call(this.deps.f64ToStr(), $.i2d($.l(U)))),
              ),
              this.lit($, " which is greater than 255."),
            ),
          );
          $.ret($.nul(SA));
        });
      });
      $.do($.l(S));
    });
  }

  /** `(what, d) -> string | null` — Headers' name argument: the ByteString
   * conversion, then the header-name token check (Node's text), lowercased;
   * null with the TypeError pending. */
  private headerNameFn(): number {
    return this.fn("headerName", [this.strRef, this.dynRef], [this.strRef], (f, $) => {
      const S = f.local(this.strRef);
      const I = f.local(I32);
      const U = f.local(I32);
      const OK = f.local(I32);
      const OUT = f.local(this.strRef);
      const SA = this.deps.strType();
      $.put(S, $.call(this.byteStringFn(), $.l(1)));
      $.if($.isNull($.l(S)), () => $.ret($.nul(SA)));
      // The token check: !#$%&'*+-.^_`|~, digits and letters, non-empty.
      $.put(OK, $.ne($.alen($.l(S)), $.i(0)));
      $.for(I, $.i(0), $.alen($.l(S)), () => {
        $.put(U, $.agetU(SA, $.l(S), $.l(I)));
        const ranges: X[] = [
          $.both($.geU($.l(U), $.i(0x30)), $.leU($.l(U), $.i(0x39))),
          $.both($.geU($.l(U), $.i(0x41)), $.leU($.l(U), $.i(0x5a))),
          $.both($.geU($.l(U), $.i(0x61)), $.leU($.l(U), $.i(0x7a))),
          ...[..."!#$%&'*+-.^_`|~"].map((ch) => $.eq($.l(U), $.i(ch.charCodeAt(0)))),
        ];
        let any = ranges[0]!;
        for (const r of ranges.slice(1)) any = $.or(any, r);
        $.if($.not(any), () => $.put(OK, $.i(0)));
      });
      $.if($.not($.l(OK)), () => {
        this.throwErr(
          $,
          "%TypeError",
          "TypeError",
          this.cat($, this.cat($, this.cat($, $.l(0), this.lit($, ': "')), $.l(S)), this.lit($, '" is an invalid header name.')),
        );
        $.ret($.nul(SA));
      });
      // ASCII lowercase.
      $.put(OUT, $.anew(SA, $.alen($.l(S))));
      $.for(I, $.i(0), $.alen($.l(S)), () => {
        $.put(U, $.agetU(SA, $.l(S), $.l(I)));
        $.aset(SA, $.l(OUT), $.l(I), $.sel(I32, $.both($.geU($.l(U), $.i(0x41)), $.leU($.l(U), $.i(0x5a))), $.add($.l(U), $.i(32)), $.l(U)));
      });
      $.do($.l(OUT));
    });
  }

  /** `(what, d) -> string | null` — a header value: the ByteString
   * conversion, the normalization (leading and trailing tab, LF, CR and
   * space dropped) and the validity check (no NUL, CR or LF), Node's
   * text naming the normalized value; null with the TypeError pending. */
  private headerValueFn(): number {
    return this.fn("headerValue", [this.strRef, this.dynRef], [this.strRef], (f, $) => {
      const S = f.local(this.strRef);
      const A0 = f.local(I32);
      const B0 = f.local(I32);
      const I = f.local(I32);
      const U = f.local(I32);
      const OUT = f.local(this.strRef);
      const SA = this.deps.strType();
      const ws = (u: X): X => $.or($.or($.eq(u, $.i(9)), $.eq(u, $.i(10))), $.or($.eq(u, $.i(13)), $.eq(u, $.i(32))));
      $.put(S, $.call(this.byteStringFn(), $.l(1)));
      $.if($.isNull($.l(S)), () => $.ret($.nul(SA)));
      $.put(B0, $.alen($.l(S)));
      $.while($.andThen($.lt($.l(A0), $.l(B0)), ws($.agetU(SA, $.l(S), $.l(A0)))), () => $.put(A0, $.add($.l(A0), $.i(1))));
      $.while($.andThen($.lt($.l(A0), $.l(B0)), ws($.agetU(SA, $.l(S), $.sub($.l(B0), $.i(1))))), () => $.put(B0, $.sub($.l(B0), $.i(1))));
      $.put(OUT, $.anew(SA, $.sub($.l(B0), $.l(A0))));
      $.do($.l(OUT), $.i(0), $.l(S), $.l(A0), $.sub($.l(B0), $.l(A0)));
      $.c.arrayCopy(SA, SA);
      $.for(I, $.i(0), $.alen($.l(OUT)), () => {
        $.put(U, $.agetU(SA, $.l(OUT), $.l(I)));
        $.if($.or($.or($.eq($.l(U), $.i(0)), $.eq($.l(U), $.i(10))), $.eq($.l(U), $.i(13))), () => {
          this.throwErr(
            $,
            "%TypeError",
            "TypeError",
            this.cat($, this.cat($, this.cat($, $.l(0), this.lit($, ': "')), $.l(OUT)), this.lit($, '" is an invalid header value.')),
          );
          $.ret($.nul(SA));
        });
      });
      $.do($.l(OUT));
    });
  }

  /** `(hdrs, args, self) -> dyn` — get / has / getSetCookie / forEach. */
  private headersFn(method: string): number {
    const dyn = this.dyn;
    return this.fn(`headers:${method}`, [this.ref(this.hdrsT()), dyn.arrRef(), this.dynRef], [this.dynRef], (f, $) => {
      const HT = this.hdrsT();
      const STRARR = this.strArrT();
      const NAME = f.local(this.strRef);
      const I = f.local(I32);
      const ACC = f.local(this.strRef);
      const V = f.local(dyn.arrRef());
      const CB = f.local(this.dynRef);
      const ARGS = f.local(dyn.arrRef());
      const argc = $.raw((c) => dyn.arrLen(c, (x) => x.localGet(1)));
      const nameAt = (i: X): X => $.aget(STRARR, $.get(HT, H_NAMES, $.l(0)), i);
      const valueAt = (i: X): X => $.aget(STRARR, $.get(HT, H_VALUES, $.l(0)), i);
      const required = (): void => {
        $.if($.eq(argc, $.i(0)), () => {
          this.throwErr($, "%TypeError", "TypeError", this.lit($, `Headers.${method}: 1 argument required, but 0 found.`));
          $.ret($.nul(dyn.dynT()));
        });
      };
      if (method === "get" || method === "has") {
        required();
        $.put(NAME, $.call(this.headerNameFn(), this.lit($, `Headers.${method}`), $.call(this.argFn(), $.l(1), $.i(0))));
        $.if($.isNull($.l(NAME)), () => $.ret($.nul(dyn.dynT())));
        $.for(I, $.i(0), $.get(HT, H_N, $.l(0)), () => {
          $.if(this.streq($, nameAt($.l(I)), $.l(NAME)), () => {
            if (method === "has") $.ret($.g(dyn.boolGlobal(true)));
            else
              $.put(
                ACC,
                $.sel(this.strRef, $.isNull($.l(ACC)), valueAt($.l(I)), this.cat($, this.cat($, $.l(ACC), this.lit($, ", ")), valueAt($.l(I)))),
              );
          });
        });
        if (method === "has") $.ret($.g(dyn.boolGlobal(false)));
        else $.ret($.sel(this.dynRef, $.isNull($.l(ACC)), $.g(dyn.nullGlobal()), this.boxStr($, $.l(ACC))));
        return;
      }
      if (method === "set" || method === "append" || method === "delete") {
        // Node's order: the argument count, the name, the value
        // (normalized: leading and trailing HTTP whitespace dropped; no
        // NUL, CR or LF), then the guard — a response's headers are
        // immutable.
        const min = method === "delete" ? 1 : 2;
        $.if($.lt(argc, $.i(min)), () => {
          this.throwErr(
            $,
            "%TypeError",
            "TypeError",
            this.cat(
              $,
              this.cat(
                $,
                this.lit($, `Headers.${method}: ${min} argument${min !== 1 ? "s" : ""} required, but`),
                $.sel(this.strRef, $.eq(argc, $.i(0)), this.lit($, " "), this.lit($, " only ")),
              ),
              this.cat($, $.call(this.deps.f64ToStr(), $.i2d(argc)), this.lit($, " found.")),
            ),
          );
          $.ret($.nul(dyn.dynT()));
        });
        $.put(NAME, $.call(this.headerNameFn(), this.lit($, `Headers.${method}`), $.call(this.argFn(), $.l(1), $.i(0))));
        $.if($.isNull($.l(NAME)), () => $.ret($.nul(dyn.dynT())));
        if (min === 2) {
          $.put(ACC, $.call(this.headerValueFn(), this.lit($, `Headers.${method}`), $.call(this.argFn(), $.l(1), $.i(1))));
          $.if($.isNull($.l(ACC)), () => $.ret($.nul(dyn.dynT())));
        }
        this.throwErr($, "%TypeError", "TypeError", this.lit($, "immutable"));
        $.ret($.nul(dyn.dynT()));
        return;
      }
      if (method === "getSetCookie") {
        $.put(V, $.raw((c) => dyn.pushNewArr(c)));
        $.for(I, $.i(0), $.get(HT, H_N, $.l(0)), () => {
          $.if(this.streq($, nameAt($.l(I)), this.lit($, "set-cookie")), () => {
            $.run(dyn.arrPush(), $.l(V), this.boxStr($, valueAt($.l(I))));
          });
        });
        $.ret($.raw((c) => dyn.boxArr(c, (x) => x.localGet(V))));
        return;
      }
      // forEach(callback): each (value, name, headers) in order.
      required();
      $.put(CB, $.call(this.argFn(), $.l(1), $.i(0)));
      $.if($.not(this.isKind($, $.l(CB), DK.FUNC)), () => {
        this.throwErr($, "%TypeError", "TypeError", this.lit($, "Failed to execute 'forEach' on 'Headers': parameter 1 is not of type 'Function'."));
        $.ret($.nul(dyn.dynT()));
      });
      $.for(I, $.i(0), $.get(HT, H_N, $.l(0)), () => {
        $.put(ARGS, $.raw((c) => dyn.pushNewArr(c)));
        $.run(dyn.arrPush(), $.l(ARGS), this.boxStr($, valueAt($.l(I))));
        $.run(dyn.arrPush(), $.l(ARGS), this.boxStr($, nameAt($.l(I))));
        $.run(dyn.arrPush(), $.l(ARGS), $.l(2));
        $.drop($.call(dyn.callFn(), $.l(CB), $.l(ARGS), this.lit($, "callback")));
        $.if(this.pending($), () => $.ret($.nul(dyn.dynT())));
      });
      $.do(this.undef($));
    });
  }
}
