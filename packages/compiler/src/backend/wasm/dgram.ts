/* INC-29 U4 — node:dgram (UDP over IPv4) on the WasmGC tier.
 *
 * THE SPLIT (abi.ts netCall ops 20-23, evPoll source 2 kinds 20-21). The
 * host does what libuv's uv_udp_* do — bind (creating the socket), connect,
 * send one datagram, start receiving, close — and answers facts: a
 * handle, an errno, the bound address, a received datagram and its
 * sender. Everything Node does lives HERE, transcribed from Node v24.18.1's
 * lib/dgram.js and lib/internal/dgram.js: the bind / connect state
 * machines and their queue of work deferred until 'listening', send's
 * signature shuffle and validation ladder (sliceBuffer, fixBufferList,
 * validatePort), the nextTick positions of 'listening', 'connect' and
 * 'close', and the errors (ERR_SOCKET_ALREADY_BOUND,
 * ERR_SOCKET_DGRAM_IS_CONNECTED, ERR_SOCKET_DGRAM_NOT_RUNNING,
 * ERR_SOCKET_BAD_PORT, ERR_BUFFER_OUT_OF_BOUNDS, ExceptionWithHostPort).
 *
 * Out of this tier (each a named fence): a host NAME for an address (dgram
 * resolves it with dns.lookup), send callbacks and buffer lists, and a
 * bind port outside 0..65535. udp6 does not lower.
 *
 * SEMANTICS.md S090 registers where this tier and Node part. */
import { Code } from "./code.js";
import { A, Fn, type X } from "./asm.js";
import { F64, I32, ModuleBuilder, type ValType } from "./module.js";
import { NetBuilder } from "./net.js";

const EQ_HEAP = -0x13;
const EQ_REF: ValType = { kind: "ref", nullable: true, typeIndex: EQ_HEAP };

/* netCall's UDP ops (abi.ts). */
const OP_CLOSE = 7;
const OP_UDP_BIND = 20;
const OP_UDP_CONNECT = 21;
const OP_UDP_SEND = 22;
const OP_UDP_RECV_START = 23;

/* evPoll's UDP kinds (source 2). */
export const EV_UDP_MESSAGE = 20;
export const EV_UDP_ERROR = 21;

const HOST_FAILURE = "netCall: host failure";

/* checked-dynamic kinds (dyn.ts DK). */
const K_NULL = 0;
const K_BOOL = 1;
const K_NUM = 2;
const K_STR = 3;
const K_ARR = 4;
const K_UNDEF = 6;
const K_BYTES = 7;
const K_FUNC = 8;

/* ── $udp fields ─────────────────────────────────────────────────────── */
const U_H = 0; // i32: the host handle (0 = none: unbound, or closed)
const U_BIND = 1; // i32: bindState (0 unbound, 1 binding, 2 bound)
const U_CONN = 2; // i32: connectState (0 disconnected, 1 connecting, 2 connected)
const U_REUSE = 3; // i32: reuseAddr
const U_UNREF = 4; // i32
const U_RECV = 5; // i32: receiving
const U_CLOSED = 6; // i32: state.handle === null
const U_LADDR = 7; // string: getsockname's address
const U_LPORT = 8; // i32
const U_QUEUE = 9; // eqref array: state.queue (void closures)
const U_QN = 10; // i32
const U_QSET = 11; // i32: state.queue !== undefined
const U_LSUCC = 12; // eqref: onListenSuccess (a 'listening' listener)
const U_LMSG = 13;
const U_LERR = 15;
const U_LLISTEN = 17;
const U_LCLOSE = 19;
const U_LCONNECT = 21;

/** A dgram listener list. */
export interface UList {
  arr: number;
  arg: "void" | "err" | "msg";
}

export const DGRAM_LISTS = {
  MESSAGE: { arr: U_LMSG, arg: "msg" } as UList,
  ERROR: { arr: U_LERR, arg: "err" } as UList,
  LISTENING: { arr: U_LLISTEN, arg: "void" } as UList,
  CLOSE: { arr: U_LCLOSE, arg: "void" } as UList,
  CONNECT: { arr: U_LCONNECT, arg: "void" } as UList,
};

/* closure environment fields */
const E_A = 1;
const E_B = 2;
const E_C = 3;
const E_N = 4;
const E_X = 5;
type Env = { a: number; b: number; cc: number; n: number; x: number };

export interface DgramDeps {
  net: () => NetBuilder;
  strRef: () => ValType;
  strType: () => number;
  pushStrLit: (c: Code, value: string) => void;
  concat: () => number;
  f64ToStr: () => number;
  netCallFunc: () => number;
  ensureCapacity: (c: Code, need: () => void) => void;
  stageCursor: () => number;
  namedTrap: (c: Code, message: string) => void;
  voidClos: () => { clos: number; fn: number };
  errClos: () => { clos: number; fn: number };
  /** `(bytes, address, family, port, size) => void` — 'message' listeners. */
  msgClos: () => { clos: number; fn: number };
  nextTickEnqueue: () => number;
  excKind: () => number;
  errType: () => number;
  newError: (c: Code, className: string, name: string, pushMessage: (c: Code) => void, pushCode: (c: Code) => void) => void;
  throwStack: (c: Code) => void;
  bytesType: () => number;
  bufType: () => number;
  strToBytes: () => number;
  /** `(string) -> f64`, Number(s). */
  strToNumber: () => number;
  specificType: () => number;
  dynRef: () => ValType;
  dynT: () => number;
  dynBytes: () => number;
  dynArrVec: () => { struct: number; bufType: number };
}

export class DgramBuilder {
  private readonly fns = new Map<string, number>();
  private readonly types = new Map<string, number>();

  constructor(
    private readonly mb: ModuleBuilder,
    private readonly deps: DgramDeps,
  ) {}

  private get net(): NetBuilder {
    return this.deps.net();
  }

  private fn(name: string, params: ValType[], results: ValType[], build: (f: Fn, $: A) => void): number {
    const hit = this.fns.get(name);
    if (hit !== undefined) return hit;
    const idx = this.mb.declareFunc(this.mb.funcType(params, results), `%w.dgram.${name}`);
    this.fns.set(name, idx);
    const f = new Fn(params.length);
    build(f, new A(f));
    this.mb.setBody(idx, f.locals, f.c.bytes());
    return idx;
  }

  private ref(t: number): ValType {
    return { kind: "ref", nullable: true, typeIndex: t };
  }
  private get strRef(): ValType {
    return this.deps.strRef();
  }
  private get S(): number {
    return this.deps.strType();
  }
  private get errRef(): ValType {
    return this.ref(this.deps.errType());
  }
  private get BT(): number {
    return this.deps.bytesType();
  }
  private get bytesRef(): ValType {
    return this.ref(this.BT);
  }
  private get DT(): number {
    return this.deps.dynT();
  }
  private get dynRef(): ValType {
    return this.deps.dynRef();
  }

  private type(key: string, make: () => number): number {
    const hit = this.types.get(key);
    if (hit !== undefined) return hit;
    const t = make();
    this.types.set(key, t);
    return t;
  }

  private get entT(): number {
    return this.type("ent", () =>
      this.mb.openStructType("dgram:ent", [
        { storage: EQ_REF, mutable: false },
        { storage: I32, mutable: false },
        { storage: I32, mutable: true },
      ]),
    );
  }
  private get entArrT(): number {
    return this.type("entArr", () => this.mb.arrayType(this.ref(this.entT), true));
  }
  private get eqArrT(): number {
    return this.type("eqArr", () => this.mb.arrayType(EQ_REF, true));
  }

  /** type:dgramSocket */
  udpT(): number {
    return this.type("udp", () => {
      const ent = this.ref(this.entArrT);
      return this.mb.openStructType("dgram:sock", [
        { storage: I32, mutable: true }, // U_H
        { storage: I32, mutable: true }, // U_BIND
        { storage: I32, mutable: true }, // U_CONN
        { storage: I32, mutable: true }, // U_REUSE
        { storage: I32, mutable: true }, // U_UNREF
        { storage: I32, mutable: true }, // U_RECV
        { storage: I32, mutable: true }, // U_CLOSED
        { storage: this.strRef, mutable: true }, // U_LADDR
        { storage: I32, mutable: true }, // U_LPORT
        { storage: this.ref(this.eqArrT), mutable: true }, // U_QUEUE
        { storage: I32, mutable: true }, // U_QN
        { storage: I32, mutable: true }, // U_QSET
        { storage: EQ_REF, mutable: true }, // U_LSUCC
        ...Array.from({ length: 5 }, () => [
          { storage: ent, mutable: true },
          { storage: I32, mutable: true },
        ]).flat(),
      ]);
    });
  }
  udpRef(): ValType {
    return this.ref(this.udpT());
  }

  private lit($: A, s: string): X {
    return () => this.deps.pushStrLit($.c, s);
  }
  private cat($: A, ...parts: X[]): X {
    return () => {
      parts[0]!();
      for (let i = 1; i < parts.length; i++) {
        parts[i]!();
        $.c.call(this.deps.concat());
      }
    };
  }
  private excReturn($: A, v?: X): void {
    $.if($.g(this.deps.excKind()), () => $.ret(v));
  }
  private err($: A, cls: "%Error" | "%TypeError" | "%RangeError", msg: X, code: string | null): X {
    return () =>
      this.deps.newError($.c, cls, cls.slice(1), () => msg(), (c) => {
        if (code === null) c.refNull(this.S);
        else this.deps.pushStrLit(c, code);
      });
  }
  private throwErr($: A, cls: "%Error" | "%TypeError" | "%RangeError", msg: X, code: string | null): void {
    this.err($, cls, msg, code)();
    this.deps.throwStack($.c);
  }
  private fence($: A, what: string): void {
    this.throwErr($, "%Error", this.lit($, `${what} is not supported yet`), null);
  }
  private trap($: A): void {
    this.deps.namedTrap($.c, HOST_FAILURE);
  }

  /* ── listener lists (lib/events.js's on / once / emit / remove) ────── */

  private pairOf(arg: UList["arg"]): { clos: number; fn: number } {
    return arg === "void" ? this.deps.voidClos() : arg === "err" ? this.deps.errClos() : this.deps.msgClos();
  }
  private argTypes(arg: UList["arg"]): ValType[] {
    return arg === "void" ? [] : arg === "err" ? [this.errRef] : [this.bytesRef, this.strRef, this.strRef, F64, F64];
  }

  /** `(udp, clos, once, prepend)` */
  addFn(spec: UList): number {
    const T = this.udpT();
    return this.fn(`add.${spec.arr}`, [this.udpRef(), EQ_REF, I32, I32], [], (f, $) => {
      const [O, CL, ONCE, PRE] = [0, 1, 2, 3];
      const NA = f.local(this.ref(this.entArrT));
      const arr = $.get(T, spec.arr, $.l(O));
      const n = $.get(T, spec.arr + 1, $.l(O));
      $.if($.isNull(arr), () => $.set(T, spec.arr, $.l(O), $.anew(this.entArrT, $.i(4))));
      $.if($.geU(n, $.alen(arr)), () => {
        $.put(NA, $.anew(this.entArrT, $.shl($.alen(arr), $.i(1))));
        $.do($.l(NA), $.i(0), arr, $.i(0), n);
        f.c.arrayCopy(this.entArrT, this.entArrT);
        $.set(T, spec.arr, $.l(O), $.l(NA));
      });
      const ent = $.new_(this.entT, $.l(CL), $.l(ONCE), $.i(0));
      $.if($.l(PRE), () => {
        $.do(arr, $.i(1), arr, $.i(0), n);
        f.c.arrayCopy(this.entArrT, this.entArrT);
        $.aset(this.entArrT, arr, $.i(0), ent);
      }, () => $.aset(this.entArrT, arr, n, ent));
      $.set(T, spec.arr + 1, $.l(O), $.add(n, $.i(1)));
    });
  }

  /** `(udp, entOrClos)` — remove the last matching entry. */
  removeFn(spec: UList): number {
    const T = this.udpT();
    return this.fn(`remove.${spec.arr}`, [this.udpRef(), EQ_REF], [], (f, $) => {
      const [O, V] = [0, 1];
      const I = f.local(I32);
      const E = f.local(this.ref(this.entT));
      const arr = $.get(T, spec.arr, $.l(O));
      const n = $.get(T, spec.arr + 1, $.l(O));
      $.put(I, n);
      $.while($.gt($.l(I), $.i(0)), () => {
        $.put(I, $.sub($.l(I), $.i(1)));
        $.put(E, $.aget(this.entArrT, arr, $.l(I)));
        $.if($.or($.refEq($.l(E), $.l(V)), $.refEq($.get(this.entT, 0, $.l(E)), $.l(V))), () => {
          $.do(arr, $.l(I), arr, $.add($.l(I), $.i(1)), $.sub($.sub(n, $.l(I)), $.i(1)));
          f.c.arrayCopy(this.entArrT, this.entArrT);
          $.set(T, spec.arr + 1, $.l(O), $.sub(n, $.i(1)));
          $.aset(this.entArrT, arr, n, $.nul(this.entT));
          $.ret();
        });
      });
    });
  }

  /** `(udp[, args]) -> i32` — emit; an 'error' with no listener throws. */
  emitFn(spec: UList): number {
    const T = this.udpT();
    const argT = this.argTypes(spec.arg);
    return this.fn(`emit.${spec.arr}`, [this.udpRef(), ...argT], [I32], (f, $) => {
      const O = 0;
      const N = f.local(I32);
      const I = f.local(I32);
      const SNAP = f.local(this.ref(this.entArrT));
      const E = f.local(this.ref(this.entT));
      const pair = this.pairOf(spec.arg);
      const c = f.c;
      $.put(N, $.get(T, spec.arr + 1, $.l(O)));
      $.if($.eq($.l(N), $.i(0)), () => {
        if (spec.arg === "err") {
          c.localGet(1);
          this.deps.throwStack(c);
        }
        $.ret($.i(0));
      });
      $.put(SNAP, $.anew(this.entArrT, $.l(N)));
      $.do($.l(SNAP), $.i(0), $.get(T, spec.arr, $.l(O)), $.i(0), $.l(N));
      c.arrayCopy(this.entArrT, this.entArrT);
      $.while($.lt($.l(I), $.l(N)), () => {
        $.put(E, $.aget(this.entArrT, $.l(SNAP), $.l(I)));
        $.put(I, $.add($.l(I), $.i(1)));
        c.block();
        $.if($.get(this.entT, 1, $.l(E)), () => {
          $.do($.get(this.entT, 2, $.l(E)));
          c.brIf(1);
          $.set(this.entT, 2, $.l(E), $.i(1));
          $.run(this.removeFn(spec), $.l(O), $.l(E));
        });
        $.do($.cast(pair.clos, $.get(this.entT, 0, $.l(E))));
        for (let a = 0; a < argT.length; a++) c.localGet(1 + a);
        $.do($.get(pair.clos, 0, $.cast(pair.clos, $.get(this.entT, 0, $.l(E)))));
        c.callRef(pair.fn);
        $.if($.g(this.deps.excKind()), () => $.ret($.i(1)));
        c.end();
      });
      $.do($.i(1));
    });
  }

  private on($: A, spec: UList, o: X, clos: X, once = false): void {
    $.run(this.addFn(spec), o, clos, $.i(once ? 1 : 0), $.i(0));
  }

  /** emit('error', err), its errorMonitor first (enqueue's onListenError:
   * the queue is dropped with its 'listening' listener). */
  private emitErrorFn(): number {
    return this.fn("emitError", [this.udpRef(), this.errRef], [], (f, $) => {
      const [U, ERR] = [0, 1];
      $.if($.get(this.udpT(), U_QSET, $.l(U)), () => {
        $.run(this.removeFn(DGRAM_LISTS.LISTENING), $.l(U), $.get(this.udpT(), U_LSUCC, $.l(U)));
        $.set(this.udpT(), U_QSET, $.l(U), $.i(0));
        $.set(this.udpT(), U_QUEUE, $.l(U), $.nul(this.eqArrT));
        $.set(this.udpT(), U_QN, $.l(U), $.i(0));
      });
      $.drop($.call(this.emitFn(DGRAM_LISTS.ERROR), $.l(U), $.l(ERR)));
    });
  }

  /* ── closures ─────────────────────────────────────────────────────── */

  private envT(): number {
    const pair = this.deps.voidClos();
    return this.type("env", () =>
      this.mb.subStructType(
        "%w.dgram.env",
        [
          { storage: { kind: "ref", nullable: false, typeIndex: pair.fn }, mutable: false },
          { storage: EQ_REF, mutable: false },
          { storage: EQ_REF, mutable: false },
          { storage: EQ_REF, mutable: false },
          { storage: I32, mutable: false },
          { storage: F64, mutable: false },
        ],
        pair.clos,
      ),
    );
  }
  private errEnvT(): number {
    const pair = this.deps.errClos();
    return this.type("errEnv", () =>
      this.mb.subStructType(
        "%w.dgram.errEnv",
        [
          { storage: { kind: "ref", nullable: false, typeIndex: pair.fn }, mutable: false },
          { storage: EQ_REF, mutable: false },
          { storage: EQ_REF, mutable: false },
          { storage: EQ_REF, mutable: false },
          { storage: I32, mutable: false },
          { storage: F64, mutable: false },
        ],
        pair.clos,
      ),
    );
  }

  private tick(name: string, body: ($: A, e: Env, f: Fn) => void, kind: "void" | "err" = "void"): number {
    const key = `clos.${name}`;
    const hit = this.fns.get(key);
    if (hit !== undefined) return hit;
    const pair = kind === "void" ? this.deps.voidClos() : this.deps.errClos();
    const idx = this.mb.declareFunc(pair.fn, `%w.dgram.${name}`);
    this.fns.set(key, idx);
    const env = kind === "void" ? this.envT() : this.errEnvT();
    const f = new Fn(kind === "void" ? 1 : 2);
    const $ = new A(f);
    const e: Env = { a: f.local(EQ_REF), b: f.local(EQ_REF), cc: f.local(EQ_REF), n: f.local(I32), x: f.local(F64) };
    $.put(e.a, $.get(env, E_A, $.cast(env, $.l(0))));
    $.put(e.b, $.get(env, E_B, $.cast(env, $.l(0))));
    $.put(e.cc, $.get(env, E_C, $.cast(env, $.l(0))));
    $.put(e.n, $.get(env, E_N, $.cast(env, $.l(0))));
    $.put(e.x, $.get(env, E_X, $.cast(env, $.l(0))));
    body($, e, f);
    this.mb.setBody(idx, f.locals, f.c.bytes());
    return idx;
  }

  private clos($: A, fn: number, parts: { a?: X; b?: X; c?: X; n?: X; x?: X }, kind: "void" | "err" = "void"): X {
    return () => {
      this.mb.declareFuncRef(fn);
      $.c.refFunc(fn);
      (parts.a ?? (() => $.c.refNull(EQ_HEAP)))();
      (parts.b ?? (() => $.c.refNull(EQ_HEAP)))();
      (parts.c ?? (() => $.c.refNull(EQ_HEAP)))();
      (parts.n ?? (() => $.c.i32Const(0)))();
      (parts.x ?? (() => $.c.f64Const(0)))();
      $.c.structNew(kind === "void" ? this.envT() : this.errEnvT());
    };
  }

  private nextTick($: A, fn: number, parts: { a?: X; b?: X; c?: X; n?: X; x?: X }): void {
    this.clos($, fn, parts)();
    $.c.call(this.deps.nextTickEnqueue());
  }

  /** Call a void closure. */
  private callVoid($: A, cl: X): void {
    const pair = this.deps.voidClos();
    $.do($.cast(pair.clos, cl), $.get(pair.clos, 0, $.cast(pair.clos, cl)));
    $.c.callRef(pair.fn);
  }

  /* ── linear memory ────────────────────────────────────────────────── */

  private base($: A, local: number): void {
    $.put(local, $.and($.add($.g(this.deps.stageCursor()), $.i(3)), $.i(-4)));
  }
  private loadU32($: A, addr: X): X {
    return () => {
      addr();
      $.c.i32Load16U();
      addr();
      $.c.i32Const(2);
      $.c.i32Add();
      $.c.i32Load16U();
      $.c.i32Const(16);
      $.c.i32Shl();
      $.c.i32Or();
    };
  }
  private storeU32($: A, addr: X, v: X): void {
    $.do(addr, v);
    $.c.i32Store();
  }

  /** Stage (u32 port, u32 family, the address run) at ptr -> the next ptr. */
  private stageAddrFn(): number {
    return this.fn("stageAddr", [I32, I32, this.strRef], [I32], (f, $) => {
      const [P, PORT, S] = [0, 1, 2];
      const I = f.local(I32);
      const N = f.local(I32);
      this.storeU32($, $.l(P), $.l(PORT));
      this.storeU32($, $.add($.l(P), $.i(4)), $.i(4));
      $.put(N, $.alen($.l(S)));
      this.storeU32($, $.add($.l(P), $.i(8)), $.l(N));
      $.for(I, $.i(0), $.l(N), () => {
        $.do($.add($.add($.l(P), $.i(12)), $.shl($.l(I), $.i(1))), $.agetU(this.S, $.l(S), $.l(I)));
        f.c.i32Store8();
        $.do($.add($.add($.l(P), $.i(13)), $.shl($.l(I), $.i(1))), $.shrU($.agetU(this.S, $.l(S), $.l(I)), $.i(8)));
        f.c.i32Store8();
      });
      $.do($.add($.add($.l(P), $.i(12)), $.and($.add($.shl($.l(N), $.i(1)), $.i(3)), $.i(-4))));
    });
  }

  /** The reply's (u32 port, u32 family, address run) at ptr into the socket. */
  private readLocalFn(): number {
    return this.fn("readLocal", [this.udpRef(), I32], [], (f, $) => {
      const [U, P] = [0, 1];
      $.set(this.udpT(), U_LPORT, $.l(U), this.loadU32($, $.l(P)));
      $.set(this.udpT(), U_LADDR, $.l(U), $.call(this.net.readRunHelper(), $.add($.l(P), $.i(8))));
    });
  }

  /* ── the socket ───────────────────────────────────────────────────── */

  /** dgram.createSocket('udp4' | { type: 'udp4', reuseAddr }) */
  newFn(): number {
    return this.fn("new", [I32], [this.udpRef()], (f, $) => {
      const U = f.local(this.udpRef());
      $.put(U, $.raw((c) => c.structNewDefault(this.udpT())));
      $.set(this.udpT(), U_REUSE, $.l(U), $.l(0));
      $.do($.l(U));
    });
  }

  /** healthCheck: 1, or 0 with ERR_SOCKET_DGRAM_NOT_RUNNING pending. */
  private healthFn(): number {
    return this.fn("health", [this.udpRef()], [I32], (f, $) => {
      $.if($.get(this.udpT(), U_CLOSED, $.l(0)), () => {
        this.throwErr($, "%Error", this.lit($, "Not running"), "ERR_SOCKET_DGRAM_NOT_RUNNING");
        $.ret($.i(0));
      });
      $.do($.i(1));
    });
  }

  /** The address an IPv4 lookup answers for an IP literal, or the fence
   * for a host name (dns.lookup has no lowering under dgram here). 1 / 0. */
  private lookupCheckFn(): number {
    return this.fn("lookupCheck", [this.strRef], [I32], (f, $) => {
      $.if($.ne($.call(this.net.isIPHelper(), $.l(0)), $.i(4)), () => {
        this.fence($, "a dgram address other than an IPv4 literal (a dns.lookup)");
        $.ret($.i(0));
      });
      $.do($.i(1));
    });
  }

  /** Socket.prototype.bind(port, address[, cb]) — `cb` null is none.
   * 1, or 0 with the error pending. */
  bindFn(): number {
    return this.fn("bind", [this.udpRef(), F64, this.strRef, this.ref(this.deps.voidClos().clos)], [I32], (f, $) => {
      const [U, PORT, ADDR0, CB] = [0, 1, 2, 3];
      const ADDR = f.local(this.strRef);
      const W = f.local(EQ_REF);
      $.if($.not($.call(this.healthFn(), $.l(U))), () => $.ret($.i(0)));
      $.if($.ne($.get(this.udpT(), U_BIND, $.l(U)), $.i(0)), () => {
        this.throwErr($, "%Error", this.lit($, "Socket is already bound"), "ERR_SOCKET_ALREADY_BOUND");
        $.ret($.i(0));
      });
      $.set(this.udpT(), U_BIND, $.l(U), $.i(1));
      $.if($.notNull($.l(CB)), () => {
        // removeListeners on 'error', onListening on 'listening': each
        // removes both, so both closures share one cell holding them.
        $.put(W, $.raw((c) => c.structNewDefault(this.pairT())));
        $.set(this.pairT(), 0, $.cast(this.pairT(), $.l(W)), this.clos($, this.onListeningFn(), { a: $.l(U), b: $.l(CB), c: $.l(W) }));
        $.set(this.pairT(), 1, $.cast(this.pairT(), $.l(W)), this.clos($, this.removeListenersFn(), { a: $.l(U), c: $.l(W) }, "err"));
        this.on($, DGRAM_LISTS.ERROR, $.l(U), $.get(this.pairT(), 1, $.cast(this.pairT(), $.l(W))));
        this.on($, DGRAM_LISTS.LISTENING, $.l(U), $.get(this.pairT(), 0, $.cast(this.pairT(), $.l(W))));
      });
      // port || 0 through the handle's uint conversion: this tier binds
      // integer ports in 0..65535 only.
      $.if($.either($.dne($.raw((c) => {
        c.localGet(PORT);
        c.f64Trunc();
      }), $.l(PORT)), $.either($.dlt($.l(PORT), $.d(0)), $.dgt($.l(PORT), $.d(65535)))), () => {
        $.if($.deq($.l(PORT), $.l(PORT)), () => {
          this.fence($, "a dgram bind port outside 0..65535");
          $.ret($.i(0));
        });
        $.put(PORT, $.d(0));
      });
      // Defaulting address for bind to all interfaces
      $.put(ADDR, $.sel(this.strRef, $.gt($.alen($.l(ADDR0)), $.i(0)), $.l(ADDR0), this.lit($, "0.0.0.0")));
      $.if($.not($.call(this.lookupCheckFn(), $.l(ADDR))), () => $.ret($.i(0)));
      // the lookup's nextTick for an IP literal
      this.nextTick($, this.afterBindLookupFn(), { a: $.l(U), b: $.l(ADDR), x: $.l(PORT) });
      $.do($.i(1));
    });
  }

  /** The cell bind's two listeners share: (onListening, removeListeners). */
  private pairT(): number {
    return this.type("pair", () =>
      this.mb.openStructType("dgram:pair", [
        { storage: EQ_REF, mutable: true },
        { storage: EQ_REF, mutable: true },
      ]),
    );
  }

  /** removeListeners(): both of bind's listeners off (c = the cell). */
  private removeBoth($: A, u: X, cell: X): void {
    $.run(this.removeFn(DGRAM_LISTS.ERROR), u, $.get(this.pairT(), 1, $.cast(this.pairT(), cell)));
    $.run(this.removeFn(DGRAM_LISTS.LISTENING), u, $.get(this.pairT(), 0, $.cast(this.pairT(), cell)));
  }

  /** bind's onListening (env a = socket, b = cb, c = the cell) */
  private onListeningFn(): number {
    return this.tick("onListening", ($, e, f) => {
      const U = f.local(this.udpRef());
      $.put(U, $.cast(this.udpT(), $.l(e.a)));
      this.removeBoth($, $.l(U), $.l(e.cc));
      this.callVoid($, $.l(e.b));
    });
  }

  /** bind's removeListeners on 'error' (env a = socket, c = the cell) */
  private removeListenersFn(): number {
    return this.tick("removeListeners", ($, e, f) => {
      const U = f.local(this.udpRef());
      $.put(U, $.cast(this.udpT(), $.l(e.a)));
      this.removeBoth($, $.l(U), $.l(e.cc));
    }, "err");
  }

  /** The bind lookup's callback (env a = socket, b = ip, x = port). */
  private afterBindLookupFn(): number {
    return this.tick("afterBindLookup", ($, e, f) => {
      const U = f.local(this.udpRef());
      const BASE = f.local(I32);
      const R = f.local(I32);
      const P = f.local(I32);
      $.put(U, $.cast(this.udpT(), $.l(e.a)));
      // Handle has been closed in the mean time
      $.if($.get(this.udpT(), U_CLOSED, $.l(U)), () => $.ret());
      this.deps.ensureCapacity(f.c, () => $.do($.add($.shl($.alen($.flatCast(this.S, $.l(e.b))), $.i(1)), $.i(64))));
      this.base($, BASE);
      $.put(P, $.call(this.stageAddrFn(), $.l(BASE), $.d2i($.l(e.x)), $.flatCast(this.S, $.l(e.b))));
      // flags: bit 0 reuseAddr
      this.storeU32($, $.l(P), $.get(this.udpT(), U_REUSE, $.l(U)));
      $.put(R, $.call(this.deps.netCallFunc(), $.i(OP_UDP_BIND), $.l(BASE), $.add($.sub($.l(P), $.l(BASE)), $.i(4)), $.i(0), $.i(0)));
      $.if($.lt($.l(R), $.i(0)), () => {
        $.set(this.udpT(), U_BIND, $.l(U), $.i(0));
        $.run(this.emitErrorFn(), $.l(U), $.call(this.net.hostPortExHelper(), $.l(R), this.lit($, "bind"), $.flatCast(this.S, $.l(e.b)), $.d2i($.l(e.x))));
        $.ret();
      });
      $.if($.eq($.l(R), $.i(0)), () => this.trap($));
      $.set(this.udpT(), U_H, $.l(U), $.l(R));
      $.run(this.net.tableSetHelper(), $.l(R), $.l(U));
      $.run(this.readLocalFn(), $.l(U), $.l(BASE));
      // startListening: recvStart, receiving, BOUND, emit('listening')
      $.if($.ne($.call(this.deps.netCallFunc(), $.i(OP_UDP_RECV_START), $.i(0), $.i(0), $.l(R), $.i(0)), $.i(0)), () => this.trap($));
      $.set(this.udpT(), U_RECV, $.l(U), $.i(1));
      $.set(this.udpT(), U_BIND, $.l(U), $.i(2));
      $.drop($.call(this.emitFn(DGRAM_LISTS.LISTENING), $.l(U)));
    });
  }

  /** enqueue(self, fn) */
  private enqueueFn(): number {
    return this.fn("enqueue", [this.udpRef(), EQ_REF], [], (f, $) => {
      const [U, CL] = [0, 1];
      const NA = f.local(this.ref(this.eqArrT));
      const T = this.udpT();
      $.if($.not($.get(T, U_QSET, $.l(U))), () => {
        $.set(T, U_QSET, $.l(U), $.i(1));
        $.set(T, U_QUEUE, $.l(U), $.anew(this.eqArrT, $.i(4)));
        $.set(T, U_QN, $.l(U), $.i(0));
        $.set(T, U_LSUCC, $.l(U), this.clos($, this.onListenSuccessFn(), { a: $.l(U) }));
        this.on($, DGRAM_LISTS.LISTENING, $.l(U), $.get(T, U_LSUCC, $.l(U)), true);
      });
      const arr = $.get(T, U_QUEUE, $.l(U));
      const n = $.get(T, U_QN, $.l(U));
      $.if($.geU(n, $.alen(arr)), () => {
        $.put(NA, $.anew(this.eqArrT, $.shl($.alen(arr), $.i(1))));
        $.do($.l(NA), $.i(0), arr, $.i(0), n);
        f.c.arrayCopy(this.eqArrT, this.eqArrT);
        $.set(T, U_QUEUE, $.l(U), $.l(NA));
      });
      $.aset(this.eqArrT, arr, n, $.l(CL));
      $.set(T, U_QN, $.l(U), $.add(n, $.i(1)));
    });
  }

  /** onListenSuccess -> clearQueue */
  private onListenSuccessFn(): number {
    return this.tick("onListenSuccess", ($, e, f) => {
      const U = f.local(this.udpRef());
      const Q = f.local(this.ref(this.eqArrT));
      const N = f.local(I32);
      const I = f.local(I32);
      const T = this.udpT();
      $.put(U, $.cast(T, $.l(e.a)));
      $.put(Q, $.get(T, U_QUEUE, $.l(U)));
      $.put(N, $.get(T, U_QN, $.l(U)));
      $.set(T, U_QSET, $.l(U), $.i(0));
      $.set(T, U_QUEUE, $.l(U), $.nul(this.eqArrT));
      $.set(T, U_QN, $.l(U), $.i(0));
      $.for(I, $.i(0), $.l(N), () => {
        this.callVoid($, $.aget(this.eqArrT, $.l(Q), $.l(I)));
        this.excReturn($);
      });
    });
  }

  /** validatePort(port, 'Port', false) over a number: 1, or 0 with
   * ERR_SOCKET_BAD_PORT pending. */
  private portFn(): number {
    return this.fn("port", [F64], [I32], (f, $) => {
      const P = 0;
      $.if($.either($.either($.dne($.raw((c) => {
        c.localGet(P);
        c.f64Trunc();
      }), $.l(P)), $.dle($.l(P), $.d(0))), $.dgt($.l(P), $.d(65535))), () => {
        this.throwErr($, "%RangeError", this.cat($, this.lit($, "Port should be > 0 and < 65536. Received type number ("), $.call(this.deps.f64ToStr(), $.l(P)), this.lit($, ").")), "ERR_SOCKET_BAD_PORT");
        $.ret($.i(0));
      });
      $.do($.i(1));
    });
  }

  /** Socket.prototype.connect(port, address[, cb]) -> 1 / 0 (error pending). */
  connectFn(): number {
    return this.fn("connect", [this.udpRef(), F64, this.strRef, this.ref(this.deps.voidClos().clos)], [I32], (f, $) => {
      const [U, PORT, ADDR, CB] = [0, 1, 2, 3];
      $.if($.not($.call(this.portFn(), $.l(PORT))), () => $.ret($.i(0)));
      $.if($.ne($.get(this.udpT(), U_CONN, $.l(U)), $.i(0)), () => {
        this.throwErr($, "%Error", this.lit($, "Already connected"), "ERR_SOCKET_DGRAM_IS_CONNECTED");
        $.ret($.i(0));
      });
      $.set(this.udpT(), U_CONN, $.l(U), $.i(1));
      $.if($.eq($.get(this.udpT(), U_BIND, $.l(U)), $.i(0)), () => {
        $.if($.not($.call(this.bindFn(), $.l(U), $.d(0), this.lit($, ""), $.nul(this.deps.voidClos().clos))), () => $.ret($.i(0)));
      });
      $.if($.ne($.get(this.udpT(), U_BIND, $.l(U)), $.i(2)), () => {
        $.run(this.enqueueFn(), $.l(U), this.clos($, this.connectNowFn(), { a: $.l(U), b: $.l(ADDR), c: $.l(CB), x: $.l(PORT) }));
        $.ret($.i(1));
      });
      $.drop($.call(this.connectInnerFn(), $.l(U), $.l(PORT), $.l(ADDR), $.l(CB)));
      $.do($.i(1));
    });
  }

  /** The queued _connect (env a = socket, b = address, c = cb, x = port). */
  private connectNowFn(): number {
    return this.tick("connectNow", ($, e) => {
      $.drop($.call(this.connectInnerFn(), $.cast(this.udpT(), $.l(e.a)), $.l(e.x), $.flatCast(this.S, $.l(e.b)), $.cast(this.deps.voidClos().clos, $.l(e.cc))));
    });
  }

  /** _connect(port, address, callback) -> i32 */
  private connectInnerFn(): number {
    return this.fn("connectInner", [this.udpRef(), F64, this.strRef, this.ref(this.deps.voidClos().clos)], [I32], (f, $) => {
      const [U, PORT, ADDR0, CB] = [0, 1, 2, 3];
      const ADDR = f.local(this.strRef);
      $.if($.notNull($.l(CB)), () => this.on($, DGRAM_LISTS.CONNECT, $.l(U), $.l(CB), true));
      // lookup4: address || '127.0.0.1'
      $.put(ADDR, $.sel(this.strRef, $.gt($.alen($.l(ADDR0)), $.i(0)), $.l(ADDR0), this.lit($, "127.0.0.1")));
      $.if($.not($.call(this.lookupCheckFn(), $.l(ADDR))), () => $.ret($.i(0)));
      this.nextTick($, this.doConnectFn(), { a: $.l(U), b: $.l(ADDR), c: $.l(CB), x: $.l(PORT) });
      $.do($.i(1));
    });
  }

  /** doConnect(ex, self, ip, address, port, callback) (env a = socket,
   * b = ip (the address, an IP literal), c = cb, x = port) */
  private doConnectFn(): number {
    return this.tick("doConnect", ($, e, f) => {
      const U = f.local(this.udpRef());
      const BASE = f.local(I32);
      const P = f.local(I32);
      const R = f.local(I32);
      const T = this.udpT();
      $.put(U, $.cast(T, $.l(e.a)));
      $.if($.get(T, U_CLOSED, $.l(U)), () => $.ret());
      this.deps.ensureCapacity(f.c, () => $.do($.add($.shl($.alen($.flatCast(this.S, $.l(e.b))), $.i(1)), $.i(64))));
      this.base($, BASE);
      $.put(P, $.call(this.stageAddrFn(), $.l(BASE), $.d2i($.l(e.x)), $.flatCast(this.S, $.l(e.b))));
      $.put(R, $.call(this.deps.netCallFunc(), $.i(OP_UDP_CONNECT), $.l(BASE), $.sub($.l(P), $.l(BASE)), $.get(T, U_H, $.l(U)), $.i(0)));
      $.if($.lt($.l(R), $.i(0)), () => {
        $.set(T, U_CONN, $.l(U), $.i(0));
        this.nextTick($, this.connectErrorFn(), { a: $.l(U), b: $.call(this.net.hostPortExHelper(), $.l(R), this.lit($, "connect"), $.flatCast(this.S, $.l(e.b)), $.d2i($.l(e.x))), c: $.l(e.cc) });
        $.ret();
      });
      $.if($.ne($.l(R), $.i(0)), () => this.trap($));
      $.run(this.readLocalFn(), $.l(U), $.l(BASE));
      $.set(T, U_CONN, $.l(U), $.i(2));
      this.nextTick($, this.emitConnectFn(), { a: $.l(U) });
    });
  }

  private emitConnectFn(): number {
    return this.tick("emitConnect", ($, e) => {
      $.drop($.call(this.emitFn(DGRAM_LISTS.CONNECT), $.cast(this.udpT(), $.l(e.a))));
    });
  }

  /** doConnect's failure tick (env a = socket, b = err, c = cb) */
  private connectErrorFn(): number {
    return this.tick("connectError", ($, e, f) => {
      const U = f.local(this.udpRef());
      $.put(U, $.cast(this.udpT(), $.l(e.a)));
      $.if($.notNull($.l(e.cc)), () => {
        // removeListener('connect', callback); callback(ex) — the lowered
        // callback takes no argument
        $.run(this.removeFn(DGRAM_LISTS.CONNECT), $.l(U), $.l(e.cc));
        this.callVoid($, $.l(e.cc));
      }, () => $.run(this.emitErrorFn(), $.l(U), $.cast(this.deps.errType(), $.l(e.b))));
    });
  }

  /** send(bytes, port, address) after the ladder: the healthCheck, the
   * implicit bind, the queue, the lookup, doSend. `port` 0 = connected. */
  sendFn(): number {
    return this.fn("send", [this.udpRef(), this.bytesRef, F64, this.strRef], [I32], (f, $) => {
      const [U, B, PORT, ADDR] = [0, 1, 2, 3];
      const T = this.udpT();
      $.if($.not($.call(this.healthFn(), $.l(U))), () => $.ret($.i(0)));
      $.if($.eq($.get(T, U_BIND, $.l(U)), $.i(0)), () => {
        $.if($.not($.call(this.bindFn(), $.l(U), $.d(0), this.lit($, ""), $.nul(this.deps.voidClos().clos))), () => $.ret($.i(0)));
      });
      $.if($.ne($.get(T, U_BIND, $.l(U)), $.i(2)), () => {
        $.run(this.enqueueFn(), $.l(U), this.clos($, this.sendLaterFn(), { a: $.l(U), b: $.l(B), c: $.l(ADDR), x: $.l(PORT) }));
        $.ret($.i(1));
      });
      $.do($.call(this.sendBoundFn(), $.l(U), $.l(B), $.l(PORT), $.l(ADDR)));
    });
  }

  /** send(msg, port, address) with a string or Buffer datagram: an
   * unconnected socket validates the port first. 1 / 0. */
  sendTypedFn(): number {
    return this.fn("sendTyped", [this.udpRef(), this.bytesRef, F64, this.strRef], [I32], (f, $) => {
      const [U, B, PORT, ADDR] = [0, 1, 2, 3];
      const CONN = f.local(I32);
      $.put(CONN, $.eq($.get(this.udpT(), U_CONN, $.l(U)), $.i(2)));
      $.if($.not($.l(CONN)), () => {
        $.if($.not($.call(this.portFn(), $.l(PORT))), () => $.ret($.i(0)));
      });
      $.do($.call(this.sendFn(), $.l(U), $.l(B), $.sel(F64, $.l(CONN), $.d(0), $.l(PORT)), $.l(ADDR)));
    });
  }

  /** The queued send (env a = socket, b = bytes, c = address, x = port):
   * Node re-runs send(list, port, address), its port check included (a
   * string "0" that passed the first check fails this one). */
  private sendLaterFn(): number {
    return this.tick("sendLater", ($, e) => {
      $.drop($.call(this.sendTypedFn(), $.cast(this.udpT(), $.l(e.a)), $.cast(this.BT, $.l(e.b)), $.l(e.x), $.flatCast(this.S, $.l(e.cc))));
    });
  }

  /** A bound socket's send: the lookup (unconnected), then doSend. */
  private sendBoundFn(): number {
    return this.fn("sendBound", [this.udpRef(), this.bytesRef, F64, this.strRef], [I32], (f, $) => {
      const [U, B, PORT, ADDR0] = [0, 1, 2, 3];
      const ADDR = f.local(this.strRef);
      $.if($.eq($.get(this.udpT(), U_CONN, $.l(U)), $.i(2)), () => {
        $.run(this.doSendFn(), $.l(U), $.l(B), $.d(0), $.nul(this.S));
        $.ret($.i(1));
      });
      $.put(ADDR, $.sel(this.strRef, $.andThen($.notNull($.l(ADDR0)), $.gt($.alen($.l(ADDR0)), $.i(0))), $.l(ADDR0), this.lit($, "127.0.0.1")));
      $.if($.not($.call(this.lookupCheckFn(), $.l(ADDR))), () => $.ret($.i(0)));
      this.nextTick($, this.doSendTickFn(), { a: $.l(U), b: $.l(B), c: $.l(ADDR), x: $.l(PORT) });
      $.do($.i(1));
    });
  }

  private doSendTickFn(): number {
    return this.tick("doSendTick", ($, e) => {
      $.run(this.doSendFn(), $.cast(this.udpT(), $.l(e.a)), $.cast(this.BT, $.l(e.b)), $.l(e.x), $.flatCast(this.S, $.l(e.cc)));
    });
  }

  /** doSend: the host's SEND (an error with no callback is dropped, as
   * Node's doSend drops it). */
  private doSendFn(): number {
    return this.fn("doSend", [this.udpRef(), this.bytesRef, F64, this.strRef], [], (f, $) => {
      const [U, B, PORT, ADDR] = [0, 1, 2, 3];
      const BASE = f.local(I32);
      const P = f.local(I32);
      const I = f.local(I32);
      const N = f.local(I32);
      const BUF = f.local(this.ref(this.deps.bufType()));
      const OFF = f.local(I32);
      const T = this.udpT();
      // closed in the mean time
      $.if($.eq($.get(T, U_H, $.l(U)), $.i(0)), () => $.ret());
      $.put(N, $.get(this.BT, 2, $.l(B)));
      $.put(BUF, $.get(this.BT, 0, $.l(B)));
      $.put(OFF, $.get(this.BT, 1, $.l(B)));
      this.deps.ensureCapacity(f.c, () => $.do($.add($.l(N), $.add($.sel(I32, $.isNull($.l(ADDR)), $.i(0), $.shl($.alen($.l(ADDR)), $.i(1))), $.i(64)))));
      this.base($, BASE);
      $.put(P, $.call(this.stageAddrFn(), $.l(BASE), $.d2i($.l(PORT)), $.sel(this.strRef, $.isNull($.l(ADDR)), this.lit($, ""), $.l(ADDR))));
      this.storeU32($, $.l(P), $.l(N));
      $.for(I, $.i(0), $.l(N), () => {
        $.do($.add($.add($.l(P), $.i(4)), $.l(I)), $.agetU(this.deps.bufType(), $.l(BUF), $.add($.l(OFF), $.l(I))));
        f.c.i32Store8();
      });
      $.put(P, $.add($.add($.l(P), $.i(4)), $.and($.add($.l(N), $.i(3)), $.i(-4))));
      $.drop($.call(this.deps.netCallFunc(), $.i(OP_UDP_SEND), $.l(BASE), $.sub($.l(P), $.l(BASE)), $.get(T, U_H, $.l(U)), $.i(0)));
    });
  }

  /** Socket.prototype.close([cb]) */
  closeFn(): number {
    return this.fn("close", [this.udpRef(), this.ref(this.deps.voidClos().clos)], [I32], (f, $) => {
      const [U, CB] = [0, 1];
      const T = this.udpT();
      $.if($.notNull($.l(CB)), () => this.on($, DGRAM_LISTS.CLOSE, $.l(U), $.l(CB)));
      $.if($.get(T, U_QSET, $.l(U)), () => {
        $.run(this.enqueueFn(), $.l(U), this.clos($, this.closeLaterFn(), { a: $.l(U) }));
        $.ret($.i(1));
      });
      $.if($.not($.call(this.healthFn(), $.l(U))), () => $.ret($.i(0)));
      // stopReceiving; handle.close(); state.handle = null
      $.set(T, U_RECV, $.l(U), $.i(0));
      $.if($.ne($.get(T, U_H, $.l(U)), $.i(0)), () => {
        $.if($.ne($.call(this.deps.netCallFunc(), $.i(OP_CLOSE), $.i(0), $.i(0), $.get(T, U_H, $.l(U)), $.i(0)), $.i(0)), () => this.trap($));
        $.run(this.net.tableSetHelper(), $.get(T, U_H, $.l(U)), $.nul(EQ_HEAP));
        $.set(T, U_H, $.l(U), $.i(0));
      });
      $.set(T, U_CLOSED, $.l(U), $.i(1));
      this.nextTick($, this.closeTickFn(), { a: $.l(U) });
      $.do($.i(1));
    });
  }

  private closeLaterFn(): number {
    return this.tick("closeLater", ($, e) => {
      $.drop($.call(this.closeFn(), $.cast(this.udpT(), $.l(e.a)), $.nul(this.deps.voidClos().clos)));
    });
  }

  private closeTickFn(): number {
    return this.tick("socketCloseNT", ($, e) => {
      $.drop($.call(this.emitFn(DGRAM_LISTS.CLOSE), $.cast(this.udpT(), $.l(e.a))));
    });
  }

  /** socket.address(): the parts (address, port); 0 with the error pending. */
  addressCheckFn(): number {
    return this.fn("addressCheck", [this.udpRef()], [I32], (f, $) => {
      $.if($.not($.call(this.healthFn(), $.l(0))), () => $.ret($.i(0)));
      $.if($.eq($.get(this.udpT(), U_H, $.l(0)), $.i(0)), () => {
        // getsockname on a socket with no fd: EBADF
        $.do($.call(this.net.errnoExHelper(), $.raw((c) => this.net.emitErrnoNum(c, "EBADF")), this.lit($, "getsockname")));
        this.deps.throwStack(f.c);
        $.ret($.i(0));
      });
      $.do($.i(1));
    });
  }
  addrStrFn(): number {
    return this.fn("addrStr", [this.udpRef()], [this.strRef], (f, $) => $.do($.get(this.udpT(), U_LADDR, $.l(0))));
  }
  addrPortFn(): number {
    return this.fn("addrPort", [this.udpRef()], [F64], (f, $) => $.do($.i2d($.get(this.udpT(), U_LPORT, $.l(0)))));
  }

  refFn(on: boolean): number {
    return this.fn(on ? "ref" : "unref", [this.udpRef()], [], (f, $) => $.set(this.udpT(), U_UNREF, $.l(0), $.i(on ? 0 : 1)));
  }

  /** net.ts's alive hook: the handle is open, receiving and ref'd. */
  aliveFn(): number {
    return this.fn("alive", [this.udpRef()], [I32], (f, $) => {
      const T = this.udpT();
      $.do($.both($.both($.ne($.get(T, U_H, $.l(0)), $.i(0)), $.get(T, U_RECV, $.l(0))), $.not($.get(T, U_UNREF, $.l(0)))));
    });
  }

  /** net.ts's event hook: `(udp, kind, a, ptr, len)`. */
  eventFn(): number {
    return this.fn("event", [this.udpRef(), I32, I32, I32, I32], [], (f, $) => {
      const [U, KIND, A_, PTR, LEN] = [0, 1, 2, 3, 4];
      const ADDR = f.local(this.strRef);
      const PORT = f.local(I32);
      const OFF = f.local(I32);
      const B = f.local(this.bytesRef);
      $.if($.eq($.l(KIND), $.i(EV_UDP_MESSAGE)), () => {
        $.put(PORT, this.loadU32($, $.add($.l(PTR), $.i(4))));
        $.put(ADDR, $.call(this.net.readRunHelper(), $.add($.l(PTR), $.i(8))));
        $.put(OFF, $.add($.i(12), $.and($.add($.shl(this.loadU32($, $.add($.l(PTR), $.i(8))), $.i(1)), $.i(3)), $.i(-4))));
        $.if($.gt($.l(OFF), $.l(LEN)), () => this.trap($));
        $.put(B, $.call(this.net.bytesAtHelper(), $.add($.l(PTR), $.l(OFF)), $.sub($.l(LEN), $.l(OFF))));
        $.drop($.call(this.emitFn(DGRAM_LISTS.MESSAGE), $.l(U), $.l(B), $.l(ADDR), this.lit($, "IPv4"), $.i2d($.l(PORT)), $.i2d($.get(this.BT, 2, $.l(B)))));
        $.ret();
      });
      $.if($.eq($.l(KIND), $.i(EV_UDP_ERROR)), () => {
        $.run(this.emitErrorFn(), $.l(U), $.call(this.net.errnoExHelper(), $.l(A_), this.lit($, "recvmsg")));
        $.ret();
      });
      this.trap($);
    });
  }

  /* ── send's checked-dynamic ladder (Socket.prototype.send) ────────── */

  /** `>>> 0` over the shapes the ladder reaches. */
  private toU32Fn(): number {
    return this.fn("toU32", [this.dynRef], [F64], (f, $) => {
      const D = 0;
      const N = f.local(F64);
      const K = f.local(I32);
      $.put(K, $.get(this.DT, 0, $.l(D)));
      $.put(N, $.d(0));
      $.if($.eq($.l(K), $.i(K_NUM)), () => $.put(N, $.get(this.DT, 1, $.l(D))));
      $.if($.eq($.l(K), $.i(K_BOOL)), () => $.put(N, $.get(this.DT, 1, $.l(D))));
      $.if($.eq($.l(K), $.i(K_STR)), () => $.put(N, $.call(this.deps.strToNumber(), $.flatCast(this.S, $.get(this.DT, 2, $.l(D))))));
      // an object, array, Buffer or function goes through ToPrimitive
      // (valueOf / toString): not modelled
      $.if($.not($.either($.either($.eq($.l(K), $.i(K_NUM)), $.eq($.l(K), $.i(K_BOOL))), $.either($.eq($.l(K), $.i(K_STR)), $.either($.eq($.l(K), $.i(K_UNDEF)), $.eq($.l(K), $.i(K_NULL)))))), () => {
        this.fence($, "an object as a dgram send offset or length");
        $.ret($.d(0));
      });
      // NaN / +-Infinity -> 0; truncate; modulo 2^32
      $.if($.dne($.dsub($.l(N), $.l(N)), $.d(0)), () => $.ret($.d(0)));
      $.put(N, $.raw((c) => {
        c.localGet(N);
        c.f64Trunc();
      }));
      $.put(N, $.dsub($.l(N), $.raw((c) => {
        c.localGet(N);
        c.f64Const(4294967296);
        c.f64Div();
        c.f64Floor();
        c.f64Const(4294967296);
        c.f64Mul();
      })));
      $.do($.l(N));
    });
  }

  private truthy($: A, d: X): X {
    return $.call(this.truthyFn(), d);
  }
  private truthyFn(): number {
    return this.fn("truthy", [this.dynRef], [I32], (f, $) => {
      const D = 0;
      const K = f.local(I32);
      const N = f.local(F64);
      $.put(K, $.get(this.DT, 0, $.l(D)));
      $.if($.either($.eq($.l(K), $.i(K_UNDEF)), $.eq($.l(K), $.i(K_NULL))), () => $.ret($.i(0)));
      $.if($.either($.eq($.l(K), $.i(K_BOOL)), $.eq($.l(K), $.i(K_NUM))), () => {
        $.put(N, $.get(this.DT, 1, $.l(D)));
        $.ret($.both($.dne($.l(N), $.d(0)), $.deq($.l(N), $.l(N))));
      });
      $.if($.eq($.l(K), $.i(K_STR)), () => $.ret($.gt($.alen($.flatCast(this.S, $.get(this.DT, 2, $.l(D)))), $.i(0))));
      $.do($.i(1));
    });
  }
  private kind($: A, d: X): X {
    return $.get(this.DT, 0, d);
  }

  /** `(dyn) -> byteLength` for a string (its UTF-8 length) or bytes. */
  private byteLenFn(): number {
    return this.fn("byteLen", [this.dynRef], [F64], (f, $) => {
      const D = 0;
      $.if($.eq(this.kind($, $.l(D)), $.i(K_STR)), () => $.ret($.i2d($.get(this.BT, 2, $.call(this.deps.strToBytes(), $.flatCast(this.S, $.get(this.DT, 2, $.l(D))))))));
      $.do($.i2d($.get(this.BT, 2, $.call(this.deps.dynBytes(), $.l(D)))));
    });
  }

  /** The send ladder over checked-dynamic arguments (buffer, a1..a4) then
   * the send; `fence` is the compiler-rendered refusal for the callback
   * and list forms. 1, or 0 with the error pending. */
  sendChkFn(): number {
    return this.fn("sendChk", [this.udpRef(), this.dynRef, this.dynRef, this.dynRef, this.dynRef, this.dynRef, this.strRef], [I32], (f, $) => {
      const [U, BUF0, A1, A2, A3, A4, FENCE] = [0, 1, 2, 3, 4, 5, 6];
      const BUF = f.local(this.dynRef);
      const OFF = f.local(this.dynRef);
      const LEN = f.local(this.dynRef);
      const PORT = f.local(this.dynRef);
      const ADDR = f.local(this.dynRef);
      const CB = f.local(this.dynRef);
      const CONNECTED = f.local(I32);
      const SLICED = f.local(I32);
      const BL = f.local(F64);
      const O32 = f.local(F64);
      const L32 = f.local(F64);
      const I = f.local(I32);
      const N = f.local(I32);
      const E = f.local(this.dynRef);
      const BYTES = f.local(this.bytesRef);
      const PNUM = f.local(F64);
      const vec = this.deps.dynArrVec();
      const expected = "of type string or an instance of Buffer, TypedArray, or DataView";
      const argType = (name: string, d: X): void => {
        this.throwErr($, "%TypeError", this.cat($, this.lit($, `The "${name}" argument must be ${expected}. Received `), $.call(this.deps.specificType(), d)), "ERR_INVALID_ARG_TYPE");
        $.ret($.i(0));
      };
      const isBuf = (d: X): X => $.either($.eq(this.kind($, d), $.i(K_STR)), $.eq(this.kind($, d), $.i(K_BYTES)));
      $.put(BUF, $.l(BUF0));
      $.put(OFF, $.l(A1));
      $.put(LEN, $.l(A2));
      $.put(PORT, $.l(A3));
      $.put(ADDR, $.l(A4));
      $.put(CB, $.nul(this.DT));
      $.put(CONNECTED, $.eq($.get(this.udpT(), U_CONN, $.l(U)), $.i(2)));
      const slice = (): void => {
        // sliceBuffer(buffer, offset, length)
        $.if($.not(isBuf($.l(BUF))), () => argType("buffer", $.l(BUF)));
        $.put(BL, $.call(this.byteLenFn(), $.l(BUF)));
        $.put(O32, $.call(this.toU32Fn(), $.l(OFF)));
        this.excReturn($, $.i(0));
        $.put(L32, $.call(this.toU32Fn(), $.l(LEN)));
        this.excReturn($, $.i(0));
        $.if($.dgt($.l(O32), $.l(BL)), () => {
          this.throwErr($, "%RangeError", this.lit($, '"offset" is outside of buffer bounds'), "ERR_BUFFER_OUT_OF_BOUNDS");
          $.ret($.i(0));
        });
        $.if($.dgt($.dadd($.l(O32), $.l(L32)), $.l(BL)), () => {
          this.throwErr($, "%RangeError", this.lit($, '"length" is outside of buffer bounds'), "ERR_BUFFER_OUT_OF_BOUNDS");
          $.ret($.i(0));
        });
        $.put(SLICED, $.i(1));
      };
      $.if($.not($.l(CONNECTED)), () => {
        $.if($.either(this.truthy($, $.l(ADDR)), $.both(this.truthy($, $.l(PORT)), $.ne(this.kind($, $.l(PORT)), $.i(K_FUNC)))), slice, () => {
          $.put(CB, $.l(PORT));
          $.put(PORT, $.l(OFF));
          $.put(ADDR, $.l(LEN));
        });
      }, () => {
        $.if($.eq(this.kind($, $.l(LEN)), $.i(K_NUM)), () => {
          slice();
          $.if($.eq(this.kind($, $.l(PORT)), $.i(K_FUNC)), () => {
            $.put(CB, $.l(PORT));
            $.put(PORT, $.nul(this.DT));
          });
        }, () => $.put(CB, $.l(OFF)));
        $.if($.either($.andThen($.notNull($.l(PORT)), this.truthy($, $.l(PORT))), $.andThen($.notNull($.l(ADDR)), this.truthy($, $.l(ADDR)))), () => {
          this.throwErr($, "%Error", this.lit($, "Already connected"), "ERR_SOCKET_DGRAM_IS_CONNECTED");
          $.ret($.i(0));
        });
      });
      // the list
      $.if($.eq(this.kind($, $.l(BUF)), $.i(K_ARR)), () => {
        $.put(N, $.get(vec.struct, 0, $.cast(vec.struct, $.get(this.DT, 2, $.l(BUF)))));
        $.for(I, $.i(0), $.l(N), () => {
          $.put(E, $.aget(vec.bufType, $.get(vec.struct, 1, $.cast(vec.struct, $.get(this.DT, 2, $.l(BUF)))), $.l(I)));
          $.if($.not(isBuf($.l(E))), () => argType("buffer list arguments", $.l(BUF)));
        });
      }, () => {
        $.if($.not(isBuf($.l(BUF))), () => argType("buffer", $.l(BUF)));
      });
      // if (!connected) port = validatePort(port, 'Port', false)
      $.if($.not($.l(CONNECTED)), () => {
        const PSTR = f.local(I32);
        $.put(PNUM, $.d(-1));
        $.if($.andThen($.notNull($.l(PORT)), $.eq(this.kind($, $.l(PORT)), $.i(K_NUM))), () => $.put(PNUM, $.get(this.DT, 1, $.l(PORT))));
        $.if($.andThen($.notNull($.l(PORT)), $.andThen($.eq(this.kind($, $.l(PORT)), $.i(K_STR)), $.gt($.alen($.flatCast(this.S, $.get(this.DT, 2, $.l(PORT)))), $.i(0)))), () => {
          $.put(PNUM, $.call(this.deps.strToNumber(), $.flatCast(this.S, $.get(this.DT, 2, $.l(PORT)))));
          $.put(PSTR, $.i(1));
        });
        // validatePort's `port === 0 && !allowZero` compares the value
        // itself: a string "0" passes it.
        $.if($.either($.either($.dne($.raw((c) => {
          c.localGet(PNUM);
          c.f64Trunc();
        }), $.l(PNUM)), $.either($.dlt($.l(PNUM), $.d(0)), $.both($.deq($.l(PNUM), $.d(0)), $.not($.l(PSTR))))), $.dgt($.l(PNUM), $.d(65535))), () => {
          this.throwErr($, "%RangeError", this.cat($, this.lit($, "Port should be > 0 and < 65536. Received "), $.call(this.deps.specificType(), $.sel(this.dynRef, $.isNull($.l(PORT)), $.raw((c) => {
            c.i32Const(K_UNDEF);
            c.f64Const(0);
            c.refNull(EQ_HEAP);
            c.structNew(this.DT);
          }), $.l(PORT))), this.lit($, ".")), "ERR_SOCKET_BAD_PORT");
          $.ret($.i(0));
        });
      });
      // callback normalization, then the address
      $.if($.andThen($.notNull($.l(ADDR)), $.eq(this.kind($, $.l(ADDR)), $.i(K_FUNC))), () => {
        $.put(CB, $.l(ADDR));
        $.put(ADDR, $.nul(this.DT));
      }, () => {
        $.if($.andThen($.notNull($.l(ADDR)), $.not($.either($.either($.eq(this.kind($, $.l(ADDR)), $.i(K_UNDEF)), $.eq(this.kind($, $.l(ADDR)), $.i(K_NULL))), $.eq(this.kind($, $.l(ADDR)), $.i(K_STR))))), () => {
          this.throwErr($, "%TypeError", this.cat($, this.lit($, 'The "address" argument must be of type string. Received '), $.call(this.deps.specificType(), $.l(ADDR))), "ERR_INVALID_ARG_TYPE");
          $.ret($.i(0));
        });
      });
      // completion callbacks and lists: the compiler-rendered fence
      $.if($.either($.andThen($.notNull($.l(CB)), $.eq(this.kind($, $.l(CB)), $.i(K_FUNC))), $.eq(this.kind($, $.l(BUF)), $.i(K_ARR))), () => {
        this.throwErr($, "%Error", $.l(FENCE), "SC2020");
        $.ret($.i(0));
      });
      // the datagram: the buffer (sliced), as bytes
      $.put(BYTES, $.sel(this.bytesRef, $.eq(this.kind($, $.l(BUF)), $.i(K_STR)), $.call(this.deps.strToBytes(), $.flatCast(this.S, $.get(this.DT, 2, $.l(BUF)))), $.call(this.deps.dynBytes(), $.l(BUF))));
      $.if($.l(SLICED), () => {
        $.put(BYTES, $.new_(this.BT, $.get(this.BT, 0, $.l(BYTES)), $.add($.get(this.BT, 1, $.l(BYTES)), $.d2i($.l(O32))), $.d2i($.l(L32))));
      });
      $.do($.call(this.sendFn(), $.l(U), $.l(BYTES), $.sel(F64, $.l(CONNECTED), $.d(0), $.l(PNUM)), $.sel(this.strRef, $.andThen($.notNull($.l(ADDR)), $.eq(this.kind($, $.l(ADDR)), $.i(K_STR))), $.flatCast(this.S, $.get(this.DT, 2, $.l(ADDR))), this.lit($, ""))));
    });
  }
}

export { K_BOOL };
