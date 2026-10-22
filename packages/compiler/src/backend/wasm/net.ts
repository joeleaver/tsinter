/* INC-29 U1 — node:net (raw TCP) on the WasmGC tier: net.Server and
 * net.Socket built in the module from Node v24.18.1's own source, over one
 * OS-level host import (abi.ts, netCall) and the event queue every event
 * module already reads (abi.ts, evPoll).
 *
 * THE SPLIT. The host does what libuv's uv_tcp_* / uv_getaddrinfo do and
 * nothing else: bind and listen, connect, start and stop reading, write
 * bytes, shut down the write side, close, set TCP_NODELAY, resolve a name.
 * It answers with raw facts — a handle, an errno, a byte count, a
 * completion. Every Node behaviour lives HERE, transcribed function by
 * function from lib/net.js, lib/internal/stream_base_commons.js and the
 * Readable / Writable / Duplex / destroy machinery under
 * lib/internal/streams/ that a net.Socket runs on: the Readable and Writable
 * state bits are Node's own (kFlowing, kNeedReadable, kWriting, ...), the
 * functions carry Node's names, and every process.nextTick Node takes is a
 * nextTick here, on the same queue as the program's own.
 *
 * WHY NOT stream.ts. stream.ts's Duplex is a class-rooted struct
 * (%Readable / %Duplex in the IR's class graph), and a net.Socket is not:
 * the IR types it `netSocket`, and a program that uses only node:net has no
 * stream class in its module at all. A Socket also overrides a large part
 * of Duplex (_read, _write / _writev, _final, _destroy with emitClose
 * false, end, pause / resume, the 'end' listener that swaps write for
 * writeAfterFIN), so the machine below carries the Duplex subset a Socket
 * runs, as Node runs it, in a struct of its own.
 *
 * THE CLOSING PHASE. libuv runs a closed handle's close callback in the
 * loop's closing-handles phase, after the check phase; Node emits a
 * Socket's 'close' from that callback (closeSocketHandle), and a write or
 * shutdown still pending on the handle completes there first with
 * ECANCELED. The module keeps its own closing list and runs it from the
 * event loop (timers.ts, `closing`) at that point, the handle closed last
 * first (libuv's closing list is LIFO); the host's CLOSE needs no
 * completion.
 *
 * THE PENDING QUEUE. libuv completes a shutdown with an empty write queue
 * through uv__io_feed: the handle joins the loop's pending queue and
 * uv__drain runs in the next uv__run_pending pass — up to eight after the
 * poll phase, and one at the top of each iteration. The module keeps that
 * queue (`pending`) and the event loop runs its passes there, so 'finish'
 * lands before the check phase as in Node. It is the only pending-queue
 * user lib/net.js reaches on this tier ON LINUX: a write that finishes at
 * once is synchronous (Node's try-write), one that does not completes from
 * the poll phase (uv__stream_io runs the write callbacks itself), and a
 * non-blocking connect on Linux answers EINPROGRESS, so its outcome is a
 * poll-phase event too. A kernel that refuses a connect at once, and a
 * write uv_write2 finishes synchronously after a partial try-write, would
 * complete in a pending pass in Node and arrive here as poll-phase events
 * (abi.ts; SEMANTICS.md S087 (j)).
 *
 * SEMANTICS.md S087 registers where this tier and Node part. */
import { Code } from "./code.js";
import { F64, I32, ModuleBuilder, type ValType } from "./module.js";

const EQ_HEAP = -0x13;
const EQ_REF: ValType = { kind: "ref", nullable: true, typeIndex: EQ_HEAP };

export interface NetDeps {
  strRef: () => ValType;
  strType: () => number;
  netCallFunc: () => number;
  evPollFunc: () => number;
  ensureCapacity: (c: Code, need: () => void) => void;
  stageCursor: () => number;
  pushStrLit: (c: Code, value: string) => void;
  namedTrap: (c: Code, message: string) => void;
  concat: () => number;
  f64ToStr: () => number;
  /** childproc.ts: `(i32) -> string`, an errno carried as -(256 + n). */
  codeName: () => number;
  /** childproc.ts: `(s, ptr, cut) -> next`, one UTF-16 run. */
  stageRun: () => number;
  voidClos: () => { clos: number; fn: number };
  /** (errRef) => void — 'error' listeners and write / end callbacks. */
  errClos: () => { clos: number; fn: number };
  /** (bytesRef) => void — 'data' listeners. */
  dataClos: () => { clos: number; fn: number };
  /** (sockRef) => void — 'connection' listeners. */
  sockClos: () => { clos: number; fn: number };
  nextTickEnqueue: () => number;
  excKind: () => number;
  reportUncaught: () => number;
  checkpoint: (c: Code) => void;
  errType: () => number;
  /** Push a fresh error of builtin class `className` ("%Error",
   * "%TypeError", "%RangeError") with the given name, message and code. */
  newError: (c: Code, className: string, name: string, pushMessage: (c: Code) => void, pushCode: (c: Code) => void) => void;
  /** Throw the error value on top of the stack (fills the pending cell). */
  throwStack: (c: Code) => void;
  bytesType: () => number;
  bufType: () => number;
  /** `(string) -> bytes`, Buffer.from(s, "utf8"). */
  strToBytes: () => number;
  /** `(f64) -> string`, Node's ERR_OUT_OF_RANGE "Received" rendering. */
  numReceived: () => number;
  /** `(string) -> string`, util.inspect of a string. */
  inspectStr: () => number;
  /** The checked-dynamic value's ref type. */
  dynRef: () => ValType;
  /** `(dyn | null) -> i32`: connect's autoSelectFamilyAttemptTimeout
   * validation (null = absent); 0 with the error pending. */
  attemptCheck: () => number;
  /** INC-29 U2: present only in a module that uses node:http (http.ts).
   * Every http-only field, list and behaviour below is gated on it, so a
   * module without node:http keeps U1's bytes. */
  http?: NetHttpHooks;
  /** INC-29 U4: present only in a module that reaches node:tls or
   * node:https (tls.ts). Every TLS-only field and list below is gated on
   * it, so a module without TLS keeps U2's bytes. */
  tls?: NetTlsHooks;
  /** INC-29 U4: present only in a module that reaches node:dgram
   * (dgram.ts): the handle table also holds its UDP sockets. */
  dgram?: NetDgramHooks;
}

/** INC-29 U4: what a TLS module adds to its sockets' events. */
export interface NetTlsHooks {
  /** `(sock, kind, a, ptr, len)`: a SECURE or TLS_ERROR event (abi.ts
   * tlsCall) on a socket the module secured. */
  event: () => number;
  /** `(sock, bytes) -> i32`: 1 when the socket is a TLS socket whose
   * handshake the module has not accepted yet — the bytes are held there
   * (no application data reaches the host before the module's verdict). */
  hold: () => number;
}

/** INC-29 U4: a dgram module's UDP sockets in the shared handle table. */
export interface NetDgramHooks {
  /** The UDP socket struct type (dgram.ts). */
  type: () => number;
  /** `(udp, kind, a, ptr, len)`: an event on a UDP handle. */
  event: () => number;
  /** `(udp) -> i32`: the UDP socket holds the loop. */
  alive: () => number;
}

/** INC-29 U2: what an http module adds to its sockets and servers. */
export interface NetHttpHooks {
  /** `(sock, bytes)`: Parser::OnStreamRead — the http parser that
   * consumed this socket's handle reads the data (http.ts). */
  consumedRead: () => number;
  /** `(srv)`: httpServerPreClose, run by an http server's close. */
  preClose: () => number;
  /** timers.ts: `(clos, ms) -> id` (a one-shot with a handle). */
  setTimeoutHandle: () => number;
  /** timers.ts: `(id)` clearTimeout. */
  clearTimer: () => number;
  /** timers.ts: `(id) -> id` refresh(). */
  refreshTimer: () => number;
  /** timers.ts: `(id) -> id` unref(). */
  unrefTimer: () => number;
}

/* netCall's ops (abi.ts). */
const OP_LISTEN = 1;
const OP_CONNECT = 2;
const OP_READ_START = 3;
const OP_READ_STOP = 4;
const OP_WRITE = 5;
const OP_SHUTDOWN = 6;
const OP_CLOSE = 7;
const OP_NODELAY = 8;
const OP_RESOLVE = 9;

/* evPoll's net kinds (abi.ts; source 2). */
const SRC_NET = 2;
const EV_ACCEPT = 1;
const EV_CONNECT = 2;
const EV_DATA = 3;
const EV_EOF = 4;
const EV_READ_ERROR = 5;
const EV_WRITE_DONE = 6;
// 7 was SHUTDOWN_DONE: retired, a shutdown completes in the pending pass.
const EV_RESOLVE_DONE = 8;
const EV_ACCEPT_ERROR = 9;
/* INC-29 U4 (abi.ts tlsCall): the TLS kinds on a secured socket. */
export const EV_SECURE = 10;
export const EV_TLS_ERROR = 11;

const EV_HEADER_BYTES = 24;
const EV_FIRST_CAPACITY = 1024;
const HOST_FAILURE = "netCall: host failure";

const UV_ECANCELED = -125;
const UV_ENOTCONN = -107;

/* Node's getDefaultHighWaterMark(false) on v24.18.1. */
const HWM = 65536;

/* ── the Readable state bits (lib/internal/streams/readable.js's own
 * names; only the ones a Socket can reach — objectMode, a decoder, and
 * 'readable' listeners have no lowering). ───────────────────────────── */
const kFlowing = 1 << 0;
const kHasFlowing = 1 << 1;
const kPaused = 1 << 2;
const kHasPaused = 1 << 3;
const kReading = 1 << 4;
const kSync = 1 << 5;
const kEnded = 1 << 6;
const kEndEmitted = 1 << 7;
const kNeedReadable = 1 << 8;
const kEmittedReadable = 1 << 9;
const kReadingMore = 1 << 10;
const kResumeScheduled = 1 << 11;
const kDataListening = 1 << 12;
const kDestroyed = 1 << 13;
const kErrored = 1 << 14;
const kErrorEmitted = 1 << 15;
const kCloseEmitted = 1 << 16;
const kClosed = 1 << 17;

/* ── the Writable state bits (writable.js's names). kDestroyed, kErrored,
 * kErrorEmitted, kCloseEmitted and kClosed share the Readable values. ── */
const wEnding = 1 << 0;
const wEnded = 1 << 1;
const wFinished = 1 << 2;
const wWriting = 1 << 3;
const wSync = 1 << 4;
const wExpectWriteCb = 1 << 5;
const wBuffered = 1 << 6;
const wNeedDrain = 1 << 7;
const wAfterWritePending = 1 << 8;
const wAfterWriteTickInfo = 1 << 9;
const wPrefinished = 1 << 10;
const wFinalCalled = 1 << 11;
const wOnFinished = 1 << 18;
const wBufferProcessing = 1 << 19;
const wAllNoop = 1 << 20;
const wCorked = 1 << 21; // INC-29 U2 (http modules)

/* ── $sock's fields ───────────────────────────────────────────────── */
const S_H = 0; // i32: the host handle, 0 = none
const S_RS = 1; // i32: Readable bits
const S_WS = 2; // i32: Writable bits
const S_RLEN = 3; // i32: readable length (bytes)
const S_RBUF = 4; // chunk array
const S_RHEAD = 5; // i32: bufferIndex
const S_RN = 6; // i32: buffer.length
const S_WLEN = 7; // i32: writable length (Node's units: a string's length, a Buffer's bytes)
const S_WRITELEN = 8; // i32
const S_WRITECB = 9; // eclos (null = nop)
const S_PENDINGCB = 10; // i32
const S_WBUF = 11; // wreq array (buffered writes)
const S_WBUFIDX = 12; // i32: bufferedIndex
const S_WBUFN = 13; // i32: buffered.length
const S_ATI = 14; // $ati, the afterWriteTickInfo object (null)
const S_ONFIN = 15; // eclos array
const S_ONFIN_N = 16; // i32
const S_RERR = 17; // err: readable errored
const S_WERR = 18; // err: writable errored
const S_CONNECTING = 19; // i32
const S_SERVER = 20; // $srv (null)
const S_WAF = 21; // i32: write is writeAfterFIN
const S_PEND = 22; // bytes: _pendingData (null)
const S_DISPATCHED = 23; // f64: the handle's bytesWritten (kBytesWritten once destroyed)
const S_NODELAY = 24; // i32: kSetNoDelay
const S_PEER_ADDR = 25; // string: the handle's getpeername address (null = none)
const S_PEER_PORT = 26; // i32
const S_PEER_FAMILY = 27; // i32
const S_PEER_CACHED = 28; // i32: this._peername was taken
const S_READING = 29; // i32: handle.reading
const S_HOST = 30; // string: the host connect() was asked for
const S_PORT = 31; // i32
const S_ADDRS = 32; // string array: addresses still to attempt
const S_FAMS = 33; // i32 array
const S_ADDR_N = 34; // i32
const S_ADDR_CUR = 35; // i32: context.current
const S_ERR_FIRST = 36; // err: context.errors[0]
const S_ERR_N = 37; // i32: context.errors.length
const S_ATT_ADDR = 38; // string: the attempt in flight
const S_ATT_FAMILY = 39; // i32
const S_WPEND = 40; // i32: an asynchronous write is outstanding on the handle
const S_SPEND = 41; // i32: a shutdown is outstanding on the handle
const S_HAS_HANDLE = 42; // i32: this._handle is non-null (from connect / accept until _destroy)
const S_MULTI = 43; // i32: internalConnectMultiple's context is live
const S_LDATA = 44;
const S_LDATA_N = 45;
const S_LEND = 46;
const S_LEND_N = 47;
const S_LCLOSE = 48;
const S_LCLOSE_N = 49;
const S_LERROR = 50;
const S_LERROR_N = 51;
const S_LCONNECT = 52;
const S_LCONNECT_N = 53;
const S_LFINISH = 54;
const S_LFINISH_N = 55;
const S_LOOKUP = 56; // i32: a RESOLVE is outstanding for this socket
/* INC-29 U2: the http module's extra $sock fields (absent elsewhere). */
const S_CORKED = 57; // i32: the Writable's corked counter
const S_UNREF = 58; // i32: the handle is unref'd
const S_TMO = 59; // f64: this[kTimeout]'s timer id (0 = none)
const S_TIMEOUT = 60; // f64: socket.timeout (-1 = undefined)
const S_HTTPMSG = 61; // eqref: socket._httpMessage
const S_PARSER = 62; // eqref: socket.parser
const S_CONSUMED = 63; // i32: the handle is consumed by socket.parser
const S_HPAUSED = 64; // i32: socket._paused (the http server's flag)
const S_HADERR = 65; // i32: socket._hadError
const S_HALFOPEN = 66; // i32: allowHalfOpen
const S_KEEPALIVE = 67; // i32: setKeepAlive's flag (recorded only: SEMANTICS.md S088 (c))
const S_LWQS = 68; // i32: kLastWriteQueueSize
const S_LDRAIN = 69;
const S_LDRAIN_N = 70;
const S_LTIMEOUT = 71;
const S_LTIMEOUT_N = 72;
const S_LPAUSE = 73;
const S_LPAUSE_N = 74;
const S_LRESUME = 75;
const S_LRESUME_N = 76;
const S_LFREE = 77;
const S_LFREE_N = 78;
const S_LAGENTRM = 79;
const S_LAGENTRM_N = 80;
const S_HCLI = 81; // eqref: http.ts's per-socket client listeners
const S_FREEGUARD = 82; // i32: the Agent's free-socket read guard is the handle's onread
/** INC-29 U2: the $sock field indices http.ts reads and writes. */
export const NET_SOCK_HTTP = {
  S_HTTPMSG, S_PARSER, S_CONSUMED, S_HPAUSED, S_HADERR, S_TIMEOUT, S_UNREF, S_CORKED, S_KEEPALIVE, S_HCLI, S_FREEGUARD,
  S_SERVER: 20, S_WLEN: 7, S_HAS_HANDLE: 42, S_CONNECTING: 19, S_RS: 1, S_WS: 2, S_RLEN: 3, S_H: 0, S_READING: 29,
};

/* ── $srv's fields ────────────────────────────────────────────────── */
const V_H = 0; // i32: the listening handle, 0 = none (Node's _handle)
const V_CONNS = 1; // i32: _connections
const V_LID = 2; // i32: _listeningId
const V_PORT = 3; // i32: the bound port
const V_FAMILY = 4; // i32
const V_ADDR = 5; // string: the bound address
const V_OVERRIDE = 6; // eqref: the `server.close = fn` override (a closure)
const V_LCONN = 7;
const V_LCONN_N = 8;
const V_LLISTENING = 9;
const V_LLISTENING_N = 10;
const V_LCLOSE = 11;
const V_LCLOSE_N = 12;
const V_LERROR = 13;
const V_LERROR_N = 14;
const V_LOOKUP_PORT = 15; // i32: lookupAndListen's port
const V_LOOKUP_LID = 16; // i32: lookupAndListen's captured listeningId
const V_LOOKUP = 17; // i32: a RESOLVE is outstanding for this server
const V_FLAGS = 18; // i32: listen flags (bit 0 = ipv6Only)
/* INC-29 U2: the http module's extra $srv fields. */
const V_HTTP = 19; // eqref: the http server's own state (http.ts), null for a net.Server
const V_HALFOPEN = 20; // i32: allowHalfOpen
const V_NODELAY = 21; // i32: noDelay
/** INC-29 U2: the $srv field indices http.ts reads and writes. */
export const NET_SRV_HTTP = { V_HTTP, V_HALFOPEN, V_NODELAY, V_H: 0, V_CONNS: 1 };

/* ── the tick / internal-listener environment ─────────────────────── */
const T_SOCK = 1;
const T_SRV = 2;
const T_ERR = 3;
const T_X = 4;
const T_N = 5;

/** A listener list on an owner struct: the array field and the count. */
interface ListSpec {
  owner: "sock" | "srv";
  arr: number;
  n: number;
  /** What one listener takes. */
  arg: "void" | "data" | "err" | "sock";
}

/* The lists. */
const L_DATA: ListSpec = { owner: "sock", arr: S_LDATA, n: S_LDATA_N, arg: "data" };
const L_END: ListSpec = { owner: "sock", arr: S_LEND, n: S_LEND_N, arg: "void" };
const L_CLOSE: ListSpec = { owner: "sock", arr: S_LCLOSE, n: S_LCLOSE_N, arg: "void" };
const L_ERROR: ListSpec = { owner: "sock", arr: S_LERROR, n: S_LERROR_N, arg: "err" };
const L_CONNECT: ListSpec = { owner: "sock", arr: S_LCONNECT, n: S_LCONNECT_N, arg: "void" };
const L_FINISH: ListSpec = { owner: "sock", arr: S_LFINISH, n: S_LFINISH_N, arg: "void" };
const LV_CONN: ListSpec = { owner: "srv", arr: V_LCONN, n: V_LCONN_N, arg: "sock" };
const LV_LISTENING: ListSpec = { owner: "srv", arr: V_LLISTENING, n: V_LLISTENING_N, arg: "void" };
const LV_CLOSE: ListSpec = { owner: "srv", arr: V_LCLOSE, n: V_LCLOSE_N, arg: "void" };
const LV_ERROR: ListSpec = { owner: "srv", arr: V_LERROR, n: V_LERROR_N, arg: "err" };

/* INC-29 U2: the http module's extra socket lists. */
const L_DRAIN: ListSpec = { owner: "sock", arr: S_LDRAIN, n: S_LDRAIN_N, arg: "void" };
const L_TIMEOUT: ListSpec = { owner: "sock", arr: S_LTIMEOUT, n: S_LTIMEOUT_N, arg: "void" };
const L_PAUSE: ListSpec = { owner: "sock", arr: S_LPAUSE, n: S_LPAUSE_N, arg: "void" };
const L_RESUME: ListSpec = { owner: "sock", arr: S_LRESUME, n: S_LRESUME_N, arg: "void" };
const L_FREE: ListSpec = { owner: "sock", arr: S_LFREE, n: S_LFREE_N, arg: "void" };
const L_AGENTRM: ListSpec = { owner: "sock", arr: S_LAGENTRM, n: S_LAGENTRM_N, arg: "void" };

export const NET_LISTS = {
  L_DATA, L_END, L_CLOSE, L_ERROR, L_CONNECT, L_FINISH, LV_CONN, LV_LISTENING, LV_CLOSE, LV_ERROR,
  L_DRAIN, L_TIMEOUT, L_PAUSE, L_RESUME, L_FREE, L_AGENTRM,
};
export type NetList = ListSpec;

/** Node's uv error messages (util.getSystemErrorMap(), v24.18.1) for the
 * errnos a listen can fail with — UVExceptionWithHostPort's middle part.
 * An errno outside the table renders libuv's "unknown error". */
// generated from Node v24.18.1 util.getSystemErrorMap()
const UV_MESSAGES: readonly (readonly [number, string])[] = [
  [-7, "argument list too long"], [-13, "permission denied"], [-98, "address already in use"],
  [-99, "address not available"], [-97, "address family not supported"], [-11, "resource temporarily unavailable"],
  [-3000, "address family not supported"], [-3001, "temporary failure"], [-3002, "bad ai_flags value"],
  [-3013, "invalid value for hints"], [-3003, "request canceled"], [-3004, "permanent failure"],
  [-3005, "ai_family not supported"], [-3006, "out of memory"], [-3007, "no address"],
  [-3008, "unknown node or service"], [-3009, "argument buffer overflow"], [-3014, "resolved protocol is unknown"],
  [-3010, "service not available for socket type"], [-3011, "socket type not supported"],
  [-114, "connection already in progress"], [-9, "bad file descriptor"], [-16, "resource busy or locked"],
  [-125, "operation canceled"], [-4080, "invalid Unicode character"], [-103, "software caused connection abort"],
  [-111, "connection refused"], [-104, "connection reset by peer"], [-89, "destination address required"],
  [-17, "file already exists"], [-14, "bad address in system call argument"], [-27, "file too large"],
  [-113, "host is unreachable"], [-4, "interrupted system call"], [-22, "invalid argument"], [-5, "i/o error"],
  [-106, "socket is already connected"], [-21, "illegal operation on a directory"],
  [-40, "too many symbolic links encountered"], [-24, "too many open files"], [-90, "message too long"],
  [-36, "name too long"], [-100, "network is down"], [-101, "network is unreachable"], [-23, "file table overflow"],
  [-105, "no buffer space available"], [-19, "no such device"], [-2, "no such file or directory"],
  [-12, "not enough memory"], [-64, "machine is not on the network"], [-92, "protocol not available"],
  [-28, "no space left on device"], [-38, "function not implemented"], [-107, "socket is not connected"],
  [-20, "not a directory"], [-39, "directory not empty"], [-88, "socket operation on non-socket"],
  [-95, "operation not supported on socket"], [-75, "value too large for defined data type"],
  [-1, "operation not permitted"], [-32, "broken pipe"], [-71, "protocol error"], [-93, "protocol not supported"],
  [-91, "protocol wrong type for socket"], [-34, "result too large"], [-30, "read-only file system"],
  [-108, "cannot send after transport endpoint shutdown"], [-29, "invalid seek"], [-3, "no such process"],
  [-110, "connection timed out"], [-26, "text file is busy"], [-18, "cross-device link not permitted"],
  [-4094, "unknown error"], [-4095, "end of file"], [-6, "no such device or address"], [-31, "too many links"],
  [-112, "host is down"], [-121, "remote I/O error"], [-25, "inappropriate ioctl for device"],
  [-4028, "inappropriate file type or format"], [-84, "illegal byte sequence"], [-94, "socket type not supported"],
  [-61, "no data available"], [-49, "protocol driver not attached"], [-8, "exec format error"],
];

/** One function under construction: its Code and its extra locals. */
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

export class NetBuilder {
  private readonly fns = new Map<string, number>();
  private sockTField: number | null = null;
  private srvTField: number | null = null;
  private entTField: number | null = null;
  private entArrTField: number | null = null;
  private chunkArrTField: number | null = null;
  private wreqTField: number | null = null;
  private wreqArrTField: number | null = null;
  private ecArrTField: number | null = null;
  private strArrTField: number | null = null;
  private i32ArrTField: number | null = null;
  private tickEnvTField: number | null = null;
  private atiTField: number | null = null;
  private multiCbEnvTField: number | null = null;
  private tableTField: number | null = null;
  private globalsField: {
    table: number;
    cap: number;
    closing: number;
    closingN: number;
    closingSrv: number;
    pend: number;
    pendN: number;
    resolving: number;
    autosel: number;
    emitArg: number;
    lastErr: number;
    stage: number;
  } | null = null;

  constructor(
    private readonly mb: ModuleBuilder,
    private readonly deps: NetDeps,
  ) {}

  /* ── plumbing ──────────────────────────────────────────────────────── */

  /** Declare-then-build (the machine is mutually recursive: a function
   * may name itself, directly or through others, while its body is being
   * built). */
  private fn(name: string, params: ValType[], results: ValType[], build: (f: Fn) => void): number {
    const hit = this.fns.get(name);
    if (hit !== undefined) return hit;
    const idx = this.mb.declareFunc(this.mb.funcType(params, results), `%w.net.${name}`);
    this.fns.set(name, idx);
    const f = new Fn(params.length);
    build(f);
    this.mb.setBody(idx, f.locals, f.c.bytes());
    return idx;
  }

  private ref(typeIndex: number): ValType {
    return { kind: "ref", nullable: true, typeIndex };
  }

  private get strRef(): ValType {
    return this.deps.strRef();
  }

  private get errRef(): ValType {
    return this.ref(this.deps.errType());
  }

  private get bytesRef(): ValType {
    return this.ref(this.deps.bytesType());
  }

  private eclosRef(): ValType {
    return this.ref(this.deps.errClos().clos);
  }

  /** if (cond) then [else els] */
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

  private lit(c: Code, s: string): void {
    this.deps.pushStrLit(c, s);
  }

  private concat(c: Code): void {
    c.call(this.deps.concat());
  }

  /* ── types ─────────────────────────────────────────────────────────── */

  private get entT(): number {
    this.entTField ??= this.mb.structType([
      { storage: EQ_REF, mutable: false }, // the listener closure
      { storage: I32, mutable: false }, // once
      { storage: I32, mutable: true }, // fired (a once listener already taken)
    ]);
    return this.entTField;
  }

  private get entArrT(): number {
    this.entArrTField ??= this.mb.arrayType(this.ref(this.entT), true);
    return this.entArrTField;
  }

  private get chunkArrT(): number {
    this.chunkArrTField ??= this.mb.arrayType(this.bytesRef, true);
    return this.chunkArrTField;
  }

  /** One buffered write: the chunk's bytes, its length in Node's units,
   * and its callback (null = nop). */
  private get wreqT(): number {
    this.wreqTField ??= this.mb.structType([
      { storage: this.bytesRef, mutable: false },
      { storage: I32, mutable: false },
      { storage: this.eclosRef(), mutable: false },
    ]);
    return this.wreqTField;
  }

  private get wreqArrT(): number {
    this.wreqArrTField ??= this.mb.arrayType(this.ref(this.wreqT), true);
    return this.wreqArrTField;
  }

  private get ecArrT(): number {
    this.ecArrTField ??= this.mb.arrayType(this.eclosRef(), true);
    return this.ecArrTField;
  }

  private get strArrT(): number {
    this.strArrTField ??= this.mb.arrayType(this.strRef, true);
    return this.strArrTField;
  }

  private get i32ArrT(): number {
    this.i32ArrTField ??= this.mb.arrayType(I32, true);
    return this.i32ArrTField;
  }

  /** afterWriteTickInfo: { count, cb }. */
  private get atiT(): number {
    this.atiTField ??= this.mb.structType([
      { storage: I32, mutable: true },
      { storage: this.eclosRef(), mutable: false },
    ]);
    return this.atiTField;
  }

  /** type:netServer. */
  srvType(): number {
    if (this.srvTField === null) {
      const ent = this.ref(this.entArrT);
      this.srvTField = this.mb.structType([
        { storage: I32, mutable: true }, // V_H
        { storage: I32, mutable: true }, // V_CONNS
        { storage: I32, mutable: true }, // V_LID
        { storage: I32, mutable: true }, // V_PORT
        { storage: I32, mutable: true }, // V_FAMILY
        { storage: this.strRef, mutable: true }, // V_ADDR
        { storage: EQ_REF, mutable: true }, // V_OVERRIDE
        { storage: ent, mutable: true },
        { storage: I32, mutable: true },
        { storage: ent, mutable: true },
        { storage: I32, mutable: true },
        { storage: ent, mutable: true },
        { storage: I32, mutable: true },
        { storage: ent, mutable: true },
        { storage: I32, mutable: true },
        { storage: I32, mutable: true }, // V_LOOKUP_PORT
        { storage: I32, mutable: true }, // V_LOOKUP_LID
        { storage: I32, mutable: true }, // V_LOOKUP
        { storage: I32, mutable: true }, // V_FLAGS
        ...(this.deps.http !== undefined
          ? [
              { storage: EQ_REF, mutable: true }, // V_HTTP
              { storage: I32, mutable: true }, // V_HALFOPEN
              { storage: I32, mutable: true }, // V_NODELAY
            ]
          : []),
        ...(this.deps.tls !== undefined
          ? [
              { storage: EQ_REF, mutable: true }, // V_TLS (tls.ts)
              { storage: ent, mutable: true }, // 'secureConnection'
              { storage: I32, mutable: true },
            ]
          : []),
      ]);
    }
    return this.srvTField;
  }

  srvRef(): ValType {
    return this.ref(this.srvType());
  }

  /** type:netSocket. */
  sockType(): number {
    if (this.sockTField === null) {
      const ent = this.ref(this.entArrT);
      const srv = this.srvRef();
      this.sockTField = this.mb.structType([
        { storage: I32, mutable: true }, // S_H
        { storage: I32, mutable: true }, // S_RS
        { storage: I32, mutable: true }, // S_WS
        { storage: I32, mutable: true }, // S_RLEN
        { storage: this.ref(this.chunkArrT), mutable: true }, // S_RBUF
        { storage: I32, mutable: true }, // S_RHEAD
        { storage: I32, mutable: true }, // S_RN
        { storage: I32, mutable: true }, // S_WLEN
        { storage: I32, mutable: true }, // S_WRITELEN
        { storage: this.eclosRef(), mutable: true }, // S_WRITECB
        { storage: I32, mutable: true }, // S_PENDINGCB
        { storage: this.ref(this.wreqArrT), mutable: true }, // S_WBUF
        { storage: I32, mutable: true }, // S_WBUFIDX
        { storage: I32, mutable: true }, // S_WBUFN
        { storage: this.ref(this.atiT), mutable: true }, // S_ATI
        { storage: this.ref(this.ecArrT), mutable: true }, // S_ONFIN
        { storage: I32, mutable: true }, // S_ONFIN_N
        { storage: this.errRef, mutable: true }, // S_RERR
        { storage: this.errRef, mutable: true }, // S_WERR
        { storage: I32, mutable: true }, // S_CONNECTING
        { storage: srv, mutable: true }, // S_SERVER
        { storage: I32, mutable: true }, // S_WAF
        { storage: this.bytesRef, mutable: true }, // S_PEND
        { storage: F64, mutable: true }, // S_DISPATCHED
        { storage: I32, mutable: true }, // S_NODELAY
        { storage: this.strRef, mutable: true }, // S_PEER_ADDR
        { storage: I32, mutable: true }, // S_PEER_PORT
        { storage: I32, mutable: true }, // S_PEER_FAMILY
        { storage: I32, mutable: true }, // S_PEER_CACHED
        { storage: I32, mutable: true }, // S_READING
        { storage: this.strRef, mutable: true }, // S_HOST
        { storage: I32, mutable: true }, // S_PORT
        { storage: this.ref(this.strArrT), mutable: true }, // S_ADDRS
        { storage: this.ref(this.i32ArrT), mutable: true }, // S_FAMS
        { storage: I32, mutable: true }, // S_ADDR_N
        { storage: I32, mutable: true }, // S_ADDR_CUR
        { storage: this.errRef, mutable: true }, // S_ERR_FIRST
        { storage: I32, mutable: true }, // S_ERR_N
        { storage: this.strRef, mutable: true }, // S_ATT_ADDR
        { storage: I32, mutable: true }, // S_ATT_FAMILY
        { storage: I32, mutable: true }, // S_WPEND
        { storage: I32, mutable: true }, // S_SPEND
        { storage: I32, mutable: true }, // S_HAS_HANDLE
        { storage: I32, mutable: true }, // S_MULTI
        { storage: ent, mutable: true },
        { storage: I32, mutable: true },
        { storage: ent, mutable: true },
        { storage: I32, mutable: true },
        { storage: ent, mutable: true },
        { storage: I32, mutable: true },
        { storage: ent, mutable: true },
        { storage: I32, mutable: true },
        { storage: ent, mutable: true },
        { storage: I32, mutable: true },
        { storage: ent, mutable: true },
        { storage: I32, mutable: true },
        { storage: I32, mutable: true }, // S_LOOKUP
        ...(this.deps.http !== undefined
          ? [
              { storage: I32, mutable: true }, // S_CORKED
              { storage: I32, mutable: true }, // S_UNREF
              { storage: F64, mutable: true }, // S_TMO
              { storage: F64, mutable: true }, // S_TIMEOUT
              { storage: EQ_REF, mutable: true }, // S_HTTPMSG
              { storage: EQ_REF, mutable: true }, // S_PARSER
              { storage: I32, mutable: true }, // S_CONSUMED
              { storage: I32, mutable: true }, // S_HPAUSED
              { storage: I32, mutable: true }, // S_HADERR
              { storage: I32, mutable: true }, // S_HALFOPEN
              { storage: I32, mutable: true }, // S_KEEPALIVE
              { storage: I32, mutable: true }, // S_LWQS
              ...Array.from({ length: 6 }, () => [
                { storage: ent, mutable: true },
                { storage: I32, mutable: true },
              ]).flat(),
              { storage: EQ_REF, mutable: true }, // S_HCLI
              { storage: I32, mutable: true }, // S_FREEGUARD
            ]
          : []),
        ...(this.deps.tls !== undefined
          ? [
              { storage: EQ_REF, mutable: true }, // S_TLS (tls.ts)
              { storage: ent, mutable: true }, // 'secureConnect'
              { storage: I32, mutable: true },
            ]
          : []),
      ]);
    }
    return this.sockTField;
  }

  sockRef(): ValType {
    return this.ref(this.sockType());
  }

  /** INC-29 U4: the TLS fields of $sock and $srv (tls.ts), after U2's
   * http fields when the module has them. */
  tlsFields(): { S_TLS: number; L_SECURE: NetList; V_TLS: number; LV_SECCONN: NetList } {
    if (this.deps.tls === undefined) throw new Error("net.ts: tlsFields in a module without TLS");
    const s = this.deps.http !== undefined ? S_FREEGUARD + 1 : S_LOOKUP + 1;
    const v = this.deps.http !== undefined ? V_NODELAY + 1 : V_FLAGS + 1;
    return {
      S_TLS: s,
      L_SECURE: { owner: "sock", arr: s + 1, n: s + 2, arg: "void" },
      V_TLS: v,
      LV_SECCONN: { owner: "srv", arr: v + 1, n: v + 2, arg: "sock" },
    };
  }

  /** The environment of every tick and internal listener the machine
   * queues: a subtype of the void closure struct. */
  private get tickEnvT(): number {
    if (this.tickEnvTField === null) {
      const pair = this.deps.voidClos();
      this.tickEnvTField = this.mb.subStructType(
        "%w.net.tickEnv",
        [
          { storage: { kind: "ref", nullable: false, typeIndex: pair.fn }, mutable: false },
          { storage: this.sockRef(), mutable: false },
          { storage: this.srvRef(), mutable: false },
          { storage: this.errRef, mutable: false },
          { storage: EQ_REF, mutable: false },
          { storage: I32, mutable: false },
        ],
        pair.clos,
      );
    }
    return this.tickEnvTField;
  }

  /** The writev callback: an error-closure subtype holding the buffered
   * requests it answers for, [from, to). */
  private get multiCbEnvT(): number {
    if (this.multiCbEnvTField === null) {
      const pair = this.deps.errClos();
      this.multiCbEnvTField = this.mb.subStructType(
        "%w.net.multiCbEnv",
        [
          { storage: { kind: "ref", nullable: false, typeIndex: pair.fn }, mutable: false },
          { storage: this.ref(this.wreqArrT), mutable: false },
          { storage: I32, mutable: false },
          { storage: I32, mutable: false },
        ],
        pair.clos,
      );
    }
    return this.multiCbEnvTField;
  }

  private get tableT(): number {
    this.tableTField ??= this.mb.arrayType(EQ_REF, true);
    return this.tableTField;
  }

  private g(): NonNullable<NetBuilder["globalsField"]> {
    if (this.globalsField === null) {
      const i32 = (v: number): number =>
        this.mb.addGlobal(I32, true, (w) => {
          w.u8(0x41);
          w.sleb(v);
        });
      const tableT = this.tableT;
      this.globalsField = {
        table: this.mb.addGlobal(this.ref(tableT), true, (w) => {
          w.u8(0xd0);
          w.sleb(tableT);
        }),
        cap: i32(EV_FIRST_CAPACITY),
        closing: this.mb.addGlobal(this.ref(tableT), true, (w) => {
          w.u8(0xd0);
          w.sleb(tableT);
        }),
        closingN: i32(0),
        closingSrv: i32(0),
        pend: this.mb.addGlobal(this.ref(tableT), true, (w) => {
          w.u8(0xd0);
          w.sleb(tableT);
        }),
        pendN: i32(0),
        resolving: i32(0),
        autosel: this.mb.addGlobal(F64, true, (w) => {
          w.u8(0x44);
          w.f64(250);
        }),
        emitArg: i32(0),
        lastErr: this.mb.addGlobal(this.errRef, true, (w) => {
          w.u8(0xd0);
          w.sleb(this.deps.errType());
        }),
        stage: i32(0),
      };
    }
    return this.globalsField;
  }

  /** The f64 global behind get/setDefaultAutoSelectFamilyAttemptTimeout
   * (Node's autoSelectFamilyAttemptTimeoutDefault, 250). */
  autoselGlobal(): number {
    return this.g().autosel;
  }

  /** The i32 global a dyn 'close' listener reads its hadError from. */
  emitArgGlobal(): number {
    return this.g().emitArg;
  }

  /* ── field shorthands ──────────────────────────────────────────────── */

  private sget(c: Code, s: number, field: number): void {
    c.localGet(s);
    c.structGet(this.sockType(), field);
  }

  private sset(c: Code, s: number, field: number, push: () => void): void {
    c.localGet(s);
    push();
    c.structSet(this.sockType(), field);
  }

  private vget(c: Code, v: number, field: number): void {
    c.localGet(v);
    c.structGet(this.srvType(), field);
  }

  private vset(c: Code, v: number, field: number, push: () => void): void {
    c.localGet(v);
    push();
    c.structSet(this.srvType(), field);
  }

  /** push (sock.field & mask) != 0 */
  private sbits(c: Code, s: number, field: number, mask: number): void {
    this.sget(c, s, field);
    c.i32Const(mask);
    c.i32And();
    c.i32Const(0);
    c.i32Ne();
  }

  /** push (sock.field & mask) == want */
  private sbitsEq(c: Code, s: number, field: number, mask: number, want: number): void {
    this.sget(c, s, field);
    c.i32Const(mask);
    c.i32And();
    c.i32Const(want);
    c.i32Eq();
  }

  private sbitSet(c: Code, s: number, field: number, mask: number): void {
    this.sset(c, s, field, () => {
      this.sget(c, s, field);
      c.i32Const(mask);
      c.i32Or();
    });
  }

  private sbitClr(c: Code, s: number, field: number, mask: number): void {
    this.sset(c, s, field, () => {
      this.sget(c, s, field);
      c.i32Const(~mask);
      c.i32And();
    });
  }

  /** Set both sides' copy of a shared bit (destroy.js sets r and w). */
  private sbitSetBoth(c: Code, s: number, mask: number): void {
    this.sbitSet(c, s, S_RS, mask);
    this.sbitSet(c, s, S_WS, mask);
  }

  /** push (r.destroyed || w.destroyed) */
  private destroyedEither(c: Code, s: number): void {
    this.sbits(c, s, S_RS, kDestroyed);
    this.sbits(c, s, S_WS, kDestroyed);
    c.i32Or();
  }

  /* ── record I/O in linear memory ───────────────────────────────────── */

  loadU32(c: Code, addr: number, off: number): void {
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

  storeU32(c: Code, addr: number, off: number, push: () => void): void {
    c.localGet(addr);
    c.i32Const(off);
    c.i32Add();
    push();
    c.i32Store();
  }

  /** The stage base: the cursor rounded up to 4, into `local`. */
  base(c: Code, local: number): void {
    c.globalGet(this.deps.stageCursor());
    c.i32Const(3);
    c.i32Add();
    c.i32Const(-4);
    c.i32And();
    c.localSet(local);
  }

  /** push the byte size of one UTF-16 run for the string in `s`. */
  private runSize(c: Code, s: number): void {
    c.localGet(s);
    c.arrayLen();
    c.i32Const(2);
    c.i32Mul();
    c.i32Const(3);
    c.i32Add();
    c.i32Const(-4);
    c.i32And();
    c.i32Const(4);
    c.i32Add();
  }

  /** `%w.net.readRun(ptr) -> string` — the UTF-16 run at ptr (a u32 count,
   * then the code units). */
  readRunHelper(): number {
    return this.fn("readRun", [I32], [this.strRef], (f) => {
      const c = f.c;
      const P = 0;
      const N = f.local(I32);
      const I = f.local(I32);
      const S = f.local(this.strRef);
      this.loadU32(c, P, 0);
      c.localSet(N);
      c.localGet(N);
      c.arrayNewDefault(this.deps.strType());
      c.localSet(S);
      this.while_(c, () => {
        c.localGet(I);
        c.localGet(N);
        c.i32LtU();
      }, () => {
        c.localGet(S);
        c.localGet(I);
        c.localGet(P);
        c.i32Const(4);
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
      c.localGet(S);
    });
  }

  /** `%w.net.bytesAt(ptr, len) -> bytes` — a fresh Buffer of the bytes at
   * [ptr, ptr + len). */
  bytesAtHelper(): number {
    return this.fn("bytesAt", [I32, I32], [this.bytesRef], (f) => {
      const c = f.c;
      const P = 0;
      const L = 1;
      const A = f.local(this.ref(this.deps.bufType()));
      const I = f.local(I32);
      c.localGet(L);
      c.arrayNewDefault(this.deps.bufType());
      c.localSet(A);
      this.while_(c, () => {
        c.localGet(I);
        c.localGet(L);
        c.i32LtU();
      }, () => {
        c.localGet(A);
        c.localGet(I);
        c.localGet(P);
        c.localGet(I);
        c.i32Add();
        c.i32Load8U();
        c.arraySet(this.deps.bufType());
        c.localGet(I);
        c.i32Const(1);
        c.i32Add();
        c.localSet(I);
      });
      c.localGet(A);
      c.refAsNonNull();
      c.i32Const(0);
      c.localGet(L);
      c.structNew(this.deps.bytesType());
    });
  }

  /** `%w.net.call(op, ptr, len, h, x) -> i32` is the import itself. */
  private netCall(c: Code): void {
    c.call(this.deps.netCallFunc());
  }

  /* ── the handle table ──────────────────────────────────────────────── */

  /** `%w.net.tableSet(h, obj)` — grows by copy; a null obj clears. */
  tableSetHelper(): number {
    return this.fn("tableSet", [I32, EQ_REF], [], (f) => {
      const c = f.c;
      const H = 0;
      const O = 1;
      const NT = f.local(this.ref(this.tableT));
      const g = this.g();
      this.if_(c, () => {
        c.globalGet(g.table);
        c.refIsNull();
      }, () => {
        c.i32Const(16);
        c.arrayNewDefault(this.tableT);
        c.globalSet(g.table);
      });
      this.while_(c, () => {
        c.localGet(H);
        c.globalGet(g.table);
        c.arrayLen();
        c.i32GeU();
      }, () => {
        c.globalGet(g.table);
        c.arrayLen();
        c.i32Const(1);
        c.i32Shl();
        c.arrayNewDefault(this.tableT);
        c.localSet(NT);
        c.localGet(NT);
        c.i32Const(0);
        c.globalGet(g.table);
        c.i32Const(0);
        c.globalGet(g.table);
        c.arrayLen();
        c.arrayCopy(this.tableT, this.tableT);
        c.localGet(NT);
        c.globalSet(g.table);
      });
      c.globalGet(g.table);
      c.localGet(H);
      c.localGet(O);
      c.arraySet(this.tableT);
    });
  }

  /** `%w.net.tableGet(h) -> eqref` — the named trap for a handle the
   * module does not hold. */
  private tableGetHelper(): number {
    return this.fn("tableGet", [I32], [EQ_REF], (f) => {
      const c = f.c;
      const H = 0;
      const O = f.local(EQ_REF);
      const g = this.g();
      this.if_(c, () => {
        c.globalGet(g.table);
        c.refIsNull();
        c.localGet(H);
        c.i32Const(1);
        c.i32LtS();
        c.i32Or();
      }, () => this.trap(c));
      this.if_(c, () => {
        c.localGet(H);
        c.globalGet(g.table);
        c.arrayLen();
        c.i32GeU();
      }, () => this.trap(c));
      c.globalGet(g.table);
      c.localGet(H);
      c.arrayGet(this.tableT);
      c.localTee(O);
      c.refIsNull();
      c.ifVoid();
      this.trap(c);
      c.end();
      c.localGet(O);
    });
  }

  /* ── listeners (lib/events.js's on / once / emit, for these lists) ─── */

  private ownerType(spec: ListSpec): number {
    return spec.owner === "sock" ? this.sockType() : this.srvType();
  }

  private ownerRef(spec: ListSpec): ValType {
    return spec.owner === "sock" ? this.sockRef() : this.srvRef();
  }

  private listName(spec: ListSpec): string {
    return `${spec.owner}${spec.arr}`;
  }

  /** `%w.net.add<list>(owner, clos, once, prepend)` — append (or prepend)
   * one listener; the list grows by copy. */
  addHelper(spec: ListSpec): number {
    return this.fn(`add.${this.listName(spec)}`, [this.ownerRef(spec), EQ_REF, I32, I32], [], (f) => {
      const c = f.c;
      const O = 0;
      const CL = 1;
      const ONCE = 2;
      const PRE = 3;
      const NA = f.local(this.ref(this.entArrT));
      const T = this.ownerType(spec);
      const get = (field: number): void => {
        c.localGet(O);
        c.structGet(T, field);
      };
      this.if_(c, () => {
        get(spec.arr);
        c.refIsNull();
      }, () => {
        c.localGet(O);
        c.i32Const(4);
        c.arrayNewDefault(this.entArrT);
        c.structSet(T, spec.arr);
      });
      this.if_(c, () => {
        get(spec.n);
        get(spec.arr);
        c.arrayLen();
        c.i32GeU();
      }, () => {
        get(spec.arr);
        c.arrayLen();
        c.i32Const(1);
        c.i32Shl();
        c.arrayNewDefault(this.entArrT);
        c.localSet(NA);
        c.localGet(NA);
        c.i32Const(0);
        get(spec.arr);
        c.i32Const(0);
        get(spec.n);
        c.arrayCopy(this.entArrT, this.entArrT);
        c.localGet(O);
        c.localGet(NA);
        c.structSet(T, spec.arr);
      });
      this.if_(c, () => c.localGet(PRE), () => {
        // Shift every entry up one, then store at 0.
        get(spec.arr);
        c.i32Const(1);
        get(spec.arr);
        c.i32Const(0);
        get(spec.n);
        c.arrayCopy(this.entArrT, this.entArrT);
        get(spec.arr);
        c.i32Const(0);
        c.localGet(CL);
        c.localGet(ONCE);
        c.i32Const(0);
        c.structNew(this.entT);
        c.arraySet(this.entArrT);
      }, () => {
        get(spec.arr);
        get(spec.n);
        c.localGet(CL);
        c.localGet(ONCE);
        c.i32Const(0);
        c.structNew(this.entT);
        c.arraySet(this.entArrT);
      });
      c.localGet(O);
      get(spec.n);
      c.i32Const(1);
      c.i32Add();
      c.structSet(T, spec.n);
    });
  }

  /** `%w.net.remove<list>(owner, entOrClos)` — remove the LAST entry
   * whose entry (or whose closure) is `x` (removeListener's own search
   * order). */
  removeHelper(spec: ListSpec): number {
    return this.fn(`remove.${this.listName(spec)}`, [this.ownerRef(spec), EQ_REF], [], (f) => {
      const c = f.c;
      const O = 0;
      const X = 1;
      const I = f.local(I32);
      const E = f.local(this.ref(this.entT));
      const T = this.ownerType(spec);
      const get = (field: number): void => {
        c.localGet(O);
        c.structGet(T, field);
      };
      get(spec.n);
      c.localSet(I);
      c.block();
      c.loop();
      c.localGet(I);
      c.i32Eqz();
      c.brIf(1);
      c.localGet(I);
      c.i32Const(1);
      c.i32Sub();
      c.localSet(I);
      get(spec.arr);
      c.localGet(I);
      c.arrayGet(this.entArrT);
      c.localTee(E);
      c.localGet(X);
      c.refEq();
      c.localGet(E);
      c.structGet(this.entT, 0);
      c.localGet(X);
      c.refEq();
      c.i32Or();
      c.ifVoid();
      // Shift the tail down over slot I.
      get(spec.arr);
      c.localGet(I);
      get(spec.arr);
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      get(spec.n);
      c.localGet(I);
      c.i32Sub();
      c.i32Const(1);
      c.i32Sub();
      c.arrayCopy(this.entArrT, this.entArrT);
      c.localGet(O);
      get(spec.n);
      c.i32Const(1);
      c.i32Sub();
      c.structSet(T, spec.n);
      get(spec.arr);
      get(spec.n);
      c.refNull(this.entT);
      c.arraySet(this.entArrT);
      c.br(2);
      c.end();
      c.br(0);
      c.end();
      c.end();
    });
  }

  /** `%w.net.emit<list>(owner[, arg]) -> i32` — Node's emit: the listeners
   * as registered when the emission starts (a snapshot), a once listener
   * removed before it runs and run at most once, stopping at the first
   * that leaves an exception pending; answers whether any listener was
   * registered. An 'error' list with no listener THROWS the error (the
   * pending cell is set; the caller's check unwinds). */
  emitHelper(spec: ListSpec): number {
    const argT: ValType[] =
      spec.arg === "void" ? [] : spec.arg === "data" ? [this.bytesRef] : spec.arg === "err" ? [this.errRef] : [this.sockRef()];
    return this.fn(`emit.${this.listName(spec)}`, [this.ownerRef(spec), ...argT], [I32], (f) => {
      const c = f.c;
      const O = 0;
      const A = 1;
      const N = f.local(I32);
      const I = f.local(I32);
      const SNAP = f.local(this.ref(this.entArrT));
      const E = f.local(this.ref(this.entT));
      const T = this.ownerType(spec);
      const pair =
        spec.arg === "void" ? this.deps.voidClos() : spec.arg === "data" ? this.deps.dataClos() : spec.arg === "err" ? this.deps.errClos() : this.deps.sockClos();
      c.localGet(O);
      c.structGet(T, spec.n);
      c.localTee(N);
      c.i32Eqz();
      c.ifVoid();
      if (spec.arg === "err") {
        c.localGet(A);
        this.deps.throwStack(c);
        c.i32Const(0);
        c.return_();
      } else {
        c.i32Const(0);
        c.return_();
      }
      c.end();
      c.localGet(N);
      c.arrayNewDefault(this.entArrT);
      c.localSet(SNAP);
      c.localGet(SNAP);
      c.i32Const(0);
      c.localGet(O);
      c.structGet(T, spec.arr);
      c.i32Const(0);
      c.localGet(N);
      c.arrayCopy(this.entArrT, this.entArrT);
      this.while_(c, () => {
        c.localGet(I);
        c.localGet(N);
        c.i32LtU();
      }, () => {
        c.localGet(SNAP);
        c.localGet(I);
        c.arrayGet(this.entArrT);
        c.localSet(E);
        c.localGet(I);
        c.i32Const(1);
        c.i32Add();
        c.localSet(I);
        // A once listener: taken at most once, and removed before it runs.
        c.block();
        c.localGet(E);
        c.structGet(this.entT, 1);
        c.ifVoid();
        c.localGet(E);
        c.structGet(this.entT, 2);
        c.brIf(1);
        c.localGet(E);
        c.i32Const(1);
        c.structSet(this.entT, 2);
        c.localGet(O);
        c.localGet(E);
        c.call(this.removeHelper(spec));
        c.end();
        c.localGet(E);
        c.structGet(this.entT, 0);
        c.refCast(pair.clos);
        if (spec.arg !== "void") c.localGet(A);
        c.localGet(E);
        c.structGet(this.entT, 0);
        c.refCast(pair.clos);
        c.structGet(pair.clos, 0);
        c.callRef(pair.fn);
        c.globalGet(this.deps.excKind());
        c.ifVoid();
        c.i32Const(1);
        c.return_();
        c.end();
        c.end();
      });
      c.i32Const(1);
    });
  }

  /** `%w.net.count<list>(owner) -> i32` */
  /** INC-29 U2: `%w.net.count<list>(owner) -> i32` — listenerCount. */
  countHelper(spec: ListSpec): number {
    return this.fn(`count.${this.listName(spec)}`, [this.ownerRef(spec)], [I32], (f) => this.countOf(f.c, spec, 0));
  }

  private countOf(c: Code, spec: ListSpec, o: number): void {
    c.localGet(o);
    c.structGet(this.ownerType(spec), spec.n);
  }

  /* ── ticks and internal listeners ──────────────────────────────────── */

  /** Declare one tick function of the void closure type; `body` reads the
   * environment's fields through the locals it is handed. */
  private tickFn(name: string, body: (f: Fn, env: { sock: number; srv: number; err: number; x: number; n: number }) => void): number {
    const hit = this.fns.get(`tick.${name}`);
    if (hit !== undefined) return hit;
    const pair = this.deps.voidClos();
    const idx = this.mb.declareFunc(pair.fn, `%w.net.tick.${name}`);
    this.fns.set(`tick.${name}`, idx);
    const env = this.tickEnvT;
    const f = new Fn(1);
    const c = f.c;
    const SOCK = f.local(this.sockRef());
    const SRV = f.local(this.srvRef());
    const ERR = f.local(this.errRef);
    const X = f.local(EQ_REF);
    const N = f.local(I32);
    const fields: [number, number][] = [[T_SOCK, SOCK], [T_SRV, SRV], [T_ERR, ERR], [T_X, X], [T_N, N]];
    for (const [field, local] of fields) {
      c.localGet(0);
      c.refCast(env);
      c.structGet(env, field);
      c.localSet(local);
    }
    body(f, { sock: SOCK, srv: SRV, err: ERR, x: X, n: N });
    this.mb.setBody(idx, f.locals, c.bytes());
    return idx;
  }

  /** Push a tick-environment closure for `fn`: sock, srv, err, x, n. */
  private closure(c: Code, fn: number, parts: { sock?: () => void; srv?: () => void; err?: () => void; x?: () => void; n?: () => void }): void {
    this.mb.declareFuncRef(fn);
    c.refFunc(fn);
    if (parts.sock) parts.sock();
    else c.refNull(this.sockType());
    if (parts.srv) parts.srv();
    else c.refNull(this.srvType());
    if (parts.err) parts.err();
    else c.refNull(this.deps.errType());
    if (parts.x) parts.x();
    else c.refNull(EQ_HEAP);
    if (parts.n) parts.n();
    else c.i32Const(0);
    c.structNew(this.tickEnvT);
  }

  /** process.nextTick(fn, ...) with the tick environment. */
  private nextTick(c: Code, fn: number, parts: { sock?: () => void; srv?: () => void; err?: () => void; x?: () => void; n?: () => void }): void {
    this.closure(c, fn, parts);
    c.call(this.deps.nextTickEnqueue());
  }

  /** Call an error callback (null = nop) with `pushErr`'s error or null. */
  private callCb(c: Code, pushCb: () => void, pushErr: () => void): void {
    const pair = this.deps.errClos();
    pushCb();
    c.refIsNull();
    c.i32Eqz();
    c.ifVoid();
    pushCb();
    pushErr();
    pushCb();
    c.structGet(pair.clos, 0);
    c.callRef(pair.fn);
    c.end();
  }

  /* ── errors (lib/internal/errors.js) ───────────────────────────────── */

  /** `%w.net.code(errno) -> string` — Node's name for a negative errno. */
  private codeOf(c: Code, pushErrno: () => void): void {
    pushErrno();
    c.i32Const(256);
    c.i32Sub();
    c.call(this.deps.codeName());
  }

  /** `%w.net.errnoEx(errno, syscall) -> err` — ErrnoException:
   * "<syscall> <CODE>", code CODE. */
  errnoExHelper(): number {
    return this.fn("errnoEx", [I32, this.strRef], [this.errRef], (f) => {
      const c = f.c;
      const CODE = f.local(this.strRef);
      this.codeOf(c, () => c.localGet(0));
      c.localSet(CODE);
      this.deps.newError(c, "%Error", "Error", (c2) => {
        c2.localGet(1);
        this.lit(c2, " ");
        this.concat(c2);
        c2.localGet(CODE);
        this.concat(c2);
      }, (c2) => c2.localGet(CODE));
    });
  }

  /** The " <address>:<port>" / " <address>" detail of the host-port
   * exceptions (port > 0 shows the port). */
  private hostPortDetail(c: Code, addr: number, port: number): void {
    c.localGet(port);
    c.i32Const(0);
    c.i32GtS();
    c.ifResult(this.strRef);
    this.lit(c, " ");
    c.localGet(addr);
    this.concat(c);
    this.lit(c, ":");
    this.concat(c);
    c.localGet(port);
    c.f64ConvertI32S();
    c.call(this.deps.f64ToStr());
    this.concat(c);
    c.else_();
    c.localGet(addr);
    c.refIsNull();
    c.ifResult(this.strRef);
    this.lit(c, "");
    c.else_();
    c.localGet(addr);
    c.arrayLen();
    c.ifResult(this.strRef);
    this.lit(c, " ");
    c.localGet(addr);
    this.concat(c);
    c.else_();
    this.lit(c, "");
    c.end();
    c.end();
    c.end();
  }

  /** `%w.net.hostPortEx(errno, syscall, address, port) -> err` —
   * ExceptionWithHostPort: "<syscall> <CODE> <address>:<port>". */
  hostPortExHelper(): number {
    return this.fn("hostPortEx", [I32, this.strRef, this.strRef, I32], [this.errRef], (f) => {
      const c = f.c;
      const CODE = f.local(this.strRef);
      this.codeOf(c, () => c.localGet(0));
      c.localSet(CODE);
      this.deps.newError(c, "%Error", "Error", (c2) => {
        c2.localGet(1);
        this.lit(c2, " ");
        this.concat(c2);
        c2.localGet(CODE);
        this.concat(c2);
        this.hostPortDetail(c2, 2, 3);
        this.concat(c2);
      }, (c2) => c2.localGet(CODE));
    });
  }

  /** `%w.net.uvHostPortEx(errno, syscall, address, port) -> err` —
   * UVExceptionWithHostPort: "<syscall> <CODE>: <uv message> <address>:<port>". */
  private uvHostPortExHelper(): number {
    return this.fn("uvHostPortEx", [I32, this.strRef, this.strRef, I32], [this.errRef], (f) => {
      const c = f.c;
      const CODE = f.local(this.strRef);
      const MSG = f.local(this.strRef);
      this.codeOf(c, () => c.localGet(0));
      c.localSet(CODE);
      this.lit(c, "unknown error");
      c.localSet(MSG);
      for (const [n, text] of UV_MESSAGES) {
        this.if_(c, () => {
          c.localGet(0);
          c.i32Const(n);
          c.i32Eq();
        }, () => {
          this.lit(c, text);
          c.localSet(MSG);
        });
      }
      this.deps.newError(c, "%Error", "Error", (c2) => {
        c2.localGet(1);
        this.lit(c2, " ");
        this.concat(c2);
        c2.localGet(CODE);
        this.concat(c2);
        this.lit(c2, ": ");
        this.concat(c2);
        c2.localGet(MSG);
        this.concat(c2);
        this.hostPortDetail(c2, 2, 3);
        this.concat(c2);
      }, (c2) => c2.localGet(CODE));
    });
  }

  /** `%w.net.dnsEx(errno, hostname) -> err` — DNSException for
   * getaddrinfo: EAI_NODATA and EAI_NONAME read ENOTFOUND. */
  private dnsExHelper(): number {
    return this.fn("dnsEx", [I32, this.strRef], [this.errRef], (f) => {
      const c = f.c;
      const CODE = f.local(this.strRef);
      c.localGet(0);
      c.i32Const(-3007);
      c.i32Eq();
      c.localGet(0);
      c.i32Const(-3008);
      c.i32Eq();
      c.i32Or();
      c.ifResult(this.strRef);
      this.lit(c, "ENOTFOUND");
      c.else_();
      this.codeOf(c, () => c.localGet(0));
      c.end();
      c.localSet(CODE);
      this.deps.newError(c, "%Error", "Error", (c2) => {
        this.lit(c2, "getaddrinfo ");
        c2.localGet(CODE);
        this.concat(c2);
        this.lit(c2, " ");
        this.concat(c2);
        c2.localGet(1);
        this.concat(c2);
      }, (c2) => c2.localGet(CODE));
    });
  }

  /** Push a fresh Node error (class Error) with a literal message and code. */
  nodeErr(c: Code, message: string, code: string): void {
    this.deps.newError(c, "%Error", "Error", (c2) => this.lit(c2, message), (c2) => this.lit(c2, code));
  }

  /* ── IP literals (lib/internal/net.js's isIPv4 / isIPv6 regexes) ──── */

  /** `%w.net.isIPv4(s, from, to) -> i32` over s[from, to). */
  private isIPv4Helper(): number {
    return this.fn("isIPv4", [this.strRef, I32, I32], [I32], (f) => {
      const c = f.c;
      const S = 0;
      const FROM = 1;
      const TO = 2;
      const I = f.local(I32);
      const SEG = f.local(I32); // segments seen
      const LEN = f.local(I32); // digits in this segment
      const V = f.local(I32); // value
      const FIRST = f.local(I32); // first digit
      const CH = f.local(I32);
      c.localGet(FROM);
      c.localSet(I);
      // Each segment: 1-3 digits, no leading zero unless the digit is "0"
      // alone, value <= 255; then "." (three times) or the end.
      c.block(); // fail
      c.block(); // ok
      c.loop();
      c.i32Const(0);
      c.localSet(LEN);
      c.i32Const(0);
      c.localSet(V);
      c.block();
      c.loop();
      c.localGet(I);
      c.localGet(TO);
      c.i32GeU();
      c.brIf(1);
      c.localGet(S);
      c.localGet(I);
      c.arrayGetU(this.deps.strType());
      c.localTee(CH);
      c.i32Const(48);
      c.i32LtU();
      c.localGet(CH);
      c.i32Const(57);
      c.i32GtU();
      c.i32Or();
      c.brIf(1);
      this.if_(c, () => {
        c.localGet(LEN);
        c.i32Eqz();
      }, () => {
        c.localGet(CH);
        c.localSet(FIRST);
      });
      c.localGet(V);
      c.i32Const(10);
      c.i32Mul();
      c.localGet(CH);
      c.i32Const(48);
      c.i32Sub();
      c.i32Add();
      c.localSet(V);
      c.localGet(LEN);
      c.i32Const(1);
      c.i32Add();
      c.localSet(LEN);
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(I);
      c.br(0);
      c.end();
      c.end();
      // A segment: 1..3 digits, value <= 255, and "0" only alone.
      c.localGet(LEN);
      c.i32Eqz();
      c.localGet(LEN);
      c.i32Const(3);
      c.i32GtU();
      c.i32Or();
      c.localGet(V);
      c.i32Const(255);
      c.i32GtU();
      c.i32Or();
      c.localGet(LEN);
      c.i32Const(1);
      c.i32GtU();
      c.localGet(FIRST);
      c.i32Const(48);
      c.i32Eq();
      c.i32And();
      c.i32Or();
      c.brIf(2); // fail
      c.localGet(SEG);
      c.i32Const(1);
      c.i32Add();
      c.localSet(SEG);
      c.localGet(SEG);
      c.i32Const(4);
      c.i32Eq();
      c.ifVoid();
      // The fourth segment must end the text.
      c.localGet(I);
      c.localGet(TO);
      c.i32Eq();
      c.brIf(2); // ok
      c.br(3); // fail
      c.end();
      // Otherwise a "." follows.
      c.localGet(I);
      c.localGet(TO);
      c.i32GeU();
      c.brIf(2);
      c.localGet(S);
      c.localGet(I);
      c.arrayGetU(this.deps.strType());
      c.i32Const(46);
      c.i32Ne();
      c.brIf(2);
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(I);
      c.br(0);
      c.end();
      c.end(); // ok
      c.i32Const(1);
      c.return_();
      c.end(); // fail
      c.i32Const(0);
    });
  }

  /** `%w.net.hexGroup(s, from, to) -> i32` — 1..4 hex digits exactly. */
  private hexGroupHelper(): number {
    return this.fn("hexGroup", [this.strRef, I32, I32], [I32], (f) => {
      const c = f.c;
      const I = f.local(I32);
      const CH = f.local(I32);
      this.if_(c, () => {
        c.localGet(2);
        c.localGet(1);
        c.i32Sub();
        c.localTee(I);
        c.i32Const(1);
        c.i32LtS();
        c.localGet(I);
        c.i32Const(4);
        c.i32GtS();
        c.i32Or();
      }, () => {
        c.i32Const(0);
        c.return_();
      });
      c.localGet(1);
      c.localSet(I);
      this.while_(c, () => {
        c.localGet(I);
        c.localGet(2);
        c.i32LtU();
      }, () => {
        c.localGet(0);
        c.localGet(I);
        c.arrayGetU(this.deps.strType());
        c.localSet(CH);
        this.if_(c, () => {
          c.localGet(CH);
          c.i32Const(48);
          c.i32GeU();
          c.localGet(CH);
          c.i32Const(57);
          c.i32LeU();
          c.i32And();
          c.localGet(CH);
          c.i32Const(97);
          c.i32GeU();
          c.localGet(CH);
          c.i32Const(102);
          c.i32LeU();
          c.i32And();
          c.i32Or();
          c.localGet(CH);
          c.i32Const(65);
          c.i32GeU();
          c.localGet(CH);
          c.i32Const(70);
          c.i32LeU();
          c.i32And();
          c.i32Or();
          c.i32Eqz();
        }, () => {
          c.i32Const(0);
          c.return_();
        });
        c.localGet(I);
        c.i32Const(1);
        c.i32Add();
        c.localSet(I);
      });
      c.i32Const(1);
    });
  }

  /** `%w.net.isIP(s) -> 0 | 4 | 6` — Node's isIP. The IPv6 test is the
   * regex's own language, restated: an optional zone ("%" and one or more
   * of [0-9a-zA-Z-.:]) after the address; at most one "::"; groups of 1-4
   * hex digits split by ":"; an IPv4 tail only as the last element; eight
   * 16-bit units without "::", at most seven with it. A host-free test
   * (wasm-net-u1.test.ts) checks this against Node's own regex. */
  isIPHelper(): number {
    return this.fn("isIP", [this.strRef], [I32], (f) => {
      const c = f.c;
      const S = 0;
      const END = f.local(I32); // the address part's end (before any zone)
      const I = f.local(I32);
      const CH = f.local(I32);
      const DC = f.local(I32); // the "::" position, -1 none
      const UNITS = f.local(I32);
      const START = f.local(I32); // the current element's start
      const LAST = f.local(I32); // the element is the last of the address
      const LEN = f.local(I32);
      c.localGet(S);
      c.arrayLen();
      c.localSet(LEN);
      this.if_(c, () => {
        c.localGet(S);
        c.i32Const(0);
        c.localGet(LEN);
        c.call(this.isIPv4Helper());
      }, () => {
        c.i32Const(4);
        c.return_();
      });
      // The zone.
      c.localGet(LEN);
      c.localSet(END);
      c.i32Const(0);
      c.localSet(I);
      this.while_(c, () => {
        c.localGet(I);
        c.localGet(LEN);
        c.i32LtU();
      }, () => {
        this.if_(c, () => {
          c.localGet(S);
          c.localGet(I);
          c.arrayGetU(this.deps.strType());
          c.i32Const(37);
          c.i32Eq();
          c.localGet(END);
          c.localGet(LEN);
          c.i32Eq();
          c.i32And();
        }, () => {
          c.localGet(I);
          c.localSet(END);
        });
        c.localGet(I);
        c.i32Const(1);
        c.i32Add();
        c.localSet(I);
      });
      this.if_(c, () => {
        c.localGet(END);
        c.localGet(LEN);
        c.i32Ne();
      }, () => {
        this.if_(c, () => {
          c.localGet(END);
          c.i32Const(1);
          c.i32Add();
          c.localGet(LEN);
          c.i32Eq();
        }, () => {
          c.i32Const(0);
          c.return_();
        });
        c.localGet(END);
        c.i32Const(1);
        c.i32Add();
        c.localSet(I);
        this.while_(c, () => {
          c.localGet(I);
          c.localGet(LEN);
          c.i32LtU();
        }, () => {
          c.localGet(S);
          c.localGet(I);
          c.arrayGetU(this.deps.strType());
          c.localSet(CH);
          this.if_(c, () => {
            c.localGet(CH);
            c.i32Const(48);
            c.i32GeU();
            c.localGet(CH);
            c.i32Const(57);
            c.i32LeU();
            c.i32And();
            c.localGet(CH);
            c.i32Const(97);
            c.i32GeU();
            c.localGet(CH);
            c.i32Const(122);
            c.i32LeU();
            c.i32And();
            c.i32Or();
            c.localGet(CH);
            c.i32Const(65);
            c.i32GeU();
            c.localGet(CH);
            c.i32Const(90);
            c.i32LeU();
            c.i32And();
            c.i32Or();
            c.localGet(CH);
            c.i32Const(45);
            c.i32Eq();
            c.i32Or();
            c.localGet(CH);
            c.i32Const(46);
            c.i32Eq();
            c.i32Or();
            c.localGet(CH);
            c.i32Const(58);
            c.i32Eq();
            c.i32Or();
            c.i32Eqz();
          }, () => {
            c.i32Const(0);
            c.return_();
          });
          c.localGet(I);
          c.i32Const(1);
          c.i32Add();
          c.localSet(I);
        });
      });
      // The "::".
      c.i32Const(-1);
      c.localSet(DC);
      c.i32Const(0);
      c.localSet(I);
      this.while_(c, () => {
        c.localGet(I);
        c.i32Const(1);
        c.i32Add();
        c.localGet(END);
        c.i32LtU();
      }, () => {
        this.if_(c, () => {
          c.localGet(S);
          c.localGet(I);
          c.arrayGetU(this.deps.strType());
          c.i32Const(58);
          c.i32Eq();
          c.localGet(S);
          c.localGet(I);
          c.i32Const(1);
          c.i32Add();
          c.arrayGetU(this.deps.strType());
          c.i32Const(58);
          c.i32Eq();
          c.i32And();
        }, () => {
          // A second "::" (or ":::") is not an address.
          this.if_(c, () => {
            c.localGet(DC);
            c.i32Const(0);
            c.i32GeS();
          }, () => {
            c.i32Const(0);
            c.return_();
          });
          c.localGet(I);
          c.localSet(DC);
          c.localGet(I);
          c.i32Const(1);
          c.i32Add();
          c.localSet(I);
        });
        c.localGet(I);
        c.i32Const(1);
        c.i32Add();
        c.localSet(I);
      });
      // Walk the elements: [0, DC) and [DC + 2, END) when "::" is present,
      // else [0, END). An empty side contributes nothing; a non-empty side
      // is elements split by single ":".
      const side = (from: () => void, to: () => void, tailSide: boolean): void => {
        from();
        c.localSet(START);
        from();
        c.localSet(I);
        // An empty side.
        c.block();
        from();
        to();
        c.i32Eq();
        c.brIf(0);
        this.while_(c, () => c.i32Const(1), () => {
          // Find the element's end.
          c.localGet(START);
          c.localSet(I);
          c.block();
          c.loop();
          c.localGet(I);
          to();
          c.i32GeU();
          c.brIf(1);
          c.localGet(S);
          c.localGet(I);
          c.arrayGetU(this.deps.strType());
          c.i32Const(58);
          c.i32Eq();
          c.brIf(1);
          c.localGet(I);
          c.i32Const(1);
          c.i32Add();
          c.localSet(I);
          c.br(0);
          c.end();
          c.end();
          c.localGet(I);
          to();
          c.i32Eq();
          c.localSet(LAST);
          // The element [START, I): a hex group, or (last element of the
          // tail side) an IPv4 address worth two units.
          c.localGet(S);
          c.localGet(START);
          c.localGet(I);
          c.call(this.hexGroupHelper());
          c.ifVoid();
          c.localGet(UNITS);
          c.i32Const(1);
          c.i32Add();
          c.localSet(UNITS);
          c.else_();
          if (tailSide) {
            c.localGet(LAST);
            c.localGet(S);
            c.localGet(START);
            c.localGet(I);
            c.call(this.isIPv4Helper());
            c.i32And();
            c.ifVoid();
            c.localGet(UNITS);
            c.i32Const(2);
            c.i32Add();
            c.localSet(UNITS);
            c.else_();
            c.i32Const(0);
            c.return_();
            c.end();
          } else {
            c.i32Const(0);
            c.return_();
          }
          c.end();
          // The end of the side, or ":" and the next element (which must
          // not be empty).
          c.localGet(LAST);
          c.brIf(2);
          c.localGet(I);
          c.i32Const(1);
          c.i32Add();
          c.localTee(START);
          to();
          c.i32GeU();
          c.ifVoid();
          c.i32Const(0);
          c.return_();
          c.end();
        });
        c.end();
      };
      this.if_(c, () => {
        c.localGet(DC);
        c.i32Const(0);
        c.i32LtS();
      }, () => {
        side(() => c.i32Const(0), () => c.localGet(END), true);
        c.localGet(UNITS);
        c.i32Const(8);
        c.i32Eq();
        c.ifResult(I32);
        c.i32Const(6);
        c.else_();
        c.i32Const(0);
        c.end();
        c.return_();
      });
      side(() => c.i32Const(0), () => c.localGet(DC), false);
      side(() => {
        c.localGet(DC);
        c.i32Const(2);
        c.i32Add();
      }, () => c.localGet(END), true);
      c.localGet(UNITS);
      c.i32Const(7);
      c.i32LeU();
      c.ifResult(I32);
      c.i32Const(6);
      c.else_();
      c.i32Const(0);
      c.end();
    });
  }

  /* ── shared small pieces ───────────────────────────────────────────── */

  /** After a call that may run a listener: an exception pending means the
   * program is dying (every emission here runs from an event, a tick or
   * the closing phase) — stop, exactly where Node's stack unwinds. */
  private excReturn(c: Code, push?: () => void): void {
    c.globalGet(this.deps.excKind());
    c.ifVoid();
    if (push !== undefined) push();
    c.return_();
    c.end();
  }

  /** Readable.writable's getter (Writable's): not destroyed, not errored,
   * not ending, not ended. */
  private writableHelper(): number {
    return this.fn("writable", [this.sockRef()], [I32], (f) => {
      const c = f.c;
      this.sbits(f.c, 0, S_WS, kDestroyed | kErrored | wEnding | wEnded);
      c.i32Eqz();
    });
  }

  /** Readable.readable's getter: not destroyed, no error emitted, no end
   * emitted. */
  readableHelper(): number {
    return this.fn("readable", [this.sockRef()], [I32], (f) => {
      const c = f.c;
      this.sbits(c, 0, S_RS, kDestroyed | kErrorEmitted | kEndEmitted);
      c.i32Eqz();
    });
  }

  /** Duplex.destroyed: both sides destroyed. */
  destroyedHelper(): number {
    return this.fn("destroyed", [this.sockRef()], [I32], (f) => {
      const c = f.c;
      this.sbits(c, 0, S_RS, kDestroyed);
      this.sbits(c, 0, S_WS, kDestroyed);
      c.i32And();
    });
  }

  /** writable public getter (the same as Writable.prototype.writable). */
  writableGetterHelper(): number {
    return this.writableHelper();
  }

  private destroyedErr(c: Code, name: string): void {
    this.nodeErr(c, `Cannot call ${name} after a stream was destroyed`, "ERR_STREAM_DESTROYED");
  }

  /* ── the Readable side ─────────────────────────────────────────────── */

  /** isPaused(): kPaused, or flowing explicitly false. */
  private isPausedHelper(): number {
    return this.fn("isPaused", [this.sockRef()], [I32], (f) => {
      const c = f.c;
      this.sbits(c, 0, S_RS, kPaused);
      this.sbitsEq(c, 0, S_RS, kHasFlowing | kFlowing, kHasFlowing);
      c.i32Or();
    });
  }

  /** canPushMore(state) */
  private canPushMore(c: Code, s: number): void {
    this.sbits(c, s, S_RS, kEnded);
    c.i32Eqz();
    this.sget(c, s, S_RLEN);
    c.i32Const(HWM);
    c.i32LtS();
    this.sget(c, s, S_RLEN);
    c.i32Eqz();
    c.i32Or();
    c.i32And();
  }

  /** Append one chunk to the readable buffer (grows by copy). */
  private bufPushHelper(): number {
    return this.fn("bufPush", [this.sockRef(), this.bytesRef], [], (f) => {
      const c = f.c;
      const S = 0;
      const B = 1;
      const NA = f.local(this.ref(this.chunkArrT));
      this.if_(c, () => {
        this.sget(c, S, S_RBUF);
        c.refIsNull();
      }, () => {
        this.sset(c, S, S_RBUF, () => {
          c.i32Const(8);
          c.arrayNewDefault(this.chunkArrT);
        });
        this.sset(c, S, S_RHEAD, () => c.i32Const(0));
        this.sset(c, S, S_RN, () => c.i32Const(0));
      });
      this.if_(c, () => {
        this.sget(c, S, S_RN);
        this.sget(c, S, S_RBUF);
        c.arrayLen();
        c.i32GeU();
      }, () => {
        this.sget(c, S, S_RBUF);
        c.arrayLen();
        c.i32Const(1);
        c.i32Shl();
        c.arrayNewDefault(this.chunkArrT);
        c.localSet(NA);
        c.localGet(NA);
        c.i32Const(0);
        this.sget(c, S, S_RBUF);
        c.i32Const(0);
        this.sget(c, S, S_RN);
        c.arrayCopy(this.chunkArrT, this.chunkArrT);
        this.sset(c, S, S_RBUF, () => c.localGet(NA));
      });
      this.sget(c, S, S_RBUF);
      this.sget(c, S, S_RN);
      c.localGet(B);
      c.arraySet(this.chunkArrT);
      this.sset(c, S, S_RN, () => {
        this.sget(c, S, S_RN);
        c.i32Const(1);
        c.i32Add();
      });
    });
  }

  /** readableAddChunkPushByteMode(stream, state, chunk) for a Buffer
   * chunk -> push()'s answer. */
  private pushHelper(): number {
    return this.fn("push", [this.sockRef(), this.bytesRef], [I32], (f) => {
      const c = f.c;
      const S = 0;
      const B = 1;
      this.if_(c, () => {
        c.localGet(B);
        c.structGet(this.deps.bytesType(), 2);
        c.i32Const(0);
        c.i32LeS();
      }, () => {
        this.sbitClr(c, S, S_RS, kReading);
        c.localGet(S);
        c.call(this.maybeReadMoreHelper());
        this.canPushMore(c, S);
        c.return_();
      });
      this.if_(c, () => this.sbits(c, S, S_RS, kEnded), () => {
        c.localGet(S);
        this.nodeErr(c, "stream.push() after EOF", "ERR_STREAM_PUSH_AFTER_EOF");
        c.i32Const(0);
        c.call(this.errorOrDestroyHelper());
        c.i32Const(0);
        c.return_();
      });
      this.if_(c, () => this.sbits(c, S, S_RS, kDestroyed | kErrored), () => {
        c.i32Const(0);
        c.return_();
      });
      this.sbitClr(c, S, S_RS, kReading);
      c.localGet(S);
      c.localGet(B);
      c.call(this.addChunkHelper());
      this.excReturn(c, () => c.i32Const(0));
      this.canPushMore(c, S);
    });
  }

  /** push(null): onEofChunk. */
  private pushNullHelper(): number {
    return this.fn("pushNull", [this.sockRef()], [], (f) => {
      const c = f.c;
      const S = 0;
      this.sbitClr(c, S, S_RS, kReading);
      this.if_(c, () => this.sbits(c, S, S_RS, kEnded), () => c.return_());
      this.sbitSet(c, S, S_RS, kEnded);
      this.if_(c, () => this.sbits(c, S, S_RS, kSync), () => {
        c.localGet(S);
        c.call(this.emitReadableHelper());
      }, () => {
        this.sbitClr(c, S, S_RS, kNeedReadable);
        this.sbitSet(c, S, S_RS, kEmittedReadable);
        c.localGet(S);
        c.call(this.emitReadableNowHelper());
      });
    });
  }

  /** addChunk(stream, state, chunk, false) */
  private addChunkHelper(): number {
    return this.fn("addChunk", [this.sockRef(), this.bytesRef], [], (f) => {
      const c = f.c;
      const S = 0;
      const B = 1;
      this.if_(c, () => {
        this.sbitsEq(c, S, S_RS, kFlowing | kSync | kDataListening, kFlowing | kDataListening);
        this.sget(c, S, S_RLEN);
        c.i32Eqz();
        c.i32And();
      }, () => {
        c.localGet(S);
        c.localGet(B);
        c.call(this.emitHelper(L_DATA));
        c.drop();
        this.excReturn(c);
      }, () => {
        this.sset(c, S, S_RLEN, () => {
          this.sget(c, S, S_RLEN);
          c.localGet(B);
          c.structGet(this.deps.bytesType(), 2);
          c.i32Add();
        });
        c.localGet(S);
        c.localGet(B);
        c.call(this.bufPushHelper());
        this.if_(c, () => this.sbits(c, S, S_RS, kNeedReadable), () => {
          c.localGet(S);
          c.call(this.emitReadableHelper());
        });
      });
      c.localGet(S);
      c.call(this.maybeReadMoreHelper());
    });
  }

  /** maybeReadMore(stream, state) */
  private maybeReadMoreHelper(): number {
    return this.fn("maybeReadMore", [this.sockRef()], [], (f) => {
      const c = f.c;
      const S = 0;
      this.if_(c, () => {
        this.sbits(c, S, S_RS, kReadingMore | kReading);
        c.i32Eqz();
      }, () => {
        this.sbitSet(c, S, S_RS, kReadingMore);
        this.nextTick(c, this.maybeReadMoreTick(), { sock: () => c.localGet(S) });
      });
    });
  }

  private maybeReadMoreTick(): number {
    return this.tickFn("maybeReadMore_", (f, e) => {
      const c = f.c;
      const S = e.sock;
      const LEN = f.local(I32);
      c.block();
      c.loop();
      // while (!reading && !ended && (length < hwm || (flowing && length === 0)))
      this.sbits(c, S, S_RS, kReading | kEnded);
      c.i32Eqz();
      this.sget(c, S, S_RLEN);
      c.i32Const(HWM);
      c.i32LtS();
      this.sbits(c, S, S_RS, kFlowing);
      this.sget(c, S, S_RLEN);
      c.i32Eqz();
      c.i32And();
      c.i32Or();
      c.i32And();
      c.i32Eqz();
      c.brIf(1);
      this.sget(c, S, S_RLEN);
      c.localSet(LEN);
      c.localGet(S);
      c.f64Const(0);
      c.call(this.readHelper());
      c.drop();
      this.excReturn(c);
      c.localGet(LEN);
      this.sget(c, S, S_RLEN);
      c.i32Eq();
      c.brIf(1);
      c.br(0);
      c.end();
      c.end();
      this.sbitClr(c, S, S_RS, kReadingMore);
    });
  }

  /** emitReadable(stream) */
  private emitReadableHelper(): number {
    return this.fn("emitReadable", [this.sockRef()], [], (f) => {
      const c = f.c;
      const S = 0;
      this.sbitClr(c, S, S_RS, kNeedReadable);
      this.if_(c, () => {
        this.sbits(c, S, S_RS, kEmittedReadable);
        c.i32Eqz();
      }, () => {
        this.sbitSet(c, S, S_RS, kEmittedReadable);
        this.nextTick(c, this.emitReadableTick(), { sock: () => c.localGet(S) });
      });
    });
  }

  private emitReadableTick(): number {
    return this.tickFn("emitReadable_", (f, e) => {
      f.c.localGet(e.sock);
      f.c.call(this.emitReadableNowHelper());
    });
  }

  /** emitReadable_(stream): 'readable' (no listener can exist here), then
   * flow(). */
  private emitReadableNowHelper(): number {
    return this.fn("emitReadable_", [this.sockRef()], [], (f) => {
      const c = f.c;
      const S = 0;
      this.if_(c, () => {
        this.sbits(c, S, S_RS, kDestroyed | kErrored);
        c.i32Eqz();
        this.sget(c, S, S_RLEN);
        c.i32Const(0);
        c.i32Ne();
        this.sbits(c, S, S_RS, kEnded);
        c.i32Or();
        c.i32And();
      }, () => this.sbitClr(c, S, S_RS, kEmittedReadable));
      this.if_(c, () => {
        this.sbits(c, S, S_RS, kFlowing | kEnded);
        c.i32Eqz();
        this.sget(c, S, S_RLEN);
        c.i32Const(HWM);
        c.i32LeS();
        c.i32And();
      }, () => this.sbitSet(c, S, S_RS, kNeedReadable));
      c.localGet(S);
      c.call(this.flowHelper());
    });
  }

  /** flow(stream): while (flowing && read() !== null); */
  private flowHelper(): number {
    return this.fn("flow", [this.sockRef()], [], (f) => {
      const c = f.c;
      const S = 0;
      c.block();
      c.loop();
      this.sbits(c, S, S_RS, kFlowing);
      c.i32Eqz();
      c.brIf(1);
      c.localGet(S);
      c.f64Const(NaN);
      c.call(this.readHelper());
      c.refIsNull();
      this.excReturn(c);
      c.brIf(1);
      c.br(0);
      c.end();
      c.end();
    });
  }

  /** howMuchToRead(n, state) */
  private howMuchHelper(): number {
    return this.fn("howMuch", [this.sockRef(), F64], [F64], (f) => {
      const c = f.c;
      const S = 0;
      const N = 1;
      this.if_(c, () => {
        c.localGet(N);
        c.f64Const(0);
        c.f64Le();
        this.sget(c, S, S_RLEN);
        c.i32Eqz();
        this.sbits(c, S, S_RS, kEnded);
        c.i32And();
        c.i32Or();
      }, () => {
        c.f64Const(0);
        c.return_();
      });
      this.if_(c, () => {
        c.localGet(N);
        c.localGet(N);
        c.f64Ne();
      }, () => {
        this.if_(c, () => {
          this.sbits(c, S, S_RS, kFlowing);
          this.sget(c, S, S_RLEN);
          c.i32Const(0);
          c.i32Ne();
          c.i32And();
        }, () => {
          this.sget(c, S, S_RBUF);
          this.sget(c, S, S_RHEAD);
          c.arrayGet(this.chunkArrT);
          c.structGet(this.deps.bytesType(), 2);
          c.f64ConvertI32S();
          c.return_();
        });
        this.sget(c, S, S_RLEN);
        c.f64ConvertI32S();
        c.return_();
      });
      this.if_(c, () => {
        c.localGet(N);
        this.sget(c, S, S_RLEN);
        c.f64ConvertI32S();
        c.f64Le();
      }, () => {
        c.localGet(N);
        c.return_();
      });
      this.sbits(c, S, S_RS, kEnded);
      c.ifResult(F64);
      this.sget(c, S, S_RLEN);
      c.f64ConvertI32S();
      c.else_();
      c.f64Const(0);
      c.end();
    });
  }

  /** A view of `b` from `off` for `len` bytes (Buffer.slice shares). */
  private slice(c: Code, b: number, off: () => void, len: () => void): void {
    const bt = this.deps.bytesType();
    c.localGet(b);
    c.structGet(bt, 0);
    c.localGet(b);
    c.structGet(bt, 1);
    off();
    c.i32Add();
    len();
    c.structNew(bt);
  }

  /** fromList(n, state) — n > 0 bytes off the front of the buffer. */
  private fromListHelper(): number {
    return this.fn("fromList", [this.sockRef(), I32], [this.bytesRef], (f) => {
      const c = f.c;
      const S = 0;
      const N = 1;
      const bt = this.deps.bytesType();
      const bufT = this.deps.bufType();
      const FIRST = f.local(this.bytesRef);
      const DST = f.local(this.ref(bufT));
      const AT = f.local(I32);
      const I = f.local(I32);
      const CH = f.local(this.bytesRef);
      const TAKE = f.local(I32);
      const copyInto = (): void => {
        // DST[AT ..] = CH[0 .. TAKE)
        c.localGet(DST);
        c.localGet(AT);
        c.localGet(CH);
        c.structGet(bt, 0);
        c.localGet(CH);
        c.structGet(bt, 1);
        c.localGet(TAKE);
        c.arrayCopy(bufT, bufT);
        c.localGet(AT);
        c.localGet(TAKE);
        c.i32Add();
        c.localSet(AT);
      };
      const reset = (): void => {
        this.sset(c, S, S_RBUF, () => c.refNull(this.chunkArrT));
        this.sset(c, S, S_RHEAD, () => c.i32Const(0));
        this.sset(c, S, S_RN, () => c.i32Const(0));
      };
      this.if_(c, () => {
        this.sget(c, S, S_RLEN);
        c.i32Eqz();
      }, () => {
        c.refNull(bt);
        c.return_();
      });
      // Read it all.
      this.if_(c, () => {
        c.localGet(N);
        this.sget(c, S, S_RLEN);
        c.i32GeS();
      }, () => {
        this.if_(c, () => {
          this.sget(c, S, S_RN);
          this.sget(c, S, S_RHEAD);
          c.i32Sub();
          c.i32Const(1);
          c.i32Eq();
        }, () => {
          this.sget(c, S, S_RBUF);
          this.sget(c, S, S_RHEAD);
          c.arrayGet(this.chunkArrT);
          c.localSet(FIRST);
          reset();
          c.localGet(FIRST);
          c.return_();
        });
        this.sget(c, S, S_RLEN);
        c.arrayNewDefault(bufT);
        c.localSet(DST);
        this.sget(c, S, S_RHEAD);
        c.localSet(I);
        this.while_(c, () => {
          c.localGet(I);
          this.sget(c, S, S_RN);
          c.i32LtS();
        }, () => {
          this.sget(c, S, S_RBUF);
          c.localGet(I);
          c.arrayGet(this.chunkArrT);
          c.localTee(CH);
          c.structGet(bt, 2);
          c.localSet(TAKE);
          copyInto();
          c.localGet(I);
          c.i32Const(1);
          c.i32Add();
          c.localSet(I);
        });
        reset();
        c.localGet(DST);
        c.refAsNonNull();
        c.i32Const(0);
        c.localGet(AT);
        c.structNew(bt);
        c.return_();
      });
      this.sget(c, S, S_RBUF);
      this.sget(c, S, S_RHEAD);
      c.arrayGet(this.chunkArrT);
      c.localSet(FIRST);
      // A part of the first chunk.
      this.if_(c, () => {
        c.localGet(N);
        c.localGet(FIRST);
        c.structGet(bt, 2);
        c.i32LtS();
      }, () => {
        this.sget(c, S, S_RBUF);
        this.sget(c, S, S_RHEAD);
        this.slice(c, FIRST, () => c.localGet(N), () => {
          c.localGet(FIRST);
          c.structGet(bt, 2);
          c.localGet(N);
          c.i32Sub();
        });
        c.arraySet(this.chunkArrT);
        this.slice(c, FIRST, () => c.i32Const(0), () => c.localGet(N));
        c.return_();
      });
      // Exactly the first chunk.
      this.if_(c, () => {
        c.localGet(N);
        c.localGet(FIRST);
        c.structGet(bt, 2);
        c.i32Eq();
      }, () => {
        this.sget(c, S, S_RBUF);
        this.sget(c, S, S_RHEAD);
        c.refNull(bt);
        c.arraySet(this.chunkArrT);
        this.sset(c, S, S_RHEAD, () => {
          this.sget(c, S, S_RHEAD);
          c.i32Const(1);
          c.i32Add();
        });
        this.if_(c, () => {
          this.sget(c, S, S_RHEAD);
          this.sget(c, S, S_RN);
          c.i32Eq();
        }, reset);
        c.localGet(FIRST);
        c.return_();
      });
      // n spans chunks: copy whole chunks, then the head of the last.
      c.localGet(N);
      c.arrayNewDefault(bufT);
      c.localSet(DST);
      this.while_(c, () => {
        c.localGet(AT);
        c.localGet(N);
        c.i32LtS();
      }, () => {
        this.sget(c, S, S_RBUF);
        this.sget(c, S, S_RHEAD);
        c.arrayGet(this.chunkArrT);
        c.localSet(CH);
        this.if_(c, () => {
          c.localGet(N);
          c.localGet(AT);
          c.i32Sub();
          c.localGet(CH);
          c.structGet(bt, 2);
          c.i32GeS();
        }, () => {
          c.localGet(CH);
          c.structGet(bt, 2);
          c.localSet(TAKE);
          copyInto();
          this.sget(c, S, S_RBUF);
          this.sget(c, S, S_RHEAD);
          c.refNull(bt);
          c.arraySet(this.chunkArrT);
          this.sset(c, S, S_RHEAD, () => {
            this.sget(c, S, S_RHEAD);
            c.i32Const(1);
            c.i32Add();
          });
        }, () => {
          c.localGet(N);
          c.localGet(AT);
          c.i32Sub();
          c.localSet(TAKE);
          // The rest of this chunk stays.
          this.sget(c, S, S_RBUF);
          this.sget(c, S, S_RHEAD);
          this.slice(c, CH, () => c.localGet(TAKE), () => {
            c.localGet(CH);
            c.structGet(bt, 2);
            c.localGet(TAKE);
            c.i32Sub();
          });
          c.arraySet(this.chunkArrT);
          copyInto();
        });
      });
      this.if_(c, () => {
        this.sget(c, S, S_RHEAD);
        this.sget(c, S, S_RN);
        c.i32Eq();
      }, reset);
      c.localGet(DST);
      c.refAsNonNull();
      c.i32Const(0);
      c.localGet(N);
      c.structNew(bt);
    });
  }

  /** Readable.prototype.read(n) — n is 0, or NaN for read(). */
  private readHelper(): number {
    return this.fn("read", [this.sockRef(), F64], [this.bytesRef], (f) => {
      const c = f.c;
      const S = 0;
      const N = 1;
      const NORIG = f.local(F64);
      const DOREAD = f.local(I32);
      const RET = f.local(this.bytesRef);
      const howMuch = (from: number): void => {
        c.localGet(S);
        c.localGet(from);
        c.call(this.howMuchHelper());
        c.localSet(N);
      };
      c.localGet(N);
      c.localSet(NORIG);
      this.if_(c, () => {
        c.localGet(N);
        c.f64Const(0);
        c.f64Ne();
      }, () => this.sbitClr(c, S, S_RS, kEmittedReadable));
      this.if_(c, () => {
        c.localGet(N);
        c.f64Const(0);
        c.f64Eq();
        this.sbits(c, S, S_RS, kNeedReadable);
        c.i32And();
        this.sget(c, S, S_RLEN);
        c.i32Const(HWM);
        c.i32GeS();
        this.sbits(c, S, S_RS, kEnded);
        c.i32Or();
        c.i32And();
      }, () => {
        this.if_(c, () => {
          this.sget(c, S, S_RLEN);
          c.i32Eqz();
          this.sbits(c, S, S_RS, kEnded);
          c.i32And();
        }, () => {
          c.localGet(S);
          c.call(this.endReadableHelper());
        }, () => {
          c.localGet(S);
          c.call(this.emitReadableHelper());
        });
        c.refNull(this.deps.bytesType());
        c.return_();
      });
      howMuch(N);
      this.if_(c, () => {
        c.localGet(N);
        c.f64Const(0);
        c.f64Eq();
        this.sbits(c, S, S_RS, kEnded);
        c.i32And();
      }, () => {
        this.if_(c, () => {
          this.sget(c, S, S_RLEN);
          c.i32Eqz();
        }, () => {
          c.localGet(S);
          c.call(this.endReadableHelper());
        });
        c.refNull(this.deps.bytesType());
        c.return_();
      });
      this.sbits(c, S, S_RS, kNeedReadable);
      c.localSet(DOREAD);
      this.if_(c, () => {
        this.sget(c, S, S_RLEN);
        c.i32Eqz();
        this.sget(c, S, S_RLEN);
        c.f64ConvertI32S();
        c.localGet(N);
        c.f64Sub();
        c.f64Const(HWM);
        c.f64Lt();
        c.i32Or();
      }, () => {
        c.i32Const(1);
        c.localSet(DOREAD);
      });
      this.if_(c, () => this.sbits(c, S, S_RS, kReading | kEnded | kDestroyed | kErrored), () => {
        c.i32Const(0);
        c.localSet(DOREAD);
      }, () => {
        this.if_(c, () => c.localGet(DOREAD), () => {
          this.sbitSet(c, S, S_RS, kReading | kSync);
          this.if_(c, () => {
            this.sget(c, S, S_RLEN);
            c.i32Eqz();
          }, () => this.sbitSet(c, S, S_RS, kNeedReadable));
          c.localGet(S);
          c.call(this.socketReadHelper());
          this.sbitClr(c, S, S_RS, kSync);
          this.if_(c, () => {
            this.sbits(c, S, S_RS, kReading);
            c.i32Eqz();
          }, () => howMuch(NORIG));
        });
      });
      this.if_(c, () => {
        c.localGet(N);
        c.f64Const(0);
        c.f64Gt();
      }, () => {
        c.localGet(S);
        c.localGet(N);
        c.i32TruncF64S();
        c.call(this.fromListHelper());
        c.localSet(RET);
      });
      this.if_(c, () => {
        c.localGet(RET);
        c.refIsNull();
      }, () => {
        this.if_(c, () => {
          this.sget(c, S, S_RLEN);
          c.i32Const(HWM);
          c.i32LeS();
        }, () => this.sbitSet(c, S, S_RS, kNeedReadable));
        c.f64Const(0);
        c.localSet(N);
      }, () => {
        this.sset(c, S, S_RLEN, () => {
          this.sget(c, S, S_RLEN);
          c.localGet(N);
          c.i32TruncF64S();
          c.i32Sub();
        });
      });
      this.if_(c, () => {
        this.sget(c, S, S_RLEN);
        c.i32Eqz();
      }, () => {
        this.if_(c, () => {
          this.sbits(c, S, S_RS, kEnded);
          c.i32Eqz();
        }, () => this.sbitSet(c, S, S_RS, kNeedReadable));
        this.if_(c, () => {
          c.localGet(NORIG);
          c.localGet(N);
          c.f64Ne();
          this.sbits(c, S, S_RS, kEnded);
          c.i32And();
        }, () => {
          c.localGet(S);
          c.call(this.endReadableHelper());
        });
      });
      this.if_(c, () => {
        c.localGet(RET);
        c.refIsNull();
        c.i32Eqz();
        this.sbits(c, S, S_RS, kErrorEmitted | kCloseEmitted);
        c.i32Eqz();
        c.i32And();
      }, () => {
        c.localGet(S);
        c.localGet(RET);
        c.call(this.emitHelper(L_DATA));
        c.drop();
      });
      c.localGet(RET);
    });
  }

  /** endReadable(stream) */
  private endReadableHelper(): number {
    return this.fn("endReadable", [this.sockRef()], [], (f) => {
      const c = f.c;
      const S = 0;
      this.if_(c, () => {
        this.sbits(c, S, S_RS, kEndEmitted);
        c.i32Eqz();
      }, () => {
        this.sbitSet(c, S, S_RS, kEnded);
        this.nextTick(c, this.endReadableTick(), { sock: () => c.localGet(S) });
      });
    });
  }

  /** endReadableNT(state, stream) */
  private endReadableTick(): number {
    return this.tickFn("endReadableNT", (f, e) => {
      const c = f.c;
      const S = e.sock;
      this.if_(c, () => {
        this.sbits(c, S, S_RS, kErrored | kCloseEmitted | kEndEmitted);
        c.i32Eqz();
        this.sget(c, S, S_RLEN);
        c.i32Eqz();
        c.i32And();
      }, () => {
        this.sbitSet(c, S, S_RS, kEndEmitted);
        c.localGet(S);
        c.call(this.emitHelper(L_END));
        c.drop();
        this.excReturn(c);
        // A Socket's allowHalfOpen is false here (no lowering sets it) —
        // except an http server's (INC-29 U2), which is true.
        this.if_(c, () => {
          c.localGet(S);
          c.call(this.writableHelper());
          if (this.deps.http !== undefined) {
            this.sget(c, S, S_HALFOPEN);
            c.i32Eqz();
            c.i32And();
          }
        }, () => {
          this.nextTick(c, this.endWritableTick(), { sock: () => c.localGet(S) });
        }, () => {
          this.if_(c, () => this.sbits(c, S, S_WS, wFinished), () => {
            c.localGet(S);
            c.refNull(this.deps.errType());
            c.call(this.destroyHelper());
          });
        });
      });
    });
  }

  /** endWritableNT(stream) */
  private endWritableTick(): number {
    return this.tickFn("endWritableNT", (f, e) => {
      const c = f.c;
      const S = e.sock;
      this.if_(c, () => {
        c.localGet(S);
        c.call(this.writableHelper());
        this.sbits(c, S, S_WS, wEnding);
        c.i32Eqz();
        c.i32And();
        c.localGet(S);
        c.call(this.destroyedHelper());
        c.i32Eqz();
        c.i32And();
      }, () => {
        c.localGet(S);
        c.refNull(this.deps.bytesType());
        c.i32Const(0);
        c.refNull(this.deps.errClos().clos);
        c.call(this.endHelper());
      });
    });
  }

  /** Readable.prototype.resume (a Socket's resume adds nothing without
   * the onread buffer option). */
  resumeHelper(): number {
    return this.fn("resume", [this.sockRef()], [], (f) => {
      const c = f.c;
      const S = 0;
      this.if_(c, () => {
        this.sbits(c, S, S_RS, kFlowing);
        c.i32Eqz();
      }, () => {
        this.sbitSet(c, S, S_RS, kHasFlowing | kFlowing);
        this.if_(c, () => {
          this.sbits(c, S, S_RS, kResumeScheduled);
          c.i32Eqz();
        }, () => {
          this.sbitSet(c, S, S_RS, kResumeScheduled);
          this.nextTick(c, this.resumeTick(), { sock: () => c.localGet(S) });
        });
      });
      this.sbitSet(c, S, S_RS, kHasPaused);
      this.sbitClr(c, S, S_RS, kPaused);
    });
  }

  /** resume_(stream, state) */
  private resumeTick(): number {
    return this.tickFn("resume_", (f, e) => {
      const c = f.c;
      const S = e.sock;
      this.if_(c, () => {
        this.sbits(c, S, S_RS, kReading);
        c.i32Eqz();
      }, () => {
        c.localGet(S);
        c.f64Const(0);
        c.call(this.readHelper());
        c.drop();
        this.excReturn(c);
      });
      this.sbitClr(c, S, S_RS, kResumeScheduled);
      // INC-29 U2: stream.emit('resume') — an http server listens for it.
      if (this.deps.http !== undefined) {
        c.localGet(S);
        c.call(this.emitHelper(L_RESUME));
        c.drop();
        this.excReturn(c);
      }
      c.localGet(S);
      c.call(this.flowHelper());
      this.excReturn(c);
      this.if_(c, () => this.sbitsEq(c, S, S_RS, kFlowing | kReading, kFlowing), () => {
        c.localGet(S);
        c.f64Const(0);
        c.call(this.readHelper());
        c.drop();
      });
    });
  }

  /** Readable.prototype.pause */
  pauseHelper(): number {
    return this.fn("pause", [this.sockRef()], [], (f) => {
      const c = f.c;
      const S = 0;
      this.if_(c, () => {
        this.sbitsEq(c, S, S_RS, kHasFlowing | kFlowing, kHasFlowing);
        c.i32Eqz();
      }, () => {
        this.sbitSet(c, S, S_RS, kHasFlowing);
        this.sbitClr(c, S, S_RS, kFlowing);
        // INC-29 U2: this.emit('pause') — an http server listens for it.
        if (this.deps.http !== undefined) {
          c.localGet(S);
          c.call(this.emitHelper(L_PAUSE));
          c.drop();
        }
      });
      this.sbitSet(c, S, S_RS, kHasPaused | kPaused);
    });
  }

  /** Readable.prototype.on('data', ...)'s own side: kDataListening, and
   * resume() unless the stream was explicitly paused. Called after the
   * listener is added. */
  dataAddedHelper(): number {
    return this.fn("dataAdded", [this.sockRef()], [], (f) => {
      const c = f.c;
      const S = 0;
      this.sbitSet(c, S, S_RS, kDataListening);
      this.if_(c, () => {
        this.sbitsEq(c, S, S_RS, kHasFlowing | kFlowing, kHasFlowing);
        c.i32Eqz();
      }, () => {
        c.localGet(S);
        c.call(this.resumeHelper());
      });
    });
  }

  /** Socket.prototype._read */
  private socketReadHelper(): number {
    return this.fn("_read", [this.sockRef()], [], (f) => {
      const c = f.c;
      const S = 0;
      this.if_(c, () => {
        this.sget(c, S, S_CONNECTING);
        this.sget(c, S, S_HAS_HANDLE);
        c.i32Eqz();
        c.i32Or();
      }, () => {
        c.localGet(S);
        this.closure(c, this.readOnConnectTick(), { sock: () => c.localGet(S) });
        c.i32Const(1);
        c.i32Const(0);
        c.call(this.addHelper(L_CONNECT));
      }, () => {
        this.if_(c, () => {
          this.sget(c, S, S_READING);
          c.i32Eqz();
        }, () => {
          c.localGet(S);
          c.call(this.tryReadStartHelper());
        });
      });
    });
  }

  /** this.once('connect', () => this._read(n)) */
  private readOnConnectTick(): number {
    return this.tickFn("readOnConnect", (f, e) => {
      f.c.localGet(e.sock);
      f.c.call(this.socketReadHelper());
    });
  }

  /** tryReadStart(socket) */
  private tryReadStartHelper(): number {
    return this.fn("tryReadStart", [this.sockRef()], [], (f) => {
      const c = f.c;
      const S = 0;
      const R = f.local(I32);
      this.if_(c, () => {
        this.sget(c, S, S_H);
        c.i32Eqz();
      }, () => this.trap(c));
      this.sset(c, S, S_READING, () => c.i32Const(1));
      c.i32Const(OP_READ_START);
      c.i32Const(0);
      c.i32Const(0);
      this.sget(c, S, S_H);
      c.i32Const(0);
      this.netCall(c);
      c.localSet(R);
      this.if_(c, () => {
        c.localGet(R);
        c.i32Const(0);
        c.i32GtS();
      }, () => this.trap(c));
      this.if_(c, () => {
        c.localGet(R);
        c.i32Const(0);
        c.i32LtS();
      }, () => {
        c.localGet(S);
        c.localGet(R);
        this.lit(c, "read");
        c.call(this.errnoExHelper());
        c.call(this.destroyHelper());
      });
    });
  }

  /* ── the Writable side ─────────────────────────────────────────────── */

  /** Append one buffered write. */
  private wbufPushHelper(): number {
    return this.fn("wbufPush", [this.sockRef(), this.ref(this.wreqT)], [], (f) => {
      const c = f.c;
      const S = 0;
      const E = 1;
      const NA = f.local(this.ref(this.wreqArrT));
      this.if_(c, () => {
        this.sget(c, S, S_WBUF);
        c.refIsNull();
      }, () => {
        this.sset(c, S, S_WBUF, () => {
          c.i32Const(4);
          c.arrayNewDefault(this.wreqArrT);
        });
      });
      this.if_(c, () => {
        this.sget(c, S, S_WBUFN);
        this.sget(c, S, S_WBUF);
        c.arrayLen();
        c.i32GeU();
      }, () => {
        this.sget(c, S, S_WBUF);
        c.arrayLen();
        c.i32Const(1);
        c.i32Shl();
        c.arrayNewDefault(this.wreqArrT);
        c.localSet(NA);
        c.localGet(NA);
        c.i32Const(0);
        this.sget(c, S, S_WBUF);
        c.i32Const(0);
        this.sget(c, S, S_WBUFN);
        c.arrayCopy(this.wreqArrT, this.wreqArrT);
        this.sset(c, S, S_WBUF, () => c.localGet(NA));
      });
      this.sget(c, S, S_WBUF);
      this.sget(c, S, S_WBUFN);
      c.localGet(E);
      c.arraySet(this.wreqArrT);
      this.sset(c, S, S_WBUFN, () => {
        this.sget(c, S, S_WBUFN);
        c.i32Const(1);
        c.i32Add();
      });
    });
  }

  private resetBuffer(c: Code, s: number): void {
    this.sset(c, s, S_WBUF, () => c.refNull(this.wreqArrT));
    this.sset(c, s, S_WBUFIDX, () => c.i32Const(0));
    this.sset(c, s, S_WBUFN, () => c.i32Const(0));
    this.sbitSet(c, s, S_WS, wAllNoop);
    this.sbitClr(c, s, S_WS, wBuffered);
  }

  /** Writable's _write(stream, chunk, encoding, cb) for a chunk already
   * in bytes (`len` is Node's length for it: a string's own length, a
   * Buffer's byte length) -> 1 / 0 (write()'s answer), or -1 when the
   * write-after-end / destroyed error was taken (that error in lastErr). */
  writeHelper(): number {
    return this.fn("write", [this.sockRef(), this.bytesRef, I32, this.eclosRef()], [I32], (f) => {
      const c = f.c;
      const S = 0;
      const B = 1;
      const LEN = 2;
      const CB = 3;
      const ERR = f.local(this.errRef);
      const g = this.g();
      this.if_(c, () => this.sbits(c, S, S_WS, wEnding), () => {
        this.nodeErr(c, "write after end", "ERR_STREAM_WRITE_AFTER_END");
        c.localSet(ERR);
      }, () => {
        this.if_(c, () => this.sbits(c, S, S_WS, kDestroyed), () => {
          this.destroyedErr(c, "write");
          c.localSet(ERR);
        });
      });
      this.if_(c, () => {
        c.localGet(ERR);
        c.refIsNull();
        c.i32Eqz();
      }, () => {
        c.localGet(ERR);
        c.globalSet(g.lastErr);
        this.if_(c, () => {
          c.localGet(CB);
          c.refIsNull();
          c.i32Eqz();
        }, () => {
          this.nextTick(c, this.cbTick(), { err: () => c.localGet(ERR), x: () => c.localGet(CB) });
        });
        c.localGet(S);
        c.localGet(ERR);
        c.i32Const(1);
        c.call(this.errorOrDestroyHelper());
        c.i32Const(-1);
        c.return_();
      });
      this.sset(c, S, S_PENDINGCB, () => {
        this.sget(c, S, S_PENDINGCB);
        c.i32Const(1);
        c.i32Add();
      });
      c.localGet(S);
      c.localGet(B);
      c.localGet(LEN);
      c.localGet(CB);
      c.call(this.writeOrBufferHelper());
    });
  }

  /** process.nextTick(cb, err) */
  private cbTick(): number {
    return this.tickFn("cb", (f, e) => {
      const c = f.c;
      this.callCb(c, () => {
        c.localGet(e.x);
        c.refCast(this.deps.errClos().clos);
      }, () => c.localGet(e.err));
    });
  }

  /** writeOrBuffer(stream, state, chunk, encoding, callback) */
  private writeOrBufferHelper(): number {
    return this.fn("writeOrBuffer", [this.sockRef(), this.bytesRef, I32, this.eclosRef()], [I32], (f) => {
      const c = f.c;
      const S = 0;
      const B = 1;
      const LEN = 2;
      const CB = 3;
      const RET = f.local(I32);
      this.sset(c, S, S_WLEN, () => {
        this.sget(c, S, S_WLEN);
        c.localGet(LEN);
        c.i32Add();
      });
      // INC-29 U2: a corked socket buffers too (http modules cork).
      const bufferMask = this.deps.http !== undefined ? wWriting | kErrored | wCorked : wWriting | kErrored;
      this.if_(c, () => this.sbits(c, S, S_WS, bufferMask), () => {
        c.localGet(S);
        c.localGet(B);
        c.localGet(LEN);
        c.localGet(CB);
        c.structNew(this.wreqT);
        c.call(this.wbufPushHelper());
        this.sbitSet(c, S, S_WS, wBuffered);
        this.if_(c, () => {
          c.localGet(CB);
          c.refIsNull();
          c.i32Eqz();
        }, () => this.sbitClr(c, S, S_WS, wAllNoop));
      }, () => {
        this.sset(c, S, S_WRITELEN, () => c.localGet(LEN));
        this.sset(c, S, S_WRITECB, () => c.localGet(CB));
        this.sbitSet(c, S, S_WS, wWriting | wSync | wExpectWriteCb);
        c.localGet(S);
        c.i32Const(0);
        c.localGet(B);
        c.call(this.writeGenericHelper());
        this.sbitClr(c, S, S_WS, wSync);
      });
      this.sget(c, S, S_WLEN);
      c.i32Const(HWM);
      c.i32LtS();
      this.sget(c, S, S_WLEN);
      c.i32Eqz();
      c.i32Or();
      c.localTee(RET);
      c.i32Eqz();
      c.ifVoid();
      this.sbitSet(c, S, S_WS, wNeedDrain);
      c.end();
      c.localGet(RET);
      this.sbits(c, S, S_WS, kDestroyed | kErrored);
      c.i32Eqz();
      c.i32And();
    });
  }

  /** doWrite(stream, state, writev, len, chunk, encoding, cb) */
  private doWriteHelper(): number {
    return this.fn("doWrite", [this.sockRef(), I32, I32, this.bytesRef, this.eclosRef()], [], (f) => {
      const c = f.c;
      const S = 0;
      const WRITEV = 1;
      const LEN = 2;
      const B = 3;
      const CB = 4;
      this.sset(c, S, S_WRITELEN, () => c.localGet(LEN));
      this.sset(c, S, S_WRITECB, () => c.localGet(CB));
      this.sbitSet(c, S, S_WS, wWriting | wSync | wExpectWriteCb);
      this.if_(c, () => this.sbits(c, S, S_WS, kDestroyed), () => {
        c.localGet(S);
        this.destroyedErr(c, "write");
        c.call(this.onwriteHelper());
      }, () => {
        c.localGet(S);
        c.localGet(WRITEV);
        c.localGet(B);
        c.call(this.writeGenericHelper());
      });
      this.sbitClr(c, S, S_WS, wSync);
    });
  }

  /** Socket.prototype._writeGeneric(writev, data, encoding, cb) with cb =
   * the Writable's onwrite; writeGeneric / afterWriteDispatched inlined. */
  private writeGenericHelper(): number {
    return this.fn("_writeGeneric", [this.sockRef(), I32, this.bytesRef], [], (f) => {
      const c = f.c;
      const S = 0;
      const WRITEV = 1;
      const B = 2;
      const ONCLOSE = f.local(this.ref(this.tickEnvT));
      const BASE = f.local(I32);
      const LEN = f.local(I32);
      const I = f.local(I32);
      const R = f.local(I32);
      const bt = this.deps.bytesType();
      // Still connecting: the data waits for 'connect' (and fails on an
      // earlier 'close').
      this.if_(c, () => this.sget(c, S, S_CONNECTING), () => {
        this.sset(c, S, S_PEND, () => c.localGet(B));
        this.closure(c, this.onCloseBeforeConnectTick(), { sock: () => c.localGet(S) });
        c.localSet(ONCLOSE);
        c.localGet(S);
        this.closure(c, this.writeOnConnectTick(), { sock: () => c.localGet(S), x: () => c.localGet(ONCLOSE), n: () => c.localGet(WRITEV) });
        c.i32Const(1);
        c.i32Const(0);
        c.call(this.addHelper(L_CONNECT));
        c.localGet(S);
        c.localGet(ONCLOSE);
        c.i32Const(1);
        c.i32Const(0);
        c.call(this.addHelper(L_CLOSE));
        c.return_();
      });
      this.sset(c, S, S_PEND, () => c.refNull(bt));
      this.if_(c, () => {
        this.sget(c, S, S_HAS_HANDLE);
        c.i32Eqz();
      }, () => {
        c.localGet(S);
        this.nodeErr(c, "Socket is closed", "ERR_SOCKET_CLOSED");
        c.call(this.onwriteHelper());
        c.return_();
      });
      this.if_(c, () => {
        this.sget(c, S, S_H);
        c.i32Eqz();
      }, () => this.trap(c));
      // INC-29 U2: this._unrefTimer()
      if (this.deps.http !== undefined) {
        c.localGet(S);
        c.call(this.unrefTimerHelper());
      }
      // INC-29 U4: a TLS socket before the module accepted its handshake
      // holds the write (tls.ts releases it): it is outstanding until then.
      if (this.deps.tls !== undefined) {
        const t = this.deps.tls;
        this.if_(c, () => {
          c.localGet(S);
          c.localGet(B);
          c.call(t.hold());
        }, () => {
          this.sset(c, S, S_DISPATCHED, () => {
            this.sget(c, S, S_DISPATCHED);
            c.localGet(B);
            c.structGet(bt, 2);
            c.f64ConvertI32S();
            c.f64Add();
          });
          this.sset(c, S, S_WPEND, () => c.i32Const(1));
          if (this.deps.http !== undefined) {
            this.sset(c, S, S_LWQS, () => {
              c.localGet(B);
              c.structGet(bt, 2);
            });
          }
          c.return_();
        });
      }
      // WRITE: the bytes at [ptr, ptr + len).
      c.localGet(B);
      c.structGet(bt, 2);
      c.localSet(LEN);
      this.deps.ensureCapacity(c, () => {
        c.localGet(LEN);
        c.i32Const(3);
        c.i32Add();
      });
      this.base(c, BASE);
      this.while_(c, () => {
        c.localGet(I);
        c.localGet(LEN);
        c.i32LtU();
      }, () => {
        c.localGet(BASE);
        c.localGet(I);
        c.i32Add();
        c.localGet(B);
        c.structGet(bt, 0);
        c.localGet(B);
        c.structGet(bt, 1);
        c.localGet(I);
        c.i32Add();
        c.arrayGetU(this.deps.bufType());
        c.i32Store8();
        c.localGet(I);
        c.i32Const(1);
        c.i32Add();
        c.localSet(I);
      });
      c.i32Const(OP_WRITE);
      c.localGet(BASE);
      c.localGet(LEN);
      this.sget(c, S, S_H);
      c.i32Const(0);
      this.netCall(c);
      c.localSet(R);
      this.if_(c, () => {
        c.localGet(R);
        c.i32Const(1);
        c.i32GtS();
      }, () => this.trap(c));
      this.if_(c, () => {
        c.localGet(R);
        c.i32Const(0);
        c.i32LtS();
      }, () => {
        c.localGet(S);
        c.localGet(R);
        this.lit(c, "write");
        c.call(this.errnoExHelper());
        c.call(this.onwriteHelper());
        c.return_();
      });
      this.sset(c, S, S_DISPATCHED, () => {
        this.sget(c, S, S_DISPATCHED);
        c.localGet(LEN);
        c.f64ConvertI32S();
        c.f64Add();
      });
      this.if_(c, () => c.localGet(R), () => {
        this.sset(c, S, S_WPEND, () => c.i32Const(1));
        // INC-29 U2: if (req.async) this[kLastWriteQueueSize] = req.bytes
        if (this.deps.http !== undefined) this.sset(c, S, S_LWQS, () => c.localGet(LEN));
      }, () => {
        c.localGet(S);
        c.refNull(this.deps.errType());
        c.call(this.onwriteHelper());
      });
    });
  }

  /** INC-29 U4: a held write's WRITE, once the module accepted the
   * handshake (tls.ts): the write is already outstanding (S_WPEND) and
   * counted; the host's answer completes it as _writeGeneric's would. */
  issueHeldHelper(): number {
    return this.fn("issueHeld", [this.sockRef(), this.bytesRef], [], (f) => {
      const c = f.c;
      const S = 0;
      const B = 1;
      const BASE = f.local(I32);
      const LEN = f.local(I32);
      const I = f.local(I32);
      const R = f.local(I32);
      const bt = this.deps.bytesType();
      c.localGet(B);
      c.structGet(bt, 2);
      c.localSet(LEN);
      this.deps.ensureCapacity(c, () => {
        c.localGet(LEN);
        c.i32Const(3);
        c.i32Add();
      });
      this.base(c, BASE);
      this.while_(c, () => {
        c.localGet(I);
        c.localGet(LEN);
        c.i32LtU();
      }, () => {
        c.localGet(BASE);
        c.localGet(I);
        c.i32Add();
        c.localGet(B);
        c.structGet(bt, 0);
        c.localGet(B);
        c.structGet(bt, 1);
        c.localGet(I);
        c.i32Add();
        c.arrayGetU(this.deps.bufType());
        c.i32Store8();
        c.localGet(I);
        c.i32Const(1);
        c.i32Add();
        c.localSet(I);
      });
      c.i32Const(OP_WRITE);
      c.localGet(BASE);
      c.localGet(LEN);
      this.sget(c, S, S_H);
      c.i32Const(0);
      this.netCall(c);
      c.localSet(R);
      this.if_(c, () => {
        c.localGet(R);
        c.i32Const(1);
        c.i32GtS();
      }, () => this.trap(c));
      this.if_(c, () => {
        c.localGet(R);
        c.i32Const(1);
        c.i32Ne();
      }, () => {
        this.sset(c, S, S_WPEND, () => c.i32Const(0));
        c.localGet(S);
        c.localGet(R);
        c.i32Const(0);
        c.i32LtS();
        c.ifResult(this.errRef);
        c.localGet(R);
        this.lit(c, "write");
        c.call(this.errnoExHelper());
        c.else_();
        c.refNull(this.deps.errType());
        c.end();
        c.call(this.onwriteHelper());
      });
    });
  }

  /** The deferred write's once('connect') listener: off('close', onClose),
   * then _writeGeneric again. */
  private writeOnConnectTick(): number {
    return this.tickFn("writeOnConnect", (f, e) => {
      const c = f.c;
      c.localGet(e.sock);
      c.localGet(e.x);
      c.call(this.removeHelper(L_CLOSE));
      c.localGet(e.sock);
      c.localGet(e.n);
      this.sget(c, e.sock, S_PEND);
      c.call(this.writeGenericHelper());
    });
  }

  /** The deferred write's once('close') listener. */
  private onCloseBeforeConnectTick(): number {
    return this.tickFn("onCloseBeforeConnect", (f, e) => {
      const c = f.c;
      c.localGet(e.sock);
      this.nodeErr(c, "Socket closed before the connection was established", "ERR_SOCKET_CLOSED_BEFORE_CONNECTION");
      c.call(this.onwriteHelper());
    });
  }

  /** onwrite(stream, er) */
  private onwriteHelper(): number {
    return this.fn("onwrite", [this.sockRef(), this.errRef], [], (f) => {
      const c = f.c;
      const S = 0;
      const ER = 1;
      const SYNC = f.local(I32);
      const CB = f.local(this.eclosRef());
      const NEEDTICK = f.local(I32);
      const ATI = f.local(this.ref(this.atiT));
      this.if_(c, () => {
        this.sbits(c, S, S_WS, wExpectWriteCb);
        c.i32Eqz();
      }, () => {
        c.localGet(S);
        this.nodeErr(c, "Callback called multiple times", "ERR_MULTIPLE_CALLBACK");
        c.i32Const(0);
        c.call(this.errorOrDestroyHelper());
        c.return_();
      });
      this.sbits(c, S, S_WS, wSync);
      c.localSet(SYNC);
      this.sget(c, S, S_WRITECB);
      c.localSet(CB);
      this.sset(c, S, S_WRITECB, () => c.refNull(this.deps.errClos().clos));
      this.sbitClr(c, S, S_WS, wWriting | wExpectWriteCb);
      this.sset(c, S, S_WLEN, () => {
        this.sget(c, S, S_WLEN);
        this.sget(c, S, S_WRITELEN);
        c.i32Sub();
      });
      this.sset(c, S, S_WRITELEN, () => c.i32Const(0));
      this.if_(c, () => {
        c.localGet(ER);
        c.refIsNull();
        c.i32Eqz();
      }, () => {
        this.if_(c, () => {
          this.sbits(c, S, S_WS, kErrored);
          c.i32Eqz();
        }, () => {
          this.sset(c, S, S_WERR, () => c.localGet(ER));
          this.sbitSet(c, S, S_WS, kErrored);
        });
        this.if_(c, () => {
          this.sbits(c, S, S_RS, kErrored);
          c.i32Eqz();
        }, () => {
          this.sset(c, S, S_RERR, () => c.localGet(ER));
          this.sbitSet(c, S, S_RS, kErrored);
        });
        this.if_(c, () => c.localGet(SYNC), () => {
          this.nextTick(c, this.onwriteErrorTick(), { sock: () => c.localGet(S), err: () => c.localGet(ER), x: () => c.localGet(CB) });
        }, () => {
          c.localGet(S);
          c.localGet(ER);
          c.localGet(CB);
          c.call(this.onwriteErrorHelper());
        });
        c.return_();
      });
      this.if_(c, () => this.sbits(c, S, S_WS, wBuffered), () => {
        c.localGet(S);
        c.call(this.clearBufferHelper());
      });
      this.if_(c, () => c.localGet(SYNC), () => {
        this.sbits(c, S, S_WS, wNeedDrain);
        this.sget(c, S, S_WLEN);
        c.i32Eqz();
        c.i32And();
        c.localGet(CB);
        c.refIsNull();
        c.i32Eqz();
        c.i32Or();
        c.localSet(NEEDTICK);
        this.if_(c, () => {
          c.localGet(CB);
          c.refIsNull();
        }, () => {
          this.if_(c, () => {
            this.sbits(c, S, S_WS, wAfterWritePending);
            c.i32Eqz();
            c.localGet(NEEDTICK);
            c.i32And();
          }, () => {
            this.nextTick(c, this.afterWrite1Tick(), { sock: () => c.localGet(S) });
            this.sbitSet(c, S, S_WS, wAfterWritePending);
          }, () => {
            this.sset(c, S, S_PENDINGCB, () => {
              this.sget(c, S, S_PENDINGCB);
              c.i32Const(1);
              c.i32Sub();
            });
            this.if_(c, () => this.sbits(c, S, S_WS, wEnding), () => {
              c.localGet(S);
              c.i32Const(1);
              c.call(this.finishMaybeHelper());
            });
          });
        }, () => {
          this.if_(c, () => {
            this.sbits(c, S, S_WS, wAfterWriteTickInfo);
            c.ifResult(I32);
            this.sget(c, S, S_ATI);
            c.structGet(this.atiT, 1);
            c.localGet(CB);
            c.refEq();
            c.else_();
            c.i32Const(0);
            c.end();
          }, () => {
            this.sget(c, S, S_ATI);
            c.localTee(ATI);
            c.localGet(ATI);
            c.structGet(this.atiT, 0);
            c.i32Const(1);
            c.i32Add();
            c.structSet(this.atiT, 0);
          }, () => {
            c.i32Const(1);
            c.localGet(CB);
            c.structNew(this.atiT);
            c.localSet(ATI);
            this.sset(c, S, S_ATI, () => c.localGet(ATI));
            this.nextTick(c, this.afterWriteTickTick(), { sock: () => c.localGet(S), x: () => c.localGet(ATI) });
            this.sbitSet(c, S, S_WS, wAfterWritePending | wAfterWriteTickInfo);
          });
        });
      }, () => {
        c.localGet(S);
        c.i32Const(1);
        c.localGet(CB);
        c.call(this.afterWriteHelper());
      });
    });
  }

  private afterWrite1Tick(): number {
    return this.tickFn("afterWrite", (f, e) => {
      const c = f.c;
      c.localGet(e.sock);
      c.i32Const(1);
      c.refNull(this.deps.errClos().clos);
      c.call(this.afterWriteHelper());
    });
  }

  /** afterWriteTick({ stream, state, count, cb }) */
  private afterWriteTickTick(): number {
    return this.tickFn("afterWriteTick", (f, e) => {
      const c = f.c;
      const ATI = f.local(this.ref(this.atiT));
      c.localGet(e.x);
      c.refCast(this.atiT);
      c.localSet(ATI);
      this.sbitClr(c, e.sock, S_WS, wAfterWriteTickInfo);
      this.sset(c, e.sock, S_ATI, () => c.refNull(this.atiT));
      c.localGet(e.sock);
      c.localGet(ATI);
      c.structGet(this.atiT, 0);
      c.localGet(ATI);
      c.structGet(this.atiT, 1);
      c.call(this.afterWriteHelper());
    });
  }

  /** afterWrite(stream, state, count, cb) */
  private afterWriteHelper(): number {
    return this.fn("afterWrite", [this.sockRef(), I32, this.eclosRef()], [], (f) => {
      const c = f.c;
      const S = 0;
      const COUNT = 1;
      const CB = 2;
      this.sbitClr(c, S, S_WS, wAfterWritePending);
      this.if_(c, () => {
        this.sbitsEq(c, S, S_WS, wEnding | wNeedDrain | kDestroyed, wNeedDrain);
        this.sget(c, S, S_WLEN);
        c.i32Eqz();
        c.i32And();
      }, () => {
        this.sbitClr(c, S, S_WS, wNeedDrain);
        // INC-29 U2: stream.emit('drain') — http modules listen for it.
        if (this.deps.http !== undefined) {
          c.localGet(S);
          c.call(this.emitHelper(L_DRAIN));
          c.drop();
          this.excReturn(c);
        }
      });
      this.while_(c, () => {
        c.localGet(COUNT);
        c.i32Const(0);
        c.i32GtS();
      }, () => {
        c.localGet(COUNT);
        c.i32Const(1);
        c.i32Sub();
        c.localSet(COUNT);
        this.sset(c, S, S_PENDINGCB, () => {
          this.sget(c, S, S_PENDINGCB);
          c.i32Const(1);
          c.i32Sub();
        });
        this.callCb(c, () => c.localGet(CB), () => c.refNull(this.deps.errType()));
        this.excReturn(c);
      });
      this.if_(c, () => this.sbits(c, S, S_WS, kDestroyed), () => {
        c.localGet(S);
        c.call(this.errorBufferHelper());
        this.excReturn(c);
      });
      this.if_(c, () => this.sbits(c, S, S_WS, wEnding), () => {
        c.localGet(S);
        c.i32Const(1);
        c.call(this.finishMaybeHelper());
      });
    });
  }

  private onwriteErrorTick(): number {
    return this.tickFn("onwriteError", (f, e) => {
      const c = f.c;
      c.localGet(e.sock);
      c.localGet(e.err);
      c.localGet(e.x);
      c.refIsNull();
      c.ifResult(this.eclosRef());
      c.refNull(this.deps.errClos().clos);
      c.else_();
      c.localGet(e.x);
      c.refCast(this.deps.errClos().clos);
      c.end();
      c.call(this.onwriteErrorHelper());
    });
  }

  /** onwriteError(stream, state, er, cb) */
  private onwriteErrorHelper(): number {
    return this.fn("onwriteError", [this.sockRef(), this.errRef, this.eclosRef()], [], (f) => {
      const c = f.c;
      const S = 0;
      this.sset(c, S, S_PENDINGCB, () => {
        this.sget(c, S, S_PENDINGCB);
        c.i32Const(1);
        c.i32Sub();
      });
      this.callCb(c, () => c.localGet(2), () => c.localGet(1));
      this.excReturn(c);
      c.localGet(S);
      c.call(this.errorBufferHelper());
      this.excReturn(c);
      c.localGet(S);
      c.localGet(1);
      c.i32Const(0);
      c.call(this.errorOrDestroyHelper());
    });
  }

  /** errorBuffer(state) */
  private errorBufferHelper(): number {
    return this.fn("errorBuffer", [this.sockRef()], [], (f) => {
      const c = f.c;
      const S = 0;
      const I = f.local(I32);
      const E = f.local(this.ref(this.wreqT));
      const ERR = f.local(this.errRef);
      const errOr = (name: string): void => {
        this.sget(c, S, S_WERR);
        c.localTee(ERR);
        c.refIsNull();
        c.ifVoid();
        this.destroyedErr(c, name);
        c.localSet(ERR);
        c.end();
      };
      this.if_(c, () => this.sbits(c, S, S_WS, wWriting), () => c.return_());
      this.if_(c, () => this.sbits(c, S, S_WS, wBuffered), () => {
        this.sget(c, S, S_WBUFIDX);
        c.localSet(I);
        this.while_(c, () => {
          c.localGet(I);
          this.sget(c, S, S_WBUFN);
          c.i32LtS();
        }, () => {
          this.sget(c, S, S_WBUF);
          c.localGet(I);
          c.arrayGet(this.wreqArrT);
          c.localSet(E);
          c.localGet(I);
          c.i32Const(1);
          c.i32Add();
          c.localSet(I);
          this.sset(c, S, S_WLEN, () => {
            this.sget(c, S, S_WLEN);
            c.localGet(E);
            c.structGet(this.wreqT, 1);
            c.i32Sub();
          });
          errOr("write");
          this.callCb(c, () => {
            c.localGet(E);
            c.structGet(this.wreqT, 2);
          }, () => c.localGet(ERR));
          this.excReturn(c);
        });
      });
      errOr("end");
      c.localGet(S);
      c.localGet(ERR);
      c.call(this.callFinishedHelper());
      this.excReturn(c);
      this.resetBuffer(c, S);
    });
  }

  /** clearBuffer(stream, state) — several buffered writes go out as one
   * writev (a Socket has _writev): their bytes, concatenated. */
  private clearBufferHelper(): number {
    return this.fn("clearBuffer", [this.sockRef()], [], (f) => {
      const c = f.c;
      const S = 0;
      const COUNT = f.local(I32);
      const I = f.local(I32);
      const E = f.local(this.ref(this.wreqT));
      const TOTAL = f.local(I32);
      const DST = f.local(this.ref(this.deps.bufType()));
      const AT = f.local(I32);
      const B = f.local(this.bytesRef);
      const bt = this.deps.bytesType();
      const bufT = this.deps.bufType();
      const guard = this.deps.http !== undefined ? kDestroyed | wBufferProcessing | wBuffered | wCorked : kDestroyed | wBufferProcessing | wBuffered;
      this.if_(c, () => {
        this.sbitsEq(c, S, S_WS, guard, wBuffered);
        c.i32Eqz();
      }, () => c.return_());
      this.sget(c, S, S_WBUFN);
      this.sget(c, S, S_WBUFIDX);
      c.i32Sub();
      c.localTee(COUNT);
      c.i32Eqz();
      c.ifVoid();
      c.return_();
      c.end();
      this.sget(c, S, S_WBUFIDX);
      c.localSet(I);
      this.sbitSet(c, S, S_WS, wBufferProcessing);
      this.if_(c, () => {
        c.localGet(COUNT);
        c.i32Const(1);
        c.i32GtS();
      }, () => {
        this.sset(c, S, S_PENDINGCB, () => {
          this.sget(c, S, S_PENDINGCB);
          c.localGet(COUNT);
          c.i32Const(1);
          c.i32Sub();
          c.i32Sub();
        });
        // The chunks' bytes, concatenated.
        c.localGet(I);
        c.localSet(AT);
        this.while_(c, () => {
          c.localGet(AT);
          this.sget(c, S, S_WBUFN);
          c.i32LtS();
        }, () => {
          c.localGet(TOTAL);
          this.sget(c, S, S_WBUF);
          c.localGet(AT);
          c.arrayGet(this.wreqArrT);
          c.structGet(this.wreqT, 0);
          c.structGet(bt, 2);
          c.i32Add();
          c.localSet(TOTAL);
          c.localGet(AT);
          c.i32Const(1);
          c.i32Add();
          c.localSet(AT);
        });
        c.localGet(TOTAL);
        c.arrayNewDefault(bufT);
        c.localSet(DST);
        c.i32Const(0);
        c.localSet(AT);
        c.localGet(I);
        c.localSet(COUNT);
        this.while_(c, () => {
          c.localGet(COUNT);
          this.sget(c, S, S_WBUFN);
          c.i32LtS();
        }, () => {
          this.sget(c, S, S_WBUF);
          c.localGet(COUNT);
          c.arrayGet(this.wreqArrT);
          c.structGet(this.wreqT, 0);
          c.localSet(B);
          c.localGet(DST);
          c.localGet(AT);
          c.localGet(B);
          c.structGet(bt, 0);
          c.localGet(B);
          c.structGet(bt, 1);
          c.localGet(B);
          c.structGet(bt, 2);
          c.arrayCopy(bufT, bufT);
          c.localGet(AT);
          c.localGet(B);
          c.structGet(bt, 2);
          c.i32Add();
          c.localSet(AT);
          c.localGet(COUNT);
          c.i32Const(1);
          c.i32Add();
          c.localSet(COUNT);
        });
        c.localGet(S);
        c.i32Const(1);
        this.sget(c, S, S_WLEN);
        c.localGet(DST);
        c.refAsNonNull();
        c.i32Const(0);
        c.localGet(TOTAL);
        c.structNew(bt);
        // The callback: nop when every buffered write had none.
        this.sbits(c, S, S_WS, wAllNoop);
        c.ifResult(this.eclosRef());
        c.refNull(this.deps.errClos().clos);
        c.else_();
        this.mb.declareFuncRef(this.multiCbFn());
        c.refFunc(this.multiCbFn());
        this.sget(c, S, S_WBUF);
        c.localGet(I);
        this.sget(c, S, S_WBUFN);
        c.structNew(this.multiCbEnvT);
        c.end();
        c.call(this.doWriteHelper());
        this.resetBuffer(c, S);
      }, () => {
        c.block();
        c.loop();
        this.sget(c, S, S_WBUF);
        c.localGet(I);
        c.arrayGet(this.wreqArrT);
        c.localSet(E);
        this.sget(c, S, S_WBUF);
        c.localGet(I);
        c.refNull(this.wreqT);
        c.arraySet(this.wreqArrT);
        c.localGet(I);
        c.i32Const(1);
        c.i32Add();
        c.localSet(I);
        c.localGet(S);
        c.i32Const(0);
        c.localGet(E);
        c.structGet(this.wreqT, 1);
        c.localGet(E);
        c.structGet(this.wreqT, 0);
        c.localGet(E);
        c.structGet(this.wreqT, 2);
        c.call(this.doWriteHelper());
        c.localGet(I);
        this.sget(c, S, S_WBUFN);
        c.i32LtS();
        this.sbits(c, S, S_WS, wWriting);
        c.i32Eqz();
        c.i32And();
        c.brIf(0);
        c.end();
        c.end();
        this.if_(c, () => {
          c.localGet(I);
          this.sget(c, S, S_WBUFN);
          c.i32Eq();
        }, () => this.resetBuffer(c, S), () => {
          this.sset(c, S, S_WBUFIDX, () => c.localGet(I));
        });
      });
      this.sbitClr(c, S, S_WS, wBufferProcessing);
    });
  }

  /** The writev callback: every buffered write's callback, in order. */
  private multiCbFn(): number {
    const hit = this.fns.get("multiCb");
    if (hit !== undefined) return hit;
    const pair = this.deps.errClos();
    const idx = this.mb.declareFunc(pair.fn, "%w.net.multiCb");
    this.fns.set("multiCb", idx);
    const env = this.multiCbEnvT;
    const f = new Fn(2);
    const c = f.c;
    const ARR = f.local(this.ref(this.wreqArrT));
    const I = f.local(I32);
    const TO = f.local(I32);
    c.localGet(0);
    c.refCast(env);
    c.structGet(env, 1);
    c.localSet(ARR);
    c.localGet(0);
    c.refCast(env);
    c.structGet(env, 2);
    c.localSet(I);
    c.localGet(0);
    c.refCast(env);
    c.structGet(env, 3);
    c.localSet(TO);
    this.while_(c, () => {
      c.localGet(I);
      c.localGet(TO);
      c.i32LtS();
    }, () => {
      this.callCb(c, () => {
        c.localGet(ARR);
        c.localGet(I);
        c.arrayGet(this.wreqArrT);
        c.structGet(this.wreqT, 2);
      }, () => c.localGet(1));
      this.excReturn(c);
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(I);
    });
    this.mb.setBody(idx, f.locals, c.bytes());
    return idx;
  }

  /** Writable.prototype.end(chunk, encoding, cb) (Socket.prototype.end
   * answers the socket; that is the caller's). `b` null = no chunk. */
  endHelper(): number {
    return this.fn("end", [this.sockRef(), this.bytesRef, I32, this.eclosRef()], [], (f) => {
      const c = f.c;
      const S = 0;
      const B = 1;
      const LEN = 2;
      const CB = 3;
      const ERR = f.local(this.errRef);
      const g = this.g();
      this.if_(c, () => {
        c.localGet(B);
        c.refIsNull();
        c.i32Eqz();
      }, () => {
        this.if_(c, () => {
          c.localGet(S);
          c.localGet(B);
          c.localGet(LEN);
          c.refNull(this.deps.errClos().clos);
          c.call(this.writeHelper());
          c.i32Const(-1);
          c.i32Eq();
        }, () => {
          c.globalGet(g.lastErr);
          c.localSet(ERR);
        });
      });
      // INC-29 U2: .end() fully uncorks (http modules cork).
      if (this.deps.http !== undefined) {
        this.if_(c, () => this.sbits(c, S, S_WS, wCorked), () => {
          this.sset(c, S, S_CORKED, () => c.i32Const(1));
          c.localGet(S);
          c.call(this.uncorkHelper());
        });
      }
      this.if_(c, () => {
        c.localGet(ERR);
        c.refIsNull();
      }, () => {
        this.if_(c, () => {
          this.sbits(c, S, S_WS, wEnding | kErrored);
          c.i32Eqz();
        }, () => {
          this.sbitSet(c, S, S_WS, wEnding);
          c.localGet(S);
          c.i32Const(1);
          c.call(this.finishMaybeHelper());
          this.sbitSet(c, S, S_WS, wEnded);
        }, () => {
          this.if_(c, () => this.sbits(c, S, S_WS, wFinished), () => {
            this.nodeErr(c, "Cannot call end after a stream was finished", "ERR_STREAM_ALREADY_FINISHED");
            c.localSet(ERR);
          }, () => {
            this.if_(c, () => this.sbits(c, S, S_WS, kDestroyed), () => {
              this.destroyedErr(c, "end");
              c.localSet(ERR);
            });
          });
        });
      });
      this.if_(c, () => {
        c.localGet(CB);
        c.refIsNull();
        c.i32Eqz();
      }, () => {
        this.if_(c, () => {
          c.localGet(ERR);
          c.refIsNull();
          c.i32Eqz();
        }, () => {
          this.nextTick(c, this.cbTick(), { err: () => c.localGet(ERR), x: () => c.localGet(CB) });
        }, () => {
          this.if_(c, () => this.sbits(c, S, S_WS, kErrored), () => {
            this.nextTick(c, this.cbTick(), { err: () => this.sget(c, S, S_WERR), x: () => c.localGet(CB) });
          }, () => {
            this.if_(c, () => this.sbits(c, S, S_WS, wFinished), () => {
              this.nextTick(c, this.cbTick(), { x: () => c.localGet(CB) });
            }, () => {
              this.sbitSet(c, S, S_WS, wOnFinished);
              c.localGet(S);
              c.localGet(CB);
              c.call(this.onfinPushHelper());
            });
          });
        });
      });
    });
  }

  /* ── INC-29 U2: what an http module adds to a Socket ──────────────── */

  /** Writable.prototype.cork */
  corkHelper(): number {
    return this.fn("cork", [this.sockRef()], [], (f) => {
      const c = f.c;
      this.sbitSet(c, 0, S_WS, wCorked);
      this.sset(c, 0, S_CORKED, () => {
        this.sget(c, 0, S_CORKED);
        c.i32Const(1);
        c.i32Add();
      });
    });
  }

  /** Writable.prototype.uncork */
  uncorkHelper(): number {
    return this.fn("uncork", [this.sockRef()], [], (f) => {
      const c = f.c;
      const S = 0;
      this.if_(c, () => this.sget(c, S, S_CORKED), () => {
        this.sset(c, S, S_CORKED, () => {
          this.sget(c, S, S_CORKED);
          c.i32Const(1);
          c.i32Sub();
        });
        this.if_(c, () => {
          this.sget(c, S, S_CORKED);
          c.i32Eqz();
        }, () => this.sbitClr(c, S, S_WS, wCorked));
        this.if_(c, () => {
          this.sbits(c, S, S_WS, wWriting);
          c.i32Eqz();
        }, () => {
          c.localGet(S);
          c.call(this.clearBufferHelper());
        });
      });
    });
  }

  /** `socket._writableState.corked = 1` (OutgoingMessage.end's own
   * assignment: the counter only, not the kCorked bit). */
  corkedOneHelper(): number {
    return this.fn("corkedOne", [this.sockRef()], [], (f) => {
      this.sset(f.c, 0, S_CORKED, () => f.c.i32Const(1));
    });
  }

  /** writableLength / writableCorked / writableFinished readers. */
  wlenHelper(): number {
    return this.fn("wlen", [this.sockRef()], [I32], (f) => this.sget(f.c, 0, S_WLEN));
  }

  writableCorkedHelper(): number {
    return this.fn("wcorked", [this.sockRef()], [I32], (f) => this.sget(f.c, 0, S_CORKED));
  }

  /** Readable.readableLength */
  rlenHelper(): number {
    return this.fn("rlen", [this.sockRef()], [I32], (f) => this.sget(f.c, 0, S_RLEN));
  }

  /** Writable.needDrain */
  needDrainHelper(): number {
    return this.fn("needDrain", [this.sockRef()], [I32], (f) => this.sbits(f.c, 0, S_WS, wNeedDrain));
  }

  /** Socket.prototype._unrefTimer: refresh this[kTimeout]. */
  unrefTimerHelper(): number {
    const http = this.deps.http!;
    return this.fn("_unrefTimer", [this.sockRef()], [], (f) => {
      const c = f.c;
      this.if_(c, () => {
        this.sget(c, 0, S_TMO);
        c.f64Const(0);
        c.f64Ne();
      }, () => {
        this.sget(c, 0, S_TMO);
        c.call(http.refreshTimer());
        c.drop();
      });
    });
  }

  /** setStreamTimeout(msecs) for an msecs already a valid duration. */
  setTimeoutHelper(): number {
    const http = this.deps.http!;
    return this.fn("setTimeout", [this.sockRef(), F64], [], (f) => {
      const c = f.c;
      const S = 0;
      const MS = 1;
      this.if_(c, () => {
        c.localGet(S);
        c.call(this.destroyedHelper());
      }, () => c.return_());
      this.sset(c, S, S_TIMEOUT, () => c.localGet(MS));
      this.if_(c, () => {
        this.sget(c, S, S_TMO);
        c.f64Const(0);
        c.f64Ne();
      }, () => {
        this.sget(c, S, S_TMO);
        c.call(http.clearTimer());
        this.sset(c, S, S_TMO, () => c.f64Const(0));
      });
      this.if_(c, () => {
        c.localGet(MS);
        c.f64Const(0);
        c.f64Ne();
      }, () => {
        // setUnrefTimeout(this._onTimeout.bind(this), msecs)
        this.sset(c, S, S_TMO, () => {
          this.closure(c, this.onTimeoutTick(), { sock: () => c.localGet(S) });
          c.localGet(MS);
          c.call(http.setTimeoutHandle());
          c.call(http.unrefTimer());
        });
      });
    });
  }

  /** Socket.prototype._onTimeout. The handle's writeQueueSize is the
   * bytes of the write the host still holds (S_LWQS while one is
   * outstanding, else 0: SEMANTICS.md S088 (j)). */
  private onTimeoutTick(): number {
    return this.tickFn("_onTimeout", (f, e) => {
      const c = f.c;
      const S = e.sock;
      // this[kTimeout] still names the timer (a fired one-shot can be
      // refreshed while its callback runs: timers.ts's firing flag).
      this.if_(c, () => {
        this.sget(c, S, S_LWQS);
        c.i32Const(0);
        c.i32GtS();
        this.sget(c, S, S_HAS_HANDLE);
        c.i32And();
        this.sget(c, S, S_WPEND);
        c.i32Eqz();
        c.i32And();
      }, () => {
        this.sset(c, S, S_LWQS, () => c.i32Const(0));
        c.localGet(S);
        c.call(this.unrefTimerHelper());
        c.return_();
      });
      c.localGet(S);
      c.call(this.emitHelper(L_TIMEOUT));
      c.drop();
    });
  }

  /** handle.reading = true; handle.readStart() (an error destroys). */
  readStartHandleHelper(): number {
    return this.fn("handleReadStart", [this.sockRef()], [], (f) => {
      f.c.localGet(0);
      f.c.call(this.tryReadStartHelper());
    });
  }

  /** handle.reading = false; handle.readStop() */
  readStopHandleHelper(): number {
    return this.fn("handleReadStop", [this.sockRef()], [], (f) => {
      const c = f.c;
      const R = f.local(I32);
      this.sset(c, 0, S_READING, () => c.i32Const(0));
      c.i32Const(OP_READ_STOP);
      c.i32Const(0);
      c.i32Const(0);
      this.sget(c, 0, S_H);
      c.i32Const(0);
      this.netCall(c);
      c.localSet(R);
      this.if_(c, () => {
        c.localGet(R);
        c.i32Const(0);
        c.i32GtS();
      }, () => this.trap(c));
    });
  }

  /** Socket.prototype.ref / unref (the handle exists: the http module only
   * calls them on connected sockets). */
  refHelper(on: boolean): number {
    return this.fn(on ? "ref" : "unref", [this.sockRef()], [], (f) => {
      this.sset(f.c, 0, S_UNREF, () => f.c.i32Const(on ? 0 : 1));
    });
  }

  /** Socket.prototype.setKeepAlive(enable): recorded, not applied
   * (SEMANTICS.md S088 (c)). */
  setKeepAliveHelper(): number {
    return this.fn("setKeepAlive", [this.sockRef(), I32], [], (f) => {
      this.sset(f.c, 0, S_KEEPALIVE, () => f.c.localGet(1));
    });
  }

  /** Socket.prototype.connect for net.createConnection(options) with the
   * agent's options: kSetNoDelay from options.noDelay, then
   * socket.setTimeout(options.timeout) when it is truthy, then the
   * connect — the same as connectHelper's otherwise. */
  connectExHelper(): number {
    return this.fn("connectEx", [F64, this.strRef, I32, F64], [this.sockRef()], (f) => {
      const CB = f.local(this.ref(this.deps.voidClos().clos));
      const ATTEMPT = f.local(this.deps.dynRef());
      this.connectBody(f, CB, ATTEMPT, { noDelay: 2, timeout: 3 });
    });
  }

  /** INC-29 U4: connectExHelper with a 'connect' callback (tls.connect's
   * `tlssock.connect(options, tlssock._start)` through the https Agent). */
  connectExCbHelper(): number {
    return this.fn("connectExCb", [F64, this.strRef, I32, F64, this.ref(this.deps.voidClos().clos)], [this.sockRef()], (f) => {
      const ATTEMPT = f.local(this.deps.dynRef());
      this.connectBody(f, 4, ATTEMPT, { noDelay: 2, timeout: 3 });
    });
  }

  private onfinPushHelper(): number {
    return this.fn("onfinPush", [this.sockRef(), this.eclosRef()], [], (f) => {
      const c = f.c;
      const S = 0;
      const NA = f.local(this.ref(this.ecArrT));
      this.if_(c, () => {
        this.sget(c, S, S_ONFIN);
        c.refIsNull();
      }, () => {
        this.sset(c, S, S_ONFIN, () => {
          c.i32Const(2);
          c.arrayNewDefault(this.ecArrT);
        });
        this.sset(c, S, S_ONFIN_N, () => c.i32Const(0));
      });
      this.if_(c, () => {
        this.sget(c, S, S_ONFIN_N);
        this.sget(c, S, S_ONFIN);
        c.arrayLen();
        c.i32GeU();
      }, () => {
        this.sget(c, S, S_ONFIN);
        c.arrayLen();
        c.i32Const(1);
        c.i32Shl();
        c.arrayNewDefault(this.ecArrT);
        c.localSet(NA);
        c.localGet(NA);
        c.i32Const(0);
        this.sget(c, S, S_ONFIN);
        c.i32Const(0);
        this.sget(c, S, S_ONFIN_N);
        c.arrayCopy(this.ecArrT, this.ecArrT);
        this.sset(c, S, S_ONFIN, () => c.localGet(NA));
      });
      this.sget(c, S, S_ONFIN);
      this.sget(c, S, S_ONFIN_N);
      c.localGet(1);
      c.arraySet(this.ecArrT);
      this.sset(c, S, S_ONFIN_N, () => {
        this.sget(c, S, S_ONFIN_N);
        c.i32Const(1);
        c.i32Add();
      });
    });
  }

  /** needFinish(state) */
  private needFinish(c: Code, s: number): void {
    this.sbitsEq(c, s, S_WS, wEnding | kDestroyed | wFinished | wWriting | kErrorEmitted | kCloseEmitted | kErrored | wBuffered, wEnding);
    this.sget(c, s, S_WLEN);
    c.i32Eqz();
    c.i32And();
  }

  /** prefinish(stream, state): a Socket has _final. */
  private prefinishHelper(): number {
    return this.fn("prefinish", [this.sockRef()], [], (f) => {
      const c = f.c;
      const S = 0;
      this.if_(c, () => this.sbits(c, S, S_WS, wPrefinished | wFinalCalled), () => c.return_());
      this.if_(c, () => {
        this.sbits(c, S, S_WS, kDestroyed);
        c.i32Eqz();
      }, () => {
        this.sbitSet(c, S, S_WS, wFinalCalled | wSync);
        this.sset(c, S, S_PENDINGCB, () => {
          this.sget(c, S, S_PENDINGCB);
          c.i32Const(1);
          c.i32Add();
        });
        c.localGet(S);
        c.call(this.socketFinalHelper());
        this.sbitClr(c, S, S_WS, wSync);
      }, () => {
        this.sbitSet(c, S, S_WS, wFinalCalled | wPrefinished);
      });
    });
  }

  /** Socket.prototype._final(cb) with cb = onFinish. */
  private socketFinalHelper(): number {
    return this.fn("_final", [this.sockRef()], [], (f) => {
      const c = f.c;
      const S = 0;
      const R = f.local(I32);
      this.if_(c, () => {
        this.sget(c, S, S_HAS_HANDLE);
        c.i32Eqz();
        this.sget(c, S, S_CONNECTING);
        c.i32Or();
      }, () => {
        c.localGet(S);
        this.closure(c, this.finalOnConnectTick(), { sock: () => c.localGet(S) });
        c.i32Const(1);
        c.i32Const(0);
        c.call(this.addHelper(L_CONNECT));
        c.return_();
      });
      this.if_(c, () => {
        this.sget(c, S, S_H);
        c.i32Eqz();
      }, () => this.trap(c));
      c.i32Const(OP_SHUTDOWN);
      c.i32Const(0);
      c.i32Const(0);
      this.sget(c, S, S_H);
      c.i32Const(0);
      this.netCall(c);
      c.localSet(R);
      // uv_shutdown answers 0 or a negative errno; Node's `err === 1`
      // arm is for other stream kinds, so a 1 here is a host failure.
      this.if_(c, () => {
        c.localGet(R);
        c.i32Const(0);
        c.i32GtS();
      }, () => this.trap(c));
      this.if_(c, () => {
        c.localGet(R);
        c.i32Const(UV_ENOTCONN);
        c.i32Eq();
      }, () => {
        c.localGet(S);
        c.refNull(this.deps.errType());
        c.call(this.onFinishHelper());
      }, () => {
        this.if_(c, () => {
          c.localGet(R);
          c.i32Const(0);
          c.i32LtS();
        }, () => {
          c.localGet(S);
          c.localGet(R);
          this.lit(c, "shutdown");
          c.call(this.errnoExHelper());
          c.call(this.onFinishHelper());
        }, () => {
          // Accepted. The write queue is empty here (the Writable calls
          // _final only once every write has completed), so uv_shutdown
          // feeds the handle to the pending queue and the shutdown
          // completes in the next pending pass (uv__drain).
          this.sset(c, S, S_SPEND, () => c.i32Const(1));
          this.if_(c, () => this.sget(c, S, S_WPEND), () => this.trap(c));
          c.localGet(S);
          c.call(this.pendingPushHelper());
        });
      });
    });
  }

  private finalOnConnectTick(): number {
    return this.tickFn("finalOnConnect", (f, e) => {
      f.c.localGet(e.sock);
      f.c.call(this.socketFinalHelper());
    });
  }

  /** onFinish(stream, state, err) — _final's callback. */
  private onFinishHelper(): number {
    return this.fn("onFinish", [this.sockRef(), this.errRef], [], (f) => {
      const c = f.c;
      const S = 0;
      const ERR = 1;
      this.if_(c, () => this.sbits(c, S, S_WS, wPrefinished), () => {
        c.localGet(S);
        c.localGet(ERR);
        c.refIsNull();
        c.ifResult(this.errRef);
        this.nodeErr(c, "Callback called multiple times", "ERR_MULTIPLE_CALLBACK");
        c.else_();
        c.localGet(ERR);
        c.end();
        c.i32Const(0);
        c.call(this.errorOrDestroyHelper());
        c.return_();
      });
      this.sset(c, S, S_PENDINGCB, () => {
        this.sget(c, S, S_PENDINGCB);
        c.i32Const(1);
        c.i32Sub();
      });
      this.if_(c, () => {
        c.localGet(ERR);
        c.refIsNull();
        c.i32Eqz();
      }, () => {
        c.localGet(S);
        c.localGet(ERR);
        c.call(this.callFinishedHelper());
        this.excReturn(c);
        c.localGet(S);
        c.localGet(ERR);
        this.sbits(c, S, S_WS, wSync);
        c.call(this.errorOrDestroyHelper());
      }, () => {
        this.if_(c, () => this.needFinish(c, S), () => {
          this.sbitSet(c, S, S_WS, wPrefinished);
          this.sset(c, S, S_PENDINGCB, () => {
            this.sget(c, S, S_PENDINGCB);
            c.i32Const(1);
            c.i32Add();
          });
          this.nextTick(c, this.finishTick(), { sock: () => c.localGet(S) });
        });
      });
    });
  }

  private finishTick(): number {
    return this.tickFn("finish", (f, e) => {
      f.c.localGet(e.sock);
      f.c.call(this.finishHelper());
    });
  }

  /** finishMaybe(stream, state, sync) */
  private finishMaybeHelper(): number {
    return this.fn("finishMaybe", [this.sockRef(), I32], [], (f) => {
      const c = f.c;
      const S = 0;
      const SYNC = 1;
      this.if_(c, () => this.needFinish(c, S), () => {
        c.localGet(S);
        c.call(this.prefinishHelper());
        this.if_(c, () => {
          this.sget(c, S, S_PENDINGCB);
          c.i32Eqz();
        }, () => {
          this.if_(c, () => c.localGet(SYNC), () => {
            this.sset(c, S, S_PENDINGCB, () => {
              this.sget(c, S, S_PENDINGCB);
              c.i32Const(1);
              c.i32Add();
            });
            this.nextTick(c, this.finishMaybeTick(), { sock: () => c.localGet(S) });
          }, () => {
            this.if_(c, () => this.needFinish(c, S), () => {
              this.sset(c, S, S_PENDINGCB, () => {
                this.sget(c, S, S_PENDINGCB);
                c.i32Const(1);
                c.i32Add();
              });
              c.localGet(S);
              c.call(this.finishHelper());
            });
          });
        });
      });
    });
  }

  /** finishMaybe's (stream, state) => { needFinish ? finish : pendingcb-- } */
  private finishMaybeTick(): number {
    return this.tickFn("finishMaybe", (f, e) => {
      const c = f.c;
      this.if_(c, () => this.needFinish(c, e.sock), () => {
        c.localGet(e.sock);
        c.call(this.finishHelper());
      }, () => {
        this.sset(c, e.sock, S_PENDINGCB, () => {
          this.sget(c, e.sock, S_PENDINGCB);
          c.i32Const(1);
          c.i32Sub();
        });
      });
    });
  }

  /** finish(stream, state) */
  private finishHelper(): number {
    return this.fn("finish", [this.sockRef()], [], (f) => {
      const c = f.c;
      const S = 0;
      this.sset(c, S, S_PENDINGCB, () => {
        this.sget(c, S, S_PENDINGCB);
        c.i32Const(1);
        c.i32Sub();
      });
      this.sbitSet(c, S, S_WS, wFinished);
      c.localGet(S);
      c.refNull(this.deps.errType());
      c.call(this.callFinishedHelper());
      this.excReturn(c);
      c.localGet(S);
      c.call(this.emitHelper(L_FINISH));
      c.drop();
      this.excReturn(c);
      this.if_(c, () => this.sbits(c, S, S_RS, kEndEmitted), () => {
        c.localGet(S);
        c.refNull(this.deps.errType());
        c.call(this.destroyHelper());
      });
    });
  }

  /** callFinishedCallbacks(state, err) */
  private callFinishedHelper(): number {
    return this.fn("callFinished", [this.sockRef(), this.errRef], [], (f) => {
      const c = f.c;
      const S = 0;
      const ARR = f.local(this.ref(this.ecArrT));
      const N = f.local(I32);
      const I = f.local(I32);
      this.if_(c, () => {
        this.sbits(c, S, S_WS, wOnFinished);
        c.i32Eqz();
      }, () => c.return_());
      this.sget(c, S, S_ONFIN);
      c.localSet(ARR);
      this.sget(c, S, S_ONFIN_N);
      c.localSet(N);
      this.sset(c, S, S_ONFIN, () => c.refNull(this.ecArrT));
      this.sset(c, S, S_ONFIN_N, () => c.i32Const(0));
      this.sbitClr(c, S, S_WS, wOnFinished);
      this.while_(c, () => {
        c.localGet(I);
        c.localGet(N);
        c.i32LtS();
      }, () => {
        this.callCb(c, () => {
          c.localGet(ARR);
          c.localGet(I);
          c.arrayGet(this.ecArrT);
        }, () => c.localGet(1));
        this.excReturn(c);
        c.localGet(I);
        c.i32Const(1);
        c.i32Add();
        c.localSet(I);
      });
    });
  }

  /* ── destroy (lib/internal/streams/destroy.js + Socket._destroy) ──── */

  /** errorOrDestroy(stream, err, sync): autoDestroy is always on. */
  private errorOrDestroyHelper(): number {
    return this.fn("errorOrDestroy", [this.sockRef(), this.errRef, I32], [], (f) => {
      const c = f.c;
      this.if_(c, () => this.destroyedEither(c, 0), () => c.return_());
      c.localGet(0);
      c.localGet(1);
      c.call(this.destroyHelper());
    });
  }

  /** destroy(err) */
  destroyHelper(): number {
    return this.fn("destroy", [this.sockRef(), this.errRef], [], (f) => {
      const c = f.c;
      const S = 0;
      const ERR = 1;
      this.if_(c, () => this.destroyedEither(c, S), () => c.return_());
      this.checkError(c, S, ERR);
      this.sbitSetBoth(c, S, kDestroyed);
      c.localGet(S);
      c.localGet(ERR);
      c.call(this.socketDestroyHelper());
    });
  }

  /** checkError(err, w, r) */
  private checkError(c: Code, s: number, err: number): void {
    this.if_(c, () => {
      c.localGet(err);
      c.refIsNull();
      c.i32Eqz();
    }, () => {
      this.if_(c, () => {
        this.sbits(c, s, S_WS, kErrored);
        c.i32Eqz();
      }, () => {
        this.sset(c, s, S_WERR, () => c.localGet(err));
        this.sbitSet(c, s, S_WS, kErrored);
      });
      this.if_(c, () => {
        this.sbits(c, s, S_RS, kErrored);
        c.i32Eqz();
      }, () => {
        this.sset(c, s, S_RERR, () => c.localGet(err));
        this.sbitSet(c, s, S_RS, kErrored);
      });
    });
  }

  /** Socket.prototype._destroy(exception, cb), with destroy.js's
   * onDestroy as cb. */
  private socketDestroyHelper(): number {
    return this.fn("_destroy", [this.sockRef(), this.errRef], [], (f) => {
      const c = f.c;
      const S = 0;
      const ERR = 1;
      const V = f.local(this.srvRef());
      this.sset(c, S, S_CONNECTING, () => c.i32Const(0));
      // INC-29 U2: clearTimeout(this[kTimeout])
      if (this.deps.http !== undefined) {
        this.if_(c, () => {
          this.sget(c, S, S_TMO);
          c.f64Const(0);
          c.f64Ne();
        }, () => {
          this.sget(c, S, S_TMO);
          c.call(this.deps.http!.clearTimer());
        });
      }
      this.if_(c, () => this.sget(c, S, S_HAS_HANDLE), () => {
        c.localGet(S);
        c.localGet(ERR);
        c.refIsNull();
        c.i32Eqz();
        c.call(this.closeSocketHandleHelper());
        this.sset(c, S, S_HAS_HANDLE, () => c.i32Const(0));
        c.localGet(S);
        c.localGet(ERR);
        c.call(this.onDestroyHelper());
      }, () => {
        c.localGet(S);
        c.localGet(ERR);
        c.call(this.onDestroyHelper());
        this.nextTick(c, this.netCloseTick(), { sock: () => c.localGet(S) });
      });
      this.sget(c, S, S_SERVER);
      c.localTee(V);
      c.refIsNull();
      c.i32Eqz();
      c.ifVoid();
      this.vset(c, V, V_CONNS, () => {
        this.vget(c, V, V_CONNS);
        c.i32Const(1);
        c.i32Sub();
      });
      c.localGet(V);
      c.call(this.emitCloseIfDrainedHelper());
      c.end();
    });
  }

  /** onDestroy(err) */
  private onDestroyHelper(): number {
    return this.fn("onDestroy", [this.sockRef(), this.errRef], [], (f) => {
      const c = f.c;
      const S = 0;
      const ERR = 1;
      this.checkError(c, S, ERR);
      this.sbitSetBoth(c, S, kClosed);
      this.if_(c, () => {
        c.localGet(ERR);
        c.refIsNull();
        c.i32Eqz();
      }, () => {
        this.nextTick(c, this.emitErrorCloseTick(), { sock: () => c.localGet(S), err: () => c.localGet(ERR) });
      }, () => {
        this.nextTick(c, this.emitCloseTick(), { sock: () => c.localGet(S) });
      });
    });
  }

  /** emitErrorCloseNT(self, err) */
  private emitErrorCloseTick(): number {
    return this.tickFn("emitErrorCloseNT", (f, e) => {
      const c = f.c;
      const S = e.sock;
      this.if_(c, () => {
        this.sbits(c, S, S_WS, kErrorEmitted);
        this.sbits(c, S, S_RS, kErrorEmitted);
        c.i32Or();
        c.i32Eqz();
      }, () => {
        this.sbitSetBoth(c, S, kErrorEmitted);
        c.localGet(S);
        c.localGet(e.err);
        c.call(this.emitHelper(L_ERROR));
        c.drop();
        this.excReturn(c);
      });
      this.sbitSetBoth(c, S, kCloseEmitted);
    });
  }

  /** destroy.js's emitCloseNT: emitClose is false for a Socket. */
  private emitCloseTick(): number {
    return this.tickFn("emitCloseNT", (f, e) => {
      this.sbitSetBoth(f.c, e.sock, kCloseEmitted);
    });
  }

  /** net.js's emitCloseNT for a socket destroyed without a handle. */
  private netCloseTick(): number {
    return this.tickFn("netCloseNT", (f, e) => {
      const c = f.c;
      c.i32Const(0);
      c.globalSet(this.g().emitArg);
      c.localGet(e.sock);
      c.call(this.emitHelper(L_CLOSE));
      c.drop();
    });
  }

  /** Queue one closing-phase callback. */
  private closingPushHelper(): number {
    return this.listPushHelper("closingPush", () => this.g().closing, () => this.g().closingN);
  }

  /** uv__io_feed: queue a socket on the pending queue (once — a watcher
   * already queued is not queued again). */
  private pendingPushHelper(): number {
    return this.listPushHelper("pendingPush", () => this.g().pend, () => this.g().pendN);
  }

  /** Append to the growable list in globals (arr, n). */
  private listPushHelper(name: string, arrG: () => number, nG: () => number): number {
    return this.fn(name, [EQ_REF], [], (f) => {
      const c = f.c;
      const NT = f.local(this.ref(this.tableT));
      const g = { closing: arrG(), closingN: nG() };
      this.if_(c, () => {
        c.globalGet(g.closing);
        c.refIsNull();
      }, () => {
        c.i32Const(4);
        c.arrayNewDefault(this.tableT);
        c.globalSet(g.closing);
      });
      this.if_(c, () => {
        c.globalGet(g.closingN);
        c.globalGet(g.closing);
        c.arrayLen();
        c.i32GeU();
      }, () => {
        c.globalGet(g.closing);
        c.arrayLen();
        c.i32Const(1);
        c.i32Shl();
        c.arrayNewDefault(this.tableT);
        c.localSet(NT);
        c.localGet(NT);
        c.i32Const(0);
        c.globalGet(g.closing);
        c.i32Const(0);
        c.globalGet(g.closingN);
        c.arrayCopy(this.tableT, this.tableT);
        c.localGet(NT);
        c.globalSet(g.closing);
      });
      c.globalGet(g.closing);
      c.globalGet(g.closingN);
      c.localGet(0);
      c.arraySet(this.tableT);
      c.globalGet(g.closingN);
      c.i32Const(1);
      c.i32Add();
      c.globalSet(g.closingN);
    });
  }

  /** CLOSE the host handle `h` (if any) and forget it. */
  private hostClose(c: Code, pushH: () => void): void {
    pushH();
    c.ifVoid();
    c.i32Const(OP_CLOSE);
    c.i32Const(0);
    c.i32Const(0);
    pushH();
    c.i32Const(0);
    this.netCall(c);
    c.ifVoid();
    this.trap(c);
    c.end();
    pushH();
    c.refNull(EQ_HEAP);
    c.call(this.tableSetHelper());
    c.end();
  }

  /** closeSocketHandle(self, isException): handle.close(() => emit
   * 'close'), the callback in the closing phase. */
  private closeSocketHandleHelper(): number {
    return this.fn("closeSocketHandle", [this.sockRef(), I32], [], (f) => {
      const c = f.c;
      const S = 0;
      this.hostClose(c, () => this.sget(c, S, S_H));
      this.sset(c, S, S_H, () => c.i32Const(0));
      this.sset(c, S, S_READING, () => c.i32Const(0));
      this.closure(c, this.closeCbTick(), { sock: () => c.localGet(S), n: () => c.localGet(1) });
      c.call(this.closingPushHelper());
    });
  }

  /** The closing-phase callback of a socket's handle: libuv first
   * completes a write and then a shutdown still pending on the handle
   * with ECANCELED (each its own callback scope), then runs the close
   * callback, which emits 'close' (isException). */
  private closeCbTick(): number {
    return this.tickFn("closeCb", (f, e) => {
      const c = f.c;
      const S = e.sock;
      this.if_(c, () => this.sget(c, S, S_WPEND), () => {
        this.sset(c, S, S_WPEND, () => c.i32Const(0));
        c.localGet(S);
        c.i32Const(UV_ECANCELED);
        this.lit(c, "write");
        c.call(this.errnoExHelper());
        c.call(this.onwriteHelper());
        this.excReturn(c);
        this.deps.checkpoint(c);
      });
      this.if_(c, () => this.sget(c, S, S_SPEND), () => {
        this.sset(c, S, S_SPEND, () => c.i32Const(0));
        c.localGet(S);
        c.refNull(this.deps.errType());
        c.call(this.onFinishHelper());
        this.excReturn(c);
        this.deps.checkpoint(c);
      });
      c.localGet(e.n);
      c.globalSet(this.g().emitArg);
      c.localGet(S);
      c.call(this.emitHelper(L_CLOSE));
      c.drop();
    });
  }

  /** A closed listening handle holds the loop one more iteration and has
   * no callback (Server.close's handle.close() takes none). */
  private noopCloseTick(): number {
    return this.tickFn("closeNoop", () => undefined);
  }

  /* ── net.Socket ────────────────────────────────────────────────────── */

  /** A fresh Socket's state: Readable's kSync, Writable's kSync and
   * kAllNoop (resetBuffer), and the constructor's own
   * this.on('end', onReadableStreamEnd). */
  sockNewHelper(): number {
    return this.fn("sockNew", [], [this.sockRef()], (f) => {
      const c = f.c;
      const S = f.local(this.sockRef());
      const T = this.sockType();
      c.i32Const(0); // S_H
      c.i32Const(kSync); // S_RS
      c.i32Const(wSync | wAllNoop); // S_WS
      c.i32Const(0); // S_RLEN
      c.refNull(this.chunkArrT);
      c.i32Const(0);
      c.i32Const(0);
      c.i32Const(0); // S_WLEN
      c.i32Const(0); // S_WRITELEN
      c.refNull(this.deps.errClos().clos);
      c.i32Const(0); // S_PENDINGCB
      c.refNull(this.wreqArrT);
      c.i32Const(0);
      c.i32Const(0);
      c.refNull(this.atiT);
      c.refNull(this.ecArrT);
      c.i32Const(0);
      c.refNull(this.deps.errType());
      c.refNull(this.deps.errType());
      c.i32Const(0); // S_CONNECTING
      c.refNull(this.srvType());
      c.i32Const(0); // S_WAF
      c.refNull(this.deps.bytesType());
      c.f64Const(0); // S_DISPATCHED
      c.i32Const(0); // S_NODELAY
      c.refNull(this.deps.strType());
      c.i32Const(0);
      c.i32Const(0);
      c.i32Const(0); // S_PEER_CACHED
      c.i32Const(0); // S_READING
      c.refNull(this.deps.strType()); // S_HOST
      c.i32Const(0);
      c.refNull(this.strArrT);
      c.refNull(this.i32ArrT);
      c.i32Const(0);
      c.i32Const(0);
      c.refNull(this.deps.errType());
      c.i32Const(0);
      c.refNull(this.deps.strType());
      c.i32Const(0);
      c.i32Const(0); // S_WPEND
      c.i32Const(0); // S_SPEND
      c.i32Const(0); // S_HAS_HANDLE
      c.i32Const(0); // S_MULTI
      for (let i = 0; i < 6; i++) {
        c.refNull(this.entArrT);
        c.i32Const(0);
      }
      c.i32Const(0); // S_LOOKUP
      if (this.deps.http !== undefined) {
        c.i32Const(0); // S_CORKED
        c.i32Const(0); // S_UNREF
        c.f64Const(0); // S_TMO
        c.f64Const(-1); // S_TIMEOUT
        c.refNull(EQ_HEAP); // S_HTTPMSG
        c.refNull(EQ_HEAP); // S_PARSER
        c.i32Const(0); // S_CONSUMED
        c.i32Const(0); // S_HPAUSED
        c.i32Const(0); // S_HADERR
        c.i32Const(0); // S_HALFOPEN
        c.i32Const(0); // S_KEEPALIVE
        c.i32Const(0); // S_LWQS
        for (let i = 0; i < 6; i++) {
          c.refNull(this.entArrT);
          c.i32Const(0);
        }
        c.refNull(EQ_HEAP); // S_HCLI
        c.i32Const(0); // S_FREEGUARD
      }
      if (this.deps.tls !== undefined) {
        c.refNull(EQ_HEAP); // S_TLS
        c.refNull(this.entArrT);
        c.i32Const(0);
      }
      c.structNew(T);
      c.localSet(S);
      c.localGet(S);
      this.closure(c, this.onReadableStreamEndTick(), { sock: () => c.localGet(S) });
      c.i32Const(0);
      c.i32Const(0);
      c.call(this.addHelper(L_END));
      c.localGet(S);
    });
  }

  /** onReadableStreamEnd: write becomes writeAfterFIN (allowHalfOpen is
   * false). */
  private onReadableStreamEndTick(): number {
    return this.tickFn("onReadableStreamEnd", (f, e) => {
      if (this.deps.http !== undefined) {
        // INC-29 U2: if (!this.allowHalfOpen)
        this.if_(f.c, () => {
          this.sget(f.c, e.sock, S_HALFOPEN);
          f.c.i32Eqz();
        }, () => this.sset(f.c, e.sock, S_WAF, () => f.c.i32Const(1)));
        return;
      }
      this.sset(f.c, e.sock, S_WAF, () => f.c.i32Const(1));
    });
  }

  /** socket.write(chunk[, cb]) for a chunk already in bytes: Socket's
   * write, or writeAfterFIN once the peer ended and the writable side has
   * ended too -> write()'s boolean. */
  sockWriteHelper(): number {
    return this.fn("sockWrite", [this.sockRef(), this.bytesRef, I32, this.eclosRef()], [I32], (f) => {
      const c = f.c;
      const S = 0;
      const ER = f.local(this.errRef);
      this.if_(c, () => {
        this.sget(c, S, S_WAF);
        this.sbits(c, S, S_WS, wEnding);
        c.i32And();
      }, () => {
        this.deps.newError(c, "%Error", "Error", (c2) => this.lit(c2, "This socket has been ended by the other party"), (c2) => this.lit(c2, "EPIPE"));
        c.localSet(ER);
        this.if_(c, () => {
          c.localGet(3);
          c.refIsNull();
          c.i32Eqz();
        }, () => {
          this.nextTick(c, this.cbTick(), { err: () => c.localGet(ER), x: () => c.localGet(3) });
        });
        c.localGet(S);
        c.localGet(ER);
        c.call(this.destroyHelper());
        c.i32Const(0);
        c.return_();
      });
      c.localGet(S);
      c.localGet(1);
      c.localGet(2);
      c.localGet(3);
      c.call(this.writeHelper());
      c.i32Const(1);
      c.i32Eq();
    });
  }

  /** socket.end([chunk][, cb]) */
  sockEndHelper(): number {
    return this.fn("sockEnd", [this.sockRef(), this.bytesRef, I32, this.eclosRef()], [], (f) => {
      const c = f.c;
      c.localGet(0);
      c.localGet(1);
      c.localGet(2);
      c.localGet(3);
      c.call(this.endHelper());
    });
  }

  /** Socket.prototype.destroySoon */
  destroySoonHelper(): number {
    return this.fn("destroySoon", [this.sockRef()], [], (f) => {
      const c = f.c;
      const S = 0;
      this.if_(c, () => {
        c.localGet(S);
        c.call(this.writableHelper());
      }, () => {
        c.localGet(S);
        c.refNull(this.deps.bytesType());
        c.i32Const(0);
        c.refNull(this.deps.errClos().clos);
        c.call(this.endHelper());
      });
      this.if_(c, () => this.sbits(c, S, S_WS, wFinished), () => {
        c.localGet(S);
        c.refNull(this.deps.errType());
        c.call(this.destroyHelper());
      }, () => {
        c.localGet(S);
        this.closure(c, this.destroyOnFinishTick(), { sock: () => c.localGet(S) });
        c.i32Const(1);
        c.i32Const(0);
        c.call(this.addHelper(L_FINISH));
      });
    });
  }

  /** this.once('finish', this.destroy) */
  private destroyOnFinishTick(): number {
    return this.tickFn("destroyOnFinish", (f, e) => {
      f.c.localGet(e.sock);
      f.c.refNull(this.deps.errType());
      f.c.call(this.destroyHelper());
    });
  }

  /** Socket.prototype.setNoDelay(enable) */
  setNoDelayHelper(): number {
    return this.fn("setNoDelay", [this.sockRef(), I32], [], (f) => {
      const c = f.c;
      const S = 0;
      const EN = 1;
      this.if_(c, () => {
        this.sget(c, S, S_HAS_HANDLE);
        c.i32Eqz();
      }, () => {
        this.sset(c, S, S_NODELAY, () => c.localGet(EN));
        c.return_();
      });
      this.if_(c, () => {
        c.localGet(EN);
        this.sget(c, S, S_NODELAY);
        c.i32Ne();
      }, () => {
        this.sset(c, S, S_NODELAY, () => c.localGet(EN));
        // A handle still waiting for its host socket (a lookup) applies
        // it at connect (afterConnect's own kSetNoDelay).
        this.if_(c, () => this.sget(c, S, S_H), () => {
          c.i32Const(OP_NODELAY);
          c.i32Const(0);
          c.i32Const(0);
          this.sget(c, S, S_H);
          c.localGet(EN);
          this.netCall(c);
          c.drop();
        });
      });
    });
  }

  /** bytesWritten: the handle's bytes plus every byte still buffered or
   * pending a connect. */
  bytesWrittenHelper(): number {
    return this.fn("bytesWritten", [this.sockRef()], [F64], (f) => {
      const c = f.c;
      const S = 0;
      const I = f.local(I32);
      const T = f.local(F64);
      const bt = this.deps.bytesType();
      this.sget(c, S, S_DISPATCHED);
      c.localSet(T);
      this.sget(c, S, S_WBUFIDX);
      c.localSet(I);
      this.if_(c, () => {
        this.sget(c, S, S_WBUF);
        c.refIsNull();
        c.i32Eqz();
      }, () => {
        this.while_(c, () => {
          c.localGet(I);
          this.sget(c, S, S_WBUFN);
          c.i32LtS();
        }, () => {
          c.localGet(T);
          this.sget(c, S, S_WBUF);
          c.localGet(I);
          c.arrayGet(this.wreqArrT);
          c.structGet(this.wreqT, 0);
          c.structGet(bt, 2);
          c.f64ConvertI32S();
          c.f64Add();
          c.localSet(T);
          c.localGet(I);
          c.i32Const(1);
          c.i32Add();
          c.localSet(I);
        });
      });
      this.if_(c, () => {
        this.sget(c, S, S_PEND);
        c.refIsNull();
        c.i32Eqz();
      }, () => {
        c.localGet(T);
        this.sget(c, S, S_PEND);
        c.structGet(bt, 2);
        c.f64ConvertI32S();
        c.f64Add();
        c.localSet(T);
      });
      c.localGet(T);
    });
  }

  /** remoteAddress: _getpeername().address — null for undefined. */
  remoteAddressHelper(): number {
    return this.fn("remoteAddress", [this.sockRef()], [this.strRef], (f) => {
      const c = f.c;
      const S = 0;
      this.if_(c, () => {
        this.sget(c, S, S_HAS_HANDLE);
        c.i32Eqz();
        this.sget(c, S, S_CONNECTING);
        c.i32Or();
        this.sget(c, S, S_H);
        c.i32Eqz();
        c.i32Or();
      }, () => {
        this.sget(c, S, S_PEER_CACHED);
        c.ifResult(this.strRef);
        this.sget(c, S, S_PEER_ADDR);
        c.else_();
        c.refNull(this.deps.strType());
        c.end();
        c.return_();
      });
      this.sset(c, S, S_PEER_CACHED, () => c.i32Const(1));
      this.sget(c, S, S_PEER_ADDR);
    });
  }

  /** Record a peer from an event payload at `p`: u32 family, u32 port, the
   * address run. */
  private setPeer(c: Code, s: number, p: number): void {
    this.sset(c, s, S_PEER_FAMILY, () => this.loadU32(c, p, 0));
    this.sset(c, s, S_PEER_PORT, () => this.loadU32(c, p, 4));
    this.sset(c, s, S_PEER_ADDR, () => {
      c.localGet(p);
      c.i32Const(8);
      c.i32Add();
      c.call(this.readRunHelper());
    });
  }

  /** validatePort(port, name) — ERR_SOCKET_BAD_PORT. Answers 1, or 0 with
   * the error pending. */
  private validatePortHelper(name: string): number {
    return this.fn(`validatePort.${name}`, [F64], [I32], (f) => {
      const c = f.c;
      const P = 0;
      this.if_(c, () => {
        c.localGet(P);
        c.f64Const(0);
        c.f64Ge();
        c.localGet(P);
        c.f64Const(65535);
        c.f64Le();
        c.i32And();
        c.localGet(P);
        c.f64Trunc();
        c.localGet(P);
        c.f64Eq();
        c.i32And();
      }, () => {
        c.i32Const(1);
        c.return_();
      });
      this.throwNew(c, "%RangeError", "RangeError", (c2) => {
        this.lit(c2, `${name} should be >= 0 and < 65536. Received type number (`);
        c2.localGet(P);
        c2.call(this.deps.f64ToStr());
        this.concat(c2);
        this.lit(c2, ").");
        this.concat(c2);
      }, "ERR_SOCKET_BAD_PORT");
      c.i32Const(0);
    });
  }

  /** Throw a fresh error now (fills the pending cell). */
  private throwNew(c: Code, className: string, name: string, pushMessage: (c: Code) => void, code: string): void {
    this.deps.newError(c, className, name, pushMessage, (c2) => this.lit(c2, code));
    this.deps.throwStack(c);
  }


  /* ── host requests ─────────────────────────────────────────────────── */

  /** LISTEN(address, port, family, flags) -> handle or -errno; the stage
   * of a failure (1 bind, 2 listen) in the `stage` global, and on success
   * the bound port / family / address into the server. */
  private listenOpHelper(): number {
    return this.fn("listenOp", [this.srvRef(), this.strRef, I32, I32, I32], [I32], (f) => {
      const c = f.c;
      const V = 0;
      const ADDR = 1;
      const P = 2;
      const FAM = 3;
      const FLAGS = 4;
      const BASE = f.local(I32);
      const END = f.local(I32);
      const R = f.local(I32);
      const g = this.g();
      this.deps.ensureCapacity(c, () => {
        c.i32Const(16 + 3);
        this.runSize(c, ADDR);
        c.i32Add();
        // The reply's run can be longer than the request's (the bound
        // address): reserve room for an IPv6 text.
        c.i32Const(4 + 2 * 64);
        c.i32Add();
      });
      this.base(c, BASE);
      this.storeU32(c, BASE, 0, () => c.localGet(P));
      this.storeU32(c, BASE, 4, () => c.localGet(FAM));
      this.storeU32(c, BASE, 8, () => c.localGet(FLAGS));
      this.storeU32(c, BASE, 12, () => c.i32Const(511));
      c.localGet(ADDR);
      c.localGet(BASE);
      c.i32Const(16);
      c.i32Add();
      c.i32Const(0);
      c.call(this.deps.stageRun());
      c.localSet(END);
      c.i32Const(OP_LISTEN);
      c.localGet(BASE);
      c.localGet(END);
      c.localGet(BASE);
      c.i32Sub();
      c.i32Const(0);
      c.i32Const(0);
      this.netCall(c);
      c.localTee(R);
      c.i32Eqz();
      c.ifVoid();
      this.trap(c);
      c.end();
      this.loadU32(c, BASE, 0);
      c.globalSet(g.stage);
      this.if_(c, () => {
        c.localGet(R);
        c.i32Const(0);
        c.i32GtS();
      }, () => {
        this.vset(c, V, V_PORT, () => this.loadU32(c, BASE, 4));
        this.vset(c, V, V_FAMILY, () => this.loadU32(c, BASE, 8));
        this.vset(c, V, V_ADDR, () => {
          c.localGet(BASE);
          c.i32Const(12);
          c.i32Add();
          c.call(this.readRunHelper());
        });
      });
      c.localGet(R);
    });
  }

  /** CONNECT(address, port, family) -> handle or -errno. */
  private connectOpHelper(): number {
    return this.fn("connectOp", [this.strRef, I32, I32], [I32], (f) => {
      const c = f.c;
      const ADDR = 0;
      const BASE = f.local(I32);
      const END = f.local(I32);
      const R = f.local(I32);
      this.deps.ensureCapacity(c, () => {
        c.i32Const(8 + 3);
        this.runSize(c, ADDR);
        c.i32Add();
      });
      this.base(c, BASE);
      this.storeU32(c, BASE, 0, () => c.localGet(1));
      this.storeU32(c, BASE, 4, () => c.localGet(2));
      c.localGet(ADDR);
      c.localGet(BASE);
      c.i32Const(8);
      c.i32Add();
      c.i32Const(0);
      c.call(this.deps.stageRun());
      c.localSet(END);
      c.i32Const(OP_CONNECT);
      c.localGet(BASE);
      c.localGet(END);
      c.localGet(BASE);
      c.i32Sub();
      c.i32Const(0);
      c.i32Const(0);
      this.netCall(c);
      c.localTee(R);
      c.i32Eqz();
      c.ifVoid();
      this.trap(c);
      c.end();
      c.localGet(R);
    });
  }

  /** RESOLVE(hostname, family, hints) -> request handle (>= 1); `owner` is
   * the socket or server the answer belongs to. */
  private resolveOpHelper(): number {
    return this.fn("resolveOp", [EQ_REF, this.strRef, I32, I32], [I32], (f) => {
      const c = f.c;
      const NAME = 1;
      const BASE = f.local(I32);
      const END = f.local(I32);
      const R = f.local(I32);
      const g = this.g();
      this.deps.ensureCapacity(c, () => {
        c.i32Const(8 + 3);
        this.runSize(c, NAME);
        c.i32Add();
      });
      this.base(c, BASE);
      this.storeU32(c, BASE, 0, () => c.localGet(2));
      this.storeU32(c, BASE, 4, () => c.localGet(3));
      c.localGet(NAME);
      c.localGet(BASE);
      c.i32Const(8);
      c.i32Add();
      c.i32Const(0);
      c.call(this.deps.stageRun());
      c.localSet(END);
      c.i32Const(OP_RESOLVE);
      c.localGet(BASE);
      c.localGet(END);
      c.localGet(BASE);
      c.i32Sub();
      c.i32Const(0);
      c.i32Const(0);
      this.netCall(c);
      c.localTee(R);
      c.i32Const(1);
      c.i32LtS();
      c.ifVoid();
      this.trap(c);
      c.end();
      c.localGet(R);
      c.localGet(0);
      c.call(this.tableSetHelper());
      c.globalGet(g.resolving);
      c.i32Const(1);
      c.i32Add();
      c.globalSet(g.resolving);
      c.localGet(R);
    });
  }

  /* ── net.Server ────────────────────────────────────────────────────── */

  srvNewHelper(): number {
    return this.fn("srvNew", [], [this.srvRef()], (f) => {
      const c = f.c;
      c.i32Const(0); // V_H
      c.i32Const(0); // V_CONNS
      c.i32Const(1); // V_LID (Node's _listeningId starts at 1)
      c.i32Const(0); // V_PORT
      c.i32Const(0); // V_FAMILY
      c.refNull(this.deps.strType());
      c.refNull(EQ_HEAP);
      for (let i = 0; i < 4; i++) {
        c.refNull(this.entArrT);
        c.i32Const(0);
      }
      c.i32Const(0);
      c.i32Const(0);
      c.i32Const(0);
      c.i32Const(0);
      if (this.deps.http !== undefined) {
        c.refNull(EQ_HEAP); // V_HTTP
        c.i32Const(0); // V_HALFOPEN
        c.i32Const(0); // V_NODELAY
      }
      if (this.deps.tls !== undefined) {
        c.refNull(EQ_HEAP); // V_TLS
        c.refNull(this.entArrT);
        c.i32Const(0);
      }
      c.structNew(this.srvType());
    });
  }

  /** Server.prototype.listen(port[, host][, cb]) -> 1, or 0 with the
   * error pending (ERR_SERVER_ALREADY_LISTEN, ERR_SOCKET_BAD_PORT). `host`
   * "" is no host; `cb` null is none. */
  listenHelper(): number {
    return this.fn("listen", [this.srvRef(), F64, this.strRef, I32, this.ref(this.deps.voidClos().clos)], [I32], (f) => {
      const c = f.c;
      const V = 0;
      const PORT = 1;
      const HOST = 2;
      const FLAGS = 3;
      const CB = 4;
      const FAM = f.local(I32);
      this.if_(c, () => this.vget(c, V, V_H), () => {
        this.throwNew(c, "%Error", "Error", (c2) => this.lit(c2, "Listen method has been called more than once without closing."), "ERR_SERVER_ALREADY_LISTEN");
        c.i32Const(0);
        c.return_();
      });
      this.if_(c, () => {
        c.localGet(CB);
        c.refIsNull();
        c.i32Eqz();
      }, () => {
        c.localGet(V);
        c.localGet(CB);
        c.i32Const(1);
        c.i32Const(0);
        c.call(this.addHelper(LV_LISTENING));
      });
      this.vset(c, V, V_LID, () => {
        this.vget(c, V, V_LID);
        c.i32Const(1);
        c.i32Add();
      });
      c.localGet(PORT);
      c.call(this.validatePortHelper("options.port"));
      c.i32Eqz();
      c.ifVoid();
      c.i32Const(0);
      c.return_();
      c.end();
      this.vset(c, V, V_FLAGS, () => c.localGet(FLAGS));
      this.if_(c, () => {
        c.localGet(HOST);
        c.arrayLen();
      }, () => {
        // lookupAndListen: dns.lookup(address, { all: true }, ...).
        this.vset(c, V, V_LOOKUP_PORT, () => {
          c.localGet(PORT);
          c.i32TruncF64S();
        });
        this.vset(c, V, V_LOOKUP_LID, () => this.vget(c, V, V_LID));
        this.vset(c, V, V_ADDR, () => c.localGet(HOST));
        c.localGet(HOST);
        c.call(this.isIPHelper());
        c.localTee(FAM);
        c.ifVoid();
        // An IP literal: dns.lookup answers on a nextTick.
        this.nextTick(c, this.listenLookupIpTick(), { srv: () => c.localGet(V), x: () => c.localGet(HOST), n: () => c.localGet(FAM) });
        c.else_();
        this.vset(c, V, V_LOOKUP, () => {
          c.localGet(V);
          c.localGet(HOST);
          c.i32Const(0);
          c.i32Const(0);
          c.call(this.resolveOpHelper());
        });
        c.end();
      }, () => {
        c.localGet(V);
        c.refNull(this.deps.strType());
        c.localGet(PORT);
        c.i32TruncF64S();
        c.i32Const(4);
        c.localGet(FLAGS);
        c.call(this.setupListenHelper());
      });
      c.i32Const(1);
    });
  }

  private listenLookupIpTick(): number {
    return this.tickFn("listenLookupIp", (f, e) => {
      const c = f.c;
      c.localGet(e.srv);
      c.refNull(this.deps.errType());
      c.localGet(e.x);
      c.refCast(this.deps.strType());
      c.localGet(e.n);
      c.call(this.listenLookupDoneHelper());
    });
  }

  /** lookupAndListen's dns.lookup callback. */
  private listenLookupDoneHelper(): number {
    return this.fn("listenLookupDone", [this.srvRef(), this.errRef, this.strRef, I32], [], (f) => {
      const c = f.c;
      const V = 0;
      this.if_(c, () => {
        this.vget(c, V, V_LOOKUP_LID);
        this.vget(c, V, V_LID);
        c.i32Ne();
      }, () => c.return_());
      this.if_(c, () => {
        c.localGet(1);
        c.refIsNull();
        c.i32Eqz();
      }, () => {
        c.localGet(V);
        c.localGet(1);
        c.call(this.emitHelper(LV_ERROR));
        c.drop();
        c.return_();
      });
      c.localGet(V);
      c.localGet(2);
      this.vget(c, V, V_LOOKUP_PORT);
      c.localGet(3);
      this.vget(c, V, V_FLAGS);
      c.call(this.setupListenHelper());
    });
  }

  /** setupListenHandle(address, port, addressType, backlog, fd, flags) —
   * `addr` null: '::', falling back to '0.0.0.0' when that bind fails. */
  private setupListenHelper(): number {
    return this.fn("setupListen", [this.srvRef(), this.strRef, I32, I32, I32], [], (f) => {
      const c = f.c;
      const V = 0;
      const ADDR = 1;
      const P = 2;
      const FAM = 3;
      const FLAGS = 4;
      const R = f.local(I32);
      const ERR = f.local(this.errRef);
      const g = this.g();
      const op = (): void => {
        c.localGet(V);
        c.localGet(ADDR);
        c.localGet(P);
        c.localGet(FAM);
        c.localGet(FLAGS);
        c.call(this.listenOpHelper());
        c.localSet(R);
      };
      this.if_(c, () => {
        c.localGet(ADDR);
        c.refIsNull();
      }, () => {
        this.lit(c, "::");
        c.localSet(ADDR);
        c.i32Const(6);
        c.localSet(FAM);
        op();
        this.if_(c, () => {
          c.localGet(R);
          c.i32Const(0);
          c.i32LtS();
          c.globalGet(g.stage);
          c.i32Const(1);
          c.i32Eq();
          c.i32And();
        }, () => {
          this.lit(c, "0.0.0.0");
          c.localSet(ADDR);
          c.i32Const(4);
          c.localSet(FAM);
          op();
        });
      }, op);
      this.if_(c, () => {
        c.localGet(R);
        c.i32Const(0);
        c.i32LtS();
      }, () => {
        c.localGet(R);
        this.lit(c, "listen");
        c.localGet(ADDR);
        c.localGet(P);
        c.call(this.uvHostPortExHelper());
        c.localSet(ERR);
        this.nextTick(c, this.srvEmitErrorTick(), { srv: () => c.localGet(V), err: () => c.localGet(ERR) });
        c.return_();
      });
      this.vset(c, V, V_H, () => c.localGet(R));
      c.localGet(R);
      c.localGet(V);
      c.call(this.tableSetHelper());
      this.nextTick(c, this.emitListeningTick(), { srv: () => c.localGet(V) });
    });
  }

  private emitListeningTick(): number {
    return this.tickFn("emitListeningNT", (f, e) => {
      const c = f.c;
      this.if_(c, () => this.vget(c, e.srv, V_H), () => {
        c.localGet(e.srv);
        c.call(this.emitHelper(LV_LISTENING));
        c.drop();
      });
    });
  }

  private srvEmitErrorTick(): number {
    return this.tickFn("srvEmitErrorNT", (f, e) => {
      f.c.localGet(e.srv);
      f.c.localGet(e.err);
      f.c.call(this.emitHelper(LV_ERROR));
      f.c.drop();
    });
  }

  /** Server.prototype.close(cb) — the real one (`cb` null is none). */
  srvCloseHelper(): number {
    return this.fn("srvClose", [this.srvRef(), this.ref(this.deps.voidClos().clos)], [], (f) => {
      const c = f.c;
      const V = 0;
      // INC-29 U2: http.Server.prototype.close runs httpServerPreClose first.
      if (this.deps.http !== undefined) {
        this.if_(c, () => {
          this.vget(c, V, V_HTTP);
          c.refIsNull();
          c.i32Eqz();
        }, () => {
          c.localGet(V);
          c.call(this.deps.http!.preClose());
        });
      }
      this.vset(c, V, V_LID, () => {
        this.vget(c, V, V_LID);
        c.i32Const(1);
        c.i32Add();
      });
      this.if_(c, () => {
        c.localGet(1);
        c.refIsNull();
        c.i32Eqz();
      }, () => {
        c.localGet(V);
        c.localGet(1);
        c.i32Const(1);
        c.i32Const(0);
        c.call(this.addHelper(LV_CLOSE));
      });
      this.if_(c, () => this.vget(c, V, V_H), () => {
        this.hostClose(c, () => this.vget(c, V, V_H));
        this.vset(c, V, V_H, () => c.i32Const(0));
        this.closure(c, this.noopCloseTick(), {});
        c.call(this.closingPushHelper());
      });
      c.localGet(V);
      c.call(this.emitCloseIfDrainedHelper());
    });
  }

  /** Server.prototype._emitCloseIfDrained */
  private emitCloseIfDrainedHelper(): number {
    return this.fn("emitCloseIfDrained", [this.srvRef()], [], (f) => {
      const c = f.c;
      const V = 0;
      this.if_(c, () => {
        this.vget(c, V, V_H);
        this.vget(c, V, V_CONNS);
        c.i32Or();
      }, () => c.return_());
      this.nextTick(c, this.srvEmitCloseTick(), { srv: () => c.localGet(V) });
    });
  }

  private srvEmitCloseTick(): number {
    return this.tickFn("srvEmitCloseNT", (f, e) => {
      f.c.localGet(e.srv);
      f.c.call(this.emitHelper(LV_CLOSE));
      f.c.drop();
    });
  }

  /** server.address().port — null.port's TypeError before a listen. */
  srvPortHelper(): number {
    return this.fn("srvPort", [this.srvRef()], [F64], (f) => {
      const c = f.c;
      this.if_(c, () => {
        this.vget(c, 0, V_H);
        c.i32Eqz();
      }, () => {
        this.deps.newError(c, "%TypeError", "TypeError", (c2) => this.lit(c2, "Cannot read properties of null (reading 'port')"), (c2) => c2.refNull(this.deps.strType()));
        this.deps.throwStack(c);
        c.f64Const(0);
        c.return_();
      });
      this.vget(c, 0, V_PORT);
      c.f64ConvertI32S();
    });
  }

  /** server.listening */
  srvListeningHelper(): number {
    return this.fn("srvListening", [this.srvRef()], [I32], (f) => {
      this.vget(f.c, 0, V_H);
      f.c.i32Const(0);
      f.c.i32Ne();
    });
  }

  /** The server's own `close` override slot (`server.close = fn`). */
  srvOverrideField(): number {
    return V_OVERRIDE;
  }

  /** onconnection(err, clientHandle) */
  private acceptHelper(): number {
    return this.fn("accept", [this.srvRef(), I32, I32], [], (f) => {
      const c = f.c;
      const V = 0;
      const NH = 1;
      const P = 2;
      const S = f.local(this.sockRef());
      this.if_(c, () => {
        this.vget(c, V, V_H);
        c.i32Eqz();
      }, () => this.trap(c));
      c.call(this.sockNewHelper());
      c.localSet(S);
      // INC-29 U2: allowHalfOpen: self.allowHalfOpen (an http server's).
      if (this.deps.http !== undefined) this.sset(c, S, S_HALFOPEN, () => this.vget(c, V, V_HALFOPEN));
      this.sset(c, S, S_H, () => c.localGet(NH));
      this.sset(c, S, S_HAS_HANDLE, () => c.i32Const(1));
      c.localGet(NH);
      c.localGet(S);
      c.call(this.tableSetHelper());
      this.setPeer(c, S, P);
      // The constructor's this.read(0): the handle starts reading.
      c.localGet(S);
      c.f64Const(0);
      c.call(this.readHelper());
      c.drop();
      this.excReturn(c);
      // INC-29 U2: if (self.noDelay) setNoDelay(true) on the handle.
      if (this.deps.http !== undefined) {
        this.if_(c, () => this.vget(c, V, V_NODELAY), () => {
          this.sset(c, S, S_NODELAY, () => c.i32Const(1));
          c.i32Const(OP_NODELAY);
          c.i32Const(0);
          c.i32Const(0);
          this.sget(c, S, S_H);
          c.i32Const(1);
          this.netCall(c);
          c.drop();
        });
      }
      this.vset(c, V, V_CONNS, () => {
        this.vget(c, V, V_CONNS);
        c.i32Const(1);
        c.i32Add();
      });
      this.sset(c, S, S_SERVER, () => c.localGet(V));
      c.localGet(V);
      c.localGet(S);
      c.call(this.emitHelper(LV_CONN));
      c.drop();
    });
  }

  /* ── net.connect ───────────────────────────────────────────────────── */

  /** net.connect(port, host[, cb]) -> the socket, or null with the error
   * pending (lookupAndConnect's synchronous validation). `host` "" is
   * 'localhost'; `cb` null is none. */
  connectHelper(): number {
    return this.fn("connect", [F64, this.strRef, this.ref(this.deps.voidClos().clos), this.deps.dynRef()], [this.sockRef()], (f) =>
      this.connectBody(f, 2, 3, null),
    );
  }

  /** connectHelper's body; `ex` (INC-29 U2, connectExHelper) adds the
   * Socket constructor's kSetNoDelay and connect()'s setTimeout. */
  private connectBody(f: Fn, CB: number, ATTEMPT: number, ex: { noDelay: number; timeout: number } | null): void {
      const c = f.c;
      const PORT = 0;
      const HOST = 1;
      const S = f.local(this.sockRef());
      const H2 = f.local(this.strRef);
      const I = f.local(I32);
      const FAM = f.local(I32);
      c.call(this.sockNewHelper());
      c.localSet(S);
      if (ex !== null) {
        this.sset(c, S, S_NODELAY, () => c.localGet(ex.noDelay));
        this.if_(c, () => {
          c.localGet(ex.timeout);
          c.f64Const(0);
          c.f64Ne();
        }, () => {
          c.localGet(S);
          c.localGet(ex.timeout);
          c.call(this.setTimeoutHelper());
        });
      }
      this.if_(c, () => {
        c.localGet(CB);
        c.refIsNull();
        c.i32Eqz();
      }, () => {
        c.localGet(S);
        c.localGet(CB);
        c.i32Const(1);
        c.i32Const(0);
        c.call(this.addHelper(L_CONNECT));
      });
      this.sset(c, S, S_HAS_HANDLE, () => c.i32Const(1));
      this.sset(c, S, S_CONNECTING, () => c.i32Const(1));
      // lookupAndConnect: options.host || 'localhost'.
      c.localGet(HOST);
      c.arrayLen();
      c.ifResult(this.strRef);
      c.localGet(HOST);
      c.else_();
      this.lit(c, "localhost");
      c.end();
      c.localSet(H2);
      // validateStringWithoutNullBytes(host, 'options.host')
      this.while_(c, () => {
        c.localGet(I);
        c.localGet(H2);
        c.arrayLen();
        c.i32LtU();
      }, () => {
        this.if_(c, () => {
          c.localGet(H2);
          c.localGet(I);
          c.arrayGetU(this.deps.strType());
          c.i32Eqz();
        }, () => {
          this.throwNew(c, "%TypeError", "TypeError", (c2) => {
            this.lit(c2, "The property 'options.host' must be a string without null bytes. Received ");
            c2.localGet(H2);
            c2.call(this.deps.inspectStr());
            this.concat(c2);
          }, "ERR_INVALID_ARG_VALUE");
          c.refNull(this.sockType());
          c.return_();
        });
        c.localGet(I);
        c.i32Const(1);
        c.i32Add();
        c.localSet(I);
      });
      c.localGet(PORT);
      c.call(this.validatePortHelper("Port"));
      c.i32Eqz();
      c.ifVoid();
      c.refNull(this.sockType());
      c.return_();
      c.end();
      // autoSelectFamily is the default (true); the attempt budget is
      // validated, then has nothing to time (SEMANTICS.md S087).
      c.localGet(ATTEMPT);
      c.call(this.deps.attemptCheck());
      c.i32Eqz();
      c.ifVoid();
      c.refNull(this.sockType());
      c.return_();
      c.end();
      this.sset(c, S, S_HOST, () => c.localGet(H2));
      this.sset(c, S, S_PORT, () => {
        c.localGet(PORT);
        c.i32TruncF64S();
      });
      c.localGet(H2);
      c.call(this.isIPHelper());
      c.localTee(FAM);
      c.ifVoid();
      this.nextTick(c, this.ipConnectTick(), { sock: () => c.localGet(S), n: () => c.localGet(FAM) });
      c.else_();
      // dns.lookup(host, { family: 0, hints: ADDRCONFIG (32), all: true })
      this.sset(c, S, S_LOOKUP, () => {
        c.localGet(S);
        c.localGet(H2);
        c.i32Const(0);
        c.i32Const(32);
        c.call(this.resolveOpHelper());
      });
      c.end();
      c.localGet(S);
  }

  /** lookupAndConnect's nextTick for an IP host. */
  private ipConnectTick(): number {
    return this.tickFn("ipConnect", (f, e) => {
      const c = f.c;
      this.if_(c, () => this.sget(c, e.sock, S_CONNECTING), () => {
        c.localGet(e.sock);
        this.sget(c, e.sock, S_HOST);
        this.sget(c, e.sock, S_PORT);
        c.localGet(e.n);
        c.call(this.internalConnectHelper());
      });
    });
  }

  /** internalConnect(self, address, port, addressType) */
  private internalConnectHelper(): number {
    return this.fn("internalConnect", [this.sockRef(), this.strRef, I32, I32], [], (f) => {
      const c = f.c;
      const S = 0;
      const R = f.local(I32);
      c.localGet(1);
      c.localGet(2);
      c.localGet(3);
      c.call(this.connectOpHelper());
      c.localSet(R);
      this.sset(c, S, S_ATT_ADDR, () => c.localGet(1));
      this.sset(c, S, S_ATT_FAMILY, () => c.localGet(3));
      this.if_(c, () => {
        c.localGet(R);
        c.i32Const(0);
        c.i32LtS();
      }, () => {
        c.localGet(S);
        c.localGet(R);
        this.lit(c, "connect");
        c.localGet(1);
        c.localGet(2);
        c.call(this.hostPortExHelper());
        c.call(this.destroyHelper());
        c.return_();
      });
      this.sset(c, S, S_H, () => c.localGet(R));
      c.localGet(R);
      c.localGet(S);
      c.call(this.tableSetHelper());
    });
  }

  /** context.errors.push(ex) — the first is kept for the aggregate's
   * code. */
  private pushAttemptErr(c: Code, s: number, pushErr: () => void): void {
    this.if_(c, () => {
      this.sget(c, s, S_ERR_N);
      c.i32Eqz();
    }, () => this.sset(c, s, S_ERR_FIRST, pushErr));
    this.sset(c, s, S_ERR_N, () => {
      this.sget(c, s, S_ERR_N);
      c.i32Const(1);
      c.i32Add();
    });
  }

  /** internalConnectMultiple(context) — the addresses one after another
   * (no attempt timer: SEMANTICS.md S087). */
  private internalConnectMultipleHelper(): number {
    return this.fn("internalConnectMultiple", [this.sockRef()], [], (f) => {
      const c = f.c;
      const S = 0;
      const CUR = f.local(I32);
      const ADDR = f.local(this.strRef);
      const FAM = f.local(I32);
      const R = f.local(I32);
      const ERR = f.local(this.errRef);
      c.block();
      c.loop();
      this.if_(c, () => {
        this.sget(c, S, S_ADDR_CUR);
        this.sget(c, S, S_ADDR_N);
        c.i32Eq();
      }, () => {
        c.localGet(S);
        this.sget(c, S, S_ERR_N);
        c.ifResult(this.errRef);
        this.deps.newError(c, "%Error", "AggregateError", (c2) => this.lit(c2, ""), (c2) => {
          this.sget(c2, S, S_ERR_FIRST);
          c2.structGet(this.deps.errType(), 3);
        });
        c.else_();
        this.nodeErr(c, "Socket connection timeout", "ERR_SOCKET_CONNECTION_TIMEOUT");
        c.end();
        c.call(this.destroyHelper());
        c.return_();
      });
      this.sget(c, S, S_ADDR_CUR);
      c.localSet(CUR);
      this.sset(c, S, S_ADDR_CUR, () => {
        c.localGet(CUR);
        c.i32Const(1);
        c.i32Add();
      });
      // A later attempt reinitializes the handle: the old one closes.
      this.if_(c, () => {
        c.localGet(CUR);
        c.i32Const(0);
        c.i32GtS();
        this.sget(c, S, S_H);
        c.i32Const(0);
        c.i32Ne();
        c.i32And();
      }, () => {
        this.hostClose(c, () => this.sget(c, S, S_H));
        this.sset(c, S, S_H, () => c.i32Const(0));
        this.closure(c, this.noopCloseTick(), {});
        c.call(this.closingPushHelper());
      });
      this.sget(c, S, S_ADDRS);
      c.localGet(CUR);
      c.arrayGet(this.strArrT);
      c.localSet(ADDR);
      this.sget(c, S, S_FAMS);
      c.localGet(CUR);
      c.arrayGet(this.i32ArrT);
      c.localSet(FAM);
      c.localGet(ADDR);
      this.sget(c, S, S_PORT);
      c.localGet(FAM);
      c.call(this.connectOpHelper());
      c.localSet(R);
      this.sset(c, S, S_ATT_ADDR, () => c.localGet(ADDR));
      this.sset(c, S, S_ATT_FAMILY, () => c.localGet(FAM));
      this.if_(c, () => {
        c.localGet(R);
        c.i32Const(0);
        c.i32GtS();
      }, () => {
        this.sset(c, S, S_H, () => c.localGet(R));
        c.localGet(R);
        c.localGet(S);
        c.call(this.tableSetHelper());
        c.br(2);
      });
      c.localGet(R);
      this.lit(c, "connect");
      c.localGet(ADDR);
      this.sget(c, S, S_PORT);
      c.call(this.hostPortExHelper());
      c.localSet(ERR);
      this.pushAttemptErr(c, S, () => c.localGet(ERR));
      c.br(0);
      c.end();
      c.end();
    });
  }

  /** afterConnect(status, handle, req, readable, writable) */
  private afterConnectHelper(): number {
    return this.fn("afterConnect", [this.sockRef(), I32, I32], [], (f) => {
      const c = f.c;
      const S = 0;
      const ST = 1;
      const P = 2;
      this.if_(c, () => {
        c.localGet(S);
        c.call(this.destroyedHelper());
      }, () => c.return_());
      this.sset(c, S, S_CONNECTING, () => c.i32Const(0));
      this.if_(c, () => {
        c.localGet(ST);
        c.i32Eqz();
      }, () => {
        this.setPeer(c, S, P);
        // INC-29 U2: self._unrefTimer()
        if (this.deps.http !== undefined) {
          c.localGet(S);
          c.call(this.unrefTimerHelper());
        }
        this.if_(c, () => this.sget(c, S, S_NODELAY), () => {
          c.i32Const(OP_NODELAY);
          c.i32Const(0);
          c.i32Const(0);
          this.sget(c, S, S_H);
          c.i32Const(1);
          this.netCall(c);
          c.drop();
        });
        c.localGet(S);
        c.call(this.emitHelper(L_CONNECT));
        c.drop();
        this.excReturn(c);
        this.if_(c, () => {
          c.localGet(S);
          c.call(this.isPausedHelper());
          c.i32Eqz();
        }, () => {
          c.localGet(S);
          c.f64Const(0);
          c.call(this.readHelper());
          c.drop();
        });
      }, () => {
        c.localGet(S);
        c.localGet(ST);
        this.lit(c, "connect");
        this.sget(c, S, S_ATT_ADDR);
        this.sget(c, S, S_PORT);
        c.call(this.hostPortExHelper());
        c.call(this.destroyHelper());
      });
    });
  }

  private connectErrorTick(): number {
    return this.tickFn("connectErrorNT", (f, e) => {
      f.c.localGet(e.sock);
      f.c.localGet(e.err);
      f.c.call(this.destroyHelper());
    });
  }

  /** The answer to a socket's lookup (lookupAndConnectMultiple's
   * callback): `p` is the payload (u32 count, then count x (u32 family,
   * address run)). */
  private connectLookupDoneHelper(): number {
    return this.fn("connectLookupDone", [this.sockRef(), I32, I32], [], (f) => {
      const c = f.c;
      const S = 0;
      const ST = 1;
      const P = 2;
      const N = f.local(I32);
      const I = f.local(I32);
      const AT = f.local(I32);
      const FAM = f.local(I32);
      const ADDR = f.local(this.strRef);
      const PREF = f.local(I32); // the first valid address's family
      const G0 = f.local(this.ref(this.strArrT));
      const G1 = f.local(this.ref(this.strArrT));
      const N0 = f.local(I32);
      const N1 = f.local(I32);
      const J = f.local(I32);
      const DUP = f.local(I32);
      const OUTA = f.local(this.ref(this.strArrT));
      const OUTF = f.local(this.ref(this.i32ArrT));
      const K = f.local(I32);
      const ERR = f.local(this.errRef);
      this.if_(c, () => {
        this.sget(c, S, S_CONNECTING);
        c.i32Eqz();
      }, () => c.return_());
      this.if_(c, () => c.localGet(ST), () => {
        c.localGet(ST);
        this.sget(c, S, S_HOST);
        c.call(this.dnsExHelper());
        c.localSet(ERR);
        this.nextTick(c, this.connectErrorTick(), { sock: () => c.localGet(S), err: () => c.localGet(ERR) });
        c.return_();
      });
      this.loadU32(c, P, 0);
      c.localSet(N);
      c.localGet(N);
      c.arrayNewDefault(this.strArrT);
      c.localSet(G0);
      c.localGet(N);
      c.arrayNewDefault(this.strArrT);
      c.localSet(G1);
      c.localGet(P);
      c.i32Const(4);
      c.i32Add();
      c.localSet(AT);
      this.while_(c, () => {
        c.localGet(I);
        c.localGet(N);
        c.i32LtU();
      }, () => {
        this.loadU32(c, AT, 0);
        c.localSet(FAM);
        c.localGet(AT);
        c.i32Const(4);
        c.i32Add();
        c.call(this.readRunHelper());
        c.localSet(ADDR);
        // The next record: 4 + the run.
        c.localGet(AT);
        c.i32Const(4);
        c.i32Add();
        this.runSize(c, ADDR);
        c.i32Add();
        c.localSet(AT);
        c.localGet(I);
        c.i32Const(1);
        c.i32Add();
        c.localSet(I);
        this.if_(c, () => {
          c.localGet(ADDR);
          c.call(this.isIPHelper());
          c.i32Const(0);
          c.i32Ne();
          c.localGet(FAM);
          c.i32Const(4);
          c.i32Eq();
          c.localGet(FAM);
          c.i32Const(6);
          c.i32Eq();
          c.i32Or();
          c.i32And();
        }, () => {
          this.if_(c, () => {
            c.localGet(PREF);
            c.i32Eqz();
          }, () => {
            c.localGet(FAM);
            c.localSet(PREF);
          });
          // Only try an address once (within its family group).
          const addTo = (G: number, NG: number): void => {
            c.i32Const(0);
            c.localSet(DUP);
            c.i32Const(0);
            c.localSet(J);
            this.while_(c, () => {
              c.localGet(J);
              c.localGet(NG);
              c.i32LtS();
            }, () => {
              this.if_(c, () => {
                c.localGet(G);
                c.localGet(J);
                c.arrayGet(this.strArrT);
                c.localGet(ADDR);
                c.call(this.strEqHelper());
              }, () => {
                c.i32Const(1);
                c.localSet(DUP);
              });
              c.localGet(J);
              c.i32Const(1);
              c.i32Add();
              c.localSet(J);
            });
            this.if_(c, () => {
              c.localGet(DUP);
              c.i32Eqz();
            }, () => {
              c.localGet(G);
              c.localGet(NG);
              c.localGet(ADDR);
              c.arraySet(this.strArrT);
              c.localGet(NG);
              c.i32Const(1);
              c.i32Add();
              c.localSet(NG);
            });
          };
          this.if_(c, () => {
            c.localGet(FAM);
            c.localGet(PREF);
            c.i32Eq();
          }, () => addTo(G0, N0), () => addTo(G1, N1));
        });
      });
      this.if_(c, () => {
        c.localGet(N0);
        c.localGet(N1);
        c.i32Add();
        c.i32Eqz();
      }, () => this.trap(c));
      // Alternate the families, the preferred one first.
      c.localGet(N0);
      c.localGet(N1);
      c.i32Add();
      c.localTee(N);
      c.arrayNewDefault(this.strArrT);
      c.localSet(OUTA);
      c.localGet(N);
      c.arrayNewDefault(this.i32ArrT);
      c.localSet(OUTF);
      c.i32Const(0);
      c.localSet(I);
      this.while_(c, () => {
        c.localGet(I);
        c.localGet(N0);
        c.i32LtS();
        c.localGet(I);
        c.localGet(N1);
        c.i32LtS();
        c.i32Or();
      }, () => {
        for (const [G, NG, other] of [[G0, N0, false], [G1, N1, true]] as const) {
          this.if_(c, () => {
            c.localGet(I);
            c.localGet(NG);
            c.i32LtS();
          }, () => {
            c.localGet(OUTA);
            c.localGet(K);
            c.localGet(G);
            c.localGet(I);
            c.arrayGet(this.strArrT);
            c.arraySet(this.strArrT);
            c.localGet(OUTF);
            c.localGet(K);
            if (other) {
              c.i32Const(10);
              c.localGet(PREF);
              c.i32Sub();
            } else {
              c.localGet(PREF);
            }
            c.arraySet(this.i32ArrT);
            c.localGet(K);
            c.i32Const(1);
            c.i32Add();
            c.localSet(K);
          });
        }
        c.localGet(I);
        c.i32Const(1);
        c.i32Add();
        c.localSet(I);
      });
      this.if_(c, () => {
        c.localGet(N);
        c.i32Const(1);
        c.i32Eq();
      }, () => {
        c.localGet(S);
        c.localGet(OUTA);
        c.i32Const(0);
        c.arrayGet(this.strArrT);
        this.sget(c, S, S_PORT);
        c.localGet(OUTF);
        c.i32Const(0);
        c.arrayGet(this.i32ArrT);
        c.call(this.internalConnectHelper());
        c.return_();
      });
      this.sset(c, S, S_ADDRS, () => c.localGet(OUTA));
      this.sset(c, S, S_FAMS, () => c.localGet(OUTF));
      this.sset(c, S, S_ADDR_N, () => c.localGet(N));
      this.sset(c, S, S_ADDR_CUR, () => c.i32Const(0));
      this.sset(c, S, S_ERR_N, () => c.i32Const(0));
      this.sset(c, S, S_MULTI, () => c.i32Const(1));
      c.localGet(S);
      c.call(this.internalConnectMultipleHelper());
    });
  }

  /** `(a, b) -> i32` string equality. */
  private strEqHelper(): number {
    return this.fn("strEq", [this.strRef, this.strRef], [I32], (f) => {
      const c = f.c;
      const I = f.local(I32);
      this.if_(c, () => {
        c.localGet(0);
        c.arrayLen();
        c.localGet(1);
        c.arrayLen();
        c.i32Ne();
      }, () => {
        c.i32Const(0);
        c.return_();
      });
      this.while_(c, () => {
        c.localGet(I);
        c.localGet(0);
        c.arrayLen();
        c.i32LtU();
      }, () => {
        this.if_(c, () => {
          c.localGet(0);
          c.localGet(I);
          c.arrayGetU(this.deps.strType());
          c.localGet(1);
          c.localGet(I);
          c.arrayGetU(this.deps.strType());
          c.i32Ne();
        }, () => {
          c.i32Const(0);
          c.return_();
        });
        c.localGet(I);
        c.i32Const(1);
        c.i32Add();
        c.localSet(I);
      });
      c.i32Const(1);
    });
  }


  /** isIpv6LinkLocal(ip): an IPv6 address whose first 16 bits are in
   * fe80::/10. */
  private linkLocalHelper(): number {
    return this.fn("linkLocal", [this.strRef], [I32], (f) => {
      const c = f.c;
      const S = 0;
      const I = f.local(I32);
      const V = f.local(I32);
      const CH = f.local(I32);
      const D = f.local(I32);
      this.if_(c, () => {
        c.localGet(S);
        c.call(this.isIPHelper());
        c.i32Const(6);
        c.i32Ne();
      }, () => {
        c.i32Const(0);
        c.return_();
      });
      c.block();
      c.loop();
      c.localGet(I);
      c.localGet(S);
      c.arrayLen();
      c.i32GeU();
      c.brIf(1);
      c.localGet(S);
      c.localGet(I);
      c.arrayGetU(this.deps.strType());
      c.localTee(CH);
      c.i32Const(58);
      c.i32Eq();
      c.brIf(1);
      // A hex digit (the address is valid: nothing else precedes ":").
      c.localGet(CH);
      c.i32Const(57);
      c.i32LeU();
      c.ifResult(I32);
      c.localGet(CH);
      c.i32Const(48);
      c.i32Sub();
      c.else_();
      c.localGet(CH);
      c.i32Const(32);
      c.i32Or();
      c.i32Const(87);
      c.i32Sub();
      c.end();
      c.localSet(D);
      c.localGet(V);
      c.i32Const(4);
      c.i32Shl();
      c.localGet(D);
      c.i32Or();
      c.localSet(V);
      c.localGet(I);
      c.i32Const(1);
      c.i32Add();
      c.localSet(I);
      c.br(0);
      c.end();
      c.end();
      c.localGet(V);
      c.i32Const(0xffc0);
      c.i32And();
      c.i32Const(0xfe80);
      c.i32Eq();
    });
  }

  /** The answer to a server's lookup (lookupAndListen's callback):
   * filterOnlyValidAddress — the first address that is not IPv6
   * link-local, else the first. The requested host waits in V_ADDR. */
  private listenLookupAnswerHelper(): number {
    return this.fn("listenLookupAnswer", [this.srvRef(), I32, I32], [], (f) => {
      const c = f.c;
      const V = 0;
      const ST = 1;
      const P = 2;
      const N = f.local(I32);
      const I = f.local(I32);
      const AT = f.local(I32);
      const FAM = f.local(I32);
      const ADDR = f.local(this.strRef);
      const PICK = f.local(this.strRef);
      const PICKF = f.local(I32);
      const FIRST = f.local(this.strRef);
      const FIRSTF = f.local(I32);
      this.if_(c, () => c.localGet(ST), () => {
        c.localGet(V);
        c.localGet(ST);
        this.vget(c, V, V_ADDR);
        c.call(this.dnsExHelper());
        c.refNull(this.deps.strType());
        c.i32Const(0);
        c.call(this.listenLookupDoneHelper());
        c.return_();
      });
      this.loadU32(c, P, 0);
      c.localSet(N);
      this.if_(c, () => {
        c.localGet(N);
        c.i32Eqz();
      }, () => this.trap(c));
      c.localGet(P);
      c.i32Const(4);
      c.i32Add();
      c.localSet(AT);
      this.while_(c, () => {
        c.localGet(I);
        c.localGet(N);
        c.i32LtU();
      }, () => {
        this.loadU32(c, AT, 0);
        c.localSet(FAM);
        c.localGet(AT);
        c.i32Const(4);
        c.i32Add();
        c.call(this.readRunHelper());
        c.localSet(ADDR);
        c.localGet(AT);
        c.i32Const(4);
        c.i32Add();
        this.runSize(c, ADDR);
        c.i32Add();
        c.localSet(AT);
        this.if_(c, () => {
          c.localGet(I);
          c.i32Eqz();
        }, () => {
          c.localGet(ADDR);
          c.localSet(FIRST);
          c.localGet(FAM);
          c.localSet(FIRSTF);
        });
        this.if_(c, () => {
          c.localGet(PICK);
          c.refIsNull();
          c.localGet(ADDR);
          c.call(this.linkLocalHelper());
          c.i32Eqz();
          c.i32And();
        }, () => {
          c.localGet(ADDR);
          c.localSet(PICK);
          c.localGet(FAM);
          c.localSet(PICKF);
        });
        c.localGet(I);
        c.i32Const(1);
        c.i32Add();
        c.localSet(I);
      });
      this.if_(c, () => {
        c.localGet(PICK);
        c.refIsNull();
      }, () => {
        c.localGet(FIRST);
        c.localSet(PICK);
        c.localGet(FIRSTF);
        c.localSet(PICKF);
      });
      c.localGet(V);
      c.refNull(this.deps.errType());
      c.localGet(PICK);
      c.localGet(PICKF);
      c.i32Eqz();
      c.ifResult(I32);
      c.i32Const(4);
      c.else_();
      c.localGet(PICKF);
      c.end();
      c.call(this.listenLookupDoneHelper());
    });
  }

  /* ── the poll phase ────────────────────────────────────────────────── */

  /** push 1 when the eqref in `local` is a socket */
  private isSock(c: Code, local: number): void {
    c.localGet(local);
    c.refTest(this.sockType());
  }

  private isSrv(c: Code, local: number): void {
    c.localGet(local);
    c.refTest(this.srvType());
  }

  /** `%w.net.event(kind, h, a, b, ptr, len)` — one host event. */
  private eventHelper(): number {
    return this.fn("event", [I32, I32, I32, I32, I32, I32], [], (f) => {
      const c = f.c;
      const KIND = 0;
      const H = 1;
      const A = 2;
      const PTR = 4;
      const LEN = 5;
      const O = f.local(EQ_REF);
      const S = f.local(this.sockRef());
      const V = f.local(this.srvRef());
      const R = f.local(I32);
      const g = this.g();
      c.localGet(H);
      c.call(this.tableGetHelper());
      c.localSet(O);
      // INC-29 U4: a UDP socket's event (dgram.ts).
      if (this.deps.dgram !== undefined) {
        const dg = this.deps.dgram;
        this.if_(c, () => {
          c.localGet(O);
          c.refTest(dg.type());
        }, () => {
          c.localGet(O);
          c.refCast(dg.type());
          c.localGet(KIND);
          c.localGet(A);
          c.localGet(PTR);
          c.localGet(LEN);
          c.call(dg.event());
          c.return_();
        });
      }
      const asSock = (): void => {
        this.if_(c, () => {
          this.isSock(c, O);
          c.i32Eqz();
        }, () => this.trap(c));
        c.localGet(O);
        c.refCast(this.sockType());
        c.localSet(S);
      };
      const asSrv = (): void => {
        this.if_(c, () => {
          this.isSrv(c, O);
          c.i32Eqz();
        }, () => this.trap(c));
        c.localGet(O);
        c.refCast(this.srvType());
        c.localSet(V);
      };
      const kind = (k: number, body: () => void): void => {
        this.if_(c, () => {
          c.localGet(KIND);
          c.i32Const(k);
          c.i32Eq();
        }, () => {
          body();
          c.return_();
        });
      };
      kind(EV_ACCEPT, () => {
        asSrv();
        c.localGet(V);
        c.localGet(A);
        c.localGet(PTR);
        c.call(this.acceptHelper());
      });
      kind(EV_ACCEPT_ERROR, () => {
        asSrv();
        c.localGet(V);
        c.localGet(A);
        this.lit(c, "accept");
        c.call(this.errnoExHelper());
        c.call(this.emitHelper(LV_ERROR));
        c.drop();
      });
      kind(EV_RESOLVE_DONE, () => {
        c.globalGet(g.resolving);
        c.i32Const(1);
        c.i32Sub();
        c.globalSet(g.resolving);
        c.localGet(H);
        c.refNull(EQ_HEAP);
        c.call(this.tableSetHelper());
        this.if_(c, () => this.isSock(c, O), () => {
          asSock();
          this.sset(c, S, S_LOOKUP, () => c.i32Const(0));
          c.localGet(S);
          c.localGet(A);
          c.localGet(PTR);
          c.call(this.connectLookupDoneHelper());
        }, () => {
          asSrv();
          this.vset(c, V, V_LOOKUP, () => c.i32Const(0));
          c.localGet(V);
          c.localGet(A);
          c.localGet(PTR);
          c.call(this.listenLookupAnswerHelper());
        });
      });
      asSock();
      // INC-29 U4: the handshake's outcome and TLS failures (tls.ts).
      if (this.deps.tls !== undefined) {
        const t = this.deps.tls;
        for (const k of [EV_SECURE, EV_TLS_ERROR]) {
          kind(k, () => {
            c.localGet(S);
            c.localGet(KIND);
            c.localGet(A);
            c.localGet(PTR);
            c.localGet(LEN);
            c.call(t.event());
          });
        }
      }
      kind(EV_CONNECT, () => {
        // afterConnectMultiple's failure branch, else afterConnect.
        this.if_(c, () => {
          this.sget(c, S, S_MULTI);
          c.localGet(A);
          c.i32Const(0);
          c.i32Ne();
          c.i32And();
        }, () => {
          this.pushAttemptErr(c, S, () => {
            c.localGet(A);
            this.lit(c, "connect");
            this.sget(c, S, S_ATT_ADDR);
            this.sget(c, S, S_PORT);
            c.call(this.hostPortExHelper());
          });
          this.if_(c, () => this.sget(c, S, S_CONNECTING), () => {
            c.localGet(S);
            c.call(this.internalConnectMultipleHelper());
          });
        }, () => {
          c.localGet(S);
          c.localGet(A);
          c.localGet(PTR);
          c.call(this.afterConnectHelper());
        });
      });
      // INC-29 U2: the Agent's freeSocketOnReadGuard as the handle's onread:
      // any read (data, EOF or an error) destroys the pooled socket.
      const freeGuard = (): void => {
        if (this.deps.http === undefined) return;
        this.if_(c, () => this.sget(c, S, S_FREEGUARD), () => {
          c.localGet(S);
          c.refNull(this.deps.errType());
          c.call(this.destroyHelper());
          c.return_();
        });
      };
      kind(EV_DATA, () => {
        freeGuard();
        if (this.deps.http !== undefined) {
          // INC-29 U2: a handle an http parser consumed reads into the
          // parser (Parser::OnStreamRead), not into the socket.
          this.if_(c, () => this.sget(c, S, S_CONSUMED), () => {
            this.if_(c, () => {
              c.localGet(S);
              c.call(this.destroyedHelper());
              c.i32Eqz();
            }, () => {
              c.localGet(S);
              c.localGet(PTR);
              c.localGet(LEN);
              c.call(this.bytesAtHelper());
              c.call(this.deps.http!.consumedRead());
            });
            c.return_();
          });
          // onStreamRead: stream[kUpdateTimer]()
          c.localGet(S);
          c.call(this.unrefTimerHelper());
        }
        // onStreamRead, nread > 0.
        this.if_(c, () => {
          c.localGet(S);
          c.call(this.destroyedHelper());
          c.i32Eqz();
        }, () => {
          c.localGet(S);
          c.localGet(PTR);
          c.localGet(LEN);
          c.call(this.bytesAtHelper());
          c.call(this.pushHelper());
          this.excReturn(c);
          c.i32Eqz();
          c.ifVoid();
          this.sset(c, S, S_READING, () => c.i32Const(0));
          this.if_(c, () => {
            c.localGet(S);
            c.call(this.destroyedHelper());
            c.i32Eqz();
          }, () => {
            c.i32Const(OP_READ_STOP);
            c.i32Const(0);
            c.i32Const(0);
            this.sget(c, S, S_H);
            c.i32Const(0);
            this.netCall(c);
            c.localSet(R);
            this.if_(c, () => {
              c.localGet(R);
              c.i32Const(0);
              c.i32GtS();
            }, () => this.trap(c));
            this.if_(c, () => {
              c.localGet(R);
              c.i32Const(0);
              c.i32LtS();
            }, () => {
              c.localGet(S);
              c.localGet(R);
              this.lit(c, "read");
              c.call(this.errnoExHelper());
              c.call(this.destroyHelper());
            });
          });
          c.end();
        });
      });
      kind(EV_EOF, () => {
        // onStreamRead, UV_EOF: push(null) then read(0).
        this.sset(c, S, S_READING, () => c.i32Const(0));
        freeGuard();
        // INC-29 U2: stream[kUpdateTimer]() (a consumed handle passes its
        // read errors to this listener too).
        if (this.deps.http !== undefined) {
          c.localGet(S);
          c.call(this.unrefTimerHelper());
        }
        this.if_(c, () => {
          this.sbits(c, S, S_RS, kEndEmitted);
          c.i32Eqz();
        }, () => {
          c.localGet(S);
          c.call(this.pushNullHelper());
          this.excReturn(c);
          c.localGet(S);
          c.f64Const(0);
          c.call(this.readHelper());
          c.drop();
        });
      });
      kind(EV_READ_ERROR, () => {
        this.sset(c, S, S_READING, () => c.i32Const(0));
        freeGuard();
        if (this.deps.http !== undefined) {
          c.localGet(S);
          c.call(this.unrefTimerHelper());
        }
        c.localGet(S);
        c.localGet(A);
        this.lit(c, "read");
        c.call(this.errnoExHelper());
        c.call(this.destroyHelper());
      });
      kind(EV_WRITE_DONE, () => {
        // onWriteComplete(status)
        this.if_(c, () => {
          this.sget(c, S, S_WPEND);
          c.i32Eqz();
        }, () => this.trap(c));
        this.sset(c, S, S_WPEND, () => c.i32Const(0));
        c.localGet(S);
        c.localGet(A);
        c.i32Const(0);
        c.i32LtS();
        c.ifResult(this.errRef);
        c.localGet(A);
        this.lit(c, "write");
        c.call(this.errnoExHelper());
        c.else_();
        c.refNull(this.deps.errType());
        c.end();
        c.call(this.onwriteHelper());
      });
      this.trap(c);
    });
  }

  /** `%w.net.poll()` — the POLL phase: every queued host event, oldest
   * first, each followed by the death check and a checkpoint (each is
   * one libuv callback into Node). A short buffer grows to the length the
   * host needs and asks again. */
  pollHelper(): number {
    return this.fn("poll", [], [], (f) => {
      const c = f.c;
      const BASE = f.local(I32);
      const LEN = f.local(I32);
      const PLEN = f.local(I32);
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
      this.loadU32(c, BASE, 0);
      c.i32Const(SRC_NET);
      c.i32Ne();
      c.ifVoid();
      this.trap(c);
      c.end();
      this.loadU32(c, BASE, 12);
      c.localSet(PLEN);
      c.localGet(LEN);
      c.localGet(PLEN);
      c.i32Const(EV_HEADER_BYTES);
      c.i32Add();
      c.i32Ne();
      c.ifVoid();
      this.trap(c);
      c.end();
      // Every handler reads its payload (into GC values) before it runs a
      // listener or stages a request, so nothing staged later can
      // overwrite a payload still to be read.
      this.loadU32(c, BASE, 8);
      this.loadU32(c, BASE, 4);
      this.loadU32(c, BASE, 16);
      this.loadU32(c, BASE, 20);
      c.localGet(BASE);
      c.i32Const(EV_HEADER_BYTES);
      c.i32Add();
      c.localGet(PLEN);
      c.call(this.eventHelper());
      c.globalGet(this.deps.excKind());
      c.ifVoid();
      c.call(this.deps.reportUncaught());
      c.end();
      this.deps.checkpoint(c);
      c.br(0);
      c.end();
      c.end();
    });
  }

  /** `%w.net.closing()` — libuv's closing-handles phase: every close
   * callback queued before it began, each followed by the death check and
   * a checkpoint. */
  closingHelper(): number {
    return this.fn("closing", [], [], (f) => {
      const c = f.c;
      const ARR = f.local(this.ref(this.tableT));
      const N = f.local(I32);
      const I = f.local(I32);
      const pair = this.deps.voidClos();
      const g = this.g();
      c.globalGet(g.closing);
      c.localSet(ARR);
      c.globalGet(g.closingN);
      c.localSet(N);
      c.refNull(this.tableT);
      c.globalSet(g.closing);
      c.i32Const(0);
      c.globalSet(g.closingN);
      // uv__make_close_pending pushes onto the head of the closing list
      // and uv__run_closing_handles walks it from the head: the handle
      // closed LAST runs FIRST.
      c.localGet(N);
      c.i32Const(1);
      c.i32Sub();
      c.localSet(I);
      this.while_(c, () => {
        c.localGet(I);
        c.i32Const(0);
        c.i32GeS();
      }, () => {
        c.localGet(ARR);
        c.localGet(I);
        c.arrayGet(this.tableT);
        c.refCast(pair.clos);
        c.localGet(ARR);
        c.localGet(I);
        c.arrayGet(this.tableT);
        c.refCast(pair.clos);
        c.structGet(pair.clos, 0);
        c.callRef(pair.fn);
        c.globalGet(this.deps.excKind());
        c.ifVoid();
        c.call(this.deps.reportUncaught());
        c.end();
        this.deps.checkpoint(c);
        c.localGet(I);
        c.i32Const(1);
        c.i32Sub();
        c.localSet(I);
      });
    });
  }

  /** `%w.net.pending() -> i32` — one uv__run_pending pass: every socket
   * fed before the pass began, oldest first (a socket fed during the
   * pass waits for the next one). A fed socket's io callback with an
   * empty write queue is uv__drain: shutdown(2) — which the host did
   * when it accepted SHUTDOWN — then afterShutdown, which calls _final's
   * callback whatever the status; each is one callback into Node,
   * followed by the death check and a checkpoint. A socket closed since
   * it was fed left the queue with its watcher (uv__io_close); its
   * shutdown completes with ECANCELED in the closing phase. Answers
   * whether the pass found anything queued. */
  pendingHelper(): number {
    return this.fn("pending", [], [I32], (f) => {
      const c = f.c;
      const ARR = f.local(this.ref(this.tableT));
      const N = f.local(I32);
      const I = f.local(I32);
      const S = f.local(this.sockRef());
      const g = this.g();
      c.globalGet(g.pend);
      c.localSet(ARR);
      c.globalGet(g.pendN);
      c.localSet(N);
      c.refNull(this.tableT);
      c.globalSet(g.pend);
      c.i32Const(0);
      c.globalSet(g.pendN);
      this.while_(c, () => {
        c.localGet(I);
        c.localGet(N);
        c.i32LtS();
      }, () => {
        c.localGet(ARR);
        c.localGet(I);
        c.arrayGet(this.tableT);
        c.refCast(this.sockType());
        c.localSet(S);
        this.if_(c, () => {
          this.sget(c, S, S_SPEND);
          this.sget(c, S, S_H);
          c.i32Const(0);
          c.i32Ne();
          c.i32And();
        }, () => {
          this.sset(c, S, S_SPEND, () => c.i32Const(0));
          c.localGet(S);
          c.refNull(this.deps.errType());
          c.call(this.onFinishHelper());
          c.globalGet(this.deps.excKind());
          c.ifVoid();
          c.call(this.deps.reportUncaught());
          c.end();
          this.deps.checkpoint(c);
        });
        c.localGet(I);
        c.i32Const(1);
        c.i32Add();
        c.localSet(I);
      });
      c.localGet(N);
      c.i32Const(0);
      c.i32Ne();
    });
  }

  /** `%w.net.pendingQueued() -> i32` — the pending queue is not empty
   * (uv__backend_timeout answers 0). */
  pendingQueuedHelper(): number {
    return this.fn("pendingQueued", [], [I32], (f) => {
      f.c.globalGet(this.g().pendN);
      f.c.i32Const(0);
      f.c.i32Ne();
    });
  }

  /** `%w.net.closingPending() -> i32` */
  closingPendingHelper(): number {
    return this.fn("closingPending", [], [I32], (f) => {
      f.c.globalGet(this.g().closingN);
      f.c.i32Const(0);
      f.c.i32Ne();
    });
  }

  /** `%w.net.alive() -> i32` — an active handle or request holds the
   * loop: a listening server, a socket reading, connecting, or with a
   * write or shutdown outstanding, a lookup in flight, or a handle still
   * to close. */
  aliveHelper(): number {
    return this.fn("alive", [], [I32], (f) => {
      const c = f.c;
      const I = f.local(I32);
      const O = f.local(EQ_REF);
      const S = f.local(this.sockRef());
      const g = this.g();
      this.if_(c, () => {
        c.globalGet(g.closingN);
        c.globalGet(g.resolving);
        c.i32Or();
      }, () => {
        c.i32Const(1);
        c.return_();
      });
      this.if_(c, () => {
        c.globalGet(g.table);
        c.refIsNull();
      }, () => {
        c.i32Const(0);
        c.return_();
      });
      this.while_(c, () => {
        c.localGet(I);
        c.globalGet(g.table);
        c.arrayLen();
        c.i32LtU();
      }, () => {
        c.globalGet(g.table);
        c.localGet(I);
        c.arrayGet(this.tableT);
        c.localSet(O);
        this.if_(c, () => this.isSrv(c, O), () => {
          c.i32Const(1);
          c.return_();
        });
        // INC-29 U4: a bound, ref'd UDP socket (dgram.ts).
        if (this.deps.dgram !== undefined) {
          const dg = this.deps.dgram;
          this.if_(c, () => {
            c.localGet(O);
            c.refTest(dg.type());
          }, () => {
            this.if_(c, () => {
              c.localGet(O);
              c.refCast(dg.type());
              c.call(dg.alive());
            }, () => {
              c.i32Const(1);
              c.return_();
            });
          });
        }
        this.if_(c, () => this.isSock(c, O), () => {
          c.localGet(O);
          c.refCast(this.sockType());
          c.localSet(S);
          this.if_(c, () => {
            this.sget(c, S, S_H);
            c.localGet(I);
            c.i32Eq();
            this.sget(c, S, S_READING);
            // INC-29 U2: an unref'd handle's reading does not hold the loop
            // (its requests still do).
            if (this.deps.http !== undefined) {
              this.sget(c, S, S_UNREF);
              c.i32Eqz();
              c.i32And();
            }
            this.sget(c, S, S_CONNECTING);
            c.i32Or();
            this.sget(c, S, S_WPEND);
            c.i32Or();
            this.sget(c, S, S_SPEND);
            c.i32Or();
            c.i32And();
          }, () => {
            c.i32Const(1);
            c.return_();
          });
        });
        c.localGet(I);
        c.i32Const(1);
        c.i32Add();
        c.localSet(I);
      });
      c.i32Const(0);
    });
  }
}
