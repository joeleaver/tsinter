/* Units G1-G3 — the host-event surfaces on the WasmGC tier: process signal
 * listeners (G1, `sigCall`), and the shared foreign-source dispatcher every
 * event module's poll phase calls for an evPoll source it does not own
 * itself (abi.ts, evPoll sources 3-5). One builder with its own `fn()` memo
 * and its own `%w.hev.*` name prefix (net.ts's shape).
 *
 * SIGNALS (G1). The host only subscribes and unsubscribes a signal number
 * (libuv's uv_signal_start / uv_signal_stop, abi.ts `sigCall`) and queues one
 * SIGNAL record per delivery; everything a program observes is Node's
 * lib/internal/process/per_thread.js startListeningIfSignal /
 * stopListeningIfSignal and lib/events.js, built here:
 *   - on / once append to the signal's listener array; the FIRST listener
 *     starts the subscription (Node's 'newListener' hook), removing the LAST
 *     one stops it, which gives the default disposition back.
 *   - off / removeListener remove the LAST registration of the listener
 *     (EventEmitter.removeListener scans from the end; a once registration
 *     matches its listener).
 *   - a delivery is process.emit(signal): the array is COPIED first, so a
 *     listener added during the emission is not called for it and one
 *     removed during it still is; a once registration removes itself when
 *     the emission reaches it (onceWrapper's fired flag guards a nested
 *     emission); each listener is followed by the death check (an uncaught
 *     throw ends the program) and the whole emission by ONE checkpoint —
 *     one MakeCallback into Node.
 *   - signals add nothing to the loop's liveness: Node unrefs the wrap
 *     (measured: a program that signals itself with nothing else alive
 *     exits without the listener running). */
import { Code } from "./code.js";
import { F64, I32, ModuleBuilder, type ValType } from "./module.js";

export interface HostEvDeps {
  /** `tsinter.evPoll`'s index. */
  evPollFunc: () => number;
  /** `tsinter.sigCall`'s index (G1). */
  sigCallFunc: () => number;
  /** `emitEnsureCapacity`: `need` pushes ONE i32 and is emitted twice. */
  ensureCapacity: (c: Code, need: () => void) => void;
  /** The output-stage bump-cursor global. */
  stageCursor: () => number;
  /** Print `message` as the uncaught report and trap. */
  namedTrap: (c: Code, message: string) => void;
  /** The `() => void` closure pair (every signal listener's shape). */
  voidClos: () => { clos: number; fn: number };
  excKind: () => number;
  reportUncaught: () => number;
  /** One steady-state microtask checkpoint, emitted inline. */
  checkpoint: (c: Code) => void;
  /** Which surfaces this module reaches (static prescan facts). */
  signals: boolean;
}

/** evPoll's header, in bytes, and the module's first buffer size. */
const EV_HEADER_BYTES = 24;
const EV_FIRST_CAPACITY = 1024;
const HOST_FAILURE = "evPoll: host failure";
/** evPoll sources (abi.ts). */
export const SRC_SIGNAL = 3;
/** sigCall ops (abi.ts). */
const SIG_START = 1;
const SIG_STOP = 2;
/** Signal numbers index a table this long (Linux numbers 1..64). */
const SIG_TABLE_LEN = 65;

/* A signal listener entry. */
const E_CB = 0; // the listener closure (identity for off)
const E_ONCE = 1; // i32
const E_FIRED = 2; // i32, mutable: onceWrapper's fired flag

/* A signal's state. */
const SG_HANDLE = 0; // i32: the host subscription, 0 = none
const SG_N = 1; // i32: live listener count
const SG_LIST = 2; // the listener array (grown by copy)

class Fn {
  readonly c = new Code();
  private readonly extra: ValType[] = [];
  constructor(private readonly nparams: number) {}
  local(t: ValType): number {
    this.extra.push(t);
    return this.nparams + this.extra.length - 1;
  }
  get locals(): ValType[] {
    return this.extra;
  }
}

export class HostEvBuilder {
  private readonly fns = new Map<string, number>();
  private entTField: number | null = null;
  private entArrTField: number | null = null;
  private sigTField: number | null = null;
  private sigTabTField: number | null = null;
  private globalsField: { cap: number; sigTab: number } | null = null;

  constructor(
    private readonly mb: ModuleBuilder,
    private readonly deps: HostEvDeps,
  ) {}

  /* ── plumbing ──────────────────────────────────────────────────────── */

  private fn(name: string, params: ValType[], results: ValType[], build: (f: Fn) => void): number {
    const hit = this.fns.get(name);
    if (hit !== undefined) return hit;
    const idx = this.mb.declareFunc(this.mb.funcType(params, results), `%w.hev.${name}`);
    this.fns.set(name, idx);
    const f = new Fn(params.length);
    build(f);
    this.mb.setBody(idx, f.locals, f.c.bytes());
    return idx;
  }

  private ref(typeIndex: number): ValType {
    return { kind: "ref", nullable: true, typeIndex };
  }

  private if_(c: Code, cond: () => void, then: () => void, els?: () => void): void {
    cond();
    c.ifVoid();
    then();
    if (els !== undefined) {
      c.else_();
      els();
    }
    c.end();
  }

  /** while (cond) body — `body` must not branch out of the loop. */
  private while_(c: Code, cond: () => void, body: () => void): void {
    c.block();
    c.loop();
    cond();
    c.i32Eqz();
    c.brIf(1);
    body();
    c.br(0);
    c.end();
    c.end();
  }

  private trap(c: Code): void {
    this.deps.namedTrap(c, HOST_FAILURE);
  }

  /** u32 little-endian load at local `addr` + off (two 16-bit loads, no
   * alignment claimed — childasync.ts's emitLoadU32). */
  private loadU32(c: Code, addr: number, off: number): void {
    c.localGet(addr);
    c.i32Const(off);
    c.i32Add();
    c.i32Load16U();
    c.localGet(addr);
    c.i32Const(off + 2);
    c.i32Add();
    c.i32Load16U();
    c.i32Const(16);
    c.i32Shl();
    c.i32Or();
  }

  /** The stage base: the cursor rounded up to 4. */
  private base(c: Code, local: number): void {
    c.globalGet(this.deps.stageCursor());
    c.i32Const(3);
    c.i32Add();
    c.i32Const(-4);
    c.i32And();
    c.localSet(local);
  }

  /** The death check after a listener: an uncaught throw ends the program. */
  private deathCheck(c: Code): void {
    c.globalGet(this.deps.excKind());
    c.ifVoid();
    c.call(this.deps.reportUncaught());
    c.end();
  }

  /** Call the `() => void` closure in local `cb`. */
  private callVoid(c: Code, cb: number): void {
    const pair = this.deps.voidClos();
    c.localGet(cb);
    c.localGet(cb);
    c.structGet(pair.clos, 0);
    c.callRef(pair.fn);
  }

  /* ── types and globals ─────────────────────────────────────────────── */

  private get voidRef(): ValType {
    return this.ref(this.deps.voidClos().clos);
  }

  private get entT(): number {
    this.entTField ??= this.mb.structType([
      { storage: this.voidRef, mutable: false },
      { storage: I32, mutable: false },
      { storage: I32, mutable: true },
    ]);
    return this.entTField;
  }

  private get entArrT(): number {
    this.entArrTField ??= this.mb.arrayType(this.ref(this.entT), true);
    return this.entArrTField;
  }

  private get sigT(): number {
    this.sigTField ??= this.mb.structType([
      { storage: I32, mutable: true },
      { storage: I32, mutable: true },
      { storage: this.ref(this.entArrT), mutable: true },
    ]);
    return this.sigTField;
  }

  private get sigTabT(): number {
    this.sigTabTField ??= this.mb.arrayType(this.ref(this.sigT), true);
    return this.sigTabTField;
  }

  private g(): { cap: number; sigTab: number } {
    if (this.globalsField === null) {
      const tabT = this.sigTabT;
      this.globalsField = {
        cap: this.mb.addGlobal(I32, true, (w) => {
          w.u8(0x41);
          w.sleb(EV_FIRST_CAPACITY);
        }),
        sigTab: this.mb.addGlobal(this.ref(tabT), true, (w) => {
          w.u8(0xd0);
          w.sleb(tabT);
        }),
      };
    }
    return this.globalsField;
  }

  /* ── signals (G1) ──────────────────────────────────────────────────── */

  /** `%w.hev.sigState(signum) -> sig` — the signal's state, made on first
   * use (the table too). */
  private sigStateHelper(): number {
    return this.fn("sigState", [I32], [this.ref(this.sigT)], (f) => {
      const c = f.c;
      const SIG = 0;
      const ST = f.local(this.ref(this.sigT));
      const g = this.g();
      this.if_(c, () => {
        c.globalGet(g.sigTab);
        c.refIsNull();
      }, () => {
        c.i32Const(SIG_TABLE_LEN);
        c.arrayNewDefault(this.sigTabT);
        c.globalSet(g.sigTab);
      });
      // The front end bakes a Linux number; anything outside the table is a
      // compiler bug, not a program outcome.
      this.if_(c, () => {
        c.localGet(SIG);
        c.i32Const(SIG_TABLE_LEN);
        c.i32GeU();
      }, () => c.unreachable());
      c.globalGet(g.sigTab);
      c.localGet(SIG);
      c.arrayGet(this.sigTabT);
      c.localTee(ST);
      c.refIsNull();
      c.ifVoid();
      c.i32Const(0);
      c.i32Const(0);
      c.i32Const(4);
      c.arrayNewDefault(this.entArrT);
      c.structNew(this.sigT);
      c.localSet(ST);
      c.globalGet(g.sigTab);
      c.localGet(SIG);
      c.localGet(ST);
      c.arraySet(this.sigTabT);
      c.end();
      c.localGet(ST);
    });
  }

  /** `%w.hev.sigStop(st)` — the last listener left: the subscription stops
   * (Node's stopListeningIfSignal; the host drops anything it queued for
   * the handle). */
  private sigStopHelper(): number {
    return this.fn("sigStop", [this.ref(this.sigT)], [], (f) => {
      const c = f.c;
      const ST = 0;
      this.if_(c, () => {
        c.localGet(ST);
        c.structGet(this.sigT, SG_N);
        c.i32Eqz();
        c.localGet(ST);
        c.structGet(this.sigT, SG_HANDLE);
        c.i32Const(0);
        c.i32Ne();
        c.i32And();
      }, () => {
        c.i32Const(SIG_STOP);
        c.localGet(ST);
        c.structGet(this.sigT, SG_HANDLE);
        c.call(this.deps.sigCallFunc());
        // STOP answers 0; anything else is a host failure.
        c.ifVoid();
        this.trap(c);
        c.end();
        c.localGet(ST);
        c.i32Const(0);
        c.structSet(this.sigT, SG_HANDLE);
      });
    });
  }

  /** `%w.hev.sigRemoveAt(st, i)` — splice entry i out of the live array. */
  private sigRemoveAtHelper(): number {
    return this.fn("sigRemoveAt", [this.ref(this.sigT), I32], [], (f) => {
      const c = f.c;
      const ST = 0;
      const I = 1;
      const LIST = f.local(this.ref(this.entArrT));
      const N = f.local(I32);
      c.localGet(ST);
      c.structGet(this.sigT, SG_LIST);
      c.localSet(LIST);
      c.localGet(ST);
      c.structGet(this.sigT, SG_N);
      c.i32Const(1);
      c.i32Sub();
      c.localSet(N);
      // list[i .. n-1) = list[i+1 .. n)
      this.if_(c, () => {
        c.localGet(I);
        c.localGet(N);
        c.i32LtS();
      }, () => {
        c.localGet(LIST);
        c.localGet(I);
        c.localGet(LIST);
        c.localGet(I);
        c.i32Const(1);
        c.i32Add();
        c.localGet(N);
        c.localGet(I);
        c.i32Sub();
        c.arrayCopy(this.entArrT, this.entArrT);
      });
      c.localGet(LIST);
      c.localGet(N);
      c.refNull(this.entT);
      c.arraySet(this.entArrT);
      c.localGet(ST);
      c.localGet(N);
      c.structSet(this.sigT, SG_N);
      c.localGet(ST);
      c.call(this.sigStopHelper());
    });
  }

  /** `%w.hev.sigOn(signo, cb, once)` — process.on / process.once. */
  sigOnHelper(): number {
    return this.fn("sigOn", [F64, this.voidRef, I32], [], (f) => {
      const c = f.c;
      const SIGNO = 0;
      const CB = 1;
      const ONCE = 2;
      const ST = f.local(this.ref(this.sigT));
      const LIST = f.local(this.ref(this.entArrT));
      const N = f.local(I32);
      const NL = f.local(this.ref(this.entArrT));
      const H = f.local(I32);
      c.localGet(SIGNO);
      c.i32TruncF64S();
      c.call(this.sigStateHelper());
      c.localSet(ST);
      c.localGet(ST);
      c.structGet(this.sigT, SG_LIST);
      c.localSet(LIST);
      c.localGet(ST);
      c.structGet(this.sigT, SG_N);
      c.localSet(N);
      // Grow by copy when full.
      this.if_(c, () => {
        c.localGet(N);
        c.localGet(LIST);
        c.arrayLen();
        c.i32GeU();
      }, () => {
        c.localGet(N);
        c.i32Const(1);
        c.i32Shl();
        c.i32Const(4);
        c.i32Add();
        c.arrayNewDefault(this.entArrT);
        c.localSet(NL);
        c.localGet(NL);
        c.i32Const(0);
        c.localGet(LIST);
        c.i32Const(0);
        c.localGet(N);
        c.arrayCopy(this.entArrT, this.entArrT);
        c.localGet(NL);
        c.localSet(LIST);
        c.localGet(ST);
        c.localGet(LIST);
        c.structSet(this.sigT, SG_LIST);
      });
      c.localGet(LIST);
      c.localGet(N);
      c.localGet(CB);
      c.localGet(ONCE);
      c.i32Const(0);
      c.structNew(this.entT);
      c.arraySet(this.entArrT);
      c.localGet(ST);
      c.localGet(N);
      c.i32Const(1);
      c.i32Add();
      c.structSet(this.sigT, SG_N);
      // The first listener starts the subscription.
      this.if_(c, () => {
        c.localGet(ST);
        c.structGet(this.sigT, SG_HANDLE);
        c.i32Eqz();
      }, () => {
        c.i32Const(SIG_START);
        c.localGet(SIGNO);
        c.i32TruncF64S();
        c.call(this.deps.sigCallFunc());
        c.localTee(H);
        c.i32Const(0);
        c.i32LeS();
        c.ifVoid();
        // uv_signal_start fails only for a number the kernel rejects; the
        // front end admits SIGINT and SIGTERM alone.
        this.trap(c);
        c.end();
        c.localGet(ST);
        c.localGet(H);
        c.structSet(this.sigT, SG_HANDLE);
      });
    });
  }

  /** `%w.hev.sigOff(signo, cb)` — process.off / process.removeListener:
   * the LAST registration of `cb` leaves. */
  sigOffHelper(): number {
    return this.fn("sigOff", [F64, this.voidRef], [], (f) => {
      const c = f.c;
      const SIGNO = 0;
      const CB = 1;
      const ST = f.local(this.ref(this.sigT));
      const I = f.local(I32);
      c.localGet(SIGNO);
      c.i32TruncF64S();
      c.call(this.sigStateHelper());
      c.localSet(ST);
      c.localGet(ST);
      c.structGet(this.sigT, SG_N);
      c.i32Const(1);
      c.i32Sub();
      c.localSet(I);
      c.block();
      c.loop();
      c.localGet(I);
      c.i32Const(0);
      c.i32LtS();
      c.brIf(1);
      c.localGet(ST);
      c.structGet(this.sigT, SG_LIST);
      c.localGet(I);
      c.arrayGet(this.entArrT);
      c.structGet(this.entT, E_CB);
      c.localGet(CB);
      c.refEq();
      c.ifVoid();
      c.localGet(ST);
      c.localGet(I);
      c.call(this.sigRemoveAtHelper());
      c.br(2);
      c.end();
      c.localGet(I);
      c.i32Const(1);
      c.i32Sub();
      c.localSet(I);
      c.br(0);
      c.end();
      c.end();
    });
  }

  /** `%w.hev.sigDeliver(handle, signum)` — one SIGNAL record:
   * process.emit(signal) over a copy of the listener array, then ONE
   * checkpoint. */
  private sigDeliverHelper(): number {
    return this.fn("sigDeliver", [I32, I32], [], (f) => {
      const c = f.c;
      const H = 0;
      const SIG = 1;
      const ST = f.local(this.ref(this.sigT));
      const SNAP = f.local(this.ref(this.entArrT));
      const N = f.local(I32);
      const I = f.local(I32);
      const J = f.local(I32);
      const E = f.local(this.ref(this.entT));
      const CB = f.local(this.voidRef);
      const g = this.g();
      // The record must name a live subscription of this module: the host
      // drops a handle's records at STOP.
      this.if_(c, () => {
        c.globalGet(g.sigTab);
        c.refIsNull();
        c.localGet(SIG);
        c.i32Const(SIG_TABLE_LEN);
        c.i32GeU();
        c.i32Or();
      }, () => this.trap(c));
      c.globalGet(g.sigTab);
      c.localGet(SIG);
      c.arrayGet(this.sigTabT);
      c.localTee(ST);
      c.refIsNull();
      c.ifVoid();
      this.trap(c);
      c.end();
      this.if_(c, () => {
        c.localGet(H);
        c.i32Eqz();
        c.localGet(ST);
        c.structGet(this.sigT, SG_HANDLE);
        c.localGet(H);
        c.i32Ne();
        c.i32Or();
      }, () => this.trap(c));
      // The copy (Node's arrayClone).
      c.localGet(ST);
      c.structGet(this.sigT, SG_N);
      c.localTee(N);
      c.arrayNewDefault(this.entArrT);
      c.localSet(SNAP);
      c.localGet(SNAP);
      c.i32Const(0);
      c.localGet(ST);
      c.structGet(this.sigT, SG_LIST);
      c.i32Const(0);
      c.localGet(N);
      c.arrayCopy(this.entArrT, this.entArrT);
      this.while_(c, () => {
        c.localGet(I);
        c.localGet(N);
        c.i32LtS();
      }, () => {
        c.localGet(SNAP);
        c.localGet(I);
        c.arrayGet(this.entArrT);
        c.localTee(E);
        c.structGet(this.entT, E_CB);
        c.localSet(CB);
        c.block();
        this.if_(c, () => {
          c.localGet(E);
          c.structGet(this.entT, E_ONCE);
        }, () => {
          // onceWrapper: a nested emission already ran it.
          c.localGet(E);
          c.structGet(this.entT, E_FIRED);
          c.brIf(1);
          c.localGet(E);
          c.i32Const(1);
          c.structSet(this.entT, E_FIRED);
          // removeListener(type, wrapFn): by the entry's own identity, from
          // the end; a no-op when off() already removed it.
          c.localGet(ST);
          c.structGet(this.sigT, SG_N);
          c.i32Const(1);
          c.i32Sub();
          c.localSet(J);
          c.block();
          c.loop();
          c.localGet(J);
          c.i32Const(0);
          c.i32LtS();
          c.brIf(1);
          c.localGet(ST);
          c.structGet(this.sigT, SG_LIST);
          c.localGet(J);
          c.arrayGet(this.entArrT);
          c.localGet(E);
          c.refEq();
          c.ifVoid();
          c.localGet(ST);
          c.localGet(J);
          c.call(this.sigRemoveAtHelper());
          c.br(2);
          c.end();
          c.localGet(J);
          c.i32Const(1);
          c.i32Sub();
          c.localSet(J);
          c.br(0);
          c.end();
          c.end();
        });
        this.callVoid(c, CB);
        this.deathCheck(c);
        c.end();
        c.localGet(I);
        c.i32Const(1);
        c.i32Add();
        c.localSet(I);
      });
      this.deps.checkpoint(c);
    });
  }

  /* ── the foreign-source dispatcher and the poll phase ──────────────── */

  /** `%w.hev.dispatch(base, len)` — one evPoll record of a source this
   * builder owns (abi.ts sources 3-5), already read into the stage at
   * `base` (`len` bytes). Each handler reads what it needs from the record
   * before it runs a listener, so nothing staged later can overwrite it.
   * Any record out of shape is the named trap. */
  dispatchHelper(): number {
    return this.fn("dispatch", [I32, I32], [], (f) => {
      const c = f.c;
      const BASE = 0;
      const LEN = 1;
      const SRC = f.local(I32);
      const KIND = f.local(I32);
      const PLEN = f.local(I32);
      this.loadU32(c, BASE, 0);
      c.localSet(SRC);
      this.loadU32(c, BASE, 8);
      c.localSet(KIND);
      this.loadU32(c, BASE, 12);
      c.localSet(PLEN);
      this.if_(c, () => {
        c.localGet(LEN);
        c.localGet(PLEN);
        c.i32Const(EV_HEADER_BYTES);
        c.i32Add();
        c.i32Ne();
      }, () => this.trap(c));
      c.block();
      if (this.deps.signals) {
        // Source 3: SIGNAL (kind 1, no payload, b = 0).
        this.if_(c, () => {
          c.localGet(SRC);
          c.i32Const(SRC_SIGNAL);
          c.i32Eq();
        }, () => {
          this.if_(c, () => {
            c.localGet(KIND);
            c.i32Const(1);
            c.i32Ne();
            c.localGet(PLEN);
            c.i32Or();
            this.loadU32(c, BASE, 20);
            c.i32Or();
          }, () => this.trap(c));
          this.loadU32(c, BASE, 4);
          this.loadU32(c, BASE, 16);
          c.call(this.sigDeliverHelper());
          c.br(1);
        });
      }
      this.trap(c);
      c.end();
    });
  }

  /** `%w.hev.poll()` — the POLL phase of an event module that is neither a
   * child_process nor a net module: every queued host event, oldest first
   * (abi.ts, evPoll). A short buffer grows to the length the host needs and
   * asks again; the event is never dropped. */
  pollHelper(): number {
    return this.fn("poll", [], [], (f) => {
      const c = f.c;
      const BASE = f.local(I32);
      const LEN = f.local(I32);
      const g = this.g();
      c.block();
      c.loop();
      this.deps.ensureCapacity(c, () => {
        c.globalGet(g.cap);
        c.i32Const(3);
        c.i32Add();
      });
      this.base(c, BASE);
      c.localGet(BASE);
      c.globalGet(g.cap);
      c.call(this.deps.evPollFunc());
      c.localTee(LEN);
      c.i32Eqz();
      c.brIf(1);
      c.localGet(LEN);
      c.i32Const(0);
      c.i32LtS();
      c.ifVoid();
      c.i32Const(0);
      c.localGet(LEN);
      c.i32Sub();
      c.globalGet(g.cap);
      c.i32LeS();
      c.ifVoid();
      this.trap(c);
      c.end();
      c.i32Const(0);
      c.localGet(LEN);
      c.i32Sub();
      c.globalSet(g.cap);
      c.br(1);
      c.end();
      c.localGet(BASE);
      c.localGet(LEN);
      c.call(this.dispatchHelper());
      c.br(0);
      c.end();
      c.end();
    });
  }

  /** Pushes an i32, nonzero while a surface of this builder holds the loop.
   * Signals never do (Node unrefs the wrap). */
  emitAlive(c: Code): void {
    c.i32Const(0);
  }
}
