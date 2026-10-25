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
 *     exits without the listener running).
 *
 * FS.WATCH (G3). The host starts and stops a file-system event watch on a
 * path (libuv's uv_fs_event_start / uv_fs_event_stop, abi.ts `watchCall`)
 * and queues one EVENT record per notification; the FSWatcher is Node's
 * lib/internal/fs/watchers.js, built here: start's failure throws the
 * UVException text synchronously (fs.ts watchStart); an event is the
 * handle's onchange — "rename" when the libuv bitmask has UV_RENAME, else
 * "change" (fs_event_wrap.cc's precedence) — emitted to the one listener
 * fs.watch registered, followed by the death check and one checkpoint; a
 * watcher error closes the handle and emits 'error', which no lowered
 * program listens for, so it is the uncaught death with Node's message.
 * close() stops the watch once (idempotent: Node's `if (!this._handle)
 * return`), and an open watcher holds the loop (persistent: true, the only
 * lowered option — the front end fences the rest).
 *
 * STDIN AND READLINE (G2). The host reads fd 0 (libuv's uv_read_start /
 * uv_read_stop, abi.ts `stdinCall`) and queues DATA / EOF records; the
 * module is the part of Node's Readable (lib/internal/streams/readable.js)
 * and readline Interface (lib/internal/readline/interface.js) a lowered
 * program observes:
 *   - flowing is Node's tri-state: a 'data' listener resumes a stream not
 *     explicitly paused, createInterface resumes it whatever its state, and
 *     an interface's close() pauses it. The module reads while not ended
 *     and (flowing, or a for-await chunk promise is parked) — and that is
 *     the liveness term (a reading pipe is a ref'd handle).
 *   - ONE ordered 'data' list and ONE 'end' list, shared by the program's
 *     listeners and each interface's own (registration order, as Node's
 *     emitter has it); an emission runs over a copy, a once listener
 *     removes itself when reached; each listener is followed by the death
 *     check and each record by one checkpoint. A chunk while not flowing
 *     settles the parked chunk promise; EOF emits 'end' (a listener added
 *     during or after it never runs), settles a parked promise with the
 *     empty done sentinel, and drops every listener.
 *   - readline: kNormalWrite's splitter over a utf8 StringDecoder — lines
 *     end at /\r?\n|\r(?!\n)/ and a chunk ending in \r drops a leading \n of
 *     the next chunk when it arrives within the crlfDelay (Node's
 *     kSawReturnAt timestamp: `crlfDelay ? max(100, crlfDelay) : 100` ms
 *     on the monotonic clock), every line of
 *     a chunk found before any is dispatched; a line answers the pending
 *     question (the callback is taken first and the prompt restored) or is
 *     dropped. question() writes its prompt to stdout when the interface
 *     has an output stream (kWriteToOutput); with a question
 *     already pending it re-writes the CURRENT prompt and drops the new
 *     callback; after close() it throws Error "readline was closed"
 *     (ERR_USE_AFTER_CLOSE). close() pauses stdin, then emits 'close':
 *     first the interface's own listener removing its 'data' / 'end'
 *     entries, then the program's, synchronously (a throw reaches close()'s
 *     caller); a pending question survives it. EOF closes every interface
 *     still listening — the partial line is dropped, as Node's onend emits
 *     it as a 'line' nothing hears. An interface created once stdin has
 *     ended registers nothing: its prompts are written, it never closes by
 *     itself. */
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
  watch: boolean;
  /** Unit G3: `tsinter.watchCall`'s index. */
  watchCallFunc: () => number;
  /** fs.ts: `(path) -> i32`, the start (handle, or a failure with the
   * pending cell set), and `(status, filename | null) -> ()`, the error. */
  watchStart: () => number;
  watchError: () => number;
  strRef: () => ValType;
  strType: () => number;
  pushStrLit: (c: Code, value: string) => void;
  /** The `(string) => void` closure pair (a watch listener's eventType form). */
  strClos: () => { clos: number; fn: number };
  /** Unit G2: stdin and readline. */
  stdin: boolean;
  /** `tsinter.stdinCall`'s index. */
  stdinCallFunc: () => number;
  /** The $bytes struct and its i8 storage array (typedarrays.ts). */
  bytesType: () => number;
  bufType: () => number;
  /** The `(Buffer) => void` closure pair a 'data' listener is stored as. */
  dataClos: () => { clos: number; fn: number };
  /** promises.ts: the promise ref, `mint() -> promise` and
   * `settle(p, kind, f64, ref, pre, state)`; EXC_OBJ is the unread kind of a
   * ref payload. */
  promRef: () => ValType;
  promMint: () => number;
  promSettle: () => number;
  excObjKind: number;
  /** Write the string on the stack to fd 1, synchronously. */
  writeStdout: (c: Code) => void;
  /** strdec.ts: `(enc, pending, chunk) -> string` / `-> f64`. */
  strdecWrite: () => number;
  strdecNext: () => number;
  /** `%w.strConcat(a, b) -> string`. */
  concat: () => number;
  /** Write an Error of `className` with a code into the pending cell. */
  throwCoded: (c: Code, className: string, name: string, pushMessage: (c: Code) => void, pushCode: (c: Code) => void) => void;
  /** `tsinter.now`'s index (the monotonic clock; readline's kSawReturnAt). */
  nowFunc: () => number;
}

/** evPoll's header, in bytes, and the module's first buffer size. */
const EV_HEADER_BYTES = 24;
const EV_FIRST_CAPACITY = 1024;
const HOST_FAILURE = "evPoll: host failure";
/** evPoll sources (abi.ts). */
export const SRC_SIGNAL = 3;
export const SRC_WATCH = 4;
/** watchCall ops and event kinds (abi.ts). */
const WATCH_STOP = 2;
const WATCH_EV_CHANGE = 1;
const WATCH_EV_ERROR = 2;
/** libuv's uv_fs_event bits. */
const UV_RENAME = 1;
const UV_CHANGE = 2;
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

/* An FSWatcher. */
const W_HANDLE = 0; // i32: the host watch, 0 once closed
const W_CB = 1; // the listener (eq: either shape), null without one
const W_SHAPE = 2; // i32: 0 none, 1 () => void, 2 (eventType: string) => void

/** evPoll source 5 and stdinCall (abi.ts). */
export const SRC_STDIN = 5;
const STDIN_READ_START = 1;
const STDIN_READ_STOP = 2;
const STDIN_EV_DATA = 1;
const STDIN_EV_EOF = 2;
const STDIN_EV_ERROR = 3;
const STDIN_READ_ERROR = "process.stdin: a read error from the host is not supported yet";
const STDIN_START_FAILED = "process.stdin: the host could not start reading fd 0";

/* flowing's tri-state (Readable's readableFlowing). */
const FLOW_NULL = 0;
const FLOW_ON = 1;
const FLOW_OFF = 2;

/* A stdin 'data' / 'end' list entry: the program's listener (cb) or an
 * interface's own (rl), never both. */
const D_CB = 0;
const D_RL = 1;
const D_ONCE = 2;
const D_FIRED = 3;

/* A readline Interface. */
const R_CLOSED = 0; // i32
const R_PAUSED = 1; // i32: the interface paused its input (close)
const R_PROMPT = 2; // string
const R_OLD = 3; // string: kOldPrompt
const R_QCB = 4; // eq: the pending question's callback, null when none
const R_QSHAPE = 5; // i32: 1 () => void, 2 (answer: string) => void
const R_LINE = 6; // string | null: kLine_buffer
const R_SAWCR = 7; // i32: kSawReturnAt != 0
const R_DEC = 8; // f64: the utf8 StringDecoder's packed pending bytes
const R_CLOSEL = 9; // the 'close' listeners
const R_CLOSEN = 10; // i32
const R_HASOUT = 11; // i32: createInterface named an output stream
const R_DELAY = 12; // f64: the effective crlfDelay, ms
const R_SAWAT = 13; // f64: kSawReturnAt's time (meaningful while R_SAWCR)

/** The abstract `eq` heap type (process.ts's REF_EQ). */
const EQ_HEAP = -0x13;
const REF_EQ: ValType = { kind: "ref", nullable: true, typeIndex: EQ_HEAP };

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
  private watchTField: number | null = null;
  private watchTabTField: number | null = null;
  private watchGField: { tab: number; open: number } | null = null;
  private rlTField: number | null = null;
  private voidArrTField: number | null = null;
  private dEntTField: number | null = null;
  private eEntTField: number | null = null;
  private dArrTField: number | null = null;
  private eArrTField: number | null = null;
  private rlTabTField: number | null = null;
  private strArrTField: number | null = null;
  private inGField: {
    flowing: number;
    ended: number;
    reading: number;
    waiter: number;
    dl: number;
    dn: number;
    el: number;
    en: number;
    rlTab: number;
    rlNext: number;
  } | null = null;

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

  /* ── fs.watch (G3) ─────────────────────────────────────────────────── */

  /** type:fsWatcher — the module's own FSWatcher. */
  watcherType(): number {
    this.watchTField ??= this.mb.structType([
      { storage: I32, mutable: true },
      { storage: REF_EQ, mutable: false },
      { storage: I32, mutable: false },
    ]);
    return this.watchTField;
  }

  watcherRef(): ValType {
    return this.ref(this.watcherType());
  }

  private get watchTabT(): number {
    this.watchTabTField ??= this.mb.arrayType(this.watcherRef(), true);
    return this.watchTabTField;
  }

  private wg(): { tab: number; open: number } {
    if (this.watchGField === null) {
      const tabT = this.watchTabT;
      this.watchGField = {
        tab: this.mb.addGlobal(this.ref(tabT), true, (w) => {
          w.u8(0xd0);
          w.sleb(tabT);
        }),
        open: this.mb.addGlobal(I32, true, (w) => {
          w.u8(0x41);
          w.sleb(0);
        }),
      };
    }
    return this.watchGField;
  }

  /** `%w.hev.watch(path, cb: eq, shape) -> watcher` — fs.watch: the start,
   * then the watcher in the handle table. A failed start leaves the pending
   * cell set and answers null (the caller's pending check unwinds). */
  watchHelper(): number {
    return this.fn("watch", [this.deps.strRef(), REF_EQ, I32], [this.watcherRef()], (f) => {
      const c = f.c;
      const PATH = 0;
      const CB = 1;
      const SHAPE = 2;
      const H = f.local(I32);
      const W = f.local(this.watcherRef());
      const NT = f.local(this.ref(this.watchTabT));
      const g = this.wg();
      c.localGet(PATH);
      c.call(this.deps.watchStart());
      c.localTee(H);
      c.i32Const(0);
      c.i32LtS();
      c.ifVoid();
      c.refNull(this.watcherType());
      c.return_();
      c.end();
      // A start answers a handle >= 1 or a failure.
      this.if_(c, () => {
        c.localGet(H);
        c.i32Eqz();
      }, () => this.trap(c));
      c.localGet(H);
      c.localGet(CB);
      c.localGet(SHAPE);
      c.structNew(this.watcherType());
      c.localSet(W);
      // The table, grown by copy to hold the handle.
      this.if_(c, () => {
        c.globalGet(g.tab);
        c.refIsNull();
      }, () => {
        c.i32Const(8);
        c.arrayNewDefault(this.watchTabT);
        c.globalSet(g.tab);
      });
      this.while_(c, () => {
        c.localGet(H);
        c.globalGet(g.tab);
        c.arrayLen();
        c.i32GeU();
      }, () => {
        c.globalGet(g.tab);
        c.arrayLen();
        c.i32Const(1);
        c.i32Shl();
        c.arrayNewDefault(this.watchTabT);
        c.localSet(NT);
        c.localGet(NT);
        c.i32Const(0);
        c.globalGet(g.tab);
        c.i32Const(0);
        c.globalGet(g.tab);
        c.arrayLen();
        c.arrayCopy(this.watchTabT, this.watchTabT);
        c.localGet(NT);
        c.globalSet(g.tab);
      });
      c.globalGet(g.tab);
      c.localGet(H);
      c.localGet(W);
      c.arraySet(this.watchTabT);
      c.globalGet(g.open);
      c.i32Const(1);
      c.i32Add();
      c.globalSet(g.open);
      c.localGet(W);
    });
  }

  /** `%w.hev.watchClose(watcher)` — FSWatcher.close: the watch stops once;
   * a closed watcher's close is a no-op. */
  watchCloseHelper(): number {
    return this.fn("watchClose", [this.watcherRef()], [], (f) => {
      const c = f.c;
      const W = 0;
      const H = f.local(I32);
      const g = this.wg();
      c.localGet(W);
      c.structGet(this.watcherType(), W_HANDLE);
      c.localTee(H);
      c.i32Eqz();
      c.ifVoid();
      c.return_();
      c.end();
      c.i32Const(WATCH_STOP);
      c.i32Const(0);
      c.i32Const(0);
      c.localGet(H);
      c.call(this.deps.watchCallFunc());
      // STOP answers 0; anything else is a host failure.
      c.ifVoid();
      this.trap(c);
      c.end();
      c.localGet(W);
      c.i32Const(0);
      c.structSet(this.watcherType(), W_HANDLE);
      c.globalGet(g.tab);
      c.localGet(H);
      c.refNull(this.watcherType());
      c.arraySet(this.watchTabT);
      c.globalGet(g.open);
      c.i32Const(1);
      c.i32Sub();
      c.globalSet(g.open);
    });
  }

  /** `%w.hev.watchEvent(base, kind, plen)` — one source-4 record: the
   * handle's watcher (a record for a handle the module does not hold is a
   * host failure — the host drops a handle's records at STOP), then the
   * event or the error. */
  private watchEventHelper(): number {
    return this.fn("watchEvent", [I32, I32, I32], [], (f) => {
      const c = f.c;
      const BASE = 0;
      const KIND = 1;
      const PLEN = 2;
      const H = f.local(I32);
      const A = f.local(I32);
      const W = f.local(this.watcherRef());
      const NAME = f.local(this.deps.strRef());
      const I = f.local(I32);
      const CB = f.local(REF_EQ);
      const g = this.wg();
      this.loadU32(c, BASE, 4);
      c.localSet(H);
      this.loadU32(c, BASE, 16);
      c.localSet(A);
      this.if_(c, () => {
        c.globalGet(g.tab);
        c.refIsNull();
        c.localGet(H);
        c.i32Eqz();
        c.i32Or();
        this.loadU32(c, BASE, 20);
        c.i32Or();
        c.localGet(PLEN);
        c.i32Const(1);
        c.i32And();
        c.i32Or();
      }, () => this.trap(c));
      this.if_(c, () => {
        c.localGet(H);
        c.globalGet(g.tab);
        c.arrayLen();
        c.i32GeU();
      }, () => this.trap(c));
      c.globalGet(g.tab);
      c.localGet(H);
      c.arrayGet(this.watchTabT);
      c.localTee(W);
      c.refIsNull();
      c.ifVoid();
      this.trap(c);
      c.end();
      this.if_(c, () => {
        c.localGet(KIND);
        c.i32Const(WATCH_EV_ERROR);
        c.i32Eq();
      }, () => {
        // The filename (UTF-16 code units), null when the event had none.
        this.if_(c, () => c.localGet(PLEN), () => {
          c.localGet(PLEN);
          c.i32Const(1);
          c.i32ShrU();
          c.arrayNewDefault(this.deps.strType());
          c.localSet(NAME);
          this.while_(c, () => {
            c.localGet(I);
            c.localGet(PLEN);
            c.i32Const(1);
            c.i32ShrU();
            c.i32LtU();
          }, () => {
            c.localGet(NAME);
            c.localGet(I);
            c.localGet(BASE);
            c.i32Const(EV_HEADER_BYTES);
            c.i32Add();
            c.localGet(I);
            c.i32Const(1);
            c.i32Shl();
            c.i32Add();
            c.i32Load16U();
            c.arraySet(this.deps.strType());
            c.localGet(I);
            c.i32Const(1);
            c.i32Add();
            c.localSet(I);
          });
        });
        // A failure status (the carrier); the handle closes, then 'error'.
        this.if_(c, () => {
          c.localGet(A);
          c.i32Const(0);
          c.i32GeS();
        }, () => this.trap(c));
        c.localGet(W);
        c.call(this.watchCloseHelper());
        c.localGet(A);
        c.localGet(NAME);
        c.call(this.deps.watchError());
        c.call(this.deps.reportUncaught());
        c.return_();
      });
      this.if_(c, () => {
        c.localGet(KIND);
        c.i32Const(WATCH_EV_CHANGE);
        c.i32Ne();
        c.localGet(A);
        c.i32Const(UV_RENAME | UV_CHANGE);
        c.i32And();
        c.i32Eqz();
        c.i32Or();
      }, () => this.trap(c));
      c.localGet(W);
      c.structGet(this.watcherType(), W_CB);
      c.localSet(CB);
      // emit('change', eventType, filename): the one listener, if any.
      this.if_(c, () => {
        c.localGet(W);
        c.structGet(this.watcherType(), W_SHAPE);
        c.i32Const(1);
        c.i32Eq();
      }, () => {
        const pair = this.deps.voidClos();
        c.localGet(CB);
        c.refCast(pair.clos);
        c.localGet(CB);
        c.refCast(pair.clos);
        c.structGet(pair.clos, 0);
        c.callRef(pair.fn);
        this.deathCheck(c);
      });
      this.if_(c, () => {
        c.localGet(W);
        c.structGet(this.watcherType(), W_SHAPE);
        c.i32Const(2);
        c.i32Eq();
      }, () => {
        const pair = this.deps.strClos();
        this.if_(c, () => {
          c.localGet(A);
          c.i32Const(UV_RENAME);
          c.i32And();
        }, () => {
          this.deps.pushStrLit(c, "rename");
          c.localSet(NAME);
        }, () => {
          this.deps.pushStrLit(c, "change");
          c.localSet(NAME);
        });
        c.localGet(CB);
        c.refCast(pair.clos);
        c.localGet(NAME);
        c.localGet(CB);
        c.refCast(pair.clos);
        c.structGet(pair.clos, 0);
        c.callRef(pair.fn);
        this.deathCheck(c);
      });
      this.deps.checkpoint(c);
    });
  }

  /* ── stdin and readline (G2) ───────────────────────────────────────── */

  private get dataRef(): ValType {
    return this.ref(this.deps.dataClos().clos);
  }

  private get bytesRef(): ValType {
    return this.ref(this.deps.bytesType());
  }

  private get strRef(): ValType {
    return this.deps.strRef();
  }

  private get voidArrT(): number {
    this.voidArrTField ??= this.mb.arrayType(this.voidRef, true);
    return this.voidArrTField;
  }

  /** The readline Interface struct. */
  private get rlT(): number {
    this.rlTField ??= this.mb.structType([
      { storage: I32, mutable: true },
      { storage: I32, mutable: true },
      { storage: this.strRef, mutable: true },
      { storage: this.strRef, mutable: true },
      { storage: REF_EQ, mutable: true },
      { storage: I32, mutable: true },
      { storage: this.strRef, mutable: true },
      { storage: I32, mutable: true },
      { storage: F64, mutable: true },
      { storage: this.ref(this.voidArrT), mutable: true },
      { storage: I32, mutable: true },
      { storage: I32, mutable: false },
      { storage: F64, mutable: false },
      { storage: F64, mutable: true },
    ]);
    return this.rlTField;
  }

  private get rlRef(): ValType {
    return this.ref(this.rlT);
  }

  private get dEntT(): number {
    this.dEntTField ??= this.mb.structType([
      { storage: this.dataRef, mutable: false },
      { storage: this.rlRef, mutable: false },
      { storage: I32, mutable: false },
      { storage: I32, mutable: true },
    ]);
    return this.dEntTField;
  }

  private get eEntT(): number {
    this.eEntTField ??= this.mb.structType([
      { storage: this.voidRef, mutable: false },
      { storage: this.rlRef, mutable: false },
      { storage: I32, mutable: false },
      { storage: I32, mutable: true },
    ]);
    return this.eEntTField;
  }

  private get dArrT(): number {
    this.dArrTField ??= this.mb.arrayType(this.ref(this.dEntT), true);
    return this.dArrTField;
  }

  private get eArrT(): number {
    this.eArrTField ??= this.mb.arrayType(this.ref(this.eEntT), true);
    return this.eArrTField;
  }

  private get rlTabT(): number {
    this.rlTabTField ??= this.mb.arrayType(this.rlRef, true);
    return this.rlTabTField;
  }

  private get strArrT(): number {
    this.strArrTField ??= this.mb.arrayType(this.strRef, true);
    return this.strArrTField;
  }

  private ig(): NonNullable<HostEvBuilder["inGField"]> {
    if (this.inGField === null) {
      const i32 = (v: number): number =>
        this.mb.addGlobal(I32, true, (w) => {
          w.u8(0x41);
          w.sleb(v);
        });
      const nul = (t: number): number =>
        this.mb.addGlobal(this.ref(t), true, (w) => {
          w.u8(0xd0);
          w.sleb(t);
        });
      const promRef = this.deps.promRef();
      if (promRef.kind !== "ref") throw new Error("emitter bug: the promise type is not a reference");
      this.inGField = {
        flowing: i32(FLOW_NULL),
        ended: i32(0),
        reading: i32(0),
        waiter: nul(promRef.typeIndex),
        dl: nul(this.dArrT),
        dn: i32(0),
        el: nul(this.eArrT),
        en: i32(0),
        rlTab: nul(this.rlTabT),
        rlNext: i32(1),
      };
    }
    return this.inGField;
  }

  /** Append the element `push` leaves on the stack to the array held in
   * global `listG` (count in global `nG`), grown by copy. */
  private emitAppendG(c: Code, f: Fn, arrT: number, listG: number, nG: number, push: () => void): void {
    const NL = f.local(this.ref(arrT));
    this.if_(c, () => {
      c.globalGet(listG);
      c.refIsNull();
    }, () => {
      c.i32Const(4);
      c.arrayNewDefault(arrT);
      c.globalSet(listG);
    });
    this.if_(c, () => {
      c.globalGet(nG);
      c.globalGet(listG);
      c.arrayLen();
      c.i32GeU();
    }, () => {
      c.globalGet(nG);
      c.i32Const(1);
      c.i32Shl();
      c.i32Const(4);
      c.i32Add();
      c.arrayNewDefault(arrT);
      c.localSet(NL);
      c.localGet(NL);
      c.i32Const(0);
      c.globalGet(listG);
      c.i32Const(0);
      c.globalGet(nG);
      c.arrayCopy(arrT, arrT);
      c.localGet(NL);
      c.globalSet(listG);
    });
    c.globalGet(listG);
    c.globalGet(nG);
    push();
    c.arraySet(arrT);
    c.globalGet(nG);
    c.i32Const(1);
    c.i32Add();
    c.globalSet(nG);
  }

  /** `%w.hev.<name>(i)` — splice index i out of the global-held array. */
  private removeAtG(name: string, arrT: number, elemT: number, listG: number, nG: number): number {
    return this.fn(name, [I32], [], (f) => {
      const c = f.c;
      const I = 0;
      const N = f.local(I32);
      c.globalGet(nG);
      c.i32Const(1);
      c.i32Sub();
      c.localSet(N);
      this.if_(c, () => {
        c.localGet(I);
        c.localGet(N);
        c.i32LtS();
      }, () => {
        c.globalGet(listG);
        c.localGet(I);
        c.globalGet(listG);
        c.localGet(I);
        c.i32Const(1);
        c.i32Add();
        c.localGet(N);
        c.localGet(I);
        c.i32Sub();
        c.arrayCopy(arrT, arrT);
      });
      c.globalGet(listG);
      c.localGet(N);
      c.refNull(elemT);
      c.arraySet(arrT);
      c.localGet(N);
      c.globalSet(nG);
    });
  }

  private dRemoveAt(): number {
    const g = this.ig();
    return this.removeAtG("stdinDataRemoveAt", this.dArrT, this.dEntT, g.dl, g.dn);
  }

  private eRemoveAt(): number {
    const g = this.ig();
    return this.removeAtG("stdinEndRemoveAt", this.eArrT, this.eEntT, g.el, g.en);
  }

  /** Remove entry `ent` (by identity, from the end) from the global-held
   * list; a no-op when it is gone already. */
  private emitRemoveEntry(c: Code, f: Fn, arrT: number, listG: number, nG: number, ent: number, removeAt: number): void {
    const J = f.local(I32);
    c.globalGet(nG);
    c.i32Const(1);
    c.i32Sub();
    c.localSet(J);
    c.block();
    c.loop();
    c.localGet(J);
    c.i32Const(0);
    c.i32LtS();
    c.brIf(1);
    c.globalGet(listG);
    c.localGet(J);
    c.arrayGet(arrT);
    c.localGet(ent);
    c.refEq();
    c.ifVoid();
    c.localGet(J);
    c.call(removeAt);
    c.br(2);
    c.end();
    c.localGet(J);
    c.i32Const(1);
    c.i32Sub();
    c.localSet(J);
    c.br(0);
    c.end();
    c.end();
  }

  /** `%w.hev.stdinSync()` — read while not ended and (flowing, or a chunk
   * promise is parked); start or stop the host's read to match. */
  private stdinSyncHelper(): number {
    return this.fn("stdinSync", [], [], (f) => {
      const c = f.c;
      const WANT = f.local(I32);
      const g = this.ig();
      c.globalGet(g.ended);
      c.i32Eqz();
      c.globalGet(g.flowing);
      c.i32Const(FLOW_ON);
      c.i32Eq();
      c.globalGet(g.waiter);
      c.refIsNull();
      c.i32Eqz();
      c.i32Or();
      c.i32And();
      c.localSet(WANT);
      this.if_(c, () => {
        c.localGet(WANT);
        c.globalGet(g.reading);
        c.i32Eqz();
        c.i32And();
      }, () => {
        c.i32Const(STDIN_READ_START);
        c.call(this.deps.stdinCallFunc());
        c.ifVoid();
        this.deps.namedTrap(c, STDIN_START_FAILED);
        c.end();
        c.i32Const(1);
        c.globalSet(g.reading);
      });
      this.if_(c, () => {
        c.localGet(WANT);
        c.i32Eqz();
        c.globalGet(g.reading);
        c.i32And();
      }, () => {
        c.i32Const(STDIN_READ_STOP);
        c.call(this.deps.stdinCallFunc());
        c.ifVoid();
        this.trap(c);
        c.end();
        c.i32Const(0);
        c.globalSet(g.reading);
      });
    });
  }

  /** `%w.hev.stdinOnData(cb, once)` — process.stdin.on / once('data'): a
   * listener resumes a stream not explicitly paused. */
  stdinOnDataHelper(): number {
    return this.fn("stdinOnData", [this.dataRef, I32], [], (f) => {
      const c = f.c;
      const CB = 0;
      const ONCE = 1;
      const g = this.ig();
      // After 'end' a listener never runs.
      c.globalGet(g.ended);
      c.ifVoid();
      c.return_();
      c.end();
      this.emitAppendG(c, f, this.dArrT, g.dl, g.dn, () => {
        c.localGet(CB);
        c.refNull(this.rlT);
        c.localGet(ONCE);
        c.i32Const(0);
        c.structNew(this.dEntT);
      });
      this.if_(c, () => {
        c.globalGet(g.flowing);
        c.i32Const(FLOW_OFF);
        c.i32Ne();
      }, () => {
        c.i32Const(FLOW_ON);
        c.globalSet(g.flowing);
      });
      c.call(this.stdinSyncHelper());
    });
  }

  /** `%w.hev.stdinOnEnd(cb, once)` — process.stdin.on / once('end'). */
  stdinOnEndHelper(): number {
    return this.fn("stdinOnEnd", [this.voidRef, I32], [], (f) => {
      const c = f.c;
      const CB = 0;
      const ONCE = 1;
      const g = this.ig();
      c.globalGet(g.ended);
      c.ifVoid();
      c.return_();
      c.end();
      this.emitAppendG(c, f, this.eArrT, g.el, g.en, () => {
        c.localGet(CB);
        c.refNull(this.rlT);
        c.localGet(ONCE);
        c.i32Const(0);
        c.structNew(this.eEntT);
      });
    });
  }

  /** Push a fresh empty bytes value (the done sentinel). */
  private emitEmptyBytes(c: Code): void {
    c.i32Const(0);
    c.arrayNewDefault(this.deps.bufType());
    c.i32Const(0);
    c.i32Const(0);
    c.structNew(this.deps.bytesType());
  }

  /** Fulfil promise local `p` with the bytes `push` leaves on the stack. */
  private emitFulfil(c: Code, p: number, push: () => void): void {
    c.localGet(p);
    c.i32Const(this.deps.excObjKind);
    c.f64Const(0);
    push();
    c.i32Const(0);
    c.i32Const(1);
    c.call(this.deps.promSettle());
  }

  /** `%w.hev.stdinNextChunk() -> promise` — the for-await chunk source:
   * the next chunk, or the empty done sentinel once stdin has ended. */
  stdinNextChunkHelper(): number {
    return this.fn("stdinNextChunk", [], [this.deps.promRef()], (f) => {
      const c = f.c;
      const P = f.local(this.deps.promRef());
      const g = this.ig();
      c.call(this.deps.promMint());
      c.localSet(P);
      this.if_(c, () => c.globalGet(g.ended), () => {
        this.emitFulfil(c, P, () => this.emitEmptyBytes(c));
        c.localGet(P);
        c.return_();
      });
      this.if_(c, () => {
        c.globalGet(g.waiter);
        c.refIsNull();
        c.i32Eqz();
      }, () => {
        c.globalGet(g.waiter);
        c.return_();
      });
      c.localGet(P);
      c.globalSet(g.waiter);
      c.call(this.stdinSyncHelper());
      c.localGet(P);
    });
  }

  /** `%w.hev.rlGet(id) -> rl` */
  private rlGetHelper(): number {
    return this.fn("rlGet", [F64], [this.rlRef], (f) => {
      const c = f.c;
      const ID = 0;
      const I = f.local(I32);
      const R = f.local(this.rlRef);
      const g = this.ig();
      c.localGet(ID);
      c.i32TruncF64S();
      c.localSet(I);
      // Interface handles come from rl.create alone.
      this.if_(c, () => {
        c.globalGet(g.rlTab);
        c.refIsNull();
        c.localGet(I);
        c.i32Const(1);
        c.i32LtS();
        c.i32Or();
      }, () => c.unreachable());
      this.if_(c, () => {
        c.localGet(I);
        c.globalGet(g.rlTab);
        c.arrayLen();
        c.i32GeU();
      }, () => c.unreachable());
      c.globalGet(g.rlTab);
      c.localGet(I);
      c.arrayGet(this.rlTabT);
      c.localTee(R);
      c.refIsNull();
      c.ifVoid();
      c.unreachable();
      c.end();
      c.localGet(R);
    });
  }

  /** `%w.hev.rlCreate() -> id` — readline.createInterface({ input:
   * process.stdin, output: process.stdout }): the interface's own 'data'
   * and 'end' listeners (none once stdin has ended — nothing would ever
   * call them), then input.resume(). */
  rlCreateHelper(): number {
    return this.fn("rlCreate", [I32, F64], [F64], (f) => {
      const c = f.c;
      const HASOUT = 0;
      const DELAY = 1;
      const R = f.local(this.rlRef);
      const ID = f.local(I32);
      const NT = f.local(this.ref(this.rlTabT));
      const g = this.ig();
      c.i32Const(0);
      c.i32Const(0);
      this.deps.pushStrLit(c, "> ");
      this.deps.pushStrLit(c, "> ");
      c.refNull(EQ_HEAP);
      c.i32Const(0);
      c.refNull(this.deps.strType());
      c.i32Const(0);
      c.f64Const(0);
      c.refNull(this.voidArrT);
      c.i32Const(0);
      c.localGet(HASOUT);
      // crlfDelay ? max(kMincrlfDelay, crlfDelay) : kMincrlfDelay (100);
      // 0 and NaN are falsy.
      c.localGet(DELAY);
      c.f64Const(0);
      c.f64Ne();
      c.localGet(DELAY);
      c.localGet(DELAY);
      c.f64Eq();
      c.i32And();
      c.ifResult(F64);
      c.localGet(DELAY);
      c.f64Const(100);
      c.f64Max();
      c.else_();
      c.f64Const(100);
      c.end();
      c.f64Const(0);
      c.structNew(this.rlT);
      c.localSet(R);
      c.globalGet(g.rlNext);
      c.localTee(ID);
      c.i32Const(1);
      c.i32Add();
      c.globalSet(g.rlNext);
      this.if_(c, () => {
        c.globalGet(g.rlTab);
        c.refIsNull();
      }, () => {
        c.i32Const(4);
        c.arrayNewDefault(this.rlTabT);
        c.globalSet(g.rlTab);
      });
      this.while_(c, () => {
        c.localGet(ID);
        c.globalGet(g.rlTab);
        c.arrayLen();
        c.i32GeU();
      }, () => {
        c.globalGet(g.rlTab);
        c.arrayLen();
        c.i32Const(1);
        c.i32Shl();
        c.arrayNewDefault(this.rlTabT);
        c.localSet(NT);
        c.localGet(NT);
        c.i32Const(0);
        c.globalGet(g.rlTab);
        c.i32Const(0);
        c.globalGet(g.rlTab);
        c.arrayLen();
        c.arrayCopy(this.rlTabT, this.rlTabT);
        c.localGet(NT);
        c.globalSet(g.rlTab);
      });
      c.globalGet(g.rlTab);
      c.localGet(ID);
      c.localGet(R);
      c.arraySet(this.rlTabT);
      this.if_(c, () => {
        c.globalGet(g.ended);
        c.i32Eqz();
      }, () => {
        this.emitAppendG(c, f, this.dArrT, g.dl, g.dn, () => {
          c.refNull(this.deps.dataClos().clos);
          c.localGet(R);
          c.i32Const(0);
          c.i32Const(0);
          c.structNew(this.dEntT);
        });
        this.emitAppendG(c, f, this.eArrT, g.el, g.en, () => {
          c.refNull(this.deps.voidClos().clos);
          c.localGet(R);
          c.i32Const(0);
          c.i32Const(0);
          c.structNew(this.eEntT);
        });
      });
      // input.resume(): flowing whatever it was.
      c.i32Const(FLOW_ON);
      c.globalSet(g.flowing);
      c.call(this.stdinSyncHelper());
      c.localGet(ID);
      c.f64ConvertI32S();
    });
  }

  /** `%w.hev.rlQuestion(id, query, cb: eq, shape)` — Interface.question:
   * after close it throws (pending cell set); with a question pending it
   * re-writes the current prompt and drops `cb`; else the query becomes the
   * prompt (the old one kept) and is written. */
  rlQuestionHelper(): number {
    return this.fn("rlQuestion", [F64, this.strRef, REF_EQ, I32], [], (f) => {
      const c = f.c;
      const ID = 0;
      const Q = 1;
      const CB = 2;
      const SHAPE = 3;
      const R = f.local(this.rlRef);
      c.localGet(ID);
      c.call(this.rlGetHelper());
      c.localSet(R);
      this.if_(c, () => {
        c.localGet(R);
        c.structGet(this.rlT, R_CLOSED);
      }, () => {
        this.deps.throwCoded(
          c,
          "%Error",
          "Error",
          (cc) => this.deps.pushStrLit(cc, "readline was closed"),
          (cc) => this.deps.pushStrLit(cc, "ERR_USE_AFTER_CLOSE"),
        );
        c.return_();
      });
      this.if_(c, () => {
        c.localGet(R);
        c.structGet(this.rlT, R_QCB);
        c.refIsNull();
        c.i32Eqz();
      }, () => {
        // prompt(): kWriteToOutput writes only to an output stream.
        this.if_(c, () => {
          c.localGet(R);
          c.structGet(this.rlT, R_HASOUT);
        }, () => {
          c.localGet(R);
          c.structGet(this.rlT, R_PROMPT);
          this.deps.writeStdout(c);
        });
        c.return_();
      });
      c.localGet(R);
      c.localGet(R);
      c.structGet(this.rlT, R_PROMPT);
      c.structSet(this.rlT, R_OLD);
      c.localGet(R);
      c.localGet(Q);
      c.structSet(this.rlT, R_PROMPT);
      c.localGet(R);
      c.localGet(CB);
      c.structSet(this.rlT, R_QCB);
      c.localGet(R);
      c.localGet(SHAPE);
      c.structSet(this.rlT, R_QSHAPE);
      this.if_(c, () => {
        c.localGet(R);
        c.structGet(this.rlT, R_HASOUT);
      }, () => {
        c.localGet(Q);
        this.deps.writeStdout(c);
      });
    });
  }

  /** `%w.hev.rlOnClose(id, cb)` — a 'close' listener; once the interface
   * has closed it never runs. */
  rlOnCloseHelper(): number {
    return this.fn("rlOnClose", [F64, this.voidRef], [], (f) => {
      const c = f.c;
      const ID = 0;
      const CB = 1;
      const R = f.local(this.rlRef);
      const L = f.local(this.ref(this.voidArrT));
      const N = f.local(I32);
      const NL = f.local(this.ref(this.voidArrT));
      c.localGet(ID);
      c.call(this.rlGetHelper());
      c.localTee(R);
      c.structGet(this.rlT, R_CLOSED);
      c.ifVoid();
      c.return_();
      c.end();
      c.localGet(R);
      c.structGet(this.rlT, R_CLOSEL);
      c.localSet(L);
      c.localGet(R);
      c.structGet(this.rlT, R_CLOSEN);
      c.localSet(N);
      this.if_(c, () => {
        c.localGet(L);
        c.refIsNull();
      }, () => {
        c.i32Const(2);
        c.arrayNewDefault(this.voidArrT);
        c.localSet(L);
      });
      this.if_(c, () => {
        c.localGet(N);
        c.localGet(L);
        c.arrayLen();
        c.i32GeU();
      }, () => {
        c.localGet(N);
        c.i32Const(1);
        c.i32Shl();
        c.arrayNewDefault(this.voidArrT);
        c.localSet(NL);
        c.localGet(NL);
        c.i32Const(0);
        c.localGet(L);
        c.i32Const(0);
        c.localGet(N);
        c.arrayCopy(this.voidArrT, this.voidArrT);
        c.localGet(NL);
        c.localSet(L);
      });
      c.localGet(L);
      c.localGet(N);
      c.localGet(CB);
      c.arraySet(this.voidArrT);
      c.localGet(R);
      c.localGet(L);
      c.structSet(this.rlT, R_CLOSEL);
      c.localGet(R);
      c.localGet(N);
      c.i32Const(1);
      c.i32Add();
      c.structSet(this.rlT, R_CLOSEN);
    });
  }

  /** `%w.hev.rlCloseRl(rl)` — Interface.close: input.pause() (once), the
   * closed flag, then 'close': the interface's own listener removes its
   * 'data' / 'end' entries, then the program's listeners in order. A
   * listener's throw stops the emission with the pending cell set. */
  private rlCloseRlHelper(): number {
    return this.fn("rlCloseRl", [this.rlRef], [], (f) => {
      const c = f.c;
      const R = 0;
      const I = f.local(I32);
      const L = f.local(this.ref(this.voidArrT));
      const N = f.local(I32);
      const CB = f.local(this.voidRef);
      const g = this.ig();
      c.localGet(R);
      c.structGet(this.rlT, R_CLOSED);
      c.ifVoid();
      c.return_();
      c.end();
      this.if_(c, () => {
        c.localGet(R);
        c.structGet(this.rlT, R_PAUSED);
        c.i32Eqz();
      }, () => {
        c.i32Const(FLOW_OFF);
        c.globalSet(g.flowing);
        c.localGet(R);
        c.i32Const(1);
        c.structSet(this.rlT, R_PAUSED);
        c.call(this.stdinSyncHelper());
      });
      c.localGet(R);
      c.i32Const(1);
      c.structSet(this.rlT, R_CLOSED);
      // onSelfCloseWithoutTerminal: the input's 'data' and 'end' entries go.
      for (const [listG, nG, arrT, entT, field, removeAt] of [
        [g.dl, g.dn, this.dArrT, this.dEntT, D_RL, this.dRemoveAt()],
        [g.el, g.en, this.eArrT, this.eEntT, D_RL, this.eRemoveAt()],
      ] as const) {
        c.globalGet(nG);
        c.i32Const(1);
        c.i32Sub();
        c.localSet(I);
        this.while_(c, () => {
          c.localGet(I);
          c.i32Const(0);
          c.i32GeS();
        }, () => {
          this.if_(c, () => {
            c.globalGet(listG);
            c.localGet(I);
            c.arrayGet(arrT);
            c.structGet(entT, field);
            c.localGet(R);
            c.refEq();
          }, () => {
            c.localGet(I);
            c.call(removeAt);
          });
          c.localGet(I);
          c.i32Const(1);
          c.i32Sub();
          c.localSet(I);
        });
      }
      // The program's 'close' listeners, as registered when it starts; they
      // never run again, so the list goes.
      c.localGet(R);
      c.structGet(this.rlT, R_CLOSEL);
      c.localSet(L);
      c.localGet(R);
      c.structGet(this.rlT, R_CLOSEN);
      c.localSet(N);
      c.localGet(R);
      c.refNull(this.voidArrT);
      c.structSet(this.rlT, R_CLOSEL);
      c.localGet(R);
      c.i32Const(0);
      c.structSet(this.rlT, R_CLOSEN);
      c.i32Const(0);
      c.localSet(I);
      this.while_(c, () => {
        c.localGet(I);
        c.localGet(N);
        c.i32LtS();
      }, () => {
        c.localGet(L);
        c.localGet(I);
        c.arrayGet(this.voidArrT);
        c.localSet(CB);
        this.callVoid(c, CB);
        c.globalGet(this.deps.excKind());
        c.ifVoid();
        c.return_();
        c.end();
        c.localGet(I);
        c.i32Const(1);
        c.i32Add();
        c.localSet(I);
      });
    });
  }

  /** `%w.hev.rlClose(id)` — the program's close(); the caller runs the
   * pending check (a 'close' listener's throw reaches it). */
  rlCloseHelper(): number {
    return this.fn("rlClose", [F64], [], (f) => {
      const c = f.c;
      c.localGet(0);
      c.call(this.rlGetHelper());
      c.call(this.rlCloseRlHelper());
    });
  }

  /** `%w.hev.sub(s, from, to) -> string` */
  private subHelper(): number {
    return this.fn("sub", [this.strRef, I32, I32], [this.strRef], (f) => {
      const c = f.c;
      const S = 0;
      const A = 1;
      const B = 2;
      const T = f.local(this.strRef);
      const strT = this.deps.strType();
      c.localGet(B);
      c.localGet(A);
      c.i32Sub();
      c.arrayNewDefault(strT);
      c.localSet(T);
      c.localGet(T);
      c.i32Const(0);
      c.localGet(S);
      c.localGet(A);
      c.localGet(B);
      c.localGet(A);
      c.i32Sub();
      c.arrayCopy(strT, strT);
      c.localGet(T);
    });
  }

  /** `%w.hev.rlLine(rl, line)` — kOnLine: the pending question's callback,
   * taken first (and the prompt restored), or nothing ('line' unheard). */
  private rlLineHelper(): number {
    return this.fn("rlLine", [this.rlRef, this.strRef], [], (f) => {
      const c = f.c;
      const R = 0;
      const LINE = 1;
      const CB = f.local(REF_EQ);
      const SHAPE = f.local(I32);
      c.localGet(R);
      c.structGet(this.rlT, R_QCB);
      c.localTee(CB);
      c.refIsNull();
      c.ifVoid();
      c.return_();
      c.end();
      c.localGet(R);
      c.structGet(this.rlT, R_QSHAPE);
      c.localSet(SHAPE);
      c.localGet(R);
      c.refNull(EQ_HEAP);
      c.structSet(this.rlT, R_QCB);
      c.localGet(R);
      c.localGet(R);
      c.structGet(this.rlT, R_OLD);
      c.structSet(this.rlT, R_PROMPT);
      this.if_(c, () => {
        c.localGet(SHAPE);
        c.i32Const(2);
        c.i32Eq();
      }, () => {
        const pair = this.deps.strClos();
        c.localGet(CB);
        c.refCast(pair.clos);
        c.localGet(LINE);
        c.localGet(CB);
        c.refCast(pair.clos);
        c.structGet(pair.clos, 0);
        c.callRef(pair.fn);
      }, () => {
        const pair = this.deps.voidClos();
        c.localGet(CB);
        c.refCast(pair.clos);
        c.localGet(CB);
        c.refCast(pair.clos);
        c.structGet(pair.clos, 0);
        c.callRef(pair.fn);
      });
    });
  }

  /** `%w.hev.rlWrite(rl, chunk)` — kNormalWrite: decode, the leading-\n
   * skip after a chunk-final \r, then every line the chunk completes
   * (found before any is dispatched), the remainder kept as the line
   * buffer. Stops at a throw (pending cell set). */
  private rlWriteHelper(): number {
    return this.fn("rlWrite", [this.rlRef, this.bytesRef], [], (f) => {
      const c = f.c;
      const R = 0;
      const CHUNK = 1;
      const S = f.local(this.strRef);
      const N = f.local(I32);
      const I = f.local(I32);
      const CH = f.local(I32);
      const FOUND = f.local(I32);
      const LINES = f.local(this.ref(this.strArrT));
      const LN = f.local(I32);
      const ST = f.local(I32);
      const LB = f.local(this.strRef);
      const K = f.local(I32);
      const strT = this.deps.strType();
      const sub = this.subHelper();
      const charAt = (idx: () => void): void => {
        c.localGet(S);
        idx();
        c.arrayGetU(strT);
      };
      // string = this[kDecoder].write(b)
      this.deps.pushStrLit(c, "utf8");
      c.localGet(R);
      c.structGet(this.rlT, R_DEC);
      c.localGet(CHUNK);
      c.call(this.deps.strdecWrite());
      c.localSet(S);
      c.localGet(R);
      this.deps.pushStrLit(c, "utf8");
      c.localGet(R);
      c.structGet(this.rlT, R_DEC);
      c.localGet(CHUNK);
      c.call(this.deps.strdecNext());
      c.structSet(this.rlT, R_DEC);
      c.localGet(S);
      c.arrayLen();
      c.localSet(N);
      // kSawReturnAt within crlfDelay (`DateNow() - kSawReturnAt <=
      // crlfDelay`, on the monotonic clock): a leading \n belongs to the
      // last chunk's \r. Outside the window the mark stays.
      this.if_(c, () => {
        c.localGet(R);
        c.structGet(this.rlT, R_SAWCR);
        c.call(this.deps.nowFunc());
        c.localGet(R);
        c.structGet(this.rlT, R_SAWAT);
        c.f64Sub();
        c.localGet(R);
        c.structGet(this.rlT, R_DELAY);
        c.f64Le();
        c.i32And();
      }, () => {
        this.if_(c, () => {
          c.localGet(N);
          c.i32Const(0);
          c.i32GtS();
        }, () => {
          this.if_(c, () => {
            charAt(() => c.i32Const(0));
            c.i32Const(10);
            c.i32Eq();
          }, () => {
            c.localGet(S);
            c.i32Const(1);
            c.localGet(N);
            c.call(sub);
            c.localSet(S);
            c.localGet(N);
            c.i32Const(1);
            c.i32Sub();
            c.localSet(N);
          });
        });
        c.localGet(R);
        c.i32Const(0);
        c.structSet(this.rlT, R_SAWCR);
      });
      // Does the new part hold a line ending?
      this.while_(c, () => {
        c.localGet(I);
        c.localGet(N);
        c.i32LtS();
        c.localGet(FOUND);
        c.i32Eqz();
        c.i32And();
      }, () => {
        charAt(() => c.localGet(I));
        c.localSet(CH);
        c.localGet(CH);
        c.i32Const(10);
        c.i32Eq();
        c.localGet(CH);
        c.i32Const(13);
        c.i32Eq();
        c.i32Or();
        c.localSet(FOUND);
        c.localGet(I);
        c.i32Const(1);
        c.i32Add();
        c.localSet(I);
      });
      // No ending: the line buffer grows.
      this.if_(c, () => {
        c.localGet(FOUND);
        c.i32Eqz();
      }, () => {
        this.if_(c, () => {
          c.localGet(N);
          c.i32Const(0);
          c.i32GtS();
        }, () => {
          c.localGet(R);
          c.structGet(this.rlT, R_LINE);
          c.localTee(LB);
          c.refIsNull();
          c.ifVoid();
          c.localGet(R);
          c.localGet(S);
          c.structSet(this.rlT, R_LINE);
          c.else_();
          c.localGet(R);
          c.localGet(LB);
          c.localGet(S);
          c.call(this.deps.concat());
          c.structSet(this.rlT, R_LINE);
          c.end();
        });
        c.return_();
      });
      // A non-empty line buffer joins the front.
      c.localGet(R);
      c.structGet(this.rlT, R_LINE);
      c.localSet(LB);
      this.if_(c, () => {
        c.localGet(LB);
        c.refIsNull();
        c.i32Eqz();
      }, () => {
        this.if_(c, () => {
          c.localGet(LB);
          c.arrayLen();
        }, () => {
          c.localGet(LB);
          c.localGet(S);
          c.call(this.deps.concat());
          c.localSet(S);
          c.localGet(S);
          c.arrayLen();
          c.localSet(N);
        });
      });
      c.localGet(R);
      c.refNull(strT);
      c.structSet(this.rlT, R_LINE);
      // kSawReturnAt = string.endsWith('\r')
      c.localGet(R);
      c.localGet(N);
      c.i32Const(0);
      c.i32GtS();
      c.ifResult(I32);
      charAt(() => {
        c.localGet(N);
        c.i32Const(1);
        c.i32Sub();
      });
      c.i32Const(13);
      c.i32Eq();
      c.else_();
      c.i32Const(0);
      c.end();
      c.structSet(this.rlT, R_SAWCR);
      c.localGet(R);
      c.call(this.deps.nowFunc());
      c.structSet(this.rlT, R_SAWAT);
      // Every line, /\r?\n|\r(?!\n)/g, before any is dispatched.
      c.localGet(N);
      c.i32Const(1);
      c.i32Add();
      c.arrayNewDefault(this.strArrT);
      c.localSet(LINES);
      c.i32Const(0);
      c.localSet(I);
      this.while_(c, () => {
        c.localGet(I);
        c.localGet(N);
        c.i32LtS();
      }, () => {
        charAt(() => c.localGet(I));
        c.localSet(CH);
        this.if_(c, () => {
          c.localGet(CH);
          c.i32Const(10);
          c.i32Eq();
          c.localGet(CH);
          c.i32Const(13);
          c.i32Eq();
          c.i32Or();
        }, () => {
          c.localGet(LINES);
          c.localGet(LN);
          c.localGet(S);
          c.localGet(ST);
          c.localGet(I);
          c.call(sub);
          c.arraySet(this.strArrT);
          c.localGet(LN);
          c.i32Const(1);
          c.i32Add();
          c.localSet(LN);
          // \r\n is one ending.
          this.if_(c, () => {
            c.localGet(CH);
            c.i32Const(13);
            c.i32Eq();
            c.localGet(I);
            c.i32Const(1);
            c.i32Add();
            c.localGet(N);
            c.i32LtS();
            c.i32And();
          }, () => {
            this.if_(c, () => {
              charAt(() => {
                c.localGet(I);
                c.i32Const(1);
                c.i32Add();
              });
              c.i32Const(10);
              c.i32Eq();
            }, () => {
              c.localGet(I);
              c.i32Const(1);
              c.i32Add();
              c.localSet(I);
            });
          });
          c.localGet(I);
          c.i32Const(1);
          c.i32Add();
          c.localSet(ST);
        });
        c.localGet(I);
        c.i32Const(1);
        c.i32Add();
        c.localSet(I);
      });
      // Either '' or the unfinished portion of the next line.
      c.localGet(R);
      c.localGet(S);
      c.localGet(ST);
      c.localGet(N);
      c.call(sub);
      c.structSet(this.rlT, R_LINE);
      this.while_(c, () => {
        c.localGet(K);
        c.localGet(LN);
        c.i32LtS();
      }, () => {
        c.localGet(R);
        c.localGet(LINES);
        c.localGet(K);
        c.arrayGet(this.strArrT);
        c.call(this.rlLineHelper());
        c.globalGet(this.deps.excKind());
        c.ifVoid();
        c.return_();
        c.end();
        c.localGet(K);
        c.i32Const(1);
        c.i32Add();
        c.localSet(K);
      });
    });
  }

  /** `%w.hev.stdinData(base, plen)` — a DATA record: flowing, the 'data'
   * emission over a copy of the list (a once entry leaves when reached; an
   * interface's entry is its ondata); not flowing, the parked chunk
   * promise. Then the read state, and one checkpoint. */
  private stdinDataHelper(): number {
    return this.fn("stdinData", [I32, I32], [], (f) => {
      const c = f.c;
      const BASE = 0;
      const PLEN = 1;
      const ARR = f.local(this.ref(this.deps.bufType()));
      const I = f.local(I32);
      const CHUNK = f.local(this.bytesRef);
      const SNAP = f.local(this.ref(this.dArrT));
      const N = f.local(I32);
      const E = f.local(this.ref(this.dEntT));
      const CB = f.local(this.dataRef);
      const P = f.local(this.deps.promRef());
      const g = this.ig();
      const bufT = this.deps.bufType();
      this.if_(c, () => c.globalGet(g.ended), () => this.trap(c));
      // The chunk, read out of the record before anything runs.
      c.localGet(PLEN);
      c.arrayNewDefault(bufT);
      c.localSet(ARR);
      this.while_(c, () => {
        c.localGet(I);
        c.localGet(PLEN);
        c.i32LtU();
      }, () => {
        c.localGet(ARR);
        c.localGet(I);
        c.localGet(BASE);
        c.i32Const(EV_HEADER_BYTES);
        c.i32Add();
        c.localGet(I);
        c.i32Add();
        c.i32Load8U();
        c.arraySet(bufT);
        c.localGet(I);
        c.i32Const(1);
        c.i32Add();
        c.localSet(I);
      });
      c.localGet(ARR);
      c.refAsNonNull();
      c.i32Const(0);
      c.localGet(PLEN);
      c.structNew(this.deps.bytesType());
      c.localSet(CHUNK);
      c.block();
      this.if_(c, () => {
        c.globalGet(g.flowing);
        c.i32Const(FLOW_ON);
        c.i32Eq();
      }, () => {
        c.globalGet(g.dn);
        c.localTee(N);
        c.arrayNewDefault(this.dArrT);
        c.localSet(SNAP);
        this.if_(c, () => c.localGet(N), () => {
          c.localGet(SNAP);
          c.i32Const(0);
          c.globalGet(g.dl);
          c.i32Const(0);
          c.localGet(N);
          c.arrayCopy(this.dArrT, this.dArrT);
        });
        c.i32Const(0);
        c.localSet(I);
        this.while_(c, () => {
          c.localGet(I);
          c.localGet(N);
          c.i32LtS();
        }, () => {
          c.localGet(SNAP);
          c.localGet(I);
          c.arrayGet(this.dArrT);
          c.localSet(E);
          c.block();
          this.if_(c, () => {
            c.localGet(E);
            c.structGet(this.dEntT, D_ONCE);
          }, () => {
            c.localGet(E);
            c.structGet(this.dEntT, D_FIRED);
            c.brIf(1);
            c.localGet(E);
            c.i32Const(1);
            c.structSet(this.dEntT, D_FIRED);
            this.emitRemoveEntry(c, f, this.dArrT, g.dl, g.dn, E, this.dRemoveAt());
          });
          this.if_(c, () => {
            c.localGet(E);
            c.structGet(this.dEntT, D_RL);
            c.refIsNull();
          }, () => {
            const pair = this.deps.dataClos();
            c.localGet(E);
            c.structGet(this.dEntT, D_CB);
            c.localTee(CB);
            c.localGet(CHUNK);
            c.localGet(CB);
            c.structGet(pair.clos, 0);
            c.callRef(pair.fn);
          }, () => {
            c.localGet(E);
            c.structGet(this.dEntT, D_RL);
            c.localGet(CHUNK);
            c.call(this.rlWriteHelper());
          });
          this.deathCheck(c);
          c.end();
          c.localGet(I);
          c.i32Const(1);
          c.i32Add();
          c.localSet(I);
        });
        c.br(1);
      });
      // Not flowing: the parked chunk promise takes it (the module reads
      // only for one; the host holds what it read after READ_STOP).
      c.globalGet(g.waiter);
      c.localTee(P);
      c.refIsNull();
      c.ifVoid();
      this.trap(c);
      c.end();
      c.refNull(this.promTypeIndex());
      c.globalSet(g.waiter);
      this.emitFulfil(c, P, () => c.localGet(CHUNK));
      c.end();
      c.call(this.stdinSyncHelper());
      this.deps.checkpoint(c);
    });
  }

  private promTypeIndex(): number {
    const t = this.deps.promRef();
    if (t.kind !== "ref") throw new Error("emitter bug: the promise type is not a reference");
    return t.typeIndex;
  }

  /** `%w.hev.stdinEof()` — the EOF record: ended, the 'end' emission over a
   * copy of the list (an interface's entry is its onend: close), the parked
   * chunk promise done, every listener dropped, one checkpoint. */
  private stdinEofHelper(): number {
    return this.fn("stdinEof", [], [], (f) => {
      const c = f.c;
      const SNAP = f.local(this.ref(this.eArrT));
      const N = f.local(I32);
      const I = f.local(I32);
      const E = f.local(this.ref(this.eEntT));
      const CB = f.local(this.voidRef);
      const P = f.local(this.deps.promRef());
      const g = this.ig();
      this.if_(c, () => c.globalGet(g.ended), () => this.trap(c));
      c.i32Const(1);
      c.globalSet(g.ended);
      c.i32Const(0);
      c.globalSet(g.reading);
      c.globalGet(g.en);
      c.localTee(N);
      c.arrayNewDefault(this.eArrT);
      c.localSet(SNAP);
      this.if_(c, () => c.localGet(N), () => {
        c.localGet(SNAP);
        c.i32Const(0);
        c.globalGet(g.el);
        c.i32Const(0);
        c.localGet(N);
        c.arrayCopy(this.eArrT, this.eArrT);
      });
      this.while_(c, () => {
        c.localGet(I);
        c.localGet(N);
        c.i32LtS();
      }, () => {
        c.localGet(SNAP);
        c.localGet(I);
        c.arrayGet(this.eArrT);
        c.localSet(E);
        c.block();
        this.if_(c, () => {
          c.localGet(E);
          c.structGet(this.eEntT, D_ONCE);
        }, () => {
          c.localGet(E);
          c.structGet(this.eEntT, D_FIRED);
          c.brIf(1);
          c.localGet(E);
          c.i32Const(1);
          c.structSet(this.eEntT, D_FIRED);
          this.emitRemoveEntry(c, f, this.eArrT, g.el, g.en, E, this.eRemoveAt());
        });
        this.if_(c, () => {
          c.localGet(E);
          c.structGet(this.eEntT, D_RL);
          c.refIsNull();
        }, () => {
          c.localGet(E);
          c.structGet(this.eEntT, D_CB);
          c.localSet(CB);
          this.callVoid(c, CB);
        }, () => {
          // onend: the partial line is emitted as a 'line' nothing hears,
          // then close().
          c.localGet(E);
          c.structGet(this.eEntT, D_RL);
          c.call(this.rlCloseRlHelper());
        });
        this.deathCheck(c);
        c.end();
        c.localGet(I);
        c.i32Const(1);
        c.i32Add();
        c.localSet(I);
      });
      this.if_(c, () => {
        c.globalGet(g.waiter);
        c.refIsNull();
        c.i32Eqz();
      }, () => {
        c.globalGet(g.waiter);
        c.localSet(P);
        c.refNull(this.promTypeIndex());
        c.globalSet(g.waiter);
        this.emitFulfil(c, P, () => this.emitEmptyBytes(c));
      });
      c.refNull(this.dArrT);
      c.globalSet(g.dl);
      c.i32Const(0);
      c.globalSet(g.dn);
      c.refNull(this.eArrT);
      c.globalSet(g.el);
      c.i32Const(0);
      c.globalSet(g.en);
      this.deps.checkpoint(c);
    });
  }

  /** `%w.hev.stdinEvent(kind, base, plen)` — one source-5 record. */
  private stdinEventHelper(): number {
    return this.fn("stdinEvent", [I32, I32, I32], [], (f) => {
      const c = f.c;
      const KIND = 0;
      const BASE = 1;
      const PLEN = 2;
      // handle 0 (fd 0's one stream), b = 0.
      this.if_(c, () => {
        this.loadU32(c, BASE, 4);
        this.loadU32(c, BASE, 20);
        c.i32Or();
      }, () => this.trap(c));
      c.block();
      this.if_(c, () => {
        c.localGet(KIND);
        c.i32Const(STDIN_EV_DATA);
        c.i32Eq();
      }, () => {
        c.localGet(BASE);
        c.localGet(PLEN);
        c.call(this.stdinDataHelper());
        c.br(1);
      });
      this.if_(c, () => {
        c.localGet(KIND);
        c.i32Const(STDIN_EV_EOF);
        c.i32Eq();
        c.localGet(PLEN);
        c.i32Eqz();
        c.i32And();
      }, () => {
        c.call(this.stdinEofHelper());
        c.br(1);
      });
      this.if_(c, () => {
        c.localGet(KIND);
        c.i32Const(STDIN_EV_ERROR);
        c.i32Eq();
      }, () => this.deps.namedTrap(c, STDIN_READ_ERROR));
      this.trap(c);
      c.end();
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
      if (this.deps.watch) {
        // Source 4: a watch EVENT or ERROR.
        this.if_(c, () => {
          c.localGet(SRC);
          c.i32Const(SRC_WATCH);
          c.i32Eq();
        }, () => {
          c.localGet(BASE);
          c.localGet(KIND);
          c.localGet(PLEN);
          c.call(this.watchEventHelper());
          c.br(1);
        });
      }
      if (this.deps.stdin) {
        // Source 5: stdin's DATA, EOF or READ_ERROR.
        this.if_(c, () => {
          c.localGet(SRC);
          c.i32Const(SRC_STDIN);
          c.i32Eq();
        }, () => {
          c.localGet(KIND);
          c.localGet(BASE);
          c.localGet(PLEN);
          c.call(this.stdinEventHelper());
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
   * Signals never do (Node unrefs the wrap); an open watcher does, and so
   * does stdin while it reads. */
  emitAlive(c: Code): void {
    let terms = 0;
    if (this.deps.watch) {
      c.globalGet(this.wg().open);
      terms++;
    }
    if (this.deps.stdin) {
      c.globalGet(this.ig().reading);
      if (terms > 0) c.i32Or();
      terms++;
    }
    if (terms === 0) c.i32Const(0);
  }
}
