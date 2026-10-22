/* INC-29 U2 — node:http on the WasmGC tier: http.Server, ServerResponse,
 * IncomingMessage, ClientRequest and http.Agent, built in the module from
 * Node v24.18.1's own lib/_http_server.js, _http_outgoing.js,
 * _http_incoming.js, _http_client.js, _http_agent.js and _http_common.js,
 * over node:net's sockets and servers (net.ts) and llhttp (http-llhttp.ts).
 * No host import of its own: an http module is a net module, and the host
 * still performs only OS-level socket operations (abi.ts netCall).
 *
 * THE SHAPE. Each JS object is a GC struct and each JS function a wasm
 * function carrying Node's name, transcribed statement for statement in
 * Node's order: the validation ladders and their texts, every
 * process.nextTick, every emit and which listener runs first, the
 * 'finish' / 'close' timing, the Date / Connection / Keep-Alive /
 * Transfer-Encoding head lines, the Agent's sockets / freeSockets /
 * requests tables and its keep-alive pooling. Node's internal listeners
 * (the server's socketOnData / socketOnEnd / ..., the client's
 * socketCloseListener, the Agent's onFree / onClose / onTimeout /
 * onRemove, resOnFinish, responseOnEnd, ...) are closures on the same
 * listener lists the program's own listeners join, so their order against
 * the program's is Node's.
 *
 * THE PARSER. Node's HTTPParser is C++ (src/node_http_parser.cc) around
 * llhttp: the Parser glue below is that file's transcription — the header
 * accumulation and its 32-field flush, the max-header-size accounting,
 * Execute / Finish and their error objects, the consumed-stream reader of
 * a server socket — including where its callbacks run with or without the
 * task queues: on_headers_complete and on_message_complete skip them, but
 * on_body and the kOnExecute callback are full MakeCallbacks, so on a
 * server socket (whose handle the parser consumes) the nextTick queue and
 * the microtasks drain after each body chunk and after each read, exactly
 * where Node drains them.
 *
 * SEMANTICS.md S088 registers where this tier and Node part. */
import { Code } from "./code.js";
import { A, Fn, type X } from "./asm.js";
import { F64, I32, I64, ModuleBuilder, type FieldType, type ValType } from "./module.js";
import { NET_LISTS, NET_SOCK_HTTP, NET_SRV_HTTP, NetBuilder, type NetList } from "./net.js";
import { HPE_NAMES, HPE_OK, HPE_PAUSED_UPGRADE, HPE_USER, HTTP_REQUEST, HTTP_RESPONSE, LlhttpBuilder, type LlFields } from "./http-llhttp.js";

const EQ_HEAP = -0x13;
const EQ_REF: ValType = { kind: "ref", nullable: true, typeIndex: EQ_HEAP };

export interface HttpDeps {
  net: () => NetBuilder;
  strRef: () => ValType;
  strType: () => number;
  pushStrLit: (c: Code, value: string) => void;
  /** `(a, b) -> a + b` */
  concat: () => number;
  /** `(f64) -> string`, Number.prototype.toString */
  f64ToStr: () => number;
  /** `(a, b) -> i32` string equality */
  strEq: () => number;
  voidClos: () => { clos: number; fn: number };
  errClos: () => { clos: number; fn: number };
  dataClos: () => { clos: number; fn: number };
  sockClos: () => { clos: number; fn: number };
  /** `(req, res) => void` — 'request' listeners. */
  reqResClos: () => { clos: number; fn: number };
  /** `(res) => void` — 'response' listeners. */
  incClos: () => { clos: number; fn: number };
  nextTickEnqueue: () => number;
  excKind: () => number;
  /** One full checkpoint (ticks, then microtasks) — emitted inline. Only
   * ever emitted inside the late-bodied drain function (see drainFn). */
  checkpoint: (c: Code) => void;
  errType: () => number;
  newError: (c: Code, className: string, name: string, pushMessage: (c: Code) => void, pushCode: (c: Code) => void) => void;
  throwStack: (c: Code) => void;
  bytesType: () => number;
  bufType: () => number;
  /** `(string) -> bytes` for one encoding name (Buffer.from(s, enc)). */
  strToBytes: (enc: string) => number;
  /** timers.ts */
  setTimeoutHandle: () => number;
  setInterval: () => number;
  clearTimer: () => number;
  unrefTimer: () => number;
  /** `() -> f64` the loop clock (uv_hrtime's place, in ms). */
  now: () => number;
  /** `() -> f64` the wall clock (Date.now's source, unfloored). */
  wallClock: () => number;
  /** `(string) -> string`, util.inspect of a string. */
  inspectStr: () => number;
  /** `(string array, count) -> string`: util.inspect of a string[]. */
  inspectStrArr: () => number;
  /** `(f64) -> string`, util.format's %s of a number. */
  numReceived: () => number;
  /** The late-bodied hooks: the emitter fills the drain function's body at
   * the end of emission, once every queue the module has exists. */
  registerLate: (build: () => void) => void;
  /** `(string) -> f64`, Number(s) (ToNumber). */
  strToNumber: () => number;
  /** `(bytes) -> string`, buf.toString('utf8'). */
  utf8Decode: () => number;
  /** `(string) -> string`, String.prototype.toLowerCase. */
  toLowerCase: () => number;
}

/* ── the Readable state bits (lib/internal/streams/readable.js; the
 * IncomingMessage subset, the same values net.ts uses) ─────────────── */
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
const kMultiAwaitDrain = 1 << 18;

/* Writable bits net.ts keeps on a socket that http.ts reads. */
const wEnding = 1 << 0;
const wEnded = 1 << 1;
const wFinished = 1 << 2;

/** Node's getDefaultHighWaterMark(false). */
const HWM = 65536;

/* ── $inc: IncomingMessage ─────────────────────────────────────────── */
const I_RS = 0;
const I_RLEN = 1;
const I_RBUF = 2;
const I_RHEAD = 3;
const I_RN = 4;
const I_RERR = 5;
const I_SOCK = 6;
const I_MAJOR = 7;
const I_MINOR = 8;
const I_COMPLETE = 9;
const I_RAWH = 10; // string array (rawHeaders)
const I_HCOUNT = 11; // kHeadersCount
const I_RAWH_N = 12; // rawHeaders.length
const I_RAWT = 13;
const I_TCOUNT = 14;
const I_RAWT_N = 15;
const I_URL = 16;
const I_METHOD = 17; // null = null
const I_STATUS = 18; // i32, -1 = null
const I_STATUSMSG = 19; // null = null
const I_ABORTED = 20;
const I_UPGRADE = 21;
const I_CONSUMING = 22;
const I_DUMPED = 23;
const I_SKIP = 24; // kSkipPendingData
const I_JOINDUP = 25;
const I_REQ = 26; // eqref: res.req (the ClientRequest) on a client response
const I_HEADERS = 27; // eqref: the dyn surface's cached headers object
const I_SERVER = 28; // i32: a server request (1) or a client response (0)
const I_LDATA = 29;
const I_LDATA_N = 30;
const I_LEND = 31;
const I_LEND_N = 32;
const I_LCLOSE = 33;
const I_LCLOSE_N = 34;
const I_LERROR = 35;
const I_LERROR_N = 36;
const I_LABORTED = 37;
const I_LABORTED_N = 38;
const I_PIPE = 39; // eqref: the one pipe destination ($out), null = none
const I_AWAIT = 40; // i32: awaitDrainWriters is the destination
const I_PIPEDATA = 41; // eqref: the pipe's ondata closure
const I_PIPEEND = 42; // eqref: the pipe's endFn closure
const I_PIPEUNPIPE = 43; // eqref: dest 'unpipe' (onunpipe)
const I_PIPECLOSE = 44; // eqref: dest 'close' (onclose)
const I_PIPEFINISH = 45; // eqref: dest 'finish' (onfinish)
const I_PIPEERROR = 46; // eqref: dest 'error' (onerror)
const I_PIPEDRAIN = 47; // eqref: dest 'drain' (ondrain), null until needed
const I_PIPEUNPIPESRC = 48; // eqref: src 'unpipe'? (none) — reserved
const I_RAWDYN = 49; // eqref: the dyn surface's cached rawHeaders array
const I_RAWVEC = 50; // eqref: the typed surface's cached rawHeaders string[]

/* ── $out: OutgoingMessage (an open struct; $res and $creq extend it) ─ */
const O_OD = 0; // array of $od (outputData)
const O_OD_N = 1;
const O_OUTSIZE = 2;
const O_WRITABLE = 3;
const O_DESTROYED = 4;
const O_LAST = 5;
const O_CHUNKED = 6;
const O_KEEPALIVE = 7;
const O_MAXREQREACHED = 8;
const O_DEFKEEPALIVE = 9;
const O_CHUNKDEFAULT = 10;
const O_SENDDATE = 11;
const O_RMCONN = 12;
const O_RMCLEN = 13;
const O_RMTE = 14;
const O_STRICTCL = 15;
const O_BYTESWRITTEN = 16; // f64
const O_CONTLEN = 17; // f64
const O_HASCONTLEN = 18; // i32: _contentLength !== null
const O_HASBODY = 19;
const O_TRAILER = 20; // string
const O_NEEDDRAIN = 21;
const O_FINISHED = 22;
const O_HEADERSENT = 23;
const O_CORKED = 24;
const O_CB = 25; // array of $od (kChunkedBuffer)
const O_CB_N = 26;
const O_CBLEN = 27; // kChunkedLength
const O_CLOSED = 28;
const O_SOCKET = 29;
const O_HEADER = 30; // string, null = null
const O_HDRS = 31; // array of $hent (kOutHeaders), null = null
const O_HDRS_N = 32;
const O_KATIMEOUT = 33; // f64
const O_ERRORED = 34; // err
const O_HWM = 35;
const O_REJECTNONSTD = 36;
const O_MAXREQPERSOCK = 37; // f64
const O_LFINISH = 38;
const O_LFINISH_N = 39;
const O_LCLOSE = 40;
const O_LCLOSE_N = 41;
const O_LPREFINISH = 42;
const O_LPREFINISH_N = 43;
const O_LDRAIN = 44;
const O_LDRAIN_N = 45;
const O_LERROR = 46;
const O_LERROR_N = 47;
const O_LUNPIPE = 48;
const O_LUNPIPE_N = 49;
const O_LTIMEOUT = 50;
const O_LTIMEOUT_N = 51;
const O_KIND = 52; // 1 ServerResponse, 2 ClientRequest
const O_FIELDS = 53;

/* $res: ServerResponse */
const R_REQ = 53;
const R_STATUS = 54; // f64 statusCode
const R_STATUSMSG = 55; // string, null = undefined
const R_SENT100 = 56;
const R_EXPECTCONT = 57;
const R_CONN = 58; // $conn: resOnFinish's bound state, and _onPendingData's
const R_PENDCB = 59; // the lowered end(cb)'s callback, for the end call that follows

/* $creq: ClientRequest */
const C_AGENT = 53; // $agent, null = none
const C_METHOD = 54;
const C_PATH = 55;
const C_HOST = 56;
const C_PROTOCOL = 57;
const C_ENDED = 58;
const C_RES = 59; // $inc, null = null
const C_ABORTED = 60;
const C_TIMEOUTCB = 61; // i32: req.timeoutCb is set (emitRequestTimeout)
const C_UPGRADEORCONNECT = 62;
const C_PARSER = 63; // $parser
const C_MAXHEADERS = 64; // i32, -1 = null
const C_REUSED = 65;
const C_TIMEOUT = 66; // f64, -1 = undefined
const C_ERROR = 67; // err (kError)
const C_PORT = 68; // f64: the options' port (for getName)
const C_LRESPONSE = 69;
const C_LRESPONSE_N = 70;
const C_RTMO = 71; // eqref: the socket 'timeout' listener emitRequestTimeout
const C_RSPTMO = 72; // eqref: the socket 'timeout' listener responseOnTimeout

/* ── $hsrv: an http.Server's own state (net.Server's V_HTTP) ──────── */
const H_LREQ = 0;
const H_LREQ_N = 1;
const H_TIMEOUT = 2; // f64 server.timeout
const H_KATIMEOUT = 3; // f64
const H_KABUFFER = 4; // f64
const H_REQTIMEOUT = 5; // f64
const H_HDRTIMEOUT = 6; // f64
const H_CHECKINTERVAL = 7; // f64
const H_CHECKID = 8; // f64 the connections-checking interval's id, 0 = none
const H_REQUIREHOST = 9;
const H_JOINDUP = 10; // -1 undefined, 0, 1
const H_MAXHEADERS = 11; // i32, -1 = null
const H_MAXREQPERSOCK = 12; // f64
const H_HALFOPEN = 13; // httpAllowHalfOpen
const H_CONNS = 14; // array of $parser (kConnections), null = none yet
const H_CONNS_N = 15;
const H_REJECTNONSTD = 16;
const H_SRV = 17; // the net.Server
const H_SEQ = 18; // i32: the next parser order (std::set's pointer order: SEMANTICS.md S088 (b))

/* ── $conn: the per-connection `state` of connectionListenerInternal ─ */
const K_SRV = 0;
const K_SOCK = 1;
const K_PARSER = 2;
const K_ONDATA = 3;
const K_ONEND = 4;
const K_ONCLOSE = 5;
const K_ONDRAIN = 6;
const K_OUT = 7; // array of $res
const K_OUT_N = 8;
const K_IN = 9; // array of $inc
const K_IN_N = 10;
const K_OUTDATA = 11;
const K_REQCOUNT = 12;
const K_KASET = 13;
const K_ONERROR = 14; // socketOnError's closure (one per socket here)
const K_ONTIMEOUT = 15;
const K_ONRESUME = 16;
const K_ONPAUSE = 17;
const K_RESCLOSE = 18; // onServerResponseClose (one closure per socket: removeListener finds it)

/* ── $parser: an HTTPParser (llhttp state, then the C++ Parser's, then
 * the JS object's own fields) ─────────────────────────────────────── */
const LL: LlFields = {
  _index: 0,
  _span_pos0: 1,
  _span_cb0: 2,
  error: 3,
  reason: 4,
  error_pos: 5,
  _current: 6,
  content_length: 7,
  type: 8,
  method: 9,
  http_major: 10,
  http_minor: 11,
  header_state: 12,
  lenient_flags: 13,
  upgrade: 14,
  finish: 15,
  flags: 16,
  status_code: 17,
  initial_message_completed: 18,
};
const P_URL = 19; // url_ (latin1 string)
const P_STATUSMSG = 20; // status_message_
const P_FIELDS = 21; // string array [32]
const P_VALUES = 22;
const P_NFIELDS = 23;
const P_NVALUES = 24;
const P_HNREAD = 25; // header_nread_
const P_HPAIRS = 26; // header_pairs_
const P_MAXHDR = 27; // max_http_header_size_
const P_HDRSDONE = 28; // headers_completed_
const P_FLUSHED = 29; // have_flushed_
const P_LASTSTART = 30; // f64 last_message_start_ (ms; 0 = idle)
const P_GOTEXC = 31; // got_exception_
const P_CHUNKEXT = 32; // chunk_extensions_nread_
const P_CONNS = 33; // eqref: connectionsList_ ($hsrv), null = none
const P_INALL = 34;
const P_INACTIVE = 35;
const P_JSHDRS = 36; // string array (parser._headers)
const P_JSHDRS_N = 37;
const P_JSURL = 38; // parser._url
const P_SOCK = 39; // parser.socket
const P_INCOMING = 40; // $inc, null = null
const P_OUTGOING = 41; // $creq, null = null
const P_MAXPAIRS = 42; // maxHeaderPairs
const P_CONSUMED = 43; // _consumed
const P_CONN = 44; // $conn: parser.onIncoming = parserOnIncoming.bind(server, socket, state); null = the client's
const P_JOINDUP = 45; // joinDuplicateHeaders: -1 null, 0, 1
const P_FREED = 46; // is_being_freed_
const P_SEQ = 47; // the order key for idle connections
const P_CURBUF = 48; // the bytes being parsed (getCurrentBuffer), null outside an execute
const P_ONEXECUTE = 49; // kOnExecute is set (a server parser)
const P_DRAINS = 50; // MakeCallback drains the queues (the consumed reader's depth)
const P_FIELDS_COUNT = 51;

/* ── $agent ─────────────────────────────────────────────────────────── */
const A_KEEPALIVE = 0;
const A_KAMSECS = 1; // f64
const A_MAXSOCKETS = 2; // f64
const A_MAXFREE = 3; // f64
const A_MAXTOTAL = 4; // f64
const A_TOTAL = 5; // f64 totalSocketCount
const A_FIFO = 6; // scheduling === 'fifo'
const A_TIMEOUT = 7; // f64 options.timeout, -1 = undefined
const A_DEFPORT = 8; // f64 defaultPort
const A_PROTOCOL = 9; // string
const A_NODELAY = 10; // options.noDelay
const A_KABUFFER = 11; // f64 agentKeepAliveTimeoutBuffer
const A_REQUESTS = 12; // array of $amap
const A_REQUESTS_N = 13;
const A_SOCKETS = 14;
const A_SOCKETS_N = 15;
const A_FREE = 16;
const A_FREE_N = 17;
const A_OPTPORT = 18; // f64 this.options.port, -1 = absent
const A_SECURE = 19;

/* $amap: one key of a requests / sockets / freeSockets object. */
const M_NAME = 0;
const M_ARR = 1; // eqref array
const M_N = 2;

/* $od: one outputData / kChunkedBuffer entry. */
const D_STR = 0; // string data, or null
const D_BYTES = 1; // bytes data, or null
const D_ENC = 2; // i32 encoding id
const D_CB = 3; // the callback (errClos), null = none

/* $hent: one kOutHeaders entry: [name, value] under its lowercased key. */
const E_KEY = 0;
const E_NAME = 1;
const E_VAL = 2; // $hv

/* $hv: a header value as set: a string, a number, or an array of them. */
const V_KIND = 0; // 0 string, 1 number, 2 array
const V_STR = 1;
const V_NUM = 2;
const V_ARR = 3; // array of $hv
const V_ARR_N = 4;

/* Encodings (Buffer's names; ENC_NONE = undefined / null). */
export const ENC_NONE = 0;
export const ENC_UTF8 = 1;
export const ENC_LATIN1 = 2;
export const ENC_ASCII = 3;
export const ENC_HEX = 4;
export const ENC_BASE64 = 5;
export const ENC_BASE64URL = 6;
export const ENC_UCS2 = 7;
export const ENC_NAMES: readonly (readonly [number, string])[] = [
  [ENC_UTF8, "utf8"], [ENC_LATIN1, "latin1"], [ENC_ASCII, "ascii"], [ENC_HEX, "hex"],
  [ENC_BASE64, "base64"], [ENC_BASE64URL, "base64url"], [ENC_UCS2, "utf16le"],
];

/** Node's http.STATUS_CODES (lib/_http_server.js). */
export const STATUS_CODES: readonly (readonly [number, string])[] = [
  [100, "Continue"], [101, "Switching Protocols"], [102, "Processing"], [103, "Early Hints"],
  [200, "OK"], [201, "Created"], [202, "Accepted"], [203, "Non-Authoritative Information"],
  [204, "No Content"], [205, "Reset Content"], [206, "Partial Content"], [207, "Multi-Status"],
  [208, "Already Reported"], [226, "IM Used"], [300, "Multiple Choices"], [301, "Moved Permanently"],
  [302, "Found"], [303, "See Other"], [304, "Not Modified"], [305, "Use Proxy"], [307, "Temporary Redirect"],
  [308, "Permanent Redirect"], [400, "Bad Request"], [401, "Unauthorized"], [402, "Payment Required"],
  [403, "Forbidden"], [404, "Not Found"], [405, "Method Not Allowed"], [406, "Not Acceptable"],
  [407, "Proxy Authentication Required"], [408, "Request Timeout"], [409, "Conflict"], [410, "Gone"],
  [411, "Length Required"], [412, "Precondition Failed"], [413, "Payload Too Large"], [414, "URI Too Long"],
  [415, "Unsupported Media Type"], [416, "Range Not Satisfiable"], [417, "Expectation Failed"],
  [418, "I'm a Teapot"], [421, "Misdirected Request"], [422, "Unprocessable Entity"], [423, "Locked"],
  [424, "Failed Dependency"], [425, "Too Early"], [426, "Upgrade Required"], [428, "Precondition Required"],
  [429, "Too Many Requests"], [431, "Request Header Fields Too Large"], [451, "Unavailable For Legal Reasons"],
  [500, "Internal Server Error"], [501, "Not Implemented"], [502, "Bad Gateway"], [503, "Service Unavailable"],
  [504, "Gateway Timeout"], [505, "HTTP Version Not Supported"], [506, "Variant Also Negotiates"],
  [507, "Insufficient Storage"], [508, "Loop Detected"], [509, "Bandwidth Limit Exceeded"], [510, "Not Extended"],
  [511, "Network Authentication Required"],
];

/** llhttp's HTTP_ALL_METHOD_MAP, index = method id (Node's allMethods). */
const ALL_METHODS = [
  "DELETE", "GET", "HEAD", "POST", "PUT", "CONNECT", "OPTIONS", "TRACE", "COPY", "LOCK", "MKCOL", "MOVE",
  "PROPFIND", "PROPPATCH", "SEARCH", "UNLOCK", "BIND", "REBIND", "UNBIND", "ACL", "REPORT", "MKACTIVITY",
  "CHECKOUT", "MERGE", "M-SEARCH", "NOTIFY", "SUBSCRIBE", "UNSUBSCRIBE", "PATCH", "PURGE", "MKCALENDAR",
  "LINK", "UNLINK", "SOURCE", "PRI", "DESCRIBE", "ANNOUNCE", "SETUP", "PLAY", "PAUSE", "TEARDOWN",
  "GET_PARAMETER", "SET_PARAMETER", "REDIRECT", "RECORD", "FLUSH", "QUERY",
];

/** An http listener list: owner struct, array field, count field, and
 * what one listener takes. */
interface HList {
  owner: "inc" | "out" | "hsrv" | "creq";
  arr: number;
  n: number;
  arg: "void" | "data" | "err" | "reqres" | "inc";
}

export const HL = {
  INC_DATA: { owner: "inc", arr: I_LDATA, n: I_LDATA_N, arg: "data" } as HList,
  INC_END: { owner: "inc", arr: I_LEND, n: I_LEND_N, arg: "void" } as HList,
  INC_CLOSE: { owner: "inc", arr: I_LCLOSE, n: I_LCLOSE_N, arg: "void" } as HList,
  INC_ERROR: { owner: "inc", arr: I_LERROR, n: I_LERROR_N, arg: "err" } as HList,
  INC_ABORTED: { owner: "inc", arr: I_LABORTED, n: I_LABORTED_N, arg: "void" } as HList,
  OUT_FINISH: { owner: "out", arr: O_LFINISH, n: O_LFINISH_N, arg: "void" } as HList,
  OUT_CLOSE: { owner: "out", arr: O_LCLOSE, n: O_LCLOSE_N, arg: "void" } as HList,
  OUT_PREFINISH: { owner: "out", arr: O_LPREFINISH, n: O_LPREFINISH_N, arg: "void" } as HList,
  OUT_DRAIN: { owner: "out", arr: O_LDRAIN, n: O_LDRAIN_N, arg: "void" } as HList,
  OUT_ERROR: { owner: "out", arr: O_LERROR, n: O_LERROR_N, arg: "err" } as HList,
  OUT_UNPIPE: { owner: "out", arr: O_LUNPIPE, n: O_LUNPIPE_N, arg: "void" } as HList,
  OUT_TIMEOUT: { owner: "out", arr: O_LTIMEOUT, n: O_LTIMEOUT_N, arg: "void" } as HList,
  SRV_REQUEST: { owner: "hsrv", arr: H_LREQ, n: H_LREQ_N, arg: "reqres" } as HList,
  CREQ_RESPONSE: { owner: "creq", arr: C_LRESPONSE, n: C_LRESPONSE_N, arg: "inc" } as HList,
};

/* The internal-closure environment's fields (one layout per closure
 * pair: the function, four refs and two numbers). */
const T_A = 1;
const T_B = 2;
const T_C = 3;
const T_D = 4;
const T_N = 5;
const T_X = 6;

type Env = { a: number; b: number; c: number; d: number; n: number; x: number };
type Parts = { a?: X; b?: X; c?: X; d?: X; n?: X; x?: X };

export class HttpBuilder {
  private readonly fns = new Map<string, number>();
  private readonly types = new Map<string, number>();
  private globalsField: {
    utc: number;
    utcTimer: number;
    parserSeq: number;
    globalAgent: number;
    drain: number;
    connSeq: number;
  } | null = null;
  private llField: LlhttpBuilder | null = null;

  constructor(
    private readonly mb: ModuleBuilder,
    private readonly deps: HttpDeps,
  ) {}

  /* ── plumbing ─────────────────────────────────────────────────────── */

  get net(): NetBuilder {
    return this.deps.net();
  }

  /** Declare-then-build, as net.ts does (the machine is mutually
   * recursive). */
  private fn(name: string, params: ValType[], results: ValType[], build: (f: Fn, $: A) => void): number {
    const hit = this.fns.get(name);
    if (hit !== undefined) return hit;
    const idx = this.mb.declareFunc(this.mb.funcType(params, results), `%w.http.${name}`);
    this.fns.set(name, idx);
    const f = new Fn(params.length);
    build(f, new A(f));
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

  private get eclosRef(): ValType {
    return this.ref(this.deps.errClos().clos);
  }

  private get vclosRef(): ValType {
    return this.ref(this.deps.voidClos().clos);
  }

  private get sockRef(): ValType {
    return this.net.sockRef();
  }

  private get srvRef(): ValType {
    return this.net.srvRef();
  }

  private get sockT(): number {
    return this.net.sockType();
  }

  private get srvT(): number {
    return this.net.srvType();
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

  private streq($: A, a: X, b: X): X {
    return $.call(this.deps.strEq(), a, b);
  }

  private num2str($: A, n: X): X {
    return $.call(this.deps.f64ToStr(), n);
  }

  /* ── types ────────────────────────────────────────────────────────── */

  private type(key: string, make: () => number): number {
    const hit = this.types.get(key);
    if (hit !== undefined) return hit;
    const t = make();
    this.types.set(key, t);
    return t;
  }

  private get entT(): number {
    return this.type("ent", () =>
      this.mb.structType([
        { storage: EQ_REF, mutable: false },
        { storage: I32, mutable: false },
        { storage: I32, mutable: true },
      ]),
    );
  }

  private get entArrT(): number {
    return this.type("entArr", () => this.mb.arrayType(this.ref(this.entT), true));
  }

  private get chunkArrT(): number {
    return this.type("chunkArr", () => this.mb.arrayType(this.bytesRef, true));
  }

  get strArrT(): number {
    return this.type("strArr", () => this.mb.arrayType(this.strRef, true));
  }

  private get eqArrT(): number {
    return this.type("eqArr", () => this.mb.arrayType(EQ_REF, true));
  }

  /** $od: one outputData entry. */
  private get odT(): number {
    return this.type("od", () =>
      this.mb.structType([
        { storage: this.strRef, mutable: true },
        { storage: this.bytesRef, mutable: true },
        { storage: I32, mutable: false },
        { storage: this.eclosRef, mutable: false },
      ]),
    );
  }

  private get odArrT(): number {
    return this.type("odArr", () => this.mb.arrayType(this.ref(this.odT), true));
  }

  /** $hv: a header value. Self-referential (an array of values). */
  get hvT(): number {
    return this.type("hv", () =>
      this.mb.structType([
        { storage: I32, mutable: false }, // V_KIND
        { storage: this.strRef, mutable: false }, // V_STR
        { storage: F64, mutable: false }, // V_NUM
        { storage: EQ_REF, mutable: true }, // V_ARR (an $hv array)
        { storage: I32, mutable: true }, // V_ARR_N
      ]),
    );
  }

  get hvArrT(): number {
    return this.type("hvArr", () => this.mb.arrayType(this.ref(this.hvT), true));
  }

  /** $hent: one kOutHeaders entry. */
  get hentT(): number {
    return this.type("hent", () =>
      this.mb.structType([
        { storage: this.strRef, mutable: false },
        { storage: this.strRef, mutable: true },
        { storage: this.ref(this.hvT), mutable: true },
      ]),
    );
  }

  get hentArrT(): number {
    return this.type("hentArr", () => this.mb.arrayType(this.ref(this.hentT), true));
  }

  /** $amap: one key of an agent table. */
  get amapT(): number {
    return this.type("amap", () =>
      this.mb.structType([
        { storage: this.strRef, mutable: false },
        { storage: this.ref(this.eqArrT), mutable: true },
        { storage: I32, mutable: true },
        { storage: I32, mutable: false }, // a distinct layout from $ent
      ]),
    );
  }

  get amapArrT(): number {
    return this.type("amapArr", () => this.mb.arrayType(this.ref(this.amapT), true));
  }

  /** $inc */
  incT(): number {
    return this.type("inc", () => {
      const ent = this.ref(this.entArrT);
      const fields: FieldType[] = [
        { storage: I32, mutable: true }, // I_RS
        { storage: I32, mutable: true }, // I_RLEN
        { storage: this.ref(this.chunkArrT), mutable: true }, // I_RBUF
        { storage: I32, mutable: true }, // I_RHEAD
        { storage: I32, mutable: true }, // I_RN
        { storage: this.errRef, mutable: true }, // I_RERR
        { storage: this.sockRef, mutable: true }, // I_SOCK
        { storage: I32, mutable: true }, // I_MAJOR
        { storage: I32, mutable: true }, // I_MINOR
        { storage: I32, mutable: true }, // I_COMPLETE
        { storage: this.ref(this.strArrT), mutable: true }, // I_RAWH
        { storage: I32, mutable: true }, // I_HCOUNT
        { storage: I32, mutable: true }, // I_RAWH_N
        { storage: this.ref(this.strArrT), mutable: true }, // I_RAWT
        { storage: I32, mutable: true }, // I_TCOUNT
        { storage: I32, mutable: true }, // I_RAWT_N
        { storage: this.strRef, mutable: true }, // I_URL
        { storage: this.strRef, mutable: true }, // I_METHOD
        { storage: I32, mutable: true }, // I_STATUS
        { storage: this.strRef, mutable: true }, // I_STATUSMSG
        { storage: I32, mutable: true }, // I_ABORTED
        { storage: I32, mutable: true }, // I_UPGRADE
        { storage: I32, mutable: true }, // I_CONSUMING
        { storage: I32, mutable: true }, // I_DUMPED
        { storage: I32, mutable: true }, // I_SKIP
        { storage: I32, mutable: true }, // I_JOINDUP
        { storage: EQ_REF, mutable: true }, // I_REQ
        { storage: EQ_REF, mutable: true }, // I_HEADERS
        { storage: I32, mutable: true }, // I_SERVER
      ];
      for (let i = 0; i < 5; i++) fields.push({ storage: ent, mutable: true }, { storage: I32, mutable: true });
      fields.push(
        { storage: EQ_REF, mutable: true }, // I_PIPE
        { storage: I32, mutable: true }, // I_AWAIT
        { storage: EQ_REF, mutable: true }, // I_PIPEDATA
        { storage: EQ_REF, mutable: true }, // I_PIPEEND
        { storage: EQ_REF, mutable: true }, // I_PIPEUNPIPE
        { storage: EQ_REF, mutable: true }, // I_PIPECLOSE
        { storage: EQ_REF, mutable: true }, // I_PIPEFINISH
        { storage: EQ_REF, mutable: true }, // I_PIPEERROR
        { storage: EQ_REF, mutable: true }, // I_PIPEDRAIN
        { storage: EQ_REF, mutable: true }, // I_PIPEUNPIPESRC
        { storage: EQ_REF, mutable: true }, // I_RAWDYN
        { storage: EQ_REF, mutable: true }, // I_RAWVEC
        { storage: F64, mutable: false }, // a distinct layout marker
      );
      return this.mb.structType(fields);
    });
  }

  incRef(): ValType {
    return this.ref(this.incT());
  }

  /** The OutgoingMessage fields, shared by $out, $res and $creq. */
  private outFields(): FieldType[] {
    const ent = this.ref(this.entArrT);
    const fields: FieldType[] = [
      { storage: this.ref(this.odArrT), mutable: true }, // O_OD
      { storage: I32, mutable: true }, // O_OD_N
      { storage: I32, mutable: true }, // O_OUTSIZE
      { storage: I32, mutable: true }, // O_WRITABLE
      { storage: I32, mutable: true }, // O_DESTROYED
      { storage: I32, mutable: true }, // O_LAST
      { storage: I32, mutable: true }, // O_CHUNKED
      { storage: I32, mutable: true }, // O_KEEPALIVE
      { storage: I32, mutable: true }, // O_MAXREQREACHED
      { storage: I32, mutable: true }, // O_DEFKEEPALIVE
      { storage: I32, mutable: true }, // O_CHUNKDEFAULT
      { storage: I32, mutable: true }, // O_SENDDATE
      { storage: I32, mutable: true }, // O_RMCONN
      { storage: I32, mutable: true }, // O_RMCLEN
      { storage: I32, mutable: true }, // O_RMTE
      { storage: I32, mutable: true }, // O_STRICTCL
      { storage: F64, mutable: true }, // O_BYTESWRITTEN
      { storage: F64, mutable: true }, // O_CONTLEN
      { storage: I32, mutable: true }, // O_HASCONTLEN
      { storage: I32, mutable: true }, // O_HASBODY
      { storage: this.strRef, mutable: true }, // O_TRAILER
      { storage: I32, mutable: true }, // O_NEEDDRAIN
      { storage: I32, mutable: true }, // O_FINISHED
      { storage: I32, mutable: true }, // O_HEADERSENT
      { storage: I32, mutable: true }, // O_CORKED
      { storage: this.ref(this.odArrT), mutable: true }, // O_CB
      { storage: I32, mutable: true }, // O_CB_N
      { storage: I32, mutable: true }, // O_CBLEN
      { storage: I32, mutable: true }, // O_CLOSED
      { storage: this.sockRef, mutable: true }, // O_SOCKET
      { storage: this.strRef, mutable: true }, // O_HEADER
      { storage: this.ref(this.hentArrT), mutable: true }, // O_HDRS
      { storage: I32, mutable: true }, // O_HDRS_N
      { storage: F64, mutable: true }, // O_KATIMEOUT
      { storage: this.errRef, mutable: true }, // O_ERRORED
      { storage: I32, mutable: true }, // O_HWM
      { storage: I32, mutable: true }, // O_REJECTNONSTD
      { storage: F64, mutable: true }, // O_MAXREQPERSOCK
    ];
    for (let i = 0; i < 7; i++) fields.push({ storage: ent, mutable: true }, { storage: I32, mutable: true });
    fields.push({ storage: I32, mutable: false }); // O_KIND
    if (fields.length !== O_FIELDS) throw new Error("http: $out layout");
    return fields;
  }

  /** $out — the open OutgoingMessage struct. */
  outT(): number {
    return this.type("out", () => this.mb.openStructType("%w.http.out", this.outFields()));
  }

  outRef(): ValType {
    return this.ref(this.outT());
  }

  /** $res — ServerResponse, a subtype of $out. */
  resT(): number {
    return this.type("res", () => {
      const out = this.outT();
      return this.mb.subStructType(
        "%w.http.res",
        [
          ...this.outFields(),
          { storage: this.incRef(), mutable: true }, // R_REQ
          { storage: F64, mutable: true }, // R_STATUS
          { storage: this.strRef, mutable: true }, // R_STATUSMSG
          { storage: I32, mutable: true }, // R_SENT100
          { storage: I32, mutable: true }, // R_EXPECTCONT
          { storage: this.ref(this.connT()), mutable: true }, // R_CONN
          { storage: EQ_REF, mutable: true }, // R_PENDCB
        ],
        out,
      );
    });
  }

  resRef(): ValType {
    return this.ref(this.resT());
  }

  /** $creq — ClientRequest, a subtype of $out. */
  creqT(): number {
    return this.type("creq", () => {
      const out = this.outT();
      const ent = this.ref(this.entArrT);
      return this.mb.subStructType(
        "%w.http.creq",
        [
          ...this.outFields(),
          { storage: this.ref(this.agentT()), mutable: true }, // C_AGENT
          { storage: this.strRef, mutable: true }, // C_METHOD
          { storage: this.strRef, mutable: true }, // C_PATH
          { storage: this.strRef, mutable: true }, // C_HOST
          { storage: this.strRef, mutable: true }, // C_PROTOCOL
          { storage: I32, mutable: true }, // C_ENDED
          { storage: this.incRef(), mutable: true }, // C_RES
          { storage: I32, mutable: true }, // C_ABORTED
          { storage: I32, mutable: true }, // C_TIMEOUTCB
          { storage: I32, mutable: true }, // C_UPGRADEORCONNECT
          { storage: this.ref(this.parserT()), mutable: true }, // C_PARSER
          { storage: I32, mutable: true }, // C_MAXHEADERS
          { storage: I32, mutable: true }, // C_REUSED
          { storage: F64, mutable: true }, // C_TIMEOUT
          { storage: this.errRef, mutable: true }, // C_ERROR
          { storage: F64, mutable: true }, // C_PORT
          { storage: ent, mutable: true }, // C_LRESPONSE
          { storage: I32, mutable: true }, // C_LRESPONSE_N
          { storage: EQ_REF, mutable: true }, // C_RTMO
          { storage: EQ_REF, mutable: true }, // C_RSPTMO
        ],
        out,
      );
    });
  }

  creqRef(): ValType {
    return this.ref(this.creqT());
  }

  /** $hsrv */
  hsrvT(): number {
    return this.type("hsrv", () => {
      const ent = this.ref(this.entArrT);
      return this.mb.structType([
        { storage: ent, mutable: true }, // H_LREQ
        { storage: I32, mutable: true }, // H_LREQ_N
        { storage: F64, mutable: true }, // H_TIMEOUT
        { storage: F64, mutable: true }, // H_KATIMEOUT
        { storage: F64, mutable: true }, // H_KABUFFER
        { storage: F64, mutable: true }, // H_REQTIMEOUT
        { storage: F64, mutable: true }, // H_HDRTIMEOUT
        { storage: F64, mutable: true }, // H_CHECKINTERVAL
        { storage: F64, mutable: true }, // H_CHECKID
        { storage: I32, mutable: true }, // H_REQUIREHOST
        { storage: I32, mutable: true }, // H_JOINDUP
        { storage: I32, mutable: true }, // H_MAXHEADERS
        { storage: F64, mutable: true }, // H_MAXREQPERSOCK
        { storage: I32, mutable: true }, // H_HALFOPEN
        { storage: this.ref(this.eqArrT), mutable: true }, // H_CONNS
        { storage: I32, mutable: true }, // H_CONNS_N
        { storage: I32, mutable: true }, // H_REJECTNONSTD
        { storage: this.srvRef, mutable: true }, // H_SRV
        { storage: I32, mutable: true }, // H_SEQ
      ]);
    });
  }

  private hsrvRef(): ValType {
    return this.ref(this.hsrvT());
  }

  /** $conn */
  connT(): number {
    return this.type("conn", () =>
      this.mb.structType([
        { storage: this.srvRef, mutable: true }, // K_SRV
        { storage: this.sockRef, mutable: true }, // K_SOCK
        { storage: this.ref(this.parserT()), mutable: true }, // K_PARSER
        { storage: EQ_REF, mutable: true }, // K_ONDATA
        { storage: EQ_REF, mutable: true }, // K_ONEND
        { storage: EQ_REF, mutable: true }, // K_ONCLOSE
        { storage: EQ_REF, mutable: true }, // K_ONDRAIN
        { storage: this.ref(this.eqArrT), mutable: true }, // K_OUT
        { storage: I32, mutable: true }, // K_OUT_N
        { storage: this.ref(this.eqArrT), mutable: true }, // K_IN
        { storage: I32, mutable: true }, // K_IN_N
        { storage: I32, mutable: true }, // K_OUTDATA
        { storage: I32, mutable: true }, // K_REQCOUNT
        { storage: I32, mutable: true }, // K_KASET
        { storage: EQ_REF, mutable: true }, // K_ONERROR
        { storage: EQ_REF, mutable: true }, // K_ONTIMEOUT
        { storage: EQ_REF, mutable: true }, // K_ONRESUME
        { storage: EQ_REF, mutable: true }, // K_ONPAUSE
        { storage: EQ_REF, mutable: true }, // K_RESCLOSE
        { storage: F64, mutable: false }, // a distinct layout marker
      ]),
    );
  }

  /** $parser */
  parserT(): number {
    return this.type("parser", () => {
      const fields: FieldType[] = [];
      const ll: [string, ValType][] = [
        ["_index", I32], ["_span_pos0", I32], ["_span_cb0", I32], ["error", I32], ["reason", this.strRef],
        ["error_pos", I32], ["_current", I32], ["content_length", I64], ["type", I32], ["method", I32],
        ["http_major", I32], ["http_minor", I32], ["header_state", I32], ["lenient_flags", I32], ["upgrade", I32],
        ["finish", I32], ["flags", I32], ["status_code", I32], ["initial_message_completed", I32],
      ];
      for (const [name, t] of ll) {
        if ((LL as unknown as Record<string, number>)[name] !== fields.length) throw new Error("http: $parser layout");
        fields.push({ storage: t, mutable: true });
      }
      fields.push(
        { storage: this.strRef, mutable: true }, // P_URL
        { storage: this.strRef, mutable: true }, // P_STATUSMSG
        { storage: this.ref(this.strArrT), mutable: true }, // P_FIELDS
        { storage: this.ref(this.strArrT), mutable: true }, // P_VALUES
        { storage: I32, mutable: true }, // P_NFIELDS
        { storage: I32, mutable: true }, // P_NVALUES
        { storage: I32, mutable: true }, // P_HNREAD
        { storage: I32, mutable: true }, // P_HPAIRS
        { storage: I32, mutable: true }, // P_MAXHDR
        { storage: I32, mutable: true }, // P_HDRSDONE
        { storage: I32, mutable: true }, // P_FLUSHED
        { storage: F64, mutable: true }, // P_LASTSTART
        { storage: I32, mutable: true }, // P_GOTEXC
        { storage: I32, mutable: true }, // P_CHUNKEXT
        { storage: EQ_REF, mutable: true }, // P_CONNS
        { storage: I32, mutable: true }, // P_INALL
        { storage: I32, mutable: true }, // P_INACTIVE
        { storage: this.ref(this.strArrT), mutable: true }, // P_JSHDRS
        { storage: I32, mutable: true }, // P_JSHDRS_N
        { storage: this.strRef, mutable: true }, // P_JSURL
        { storage: this.sockRef, mutable: true }, // P_SOCK
        { storage: this.incRef(), mutable: true }, // P_INCOMING
        { storage: EQ_REF, mutable: true }, // P_OUTGOING
        { storage: I32, mutable: true }, // P_MAXPAIRS
        { storage: I32, mutable: true }, // P_CONSUMED
        { storage: EQ_REF, mutable: true }, // P_CONN
        { storage: I32, mutable: true }, // P_JOINDUP
        { storage: I32, mutable: true }, // P_FREED
        { storage: I32, mutable: true }, // P_SEQ
        { storage: this.bytesRef, mutable: true }, // P_CURBUF
        { storage: I32, mutable: true }, // P_ONEXECUTE
        { storage: I32, mutable: true }, // P_DRAINS
      );
      if (fields.length !== P_FIELDS_COUNT) throw new Error("http: $parser fields");
      return this.mb.structType(fields);
    });
  }

  parserRef(): ValType {
    return this.ref(this.parserT());
  }

  /** $agent */
  agentT(): number {
    return this.type("agent", () =>
      this.mb.structType([
        { storage: I32, mutable: true }, // A_KEEPALIVE
        { storage: F64, mutable: true }, // A_KAMSECS
        { storage: F64, mutable: true }, // A_MAXSOCKETS
        { storage: F64, mutable: true }, // A_MAXFREE
        { storage: F64, mutable: true }, // A_MAXTOTAL
        { storage: F64, mutable: true }, // A_TOTAL
        { storage: I32, mutable: true }, // A_FIFO
        { storage: F64, mutable: true }, // A_TIMEOUT
        { storage: F64, mutable: true }, // A_DEFPORT
        { storage: this.strRef, mutable: true }, // A_PROTOCOL
        { storage: I32, mutable: true }, // A_NODELAY
        { storage: F64, mutable: true }, // A_KABUFFER
        { storage: this.ref(this.amapArrT), mutable: true }, // A_REQUESTS
        { storage: I32, mutable: true },
        { storage: this.ref(this.amapArrT), mutable: true }, // A_SOCKETS
        { storage: I32, mutable: true },
        { storage: this.ref(this.amapArrT), mutable: true }, // A_FREE
        { storage: I32, mutable: true },
        { storage: F64, mutable: true }, // A_OPTPORT
        { storage: I32, mutable: true }, // A_SECURE
      ]),
    );
  }

  agentRef(): ValType {
    return this.ref(this.agentT());
  }

  /** The internal-closure environment for one closure pair. */
  private envT(pair: { clos: number; fn: number }, key: string): number {
    return this.type(`env:${key}`, () =>
      this.mb.subStructType(
        `%w.http.env.${key}`,
        [
          { storage: { kind: "ref", nullable: false, typeIndex: pair.fn }, mutable: false },
          { storage: EQ_REF, mutable: false },
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

  /* ── globals ──────────────────────────────────────────────────────── */

  private g(): NonNullable<HttpBuilder["globalsField"]> {
    if (this.globalsField === null) {
      const i32 = (v: number): number =>
        this.mb.addGlobal(I32, true, (w) => {
          w.u8(0x41);
          w.sleb(v);
        });
      const strT = this.deps.strType();
      const agentT = this.agentT();
      this.globalsField = {
        utc: this.mb.addGlobal(this.strRef, true, (w) => {
          w.u8(0xd0);
          w.sleb(strT);
        }),
        utcTimer: this.mb.addGlobal(F64, true, (w) => {
          w.u8(0x44);
          w.f64(0);
        }),
        parserSeq: i32(1),
        globalAgent: this.mb.addGlobal(this.ref(agentT), true, (w) => {
          w.u8(0xd0);
          w.sleb(agentT);
        }),
        drain: this.drainFn(),
        connSeq: i32(1),
      };
    }
    return this.globalsField;
  }

  /** `%w.http.drain()` — the task queues of an InternalCallbackScope's
   * close: ticks, then microtasks (processTicksAndRejections). Its body is
   * built LATE (the emitter's registerLate) so the checkpoint it emits
   * sees every queue the module ends up with. */
  private drainField: number | null = null;

  drainFn(): number {
    if (this.drainField === null) {
      const idx = this.mb.declareFunc(this.mb.funcType([], []), "%w.http.drain");
      this.drainField = idx;
      this.deps.registerLate(() => {
        const c = new Code();
        this.deps.checkpoint(c);
        this.mb.setBody(idx, [], c.bytes());
      });
    }
    return this.drainField;
  }

  /* ── listener lists (lib/events.js's on / once / emit / remove) ────── */

  private ownerT(spec: HList): number {
    return spec.owner === "inc" ? this.incT() : spec.owner === "out" ? this.outT() : spec.owner === "creq" ? this.creqT() : this.hsrvT();
  }

  private pairOf(arg: HList["arg"] | "sock"): { clos: number; fn: number } {
    switch (arg) {
      case "void":
        return this.deps.voidClos();
      case "data":
        return this.deps.dataClos();
      case "err":
        return this.deps.errClos();
      case "reqres":
        return this.deps.reqResClos();
      case "inc":
        return this.deps.incClos();
      case "sock":
        return this.deps.sockClos();
    }
  }

  private argTypes(arg: HList["arg"]): ValType[] {
    switch (arg) {
      case "void":
        return [];
      case "data":
        return [this.bytesRef];
      case "err":
        return [this.errRef];
      case "reqres":
        return [this.incRef(), this.resRef()];
      case "inc":
        return [this.incRef()];
    }
  }

  private listName(spec: HList): string {
    return `${spec.owner}${spec.arr}`;
  }

  /** `(owner, clos, once, prepend)` */
  addFn(spec: HList): number {
    const T = this.ownerT(spec);
    return this.fn(`add.${this.listName(spec)}`, [this.ref(T), EQ_REF, I32, I32], [], (f, $) => {
      const [O, CL, ONCE, PRE] = [0, 1, 2, 3];
      const NA = f.local(this.ref(this.entArrT));
      const arr = $.get(T, spec.arr, $.l(O));
      const n = $.get(T, spec.n, $.l(O));
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
      $.set(T, spec.n, $.l(O), $.add(n, $.i(1)));
    });
  }

  /** `(owner, entOrClos)` — remove the LAST entry whose entry or closure is
   * the value (removeListener's search order). */
  removeFn(spec: HList): number {
    const T = this.ownerT(spec);
    return this.fn(`remove.${this.listName(spec)}`, [this.ref(T), EQ_REF], [], (f, $) => {
      const [O, V] = [0, 1];
      const I = f.local(I32);
      const E = f.local(this.ref(this.entT));
      const arr = $.get(T, spec.arr, $.l(O));
      const n = $.get(T, spec.n, $.l(O));
      $.put(I, n);
      $.while($.gt($.l(I), $.i(0)), () => {
        $.put(I, $.sub($.l(I), $.i(1)));
        $.put(E, $.aget(this.entArrT, arr, $.l(I)));
        $.if($.or($.refEq($.l(E), $.l(V)), $.refEq($.get(this.entT, 0, $.l(E)), $.l(V))), () => {
          $.do(arr, $.l(I), arr, $.add($.l(I), $.i(1)), $.sub($.sub(n, $.l(I)), $.i(1)));
          f.c.arrayCopy(this.entArrT, this.entArrT);
          $.set(T, spec.n, $.l(O), $.sub(n, $.i(1)));
          $.aset(this.entArrT, arr, n, $.nul(this.entT));
          $.ret();
        });
      });
    });
  }

  /** `(owner)` — removeAllListeners(event). */
  removeAllFn(spec: HList): number {
    const T = this.ownerT(spec);
    return this.fn(`removeAll.${this.listName(spec)}`, [this.ref(T)], [], (f, $) => {
      $.set(T, spec.arr, $.l(0), $.nul(this.entArrT));
      $.set(T, spec.n, $.l(0), $.i(0));
    });
  }

  /** `(owner) -> i32` — listenerCount(event). */
  countFn(spec: HList): number {
    const T = this.ownerT(spec);
    return this.fn(`count.${this.listName(spec)}`, [this.ref(T)], [I32], (f, $) => $.do($.get(T, spec.n, $.l(0))));
  }

  /** `(owner[, args]) -> i32` — emit: the listeners as registered when the
   * emission starts, a once listener removed before it runs and run at
   * most once, stopping at the first that leaves an exception pending;
   * answers whether any listener was registered. An 'error' list with no
   * listener throws the error (the pending cell is set). */
  emitFn(spec: HList): number {
    const T = this.ownerT(spec);
    const argT = this.argTypes(spec.arg);
    return this.fn(`emit.${this.listName(spec)}`, [this.ref(T), ...argT], [I32], (f, $) => {
      const O = 0;
      const N = f.local(I32);
      const I = f.local(I32);
      const SNAP = f.local(this.ref(this.entArrT));
      const E = f.local(this.ref(this.entT));
      const pair = this.pairOf(spec.arg);
      const c = f.c;
      $.put(N, $.get(T, spec.n, $.l(O)));
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

  /** Statement: emit and drop the answer. */
  private emit($: A, spec: HList, owner: X, ...args: X[]): void {
    $.drop($.call(this.emitFn(spec), owner, ...args));
  }

  /** Statement: owner.on(event, clos) / once / prependListener. */
  private on($: A, spec: HList, owner: X, clos: X, once = false, prepend = false): void {
    $.run(this.addFn(spec), owner, clos, $.i(once ? 1 : 0), $.i(prepend ? 1 : 0));
  }

  /** The same on a net socket's or server's list. */
  private son($: A, list: NetList, owner: X, clos: X, once = false, prepend = false): void {
    $.run(this.net.addHelper(list), owner, clos, $.i(once ? 1 : 0), $.i(prepend ? 1 : 0));
  }

  private soff($: A, list: NetList, owner: X, clos: X): void {
    $.run(this.net.removeHelper(list), owner, clos);
  }

  private semit($: A, list: NetList, owner: X, ...args: X[]): X {
    return $.call(this.net.emitHelper(list), owner, ...args);
  }

  /* ── internal closures ────────────────────────────────────────────── */

  /** Declare one internal listener / tick of the given closure pair; the
   * body reads the environment's fields through the locals it is handed
   * (`arg` is the listener's own argument local, -1 for none). */
  private closFn(
    name: string,
    kind: "void" | "data" | "err" | "sock" | "reqres" | "inc",
    body: ($: A, env: Env, f: Fn, arg: number) => void,
  ): number {
    const key = `clos.${name}`;
    const hit = this.fns.get(key);
    if (hit !== undefined) return hit;
    const pair = this.pairOf(kind);
    const idx = this.mb.declareFunc(pair.fn, `%w.http.${name}`);
    this.fns.set(key, idx);
    const env = this.envT(pair, kind);
    const nparams = kind === "void" ? 1 : kind === "reqres" ? 3 : 2;
    const f = new Fn(nparams);
    const $ = new A(f);
    const e: Env = {
      a: f.local(EQ_REF),
      b: f.local(EQ_REF),
      c: f.local(EQ_REF),
      d: f.local(EQ_REF),
      n: f.local(I32),
      x: f.local(F64),
    };
    const fieldsOf: [number, number][] = [[T_A, e.a], [T_B, e.b], [T_C, e.c], [T_D, e.d], [T_N, e.n], [T_X, e.x]];
    for (const [field, local] of fieldsOf) $.put(local, $.get(env, field, $.cast(env, $.l(0))));
    body($, e, f, nparams > 1 ? 1 : -1);
    this.mb.setBody(idx, f.locals, f.c.bytes());
    return idx;
  }

  /** Push a closure for `fn` of the given pair with its environment. */
  private clos($: A, fn: number, kind: "void" | "data" | "err" | "sock" | "reqres" | "inc", parts: Parts): X {
    return () => {
      const pair = this.pairOf(kind);
      const env = this.envT(pair, kind);
      this.mb.declareFuncRef(fn);
      $.c.refFunc(fn);
      (parts.a ?? (() => $.c.refNull(EQ_HEAP)))();
      (parts.b ?? (() => $.c.refNull(EQ_HEAP)))();
      (parts.c ?? (() => $.c.refNull(EQ_HEAP)))();
      (parts.d ?? (() => $.c.refNull(EQ_HEAP)))();
      (parts.n ?? (() => $.c.i32Const(0)))();
      (parts.x ?? (() => $.c.f64Const(0)))();
      $.c.structNew(env);
    };
  }

  /** process.nextTick(fn, ...) with the void closure environment. */
  private nextTick($: A, fn: number, parts: Parts): void {
    this.clos($, fn, "void", parts)();
    $.c.call(this.deps.nextTickEnqueue());
  }

  /** A void tick / listener. */
  private tick(name: string, body: ($: A, env: Env, f: Fn) => void): number {
    return this.closFn(name, "void", ($, e, f) => body($, e, f));
  }

  /** Cast an environment slot to a struct type. */
  private as($: A, T: number, local: number): X {
    return $.cast(T, $.l(local));
  }

  /** After a call that may run a listener: an exception pending means the
   * program is dying — stop, exactly where Node's stack unwinds. */
  private excReturn($: A, v?: X): void {
    $.if($.g(this.deps.excKind()), () => $.ret(v));
  }

  /** Call an error callback (null = nop) with the error or null. */
  private callEcb($: A, cb: X, err: X): void {
    const pair = this.deps.errClos();
    $.if($.notNull(cb), () => {
      $.do(cb, err, $.get(pair.clos, 0, cb));
      $.c.callRef(pair.fn);
    });
  }

  /** Call a void closure (null = nop). */
  private callVcb($: A, cb: X): void {
    const pair = this.deps.voidClos();
    $.if($.notNull(cb), () => {
      $.do(cb, $.get(pair.clos, 0, cb));
      $.c.callRef(pair.fn);
    });
  }

  /* ── errors (lib/internal/errors.js) ──────────────────────────────── */

  /** Push a fresh error of builtin class `cls` with Node's name, the
   * message and the code. */
  private err($: A, cls: "%Error" | "%TypeError" | "%RangeError", msg: X, code: string): X {
    const name = cls.slice(1);
    return () => this.deps.newError($.c, cls, name, () => msg(), (c) => this.deps.pushStrLit(c, code));
  }

  /** Throw a fresh error now (fills the pending cell); the caller returns. */
  private throwErr($: A, cls: "%Error" | "%TypeError" | "%RangeError", msg: X, code: string): void {
    this.err($, cls, msg, code)();
    this.deps.throwStack($.c);
  }

  /** ConnResetException(msg): Error with code ECONNRESET. */
  private connReset($: A, msg: string): X {
    return this.err($, "%Error", this.lit($, msg), "ECONNRESET");
  }

  /** ERR_HTTP_HEADERS_SENT(arg) */
  private throwHeadersSent($: A, arg: string): void {
    this.throwErr($, "%Error", this.lit($, `Cannot ${arg} headers after they are sent to the client`), "ERR_HTTP_HEADERS_SENT");
  }

  /* ── strings ──────────────────────────────────────────────────────── */

  private get strT(): number {
    return this.deps.strType();
  }

  /** `(buf, from, to) -> string` — OneByteString over bytes (latin1). */
  latin1Fn(): number {
    return this.fn("latin1", [this.ref(this.deps.bufType()), I32, I32], [this.strRef], (f, $) => {
      const [B, FROM, TO] = [0, 1, 2];
      const S = f.local(this.strRef);
      const I = f.local(I32);
      $.put(S, $.anew(this.strT, $.sub($.l(TO), $.l(FROM))));
      $.for(I, $.i(0), $.sub($.l(TO), $.l(FROM)), () => {
        $.aset(this.strT, $.l(S), $.l(I), $.agetU(this.deps.bufType(), $.l(B), $.add($.l(FROM), $.l(I))));
      });
      $.do($.l(S));
    });
  }

  /** `(string) -> string`: ASCII lower-casing — String.prototype
   * toLowerCase on the latin1 header names llhttp hands over (a token, so
   * ASCII; checked by its own caller). */
  private asciiLowerFn(): number {
    return this.fn("asciiLower", [this.strRef], [this.strRef], (f, $) => {
      const S = 0;
      const O = f.local(this.strRef);
      const I = f.local(I32);
      const CH = f.local(I32);
      $.put(O, $.anew(this.strT, $.alen($.l(S))));
      $.for(I, $.i(0), $.alen($.l(S)), () => {
        $.put(CH, $.agetU(this.strT, $.l(S), $.l(I)));
        $.if($.both($.ge($.l(CH), $.i(65)), $.le($.l(CH), $.i(90))), () => $.put(CH, $.or($.l(CH), $.i(32))));
        $.aset(this.strT, $.l(O), $.l(I), $.l(CH));
      });
      $.do($.l(O));
    });
  }

  /** `(string, code) -> i32` — the index of the first `code` unit, -1. */
  private indexOfFn(): number {
    return this.fn("indexOf", [this.strRef, I32, I32], [I32], (f, $) => {
      const [S, CH, FROM] = [0, 1, 2];
      const I = f.local(I32);
      $.for(I, $.l(FROM), $.alen($.l(S)), () => {
        $.if($.eq($.agetU(this.strT, $.l(S), $.l(I)), $.l(CH)), () => $.ret($.l(I)));
      });
      $.do($.i(-1));
    });
  }

  /** `(string, from, to) -> string` */
  substrFn(): number {
    return this.fn("substr", [this.strRef, I32, I32], [this.strRef], (f, $) => {
      const [S, FROM, TO] = [0, 1, 2];
      const O = f.local(this.strRef);
      $.put(O, $.anew(this.strT, $.sub($.l(TO), $.l(FROM))));
      $.do($.l(O), $.i(0), $.l(S), $.l(FROM), $.sub($.l(TO), $.l(FROM)));
      f.c.arrayCopy(this.strT, this.strT);
      $.do($.l(O));
    });
  }

  /** `(string) -> i32` — checkIsHttpToken (lib/_http_common.js): the
   * validTokenChars table; the regex form for length >= 10 accepts the
   * same set. */
  checkIsHttpTokenFn(): number {
    return this.fn("checkIsHttpToken", [this.strRef], [I32], (f, $) => {
      const S = 0;
      const I = f.local(I32);
      const CH = f.local(I32);
      $.if($.eq($.alen($.l(S)), $.i(0)), () => $.ret($.i(0)));
      $.for(I, $.i(0), $.alen($.l(S)), () => {
        $.put(CH, $.agetU(this.strT, $.l(S), $.l(I)));
        // !"#$%&'()*+,-./ 0-9:;<=>? @A-O P-Z[\]^_ `a-o p-z{|}~
        const ok = (lo: number, hi: number): X => $.both($.ge($.l(CH), $.i(lo)), $.le($.l(CH), $.i(hi)));
        const is = (v: number): X => $.eq($.l(CH), $.i(v));
        $.if(
          $.not(
            $.or(
              $.or($.or(ok(48, 57), ok(65, 90)), $.or(ok(94, 122), is(124))),
              $.or(
                $.or($.or(is(33), ok(35, 39)), $.or(is(42), is(43))),
                $.or($.or(is(45), is(46)), is(126)),
              ),
            ),
          ),
          () => $.ret($.i(0)),
        );
      });
      $.do($.i(1));
    });
  }

  /** `(string) -> i32` — checkInvalidHeaderChar: /[^\t\x20-\x7e\x80-\xff]/. */
  checkInvalidHeaderCharFn(): number {
    return this.fn("checkInvalidHeaderChar", [this.strRef], [I32], (f, $) => {
      const S = 0;
      const I = f.local(I32);
      const CH = f.local(I32);
      $.for(I, $.i(0), $.alen($.l(S)), () => {
        $.put(CH, $.agetU(this.strT, $.l(S), $.l(I)));
        $.if(
          $.not(
            $.or(
              $.eq($.l(CH), $.i(9)),
              $.or($.both($.ge($.l(CH), $.i(0x20)), $.le($.l(CH), $.i(0x7e))), $.both($.ge($.l(CH), $.i(0x80)), $.le($.l(CH), $.i(0xff)))),
            ),
          ),
          () => $.ret($.i(1)),
        );
      });
      $.do($.i(0));
    });
  }

  /** `(string, enc) -> bytes` — the bytes a socket write of a string chunk
   * puts on the wire in that encoding. */
  encodeFn(): number {
    return this.fn("encode", [this.strRef, I32], [this.bytesRef], (f, $) => {
      const [S, ENC] = [0, 1];
      for (const [id, name] of ENC_NAMES) {
        if (id === ENC_UTF8) continue;
        $.if($.eq($.l(ENC), $.i(id)), () => $.ret($.call(this.deps.strToBytes(name), $.l(S))));
      }
      $.do($.call(this.deps.strToBytes("utf8"), $.l(S)));
    });
  }

  /** `(string) -> i32` — Buffer.byteLength(s, 'utf8'). */
  private utf8LenFn(): number {
    return this.fn("utf8Len", [this.strRef], [I32], (f, $) => {
      $.do($.get(this.deps.bytesType(), 2, $.call(this.deps.strToBytes("utf8"), $.l(0))));
    });
  }

  /** `(string, enc) -> i32` — Buffer.byteLength(chunk, encoding). */
  byteLengthFn(): number {
    return this.fn("byteLength", [this.strRef, I32], [I32], (f, $) => {
      $.do($.get(this.deps.bytesType(), 2, $.call(this.encodeFn(), $.l(0), $.l(1))));
    });
  }

  /** `(i32) -> string` — n.toString(16) for a non-negative chunk length. */
  private hexFn(): number {
    return this.fn("hex", [I32], [this.strRef], (f, $) => {
      const N = 0;
      const S = f.local(this.strRef);
      const L = f.local(I32);
      const T = f.local(I32);
      const D = f.local(I32);
      // Count the digits.
      $.put(L, $.i(1));
      $.put(T, $.shrU($.l(N), $.i(4)));
      $.while($.ne($.l(T), $.i(0)), () => {
        $.put(L, $.add($.l(L), $.i(1)));
        $.put(T, $.shrU($.l(T), $.i(4)));
      });
      $.put(S, $.anew(this.strT, $.l(L)));
      $.put(T, $.l(N));
      $.while($.gt($.l(L), $.i(0)), () => {
        $.put(L, $.sub($.l(L), $.i(1)));
        $.put(D, $.and($.l(T), $.i(15)));
        $.aset(this.strT, $.l(S), $.l(L), $.sel(I32, $.lt($.l(D), $.i(10)), $.add($.l(D), $.i(48)), $.add($.l(D), $.i(87))));
        $.put(T, $.shrU($.l(T), $.i(4)));
      });
      $.do($.l(S));
    });
  }

  /** STATUS_CODES[code] || null */
  private statusTextFn(): number {
    return this.fn("statusText", [I32], [this.strRef], (f, $) => {
      for (const [code, text] of STATUS_CODES) {
        $.if($.eq($.l(0), $.i(code)), () => $.ret(this.lit($, text)));
      }
      $.do($.nul(this.strT));
    });
  }

  /* ── the HTTP parser: src/node_http_parser.cc's Parser over llhttp ─── */

  private get ll(): LlhttpBuilder {
    this.llField ??= new LlhttpBuilder(this.mb, {
      parserType: () => this.parserT(),
      fields: LL,
      bufType: () => this.deps.bufType(),
      pushStrLit: (c, s) => this.deps.pushStrLit(c, s),
      strRef: () => this.strRef,
      spanCb: (name) => this.spanCb(name),
      plainCb: (name) => this.plainCb(name),
    });
    return this.llField;
  }

  private get PT(): number {
    return this.parserT();
  }

  /** Node's settings: the span callbacks it sets (on_protocol, on_method
   * and on_version are NULL). */
  private spanCb(name: string): number | null {
    switch (name) {
      case "llhttp__on_url":
        return this.onUrlFn("url", P_URL);
      case "llhttp__on_status":
        return this.onUrlFn("status", P_STATUSMSG);
      case "llhttp__on_header_field":
        return this.onHeaderFieldFn();
      case "llhttp__on_header_value":
        return this.onHeaderValueFn();
      case "llhttp__on_body":
        return this.onBodyFn();
      case "llhttp__on_chunk_extension_name":
      case "llhttp__on_chunk_extension_value":
        return this.onChunkExtensionFn();
      default:
        return null;
    }
  }

  private plainCb(name: string): number | null {
    switch (name) {
      case "llhttp__on_message_begin":
        return this.onMessageBeginFn();
      case "llhttp__on_headers_complete":
        return this.onHeadersCompleteFn();
      case "llhttp__on_message_complete":
        return this.onMessageCompleteFn();
      case "llhttp__on_chunk_header":
        return this.fn("on_chunk_header", [this.parserRef()], [I32], (f, $) => {
          $.if($.get(this.PT, P_FREED, $.l(0)), () => $.ret($.i(0)));
          $.set(this.PT, P_HNREAD, $.l(0), $.i(0));
          $.set(this.PT, P_CHUNKEXT, $.l(0), $.i(0));
          $.do($.i(0));
        });
      case "llhttp__on_chunk_complete":
        return this.fn("on_chunk_complete", [this.parserRef()], [I32], (f, $) => {
          $.if($.get(this.PT, P_FREED, $.l(0)), () => $.ret($.i(0)));
          $.set(this.PT, P_HNREAD, $.l(0), $.i(0));
          $.do($.i(0));
        });
      default:
        return null;
    }
  }

  /** llhttp_set_error_reason */
  private setReason($: A, P: X, reason: string): void {
    P();
    this.deps.pushStrLit($.c, reason);
    $.c.structSet(this.PT, LL.reason);
  }

  /** TrackHeader(len) -> 0 or HPE_USER, inlined at the top of a span
   * callback: returns from it on overflow. */
  private trackHeader($: A, P: number, len: X): void {
    $.set(this.PT, P_HNREAD, $.l(P), $.add($.get(this.PT, P_HNREAD, $.l(P)), len));
    $.if($.geU($.get(this.PT, P_HNREAD, $.l(P)), $.get(this.PT, P_MAXHDR, $.l(P))), () => {
      this.setReason($, $.l(P), "HPE_HEADER_OVERFLOW:Header overflow");
      $.ret($.i(HPE_USER));
    });
  }

  /** on_url / on_status: TrackHeader, then StringPtr::Update. */
  private onUrlFn(name: string, field: number): number {
    return this.fn(`on_${name}`, [this.parserRef(), this.ref(this.deps.bufType()), I32, I32], [I32], (f, $) => {
      const [P, B, S, E] = [0, 1, 2, 3];
      $.if($.get(this.PT, P_FREED, $.l(P)), () => $.ret($.i(0)));
      this.trackHeader($, P, $.sub($.l(E), $.l(S)));
      $.set(this.PT, field, $.l(P), this.cat($, $.get(this.PT, field, $.l(P)), $.call(this.latin1Fn(), $.l(B), $.l(S), $.l(E))));
      $.do($.i(0));
    });
  }

  private onHeaderFieldFn(): number {
    return this.fn("on_header_field", [this.parserRef(), this.ref(this.deps.bufType()), I32, I32], [I32], (f, $) => {
      const [P, B, S, E] = [0, 1, 2, 3];
      const PT = this.PT;
      const MAXP = f.local(F64);
      $.if($.get(PT, P_FREED, $.l(P)), () => $.ret($.i(0)));
      this.trackHeader($, P, $.sub($.l(E), $.l(S)));
      $.if($.eq($.get(PT, P_NFIELDS, $.l(P)), $.get(PT, P_NVALUES, $.l(P))), () => {
        // TrackHeaderPair (requests only).
        $.if($.eq($.get(PT, LL.type, $.l(P)), $.i(HTTP_REQUEST)), () => {
          $.set(PT, P_HPAIRS, $.l(P), $.add($.get(PT, P_HPAIRS, $.l(P)), $.i(2)));
          $.put(MAXP, $.i2d($.get(PT, P_MAXPAIRS, $.l(P))));
          $.if($.both($.dgt($.l(MAXP), $.d(0)), $.dgt($.i2d($.get(PT, P_HPAIRS, $.l(P))), $.l(MAXP))), () => {
            this.setReason($, $.l(P), "HPE_HEADER_OVERFLOW:Header overflow");
            $.ret($.i(HPE_USER));
          });
        });
        $.set(PT, P_NFIELDS, $.l(P), $.add($.get(PT, P_NFIELDS, $.l(P)), $.i(1)));
        $.if($.eq($.get(PT, P_NFIELDS, $.l(P)), $.i(32)), () => {
          $.run(this.flushFn(), $.l(P));
          $.set(PT, P_NFIELDS, $.l(P), $.i(1));
          $.set(PT, P_NVALUES, $.l(P), $.i(0));
        });
        $.aset(this.strArrT, $.get(PT, P_FIELDS, $.l(P)), $.sub($.get(PT, P_NFIELDS, $.l(P)), $.i(1)), this.lit($, ""));
      });
      const slot = $.sub($.get(PT, P_NFIELDS, $.l(P)), $.i(1));
      $.aset(
        this.strArrT,
        $.get(PT, P_FIELDS, $.l(P)),
        slot,
        this.cat($, $.aget(this.strArrT, $.get(PT, P_FIELDS, $.l(P)), slot), $.call(this.latin1Fn(), $.l(B), $.l(S), $.l(E))),
      );
      $.do($.i(0));
    });
  }

  private onHeaderValueFn(): number {
    return this.fn("on_header_value", [this.parserRef(), this.ref(this.deps.bufType()), I32, I32], [I32], (f, $) => {
      const [P, B, S, E] = [0, 1, 2, 3];
      const PT = this.PT;
      $.if($.get(PT, P_FREED, $.l(P)), () => $.ret($.i(0)));
      this.trackHeader($, P, $.sub($.l(E), $.l(S)));
      $.if($.ne($.get(PT, P_NVALUES, $.l(P)), $.get(PT, P_NFIELDS, $.l(P))), () => {
        $.set(PT, P_NVALUES, $.l(P), $.add($.get(PT, P_NVALUES, $.l(P)), $.i(1)));
        $.aset(this.strArrT, $.get(PT, P_VALUES, $.l(P)), $.sub($.get(PT, P_NVALUES, $.l(P)), $.i(1)), this.lit($, ""));
      });
      const slot = $.sub($.get(PT, P_NVALUES, $.l(P)), $.i(1));
      $.aset(
        this.strArrT,
        $.get(PT, P_VALUES, $.l(P)),
        slot,
        this.cat($, $.aget(this.strArrT, $.get(PT, P_VALUES, $.l(P)), slot), $.call(this.latin1Fn(), $.l(B), $.l(S), $.l(E))),
      );
      $.do($.i(0));
    });
  }

  private onChunkExtensionFn(): number {
    return this.fn("on_chunk_extension", [this.parserRef(), this.ref(this.deps.bufType()), I32, I32], [I32], (f, $) => {
      const [P, , S, E] = [0, 1, 2, 3];
      $.if($.get(this.PT, P_FREED, $.l(P)), () => $.ret($.i(0)));
      $.set(this.PT, P_CHUNKEXT, $.l(P), $.add($.get(this.PT, P_CHUNKEXT, $.l(P)), $.sub($.l(E), $.l(S))));
      $.if($.gt($.get(this.PT, P_CHUNKEXT, $.l(P)), $.i(16384)), () => {
        this.setReason($, $.l(P), "HPE_CHUNK_EXTENSIONS_OVERFLOW:Chunk extensions overflow");
        $.ret($.i(HPE_USER));
      });
      $.do($.i(0));
    });
  }

  /** `(parser) -> string array of 2 * num_values_` — CreateHeaders (the
   * values trimmed of trailing OWS). */
  private createHeadersFn(): number {
    return this.fn("createHeaders", [this.parserRef()], [this.ref(this.strArrT)], (f, $) => {
      const P = 0;
      const PT = this.PT;
      const OUT = f.local(this.ref(this.strArrT));
      const I = f.local(I32);
      const V = f.local(this.strRef);
      const L = f.local(I32);
      $.put(OUT, $.anew(this.strArrT, $.mul($.get(PT, P_NVALUES, $.l(P)), $.i(2))));
      $.for(I, $.i(0), $.get(PT, P_NVALUES, $.l(P)), () => {
        $.aset(this.strArrT, $.l(OUT), $.mul($.l(I), $.i(2)), $.aget(this.strArrT, $.get(PT, P_FIELDS, $.l(P)), $.l(I)));
        $.put(V, $.aget(this.strArrT, $.get(PT, P_VALUES, $.l(P)), $.l(I)));
        $.put(L, $.alen($.l(V)));
        $.while(
          $.andThen($.gt($.l(L), $.i(0)), $.or($.eq($.agetU(this.strT, $.l(V), $.sub($.l(L), $.i(1))), $.i(32)), $.eq($.agetU(this.strT, $.l(V), $.sub($.l(L), $.i(1))), $.i(9)))),
          () => $.put(L, $.sub($.l(L), $.i(1))),
        );
        $.aset(this.strArrT, $.l(OUT), $.add($.mul($.l(I), $.i(2)), $.i(1)), $.call(this.substrFn(), $.l(V), $.i(0), $.l(L)));
      });
      $.do($.l(OUT));
    });
  }

  /** Flush(): parserOnHeaders(CreateHeaders(), url_) through MakeCallback
   * (a drain point on the consumed reader); url_ resets, have_flushed_. */
  private flushFn(): number {
    return this.fn("flush", [this.parserRef()], [], (f, $) => {
      const P = 0;
      const PT = this.PT;
      const H = f.local(this.ref(this.strArrT));
      const CAP = f.local(I32);
      const I = f.local(I32);
      const N = f.local(I32);
      $.put(H, $.call(this.createHeadersFn(), $.l(P)));
      // parserOnHeaders(headers, url)
      $.put(N, $.alen($.l(H)));
      $.put(CAP, $.sub($.get(PT, P_MAXPAIRS, $.l(P)), $.get(PT, P_JSHDRS_N, $.l(P))));
      $.if($.or($.le($.get(PT, P_MAXPAIRS, $.l(P)), $.i(0)), $.ge($.l(CAP), $.l(N))), () => {}, () => {
        $.if($.gt($.l(CAP), $.i(0)), () => $.put(N, $.l(CAP)), () => $.put(N, $.i(0)));
      });
      $.for(I, $.i(0), $.l(N), () => $.run(this.jsHeadersPushFn(), $.l(P), $.aget(this.strArrT, $.l(H), $.l(I))));
      $.set(PT, P_JSURL, $.l(P), this.cat($, $.get(PT, P_JSURL, $.l(P)), $.get(PT, P_URL, $.l(P))));
      this.makeCallbackDrain($, P);
      $.set(PT, P_URL, $.l(P), this.lit($, ""));
      $.set(PT, P_FLUSHED, $.l(P), $.i(1));
    });
  }

  /** The close of a MakeCallback's scope: on the consumed reader (depth 1)
   * the task queues drain. */
  private makeCallbackDrain($: A, P: number): void {
    $.if($.both($.get(this.PT, P_DRAINS, $.l(P)), $.not($.g(this.deps.excKind()))), () => $.run(this.drainFn()));
  }

  /** parser._headers.push(s) */
  private jsHeadersPushFn(): number {
    return this.fn("jsHeadersPush", [this.parserRef(), this.strRef], [], (f, $) => {
      const [P, S] = [0, 1];
      const PT = this.PT;
      const NA = f.local(this.ref(this.strArrT));
      const arr = $.get(PT, P_JSHDRS, $.l(P));
      const n = $.get(PT, P_JSHDRS_N, $.l(P));
      $.if($.geU(n, $.alen(arr)), () => {
        $.put(NA, $.anew(this.strArrT, $.add($.shl($.alen(arr), $.i(1)), $.i(8))));
        $.do($.l(NA), $.i(0), arr, $.i(0), n);
        f.c.arrayCopy(this.strArrT, this.strArrT);
        $.set(PT, P_JSHDRS, $.l(P), $.l(NA));
      });
      $.aset(this.strArrT, arr, n, $.l(S));
      $.set(PT, P_JSHDRS_N, $.l(P), $.add(n, $.i(1)));
    });
  }

  /** ConnectionsList Pop / PopActive / Push / PushActive: membership flags
   * on the parser and the server's list. */
  private connsPushFn(): number {
    return this.fn("connsPush", [this.parserRef(), I32], [], (f, $) => {
      const [P, ACTIVE] = [0, 1];
      $.set(this.PT, P_INALL, $.l(P), $.i(1));
      $.if($.l(ACTIVE), () => $.set(this.PT, P_INACTIVE, $.l(P), $.i(1)));
    });
  }

  /** The parser joins its server's array (for as long as it lives: Pop
   * and Push only move its flags). */
  private connsAddFn(): number {
    return this.fn("connsAdd", [this.parserRef()], [], (f, $) => {
      const P = 0;
      const HT = this.hsrvT();
      const HS = f.local(this.hsrvRef());
      const NA = f.local(this.ref(this.eqArrT));
      $.put(HS, $.cast(HT, $.get(this.PT, P_CONNS, $.l(P))));
      $.if($.isNull($.get(HT, H_CONNS, $.l(HS))), () => $.set(HT, H_CONNS, $.l(HS), $.anew(this.eqArrT, $.i(4))));
      const arr = $.get(HT, H_CONNS, $.l(HS));
      const n = $.get(HT, H_CONNS_N, $.l(HS));
      $.if($.geU(n, $.alen(arr)), () => {
        $.put(NA, $.anew(this.eqArrT, $.shl($.alen(arr), $.i(1))));
        $.do($.l(NA), $.i(0), arr, $.i(0), n);
        f.c.arrayCopy(this.eqArrT, this.eqArrT);
        $.set(HT, H_CONNS, $.l(HS), $.l(NA));
      });
      $.aset(this.eqArrT, arr, n, $.l(P));
      $.set(HT, H_CONNS_N, $.l(HS), $.add(n, $.i(1)));
    });
  }

  /** Pop + PopActive (the parser stays in the array; its flags say it is
   * out of both sets). */
  private connsPop($: A, P: number): void {
    $.set(this.PT, P_INALL, $.l(P), $.i(0));
    $.set(this.PT, P_INACTIVE, $.l(P), $.i(0));
  }

  /** Remove a parser from its server's array for good (Parser::Remove). */
  private connsRemoveFn(): number {
    return this.fn("connsRemove", [this.parserRef()], [], (f, $) => {
      const P = 0;
      const HS = f.local(this.hsrvRef());
      const I = f.local(I32);
      const HT = this.hsrvT();
      $.if($.isNull($.get(this.PT, P_CONNS, $.l(P))), () => $.ret());
      $.put(HS, $.cast(HT, $.get(this.PT, P_CONNS, $.l(P))));
      this.connsPop($, P);
      $.for(I, $.i(0), $.get(HT, H_CONNS_N, $.l(HS)), () => {
        $.if($.refEq($.aget(this.eqArrT, $.get(HT, H_CONNS, $.l(HS)), $.l(I)), $.l(P)), () => {
          const arr = $.get(HT, H_CONNS, $.l(HS));
          $.do(arr, $.l(I), arr, $.add($.l(I), $.i(1)), $.sub($.sub($.get(HT, H_CONNS_N, $.l(HS)), $.l(I)), $.i(1)));
          f.c.arrayCopy(this.eqArrT, this.eqArrT);
          $.set(HT, H_CONNS_N, $.l(HS), $.sub($.get(HT, H_CONNS_N, $.l(HS)), $.i(1)));
          $.ret();
        });
      });
    });
  }

  private onMessageBeginFn(): number {
    return this.fn("on_message_begin", [this.parserRef()], [I32], (f, $) => {
      const P = 0;
      const PT = this.PT;
      $.if($.get(PT, P_FREED, $.l(P)), () => $.ret($.i(0)));
      const hasConns = $.notNull($.get(PT, P_CONNS, $.l(P)));
      $.if(hasConns, () => this.connsPop($, P));
      $.set(PT, P_NFIELDS, $.l(P), $.i(0));
      $.set(PT, P_NVALUES, $.l(P), $.i(0));
      $.set(PT, P_HDRSDONE, $.l(P), $.i(0));
      $.set(PT, P_CHUNKEXT, $.l(P), $.i(0));
      $.set(PT, P_LASTSTART, $.l(P), $.call(this.deps.now()));
      $.set(PT, P_URL, $.l(P), this.lit($, ""));
      $.set(PT, P_STATUSMSG, $.l(P), this.lit($, ""));
      $.if(hasConns, () => $.run(this.connsPushFn(), $.l(P), $.i(1)));
      // kOnMessageBegin is null in lib/_http_common.js's parsers.
      $.do($.i(0));
    });
  }

  /** on_headers_complete -> parserOnHeadersComplete's answer (-1 when it
   * threw). */
  private onHeadersCompleteFn(): number {
    return this.fn("on_headers_complete", [this.parserRef()], [I32], (f, $) => {
      const P = 0;
      const PT = this.PT;
      const H = f.local(this.ref(this.strArrT));
      const URL = f.local(this.strRef);
      const R = f.local(I32);
      $.if($.get(PT, P_FREED, $.l(P)), () => $.ret($.i(0)));
      $.set(PT, P_HDRSDONE, $.l(P), $.i(1));
      $.set(PT, P_HNREAD, $.l(P), $.i(0));
      $.if($.get(PT, P_FLUSHED, $.l(P)), () => {
        // Slow case: flush the rest; JS reads parser._headers / _url.
        $.run(this.flushFn(), $.l(P));
        $.if($.g(this.deps.excKind()), () => {
          $.set(PT, P_GOTEXC, $.l(P), $.i(1));
          $.ret($.i(-1));
        });
      }, () => {
        $.put(H, $.call(this.createHeadersFn(), $.l(P)));
        $.if($.eq($.get(PT, LL.type, $.l(P)), $.i(HTTP_REQUEST)), () => $.put(URL, $.get(PT, P_URL, $.l(P))));
      });
      $.set(PT, P_NFIELDS, $.l(P), $.i(0));
      $.set(PT, P_NVALUES, $.l(P), $.i(0));
      $.set(PT, P_HPAIRS, $.l(P), $.i(0));
      // parserOnHeadersComplete (an InternalCallbackScope that skips the
      // task queues).
      $.put(R, $.call(this.parserOnHeadersCompleteFn(), $.l(P), $.l(H), $.l(URL), $.call(this.ll.shouldKeepAliveFn(), $.l(P))));
      $.if($.g(this.deps.excKind()), () => {
        $.set(PT, P_GOTEXC, $.l(P), $.i(1));
        $.ret($.i(-1));
      });
      $.do($.l(R));
    });
  }

  private onBodyFn(): number {
    return this.fn("on_body", [this.parserRef(), this.ref(this.deps.bufType()), I32, I32], [I32], (f, $) => {
      const [P, B, S, E] = [0, 1, 2, 3];
      const BUF = f.local(this.ref(this.deps.bufType()));
      $.if($.get(this.PT, P_FREED, $.l(P)), () => $.ret($.i(0)));
      $.if($.eq($.l(S), $.l(E)), () => $.ret($.i(0)));
      // Buffer::Copy(at, length)
      $.put(BUF, $.anew(this.deps.bufType(), $.sub($.l(E), $.l(S))));
      $.do($.l(BUF), $.i(0), $.l(B), $.l(S), $.sub($.l(E), $.l(S)));
      f.c.arrayCopy(this.deps.bufType(), this.deps.bufType());
      $.run(this.parserOnBodyFn(), $.l(P), $.new_(this.deps.bytesType(), $.raw((c) => {
        c.localGet(BUF);
        c.refAsNonNull();
      }), $.i(0), $.sub($.l(E), $.l(S))));
      $.if($.g(this.deps.excKind()), () => {
        $.set(this.PT, P_GOTEXC, $.l(P), $.i(1));
        this.setReason($, $.l(P), "HPE_JS_EXCEPTION:JS Exception");
        $.ret($.i(HPE_USER));
      });
      this.makeCallbackDrain($, P);
      $.if($.g(this.deps.excKind()), () => {
        $.set(this.PT, P_GOTEXC, $.l(P), $.i(1));
        this.setReason($, $.l(P), "HPE_JS_EXCEPTION:JS Exception");
        $.ret($.i(HPE_USER));
      });
      $.do($.i(0));
    });
  }

  private onMessageCompleteFn(): number {
    return this.fn("on_message_complete", [this.parserRef()], [I32], (f, $) => {
      const P = 0;
      const PT = this.PT;
      $.if($.get(PT, P_FREED, $.l(P)), () => $.ret($.i(0)));
      const hasConns = $.notNull($.get(PT, P_CONNS, $.l(P)));
      $.if(hasConns, () => this.connsPop($, P));
      $.set(PT, P_LASTSTART, $.l(P), $.d(0));
      $.if(hasConns, () => $.run(this.connsPushFn(), $.l(P), $.i(0)));
      $.if($.get(PT, P_NFIELDS, $.l(P)), () => {
        $.run(this.flushFn(), $.l(P));
        $.if($.g(this.deps.excKind()), () => {
          $.set(PT, P_GOTEXC, $.l(P), $.i(1));
          $.ret($.i(-1));
        });
      });
      $.set(PT, P_HPAIRS, $.l(P), $.i(0));
      $.run(this.parserOnMessageCompleteFn(), $.l(P));
      $.if($.g(this.deps.excKind()), () => {
        $.set(PT, P_GOTEXC, $.l(P), $.i(1));
        $.ret($.i(-1));
      });
      $.do($.i(0));
    });
  }

  /** `new HTTPParser()` then cleanParser (the FreeList's constructor). */
  private parserNewFn(): number {
    return this.fn("parserNew", [], [this.parserRef()], (f, $) => {
      const P = f.local(this.parserRef());
      const PT = this.PT;
      const c = f.c;
      // llhttp fields (llhttp_init fills them for real in initialize).
      c.i32Const(0); // _index
      c.i32Const(-1); // _span_pos0
      c.i32Const(0); // _span_cb0
      c.i32Const(0); // error
      c.refNull(this.strT); // reason
      c.i32Const(0); // error_pos
      c.i32Const(0); // _current
      c.i64Const(0n); // content_length
      for (let i = LL.type; i <= LL.initial_message_completed; i++) c.i32Const(0);
      this.deps.pushStrLit(c, ""); // P_URL
      this.deps.pushStrLit(c, ""); // P_STATUSMSG
      $.do($.anew(this.strArrT, $.i(32)), $.anew(this.strArrT, $.i(32)));
      c.i32Const(0); // P_NFIELDS
      c.i32Const(0); // P_NVALUES
      c.i32Const(0); // P_HNREAD
      c.i32Const(0); // P_HPAIRS
      c.i32Const(16384); // P_MAXHDR
      c.i32Const(0); // P_HDRSDONE
      c.i32Const(0); // P_FLUSHED
      c.f64Const(0); // P_LASTSTART
      c.i32Const(0); // P_GOTEXC
      c.i32Const(0); // P_CHUNKEXT
      c.refNull(EQ_HEAP); // P_CONNS
      c.i32Const(0); // P_INALL
      c.i32Const(0); // P_INACTIVE
      $.do($.anew(this.strArrT, $.i(0)));
      c.i32Const(0); // P_JSHDRS_N
      this.deps.pushStrLit(c, ""); // P_JSURL
      c.refNull(this.sockT); // P_SOCK
      c.refNull(this.incT()); // P_INCOMING
      c.refNull(EQ_HEAP); // P_OUTGOING
      c.i32Const(2000); // P_MAXPAIRS (MAX_HEADER_PAIRS)
      c.i32Const(0); // P_CONSUMED
      c.refNull(EQ_HEAP); // P_CONN
      c.i32Const(-1); // P_JOINDUP (null)
      c.i32Const(0); // P_FREED
      c.globalGet(this.g().parserSeq); // P_SEQ
      c.refNull(this.deps.bytesType()); // P_CURBUF
      c.i32Const(0); // P_ONEXECUTE
      c.i32Const(0); // P_DRAINS
      c.structNew(PT);
      c.localSet(P);
      $.gput(this.g().parserSeq, $.add($.g(this.g().parserSeq), $.i(1)));
      $.do($.l(P));
    });
  }

  /** parser.initialize(type, resource, maxHeaderSize (0 = the default),
   * lenient (none), connectionsList) — Parser::Initialize. */
  private parserInitFn(): number {
    return this.fn("parserInit", [this.parserRef(), I32, EQ_REF], [], (f, $) => {
      const [P, TYPE, CONNS] = [0, 1, 2];
      const PT = this.PT;
      $.run(this.ll.initFn(), $.l(P), $.l(TYPE));
      $.set(PT, P_HNREAD, $.l(P), $.i(0));
      $.set(PT, P_URL, $.l(P), this.lit($, ""));
      $.set(PT, P_STATUSMSG, $.l(P), this.lit($, ""));
      $.set(PT, P_NFIELDS, $.l(P), $.i(0));
      $.set(PT, P_NVALUES, $.l(P), $.i(0));
      $.set(PT, P_FLUSHED, $.l(P), $.i(0));
      $.set(PT, P_GOTEXC, $.l(P), $.i(0));
      $.set(PT, P_FREED, $.l(P), $.i(0));
      $.set(PT, P_HDRSDONE, $.l(P), $.i(0));
      $.set(PT, P_MAXHDR, $.l(P), $.i(16384));
      $.set(PT, P_HPAIRS, $.l(P), $.i(0));
      $.if($.notNull($.l(CONNS)), () => {
        $.set(PT, P_CONNS, $.l(P), $.l(CONNS));
        $.set(PT, P_LASTSTART, $.l(P), $.call(this.deps.now()));
        $.run(this.connsAddFn(), $.l(P));
        $.run(this.connsPushFn(), $.l(P), $.i(1));
      }, () => $.set(PT, P_CONNS, $.l(P), $.nul(EQ_HEAP)));
    });
  }

  /** The value an Execute / Finish answers: >= 0 the bytes parsed, -1 an
   * exception (pending), -2 a parse error (the error in parseErr). */
  private parseErrG: number | null = null;

  private parseErrGlobal(): number {
    if (this.parseErrG === null) {
      const errT = this.deps.errType();
      this.parseErrG = this.mb.addGlobal(this.errRef, true, (w) => {
        w.u8(0xd0);
        w.sleb(errT);
      });
    }
    return this.parseErrG;
  }

  /** The parse error object: Error("Parse Error") with code and reason;
   * prepareError then makes the message "Parse Error: <reason>" (its
   * bytesParsed / rawPacket / reason properties are S088's). */
  private parseError($: A, P: number, ERR: number): X {
    return () => {
      const CODE = $.local(this.strRef);
      const REASON = $.local(this.strRef);
      const I = $.local(I32);
      $.put(REASON, $.get(this.PT, LL.reason, $.l(P)));
      $.if($.eq($.l(ERR), $.i(HPE_USER)), () => {
        // "HPE_XXX:reason" — the code before the colon.
        $.put(I, $.call(this.indexOfFn(), $.l(REASON), $.i(58), $.i(0)));
        $.put(CODE, $.call(this.substrFn(), $.l(REASON), $.i(0), $.l(I)));
        $.put(REASON, $.call(this.substrFn(), $.l(REASON), $.add($.l(I), $.i(1)), $.alen($.l(REASON))));
      }, () => {
        $.put(CODE, this.lit($, "HPE_INTERNAL"));
        for (const [n, name] of HPE_NAMES) $.if($.eq($.l(ERR), $.i(n)), () => $.put(CODE, this.lit($, name)));
      });
      this.deps.newError($.c, "%Error", "Error", () => {
        this.cat($, this.lit($, "Parse Error: "), $.l(REASON))();
      }, (c) => c.localGet(CODE));
    };
  }

  /** Parser::Execute(data, len) as parser.execute(buffer) answers it. */
  private executeFn(): number {
    return this.fn("execute", [this.parserRef(), this.bytesRef], [I32], (f, $) => {
      const [P, D] = [0, 1];
      const PT = this.PT;
      const ERR = f.local(I32);
      const NREAD = f.local(I32);
      const BT = this.deps.bytesType();
      const base = $.get(BT, 1, $.l(D));
      const len = $.get(BT, 2, $.l(D));
      $.set(PT, P_CURBUF, $.l(P), $.l(D));
      $.set(PT, P_GOTEXC, $.l(P), $.i(0));
      $.put(ERR, $.call(this.ll.executeFn(), $.l(P), $.get(BT, 0, $.l(D)), base, $.add(base, len)));
      $.put(NREAD, len);
      $.if($.ne($.l(ERR), $.i(HPE_OK)), () => {
        $.put(NREAD, $.sub($.get(PT, LL.error_pos, $.l(P)), base));
        $.if($.eq($.l(ERR), $.i(HPE_PAUSED_UPGRADE)), () => {
          $.put(ERR, $.i(HPE_OK));
          $.run(this.ll.resumeAfterUpgradeFn(), $.l(P));
        });
      });
      $.set(PT, P_CURBUF, $.l(P), $.nul(BT));
      $.if($.get(PT, P_GOTEXC, $.l(P)), () => $.ret($.i(-1)));
      $.if($.both($.not($.get(PT, LL.upgrade, $.l(P))), $.ne($.l(ERR), $.i(HPE_OK))), () => {
        $.gput(this.parseErrGlobal(), this.parseError($, P, ERR));
        $.ret($.i(-2));
      });
      $.do($.l(NREAD));
    });
  }

  /** Parser::Finish -> 0 (nothing), -1 (exception), -2 (parse error). */
  private finishFn(): number {
    return this.fn("finish", [this.parserRef()], [I32], (f, $) => {
      const P = 0;
      const PT = this.PT;
      const ERR = f.local(I32);
      $.set(PT, P_GOTEXC, $.l(P), $.i(0));
      $.put(ERR, $.call(this.ll.finishFn(this.onMessageCompleteFn()), $.l(P)));
      $.if($.get(PT, P_GOTEXC, $.l(P)), () => $.ret($.i(-1)));
      $.if($.both($.not($.get(PT, LL.upgrade, $.l(P))), $.ne($.l(ERR), $.i(HPE_OK))), () => {
        $.gput(this.parseErrGlobal(), this.parseError($, P, ERR));
        $.ret($.i(-2));
      });
      $.do($.i(0));
    });
  }

  /** Parser::OnStreamRead for a consumed server socket: Execute, then the
   * kOnExecute callback through MakeCallback; this is a top-level callback
   * (no scope around it), so every MakeCallback inside drains the queues. */
  consumedReadFn(): number {
    return this.fn("consumedRead", [this.sockRef, this.bytesRef], [], (f, $) => {
      const [S, D] = [0, 1];
      const P = f.local(this.parserRef());
      const R = f.local(I32);
      const BT = this.deps.bytesType();
      const ST = NET_SOCK_HTTP;
      $.put(P, $.cast(this.PT, $.get(this.sockT, ST.S_PARSER, $.l(S))));
      $.if($.eq($.get(BT, 2, $.l(D)), $.i(0)), () => $.ret());
      $.set(this.PT, P_DRAINS, $.l(P), $.i(1));
      $.put(R, $.call(this.executeFn(), $.l(P), $.l(D)));
      $.if($.eq($.l(R), $.i(-1)), () => {
        $.set(this.PT, P_DRAINS, $.l(P), $.i(0));
        $.ret();
      });
      $.if($.not($.get(this.PT, P_ONEXECUTE, $.l(P))), () => {
        $.set(this.PT, P_DRAINS, $.l(P), $.i(0));
        $.ret();
      });
      $.set(this.PT, P_CURBUF, $.l(P), $.l(D));
      $.run(this.onParserExecuteFn(), $.l(P), $.l(R));
      $.set(this.PT, P_CURBUF, $.l(P), $.nul(BT));
      this.makeCallbackDrain($, P);
      $.set(this.PT, P_DRAINS, $.l(P), $.i(0));
    });
  }

  /** parser.pause() / resume() */
  private parserPause($: A, P: X, on: boolean): void {
    $.run(on ? this.ll.pauseFn() : this.ll.resumeFn(), P);
  }

  /* ── lib/_http_common.js ──────────────────────────────────────────── */

  /** parserOnHeadersComplete(...) -> parser.onIncoming(incoming,
   * shouldKeepAlive); `headers` / `url` null = read parser._headers /
   * parser._url. */
  private parserOnHeadersCompleteFn(): number {
    return this.fn("parserOnHeadersComplete", [this.parserRef(), this.ref(this.strArrT), this.strRef, I32], [I32], (f, $) => {
      const [P, H0, U0, KEEP] = [0, 1, 2, 3];
      const PT = this.PT;
      const IT = this.incT();
      const H = f.local(this.ref(this.strArrT));
      const HN = f.local(I32);
      const URL = f.local(this.strRef);
      const INC = f.local(this.incRef());
      const S = f.local(this.sockRef);
      const N = f.local(I32);
      const MAJ = f.local(I32);
      const MIN = f.local(I32);
      const V = f.local(this.srvRef);
      const JD = f.local(I32);
      $.put(S, $.get(PT, P_SOCK, $.l(P)));
      $.if($.isNull($.l(H0)), () => {
        $.put(H, $.get(PT, P_JSHDRS, $.l(P)));
        $.put(HN, $.get(PT, P_JSHDRS_N, $.l(P)));
        $.set(PT, P_JSHDRS, $.l(P), $.anew(this.strArrT, $.i(0)));
        $.set(PT, P_JSHDRS_N, $.l(P), $.i(0));
      }, () => {
        $.put(H, $.l(H0));
        $.put(HN, $.alen($.l(H0)));
      });
      $.if($.isNull($.l(U0)), () => {
        $.put(URL, $.get(PT, P_JSURL, $.l(P)));
        $.set(PT, P_JSURL, $.l(P), this.lit($, ""));
      }, () => $.put(URL, $.l(U0)));
      $.put(INC, $.call(this.incNewFn(), $.l(S)));
      $.set(PT, P_INCOMING, $.l(P), $.l(INC));
      $.put(MAJ, $.get(PT, LL.http_major, $.l(P)));
      $.put(MIN, $.get(PT, LL.http_minor, $.l(P)));
      $.set(IT, I_MAJOR, $.l(INC), $.l(MAJ));
      $.set(IT, I_MINOR, $.l(INC), $.l(MIN));
      // joinDuplicateHeaders = socket?.server?.joinDuplicateHeaders || parser.joinDuplicateHeaders
      $.put(JD, $.i(0));
      $.if($.notNull($.l(S)), () => {
        $.put(V, $.get(this.sockT, NET_SOCK_HTTP.S_SERVER, $.l(S)));
        $.if($.andThen($.notNull($.l(V)), $.notNull($.get(this.srvT, NET_SRV_HTTP.V_HTTP, $.l(V)))), () => {
          $.put(JD, $.eq($.get(this.hsrvT(), H_JOINDUP, $.cast(this.hsrvT(), $.get(this.srvT, NET_SRV_HTTP.V_HTTP, $.l(V)))), $.i(1)));
        });
      });
      $.if($.not($.l(JD)), () => $.put(JD, $.eq($.get(PT, P_JOINDUP, $.l(P)), $.i(1))));
      $.set(IT, I_JOINDUP, $.l(INC), $.l(JD));
      $.set(IT, I_URL, $.l(INC), $.l(URL));
      $.set(IT, I_UPGRADE, $.l(INC), $.get(PT, LL.upgrade, $.l(P)));
      $.put(N, $.l(HN));
      $.if($.gt($.get(PT, P_MAXPAIRS, $.l(P)), $.i(0)), () => {
        $.if($.gt($.l(N), $.get(PT, P_MAXPAIRS, $.l(P))), () => $.put(N, $.get(PT, P_MAXPAIRS, $.l(P))));
      });
      $.run(this.addHeaderLinesFn(), $.l(INC), $.l(H), $.l(HN), $.l(N));
      $.if($.eq($.get(PT, LL.type, $.l(P)), $.i(HTTP_REQUEST)), () => {
        $.set(IT, I_METHOD, $.l(INC), $.call(this.methodNameFn(), $.get(PT, LL.method, $.l(P))));
      }, () => {
        $.set(IT, I_STATUS, $.l(INC), $.get(PT, LL.status_code, $.l(P)));
        $.set(IT, I_STATUSMSG, $.l(INC), $.get(PT, P_STATUSMSG, $.l(P)));
      });
      // parser.onIncoming(incoming, shouldKeepAlive)
      $.if($.notNull($.get(PT, P_CONN, $.l(P))), () => {
        $.ret($.call(this.parserOnIncomingFn(), $.cast(this.connT(), $.get(PT, P_CONN, $.l(P))), $.l(INC), $.l(KEEP)));
      });
      $.do($.call(this.parserOnIncomingClientFn(), $.l(P), $.l(INC), $.l(KEEP)));
    });
  }

  /** allMethods[method] */
  private methodNameFn(): number {
    return this.fn("methodName", [I32], [this.strRef], (f, $) => {
      ALL_METHODS.forEach((m, i) => $.if($.eq($.l(0), $.i(i)), () => $.ret(this.lit($, m))));
      $.trap();
    });
  }

  /** parserOnBody(b) */
  private parserOnBodyFn(): number {
    return this.fn("parserOnBody", [this.parserRef(), this.bytesRef], [], (f, $) => {
      const [P, B] = [0, 1];
      const INC = f.local(this.incRef());
      $.put(INC, $.get(this.PT, P_INCOMING, $.l(P)));
      $.if($.or($.isNull($.l(INC)), $.get(this.incT(), I_SKIP, $.l(INC))), () => $.ret());
      $.if($.not($.get(this.incT(), I_DUMPED, $.l(INC))), () => {
        $.if($.not($.call(this.incPushFn(), $.l(INC), $.l(B))), () => {
          this.excReturn($);
          $.run(this.readStopFn(), $.get(this.PT, P_SOCK, $.l(P)));
        });
      });
    });
  }

  /** parserOnMessageComplete() */
  private parserOnMessageCompleteFn(): number {
    return this.fn("parserOnMessageComplete", [this.parserRef()], [], (f, $) => {
      const P = 0;
      const PT = this.PT;
      const INC = f.local(this.incRef());
      const IT = this.incT();
      $.put(INC, $.get(PT, P_INCOMING, $.l(P)));
      $.if($.andThen($.notNull($.l(INC)), $.not($.get(IT, I_SKIP, $.l(INC)))), () => {
        $.set(IT, I_COMPLETE, $.l(INC), $.i(1));
        $.if($.gt($.get(PT, P_JSHDRS_N, $.l(P)), $.i(0)), () => {
          $.run(this.addHeaderLinesFn(), $.l(INC), $.get(PT, P_JSHDRS, $.l(P)), $.get(PT, P_JSHDRS_N, $.l(P)), $.get(PT, P_JSHDRS_N, $.l(P)));
          $.set(PT, P_JSHDRS, $.l(P), $.anew(this.strArrT, $.i(0)));
          $.set(PT, P_JSHDRS_N, $.l(P), $.i(0));
          $.set(PT, P_JSURL, $.l(P), this.lit($, ""));
        });
        $.run(this.incPushNullFn(), $.l(INC));
        this.excReturn($);
      });
      $.run(this.readStartFn(), $.get(PT, P_SOCK, $.l(P)));
    });
  }

  /** freeParser(parser, req, socket): unconsume, remove from the
   * connections list, cleanParser, back to the FreeList. */
  private freeParserFn(): number {
    return this.fn("freeParser", [this.parserRef(), EQ_REF, this.sockRef], [], (f, $) => {
      const [P, REQ, S] = [0, 1, 2];
      const PT = this.PT;
      $.if($.notNull($.l(P)), () => {
        $.if($.get(PT, P_CONSUMED, $.l(P)), () => $.run(this.unconsumeHandleFn(), $.get(PT, P_SOCK, $.l(P))));
        // parser.remove(): is_being_freed_, and out of the connections list.
        $.set(PT, P_FREED, $.l(P), $.i(1));
        $.run(this.connsRemoveFn(), $.l(P));
        // cleanParser
        $.set(PT, P_JSHDRS, $.l(P), $.anew(this.strArrT, $.i(0)));
        $.set(PT, P_JSHDRS_N, $.l(P), $.i(0));
        $.set(PT, P_JSURL, $.l(P), this.lit($, ""));
        $.set(PT, P_SOCK, $.l(P), $.nul(this.sockT));
        $.set(PT, P_INCOMING, $.l(P), $.nul(this.incT()));
        $.set(PT, P_OUTGOING, $.l(P), $.nul(EQ_HEAP));
        $.set(PT, P_MAXPAIRS, $.l(P), $.i(2000));
        $.set(PT, P_ONEXECUTE, $.l(P), $.i(0));
        $.set(PT, P_CONSUMED, $.l(P), $.i(0));
        $.set(PT, P_CONN, $.l(P), $.nul(EQ_HEAP));
        $.set(PT, P_JOINDUP, $.l(P), $.i(-1));
      });
      $.if($.notNull($.l(REQ)), () => {
        $.if($.test(this.creqT(), $.l(REQ)), () => $.set(this.creqT(), C_PARSER, $.cast(this.creqT(), $.l(REQ)), $.nul(PT)));
      });
      $.if($.notNull($.l(S)), () => $.set(this.sockT, NET_SOCK_HTTP.S_PARSER, $.l(S), $.nul(EQ_HEAP)));
    });
  }

  /** parser.unconsume(): the handle's reads go back to the socket. */
  private unconsumeHandleFn(): number {
    return this.fn("unconsumeHandle", [this.sockRef], [], (f, $) => {
      $.if($.notNull($.l(0)), () => $.set(this.sockT, NET_SOCK_HTTP.S_CONSUMED, $.l(0), $.i(0)));
    });
  }

  /* ── IncomingMessage (lib/_http_incoming.js over Readable) ───────── */

  private get IT(): number {
    return this.incT();
  }

  /** (inc.RS & mask) != 0 */
  private rbit($: A, o: X, mask: number): X {
    return $.bit(this.IT, I_RS, o, mask);
  }

  private rset($: A, o: X, mask: number): void {
    $.bitSet(this.IT, I_RS, o, mask);
  }

  private rclr($: A, o: X, mask: number): void {
    $.bitClr(this.IT, I_RS, o, mask);
  }

  /** (inc.RS & mask) == want */
  private rbitsEq($: A, o: X, mask: number, want: number): X {
    return $.eq($.and($.get(this.IT, I_RS, o), $.i(mask)), $.i(want));
  }

  /** new IncomingMessage(socket): a Readable (autoDestroy, emitClose,
   * highWaterMark = socket.readableHighWaterMark, sync) with readingMore
   * already true. */
  incNewFn(): number {
    return this.fn("incNew", [this.sockRef], [this.incRef()], (f, $) => {
      const c = f.c;
      const S = 0;
      c.i32Const(kSync | kReadingMore); // I_RS
      c.i32Const(0); // I_RLEN
      c.refNull(this.chunkArrT);
      c.i32Const(0);
      c.i32Const(0);
      c.refNull(this.deps.errType()); // I_RERR
      c.localGet(S); // I_SOCK
      c.i32Const(-1); // I_MAJOR (null)
      c.i32Const(-1); // I_MINOR
      c.i32Const(0); // I_COMPLETE
      $.do($.anew(this.strArrT, $.i(0)));
      c.i32Const(0); // I_HCOUNT
      c.i32Const(0); // I_RAWH_N
      $.do($.anew(this.strArrT, $.i(0)));
      c.i32Const(0);
      c.i32Const(0);
      this.deps.pushStrLit(c, ""); // I_URL
      c.refNull(this.strT); // I_METHOD
      c.i32Const(-1); // I_STATUS
      c.refNull(this.strT); // I_STATUSMSG
      c.i32Const(0); // I_ABORTED
      c.i32Const(-1); // I_UPGRADE (null)
      c.i32Const(0); // I_CONSUMING
      c.i32Const(0); // I_DUMPED
      c.i32Const(0); // I_SKIP
      c.i32Const(0); // I_JOINDUP
      c.refNull(EQ_HEAP); // I_REQ
      c.refNull(EQ_HEAP); // I_HEADERS
      c.i32Const(0); // I_SERVER
      for (let i = 0; i < 5; i++) {
        c.refNull(this.entArrT);
        c.i32Const(0);
      }
      c.refNull(EQ_HEAP); // I_PIPE
      c.i32Const(0); // I_AWAIT
      for (let i = 0; i < 10; i++) c.refNull(EQ_HEAP); // I_PIPEDATA .. I_RAWVEC
      c.f64Const(0);
      c.structNew(this.IT);
    });
  }

  /** _addHeaderLines(headers, n): rawHeaders / rawTrailers (the objects
   * are built lazily by the readers). */
  private addHeaderLinesFn(): number {
    return this.fn("_addHeaderLines", [this.incRef(), this.ref(this.strArrT), I32, I32], [], (f, $) => {
      const [INC, H, LEN, N] = [0, 1, 2, 3];
      const IT = this.IT;
      $.if($.gt($.l(LEN), $.i(0)), () => {
        $.if($.get(IT, I_COMPLETE, $.l(INC)), () => {
          $.set(IT, I_RAWT, $.l(INC), $.l(H));
          $.set(IT, I_RAWT_N, $.l(INC), $.l(LEN));
          $.set(IT, I_TCOUNT, $.l(INC), $.l(N));
        }, () => {
          $.set(IT, I_RAWH, $.l(INC), $.l(H));
          $.set(IT, I_RAWH_N, $.l(INC), $.l(LEN));
          $.set(IT, I_HCOUNT, $.l(INC), $.l(N));
        });
      });
    });
  }

  /** canPushMore(state) */
  private canPushMore($: A, o: X): X {
    return $.both($.not(this.rbit($, o, kEnded)), $.or($.lt($.get(this.IT, I_RLEN, o), $.i(HWM)), $.eq($.get(this.IT, I_RLEN, o), $.i(0))));
  }

  /** Readable.prototype.push(chunk) for a Buffer chunk. */
  incPushFn(): number {
    return this.fn("incPush", [this.incRef(), this.bytesRef], [I32], (f, $) => {
      const [S, B] = [0, 1];
      const s = $.l(S);
      $.if($.le($.get(this.deps.bytesType(), 2, $.l(B)), $.i(0)), () => {
        this.rclr($, s, kReading);
        $.run(this.incMaybeReadMoreFn(), s);
        $.ret(this.canPushMore($, s));
      });
      $.if(this.rbit($, s, kEnded), () => {
        $.run(this.incErrorOrDestroyFn(), s, this.err($, "%Error", this.lit($, "stream.push() after EOF"), "ERR_STREAM_PUSH_AFTER_EOF"));
        $.ret($.i(0));
      });
      $.if(this.rbit($, s, kDestroyed | kErrored), () => $.ret($.i(0)));
      this.rclr($, s, kReading);
      $.run(this.incAddChunkFn(), s, $.l(B));
      this.excReturn($, $.i(0));
      $.do(this.canPushMore($, s));
    });
  }

  /** push(null): onEofChunk. */
  incPushNullFn(): number {
    return this.fn("incPushNull", [this.incRef()], [], (f, $) => {
      const s = $.l(0);
      this.rclr($, s, kReading);
      $.if(this.rbit($, s, kEnded), () => $.ret());
      this.rset($, s, kEnded);
      $.if(this.rbit($, s, kSync), () => $.run(this.incEmitReadableFn(), s), () => {
        this.rclr($, s, kNeedReadable);
        this.rset($, s, kEmittedReadable);
        $.run(this.incEmitReadableNowFn(), s);
      });
    });
  }

  /** addChunk(stream, state, chunk, false) */
  private incAddChunkFn(): number {
    return this.fn("incAddChunk", [this.incRef(), this.bytesRef], [], (f, $) => {
      const [S, B] = [0, 1];
      const s = $.l(S);
      const IT = this.IT;
      $.if(
        $.both(this.rbitsEq($, s, kFlowing | kSync | kDataListening, kFlowing | kDataListening), $.eq($.get(IT, I_RLEN, s), $.i(0))),
        () => {
          // awaitDrainWriters = null
          $.set(IT, I_AWAIT, s, $.i(0));
          this.emit($, HL.INC_DATA, s, $.l(B));
          this.excReturn($);
        },
        () => {
          $.set(IT, I_RLEN, s, $.add($.get(IT, I_RLEN, s), $.get(this.deps.bytesType(), 2, $.l(B))));
          $.run(this.incBufPushFn(), s, $.l(B));
          $.if(this.rbit($, s, kNeedReadable), () => $.run(this.incEmitReadableFn(), s));
        },
      );
      $.run(this.incMaybeReadMoreFn(), s);
    });
  }

  private incBufPushFn(): number {
    return this.fn("incBufPush", [this.incRef(), this.bytesRef], [], (f, $) => {
      const [S, B] = [0, 1];
      const IT = this.IT;
      const NA = f.local(this.ref(this.chunkArrT));
      const s = $.l(S);
      $.if($.isNull($.get(IT, I_RBUF, s)), () => {
        $.set(IT, I_RBUF, s, $.anew(this.chunkArrT, $.i(8)));
        $.set(IT, I_RHEAD, s, $.i(0));
        $.set(IT, I_RN, s, $.i(0));
      });
      $.if($.geU($.get(IT, I_RN, s), $.alen($.get(IT, I_RBUF, s))), () => {
        $.put(NA, $.anew(this.chunkArrT, $.shl($.alen($.get(IT, I_RBUF, s)), $.i(1))));
        $.do($.l(NA), $.i(0), $.get(IT, I_RBUF, s), $.i(0), $.get(IT, I_RN, s));
        f.c.arrayCopy(this.chunkArrT, this.chunkArrT);
        $.set(IT, I_RBUF, s, $.l(NA));
      });
      $.aset(this.chunkArrT, $.get(IT, I_RBUF, s), $.get(IT, I_RN, s), $.l(B));
      $.inc(IT, I_RN, s);
    });
  }

  /** maybeReadMore(stream, state) */
  private incMaybeReadMoreFn(): number {
    return this.fn("incMaybeReadMore", [this.incRef()], [], (f, $) => {
      const s = $.l(0);
      $.if($.not(this.rbit($, s, kReadingMore | kReading)), () => {
        this.rset($, s, kReadingMore);
        this.nextTick($, this.incMaybeReadMoreTick(), { a: s });
      });
    });
  }

  private incMaybeReadMoreTick(): number {
    return this.tick("incMaybeReadMore_", ($, e, f) => {
      const S = f.local(this.incRef());
      const LEN = f.local(I32);
      const IT = this.IT;
      $.put(S, this.as($, IT, e.a));
      const s = $.l(S);
      const c = f.c;
      c.block();
      c.loop();
      $.do(
        $.not(
          $.both(
            $.not(this.rbit($, s, kReading | kEnded)),
            $.or($.lt($.get(IT, I_RLEN, s), $.i(HWM)), $.both(this.rbit($, s, kFlowing), $.eq($.get(IT, I_RLEN, s), $.i(0)))),
          ),
        ),
      );
      c.brIf(1);
      $.put(LEN, $.get(IT, I_RLEN, s));
      $.drop($.call(this.incReadFn(), s, $.d(0)));
      this.excReturn($);
      $.do($.eq($.l(LEN), $.get(IT, I_RLEN, s)));
      c.brIf(1);
      c.br(0);
      c.end();
      c.end();
      this.rclr($, s, kReadingMore);
    });
  }

  /** emitReadable(stream) */
  private incEmitReadableFn(): number {
    return this.fn("incEmitReadable", [this.incRef()], [], (f, $) => {
      const s = $.l(0);
      this.rclr($, s, kNeedReadable);
      $.if($.not(this.rbit($, s, kEmittedReadable)), () => {
        this.rset($, s, kEmittedReadable);
        this.nextTick($, this.tick("incEmitReadable_", ($2, e) => $2.run(this.incEmitReadableNowFn(), this.as($2, this.IT, e.a))), { a: s });
      });
    });
  }

  /** emitReadable_(stream): 'readable' has no listener here, then flow. */
  private incEmitReadableNowFn(): number {
    return this.fn("incEmitReadable_", [this.incRef()], [], (f, $) => {
      const s = $.l(0);
      const IT = this.IT;
      $.if($.both($.not(this.rbit($, s, kDestroyed | kErrored)), $.or($.ne($.get(IT, I_RLEN, s), $.i(0)), this.rbit($, s, kEnded))), () =>
        this.rclr($, s, kEmittedReadable),
      );
      $.if($.both($.not(this.rbit($, s, kFlowing | kEnded)), $.le($.get(IT, I_RLEN, s), $.i(HWM))), () => this.rset($, s, kNeedReadable));
      $.run(this.incFlowFn(), s);
    });
  }

  /** flow(stream) */
  private incFlowFn(): number {
    return this.fn("incFlow", [this.incRef()], [], (f, $) => {
      const s = $.l(0);
      const c = f.c;
      c.block();
      c.loop();
      $.do($.not(this.rbit($, s, kFlowing)));
      c.brIf(1);
      $.do($.isNull($.call(this.incReadFn(), s, $.d(NaN))));
      this.excReturn($);
      c.brIf(1);
      c.br(0);
      c.end();
      c.end();
    });
  }

  /** howMuchToRead(n, state) */
  private incHowMuchFn(): number {
    return this.fn("incHowMuch", [this.incRef(), F64], [F64], (f, $) => {
      const [S, N] = [0, 1];
      const s = $.l(S);
      const IT = this.IT;
      const len = $.get(IT, I_RLEN, s);
      $.if($.or($.dle($.l(N), $.d(0)), $.both($.eq(len, $.i(0)), this.rbit($, s, kEnded))), () => $.ret($.d(0)));
      $.if($.dne($.l(N), $.l(N)), () => {
        $.if($.both(this.rbit($, s, kFlowing), $.ne(len, $.i(0))), () =>
          $.ret($.i2d($.get(this.deps.bytesType(), 2, $.aget(this.chunkArrT, $.get(IT, I_RBUF, s), $.get(IT, I_RHEAD, s))))),
        );
        $.ret($.i2d(len));
      });
      $.if($.dle($.l(N), $.i2d(len)), () => $.ret($.l(N)));
      $.do($.sel(F64, this.rbit($, s, kEnded), $.i2d(len), $.d(0)));
    });
  }

  /** A view of bytes `b` from `off` for `len` (Buffer.slice shares). */
  private sliceBytes($: A, b: X, off: X, len: X): X {
    const BT = this.deps.bytesType();
    return $.new_(BT, $.get(BT, 0, b), $.add($.get(BT, 1, b), off), len);
  }

  /** fromList(n, state) — n > 0 bytes off the front of the buffer. */
  private incFromListFn(): number {
    return this.fn("incFromList", [this.incRef(), I32], [this.bytesRef], (f, $) => {
      const [S, N] = [0, 1];
      const IT = this.IT;
      const BT = this.deps.bytesType();
      const bufT = this.deps.bufType();
      const FIRST = f.local(this.bytesRef);
      const DST = f.local(this.ref(bufT));
      const AT = f.local(I32);
      const I = f.local(I32);
      const CH = f.local(this.bytesRef);
      const TAKE = f.local(I32);
      const s = $.l(S);
      const rbuf = $.get(IT, I_RBUF, s);
      const head = $.get(IT, I_RHEAD, s);
      const copyInto = (): void => {
        $.do($.l(DST), $.l(AT), $.get(BT, 0, $.l(CH)), $.get(BT, 1, $.l(CH)), $.l(TAKE));
        f.c.arrayCopy(bufT, bufT);
        $.put(AT, $.add($.l(AT), $.l(TAKE)));
      };
      const reset = (): void => {
        $.set(IT, I_RBUF, s, $.nul(this.chunkArrT));
        $.set(IT, I_RHEAD, s, $.i(0));
        $.set(IT, I_RN, s, $.i(0));
      };
      const out = (n: X): X => $.new_(BT, $.raw((c) => {
        c.localGet(DST);
        c.refAsNonNull();
      }), $.i(0), n);
      $.if($.eq($.get(IT, I_RLEN, s), $.i(0)), () => $.ret($.nul(BT)));
      $.if($.ge($.l(N), $.get(IT, I_RLEN, s)), () => {
        $.if($.eq($.sub($.get(IT, I_RN, s), head), $.i(1)), () => {
          $.put(FIRST, $.aget(this.chunkArrT, rbuf, head));
          reset();
          $.ret($.l(FIRST));
        });
        $.put(DST, $.anew(bufT, $.get(IT, I_RLEN, s)));
        $.for(I, head, $.get(IT, I_RN, s), () => {
          $.put(CH, $.aget(this.chunkArrT, rbuf, $.l(I)));
          $.put(TAKE, $.get(BT, 2, $.l(CH)));
          copyInto();
        });
        reset();
        $.ret(out($.l(AT)));
      });
      $.put(FIRST, $.aget(this.chunkArrT, rbuf, head));
      $.if($.lt($.l(N), $.get(BT, 2, $.l(FIRST))), () => {
        $.aset(this.chunkArrT, rbuf, head, this.sliceBytes($, $.l(FIRST), $.l(N), $.sub($.get(BT, 2, $.l(FIRST)), $.l(N))));
        $.ret(this.sliceBytes($, $.l(FIRST), $.i(0), $.l(N)));
      });
      $.if($.eq($.l(N), $.get(BT, 2, $.l(FIRST))), () => {
        $.aset(this.chunkArrT, rbuf, head, $.nul(BT));
        $.inc(IT, I_RHEAD, s);
        $.if($.eq($.get(IT, I_RHEAD, s), $.get(IT, I_RN, s)), reset);
        $.ret($.l(FIRST));
      });
      $.put(DST, $.anew(bufT, $.l(N)));
      $.while($.lt($.l(AT), $.l(N)), () => {
        $.put(CH, $.aget(this.chunkArrT, rbuf, head));
        $.if($.ge($.sub($.l(N), $.l(AT)), $.get(BT, 2, $.l(CH))), () => {
          $.put(TAKE, $.get(BT, 2, $.l(CH)));
          copyInto();
          $.aset(this.chunkArrT, rbuf, head, $.nul(BT));
          $.inc(IT, I_RHEAD, s);
        }, () => {
          $.put(TAKE, $.sub($.l(N), $.l(AT)));
          $.aset(this.chunkArrT, rbuf, head, this.sliceBytes($, $.l(CH), $.l(TAKE), $.sub($.get(BT, 2, $.l(CH)), $.l(TAKE))));
          copyInto();
        });
      });
      $.if($.eq($.get(IT, I_RHEAD, s), $.get(IT, I_RN, s)), reset);
      $.do(out($.l(N)));
    });
  }

  /** Readable.prototype.read(n) — n is 0, or NaN for read(). */
  incReadFn(): number {
    return this.fn("incRead", [this.incRef(), F64], [this.bytesRef], (f, $) => {
      const [S, N] = [0, 1];
      const IT = this.IT;
      const BT = this.deps.bytesType();
      const NORIG = f.local(F64);
      const DOREAD = f.local(I32);
      const RET = f.local(this.bytesRef);
      const s = $.l(S);
      const len = $.get(IT, I_RLEN, s);
      const howMuch = (from: number): void => $.put(N, $.call(this.incHowMuchFn(), s, $.l(from)));
      $.put(NORIG, $.l(N));
      $.if($.dne($.l(N), $.d(0)), () => this.rclr($, s, kEmittedReadable));
      $.if($.both($.both($.deq($.l(N), $.d(0)), this.rbit($, s, kNeedReadable)), $.or($.ge(len, $.i(HWM)), this.rbit($, s, kEnded))), () => {
        $.if($.both($.eq(len, $.i(0)), this.rbit($, s, kEnded)), () => $.run(this.incEndReadableFn(), s), () => $.run(this.incEmitReadableFn(), s));
        $.ret($.nul(BT));
      });
      howMuch(N);
      $.if($.both($.deq($.l(N), $.d(0)), this.rbit($, s, kEnded)), () => {
        $.if($.eq(len, $.i(0)), () => $.run(this.incEndReadableFn(), s));
        $.ret($.nul(BT));
      });
      $.put(DOREAD, this.rbit($, s, kNeedReadable));
      $.if($.or($.eq(len, $.i(0)), $.dlt($.dsub($.i2d(len), $.l(N)), $.d(HWM))), () => $.put(DOREAD, $.i(1)));
      $.if(this.rbit($, s, kReading | kEnded | kDestroyed | kErrored), () => $.put(DOREAD, $.i(0)), () => {
        $.if($.l(DOREAD), () => {
          this.rset($, s, kReading | kSync);
          $.if($.eq(len, $.i(0)), () => this.rset($, s, kNeedReadable));
          $.run(this.incReadImplFn(), s);
          this.rclr($, s, kSync);
          $.if($.not(this.rbit($, s, kReading)), () => howMuch(NORIG));
        });
      });
      $.if($.dgt($.l(N), $.d(0)), () => $.put(RET, $.call(this.incFromListFn(), s, $.d2i($.l(N)))));
      $.if($.isNull($.l(RET)), () => {
        $.if($.le(len, $.i(HWM)), () => this.rset($, s, kNeedReadable));
        $.put(N, $.d(0));
      }, () => {
        $.set(IT, I_RLEN, s, $.sub(len, $.d2i($.l(N))));
        $.set(IT, I_AWAIT, s, $.i(0));
      });
      $.if($.eq(len, $.i(0)), () => {
        $.if($.not(this.rbit($, s, kEnded)), () => this.rset($, s, kNeedReadable));
        $.if($.both($.dne($.l(NORIG), $.l(N)), this.rbit($, s, kEnded)), () => $.run(this.incEndReadableFn(), s));
      });
      $.if($.both($.notNull($.l(RET)), $.not(this.rbit($, s, kErrorEmitted | kCloseEmitted))), () => {
        this.emit($, HL.INC_DATA, s, $.l(RET));
      });
      $.do($.l(RET));
    });
  }

  /** IncomingMessage.prototype._read(n) */
  private incReadImplFn(): number {
    return this.fn("inc_read", [this.incRef()], [], (f, $) => {
      const s = $.l(0);
      const IT = this.IT;
      $.if($.not($.get(IT, I_CONSUMING, s)), () => {
        this.rclr($, s, kReadingMore);
        $.set(IT, I_CONSUMING, s, $.i(1));
      });
      $.if($.call(this.net.readableHelper(), $.get(IT, I_SOCK, s)), () => $.run(this.readStartFn(), $.get(IT, I_SOCK, s)));
    });
  }

  /** readStart(socket): if (socket && !socket._paused && socket.readable)
   * socket.resume(). */
  readStartFn(): number {
    return this.fn("readStart", [this.sockRef], [], (f, $) => {
      const S = 0;
      $.if($.notNull($.l(S)), () => {
        $.if($.both($.not($.get(this.sockT, NET_SOCK_HTTP.S_HPAUSED, $.l(S))), $.call(this.net.readableHelper(), $.l(S))), () =>
          $.run(this.net.resumeHelper(), $.l(S)),
        );
      });
    });
  }

  /** readStop(socket): if (socket) socket.pause(). */
  private readStopFn(): number {
    return this.fn("readStop", [this.sockRef], [], (f, $) => {
      $.if($.notNull($.l(0)), () => $.run(this.net.pauseHelper(), $.l(0)));
    });
  }

  /** endReadable(stream) */
  private incEndReadableFn(): number {
    return this.fn("incEndReadable", [this.incRef()], [], (f, $) => {
      const s = $.l(0);
      $.if($.not(this.rbit($, s, kEndEmitted)), () => {
        this.rset($, s, kEnded);
        this.nextTick($, this.incEndReadableTick(), { a: s });
      });
    });
  }

  /** endReadableNT(state, stream): 'end', then autoDestroy (a Readable
   * has no writable side). */
  private incEndReadableTick(): number {
    return this.tick("incEndReadableNT", ($, e, f) => {
      const S = f.local(this.incRef());
      $.put(S, this.as($, this.IT, e.a));
      const s = $.l(S);
      $.if($.both($.not(this.rbit($, s, kErrored | kCloseEmitted | kEndEmitted)), $.eq($.get(this.IT, I_RLEN, s), $.i(0))), () => {
        this.rset($, s, kEndEmitted);
        this.emit($, HL.INC_END, s);
        this.excReturn($);
        $.run(this.incDestroyFn(), s, $.nul(this.deps.errType()));
      });
    });
  }

  /** Readable.prototype.resume */
  incResumeFn(): number {
    return this.fn("incResume", [this.incRef()], [], (f, $) => {
      const s = $.l(0);
      $.if($.not(this.rbit($, s, kFlowing)), () => {
        this.rset($, s, kHasFlowing | kFlowing);
        $.if($.not(this.rbit($, s, kResumeScheduled)), () => {
          this.rset($, s, kResumeScheduled);
          this.nextTick($, this.incResumeTick(), { a: s });
        });
      });
      this.rset($, s, kHasPaused);
      this.rclr($, s, kPaused);
    });
  }

  /** resume_(stream, state) ('resume' has no listener here). */
  private incResumeTick(): number {
    return this.tick("incResume_", ($, e, f) => {
      const S = f.local(this.incRef());
      $.put(S, this.as($, this.IT, e.a));
      const s = $.l(S);
      $.if($.not(this.rbit($, s, kReading)), () => {
        $.drop($.call(this.incReadFn(), s, $.d(0)));
        this.excReturn($);
      });
      this.rclr($, s, kResumeScheduled);
      $.run(this.incFlowFn(), s);
      this.excReturn($);
      $.if(this.rbitsEq($, s, kFlowing | kReading, kFlowing), () => $.drop($.call(this.incReadFn(), s, $.d(0))));
    });
  }

  /** Readable.prototype.pause ('pause' has no listener here). */
  incPauseFn(): number {
    return this.fn("incPause", [this.incRef()], [], (f, $) => {
      const s = $.l(0);
      $.if($.not(this.rbitsEq($, s, kHasFlowing | kFlowing, kHasFlowing)), () => {
        this.rset($, s, kHasFlowing);
        this.rclr($, s, kFlowing);
      });
      this.rset($, s, kHasPaused | kPaused);
    });
  }

  /** Readable.prototype.on('data', ...)'s own side, after the listener is
   * added: kDataListening, and resume() unless explicitly paused. */
  incDataAddedFn(): number {
    return this.fn("incDataAdded", [this.incRef()], [], (f, $) => {
      const s = $.l(0);
      this.rset($, s, kDataListening);
      $.if($.not(this.rbitsEq($, s, kHasFlowing | kFlowing, kHasFlowing)), () => $.run(this.incResumeFn(), s));
    });
  }

  /** Readable.prototype.removeListener('data', ...)'s own side. */
  private incDataRemovedFn(): number {
    return this.fn("incDataRemoved", [this.incRef()], [], (f, $) => {
      $.if($.eq($.call(this.countFn(HL.INC_DATA), $.l(0)), $.i(0)), () => this.rclr($, $.l(0), kDataListening));
    });
  }

  /** IncomingMessage.prototype._dump */
  incDumpFn(): number {
    return this.fn("_dump", [this.incRef()], [], (f, $) => {
      const s = $.l(0);
      $.if($.not($.get(this.IT, I_DUMPED, s)), () => {
        $.set(this.IT, I_DUMPED, s, $.i(1));
        $.run(this.removeAllFn(HL.INC_DATA), s);
        $.run(this.incResumeFn(), s);
      });
    });
  }

  /** Readable readable getter: !destroyed && !errorEmitted && !endEmitted. */
  incReadableFn(): number {
    return this.fn("incReadable", [this.incRef()], [I32], (f, $) => {
      $.do($.not(this.rbit($, $.l(0), kDestroyed | kErrorEmitted | kEndEmitted)));
    });
  }

  incDestroyedFn(): number {
    return this.fn("incDestroyed", [this.incRef()], [I32], (f, $) => $.do(this.rbit($, $.l(0), kDestroyed)));
  }

  /** readableEnded */
  private incEndedFn(): number {
    return this.fn("incEnded", [this.incRef()], [I32], (f, $) => $.do(this.rbit($, $.l(0), kEndEmitted)));
  }

  /** errorOrDestroy(stream, err): autoDestroy is on. */
  private incErrorOrDestroyFn(): number {
    return this.fn("incErrorOrDestroy", [this.incRef(), this.errRef], [], (f, $) => {
      $.if(this.rbit($, $.l(0), kDestroyed), () => $.ret());
      $.run(this.incDestroyFn(), $.l(0), $.l(1));
    });
  }

  /** destroy(err) (lib/internal/streams/destroy.js) */
  incDestroyFn(): number {
    return this.fn("incDestroy", [this.incRef(), this.errRef], [], (f, $) => {
      const [S, ERR] = [0, 1];
      const s = $.l(S);
      $.if(this.rbit($, s, kDestroyed), () => $.ret());
      $.if($.both($.notNull($.l(ERR)), $.not(this.rbit($, s, kErrored))), () => {
        $.set(this.IT, I_RERR, s, $.l(ERR));
        this.rset($, s, kErrored);
      });
      this.rset($, s, kDestroyed);
      $.run(this.incDestroyImplFn(), s, $.l(ERR));
    });
  }

  /** IncomingMessage.prototype._destroy(err, onDestroy) */
  private incDestroyImplFn(): number {
    return this.fn("inc_destroy", [this.incRef(), this.errRef], [], (f, $) => {
      const [S, ERR] = [0, 1];
      const IT = this.IT;
      const SOCK = f.local(this.sockRef);
      const s = $.l(S);
      $.if($.or($.not(this.rbit($, s, kEndEmitted)), $.not($.get(IT, I_COMPLETE, s))), () => {
        $.set(IT, I_ABORTED, s, $.i(1));
        this.emit($, HL.INC_ABORTED, s);
        this.excReturn($);
      });
      $.put(SOCK, $.get(IT, I_SOCK, s));
      $.if(
        $.andThen($.notNull($.l(SOCK)), $.both($.not($.call(this.net.destroyedHelper(), $.l(SOCK))), $.get(IT, I_ABORTED, s))),
        () => {
          $.run(this.net.destroyHelper(), $.l(SOCK), $.l(ERR));
          // finished(this.socket, cb): the socket's 'error' or 'close',
          // whichever comes first, then onError on a tick.
          const once = this.clos($, this.incEosFn(), "void", { a: s, b: $.l(ERR) as X });
          const L = f.local(this.vclosRef);
          $.put(L, $.cast(this.deps.voidClos().clos, once));
          $.set(IT, I_PIPEUNPIPESRC, s, $.l(L));
          this.son($, NET_LISTS.L_CLOSE, $.l(SOCK), $.l(L), true);
          this.son($, NET_LISTS.L_ERROR, $.l(SOCK), $.raw(() => {
            this.clos($, this.incEosErrFn(), "err", { a: s, b: $.l(L) })();
          }), true);
        },
        () => this.nextTick($, this.incOnErrorTick(), { a: s, b: $.l(ERR) }),
      );
    });
  }

  /** The eos callback of _destroy (a once listener on the socket's
   * 'close'): process.nextTick(onError, this, e || err, cb). */
  private incEosFn(): number {
    return this.tick("incEos", ($, e) => {
      const IT = this.IT;
      const s = this.as($, IT, e.a);
      // Called once: the 'error' twin clears the marker.
      $.if($.isNull($.get(IT, I_PIPEUNPIPESRC, s)), () => $.ret());
      $.set(IT, I_PIPEUNPIPESRC, s, $.nul(EQ_HEAP));
      this.nextTick($, this.incOnErrorTick(), { a: s, b: $.l(e.b) });
    });
  }

  private incEosErrFn(): number {
    return this.closFn("incEosErr", "err", ($, e, f, arg) => {
      const IT = this.IT;
      const s = this.as($, IT, e.a);
      $.if($.isNull($.get(IT, I_PIPEUNPIPESRC, s)), () => $.ret());
      $.set(IT, I_PIPEUNPIPESRC, s, $.nul(EQ_HEAP));
      this.nextTick($, this.incOnErrorTick(), { a: s, b: $.l(arg) });
    });
  }

  /** onError(self, error, cb) with cb = destroy.js's onDestroy. */
  private incOnErrorTick(): number {
    return this.tick("incOnError", ($, e, f) => {
      const S = f.local(this.incRef());
      const ERR = f.local(this.errRef);
      $.put(S, this.as($, this.IT, e.a));
      $.put(ERR, $.sel(this.errRef, $.isNull($.l(e.b)), $.nul(this.deps.errType()), $.cast(this.deps.errType(), $.l(e.b))));
      $.if($.eq($.call(this.countFn(HL.INC_ERROR), $.l(S)), $.i(0)), () => $.put(ERR, $.nul(this.deps.errType())));
      $.run(this.incOnDestroyFn(), $.l(S), $.l(ERR));
    });
  }

  /** destroy.js's onDestroy(err) */
  private incOnDestroyFn(): number {
    return this.fn("incOnDestroy", [this.incRef(), this.errRef], [], (f, $) => {
      const [S, ERR] = [0, 1];
      const s = $.l(S);
      $.if($.both($.notNull($.l(ERR)), $.not(this.rbit($, s, kErrored))), () => {
        $.set(this.IT, I_RERR, s, $.l(ERR));
        this.rset($, s, kErrored);
      });
      this.rset($, s, kClosed);
      $.if($.notNull($.l(ERR)), () => this.nextTick($, this.incEmitErrorCloseTick(), { a: s, b: $.l(ERR) }), () =>
        this.nextTick($, this.incEmitCloseTick(), { a: s }),
      );
    });
  }

  private incEmitErrorCloseTick(): number {
    return this.tick("incEmitErrorCloseNT", ($, e, f) => {
      const S = f.local(this.incRef());
      $.put(S, this.as($, this.IT, e.a));
      $.if($.not(this.rbit($, $.l(S), kErrorEmitted)), () => {
        this.rset($, $.l(S), kErrorEmitted);
        this.emit($, HL.INC_ERROR, $.l(S), $.cast(this.deps.errType(), $.l(e.b)));
        this.excReturn($);
      });
      this.rset($, $.l(S), kCloseEmitted);
      this.emit($, HL.INC_CLOSE, $.l(S));
    });
  }

  private incEmitCloseTick(): number {
    return this.tick("incEmitCloseNT", ($, e, f) => {
      const S = f.local(this.incRef());
      $.put(S, this.as($, this.IT, e.a));
      this.rset($, $.l(S), kCloseEmitted);
      this.emit($, HL.INC_CLOSE, $.l(S));
    });
  }

  /* ── Readable.prototype.pipe(dest) for an OutgoingMessage dest ──── */

  /** src.pipe(dest) — one destination per source here (a second pipe is
   * the named fence in the emitter). */
  incPipeFn(): number {
    return this.fn("incPipe", [this.incRef(), this.outRef()], [], (f, $) => {
      const [S, D] = [0, 1];
      const IT = this.IT;
      const OT = this.outT();
      const s = $.l(S);
      const d = $.l(D);
      const L = f.local(EQ_REF);
      $.set(IT, I_PIPE, s, d);
      // endFn: onend (doEnd), once('end') or on a tick when already ended.
      $.put(L, this.clos($, this.pipeOnEndFn(), "void", { a: s, b: d }));
      $.set(IT, I_PIPEEND, s, $.l(L));
      $.if(this.rbit($, s, kEndEmitted), () => {
        $.c.localGet(L);
        $.c.refCast(this.deps.voidClos().clos);
        $.c.call(this.deps.nextTickEnqueue());
      }, () => this.on($, HL.INC_END, s, $.l(L), true));
      $.put(L, this.clos($, this.pipeOnUnpipeFn(), "void", { a: s, b: d }));
      $.set(IT, I_PIPEUNPIPE, s, $.l(L));
      this.on($, HL.OUT_UNPIPE, d, $.l(L));
      $.put(L, this.clos($, this.pipeOnDataFn(), "data", { a: s, b: d }));
      $.set(IT, I_PIPEDATA, s, $.l(L));
      this.on($, HL.INC_DATA, s, $.l(L));
      $.run(this.incDataAddedFn(), s);
      $.put(L, this.clos($, this.pipeOnErrorFn(), "err", { a: s, b: d }));
      $.set(IT, I_PIPEERROR, s, $.l(L));
      this.on($, HL.OUT_ERROR, d, $.l(L), false, true);
      $.put(L, this.clos($, this.pipeOnCloseFn(), "void", { a: s, b: d }));
      $.set(IT, I_PIPECLOSE, s, $.l(L));
      this.on($, HL.OUT_CLOSE, d, $.l(L), true);
      $.put(L, this.clos($, this.pipeOnFinishFn(), "void", { a: s, b: d }));
      $.set(IT, I_PIPEFINISH, s, $.l(L));
      this.on($, HL.OUT_FINISH, d, $.l(L), true);
      // dest.emit('pipe', src): no listener can exist on an OutgoingMessage here.
      $.if($.call(this.outNeedDrainGetterFn(), d), () => $.run(this.pipePauseFn(), s, d), () => {
        $.if($.not(this.rbit($, s, kFlowing)), () => $.run(this.incResumeFn(), s));
      });
      void OT;
    });
  }

  /** onend: dest.end() */
  private pipeOnEndFn(): number {
    return this.tick("pipeOnEnd", ($, e) => {
      $.run(this.outEndFn(), $.cast(this.outT(), $.l(e.b)), $.nul(this.strT), $.nul(this.deps.bytesType()), $.i(ENC_NONE), $.nul(this.deps.voidClos().clos));
    });
  }

  /** ondata(chunk): dest.write(chunk) === false -> pause(). */
  private pipeOnDataFn(): number {
    return this.closFn("pipeOnData", "data", ($, e, f, arg) => {
      const R = f.local(I32);
      $.put(R, $.call(this.outWriteFn(), $.cast(this.outT(), $.l(e.b)), $.nul(this.strT), $.l(arg), $.i(ENC_NONE), $.nul(this.deps.errClos().clos)));
      this.excReturn($);
      $.if($.eq($.l(R), $.i(0)), () => $.run(this.pipePauseFn(), this.as($, this.IT, e.a), $.cast(this.outT(), $.l(e.b))));
    });
  }

  /** The pipe's pause(): awaitDrainWriters = dest, src.pause(), and the
   * lazily-added 'drain' listener. */
  private pipePauseFn(): number {
    return this.fn("pipePause", [this.incRef(), this.outRef()], [], (f, $) => {
      const [S, D] = [0, 1];
      const IT = this.IT;
      const L = f.local(EQ_REF);
      $.if($.notNull($.get(IT, I_PIPEDATA, $.l(S))), () => {
        $.set(IT, I_AWAIT, $.l(S), $.i(1));
        this.rclr($, $.l(S), kMultiAwaitDrain);
        $.run(this.incPauseFn(), $.l(S));
      });
      $.if($.isNull($.get(IT, I_PIPEDRAIN, $.l(S))), () => {
        $.put(L, this.clos($, this.pipeOnDrainFn(), "void", { a: $.l(S), b: $.l(D) }));
        $.set(IT, I_PIPEDRAIN, $.l(S), $.l(L));
        this.on($, HL.OUT_DRAIN, $.l(D), $.l(L));
      });
    });
  }

  /** pipeOnDrain(src, dest)'s function. */
  private pipeOnDrainFn(): number {
    return this.tick("pipeOnDrain", ($, e) => {
      const s = this.as($, this.IT, e.a);
      $.set(this.IT, I_AWAIT, s, $.i(0));
      $.if(this.rbit($, s, kDataListening), () => $.run(this.incResumeFn(), s));
    });
  }

  private pipeOnUnpipeFn(): number {
    return this.tick("pipeOnUnpipe", ($, e) => {
      // readable === src, unpipeInfo.hasUnpiped === false: cleanup().
      $.run(this.pipeCleanupFn(), this.as($, this.IT, e.a), $.cast(this.outT(), $.l(e.b)));
    });
  }

  /** cleanup() */
  private pipeCleanupFn(): number {
    return this.fn("pipeCleanup", [this.incRef(), this.outRef()], [], (f, $) => {
      const [S, D] = [0, 1];
      const IT = this.IT;
      const s = $.l(S);
      const d = $.l(D);
      $.run(this.removeFn(HL.OUT_CLOSE), d, $.get(IT, I_PIPECLOSE, s));
      $.run(this.removeFn(HL.OUT_FINISH), d, $.get(IT, I_PIPEFINISH, s));
      $.if($.notNull($.get(IT, I_PIPEDRAIN, s)), () => $.run(this.removeFn(HL.OUT_DRAIN), d, $.get(IT, I_PIPEDRAIN, s)));
      $.run(this.removeFn(HL.OUT_ERROR), d, $.get(IT, I_PIPEERROR, s));
      $.run(this.removeFn(HL.OUT_UNPIPE), d, $.get(IT, I_PIPEUNPIPE, s));
      $.run(this.removeFn(HL.INC_END), s, $.get(IT, I_PIPEEND, s));
      $.run(this.removeFn(HL.INC_DATA), s, $.get(IT, I_PIPEDATA, s));
      $.run(this.incDataRemovedFn(), s);
      $.set(IT, I_PIPEDATA, s, $.nul(EQ_HEAP));
      // if (ondrain && state.awaitDrainWriters && dest needDrain) ondrain()
      $.if($.both($.notNull($.get(IT, I_PIPEDRAIN, s)), $.get(IT, I_AWAIT, s)), () => {
        $.set(IT, I_AWAIT, s, $.i(0));
        $.if(this.rbit($, s, kDataListening), () => $.run(this.incResumeFn(), s));
      });
    });
  }

  /** onerror(er): unpipe, then the dest's own error handling. */
  private pipeOnErrorFn(): number {
    return this.closFn("pipeOnError", "err", ($, e, f, arg) => {
      const s = this.as($, this.IT, e.a);
      const d = $.cast(this.outT(), $.l(e.b));
      $.run(this.pipeUnpipeFn(), s, d);
      $.run(this.removeFn(HL.OUT_ERROR), d, $.get(this.IT, I_PIPEERROR, s));
      $.if($.eq($.call(this.countFn(HL.OUT_ERROR), d), $.i(0)), () => {
        // dest has no _writableState: dest.emit('error', er).
        this.emit($, HL.OUT_ERROR, d, $.l(arg));
      });
    });
  }

  private pipeOnCloseFn(): number {
    return this.tick("pipeOnClose", ($, e) => {
      const s = this.as($, this.IT, e.a);
      const d = $.cast(this.outT(), $.l(e.b));
      $.run(this.removeFn(HL.OUT_FINISH), d, $.get(this.IT, I_PIPEFINISH, s));
      $.run(this.pipeUnpipeFn(), s, d);
    });
  }

  private pipeOnFinishFn(): number {
    return this.tick("pipeOnFinish", ($, e) => {
      const s = this.as($, this.IT, e.a);
      const d = $.cast(this.outT(), $.l(e.b));
      $.run(this.removeFn(HL.OUT_CLOSE), d, $.get(this.IT, I_PIPECLOSE, s));
      $.run(this.pipeUnpipeFn(), s, d);
    });
  }

  /** src.unpipe(dest) */
  private pipeUnpipeFn(): number {
    return this.fn("pipeUnpipe", [this.incRef(), this.outRef()], [], (f, $) => {
      const [S, D] = [0, 1];
      $.if($.not($.refEq($.get(this.IT, I_PIPE, $.l(S)), $.l(D))), () => $.ret());
      $.set(this.IT, I_PIPE, $.l(S), $.nul(EQ_HEAP));
      $.run(this.incPauseFn(), $.l(S));
      this.emit($, HL.OUT_UNPIPE, $.l(D));
    });
  }

  /* ── OutgoingMessage (lib/_http_outgoing.js) ──────────────────────── */

  private get OT(): number {
    return this.outT();
  }

  /** Push the OutgoingMessage constructor's field values (for the
   * structNew of a $res or $creq), with highWaterMark `hwm`. */
  private pushOutInit(c: Code, kind: number, hwm: X): void {
    c.refNull(this.odArrT); // O_OD
    c.i32Const(0); // O_OD_N
    c.i32Const(0); // O_OUTSIZE
    c.i32Const(1); // O_WRITABLE
    c.i32Const(0); // O_DESTROYED
    c.i32Const(0); // O_LAST
    c.i32Const(0); // O_CHUNKED
    c.i32Const(1); // O_KEEPALIVE
    c.i32Const(0); // O_MAXREQREACHED
    c.i32Const(1); // O_DEFKEEPALIVE
    c.i32Const(1); // O_CHUNKDEFAULT
    c.i32Const(0); // O_SENDDATE
    c.i32Const(0); // O_RMCONN
    c.i32Const(0); // O_RMCLEN
    c.i32Const(0); // O_RMTE
    c.i32Const(0); // O_STRICTCL
    c.f64Const(0); // O_BYTESWRITTEN
    c.f64Const(0); // O_CONTLEN
    c.i32Const(0); // O_HASCONTLEN
    c.i32Const(1); // O_HASBODY
    this.deps.pushStrLit(c, ""); // O_TRAILER
    c.i32Const(0); // O_NEEDDRAIN
    c.i32Const(0); // O_FINISHED
    c.i32Const(0); // O_HEADERSENT
    c.i32Const(0); // O_CORKED
    c.refNull(this.odArrT); // O_CB
    c.i32Const(0);
    c.i32Const(0); // O_CBLEN
    c.i32Const(0); // O_CLOSED
    c.refNull(this.sockT); // O_SOCKET
    c.refNull(this.strT); // O_HEADER
    c.refNull(this.hentArrT); // O_HDRS
    c.i32Const(0);
    c.f64Const(0); // O_KATIMEOUT
    c.refNull(this.deps.errType()); // O_ERRORED
    hwm(); // O_HWM
    c.i32Const(0); // O_REJECTNONSTD
    c.f64Const(0); // O_MAXREQPERSOCK
    for (let i = 0; i < 7; i++) {
      c.refNull(this.entArrT);
      c.i32Const(0);
    }
    c.i32Const(kind); // O_KIND
  }

  /** The module's one `nop` (lib/_http_outgoing.js's): a real function,
   * so a socket write carrying it is not Writable's own nop. */
  private nopG: number | null = null;

  private nopClos($: A): X {
    if (this.nopG === null) {
      const pair = this.deps.errClos();
      this.nopG = this.mb.addGlobal(this.eclosRef, true, (w) => {
        w.u8(0xd0);
        w.sleb(pair.clos);
      });
    }
    const g = this.nopG;
    return () => {
      $.if($.isNull($.g(g)), () => $.gput(g, $.cast(this.deps.errClos().clos, this.clos($, this.closFn("nop", "err", () => {}), "err", {}))));
      $.c.globalGet(g);
    };
  }

  /* header values */

  hvStrNew($: A, s: X): X {
    return $.new_(this.hvT, $.i(0), s, $.d(0), $.nul(EQ_HEAP), $.i(0));
  }

  hvNumNew($: A, n: X): X {
    return $.new_(this.hvT, $.i(1), $.nul(this.strT), n, $.nul(EQ_HEAP), $.i(0));
  }

  /** `(hv) -> string`: String(value) (an array joins with ','). */
  hvToStrFn(): number {
    return this.fn("hvToStr", [this.ref(this.hvT)], [this.strRef], (f, $) => {
      const V = 0;
      const S = f.local(this.strRef);
      const I = f.local(I32);
      const HT = this.hvT;
      $.if($.eq($.get(HT, V_KIND, $.l(V)), $.i(0)), () => $.ret($.get(HT, V_STR, $.l(V))));
      $.if($.eq($.get(HT, V_KIND, $.l(V)), $.i(1)), () => $.ret(this.num2str($, $.get(HT, V_NUM, $.l(V)))));
      $.put(S, this.lit($, ""));
      $.for(I, $.i(0), $.get(HT, V_ARR_N, $.l(V)), () => {
        $.if($.gt($.l(I), $.i(0)), () => $.put(S, this.cat($, $.l(S), this.lit($, ","))));
        $.put(S, this.cat($, $.l(S), $.call(this.hvToStrFn(), $.aget(this.hvArrT, $.cast(this.hvArrT, $.get(HT, V_ARR, $.l(V))), $.l(I)))));
      });
      $.do($.l(S));
    });
  }

  /** validateHeaderName(name[, label]) -> 1, or 0 with the error pending. */
  validateHeaderNameFn(label = "Header name"): number {
    return this.fn(`validateHeaderName:${label}`, [this.strRef], [I32], (f, $) => {
      $.if($.not($.call(this.checkIsHttpTokenFn(), $.l(0))), () => {
        this.throwErr($, "%TypeError", this.cat($, this.lit($, `${label} must be a valid HTTP token ["`), $.l(0), this.lit($, '"]')), "ERR_INVALID_HTTP_TOKEN");
        $.ret($.i(0));
      });
      $.do($.i(1));
    });
  }

  /** validateHeaderValue(name, value) -> 1, or 0 with the error pending
   * (a null value is `undefined`). */
  validateHeaderValueFn(): number {
    return this.fn("validateHeaderValue", [this.strRef, this.ref(this.hvT)], [I32], (f, $) => {
      const [N, V] = [0, 1];
      $.if($.isNull($.l(V)), () => {
        this.throwErr($, "%TypeError", this.cat($, this.lit($, 'Invalid value "undefined" for header "'), $.l(N), this.lit($, '"')), "ERR_HTTP_INVALID_HEADER_VALUE");
        $.ret($.i(0));
      });
      $.if($.call(this.checkInvalidHeaderCharFn(), $.call(this.hvToStrFn(), $.l(V))), () => {
        this.throwErr($, "%TypeError", this.cat($, this.lit($, 'Invalid character in header content ["'), $.l(N), this.lit($, '"]')), "ERR_INVALID_CHAR");
        $.ret($.i(0));
      });
      $.do($.i(1));
    });
  }

  /** The index of kOutHeaders[key], -1 when absent. */
  private hdrFindFn(): number {
    return this.fn("hdrFind", [this.outRef(), this.strRef], [I32], (f, $) => {
      const [O, K] = [0, 1];
      const I = f.local(I32);
      const OT = this.OT;
      $.if($.isNull($.get(OT, O_HDRS, $.l(O))), () => $.ret($.i(-1)));
      $.for(I, $.i(0), $.get(OT, O_HDRS_N, $.l(O)), () => {
        $.if(this.streq($, $.get(this.hentT, E_KEY, $.aget(this.hentArrT, $.get(OT, O_HDRS, $.l(O)), $.l(I))), $.l(K)), () => $.ret($.l(I)));
      });
      $.do($.i(-1));
    });
  }

  /** headers[key] = [name, value] (an existing key keeps its place). */
  private hdrPutFn(): number {
    return this.fn("hdrPut", [this.outRef(), this.strRef, this.strRef, this.ref(this.hvT)], [], (f, $) => {
      const [O, K, N, V] = [0, 1, 2, 3];
      const OT = this.OT;
      const I = f.local(I32);
      const NA = f.local(this.ref(this.hentArrT));
      $.put(I, $.call(this.hdrFindFn(), $.l(O), $.l(K)));
      $.if($.ge($.l(I), $.i(0)), () => {
        const e = $.aget(this.hentArrT, $.get(OT, O_HDRS, $.l(O)), $.l(I));
        $.set(this.hentT, E_NAME, e, $.l(N));
        $.set(this.hentT, E_VAL, e, $.l(V));
        $.ret();
      });
      $.if($.isNull($.get(OT, O_HDRS, $.l(O))), () => $.set(OT, O_HDRS, $.l(O), $.anew(this.hentArrT, $.i(4))));
      const arr = $.get(OT, O_HDRS, $.l(O));
      const n = $.get(OT, O_HDRS_N, $.l(O));
      $.if($.geU(n, $.alen(arr)), () => {
        $.put(NA, $.anew(this.hentArrT, $.shl($.alen(arr), $.i(1))));
        $.do($.l(NA), $.i(0), arr, $.i(0), n);
        f.c.arrayCopy(this.hentArrT, this.hentArrT);
        $.set(OT, O_HDRS, $.l(O), $.l(NA));
      });
      $.aset(this.hentArrT, arr, n, $.new_(this.hentT, $.l(K), $.l(N), $.l(V)));
      $.set(OT, O_HDRS_N, $.l(O), $.add(n, $.i(1)));
    });
  }

  /** OutgoingMessage.prototype.setHeader(name, value) */
  setHeaderFn(): number {
    return this.fn("setHeader", [this.outRef(), this.strRef, this.ref(this.hvT)], [], (f, $) => {
      const [O, N, V] = [0, 1, 2];
      $.if($.notNull($.get(this.OT, O_HEADER, $.l(O))), () => {
        this.throwHeadersSent($, "set");
        $.ret();
      });
      $.if($.not($.call(this.validateHeaderNameFn(), $.l(N))), () => $.ret());
      $.if($.not($.call(this.validateHeaderValueFn(), $.l(N), $.l(V))), () => $.ret());
      $.run(this.hdrPutFn(), $.l(O), $.call(this.deps.toLowerCase(), $.l(N)), $.l(N), $.l(V));
    });
  }

  /** OutgoingMessage.prototype.appendHeader(name, value) */
  appendHeaderFn(): number {
    return this.fn("appendHeader", [this.outRef(), this.strRef, this.ref(this.hvT)], [], (f, $) => {
      const [O, N, V] = [0, 1, 2];
      const I = f.local(I32);
      const E = f.local(this.ref(this.hentT));
      const CUR = f.local(this.ref(this.hvT));
      const ARR = f.local(this.ref(this.hvArrT));
      const J = f.local(I32);
      const HT = this.hvT;
      $.if($.notNull($.get(this.OT, O_HEADER, $.l(O))), () => {
        this.throwHeadersSent($, "append");
        $.ret();
      });
      $.if($.not($.call(this.validateHeaderNameFn(), $.l(N))), () => $.ret());
      $.if($.not($.call(this.validateHeaderValueFn(), $.l(N), $.l(V))), () => $.ret());
      $.put(I, $.call(this.hdrFindFn(), $.l(O), $.call(this.deps.toLowerCase(), $.l(N))));
      $.if($.lt($.l(I), $.i(0)), () => {
        $.run(this.setHeaderFn(), $.l(O), $.l(N), $.l(V));
        $.ret();
      });
      $.put(E, $.aget(this.hentArrT, $.get(this.OT, O_HDRS, $.l(O)), $.l(I)));
      $.put(CUR, $.get(this.hentT, E_VAL, $.l(E)));
      $.if($.ne($.get(HT, V_KIND, $.l(CUR)), $.i(2)), () => {
        $.put(ARR, $.anew(this.hvArrT, $.i(4)));
        $.aset(this.hvArrT, $.l(ARR), $.i(0), $.l(CUR));
        $.put(CUR, $.new_(HT, $.i(2), $.nul(this.strT), $.d(0), $.l(ARR), $.i(1)));
        $.set(this.hentT, E_VAL, $.l(E), $.l(CUR));
      });
      const push = (v: X): void => {
        $.put(ARR, $.cast(this.hvArrT, $.get(HT, V_ARR, $.l(CUR))));
        $.if($.geU($.get(HT, V_ARR_N, $.l(CUR)), $.alen($.l(ARR))), () => {
          const NA = $.local(this.ref(this.hvArrT));
          $.put(NA, $.anew(this.hvArrT, $.shl($.alen($.l(ARR)), $.i(1))));
          $.do($.l(NA), $.i(0), $.l(ARR), $.i(0), $.get(HT, V_ARR_N, $.l(CUR)));
          f.c.arrayCopy(this.hvArrT, this.hvArrT);
          $.set(HT, V_ARR, $.l(CUR), $.l(NA));
          $.put(ARR, $.l(NA));
        });
        $.aset(this.hvArrT, $.l(ARR), $.get(HT, V_ARR_N, $.l(CUR)), v);
        $.inc(HT, V_ARR_N, $.l(CUR));
      };
      $.if($.eq($.get(HT, V_KIND, $.l(V)), $.i(2)), () => {
        $.for(J, $.i(0), $.get(HT, V_ARR_N, $.l(V)), () => push($.aget(this.hvArrT, $.cast(this.hvArrT, $.get(HT, V_ARR, $.l(V))), $.l(J))));
      }, () => push($.l(V)));
    });
  }

  /** getHeader(name) -> the value, or null (undefined). */
  getHeaderFn(): number {
    return this.fn("getHeader", [this.outRef(), this.strRef], [this.ref(this.hvT)], (f, $) => {
      const I = f.local(I32);
      $.put(I, $.call(this.hdrFindFn(), $.l(0), $.call(this.deps.toLowerCase(), $.l(1))));
      $.if($.lt($.l(I), $.i(0)), () => $.ret($.nul(this.hvT)));
      $.do($.get(this.hentT, E_VAL, $.aget(this.hentArrT, $.get(this.OT, O_HDRS, $.l(0)), $.l(I))));
    });
  }

  hasHeaderFn(): number {
    return this.fn("hasHeader", [this.outRef(), this.strRef], [I32], (f, $) => {
      $.do($.ge($.call(this.hdrFindFn(), $.l(0), $.call(this.deps.toLowerCase(), $.l(1))), $.i(0)));
    });
  }

  /** removeHeader(name) */
  removeHeaderFn(): number {
    return this.fn("removeHeader", [this.outRef(), this.strRef], [], (f, $) => {
      const [O, N] = [0, 1];
      const K = f.local(this.strRef);
      const I = f.local(I32);
      const OT = this.OT;
      $.if($.notNull($.get(OT, O_HEADER, $.l(O))), () => {
        this.throwHeadersSent($, "remove");
        $.ret();
      });
      $.put(K, $.call(this.deps.toLowerCase(), $.l(N)));
      $.if(this.streq($, $.l(K), this.lit($, "connection")), () => $.set(OT, O_RMCONN, $.l(O), $.i(1)));
      $.if(this.streq($, $.l(K), this.lit($, "content-length")), () => $.set(OT, O_RMCLEN, $.l(O), $.i(1)));
      $.if(this.streq($, $.l(K), this.lit($, "transfer-encoding")), () => $.set(OT, O_RMTE, $.l(O), $.i(1)));
      $.if(this.streq($, $.l(K), this.lit($, "date")), () => $.set(OT, O_SENDDATE, $.l(O), $.i(0)));
      $.put(I, $.call(this.hdrFindFn(), $.l(O), $.l(K)));
      $.if($.ge($.l(I), $.i(0)), () => {
        const arr = $.get(OT, O_HDRS, $.l(O));
        const n = $.get(OT, O_HDRS_N, $.l(O));
        $.do(arr, $.l(I), arr, $.add($.l(I), $.i(1)), $.sub($.sub(n, $.l(I)), $.i(1)));
        f.c.arrayCopy(this.hentArrT, this.hentArrT);
        $.set(OT, O_HDRS_N, $.l(O), $.sub(n, $.i(1)));
        $.aset(this.hentArrT, arr, $.get(OT, O_HDRS_N, $.l(O)), $.nul(this.hentT));
      });
    });
  }

  /** cork() */
  outCorkFn(): number {
    return this.fn("outCork", [this.outRef()], [], (f, $) => {
      $.inc(this.OT, O_CORKED, $.l(0));
      $.if($.notNull($.get(this.OT, O_SOCKET, $.l(0))), () => $.run(this.net.corkHelper(), $.get(this.OT, O_SOCKET, $.l(0))));
    });
  }

  /** uncork() — a corked chunked body goes out as one chunk. */
  outUncorkFn(): number {
    return this.fn("outUncork", [this.outRef()], [], (f, $) => {
      const O = 0;
      const OT = this.OT;
      const N = f.local(I32);
      const LEN = f.local(I32);
      const BUF = f.local(this.ref(this.odArrT));
      const I = f.local(I32);
      const E = f.local(this.ref(this.odT));
      const CBS = f.local(this.ref(this.odArrT));
      $.set(OT, O_CORKED, $.l(O), $.sub($.get(OT, O_CORKED, $.l(O)), $.i(1)));
      $.if($.notNull($.get(OT, O_SOCKET, $.l(O))), () => $.run(this.net.uncorkHelper(), $.get(OT, O_SOCKET, $.l(O))));
      $.if($.or($.ne($.get(OT, O_CORKED, $.l(O)), $.i(0)), $.eq($.get(OT, O_CB_N, $.l(O)), $.i(0))), () => $.ret());
      $.put(LEN, $.get(OT, O_CBLEN, $.l(O)));
      $.put(BUF, $.get(OT, O_CB, $.l(O)));
      $.put(N, $.get(OT, O_CB_N, $.l(O)));
      $.drop(this.send($, $.l(O), $.call(this.hexFn(), $.l(LEN)), $.nul(this.deps.bytesType()), $.i(ENC_LATIN1), $.nul(this.deps.errClos().clos)));
      $.drop(this.send($, $.l(O), $.nul(this.strT), this.crlf($), $.i(ENC_NONE), $.nul(this.deps.errClos().clos)));
      $.put(CBS, $.l(BUF));
      $.for(I, $.i(0), $.l(N), () => {
        $.put(E, $.aget(this.odArrT, $.l(BUF), $.l(I)));
        $.drop(this.send($, $.l(O), $.get(this.odT, D_STR, $.l(E)), $.get(this.odT, D_BYTES, $.l(E)), $.get(this.odT, D_ENC, $.l(E)), $.nul(this.deps.errClos().clos)));
      });
      // Every buffered write carried a callback (write_'s nop at least).
      $.drop(this.send($, $.l(O), $.nul(this.strT), this.crlf($), $.i(ENC_NONE), $.cast(this.deps.errClos().clos, this.clos($, this.multiCbFn(), "err", { a: $.l(CBS), n: $.l(N) }))));
      $.set(OT, O_CB, $.l(O), $.nul(this.odArrT));
      $.set(OT, O_CB_N, $.l(O), $.i(0));
      $.set(OT, O_CBLEN, $.l(O), $.i(0));
    });
  }

  /** (err) => { for (const callback of callbacks) callback(err); } */
  private multiCbFn(): number {
    return this.closFn("multiCb", "err", ($, e, f, arg) => {
      const I = f.local(I32);
      const ARR = f.local(this.ref(this.odArrT));
      $.put(ARR, $.cast(this.odArrT, $.l(e.a)));
      $.for(I, $.i(0), $.l(e.n), () => {
        this.callEcb($, $.get(this.odT, D_CB, $.aget(this.odArrT, $.l(ARR), $.l(I))), $.l(arg));
        this.excReturn($);
      });
    });
  }

  /** crlf_buf: Buffer.from('\r\n') (a fresh view of the shared bytes). */
  private crlf($: A): X {
    return $.call(this.deps.strToBytes("utf8"), this.lit($, "\r\n"));
  }

  /** OutgoingMessage.prototype.destroy(error) */
  outDestroyFn(): number {
    return this.fn("outDestroy", [this.outRef(), this.errRef], [], (f, $) => {
      const [O, ERR] = [0, 1];
      const OT = this.OT;
      $.if($.get(OT, O_DESTROYED, $.l(O)), () => $.ret());
      $.set(OT, O_DESTROYED, $.l(O), $.i(1));
      $.set(OT, O_ERRORED, $.l(O), $.l(ERR));
      $.if($.notNull($.get(OT, O_SOCKET, $.l(O))), () => $.run(this.net.destroyHelper(), $.get(OT, O_SOCKET, $.l(O)), $.l(ERR)), () =>
        this.nextTick($, this.tick("emitDestroyNT", ($2, e) => {
          const o = $2.cast(this.OT, $2.l(e.a));
          $2.if($2.not($2.get(this.OT, O_CLOSED, o)), () => {
            $2.set(this.OT, O_CLOSED, o, $2.i(1));
            this.emit($2, HL.OUT_CLOSE, o);
          });
        }), { a: $.l(O) }),
      );
    });
  }

  /** _send(data, encoding, callback) -> write's boolean. */
  private send($: A, o: X, s: X, b: X, enc: X, cb: X): X {
    return $.call(this.outSendFn(), o, s, b, enc, cb);
  }

  private outSendFn(): number {
    return this.fn("_send", [this.outRef(), this.strRef, this.bytesRef, I32, this.eclosRef], [I32], (f, $) => {
      const [O, S, B, ENC, CB] = [0, 1, 2, 3, 4];
      const OT = this.OT;
      const H = f.local(this.strRef);
      $.if($.both($.not($.get(OT, O_HEADERSENT, $.l(O))), $.notNull($.get(OT, O_HEADER, $.l(O)))), () => {
        $.put(H, $.get(OT, O_HEADER, $.l(O)));
        $.if(
          $.andThen($.notNull($.l(S)), $.or($.or($.eq($.l(ENC), $.i(ENC_UTF8)), $.eq($.l(ENC), $.i(ENC_LATIN1))), $.eq($.l(ENC), $.i(ENC_NONE)))),
          () => $.put(S, this.cat($, $.l(H), $.l(S))),
          () => {
            $.run(this.odUnshiftFn(), $.l(O), $.new_(this.odT, $.l(H), $.nul(this.deps.bytesType()), $.i(ENC_LATIN1), $.nul(this.deps.errClos().clos)));
            $.set(OT, O_OUTSIZE, $.l(O), $.add($.get(OT, O_OUTSIZE, $.l(O)), $.alen($.l(H))));
            $.run(this.onPendingDataFn(), $.l(O), $.alen($.l(H)));
            this.excReturn($, $.i(0));
          },
        );
        $.set(OT, O_HEADERSENT, $.l(O), $.i(1));
      });
      $.do($.call(this.outWriteRawFn(), $.l(O), $.l(S), $.l(B), $.l(ENC), $.l(CB)));
    });
  }

  /** this._onPendingData(delta): the server's updateOutgoingData; a nop on
   * a ClientRequest. */
  private onPendingDataFn(): number {
    return this.fn("onPendingData", [this.outRef(), I32], [], (f, $) => {
      const [O, DELTA] = [0, 1];
      const K = f.local(this.ref(this.connT()));
      $.if($.not($.test(this.resT(), $.l(O))), () => $.ret());
      $.put(K, $.get(this.resT(), R_CONN, $.cast(this.resT(), $.l(O))));
      $.if($.isNull($.l(K)), () => $.ret());
      $.run(this.updateOutgoingDataFn(), $.l(K), $.l(DELTA));
    });
  }

  private odPushFn(field: number, nfield: number, name: string): number {
    return this.fn(name, [this.outRef(), this.ref(this.odT)], [], (f, $) => {
      const [O, E] = [0, 1];
      const OT = this.OT;
      const NA = f.local(this.ref(this.odArrT));
      $.if($.isNull($.get(OT, field, $.l(O))), () => $.set(OT, field, $.l(O), $.anew(this.odArrT, $.i(4))));
      const arr = $.get(OT, field, $.l(O));
      const n = $.get(OT, nfield, $.l(O));
      $.if($.geU(n, $.alen(arr)), () => {
        $.put(NA, $.anew(this.odArrT, $.shl($.alen(arr), $.i(1))));
        $.do($.l(NA), $.i(0), arr, $.i(0), n);
        f.c.arrayCopy(this.odArrT, this.odArrT);
        $.set(OT, field, $.l(O), $.l(NA));
      });
      $.aset(this.odArrT, arr, n, $.l(E));
      $.set(OT, nfield, $.l(O), $.add(n, $.i(1)));
    });
  }

  private odUnshiftFn(): number {
    return this.fn("odUnshift", [this.outRef(), this.ref(this.odT)], [], (f, $) => {
      const [O, E] = [0, 1];
      const OT = this.OT;
      $.run(this.odPushFn(O_OD, O_OD_N, "odPush"), $.l(O), $.l(E));
      const arr = $.get(OT, O_OD, $.l(O));
      $.do(arr, $.i(1), arr, $.i(0), $.sub($.get(OT, O_OD_N, $.l(O)), $.i(1)));
      f.c.arrayCopy(this.odArrT, this.odArrT);
      $.aset(this.odArrT, arr, $.i(0), $.l(E));
    });
  }

  /** conn.write(data, encoding, callback) -> write's boolean. */
  private sockWrite($: A, sock: X, s: X, b: X, enc: X, cb: X): X {
    return $.call(this.sockWriteDataFn(), sock, s, b, enc, cb);
  }

  private sockWriteDataFn(): number {
    return this.fn("sockWriteData", [this.sockRef, this.strRef, this.bytesRef, I32, this.eclosRef], [I32], (f, $) => {
      const [S, STR, B, ENC, CB] = [0, 1, 2, 3, 4];
      $.if($.notNull($.l(STR)), () =>
        $.ret($.call(this.net.sockWriteHelper(), $.l(S), $.call(this.encodeFn(), $.l(STR), $.l(ENC)), $.alen($.l(STR)), $.l(CB))),
      );
      $.do($.call(this.net.sockWriteHelper(), $.l(S), $.l(B), $.get(this.deps.bytesType(), 2, $.l(B)), $.l(CB)));
    });
  }

  /** _writeRaw(data, encoding, callback) */
  private outWriteRawFn(): number {
    return this.fn("_writeRaw", [this.outRef(), this.strRef, this.bytesRef, I32, this.eclosRef], [I32], (f, $) => {
      const [O, S, B, ENC, CB] = [0, 1, 2, 3, 4];
      const OT = this.OT;
      const CONN = f.local(this.sockRef);
      const LEN = f.local(I32);
      $.put(CONN, $.get(OT, O_SOCKET, $.l(O)));
      $.if($.andThen($.notNull($.l(CONN)), $.call(this.net.destroyedHelper(), $.l(CONN))), () => $.ret($.i(0)));
      $.if(
        $.andThen(
          $.notNull($.l(CONN)),
          $.both($.refEq($.get(this.sockT, NET_SOCK_HTTP.S_HTTPMSG, $.l(CONN)), $.l(O)), $.call(this.net.writableGetterHelper(), $.l(CONN))),
        ),
        () => {
          $.if($.gt($.get(OT, O_OD_N, $.l(O)), $.i(0)), () => {
            $.drop($.call(this.outFlushOutputFn(), $.l(O), $.l(CONN)));
            this.excReturn($, $.i(0));
          });
          $.ret(this.sockWrite($, $.l(CONN), $.l(S), $.l(B), $.l(ENC), $.l(CB)));
        },
      );
      $.run(this.odPushFn(O_OD, O_OD_N, "odPush"), $.l(O), $.new_(this.odT, $.l(S), $.l(B), $.l(ENC), $.l(CB)));
      $.put(LEN, $.sel(I32, $.notNull($.l(S)), $.alen($.l(S)), $.get(this.deps.bytesType(), 2, $.l(B))));
      $.set(OT, O_OUTSIZE, $.l(O), $.add($.get(OT, O_OUTSIZE, $.l(O)), $.l(LEN)));
      $.run(this.onPendingDataFn(), $.l(O), $.l(LEN));
      $.do($.lt($.get(OT, O_OUTSIZE, $.l(O)), $.get(OT, O_HWM, $.l(O))));
    });
  }

  /** _flushOutput(socket) */
  outFlushOutputFn(): number {
    return this.fn("_flushOutput", [this.outRef(), this.sockRef], [I32], (f, $) => {
      const [O, S] = [0, 1];
      const OT = this.OT;
      const N = f.local(I32);
      const I = f.local(I32);
      const ARR = f.local(this.ref(this.odArrT));
      const E = f.local(this.ref(this.odT));
      const RET = f.local(I32);
      $.put(N, $.get(OT, O_OD_N, $.l(O)));
      $.if($.le($.l(N), $.i(0)), () => $.ret($.i(0)));
      $.put(ARR, $.get(OT, O_OD, $.l(O)));
      $.run(this.net.corkHelper(), $.l(S));
      $.for(I, $.i(0), $.l(N), () => {
        $.put(E, $.aget(this.odArrT, $.l(ARR), $.l(I)));
        $.put(RET, this.sockWrite($, $.l(S), $.get(this.odT, D_STR, $.l(E)), $.get(this.odT, D_BYTES, $.l(E)), $.get(this.odT, D_ENC, $.l(E)), $.get(this.odT, D_CB, $.l(E))));
        this.excReturn($, $.i(0));
      });
      $.run(this.net.uncorkHelper(), $.l(S));
      $.set(OT, O_OD, $.l(O), $.nul(this.odArrT));
      $.set(OT, O_OD_N, $.l(O), $.i(0));
      $.run(this.onPendingDataFn(), $.l(O), $.sub($.i(0), $.get(OT, O_OUTSIZE, $.l(O))));
      $.set(OT, O_OUTSIZE, $.l(O), $.i(0));
      $.do($.l(RET));
    });
  }

  /** _flush() */
  outFlushFn(): number {
    return this.fn("_flush", [this.outRef()], [], (f, $) => {
      const O = 0;
      const OT = this.OT;
      const S = f.local(this.sockRef);
      $.put(S, $.get(OT, O_SOCKET, $.l(O)));
      $.if($.andThen($.notNull($.l(S)), $.call(this.net.writableGetterHelper(), $.l(S))), () => {
        $.drop($.call(this.outFlushOutputFn(), $.l(O), $.l(S)));
        this.excReturn($);
        $.if($.get(OT, O_FINISHED, $.l(O)), () => $.run(this.outFinishFn(), $.l(O)), () => {
          $.if($.both($.get(OT, O_NEEDDRAIN, $.l(O)), $.eq($.call(this.outWritableLengthFn(), $.l(O)), $.i(0))), () => {
            $.set(OT, O_NEEDDRAIN, $.l(O), $.i(0));
            this.emit($, HL.OUT_DRAIN, $.l(O));
          });
        });
      });
    });
  }

  /** writableLength */
  outWritableLengthFn(): number {
    return this.fn("outWritableLength", [this.outRef()], [I32], (f, $) => {
      const OT = this.OT;
      const S = $.get(OT, O_SOCKET, $.l(0));
      $.do($.add($.add($.get(OT, O_OUTSIZE, $.l(0)), $.get(OT, O_CBLEN, $.l(0))), $.sel(I32, $.notNull(S), $.call(this.net.wlenHelper(), S), $.i(0))));
    });
  }

  /** writableFinished */
  outWritableFinishedFn(): number {
    return this.fn("outWritableFinished", [this.outRef()], [I32], (f, $) => {
      const OT = this.OT;
      const S = $.get(OT, O_SOCKET, $.l(0));
      $.do(
        $.andThen(
          $.both($.get(OT, O_FINISHED, $.l(0)), $.eq($.get(OT, O_OUTSIZE, $.l(0)), $.i(0))),
          $.orElse($.isNull(S), $.eq($.call(this.net.wlenHelper(), S), $.i(0))),
        ),
      );
    });
  }

  /** writableNeedDrain */
  outNeedDrainGetterFn(): number {
    return this.fn("outWritableNeedDrain", [this.outRef()], [I32], (f, $) => {
      const OT = this.OT;
      $.do($.both($.both($.not($.get(OT, O_DESTROYED, $.l(0))), $.not($.get(OT, O_FINISHED, $.l(0)))), $.get(OT, O_NEEDDRAIN, $.l(0))));
    });
  }

  /** utcDate(): the cached toUTCString, cleared by an unref'd timer at the
   * next second. */
  private utcDateFn(): number {
    return this.fn("utcDate", [], [this.strRef], (f, $) => {
      const g = this.g();
      const NOW = f.local(F64);
      $.if($.isNull($.g(g.utc)), () => {
        $.put(NOW, $.raw((c) => {
          c.call(this.deps.wallClock());
          c.f64Floor();
        }));
        $.gput(g.utc, $.call(this.utcStringFn(), $.l(NOW)));
        // setUnrefTimeout(resetCache, 1000 - d.getMilliseconds())
        $.drop($.call(
          this.deps.unrefTimer(),
          $.call(
            this.deps.setTimeoutHandle(),
            $.cast(this.deps.voidClos().clos, this.clos($, this.tick("resetCache", ($2) => $2.gput(g.utc, $2.nul(this.strT))), "void", {})),
            $.dsub($.d(1000), $.raw((c) => {
              // getMilliseconds(): the ms field of the (integral) time value.
              c.localGet(NOW);
              c.localGet(NOW);
              c.f64Const(1000);
              c.f64Div();
              c.f64Floor();
              c.f64Const(1000);
              c.f64Mul();
              c.f64Sub();
            })),
          ),
        ));
      });
      $.do($.g(g.utc));
    });
  }

  /** `(f64 ms) -> string` — Date.prototype.toUTCString for a time value
   * of this era ("Wed, 21 Oct 2026 12:34:56 GMT"). */
  private utcStringFn(): number {
    return this.fn("utcString", [F64], [this.strRef], (f, $) => {
      const T = 0;
      const DAYS = f.local(I32);
      const MS = f.local(I32);
      const Z = f.local(I32);
      const ERA = f.local(I32);
      const DOE = f.local(I32);
      const YOE = f.local(I32);
      const Y = f.local(I32);
      const DOY = f.local(I32);
      const MP = f.local(I32);
      const D = f.local(I32);
      const M = f.local(I32);
      const WD = f.local(I32);
      const two = (v: X): X => $.raw(() => {
        // a two-digit, zero-padded number
        this.cat($, $.sel(this.strRef, $.lt(v, $.i(10)), this.lit($, "0"), this.lit($, "")), this.num2str($, $.i2d(v)))();
      });
      $.put(DAYS, $.raw((c) => {
        c.localGet(T);
        c.f64Const(86400000);
        c.f64Div();
        c.f64Floor();
        c.i32TruncF64S();
      }));
      $.put(MS, $.raw((c) => {
        c.localGet(T);
        c.localGet(DAYS);
        c.f64ConvertI32S();
        c.f64Const(86400000);
        c.f64Mul();
        c.f64Sub();
        c.i32TruncF64S();
      }));
      // civil_from_days (Howard Hinnant), days >= 0 here.
      $.put(Z, $.add($.l(DAYS), $.i(719468)));
      $.put(ERA, $.raw((c) => {
        c.localGet(Z);
        c.i32Const(146097);
        c.i32DivS();
      }));
      $.put(DOE, $.sub($.l(Z), $.mul($.l(ERA), $.i(146097))));
      $.put(YOE, $.raw((c) => {
        // (doe - doe/1460 + doe/36524 - doe/146096) / 365
        c.localGet(DOE);
        c.localGet(DOE);
        c.i32Const(1460);
        c.i32DivS();
        c.i32Sub();
        c.localGet(DOE);
        c.i32Const(36524);
        c.i32DivS();
        c.i32Add();
        c.localGet(DOE);
        c.i32Const(146096);
        c.i32DivS();
        c.i32Sub();
        c.i32Const(365);
        c.i32DivS();
      }));
      $.put(Y, $.add($.l(YOE), $.mul($.l(ERA), $.i(400))));
      $.put(DOY, $.raw((c) => {
        // doe - (365*yoe + yoe/4 - yoe/100)
        c.localGet(DOE);
        c.localGet(YOE);
        c.i32Const(365);
        c.i32Mul();
        c.localGet(YOE);
        c.i32Const(4);
        c.i32DivS();
        c.i32Add();
        c.localGet(YOE);
        c.i32Const(100);
        c.i32DivS();
        c.i32Sub();
        c.i32Sub();
      }));
      $.put(MP, $.raw((c) => {
        c.localGet(DOY);
        c.i32Const(5);
        c.i32Mul();
        c.i32Const(2);
        c.i32Add();
        c.i32Const(153);
        c.i32DivS();
      }));
      $.put(D, $.raw((c) => {
        // doy - (153*mp+2)/5 + 1
        c.localGet(DOY);
        c.localGet(MP);
        c.i32Const(153);
        c.i32Mul();
        c.i32Const(2);
        c.i32Add();
        c.i32Const(5);
        c.i32DivS();
        c.i32Sub();
        c.i32Const(1);
        c.i32Add();
      }));
      $.put(M, $.sel(I32, $.lt($.l(MP), $.i(10)), $.add($.l(MP), $.i(3)), $.sub($.l(MP), $.i(9))));
      $.if($.le($.l(M), $.i(2)), () => $.put(Y, $.add($.l(Y), $.i(1))));
      $.put(WD, $.raw((c) => {
        // (days + 4) mod 7, 1970-01-01 a Thursday
        c.localGet(DAYS);
        c.i32Const(4);
        c.i32Add();
        c.i32Const(7);
        c.i32RemS();
      }));
      const pick = (v: number, names: string[], base: number): X => () => {
        const S = $.local(this.strRef);
        names.forEach((n, i) => $.if($.eq($.l(v), $.i(i + base)), () => $.put(S, this.lit($, n))));
        $.c.localGet(S);
      };
      const hh = $.raw((c) => {
        c.localGet(MS);
        c.i32Const(3600000);
        c.i32DivS();
      });
      const mm = $.raw((c) => {
        c.localGet(MS);
        c.i32Const(60000);
        c.i32DivS();
        c.i32Const(60);
        c.i32RemS();
      });
      const ss = $.raw((c) => {
        c.localGet(MS);
        c.i32Const(1000);
        c.i32DivS();
        c.i32Const(60);
        c.i32RemS();
      });
      $.do(
        this.cat(
          $,
          pick(WD, ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], 0),
          this.lit($, ", "),
          two($.l(D)),
          this.lit($, " "),
          pick(M, ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"], 1),
          this.lit($, " "),
          this.num2str($, $.i2d($.l(Y))),
          this.lit($, " "),
          two(hh),
          this.lit($, ":"),
          two(mm),
          this.lit($, ":"),
          two(ss),
          this.lit($, " GMT"),
        ),
      );
    });
  }

  /** `(value, word) -> i32`: /(?:^|\W)word(?:$|\W)/i over String(value). */
  private wordMatchFn(): number {
    return this.fn("wordMatch", [this.strRef, this.strRef], [I32], (f, $) => {
      const [S, W] = [0, 1];
      const I = f.local(I32);
      const J = f.local(I32);
      const CH = f.local(I32);
      const OK = f.local(I32);
      const isWord = (ch: X): X => $.or($.or($.both($.ge(ch, $.i(48)), $.le(ch, $.i(57))), $.both($.ge(ch, $.i(65)), $.le(ch, $.i(90)))), $.or($.both($.ge(ch, $.i(97)), $.le(ch, $.i(122))), $.eq(ch, $.i(95))));
      $.for(I, $.i(0), $.add($.sub($.alen($.l(S)), $.alen($.l(W))), $.i(1)), () => {
        $.put(OK, $.i(1));
        // (?:^|\W) before
        $.if($.gt($.l(I), $.i(0)), () => {
          $.if(isWord($.agetU(this.strT, $.l(S), $.sub($.l(I), $.i(1)))), () => $.put(OK, $.i(0)));
        });
        $.for(J, $.i(0), $.alen($.l(W)), () => {
          $.put(CH, $.agetU(this.strT, $.l(S), $.add($.l(I), $.l(J))));
          $.if($.both($.ge($.l(CH), $.i(65)), $.le($.l(CH), $.i(90))), () => $.put(CH, $.or($.l(CH), $.i(32))));
          $.if($.ne($.l(CH), $.agetU(this.strT, $.l(W), $.l(J))), () => $.put(OK, $.i(0)));
        });
        // (?:$|\W) after
        $.if($.lt($.add($.l(I), $.alen($.l(W))), $.alen($.l(S))), () => {
          $.if(isWord($.agetU(this.strT, $.l(S), $.add($.l(I), $.alen($.l(W))))), () => $.put(OK, $.i(0)));
        });
        $.if($.l(OK), () => $.ret($.i(1)));
      });
      $.do($.i(0));
    });
  }

  /** _storeHeader(firstLine, headers): `list` (n entries) is kOutHeaders
   * (validate 0) or the caller's own headers (validate 1); null = none. */
  storeHeaderFn(): number {
    return this.fn("_storeHeader", [this.outRef(), this.strRef, this.ref(this.hentArrT), I32, I32], [], (f, $) => {
      const [O, FIRST, LIST, N, VALIDATE] = [0, 1, 2, 3, 4];
      const OT = this.OT;
      const HT = this.hvT;
      const st = {
        connection: f.local(I32),
        contLen: f.local(I32),
        te: f.local(I32),
        date: f.local(I32),
        expect: f.local(I32),
        trailer: f.local(I32),
      };
      const HDR = f.local(this.strRef);
      const I = f.local(I32);
      const J = f.local(I32);
      const E = f.local(this.ref(this.hentT));
      const KEY = f.local(this.strRef);
      const V = f.local(this.ref(HT));
      const VS = f.local(this.strRef);
      const LK = f.local(this.strRef);
      const SHOULD = f.local(I32);
      const o = $.l(O);
      $.put(HDR, $.l(FIRST));
      /** storeHeader(self, state, key, value, validate) + matchHeader */
      const storeOne = (key: X, value: X): void => {
        $.if($.l(VALIDATE), () => {
          $.if($.not($.call(this.validateHeaderValueFn(), key, value)), () => $.ret());
        });
        $.put(VS, $.call(this.hvToStrFn(), value));
        $.put(HDR, this.cat($, $.l(HDR), key, this.lit($, ": "), $.l(VS), this.lit($, "\r\n")));
        // matchHeader
        $.if($.both($.ge($.alen(key), $.i(4)), $.le($.alen(key), $.i(17))), () => {
          $.put(LK, $.call(this.deps.toLowerCase(), key));
          $.if(this.streq($, $.l(LK), this.lit($, "connection")), () => {
            $.put(st.connection, $.i(1));
            $.set(OT, O_RMCONN, o, $.i(0));
            $.if($.call(this.wordMatchFn(), $.l(VS), this.lit($, "close")), () => $.set(OT, O_LAST, o, $.i(1)), () => $.set(OT, O_KEEPALIVE, o, $.i(1)));
          });
          $.if(this.streq($, $.l(LK), this.lit($, "transfer-encoding")), () => {
            $.put(st.te, $.i(1));
            $.set(OT, O_RMTE, o, $.i(0));
            $.if($.call(this.wordMatchFn(), $.l(VS), this.lit($, "chunked")), () => $.set(OT, O_CHUNKED, o, $.i(1)));
          });
          $.if(this.streq($, $.l(LK), this.lit($, "content-length")), () => {
            $.put(st.contLen, $.i(1));
            $.set(OT, O_CONTLEN, o, $.sel(F64, $.eq($.get(HT, V_KIND, value), $.i(1)), $.get(HT, V_NUM, value), $.call(this.deps.strToNumber(), $.l(VS))));
            $.set(OT, O_HASCONTLEN, o, $.i(1));
            $.set(OT, O_RMCLEN, o, $.i(0));
          });
          $.if(this.streq($, $.l(LK), this.lit($, "date")), () => $.put(st.date, $.i(1)));
          $.if(this.streq($, $.l(LK), this.lit($, "expect")), () => $.put(st.expect, $.i(1)));
          $.if(this.streq($, $.l(LK), this.lit($, "trailer")), () => $.put(st.trailer, $.i(1)));
          $.if(this.streq($, $.l(LK), this.lit($, "keep-alive")), () => $.set(OT, O_DEFKEEPALIVE, o, $.i(0)));
        });
      };
      $.if($.notNull($.l(LIST)), () => {
        $.for(I, $.i(0), $.l(N), () => {
          $.put(E, $.aget(this.hentArrT, $.l(LIST), $.l(I)));
          $.put(KEY, $.get(this.hentT, E_NAME, $.l(E)));
          $.put(V, $.get(this.hentT, E_VAL, $.l(E)));
          // processHeader
          $.if($.l(VALIDATE), () => {
            $.if($.not($.call(this.validateHeaderNameFn(), $.l(KEY))), () => $.ret());
          });
          // content-disposition with a content length: a latin1 Buffer
          // stringified as utf8.
          $.if(
            $.andThen(
              $.andThen($.eq($.alen($.l(KEY)), $.i(19)), this.streq($, $.call(this.deps.toLowerCase(), $.l(KEY)), this.lit($, "content-disposition"))),
              $.andThen($.get(OT, O_HASCONTLEN, o), $.dne($.get(OT, O_CONTLEN, o), $.d(0))),
            ),
            () => {
              $.if($.eq($.get(HT, V_KIND, $.l(V)), $.i(0)), () => {
                $.put(V, this.hvStrNew($, $.call(this.deps.utf8Decode(), $.call(this.encodeFn(), $.get(HT, V_STR, $.l(V)), $.i(ENC_LATIN1)))));
              });
            },
          );
          $.if($.eq($.get(HT, V_KIND, $.l(V)), $.i(2)), () => {
            // (value.length < 2 || !isCookieField(key)): one line each.
            $.if(
              $.orElse(
                $.lt($.get(HT, V_ARR_N, $.l(V)), $.i(2)),
                $.not($.andThen($.eq($.alen($.l(KEY)), $.i(6)), this.streq($, $.call(this.deps.toLowerCase(), $.l(KEY)), this.lit($, "cookie")))),
              ),
              () => {
                $.for(J, $.i(0), $.get(HT, V_ARR_N, $.l(V)), () => {
                  storeOne($.l(KEY), $.aget(this.hvArrT, $.cast(this.hvArrT, $.get(HT, V_ARR, $.l(V))), $.l(J)));
                });
              },
              () => {
                // value.join('; ')
                $.put(VS, this.lit($, ""));
                $.for(J, $.i(0), $.get(HT, V_ARR_N, $.l(V)), () => {
                  $.if($.gt($.l(J), $.i(0)), () => $.put(VS, this.cat($, $.l(VS), this.lit($, "; "))));
                  $.put(VS, this.cat($, $.l(VS), $.call(this.hvToStrFn(), $.aget(this.hvArrT, $.cast(this.hvArrT, $.get(HT, V_ARR, $.l(V))), $.l(J)))));
                });
                $.put(V, this.hvStrNew($, $.l(VS)));
                storeOne($.l(KEY), $.l(V));
              },
            );
          }, () => storeOne($.l(KEY), $.l(V)));
        });
      });
      $.if($.both($.get(OT, O_SENDDATE, o), $.not($.l(st.date))), () => {
        $.put(HDR, this.cat($, $.l(HDR), this.lit($, "Date: "), $.call(this.utcDateFn()), this.lit($, "\r\n")));
      });
      $.if($.andThen($.get(OT, O_CHUNKED, o), $.test(this.resT(), o)), () => {
        const sc = $.get(this.resT(), R_STATUS, $.cast(this.resT(), o));
        $.if($.or($.deq(sc, $.d(204)), $.deq(sc, $.d(304))), () => {
          $.set(OT, O_CHUNKED, o, $.i(0));
          $.set(OT, O_KEEPALIVE, o, $.i(0));
        });
      });
      $.if($.get(OT, O_RMCONN, o), () => $.set(OT, O_LAST, o, $.not($.get(OT, O_KEEPALIVE, o))), () => {
        $.if($.not($.l(st.connection)), () => {
          // shouldSendKeepAlive = shouldKeepAlive && (contLen || useChunkedEncodingByDefault || this.agent)
          $.put(SHOULD, $.both($.get(OT, O_KEEPALIVE, o), $.or($.or($.l(st.contLen), $.get(OT, O_CHUNKDEFAULT, o)), $.andThen($.test(this.creqT(), o), $.notNull($.get(this.creqT(), C_AGENT, $.cast(this.creqT(), o)))))));
          $.if($.both($.l(SHOULD), $.get(OT, O_MAXREQREACHED, o)), () => $.put(HDR, this.cat($, $.l(HDR), this.lit($, "Connection: close\r\n"))), () => {
            $.if($.l(SHOULD), () => {
              $.put(HDR, this.cat($, $.l(HDR), this.lit($, "Connection: keep-alive\r\n")));
              $.if($.both($.dne($.get(OT, O_KATIMEOUT, o), $.d(0)), $.get(OT, O_DEFKEEPALIVE, o)), () => {
                $.put(VS, this.lit($, ""));
                $.if($.dge($.get(OT, O_MAXREQPERSOCK, o), $.d(1)), () => $.put(VS, this.cat($, this.lit($, ", max="), this.num2str($, $.get(OT, O_MAXREQPERSOCK, o)))));
                $.put(HDR, this.cat($, $.l(HDR), this.lit($, "Keep-Alive: timeout="), this.num2str($, $.raw((c) => {
                  $.do($.get(OT, O_KATIMEOUT, o));
                  c.f64Const(1000);
                  c.f64Div();
                  c.f64Floor();
                })), $.l(VS), this.lit($, "\r\n")));
              });
            }, () => {
              $.set(OT, O_LAST, o, $.i(1));
              $.put(HDR, this.cat($, $.l(HDR), this.lit($, "Connection: close\r\n")));
            });
          });
        });
      });
      $.if($.both($.not($.l(st.contLen)), $.not($.l(st.te))), () => {
        $.if($.not($.get(OT, O_HASBODY, o)), () => $.set(OT, O_CHUNKED, o, $.i(0)), () => {
          $.if($.not($.get(OT, O_CHUNKDEFAULT, o)), () => $.set(OT, O_LAST, o, $.i(1)), () => {
            $.if($.both($.both($.not($.l(st.trailer)), $.not($.get(OT, O_RMCLEN, o))), $.get(OT, O_HASCONTLEN, o)), () => {
              $.put(HDR, this.cat($, $.l(HDR), this.lit($, "Content-Length: "), this.num2str($, $.get(OT, O_CONTLEN, o)), this.lit($, "\r\n")));
            }, () => {
              $.if($.not($.get(OT, O_RMTE, o)), () => {
                $.put(HDR, this.cat($, $.l(HDR), this.lit($, "Transfer-Encoding: chunked\r\n")));
                $.set(OT, O_CHUNKED, o, $.i(1));
              }, () => $.set(OT, O_LAST, o, $.i(1)));
            });
          });
        });
      });
      $.if($.both($.ne($.get(OT, O_CHUNKED, o), $.i(1)), $.l(st.trailer)), () => {
        this.throwErr($, "%Error", this.lit($, "Trailers are invalid with this transfer encoding"), "ERR_HTTP_TRAILER_INVALID");
        $.ret();
      });
      $.set(OT, O_HEADER, o, this.cat($, $.l(HDR), this.lit($, "\r\n")));
      $.set(OT, O_HEADERSENT, o, $.i(0));
      $.if($.l(st.expect), () => $.drop(this.send($, o, this.lit($, ""), $.nul(this.deps.bytesType()), $.i(ENC_NONE), $.nul(this.deps.errClos().clos))));
    });
  }

  /** _implicitHeader(): ServerResponse's writeHead(this.statusCode), or
   * ClientRequest's _storeHeader(method + ' ' + path + ' HTTP/1.1\r\n',
   * kOutHeaders). */
  private outImplicitHeaderFn(): number {
    return this.fn("_implicitHeader", [this.outRef()], [], (f, $) => {
      const O = 0;
      $.if($.test(this.resT(), $.l(O)), () => {
        const r = $.cast(this.resT(), $.l(O));
        $.run(this.writeHeadFn(), r, $.get(this.resT(), R_STATUS, r), $.nul(this.strT), $.i(0), $.nul(this.hentArrT), $.i(0));
        $.ret();
      });
      const q = $.cast(this.creqT(), $.l(O));
      $.if($.notNull($.get(this.OT, O_HEADER, $.l(O))), () => {
        this.throwHeadersSent($, "render");
        $.ret();
      });
      $.run(
        this.storeHeaderFn(),
        $.l(O),
        this.cat($, $.get(this.creqT(), C_METHOD, q), this.lit($, " "), $.get(this.creqT(), C_PATH, q), this.lit($, " HTTP/1.1\r\n")),
        $.get(this.OT, O_HDRS, $.l(O)),
        $.get(this.OT, O_HDRS_N, $.l(O)),
        $.i(0),
      );
    });
  }

  /** onError(msg, err, callback): nextTick(emitErrorNt). */
  private outOnError($: A, o: X, err: X, cb: X): void {
    $.run(this.outOnErrorFn(), o, err, cb);
  }

  private outOnErrorFn(): number {
    return this.fn("onError", [this.outRef(), this.errRef, this.eclosRef], [], (f, $) => {
      $.if($.get(this.OT, O_DESTROYED, $.l(0)), () => $.ret());
      this.nextTick($, this.tick("emitErrorNt", ($2, e) => {
        const m = $2.cast(this.OT, $2.l(e.a));
        this.callEcb($2, $2.cast(this.deps.errClos().clos, $2.l(e.c)), $2.cast(this.deps.errType(), $2.l(e.b)));
        this.excReturn($2);
        $2.if($2.not($2.get(this.OT, O_DESTROYED, m)), () => this.emit($2, HL.OUT_ERROR, m, $2.cast(this.deps.errType(), $2.l(e.b))));
      }), { a: $.l(0), b: $.l(1), c: $.l(2) });
    });
  }

  /** write_(msg, chunk, encoding, callback, fromEnd) -> boolean. The
   * chunk is a string or bytes (both null = `null`, the TypeError). */
  private writeImplFn(): number {
    return this.fn("write_", [this.outRef(), this.strRef, this.bytesRef, I32, this.eclosRef, I32], [I32], (f, $) => {
      const [O, S, B, ENC, CB0, FROMEND] = [0, 1, 2, 3, 4, 5];
      const OT = this.OT;
      const CB = f.local(this.eclosRef);
      const LEN = f.local(I32);
      const ERR = f.local(this.errRef);
      const RET = f.local(I32);
      const SOCK = f.local(this.sockRef);
      const o = $.l(O);
      $.put(CB, $.sel(this.eclosRef, $.isNull($.l(CB0)), this.nopClos($), $.l(CB0)));
      $.if($.both($.isNull($.l(S)), $.isNull($.l(B))), () => {
        this.throwErr($, "%TypeError", this.lit($, "May not write null values to stream"), "ERR_STREAM_NULL_VALUES");
        $.ret($.i(0));
      });
      $.if($.get(OT, O_FINISHED, o), () => $.put(ERR, this.err($, "%Error", this.lit($, "write after end"), "ERR_STREAM_WRITE_AFTER_END")), () => {
        $.if($.get(OT, O_DESTROYED, o), () => $.put(ERR, this.err($, "%Error", this.lit($, "Cannot call write after a stream was destroyed"), "ERR_STREAM_DESTROYED")));
      });
      $.if($.notNull($.l(ERR)), () => {
        $.if($.not($.get(OT, O_DESTROYED, o)), () => this.outOnError($, o, $.l(ERR), $.l(CB)), () => {
          this.nextTick($, this.tick("cbErr", ($2, e) => this.callEcb($2, $2.cast(this.deps.errClos().clos, $2.l(e.a)), $2.cast(this.deps.errType(), $2.l(e.b)))), { a: $.l(CB), b: $.l(ERR) });
        });
        $.ret($.i(0));
      });
      $.put(LEN, $.i(-1));
      const len = (): X => $.sel(I32, $.notNull($.l(S)), $.call(this.byteLengthFn(), $.l(S), $.l(ENC)), $.get(this.deps.bytesType(), 2, $.l(B)));
      $.if($.isNull($.get(OT, O_HEADER, o)), () => {
        $.if($.l(FROMEND), () => {
          $.put(LEN, len());
          $.set(OT, O_CONTLEN, o, $.i2d($.l(LEN)));
          $.set(OT, O_HASCONTLEN, o, $.i(1));
        });
        $.run(this.outImplicitHeaderFn(), o);
        this.excReturn($, $.i(0));
      });
      $.if($.not($.get(OT, O_HASBODY, o)), () => {
        // rejectNonStandardBodyWrites is false here: the callback on a tick.
        this.nextTick($, this.tick("cbNoBody", ($2, e) => this.callEcb($2, $2.cast(this.deps.errClos().clos, $2.l(e.a)), $2.nul(this.deps.errType()))), { a: $.l(CB) });
        $.ret($.i(1));
      });
      $.put(SOCK, $.get(OT, O_SOCKET, o));
      $.if($.both($.not($.l(FROMEND)), $.andThen($.notNull($.l(SOCK)), $.eq($.call(this.net.writableCorkedHelper(), $.l(SOCK)), $.i(0)))), () => {
        $.run(this.net.corkHelper(), $.l(SOCK));
        this.nextTick($, this.tick("connectionCorkNT", ($2, e) => $2.run(this.net.uncorkHelper(), $2.cast(this.sockT, $2.l(e.a)))), { a: $.l(SOCK) });
      });
      const chunkLen = $.sel(I32, $.notNull($.l(S)), $.alen($.l(S)), $.get(this.deps.bytesType(), 2, $.l(B)));
      $.if($.both($.get(OT, O_CHUNKED, o), $.ne(chunkLen, $.i(0))), () => {
        $.if($.lt($.l(LEN), $.i(0)), () => $.put(LEN, len()));
        $.if($.both($.ne($.get(OT, O_CORKED, o), $.i(0)), $.get(OT, O_HEADERSENT, o)), () => {
          $.run(this.odPushFn(O_CB, O_CB_N, "cbPush"), o, $.new_(this.odT, $.l(S), $.l(B), $.l(ENC), $.l(CB)));
          $.set(OT, O_CBLEN, o, $.add($.get(OT, O_CBLEN, o), $.l(LEN)));
          $.put(RET, $.lt($.get(OT, O_CBLEN, o), $.get(OT, O_HWM, o)));
        }, () => {
          $.drop(this.send($, o, $.call(this.hexFn(), $.l(LEN)), $.nul(this.deps.bytesType()), $.i(ENC_LATIN1), $.nul(this.deps.errClos().clos)));
          this.excReturn($, $.i(0));
          $.drop(this.send($, o, $.nul(this.strT), this.crlf($), $.i(ENC_NONE), $.nul(this.deps.errClos().clos)));
          this.excReturn($, $.i(0));
          $.drop(this.send($, o, $.l(S), $.l(B), $.l(ENC), $.nul(this.deps.errClos().clos)));
          this.excReturn($, $.i(0));
          $.put(RET, this.send($, o, $.nul(this.strT), this.crlf($), $.i(ENC_NONE), $.l(CB)));
        });
      }, () => $.put(RET, this.send($, o, $.l(S), $.l(B), $.l(ENC), $.l(CB))));
      $.do($.l(RET));
    });
  }

  /** OutgoingMessage.prototype.write(chunk, encoding, callback) */
  outWriteFn(): number {
    return this.fn("outWrite", [this.outRef(), this.strRef, this.bytesRef, I32, this.eclosRef], [I32], (f, $) => {
      const R = f.local(I32);
      $.put(R, $.call(this.writeImplFn(), $.l(0), $.l(1), $.l(2), $.l(3), $.l(4), $.i(0)));
      this.excReturn($, $.i(0));
      $.if($.not($.l(R)), () => $.set(this.OT, O_NEEDDRAIN, $.l(0), $.i(1)));
      $.do($.l(R));
    });
  }

  /** onFinish(outmsg): unless the socket had an error, emit 'finish'. */
  private onFinishClosFn(): number {
    return this.closFn("onFinish", "err", ($, e) => {
      const m = $.cast(this.OT, $.l(e.a));
      const s = $.get(this.OT, O_SOCKET, m);
      $.if($.andThen($.notNull(s), $.get(this.sockT, NET_SOCK_HTTP.S_HADERR, s)), () => $.ret());
      this.emit($, HL.OUT_FINISH, m);
    });
  }

  /** OutgoingMessage.prototype.end(chunk, encoding, callback): a chunk is
   * a string or bytes (both null = none); `cb` null = none. */
  outEndFn(): number {
    return this.fn("outEnd", [this.outRef(), this.strRef, this.bytesRef, I32, this.vclosRef], [], (f, $) => {
      $.run(this.outEndXFn(), $.l(0), $.l(1), $.l(2), $.l(3), $.l(4), $.nul(this.deps.errClos().clos));
    });
  }

  /** end(chunk, encoding, callback) with the callback twice: `CB` as the
   * 'finish' listener (called with no argument), `ECB` (null = derived
   * from CB, its argument dropped: a typed callback takes none) for the
   * two calls that hand it an error. */
  outEndXFn(): number {
    return this.fn("outEndX", [this.outRef(), this.strRef, this.bytesRef, I32, this.vclosRef, this.eclosRef], [], (f, $) => {
      const [O, S, B, ENC, CB, ECB] = [0, 1, 2, 3, 4, 5];
      const OT = this.OT;
      const o = $.l(O);
      const SOCK = f.local(this.sockRef);
      const FIN = f.local(this.eclosRef);
      const hasChunk = $.or($.andThen($.notNull($.l(S)), $.ne($.alen($.l(S)), $.i(0))), $.notNull($.l(B)));
      $.put(SOCK, $.get(OT, O_SOCKET, o));
      $.if(hasChunk, () => {
        $.if($.get(OT, O_FINISHED, o), () => {
          this.outOnError($, o, this.err($, "%Error", this.lit($, "write after end"), "ERR_STREAM_WRITE_AFTER_END"), $.sel(this.eclosRef, $.notNull($.l(ECB)), $.l(ECB), $.sel(this.eclosRef, $.isNull($.l(CB)), this.nopClos($), $.cast(this.deps.errClos().clos, this.clos($, this.vcbAsEcbFn(), "err", { a: $.l(CB) })))));
          $.ret();
        });
        $.if($.notNull($.l(SOCK)), () => $.run(this.net.corkHelper(), $.l(SOCK)));
        $.drop($.call(this.writeImplFn(), o, $.l(S), $.l(B), $.l(ENC), $.nul(this.deps.errClos().clos), $.i(1)));
        this.excReturn($);
      }, () => {
        $.if($.get(OT, O_FINISHED, o), () => {
          $.if($.notNull($.l(CB)), () => {
            $.if($.not($.call(this.outWritableFinishedFn(), o)), () => this.on($, HL.OUT_FINISH, o, $.l(CB)), () => {
              // callback(new ERR_STREAM_ALREADY_FINISHED('end'))
              $.if($.notNull($.l(ECB)), () => {
                this.callEcb($, $.l(ECB), this.err($, "%Error", this.lit($, "Cannot call end after a stream was finished"), "ERR_STREAM_ALREADY_FINISHED"));
              }, () => this.callVcb($, $.l(CB)));
            });
          });
          $.ret();
        });
        $.if($.isNull($.get(OT, O_HEADER, o)), () => {
          $.if($.notNull($.l(SOCK)), () => $.run(this.net.corkHelper(), $.l(SOCK)));
          $.set(OT, O_CONTLEN, o, $.d(0));
          $.set(OT, O_HASCONTLEN, o, $.i(1));
          $.run(this.outImplicitHeaderFn(), o);
          this.excReturn($);
        });
      });
      $.if($.notNull($.l(CB)), () => this.on($, HL.OUT_FINISH, o, $.l(CB), true));
      $.put(FIN, $.cast(this.deps.errClos().clos, this.clos($, this.onFinishClosFn(), "err", { a: o })));
      $.if($.both($.get(OT, O_HASBODY, o), $.get(OT, O_CHUNKED, o)), () => {
        $.drop(this.send($, o, this.cat($, this.lit($, "0\r\n"), $.get(OT, O_TRAILER, o), this.lit($, "\r\n")), $.nul(this.deps.bytesType()), $.i(ENC_LATIN1), $.l(FIN)));
      }, () => {
        $.if($.or($.or($.not($.get(OT, O_HEADERSENT, o)), $.ne($.call(this.outWritableLengthFn(), o), $.i(0))), hasChunk), () => {
          $.drop(this.send($, o, this.lit($, ""), $.nul(this.deps.bytesType()), $.i(ENC_LATIN1), $.l(FIN)));
        }, () => {
          this.nextTick($, this.tick("finishNT", ($2, e) => {
            const m = $2.cast(this.OT, $2.l(e.a));
            const s = $2.get(this.OT, O_SOCKET, m);
            $2.if($2.andThen($2.notNull(s), $2.get(this.sockT, NET_SOCK_HTTP.S_HADERR, s)), () => $2.ret());
            this.emit($2, HL.OUT_FINISH, m);
          }), { a: o });
        });
      });
      this.excReturn($);
      $.if($.notNull($.l(SOCK)), () => {
        $.run(this.net.corkedOneHelper(), $.l(SOCK));
        $.run(this.net.uncorkHelper(), $.l(SOCK));
      });
      $.set(OT, O_CORKED, o, $.i(1));
      $.run(this.outUncorkFn(), o);
      this.excReturn($);
      $.set(OT, O_FINISHED, o, $.i(1));
      $.if(
        $.both($.eq($.get(OT, O_OD_N, o), $.i(0)), $.andThen($.notNull($.get(OT, O_SOCKET, o)), $.refEq($.get(this.sockT, NET_SOCK_HTTP.S_HTTPMSG, $.get(OT, O_SOCKET, o)), o))),
        () => $.run(this.outFinishFn(), o),
      );
    });
  }

  /** A void callback where an error callback is wanted (it ignores the
   * argument, as a zero-parameter JS function does). */
  private vcbAsEcbFn(): number {
    return this.closFn("vcbAsEcb", "err", ($, e) => this.callVcb($, $.cast(this.deps.voidClos().clos, $.l(e.a))));
  }

  /** _finish(): emit('prefinish'). */
  private outFinishFn(): number {
    return this.fn("_finish", [this.outRef()], [], (f, $) => this.emit($, HL.OUT_PREFINISH, $.l(0)));
  }

  /** flushHeaders() */
  outFlushHeadersFn(): number {
    return this.fn("flushHeaders", [this.outRef()], [], (f, $) => {
      $.if($.isNull($.get(this.OT, O_HEADER, $.l(0))), () => {
        $.run(this.outImplicitHeaderFn(), $.l(0));
        this.excReturn($);
      });
      $.drop(this.send($, $.l(0), this.lit($, ""), $.nul(this.deps.bytesType()), $.i(ENC_NONE), $.nul(this.deps.errClos().clos)));
    });
  }

  /* ── the headers object (IncomingMessage's `headers` getter) ──────── */

  /** matchKnownFields(lowercased field) as a flag: 0 joins with ', ',
   * 1 is set-cookie (an array), 2 joins with '; ' (cookie), 3 keeps the
   * first value (unless joinDuplicateHeaders). */
  fieldFlagFn(): number {
    return this.fn("fieldFlag", [this.strRef], [I32], (f, $) => {
      const plain = [
        "age", "host", "from", "etag", "server", "referer", "expires", "location", "user-agent", "retry-after",
        "content-type", "max-forwards", "authorization", "last-modified", "content-length", "if-modified-since",
        "proxy-authorization", "if-unmodified-since",
      ];
      for (const name of plain) $.if(this.streq($, $.l(0), this.lit($, name)), () => $.ret($.i(3)));
      $.if(this.streq($, $.l(0), this.lit($, "set-cookie")), () => $.ret($.i(1)));
      $.if(this.streq($, $.l(0), this.lit($, "cookie")), () => $.ret($.i(2)));
      $.do($.i(0));
    });
  }

  /** req.headers[key] for a lowercased key -> the string, or null
   * (undefined); a set-cookie that is present answers its values joined
   * with ', ' and sets the module's arrayHeader flag (the caller fences). */
  incHeaderFn(): number {
    return this.fn("incHeader", [this.incRef(), this.strRef], [this.strRef], (f, $) => {
      const [INC, K] = [0, 1];
      const IT = this.IT;
      const N = f.local(I32);
      const R = f.local(this.strRef);
      const FL = f.local(I32);
      const V = f.local(this.strRef);
      const raw = $.get(IT, I_RAWH, $.l(INC));
      $.put(FL, $.call(this.fieldFlagFn(), $.l(K)));
      $.for(N, $.i(0), $.get(IT, I_HCOUNT, $.l(INC)), () => {
        $.if(this.streq($, $.call(this.asciiLowerFn(), $.aget(this.strArrT, raw, $.l(N))), $.l(K)), () => {
          $.put(V, $.aget(this.strArrT, raw, $.add($.l(N), $.i(1))));
          $.if($.isNull($.l(R)), () => $.put(R, $.l(V)), () => {
            $.if($.or($.eq($.l(FL), $.i(0)), $.eq($.l(FL), $.i(1))), () => $.put(R, this.cat($, $.l(R), this.lit($, ", "), $.l(V))));
            $.if($.eq($.l(FL), $.i(2)), () => $.put(R, this.cat($, $.l(R), this.lit($, "; "), $.l(V))));
            $.if($.both($.eq($.l(FL), $.i(3)), $.get(IT, I_JOINDUP, $.l(INC))), () => $.put(R, this.cat($, $.l(R), this.lit($, ", "), $.l(V))));
          });
        });
        $.put(N, $.add($.l(N), $.i(1)));
      });
      $.do($.l(R));
    });
  }

  /** The headers object's keys in insertion order, as lowercased-key /
   * value pairs (`set-cookie`'s values as one entry each, flagged by the
   * caller through fieldFlag). */
  incHeaderPairsFn(): number {
    return this.fn("incHeaderPairs", [this.incRef()], [this.ref(this.strArrT)], (f, $) => {
      const INC = 0;
      const IT = this.IT;
      const N = f.local(I32);
      const KEYS = f.local(this.ref(this.strArrT));
      const KN = f.local(I32);
      const I = f.local(I32);
      const K = f.local(this.strRef);
      const SEEN = f.local(I32);
      const OUT = f.local(this.ref(this.strArrT));
      const raw = $.get(IT, I_RAWH, $.l(INC));
      $.put(KEYS, $.anew(this.strArrT, $.add($.get(IT, I_HCOUNT, $.l(INC)), $.i(1))));
      $.for(N, $.i(0), $.get(IT, I_HCOUNT, $.l(INC)), () => {
        $.put(K, $.call(this.asciiLowerFn(), $.aget(this.strArrT, raw, $.l(N))));
        $.put(SEEN, $.i(0));
        $.for(I, $.i(0), $.l(KN), () => {
          $.if(this.streq($, $.aget(this.strArrT, $.l(KEYS), $.l(I)), $.l(K)), () => $.put(SEEN, $.i(1)));
        });
        $.if($.not($.l(SEEN)), () => {
          $.aset(this.strArrT, $.l(KEYS), $.l(KN), $.l(K));
          $.put(KN, $.add($.l(KN), $.i(1)));
        });
        $.put(N, $.add($.l(N), $.i(1)));
      });
      $.put(OUT, $.anew(this.strArrT, $.mul($.l(KN), $.i(2))));
      $.for(I, $.i(0), $.l(KN), () => {
        $.aset(this.strArrT, $.l(OUT), $.mul($.l(I), $.i(2)), $.aget(this.strArrT, $.l(KEYS), $.l(I)));
        $.aset(this.strArrT, $.l(OUT), $.add($.mul($.l(I), $.i(2)), $.i(1)), $.call(this.incHeaderFn(), $.l(INC), $.aget(this.strArrT, $.l(KEYS), $.l(I))));
      });
      $.do($.l(OUT));
    });
  }

  /** /(?:^|\W)<word>(?:$|\W)/i.test(req.headers[key]) (undefined reads
   * "undefined", as RegExp.test stringifies it). */
  private incHeaderWordFn(): number {
    return this.fn("incHeaderWord", [this.incRef(), this.strRef, this.strRef], [I32], (f, $) => {
      const V = f.local(this.strRef);
      $.put(V, $.call(this.incHeaderFn(), $.l(0), $.l(1)));
      $.if($.isNull($.l(V)), () => $.put(V, this.lit($, "undefined")));
      $.do($.call(this.wordMatchFn(), $.l(V), $.l(2)));
    });
  }

  /* ── ServerResponse (lib/_http_server.js) ────────────────────────── */

  private get RT(): number {
    return this.resT();
  }

  /** new ServerResponse(req, { highWaterMark, rejectNonStandardBodyWrites }) */
  private resNewFn(): number {
    return this.fn("resNew", [this.incRef(), I32], [this.resRef()], (f, $) => {
      const [REQ, HWMARG] = [0, 1];
      const R = f.local(this.resRef());
      const IT = this.IT;
      const c = f.c;
      this.pushOutInit(c, 1, $.l(HWMARG));
      c.localGet(REQ); // R_REQ
      c.f64Const(200); // R_STATUS (the prototype's)
      c.refNull(this.strT); // R_STATUSMSG (undefined)
      c.i32Const(0); // R_SENT100
      c.i32Const(0); // R_EXPECTCONT
      c.refNull(this.connT()); // R_CONN
      c.refNull(EQ_HEAP); // R_PENDCB
      c.structNew(this.RT);
      c.localSet(R);
      $.if(this.streq($, $.get(IT, I_METHOD, $.l(REQ)), this.lit($, "HEAD")), () => $.set(this.OT, O_HASBODY, $.l(R), $.i(0)));
      $.set(this.OT, O_SENDDATE, $.l(R), $.i(1));
      $.if($.or($.lt($.get(IT, I_MAJOR, $.l(REQ)), $.i(1)), $.lt($.get(IT, I_MINOR, $.l(REQ)), $.i(1))), () => {
        $.set(this.OT, O_CHUNKDEFAULT, $.l(R), $.call(this.incHeaderWordFn(), $.l(REQ), this.lit($, "te"), this.lit($, "chunked")));
        $.set(this.OT, O_KEEPALIVE, $.l(R), $.i(0));
      });
      $.do($.l(R));
    });
  }

  /** The socket setter's cork transfer, then this[kSocket] = val. */
  private outSetSocket($: A, o: X, sock: X): void {
    $.run(this.outSetSocketFn(), o, sock);
  }

  private outSetSocketFn(): number {
    return this.fn("setSocket", [this.outRef(), this.sockRef], [], (f, $) => {
      const [O, S] = [0, 1];
      const N = f.local(I32);
      $.for(N, $.i(0), $.get(this.OT, O_CORKED, $.l(O)), () => {
        $.if($.notNull($.l(S)), () => $.run(this.net.corkHelper(), $.l(S)));
        $.if($.notNull($.get(this.OT, O_SOCKET, $.l(O))), () => $.run(this.net.uncorkHelper(), $.get(this.OT, O_SOCKET, $.l(O))));
      });
      $.set(this.OT, O_SOCKET, $.l(O), $.l(S));
    });
  }

  /** ServerResponse.prototype.assignSocket(socket) */
  private assignSocketFn(): number {
    return this.fn("assignSocket", [this.resRef(), this.sockRef], [], (f, $) => {
      const [R, S] = [0, 1];
      const K = f.local(this.ref(this.connT()));
      $.if($.notNull($.get(this.sockT, NET_SOCK_HTTP.S_HTTPMSG, $.l(S))), () => {
        this.throwErr($, "%Error", this.lit($, "ServerResponse has an already assigned socket"), "ERR_HTTP_SOCKET_ASSIGNED");
        $.ret();
      });
      $.set(this.sockT, NET_SOCK_HTTP.S_HTTPMSG, $.l(S), $.l(R));
      $.put(K, $.get(this.RT, R_CONN, $.l(R)));
      this.son($, NET_LISTS.L_CLOSE, $.l(S), $.get(this.connT(), K_RESCLOSE, $.l(K)));
      this.outSetSocket($, $.l(R), $.l(S));
      // this.emit('socket', socket): no listener can exist on a response here.
      $.run(this.outFlushFn(), $.l(R));
    });
  }

  /** ServerResponse.prototype.detachSocket(socket) */
  private detachSocketFn(): number {
    return this.fn("detachSocket", [this.resRef(), this.sockRef], [], (f, $) => {
      const [R, S] = [0, 1];
      this.soff($, NET_LISTS.L_CLOSE, $.l(S), $.get(this.connT(), K_RESCLOSE, $.get(this.RT, R_CONN, $.l(R))));
      $.set(this.sockT, NET_SOCK_HTTP.S_HTTPMSG, $.l(S), $.nul(EQ_HEAP));
      this.outSetSocket($, $.l(R), $.nul(this.sockT));
    });
  }

  /** emitCloseNT(self) for a ServerResponse */
  private resEmitCloseFn(): number {
    return this.fn("resEmitClose", [this.outRef()], [], (f, $) => {
      const O = 0;
      $.if($.not($.get(this.OT, O_CLOSED, $.l(O))), () => {
        $.set(this.OT, O_DESTROYED, $.l(O), $.i(1));
        $.set(this.OT, O_CLOSED, $.l(O), $.i(1));
        this.emit($, HL.OUT_CLOSE, $.l(O));
      });
    });
  }

  private resEmitCloseTick(): number {
    return this.tick("emitCloseNT", ($, e) => $.run(this.resEmitCloseFn(), $.cast(this.OT, $.l(e.a))));
  }

  /** writeInformation(100, null, cb) as writeContinue uses it. */
  private writeContinueFn(): number {
    return this.fn("writeContinue", [this.resRef()], [], (f, $) => {
      const R = 0;
      $.if($.notNull($.get(this.OT, O_HEADER, $.l(R))), () => {
        this.throwHeadersSent($, "write");
        $.ret();
      });
      $.drop($.call(this.outWriteRawFn(), $.l(R), this.lit($, "HTTP/1.1 100 Continue\r\n\r\n"), $.nul(this.deps.bytesType()), $.i(ENC_ASCII), $.nul(this.deps.errClos().clos)));
      $.set(this.RT, R_SENT100, $.l(R), $.i(1));
    });
  }

  /** ServerResponse.prototype.writeHead(statusCode[, reason][, obj]) — a
   * string `reason` is the reason phrase (null = none); `kind` is the
   * headers argument's shape (0 none, 1 an object, 2 a flat array) with
   * its `n` entries in `list`; `odd` is the flat array's
   * ERR_INVALID_ARG_VALUE (built by the caller) when its length is odd;
   * `orig` is String(statusCode) for the status error (null = render the
   * number). */
  writeHeadFn(): number {
    return this.fn("writeHead", [this.resRef(), F64, this.strRef, I32, this.ref(this.hentArrT), I32], [], (f, $) => {
      const [R, SC0, REASON, KIND, LIST, N] = [0, 1, 2, 3, 4, 5];
      const OT = this.OT;
      const RT = this.RT;
      const SC = f.local(I32);
      const I = f.local(I32);
      const E = f.local(this.ref(this.hentT));
      const LINE = f.local(this.strRef);
      const r = $.l(R);
      $.if($.notNull($.get(OT, O_HEADER, r)), () => {
        this.throwHeadersSent($, "write");
        $.ret();
      });
      $.put(SC, $.call(this.toInt32Fn(), $.l(SC0)));
      $.if($.or($.lt($.l(SC), $.i(100)), $.gt($.l(SC), $.i(999))), () => {
        this.throwErr($, "%RangeError", this.cat($, this.lit($, "Invalid status code: "), this.num2str($, $.l(SC0))), "ERR_HTTP_INVALID_STATUS_CODE");
        $.ret();
      });
      $.if($.notNull($.l(REASON)), () => $.set(RT, R_STATUSMSG, r, $.l(REASON)), () => {
        $.if($.orElse($.isNull($.get(RT, R_STATUSMSG, r)), $.eq($.alen($.get(RT, R_STATUSMSG, r)), $.i(0))), () => {
          $.set(RT, R_STATUSMSG, r, $.call(this.statusTextFn(), $.l(SC)));
          $.if($.isNull($.get(RT, R_STATUSMSG, r)), () => $.set(RT, R_STATUSMSG, r, this.lit($, "unknown")));
        });
      });
      $.set(RT, R_STATUS, r, $.i2d($.l(SC)));
      const viaOut = (): void => {
        $.if($.eq($.l(KIND), $.i(2)), () => {
          $.for(I, $.i(0), $.l(N), () => {
            $.run(this.removeHeaderFn(), r, $.get(this.hentT, E_NAME, $.aget(this.hentArrT, $.l(LIST), $.l(I))));
            this.excReturn($);
          });
          $.for(I, $.i(0), $.l(N), () => {
            $.put(E, $.aget(this.hentArrT, $.l(LIST), $.l(I)));
            $.if($.gt($.alen($.get(this.hentT, E_NAME, $.l(E))), $.i(0)), () => {
              $.run(this.appendHeaderFn(), r, $.get(this.hentT, E_NAME, $.l(E)), $.get(this.hentT, E_VAL, $.l(E)));
              this.excReturn($);
            });
          });
        });
        $.if($.eq($.l(KIND), $.i(1)), () => {
          $.for(I, $.i(0), $.l(N), () => {
            $.put(E, $.aget(this.hentArrT, $.l(LIST), $.l(I)));
            $.if($.gt($.alen($.get(this.hentT, E_NAME, $.l(E))), $.i(0)), () => {
              $.run(this.setHeaderFn(), r, $.get(this.hentT, E_NAME, $.l(E)), $.get(this.hentT, E_VAL, $.l(E)));
              this.excReturn($);
            });
          });
        });
      };
      const hasOut = $.notNull($.get(OT, O_HDRS, r));
      // kind 3: an odd-length flat array (the caller throws its
      // ERR_INVALID_ARG_VALUE at the point this returns).
      $.if(hasOut, () => {
        $.if($.eq($.l(KIND), $.i(3)), () => $.ret());
        viaOut();
      });
      $.if($.call(this.checkInvalidHeaderCharFn(), $.get(RT, R_STATUSMSG, r)), () => {
        this.throwErr($, "%TypeError", this.lit($, "Invalid character in statusMessage"), "ERR_INVALID_CHAR");
        $.ret();
      });
      $.put(LINE, this.cat($, this.lit($, "HTTP/1.1 "), this.num2str($, $.i2d($.l(SC))), this.lit($, " "), $.get(RT, R_STATUSMSG, r), this.lit($, "\r\n")));
      $.if($.or($.or($.eq($.l(SC), $.i(204)), $.eq($.l(SC), $.i(304))), $.both($.ge($.l(SC), $.i(100)), $.le($.l(SC), $.i(199)))), () =>
        $.set(OT, O_HASBODY, r, $.i(0)),
      );
      $.if($.both($.get(RT, R_EXPECTCONT, r), $.not($.get(RT, R_SENT100, r))), () => $.set(OT, O_KEEPALIVE, r, $.i(0)));
      $.if($.eq($.l(KIND), $.i(3)), () => $.ret());
      $.if(hasOut, () => {
        $.run(this.storeHeaderFn(), r, $.l(LINE), $.get(OT, O_HDRS, r), $.get(OT, O_HDRS_N, r), $.i(0));
      }, () => {
        $.run(this.storeHeaderFn(), r, $.l(LINE), $.sel(this.ref(this.hentArrT), $.eq($.l(KIND), $.i(0)), $.nul(this.hentArrT), $.l(LIST)), $.l(N), $.i(1));
      });
    });
  }

  /** ToInt32 (the `|= 0`). */
  private toInt32Fn(): number {
    return this.fn("toInt32", [F64], [I32], (f, $) => {
      const D = 0;
      const T = f.local(F64);
      $.if($.or($.dne($.l(D), $.l(D)), $.deq($.raw((c) => {
        c.localGet(D);
        c.f64Abs();
      }), $.d(Infinity))), () => $.ret($.i(0)));
      // trunc, then modulo 2^32 into the int32 range.
      $.put(T, $.raw((c) => {
        c.localGet(D);
        c.f64Trunc();
      }));
      $.put(T, $.raw((c) => {
        c.localGet(T);
        c.localGet(T);
        c.f64Const(4294967296);
        c.f64Div();
        c.f64Floor();
        c.f64Const(4294967296);
        c.f64Mul();
        c.f64Sub();
      }));
      $.do($.raw((c) => {
        c.localGet(T);
        c.i64TruncF64S();
        c.i32WrapI64();
      }));
    });
  }

  /* ── http.Server (lib/_http_server.js) ───────────────────────────── */

  private get HT(): number {
    return this.hsrvT();
  }

  /** new Server([requestListener]) — storeHTTPOptions over no options, the
   * net.Server ({ allowHalfOpen: true, noDelay: true }), the 'request'
   * listener, and the 'connection' / 'listening' listeners. */
  serverNewFn(): number {
    return this.fn("serverNew", [EQ_REF], [this.srvRef], (f, $) => {
      const CB = 0;
      const V = f.local(this.srvRef);
      const H = f.local(this.hsrvRef());
      const c = f.c;
      $.put(V, $.call(this.net.srvNewHelper()));
      // storeHTTPOptions
      c.refNull(this.entArrT);
      c.i32Const(0);
      c.f64Const(0); // H_TIMEOUT (this.timeout = 0)
      c.f64Const(5000); // H_KATIMEOUT
      c.f64Const(1000); // H_KABUFFER
      c.f64Const(300000); // H_REQTIMEOUT
      c.f64Const(60000); // H_HDRTIMEOUT
      c.f64Const(30000); // H_CHECKINTERVAL
      c.f64Const(0); // H_CHECKID
      c.i32Const(1); // H_REQUIREHOST
      c.i32Const(-1); // H_JOINDUP
      c.i32Const(-1); // H_MAXHEADERS (null)
      c.f64Const(0); // H_MAXREQPERSOCK
      c.i32Const(0); // H_HALFOPEN (httpAllowHalfOpen)
      c.refNull(this.eqArrT); // H_CONNS
      c.i32Const(0);
      c.i32Const(0); // H_REJECTNONSTD
      c.localGet(V); // H_SRV
      c.i32Const(0); // H_SEQ
      c.structNew(this.HT);
      c.localSet(H);
      $.set(this.srvT, NET_SRV_HTTP.V_HTTP, $.l(V), $.l(H));
      $.set(this.srvT, NET_SRV_HTTP.V_HALFOPEN, $.l(V), $.i(1));
      $.set(this.srvT, NET_SRV_HTTP.V_NODELAY, $.l(V), $.i(1));
      $.if($.notNull($.l(CB)), () => this.on($, HL.SRV_REQUEST, $.l(H), $.l(CB)));
      this.son($, NET_LISTS.LV_CONN, $.l(V), this.clos($, this.connectionListenerFn(), "sock", { a: $.l(V) }));
      this.son($, NET_LISTS.LV_LISTENING, $.l(V), this.clos($, this.setupConnectionsTrackingFn(), "void", { a: $.l(V) }));
      $.do($.l(V));
    });
  }

  /** The http state of an http server (null for a plain net.Server). */
  hsrvOf($: A, srv: X): X {
    return $.cast(this.HT, $.get(this.srvT, NET_SRV_HTTP.V_HTTP, srv));
  }

  /** server.on('request', listener) */
  serverOnRequest($: A, srv: X, clos: X, once: boolean): void {
    $.if($.notNull($.get(this.srvT, NET_SRV_HTTP.V_HTTP, srv)), () => this.on($, HL.SRV_REQUEST, this.hsrvOf($, srv), clos, once));
  }

  /** setupConnectionsTracking (a 'listening' listener, this = server). */
  private setupConnectionsTrackingFn(): number {
    return this.tick("setupConnectionsTracking", ($, e, f) => {
      const V = f.local(this.srvRef);
      const H = f.local(this.hsrvRef());
      $.put(V, $.cast(this.srvT, $.l(e.a)));
      $.put(H, this.hsrvOf($, $.l(V)));
      $.if($.isNull($.get(this.HT, H_CONNS, $.l(H))), () => $.set(this.HT, H_CONNS, $.l(H), $.anew(this.eqArrT, $.i(4))));
      $.if($.dne($.get(this.HT, H_CHECKID, $.l(H)), $.d(0)), () => $.run(this.deps.clearTimer(), $.get(this.HT, H_CHECKID, $.l(H))));
      $.set(this.HT, H_CHECKID, $.l(H), $.call(
        this.deps.unrefTimer(),
        $.call(this.deps.setInterval(), $.cast(this.deps.voidClos().clos, this.clos($, this.checkConnectionsFn(), "void", { a: $.l(H) })), $.get(this.HT, H_CHECKINTERVAL, $.l(H))),
      ));
    });
  }

  /** checkConnections (this = server) */
  private checkConnectionsFn(): number {
    return this.tick("checkConnections", ($, e, f) => {
      const H = f.local(this.hsrvRef());
      const HT = this.HT;
      const NOW = f.local(F64);
      const HD = f.local(F64);
      const RD = f.local(F64);
      const HTO = f.local(F64);
      const RTO = f.local(F64);
      const SNAP = f.local(this.ref(this.eqArrT));
      const N = f.local(I32);
      const I = f.local(I32);
      const P = f.local(this.parserRef());
      const T = f.local(F64);
      $.put(H, $.cast(HT, $.l(e.a)));
      $.put(HTO, $.get(HT, H_HDRTIMEOUT, $.l(H)));
      $.put(RTO, $.get(HT, H_REQTIMEOUT, $.l(H)));
      $.if($.both($.deq($.l(HTO), $.d(0)), $.deq($.l(RTO), $.d(0))), () => $.ret());
      // ConnectionsList::Expired
      $.if($.both($.dgt($.l(RTO), $.d(0)), $.dgt($.l(HTO), $.l(RTO))), () => {
        $.put(T, $.l(HTO));
        $.put(HTO, $.l(RTO));
        $.put(RTO, $.l(T));
      });
      $.put(NOW, $.call(this.deps.now()));
      $.put(HD, $.sel(F64, $.both($.dgt($.l(HTO), $.d(0)), $.dgt($.l(NOW), $.l(HTO))), $.dsub($.l(NOW), $.l(HTO)), $.d(0)));
      $.put(RD, $.sel(F64, $.both($.dgt($.l(RTO), $.d(0)), $.dgt($.l(NOW), $.l(RTO))), $.dsub($.l(NOW), $.l(RTO)), $.d(0)));
      $.if($.both($.deq($.l(HD), $.d(0)), $.deq($.l(RD), $.d(0))), () => $.ret());
      // Active connections in comparator order (start time, then order).
      $.put(SNAP, $.call(this.connsSortedFn(), $.l(H), $.i(1)));
      $.put(N, $.alen($.l(SNAP)));
      $.for(I, $.i(0), $.l(N), () => {
        $.put(P, $.cast(this.PT, $.aget(this.eqArrT, $.l(SNAP), $.l(I))));
        const start = $.get(this.PT, P_LASTSTART, $.l(P));
        $.if(
          $.or(
            $.both($.both($.not($.get(this.PT, P_HDRSDONE, $.l(P))), $.dgt($.l(HD), $.d(0))), $.dlt(start, $.l(HD))),
            $.both($.dgt($.l(RD), $.d(0)), $.dlt(start, $.l(RD))),
          ),
          () => {
            $.set(this.PT, P_INACTIVE, $.l(P), $.i(0));
            $.if($.notNull($.get(this.PT, P_SOCK, $.l(P))), () => {
              // onRequestTimeout(socket)
              $.run(this.socketOnErrorFn(), $.get(this.PT, P_SOCK, $.l(P)), this.err($, "%Error", this.lit($, "Request timeout"), "ERR_HTTP_REQUEST_TIMEOUT"));
              this.excReturn($);
            });
          },
        );
      });
    });
  }

  /** The server's connections in std::set order: idle ones (start 0)
   * first in creation order, then by start time. `active` 1 = only the
   * active set, 0 = all, 2 = only the idle ones. */
  private connsSortedFn(): number {
    return this.fn("connsSorted", [this.hsrvRef(), I32], [this.ref(this.eqArrT)], (f, $) => {
      const [H, MODE] = [0, 1];
      const HT = this.HT;
      const OUT = f.local(this.ref(this.eqArrT));
      const N = f.local(I32);
      const I = f.local(I32);
      const J = f.local(I32);
      const P = f.local(this.parserRef());
      const Q = f.local(this.parserRef());
      const T = f.local(EQ_REF);
      const arr = $.get(HT, H_CONNS, $.l(H));
      $.if($.isNull(arr), () => $.ret($.anew(this.eqArrT, $.i(0))));
      $.put(OUT, $.anew(this.eqArrT, $.get(HT, H_CONNS_N, $.l(H))));
      $.for(I, $.i(0), $.get(HT, H_CONNS_N, $.l(H)), () => {
        $.put(P, $.cast(this.PT, $.aget(this.eqArrT, arr, $.l(I))));
        const inAll = $.get(this.PT, P_INALL, $.l(P));
        const idle = $.deq($.get(this.PT, P_LASTSTART, $.l(P)), $.d(0));
        $.if(
          $.sel(I32, $.eq($.l(MODE), $.i(1)), $.get(this.PT, P_INACTIVE, $.l(P)), $.sel(I32, $.eq($.l(MODE), $.i(2)), $.both(inAll, idle), inAll)),
          () => {
            $.aset(this.eqArrT, $.l(OUT), $.l(N), $.l(P));
            $.put(N, $.add($.l(N), $.i(1)));
          },
        );
      });
      // insertion sort by (idle first by order, then start time, order)
      $.for(I, $.i(1), $.l(N), () => {
        $.put(J, $.l(I));
        $.while($.gt($.l(J), $.i(0)), () => {
          $.put(P, $.cast(this.PT, $.aget(this.eqArrT, $.l(OUT), $.sub($.l(J), $.i(1)))));
          $.put(Q, $.cast(this.PT, $.aget(this.eqArrT, $.l(OUT), $.l(J))));
          const ps = $.get(this.PT, P_LASTSTART, $.l(P));
          const qs = $.get(this.PT, P_LASTSTART, $.l(Q));
          // Q < P ?
          const less = $.sel(
            I32,
            $.both($.deq(qs, $.d(0)), $.deq(ps, $.d(0))),
            $.lt($.get(this.PT, P_SEQ, $.l(Q)), $.get(this.PT, P_SEQ, $.l(P))),
            $.sel(I32, $.deq(qs, $.d(0)), $.i(1), $.sel(I32, $.deq(ps, $.d(0)), $.i(0), $.dlt(qs, ps))),
          );
          $.if($.not(less), () => $.put(J, $.i(0)), () => {
            $.put(T, $.aget(this.eqArrT, $.l(OUT), $.l(J)));
            $.aset(this.eqArrT, $.l(OUT), $.l(J), $.aget(this.eqArrT, $.l(OUT), $.sub($.l(J), $.i(1))));
            $.aset(this.eqArrT, $.l(OUT), $.sub($.l(J), $.i(1)), $.l(T));
            $.put(J, $.sub($.l(J), $.i(1)));
          });
        });
      });
      // Trim to n.
      $.put(T, $.l(OUT));
      $.put(OUT, $.anew(this.eqArrT, $.l(N)));
      $.do($.l(OUT), $.i(0), $.cast(this.eqArrT, $.l(T)), $.i(0), $.l(N));
      f.c.arrayCopy(this.eqArrT, this.eqArrT);
      $.do($.l(OUT));
    });
  }

  /** httpServerPreClose(server): closeIdleConnections, clearInterval. */
  preCloseFn(): number {
    return this.fn("httpServerPreClose", [this.srvRef], [], (f, $) => {
      const V = 0;
      const H = f.local(this.hsrvRef());
      $.put(H, this.hsrvOf($, $.l(V)));
      $.run(this.closeIdleConnectionsFn(), $.l(H));
      $.if($.dne($.get(this.HT, H_CHECKID, $.l(H)), $.d(0)), () => $.run(this.deps.clearTimer(), $.get(this.HT, H_CHECKID, $.l(H))));
    });
  }

  /** Server.prototype.closeIdleConnections */
  closeIdleConnectionsFn(): number {
    return this.fn("closeIdleConnections", [this.hsrvRef()], [], (f, $) => {
      const H = 0;
      const SNAP = f.local(this.ref(this.eqArrT));
      const I = f.local(I32);
      const S = f.local(this.sockRef);
      const M = f.local(EQ_REF);
      $.if($.isNull($.get(this.HT, H_CONNS, $.l(H))), () => $.ret());
      $.put(SNAP, $.call(this.connsSortedFn(), $.l(H), $.i(2)));
      $.for(I, $.i(0), $.alen($.l(SNAP)), () => {
        $.put(S, $.get(this.PT, P_SOCK, $.cast(this.PT, $.aget(this.eqArrT, $.l(SNAP), $.l(I)))));
        $.if($.notNull($.l(S)), () => {
          $.put(M, $.get(this.sockT, NET_SOCK_HTTP.S_HTTPMSG, $.l(S)));
          $.if($.andThen($.notNull($.l(M)), $.not($.get(this.OT, O_FINISHED, $.cast(this.OT, $.l(M))))), () => {}, () => {
            $.run(this.net.destroyHelper(), $.l(S), $.nul(this.deps.errType()));
          });
        });
      });
    });
  }

  /** Server.prototype.closeAllConnections */
  closeAllConnectionsFn(): number {
    return this.fn("closeAllConnections", [this.hsrvRef()], [], (f, $) => {
      const H = 0;
      const SNAP = f.local(this.ref(this.eqArrT));
      const I = f.local(I32);
      const S = f.local(this.sockRef);
      $.if($.isNull($.get(this.HT, H_CONNS, $.l(H))), () => $.ret());
      $.put(SNAP, $.call(this.connsSortedFn(), $.l(H), $.i(0)));
      $.for(I, $.i(0), $.alen($.l(SNAP)), () => {
        $.put(S, $.get(this.PT, P_SOCK, $.cast(this.PT, $.aget(this.eqArrT, $.l(SNAP), $.l(I)))));
        $.if($.notNull($.l(S)), () => $.run(this.net.destroyHelper(), $.l(S), $.nul(this.deps.errType())));
      });
    });
  }

  /** connectionListener(socket) (this = server): the parser, the state
   * and the socket listeners; the handle is consumed by the parser. */
  private connectionListenerFn(): number {
    return this.closFn("connectionListener", "sock", ($, e, f, arg) => {
      const S = arg;
      const V = f.local(this.srvRef);
      const H = f.local(this.hsrvRef());
      const P = f.local(this.parserRef());
      const K = f.local(this.ref(this.connT()));
      const L = f.local(EQ_REF);
      const ST = NET_SOCK_HTTP;
      const KT = this.connT();
      const c = f.c;
      $.put(V, $.cast(this.srvT, $.l(e.a)));
      $.put(H, this.hsrvOf($, $.l(V)));
      $.set(this.sockT, ST.S_SERVER, $.l(S), $.l(V));
      $.if($.dne($.get(this.HT, H_TIMEOUT, $.l(H)), $.d(0)), () => $.run(this.net.setTimeoutHelper(), $.l(S), $.get(this.HT, H_TIMEOUT, $.l(H))));
      // state
      c.localGet(V);
      c.localGet(S);
      c.refNull(this.PT);
      for (let i = 0; i < 4; i++) c.refNull(EQ_HEAP);
      c.refNull(this.eqArrT);
      c.i32Const(0);
      c.refNull(this.eqArrT);
      c.i32Const(0);
      c.i32Const(0); // K_OUTDATA
      c.i32Const(0); // K_REQCOUNT
      c.i32Const(0); // K_KASET
      for (let i = 0; i < 5; i++) c.refNull(EQ_HEAP);
      c.f64Const(0);
      c.structNew(KT);
      c.localSet(K);
      $.set(KT, K_ONTIMEOUT, $.l(K), this.clos($, this.socketOnTimeoutFn(), "void", { a: $.l(S) }));
      this.son($, NET_LISTS.L_TIMEOUT, $.l(S), $.get(KT, K_ONTIMEOUT, $.l(K)));
      $.put(P, $.call(this.parserNewFn()));
      $.run(this.parserInitFn(), $.l(P), $.i(HTTP_REQUEST), $.sel(EQ_REF, $.isNull($.get(this.HT, H_CONNS, $.l(H))), $.nul(EQ_HEAP), $.l(H)));
      $.set(this.PT, P_SOCK, $.l(P), $.l(S));
      $.set(this.sockT, ST.S_PARSER, $.l(S), $.l(P));
      $.if($.ge($.get(this.HT, H_MAXHEADERS, $.l(H)), $.i(0)), () => $.set(this.PT, P_MAXPAIRS, $.l(P), $.shl($.get(this.HT, H_MAXHEADERS, $.l(H)), $.i(1))));
      $.set(KT, K_PARSER, $.l(K), $.l(P));
      $.set(KT, K_ONDATA, $.l(K), this.clos($, this.socketOnDataFn(), "data", { a: $.l(K) }));
      $.set(KT, K_ONEND, $.l(K), this.clos($, this.socketOnEndFn(), "void", { a: $.l(K) }));
      $.set(KT, K_ONCLOSE, $.l(K), this.clos($, this.socketOnCloseFn(), "void", { a: $.l(K) }));
      $.set(KT, K_ONDRAIN, $.l(K), this.clos($, this.socketOnDrainFn(), "void", { a: $.l(K) }));
      $.set(KT, K_ONERROR, $.l(K), this.clos($, this.socketOnErrorClosFn(), "err", { a: $.l(S) }));
      $.set(KT, K_RESCLOSE, $.l(K), this.clos($, this.onServerResponseCloseFn(), "void", { a: $.l(S) }));
      this.son($, NET_LISTS.L_DATA, $.l(S), $.get(KT, K_ONDATA, $.l(K)));
      $.run(this.net.dataAddedHelper(), $.l(S));
      this.son($, NET_LISTS.L_ERROR, $.l(S), $.get(KT, K_ONERROR, $.l(K)));
      this.son($, NET_LISTS.L_END, $.l(S), $.get(KT, K_ONEND, $.l(K)));
      this.son($, NET_LISTS.L_CLOSE, $.l(S), $.get(KT, K_ONCLOSE, $.l(K)));
      this.son($, NET_LISTS.L_DRAIN, $.l(S), $.get(KT, K_ONDRAIN, $.l(K)));
      $.set(this.PT, P_CONN, $.l(P), $.l(K));
      $.set(KT, K_ONRESUME, $.l(K), this.clos($, this.onSocketResumeFn(), "void", { a: $.l(S) }));
      $.set(KT, K_ONPAUSE, $.l(K), this.clos($, this.onSocketPauseFn(), "void", { a: $.l(S) }));
      this.son($, NET_LISTS.L_RESUME, $.l(S), $.get(KT, K_ONRESUME, $.l(K)));
      this.son($, NET_LISTS.L_PAUSE, $.l(S), $.get(KT, K_ONPAUSE, $.l(K)));
      // parser.consume(socket._handle)
      $.if($.both($.get(this.sockT, ST.S_HAS_HANDLE, $.l(S)), $.not($.get(this.sockT, ST.S_CONSUMED, $.l(S)))), () => {
        $.set(this.PT, P_CONSUMED, $.l(P), $.i(1));
        $.set(this.sockT, ST.S_CONSUMED, $.l(S), $.i(1));
      });
      $.set(this.PT, P_ONEXECUTE, $.l(P), $.i(1));
      $.set(this.sockT, ST.S_HPAUSED, $.l(S), $.i(0));
      void L;
    });
  }

  /** socketOnData(server, socket, parser, state, d) */
  private socketOnDataFn(): number {
    return this.closFn("socketOnData", "data", ($, e, f, arg) => {
      const K = f.local(this.ref(this.connT()));
      const R = f.local(I32);
      $.put(K, $.cast(this.connT(), $.l(e.a)));
      const p = $.get(this.connT(), K_PARSER, $.l(K));
      $.put(R, $.call(this.executeFn(), p, $.l(arg)));
      $.if($.eq($.l(R), $.i(-1)), () => $.ret());
      $.run(this.onParserExecuteCommonFn(), $.l(K), $.l(R), $.l(arg));
    });
  }

  /** onParserExecute(server, socket, parser, state, ret) — the
   * kOnExecute callback of the consumed reader. */
  private onParserExecuteFn(): number {
    return this.fn("onParserExecute", [this.parserRef(), I32], [], (f, $) => {
      const [P, R] = [0, 1];
      const K = f.local(this.ref(this.connT()));
      $.put(K, $.cast(this.connT(), $.get(this.PT, P_CONN, $.l(P))));
      $.run(this.net.unrefTimerHelper(), $.get(this.connT(), K_SOCK, $.l(K)));
      $.run(this.onParserExecuteCommonFn(), $.l(K), $.l(R), $.nul(this.deps.bytesType()));
    });
  }

  /** onParserExecuteCommon(server, socket, parser, state, ret, d): `ret`
   * -2 is a parse error (parseErr), else the bytes parsed. */
  private onParserExecuteCommonFn(): number {
    return this.fn("onParserExecuteCommon", [this.ref(this.connT()), I32, this.bytesRef], [], (f, $) => {
      const [K, R] = [0, 1];
      const KT = this.connT();
      const S = f.local(this.sockRef);
      const P = f.local(this.parserRef());
      const INC = f.local(this.incRef());
      $.put(S, $.get(KT, K_SOCK, $.l(K)));
      $.put(P, $.get(KT, K_PARSER, $.l(K)));
      $.if($.eq($.l(R), $.i(-2)), () => {
        $.run(this.socketOnErrorFn(), $.l(S), $.g(this.parseErrGlobal()));
        this.excReturn($);
      }, () => {
        $.put(INC, $.sel(this.incRef(), $.isNull($.l(P)), $.nul(this.IT), $.get(this.PT, P_INCOMING, $.l(P))));
        $.if($.andThen($.notNull($.l(INC)), $.eq($.get(this.IT, I_UPGRADE, $.l(INC)), $.i(1))), () => {
          // Upgrade or CONNECT: no listener can exist here, so the socket
          // is destroyed once the parser is let go.
          this.soff($, NET_LISTS.L_DATA, $.l(S), $.get(KT, K_ONDATA, $.l(K)));
          this.soff($, NET_LISTS.L_END, $.l(S), $.get(KT, K_ONEND, $.l(K)));
          this.soff($, NET_LISTS.L_CLOSE, $.l(S), $.get(KT, K_ONCLOSE, $.l(K)));
          this.soff($, NET_LISTS.L_DRAIN, $.l(S), $.get(KT, K_ONDRAIN, $.l(K)));
          this.soff($, NET_LISTS.L_ERROR, $.l(S), $.get(KT, K_ONERROR, $.l(K)));
          this.soff($, NET_LISTS.L_TIMEOUT, $.l(S), $.get(KT, K_ONTIMEOUT, $.l(K)));
          $.run(this.unconsumeFn(), $.l(K));
          $.drop($.call(this.finishFn(), $.l(P)));
          this.excReturn($);
          $.run(this.freeParserFn(), $.l(P), $.l(INC), $.l(S));
          $.run(this.net.destroyHelper(), $.l(S), $.nul(this.deps.errType()));
        }, () => {
          $.if($.andThen($.notNull($.l(INC)), this.streq($, $.get(this.IT, I_METHOD, $.l(INC)), this.lit($, "PRI"))), () => {
            $.run(this.net.destroyHelper(), $.l(S), $.nul(this.deps.errType()));
          });
        });
      });
      $.if($.andThen($.get(this.sockT, NET_SOCK_HTTP.S_HPAUSED, $.l(S)), $.notNull($.get(this.sockT, NET_SOCK_HTTP.S_PARSER, $.l(S)))), () => {
        this.parserPause($, $.cast(this.PT, $.get(this.sockT, NET_SOCK_HTTP.S_PARSER, $.l(S))), true);
      });
    });
  }

  /** unconsume(parser, socket) */
  private unconsumeFn(): number {
    return this.fn("unconsume", [this.ref(this.connT())], [], (f, $) => {
      const K = 0;
      const KT = this.connT();
      const S = $.get(KT, K_SOCK, $.l(K));
      const P = $.get(KT, K_PARSER, $.l(K));
      $.if($.get(this.sockT, NET_SOCK_HTTP.S_HAS_HANDLE, S), () => {
        $.if($.get(this.PT, P_CONSUMED, P), () => $.run(this.unconsumeHandleFn(), S));
        $.set(this.PT, P_CONSUMED, P, $.i(0));
        this.soff($, NET_LISTS.L_PAUSE, S, $.get(KT, K_ONPAUSE, $.l(K)));
        this.soff($, NET_LISTS.L_RESUME, S, $.get(KT, K_ONRESUME, $.l(K)));
      });
    });
  }

  /** The noop error listener socketOnError leaves behind. */
  private srvNoopG: number | null = null;

  private srvNoop($: A): X {
    if (this.srvNoopG === null) {
      const pair = this.deps.errClos();
      this.srvNoopG = this.mb.addGlobal(this.eclosRef, true, (w) => {
        w.u8(0xd0);
        w.sleb(pair.clos);
      });
    }
    const g = this.srvNoopG;
    return () => {
      $.if($.isNull($.g(g)), () => $.gput(g, $.cast(this.deps.errClos().clos, this.clos($, this.closFn("noop", "err", () => {}), "err", {}))));
      $.c.globalGet(g);
    };
  }

  private socketOnErrorClosFn(): number {
    return this.closFn("socketOnErrorL", "err", ($, e, f, arg) => {
      $.run(this.socketOnErrorFn(), $.cast(this.sockT, $.l(e.a)), $.l(arg));
    });
  }

  /** socketOnError(e) (this = socket) */
  socketOnErrorFn(): number {
    return this.fn("socketOnError", [this.sockRef, this.errRef], [], (f, $) => {
      const [S, E] = [0, 1];
      const K = f.local(this.ref(this.connT()));
      const M = f.local(EQ_REF);
      const CODE = f.local(this.strRef);
      const RESP = f.local(this.strRef);
      const P = f.local(this.parserRef());
      $.put(P, $.cast(this.PT, $.get(this.sockT, NET_SOCK_HTTP.S_PARSER, $.l(S))));
      $.if($.notNull($.l(P)), () => $.put(K, $.cast(this.connT(), $.get(this.PT, P_CONN, $.l(P)))));
      // this.removeListener('error', socketOnError): the per-socket closure.
      $.if($.notNull($.l(K)), () => this.soff($, NET_LISTS.L_ERROR, $.l(S), $.get(this.connT(), K_ONERROR, $.l(K))));
      $.if($.eq($.call(this.net.countHelper(NET_LISTS.L_ERROR), $.l(S)), $.i(0)), () => this.son($, NET_LISTS.L_ERROR, $.l(S), this.srvNoop($)));
      // this.server.emit('clientError', e, this): no listener here.
      $.put(M, $.get(this.sockT, NET_SOCK_HTTP.S_HTTPMSG, $.l(S)));
      $.if(
        $.andThen(
          $.call(this.net.writableGetterHelper(), $.l(S)),
          $.orElse($.isNull($.l(M)), $.not($.get(this.OT, O_HEADERSENT, $.cast(this.OT, $.l(M))))),
        ),
        () => {
          $.put(CODE, $.get(this.deps.errType(), 3, $.l(E)));
          $.put(RESP, this.lit($, "HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"));
          $.if($.notNull($.l(CODE)), () => {
            $.if(this.streq($, $.l(CODE), this.lit($, "HPE_HEADER_OVERFLOW")), () => $.put(RESP, this.lit($, "HTTP/1.1 431 Request Header Fields Too Large\r\nConnection: close\r\n\r\n")));
            $.if(this.streq($, $.l(CODE), this.lit($, "HPE_CHUNK_EXTENSIONS_OVERFLOW")), () => $.put(RESP, this.lit($, "HTTP/1.1 413 Payload Too Large\r\nConnection: close\r\n\r\n")));
            $.if(this.streq($, $.l(CODE), this.lit($, "ERR_HTTP_REQUEST_TIMEOUT")), () => $.put(RESP, this.lit($, "HTTP/1.1 408 Request Timeout\r\nConnection: close\r\n\r\n")));
          });
          // this.write(response): a Buffer (ascii).
          $.drop($.call(this.net.sockWriteHelper(), $.l(S), $.call(this.encodeFn(), $.l(RESP), $.i(ENC_LATIN1)), $.alen($.l(RESP)), $.nul(this.deps.errClos().clos)));
          this.excReturn($);
        },
      );
      $.run(this.net.destroyHelper(), $.l(S), $.l(E));
    });
  }

  /** socketOnEnd(server, socket, parser, state) */
  private socketOnEndFn(): number {
    return this.tick("socketOnEnd", ($, e, f) => {
      const K = f.local(this.ref(this.connT()));
      const R = f.local(I32);
      const S = f.local(this.sockRef);
      const KT = this.connT();
      $.put(K, $.cast(KT, $.l(e.a)));
      $.put(S, $.get(KT, K_SOCK, $.l(K)));
      $.put(R, $.call(this.finishFn(), $.get(KT, K_PARSER, $.l(K))));
      $.if($.eq($.l(R), $.i(-1)), () => $.ret());
      $.if($.eq($.l(R), $.i(-2)), () => {
        $.run(this.socketOnErrorFn(), $.l(S), $.g(this.parseErrGlobal()));
        $.ret();
      });
      $.if($.not($.get(this.HT, H_HALFOPEN, this.hsrvOf($, $.get(KT, K_SRV, $.l(K))))), () => {
        $.run(this.net.endHelper(), $.l(S), $.nul(this.deps.bytesType()), $.i(0), $.nul(this.deps.errClos().clos));
        $.ret();
      });
      // httpAllowHalfOpen is false here (no lowering sets it).
      $.run(this.net.endHelper(), $.l(S), $.nul(this.deps.bytesType()), $.i(0), $.nul(this.deps.errClos().clos));
    });
  }

  /** socketOnClose(socket, state) */
  private socketOnCloseFn(): number {
    return this.tick("socketOnClose", ($, e, f) => {
      const K = f.local(this.ref(this.connT()));
      const KT = this.connT();
      const S = f.local(this.sockRef);
      $.put(K, $.cast(KT, $.l(e.a)));
      $.put(S, $.get(KT, K_SOCK, $.l(K)));
      $.run(this.freeParserFn(), $.cast(this.PT, $.get(this.sockT, NET_SOCK_HTTP.S_PARSER, $.l(S))), $.nul(EQ_HEAP), $.l(S));
      // abortIncoming / abortOutgoing
      $.while($.gt($.get(KT, K_IN_N, $.l(K)), $.i(0)), () => {
        $.run(this.incDestroyFn(), $.cast(this.IT, $.call(this.connShiftFn(K_IN, K_IN_N), $.l(K))), this.connReset($, "aborted"));
        this.excReturn($);
      });
      $.while($.gt($.get(KT, K_OUT_N, $.l(K)), $.i(0)), () => {
        $.run(this.outDestroyFn(), $.cast(this.OT, $.call(this.connShiftFn(K_OUT, K_OUT_N), $.l(K))), this.connReset($, "aborted"));
        this.excReturn($);
      });
    });
  }

  /** state.incoming / state.outgoing push and shift. */
  private connPushFn(field: number, nfield: number): number {
    return this.fn(`connPush${field}`, [this.ref(this.connT()), EQ_REF], [], (f, $) => {
      const [K, V] = [0, 1];
      const KT = this.connT();
      const NA = f.local(this.ref(this.eqArrT));
      $.if($.isNull($.get(KT, field, $.l(K))), () => $.set(KT, field, $.l(K), $.anew(this.eqArrT, $.i(2))));
      const arr = $.get(KT, field, $.l(K));
      const n = $.get(KT, nfield, $.l(K));
      $.if($.geU(n, $.alen(arr)), () => {
        $.put(NA, $.anew(this.eqArrT, $.shl($.alen(arr), $.i(1))));
        $.do($.l(NA), $.i(0), arr, $.i(0), n);
        f.c.arrayCopy(this.eqArrT, this.eqArrT);
        $.set(KT, field, $.l(K), $.l(NA));
      });
      $.aset(this.eqArrT, arr, n, $.l(V));
      $.set(KT, nfield, $.l(K), $.add(n, $.i(1)));
    });
  }

  private connShiftFn(field: number, nfield: number): number {
    return this.fn(`connShift${field}`, [this.ref(this.connT())], [EQ_REF], (f, $) => {
      const K = 0;
      const KT = this.connT();
      const V = f.local(EQ_REF);
      const arr = $.get(KT, field, $.l(K));
      const n = $.get(KT, nfield, $.l(K));
      $.if($.eq(n, $.i(0)), () => $.ret($.nul(EQ_HEAP)));
      $.put(V, $.aget(this.eqArrT, arr, $.i(0)));
      $.do(arr, $.i(0), arr, $.i(1), $.sub(n, $.i(1)));
      f.c.arrayCopy(this.eqArrT, this.eqArrT);
      $.set(KT, nfield, $.l(K), $.sub(n, $.i(1)));
      $.aset(this.eqArrT, arr, $.get(KT, nfield, $.l(K)), $.nul(EQ_HEAP));
      $.do($.l(V));
    });
  }

  /** updateOutgoingData(socket, state, delta) */
  private updateOutgoingDataFn(): number {
    return this.fn("updateOutgoingData", [this.ref(this.connT()), I32], [], (f, $) => {
      $.set(this.connT(), K_OUTDATA, $.l(0), $.add($.get(this.connT(), K_OUTDATA, $.l(0)), $.l(1)));
      $.run(this.socketOnDrainImplFn(), $.l(0));
    });
  }

  private socketOnDrainFn(): number {
    return this.tick("socketOnDrain", ($, e) => $.run(this.socketOnDrainImplFn(), $.cast(this.connT(), $.l(e.a))));
  }

  /** socketOnDrain(socket, state) */
  private socketOnDrainImplFn(): number {
    return this.fn("socketOnDrainImpl", [this.ref(this.connT())], [], (f, $) => {
      const K = 0;
      const KT = this.connT();
      const S = f.local(this.sockRef);
      const NEEDPAUSE = f.local(I32);
      const M = f.local(this.outRef());
      $.put(S, $.get(KT, K_SOCK, $.l(K)));
      $.put(NEEDPAUSE, $.gt($.get(KT, K_OUTDATA, $.l(K)), $.i(HWM)));
      $.if($.both($.get(this.sockT, NET_SOCK_HTTP.S_HPAUSED, $.l(S)), $.not($.l(NEEDPAUSE))), () => {
        $.set(this.sockT, NET_SOCK_HTTP.S_HPAUSED, $.l(S), $.i(0));
        $.if($.notNull($.get(this.sockT, NET_SOCK_HTTP.S_PARSER, $.l(S))), () => this.parserPause($, $.cast(this.PT, $.get(this.sockT, NET_SOCK_HTTP.S_PARSER, $.l(S))), false));
        $.run(this.net.resumeHelper(), $.l(S));
      });
      $.put(M, $.cast(this.OT, $.get(this.sockT, NET_SOCK_HTTP.S_HTTPMSG, $.l(S))));
      $.if(
        $.andThen(
          $.notNull($.l(M)),
          $.andThen($.both($.not($.get(this.OT, O_FINISHED, $.l(M))), $.get(this.OT, O_NEEDDRAIN, $.l(M))), $.eq($.call(this.outWritableLengthFn(), $.l(M)), $.i(0))),
        ),
        () => {
          $.set(this.OT, O_NEEDDRAIN, $.l(M), $.i(0));
          this.emit($, HL.OUT_DRAIN, $.l(M));
        },
      );
    });
  }

  /** socketOnTimeout (this = socket) */
  private socketOnTimeoutFn(): number {
    return this.tick("socketOnTimeout", ($, e, f) => {
      const S = f.local(this.sockRef);
      const P = f.local(this.parserRef());
      const R = f.local(I32);
      const M = f.local(EQ_REF);
      $.put(S, $.cast(this.sockT, $.l(e.a)));
      $.put(P, $.cast(this.PT, $.get(this.sockT, NET_SOCK_HTTP.S_PARSER, $.l(S))));
      // req.emit('timeout') / server.emit('timeout'): no listener can exist
      // here; the response's own 'timeout' list can.
      $.put(M, $.get(this.sockT, NET_SOCK_HTTP.S_HTTPMSG, $.l(S)));
      $.if($.notNull($.l(M)), () => {
        $.put(R, $.call(this.emitFn(HL.OUT_TIMEOUT), $.cast(this.OT, $.l(M))));
        this.excReturn($);
      });
      $.if($.not($.l(R)), () => $.run(this.net.destroyHelper(), $.l(S), $.nul(this.deps.errType())));
      void P;
    });
  }

  /** onServerResponseClose (this = socket) */
  private onServerResponseCloseFn(): number {
    return this.tick("onServerResponseClose", ($, e) => {
      const m = $.get(this.sockT, NET_SOCK_HTTP.S_HTTPMSG, $.cast(this.sockT, $.l(e.a)));
      $.if($.notNull(m), () => $.run(this.resEmitCloseFn(), $.cast(this.OT, m)));
    });
  }

  /** onSocketResume (this = socket) */
  private onSocketResumeFn(): number {
    return this.tick("onSocketResume", ($, e, f) => {
      const S = f.local(this.sockRef);
      $.put(S, $.cast(this.sockT, $.l(e.a)));
      $.if($.get(this.sockT, NET_SOCK_HTTP.S_HPAUSED, $.l(S)), () => {
        $.run(this.net.pauseHelper(), $.l(S));
        $.ret();
      });
      $.if($.both($.get(this.sockT, NET_SOCK_HTTP.S_HAS_HANDLE, $.l(S)), $.not($.get(this.sockT, NET_SOCK_HTTP.S_READING, $.l(S)))), () => {
        $.run(this.net.readStartHandleHelper(), $.l(S));
      });
    });
  }

  /** onSocketPause (this = socket) */
  private onSocketPauseFn(): number {
    return this.tick("onSocketPause", ($, e, f) => {
      const S = f.local(this.sockRef);
      $.put(S, $.cast(this.sockT, $.l(e.a)));
      $.if($.both($.get(this.sockT, NET_SOCK_HTTP.S_HAS_HANDLE, $.l(S)), $.get(this.sockT, NET_SOCK_HTTP.S_READING, $.l(S))), () => {
        $.run(this.net.readStopHandleHelper(), $.l(S));
      });
    });
  }

  /** resetSocketTimeout(server, socket, state) */
  private resetSocketTimeout($: A, K: number): void {
    const KT = this.connT();
    $.if($.get(KT, K_KASET, $.l(K)), () => {
      $.run(this.net.setTimeoutHelper(), $.get(KT, K_SOCK, $.l(K)), $.get(this.HT, H_TIMEOUT, this.hsrvOf($, $.get(KT, K_SRV, $.l(K)))));
      $.set(KT, K_KASET, $.l(K), $.i(0));
    });
  }

  /** parserOnIncoming(server, socket, state, req, keepAlive) -> 0 / 2 */
  private parserOnIncomingFn(): number {
    return this.fn("parserOnIncoming", [this.ref(this.connT()), this.incRef(), I32], [I32], (f, $) => {
      const [K, REQ, KEEP] = [0, 1, 2];
      const KT = this.connT();
      const IT = this.IT;
      const S = f.local(this.sockRef);
      const H = f.local(this.hsrvRef());
      const RES = f.local(this.resRef());
      const HANDLED = f.local(I32);
      const EXPECT = f.local(this.strRef);
      $.put(S, $.get(KT, K_SOCK, $.l(K)));
      $.put(H, this.hsrvOf($, $.get(KT, K_SRV, $.l(K))));
      $.set(IT, I_SERVER, $.l(REQ), $.i(1));
      this.resetSocketTimeout($, K);
      $.if($.eq($.get(IT, I_UPGRADE, $.l(REQ)), $.i(1)), () => {
        // req.method === 'CONNECT' || shouldUpgradeCallback(req) (no
        // 'upgrade' listener can exist here).
        $.set(IT, I_UPGRADE, $.l(REQ), this.streq($, $.get(IT, I_METHOD, $.l(REQ)), this.lit($, "CONNECT")));
        $.if($.get(IT, I_UPGRADE, $.l(REQ)), () => $.ret($.i(2)));
      });
      $.run(this.connPushFn(K_IN, K_IN_N), $.l(K), $.l(REQ));
      $.if($.not($.get(this.sockT, NET_SOCK_HTTP.S_HPAUSED, $.l(S))), () => {
        $.if($.or($.call(this.net.needDrainHelper(), $.l(S)), $.ge($.get(KT, K_OUTDATA, $.l(K)), $.i(HWM))), () => {
          $.set(this.sockT, NET_SOCK_HTTP.S_HPAUSED, $.l(S), $.i(1));
          $.run(this.net.pauseHelper(), $.l(S));
        });
      });
      $.put(RES, $.call(this.resNewFn(), $.l(REQ), $.i(HWM)));
      $.set(this.RT, R_CONN, $.l(RES), $.l(K));
      $.set(this.OT, O_KATIMEOUT, $.l(RES), $.get(this.HT, H_KATIMEOUT, $.l(H)));
      $.set(this.OT, O_MAXREQPERSOCK, $.l(RES), $.get(this.HT, H_MAXREQPERSOCK, $.l(H)));
      $.set(this.OT, O_KEEPALIVE, $.l(RES), $.l(KEEP));
      $.if($.notNull($.get(this.sockT, NET_SOCK_HTTP.S_HTTPMSG, $.l(S))), () => $.run(this.connPushFn(K_OUT, K_OUT_N), $.l(K), $.l(RES)), () => {
        $.run(this.assignSocketFn(), $.l(RES), $.l(S));
        this.excReturn($, $.i(0));
      });
      this.on($, HL.OUT_FINISH, $.l(RES), this.clos($, this.resOnFinishFn(), "void", { a: $.l(REQ), b: $.l(RES), c: $.l(K) }));
      $.if($.both($.eq($.get(IT, I_MAJOR, $.l(REQ)), $.i(1)), $.eq($.get(IT, I_MINOR, $.l(REQ)), $.i(1))), () => {
        $.if($.both($.get(this.HT, H_REQUIREHOST, $.l(H)), $.isNull($.call(this.incHeaderFn(), $.l(REQ), this.lit($, "host")))), () => {
          // res.writeHead(400, ['Connection', 'close']); res.end();
          const L = $.local(this.ref(this.hentArrT));
          $.put(L, $.anew(this.hentArrT, $.i(1)));
          $.aset(this.hentArrT, $.l(L), $.i(0), $.new_(this.hentT, this.lit($, "connection"), this.lit($, "Connection"), this.hvStrNew($, this.lit($, "close"))));
          $.run(this.writeHeadFn(), $.l(RES), $.d(400), $.nul(this.strT), $.i(2), $.l(L), $.i(1));
          this.excReturn($, $.i(0));
          $.run(this.outEndFn(), $.l(RES), $.nul(this.strT), $.nul(this.deps.bytesType()), $.i(ENC_NONE), $.nul(this.deps.voidClos().clos));
          $.ret($.i(0));
        });
        // maxRequestsPerSocket is 0 here (no lowering sets it).
        $.put(EXPECT, $.call(this.incHeaderFn(), $.l(REQ), this.lit($, "expect")));
        $.if($.notNull($.l(EXPECT)), () => {
          $.put(HANDLED, $.i(1));
          $.if($.call(this.wordMatchFn(), $.l(EXPECT), this.lit($, "100-continue")), () => {
            $.set(this.RT, R_EXPECTCONT, $.l(RES), $.i(1));
            // no 'checkContinue' listener can exist here
            $.run(this.writeContinueFn(), $.l(RES));
            this.excReturn($, $.i(0));
            this.emit($, HL.SRV_REQUEST, $.l(H), $.l(REQ), $.l(RES));
          }, () => {
            $.run(this.writeHeadFn(), $.l(RES), $.d(417), $.nul(this.strT), $.i(0), $.nul(this.hentArrT), $.i(0));
            this.excReturn($, $.i(0));
            $.run(this.outEndFn(), $.l(RES), $.nul(this.strT), $.nul(this.deps.bytesType()), $.i(ENC_NONE), $.nul(this.deps.voidClos().clos));
          });
        });
      });
      $.if($.not($.l(HANDLED)), () => this.emit($, HL.SRV_REQUEST, $.l(H), $.l(REQ), $.l(RES)));
      $.do($.i(0));
    });
  }

  /** resOnFinish(req, res, socket, state, server) */
  private resOnFinishFn(): number {
    return this.tick("resOnFinish", ($, e, f) => {
      const REQ = f.local(this.incRef());
      const RES = f.local(this.resRef());
      const K = f.local(this.ref(this.connT()));
      const S = f.local(this.sockRef);
      const H = f.local(this.hsrvRef());
      const KA = f.local(F64);
      const KB = f.local(F64);
      const M = f.local(EQ_REF);
      const KT = this.connT();
      $.put(REQ, $.cast(this.IT, $.l(e.a)));
      $.put(RES, $.cast(this.RT, $.l(e.b)));
      $.put(K, $.cast(KT, $.l(e.c)));
      $.put(S, $.get(KT, K_SOCK, $.l(K)));
      $.put(H, this.hsrvOf($, $.get(KT, K_SRV, $.l(K))));
      $.drop($.call(this.connShiftFn(K_IN, K_IN_N), $.l(K)));
      $.if($.both($.not($.get(this.IT, I_CONSUMING, $.l(REQ))), $.not(this.rbit($, $.l(REQ), kResumeScheduled))), () => {
        $.run(this.incDumpFn(), $.l(REQ));
      });
      $.run(this.detachSocketFn(), $.l(RES), $.l(S));
      $.run(this.clearIncomingFn(), $.l(REQ));
      this.nextTick($, this.resEmitCloseTick(), { a: $.l(RES) });
      $.if($.get(this.OT, O_LAST, $.l(RES)), () => $.run(this.net.destroySoonHelper(), $.l(S)), () => {
        $.if($.eq($.get(KT, K_OUT_N, $.l(K)), $.i(0)), () => {
          $.put(KA, $.get(this.HT, H_KATIMEOUT, $.l(H)));
          $.if($.or($.dne($.l(KA), $.l(KA)), $.dlt($.l(KA), $.d(0))), () => $.put(KA, $.d(0)));
          $.put(KB, $.get(this.HT, H_KABUFFER, $.l(H)));
          $.if($.or($.dne($.l(KB), $.l(KB)), $.dlt($.l(KB), $.d(0))), () => $.put(KB, $.d(1000)));
          $.if($.dne($.l(KA), $.d(0)), () => {
            $.run(this.net.setTimeoutHelper(), $.l(S), $.dadd($.l(KA), $.l(KB)));
            $.set(KT, K_KASET, $.l(K), $.i(1));
          });
        }, () => {
          $.put(M, $.call(this.connShiftFn(K_OUT, K_OUT_N), $.l(K)));
          $.if($.notNull($.l(M)), () => $.run(this.assignSocketFn(), $.cast(this.RT, $.l(M)), $.l(S)));
        });
      });
    });
  }

  /** clearIncoming(req) */
  private clearIncomingFn(): number {
    return this.fn("clearIncoming", [this.incRef()], [], (f, $) => {
      const REQ = 0;
      const S = f.local(this.sockRef);
      const P = f.local(EQ_REF);
      $.put(S, $.get(this.IT, I_SOCK, $.l(REQ)));
      $.if($.isNull($.l(S)), () => $.ret());
      $.put(P, $.get(this.sockT, NET_SOCK_HTTP.S_PARSER, $.l(S)));
      $.if($.andThen($.notNull($.l(P)), $.refEq($.get(this.PT, P_INCOMING, $.cast(this.PT, $.l(P))), $.l(REQ))), () => {
        $.if(this.rbit($, $.l(REQ), kEndEmitted), () => $.set(this.PT, P_INCOMING, $.cast(this.PT, $.l(P)), $.nul(this.IT)), () => {
          this.on($, HL.INC_END, $.l(REQ), this.clos($, this.tick("clearIncomingL", ($2, e) => $2.run(this.clearIncomingFn(), $2.cast(this.IT, $2.l(e.a)))), "void", { a: $.l(REQ) }));
        });
      });
    });
  }

  /* ── ClientRequest (lib/_http_client.js) ─────────────────────────── */

  private get CT(): number {
    return this.creqT();
  }

  /** $hcli: a socket's client-side listener closures (lib/_http_client.js
   * and lib/_http_agent.js register module-level functions on it; one
   * closure per socket stands for each, so removeListener finds it). */
  private get hcliT(): number {
    return this.type("hcli", () =>
      this.mb.structType([
        { storage: EQ_REF, mutable: false }, // 0 socketOnData
        { storage: EQ_REF, mutable: false }, // 1 socketOnEnd
        { storage: EQ_REF, mutable: false }, // 2 socketCloseListener
        { storage: EQ_REF, mutable: false }, // 3 socketErrorListener
        { storage: EQ_REF, mutable: false }, // 4 ondrain
        { storage: EQ_REF, mutable: false }, // 5 responseOnTimeout
        { storage: EQ_REF, mutable: false }, // 6 emitRequestTimeout
        { storage: EQ_REF, mutable: true }, // 7 the agent's onFree
        { storage: EQ_REF, mutable: true }, // 8 onClose
        { storage: EQ_REF, mutable: true }, // 9 onTimeout
        { storage: EQ_REF, mutable: true }, // 10 onRemove
        { storage: EQ_REF, mutable: false }, // 11 freeSocketErrorListener
        { storage: I64, mutable: false }, // a distinct layout marker
      ]),
    );
  }

  /** The socket's $hcli, made on first use. */
  private hcliFn(): number {
    return this.fn("hcli", [this.sockRef], [this.ref(this.hcliT)], (f, $) => {
      const S = 0;
      const H = f.local(this.ref(this.hcliT));
      const s = $.l(S);
      $.if($.notNull($.get(this.sockT, NET_SOCK_HTTP.S_HCLI, s)), () => $.ret($.cast(this.hcliT, $.get(this.sockT, NET_SOCK_HTTP.S_HCLI, s))));
      $.put(
        H,
        $.new_(
          this.hcliT,
          this.clos($, this.cliSocketOnDataFn(), "data", { a: s }),
          this.clos($, this.cliSocketOnEndFn(), "void", { a: s }),
          this.clos($, this.socketCloseListenerFn(), "void", { a: s }),
          this.clos($, this.socketErrorListenerFn(), "err", { a: s }),
          this.clos($, this.cliOnDrainFn(), "void", { a: s }),
          this.clos($, this.responseOnTimeoutFn(), "void", { a: s }),
          this.clos($, this.emitRequestTimeoutFn(), "void", { a: s }),
          $.nul(EQ_HEAP),
          $.nul(EQ_HEAP),
          $.nul(EQ_HEAP),
          $.nul(EQ_HEAP),
          this.clos($, this.freeSocketErrorListenerFn(), "err", { a: s }),
          $.j(0n),
        ),
      );
      $.set(this.sockT, NET_SOCK_HTTP.S_HCLI, s, $.l(H));
      $.do($.l(H));
    });
  }

  private hcli($: A, sock: X, i: number): X {
    return $.get(this.hcliT, i, $.call(this.hcliFn(), sock));
  }

  /** new ClientRequest(options[, cb]) from the lowered options: host,
   * port (<= 0 = none), path, method, timeout (0 = none), the headers as
   * flat [name, value, ...] pairs (set in order), the agent (null = the
   * global agent; `oneShot` = `agent: false`'s own fresh Agent), and the
   * 'response' callback (null = none). */
  /** INC-29 U3: new ClientRequest(urlToHttpOptions(url)[, cb]) — the
   * URL's hostname (brackets stripped), its port (<= 0 = none), path
   * (pathname + search) and the method; `auth` (null = none) is the
   * decoded "user:password" whose Authorization header Node sets right
   * after the Host header. */
  clientRequestUrlFn(): number {
    return this.fn(
      "clientRequestUrl",
      [this.strRef, F64, this.strRef, this.strRef, EQ_REF, this.strRef],
      [this.creqRef()],
      (f, $) => {
        const [HOST, PORT, PATH, METHOD, CB, AUTH] = [0, 1, 2, 3, 4, 5];
        const Q = f.local(this.creqRef());
        $.put(Q, $.call(this.clientRequestNewFn(), $.l(HOST), $.l(PORT), $.l(PATH), $.l(METHOD), $.d(0), $.anew(this.strArrT, $.i(0)), $.i(0), $.nul(this.agentT()), $.i(0), $.l(CB)));
        this.excReturn($, $.nul(this.CT));
        $.if($.notNull($.l(AUTH)), () => {
          $.run(this.setHeaderFn(), $.l(Q), this.lit($, "Authorization"), this.hvStrNew($, this.cat($, this.lit($, "Basic "), $.l(AUTH))));
          this.excReturn($, $.nul(this.CT));
        });
        $.do($.l(Q));
      },
    );
  }

  clientRequestNewFn(): number {
    return this.fn(
      "clientRequestNew",
      [this.strRef, F64, this.strRef, this.strRef, F64, this.ref(this.strArrT), I32, this.agentRef(), I32, EQ_REF],
      [this.creqRef()],
      (f, $) => {
        const [HOST0, PORT0, PATH0, METHOD0, TMO, HDRS, NHDRS, AGENT0, ONESHOT, CB] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
        const CT = this.CT;
        const OT = this.OT;
        const AT = this.agentT();
        const Q = f.local(this.creqRef());
        const AG = f.local(this.agentRef());
        const PORT = f.local(F64);
        const DEFPORT = f.local(F64);
        const HOST = f.local(this.strRef);
        const METHOD = f.local(this.strRef);
        const PATH = f.local(this.strRef);
        const I = f.local(I32);
        const HH = f.local(this.strRef);
        const PC = f.local(I32);
        const c = f.c;
        // agent: false -> new defaultAgent.constructor(); absent -> the global agent.
        $.if($.l(ONESHOT), () => $.put(AG, $.call(this.agentNewFn(), $.i(0), $.d(-1), $.d(-1), $.d(-1), $.d(-1), $.d(-1), $.i(0))), () => {
          $.put(AG, $.sel(this.agentRef(), $.isNull($.l(AGENT0)), $.call(this.globalAgentFn()), $.l(AGENT0)));
        });
        // The path check: /[^!-ÿ]/
        $.put(PATH, $.l(PATH0));
        $.if($.gt($.alen($.l(PATH)), $.i(0)), () => {
          $.for(I, $.i(0), $.alen($.l(PATH)), () => {
            const ch = $.agetU(this.strT, $.l(PATH), $.l(I));
            $.if($.or($.lt(ch, $.i(0x21)), $.gt(ch, $.i(0xff))), () => {
              this.throwErr($, "%TypeError", this.lit($, "Request path contains unescaped characters"), "ERR_UNESCAPED_CHARACTERS");
              $.ret($.nul(CT));
            });
          });
        });
        // defaultPort = options.defaultPort || this.agent?.defaultPort
        $.put(DEFPORT, $.get(AT, A_DEFPORT, $.l(AG)));
        // port = options.port || defaultPort || 80
        $.put(PORT, $.l(PORT0));
        $.if($.not($.dgt($.l(PORT), $.d(0))), () => {
          $.put(PORT, $.l(DEFPORT));
          $.if($.not($.dgt($.l(PORT), $.d(0))), () => $.put(PORT, $.d(80)));
        });
        $.put(HOST, $.sel(this.strRef, $.gt($.alen($.l(HOST0)), $.i(0)), $.l(HOST0), this.lit($, "localhost")));
        // method: checkIsHttpToken, toUpperCase
        $.if($.gt($.alen($.l(METHOD0)), $.i(0)), () => {
          $.if($.not($.call(this.checkIsHttpTokenFn(), $.l(METHOD0))), () => {
            this.throwErr($, "%TypeError", this.cat($, this.lit($, 'Method must be a valid HTTP token ["'), $.l(METHOD0), this.lit($, '"]')), "ERR_INVALID_HTTP_TOKEN");
            $.ret($.nul(CT));
          });
          $.put(METHOD, $.call(this.asciiUpperFn(), $.l(METHOD0)));
        }, () => $.put(METHOD, this.lit($, "GET")));
        // OutgoingMessage.call(this), then the request's own fields.
        this.pushOutInit(c, 2, $.i(HWM));
        c.localGet(AG); // C_AGENT
        c.localGet(METHOD); // C_METHOD
        $.do($.sel(this.strRef, $.gt($.alen($.l(PATH)), $.i(0)), $.l(PATH), this.lit($, "/"))); // C_PATH (this[kPath])
        c.localGet(HOST); // C_HOST
        this.deps.pushStrLit(c, "http:"); // C_PROTOCOL
        c.i32Const(0); // C_ENDED
        c.refNull(this.IT); // C_RES
        c.i32Const(0); // C_ABORTED
        c.i32Const(0); // C_TIMEOUTCB
        c.i32Const(0); // C_UPGRADEORCONNECT
        c.refNull(this.PT); // C_PARSER
        c.i32Const(-1); // C_MAXHEADERS
        c.i32Const(0); // C_REUSED
        $.do($.sel(F64, $.dgt($.l(TMO), $.d(0)), $.l(TMO), $.d(-1))); // C_TIMEOUT
        c.refNull(this.deps.errType()); // C_ERROR
        c.localGet(PORT); // C_PORT
        c.refNull(this.entArrT);
        c.i32Const(0);
        c.refNull(EQ_HEAP);
        c.refNull(EQ_HEAP);
        c.structNew(CT);
        c.localSet(Q);
        $.if($.notNull($.l(CB)), () => this.on($, HL.CREQ_RESPONSE, $.l(Q), $.l(CB), true));
        // useChunkedEncodingByDefault
        $.if(
          $.or(
            $.or($.or(this.streq($, $.l(METHOD), this.lit($, "GET")), this.streq($, $.l(METHOD), this.lit($, "HEAD"))), this.streq($, $.l(METHOD), this.lit($, "DELETE"))),
            $.or($.or(this.streq($, $.l(METHOD), this.lit($, "OPTIONS")), this.streq($, $.l(METHOD), this.lit($, "TRACE"))), this.streq($, $.l(METHOD), this.lit($, "CONNECT"))),
          ),
          () => $.set(OT, O_CHUNKDEFAULT, $.l(Q), $.i(0)),
        );
        // if (!agent.keepAlive && !isFinite(agent.maxSockets)) close-after
        $.if($.both($.not($.get(AT, A_KEEPALIVE, $.l(AG))), $.deq($.get(AT, A_MAXSOCKETS, $.l(AG)), $.d(Infinity))), () => {
          $.set(OT, O_LAST, $.l(Q), $.i(1));
          $.set(OT, O_KEEPALIVE, $.l(Q), $.i(0));
        }, () => {
          $.set(OT, O_LAST, $.l(Q), $.i(0));
          $.set(OT, O_KEEPALIVE, $.l(Q), $.i(1));
        });
        // the headers object, in order
        $.for(I, $.i(0), $.l(NHDRS), () => {
          $.run(this.setHeaderFn(), $.l(Q), $.aget(this.strArrT, $.l(HDRS), $.l(I)), this.hvStrNew($, $.aget(this.strArrT, $.l(HDRS), $.add($.l(I), $.i(1)))));
          this.excReturn($, $.nul(CT));
          $.put(I, $.add($.l(I), $.i(1)));
        });
        // the Host header
        $.if($.isNull($.call(this.getHeaderFn(), $.l(Q), this.lit($, "host"))), () => {
          $.put(HH, $.l(HOST));
          $.put(PC, $.call(this.indexOfFn(), $.l(HH), $.i(58), $.i(0)));
          $.if($.ne($.l(PC), $.i(-1)), () => {
            $.if($.both($.ne($.call(this.indexOfFn(), $.l(HH), $.i(58), $.add($.l(PC), $.i(1))), $.i(-1)), $.ne($.agetU(this.strT, $.l(HH), $.i(0)), $.i(91))), () => {
              $.put(HH, this.cat($, this.lit($, "["), $.l(HH), this.lit($, "]")));
            });
          });
          $.if($.dne($.l(PORT), $.l(DEFPORT)), () => $.put(HH, this.cat($, $.l(HH), this.lit($, ":"), this.num2str($, $.l(PORT)))));
          $.run(this.setHeaderFn(), $.l(Q), this.lit($, "Host"), this.hvStrNew($, $.l(HH)));
          this.excReturn($, $.nul(CT));
        });
        $.if($.notNull($.call(this.getHeaderFn(), $.l(Q), this.lit($, "expect"))), () => {
          $.run(this.storeHeaderFn(), $.l(Q), this.cat($, $.l(METHOD), this.lit($, " "), $.get(CT, C_PATH, $.l(Q)), this.lit($, " HTTP/1.1\r\n")), $.get(OT, O_HDRS, $.l(Q)), $.get(OT, O_HDRS_N, $.l(Q)), $.i(0));
          this.excReturn($, $.nul(CT));
        });
        $.run(this.agentAddRequestFn(), $.l(AG), $.l(Q));
        this.excReturn($, $.nul(CT));
        $.do($.l(Q));
      },
    );
  }

  /** `(string) -> string` ASCII upper-casing (a token's toUpperCase). */
  private asciiUpperFn(): number {
    return this.fn("asciiUpper", [this.strRef], [this.strRef], (f, $) => {
      const S = 0;
      const O = f.local(this.strRef);
      const I = f.local(I32);
      const CH = f.local(I32);
      $.put(O, $.anew(this.strT, $.alen($.l(S))));
      $.for(I, $.i(0), $.alen($.l(S)), () => {
        $.put(CH, $.agetU(this.strT, $.l(S), $.l(I)));
        $.if($.both($.ge($.l(CH), $.i(97)), $.le($.l(CH), $.i(122))), () => $.put(CH, $.sub($.l(CH), $.i(32))));
        $.aset(this.strT, $.l(O), $.l(I), $.l(CH));
      });
      $.do($.l(O));
    });
  }

  /** req.onSocket(socket[, err]) */
  private onSocketFn(): number {
    return this.fn("onSocket", [this.creqRef(), this.sockRef], [], (f, $) => {
      const [Q, S] = [0, 1];
      $.if($.notNull($.l(S)), () => {
        $.set(this.sockT, NET_SOCK_HTTP.S_HTTPMSG, $.l(S), $.l(Q));
        this.son($, NET_LISTS.L_ERROR, $.l(S), this.hcli($, $.l(S), 3));
      });
      this.nextTick($, this.onSocketNTFn(), { a: $.l(Q), b: $.l(S) });
    });
  }

  /** onSocketNT(req, socket, err) */
  private onSocketNTFn(): number {
    return this.tick("onSocketNT", ($, e, f) => {
      const Q = f.local(this.creqRef());
      const S = f.local(this.sockRef);
      $.put(Q, $.cast(this.CT, $.l(e.a)));
      $.put(S, $.cast(this.sockT, $.l(e.b)));
      $.if($.get(this.OT, O_DESTROYED, $.l(Q)), () => {
        // req.destroyed (no error): the socket goes back to the agent, or
        // is destroyed; then 'socket hang up' and 'close'.
        $.if($.both($.notNull($.get(this.CT, C_AGENT, $.l(Q))), $.not($.call(this.net.destroyedHelper(), $.l(S)))), () => {
          $.drop(this.semit($, NET_LISTS.L_FREE, $.l(S)));
          this.excReturn($);
          this.soff($, NET_LISTS.L_ERROR, $.l(S), this.hcli($, $.l(S), 3));
          $.run(this.reqDestroyedNoSocketFn(), $.l(Q), $.l(S), $.get(this.CT, C_ERROR, $.l(Q)));
        }, () => {
          // finished(socket.destroy(err || req[kError]), ...): the error on
          // 'close' (SEMANTICS.md S088 (k): this tier waits for the socket's close).
          $.run(this.net.destroyHelper(), $.l(S), $.get(this.CT, C_ERROR, $.l(Q)));
          this.son($, NET_LISTS.L_CLOSE, $.l(S), this.clos($, this.tick("onSocketNTClose", ($2, e2) => {
            $2.run(this.reqDestroyedNoSocketFn(), $2.cast(this.CT, $2.l(e2.a)), $2.cast(this.sockT, $2.l(e2.b)), $2.get(this.CT, C_ERROR, $2.cast(this.CT, $2.l(e2.a))));
          }), "void", { a: $.l(Q), b: $.l(S) }), true);
        });
        $.ret();
      });
      $.run(this.tickOnSocketFn(), $.l(Q), $.l(S));
      this.excReturn($);
      $.run(this.outFlushFn(), $.l(Q));
    });
  }

  /** onSocketNT's _destroy(req, err) */
  private reqDestroyedNoSocketFn(): number {
    return this.fn("reqDestroyed", [this.creqRef(), this.sockRef, this.errRef], [], (f, $) => {
      const [Q, S, ERR0] = [0, 1, 2];
      const ERR = f.local(this.errRef);
      $.put(ERR, $.l(ERR0));
      $.if($.both($.not($.get(this.CT, C_ABORTED, $.l(Q))), $.isNull($.l(ERR))), () => $.put(ERR, this.connReset($, "socket hang up")));
      $.if($.both($.notNull($.l(ERR)), $.orElse($.isNull($.l(S)), $.not($.get(this.sockT, NET_SOCK_HTTP.S_HADERR, $.l(S))))), () => {
        this.emit($, HL.OUT_ERROR, $.l(Q), $.l(ERR));
        this.excReturn($);
      });
      $.set(this.OT, O_CLOSED, $.l(Q), $.i(1));
      this.emit($, HL.OUT_CLOSE, $.l(Q));
    });
  }

  /** tickOnSocket(req, socket) */
  private tickOnSocketFn(): number {
    return this.fn("tickOnSocket", [this.creqRef(), this.sockRef], [], (f, $) => {
      const [Q, S] = [0, 1];
      const P = f.local(this.parserRef());
      const CT = this.CT;
      $.put(P, $.call(this.parserNewFn()));
      this.outSetSocket($, $.l(Q), $.l(S));
      $.run(this.parserInitFn(), $.l(P), $.i(HTTP_RESPONSE), $.nul(EQ_HEAP));
      $.set(this.PT, P_SOCK, $.l(P), $.l(S));
      $.set(this.PT, P_OUTGOING, $.l(P), $.l(Q));
      $.set(CT, C_PARSER, $.l(Q), $.l(P));
      $.set(this.sockT, NET_SOCK_HTTP.S_PARSER, $.l(S), $.l(P));
      $.set(this.sockT, NET_SOCK_HTTP.S_HTTPMSG, $.l(S), $.l(Q));
      $.if($.ge($.get(CT, C_MAXHEADERS, $.l(Q)), $.i(0)), () => $.set(this.PT, P_MAXPAIRS, $.l(P), $.shl($.get(CT, C_MAXHEADERS, $.l(Q)), $.i(1))));
      // parser.joinDuplicateHeaders = req.joinDuplicateHeaders (undefined here)
      this.son($, NET_LISTS.L_DATA, $.l(S), this.hcli($, $.l(S), 0));
      $.run(this.net.dataAddedHelper(), $.l(S));
      this.son($, NET_LISTS.L_END, $.l(S), this.hcli($, $.l(S), 1));
      this.son($, NET_LISTS.L_CLOSE, $.l(S), this.hcli($, $.l(S), 2));
      this.son($, NET_LISTS.L_DRAIN, $.l(S), this.hcli($, $.l(S), 4));
      $.if($.or($.dge($.get(CT, C_TIMEOUT, $.l(Q)), $.d(0)), $.dgt($.get(this.agentT(), A_TIMEOUT, $.get(CT, C_AGENT, $.l(Q))), $.d(0))), () => {
        $.run(this.listenSocketTimeoutFn(), $.l(Q));
      });
      // req.emit('socket', socket): no listener can exist here.
    });
  }

  /** listenSocketTimeout(req) — the socket is assigned here. */
  private listenSocketTimeoutFn(): number {
    return this.fn("listenSocketTimeout", [this.creqRef()], [], (f, $) => {
      const Q = 0;
      $.if($.get(this.CT, C_TIMEOUTCB, $.l(Q)), () => $.ret());
      $.set(this.CT, C_TIMEOUTCB, $.l(Q), $.i(1));
      const s = $.get(this.OT, O_SOCKET, $.l(Q));
      $.if($.notNull(s), () => this.son($, NET_LISTS.L_TIMEOUT, s, this.hcli($, s, 6), true));
    });
  }

  /** emitRequestTimeout (this = socket) */
  private emitRequestTimeoutFn(): number {
    return this.tick("emitRequestTimeout", ($, e) => {
      const m = $.get(this.sockT, NET_SOCK_HTTP.S_HTTPMSG, $.cast(this.sockT, $.l(e.a)));
      $.if($.andThen($.notNull(m), $.test(this.CT, m)), () => this.emit($, HL.OUT_TIMEOUT, $.cast(this.OT, m)));
    });
  }

  /** responseOnTimeout (this = socket): res.emit('timeout') — no listener
   * can exist on a response's 'timeout' here. */
  private responseOnTimeoutFn(): number {
    return this.tick("responseOnTimeout", () => {});
  }

  /** ondrain (this = socket) */
  private cliOnDrainFn(): number {
    return this.tick("ondrain", ($, e) => {
      const m = $.get(this.sockT, NET_SOCK_HTTP.S_HTTPMSG, $.cast(this.sockT, $.l(e.a)));
      $.if($.andThen($.notNull(m), $.both($.not($.get(this.OT, O_FINISHED, $.cast(this.OT, m))), $.get(this.OT, O_NEEDDRAIN, $.cast(this.OT, m)))), () => {
        $.set(this.OT, O_NEEDDRAIN, $.cast(this.OT, m), $.i(0));
        this.emit($, HL.OUT_DRAIN, $.cast(this.OT, m));
      });
    });
  }

  /** The socket's ClientRequest (socket._httpMessage). */
  private sockReq($: A, s: X): X {
    return $.cast(this.CT, $.get(this.sockT, NET_SOCK_HTTP.S_HTTPMSG, s));
  }

  /** socketOnData (the client's, this = socket) */
  private cliSocketOnDataFn(): number {
    return this.closFn("cliSocketOnData", "data", ($, e, f, arg) => {
      const S = f.local(this.sockRef);
      const Q = f.local(this.creqRef());
      const P = f.local(this.parserRef());
      const R = f.local(I32);
      const INC = f.local(this.incRef());
      $.put(S, $.cast(this.sockT, $.l(e.a)));
      $.put(Q, this.sockReq($, $.l(S)));
      $.put(P, $.cast(this.PT, $.get(this.sockT, NET_SOCK_HTTP.S_PARSER, $.l(S))));
      $.put(R, $.call(this.executeFn(), $.l(P), $.l(arg)));
      $.if($.eq($.l(R), $.i(-1)), () => $.ret());
      $.if($.eq($.l(R), $.i(-2)), () => {
        $.run(this.freeParserFn(), $.l(P), $.l(Q), $.l(S));
        this.soff($, NET_LISTS.L_DATA, $.l(S), this.hcli($, $.l(S), 0));
        this.soff($, NET_LISTS.L_END, $.l(S), this.hcli($, $.l(S), 1));
        $.run(this.net.destroyHelper(), $.l(S), $.nul(this.deps.errType()));
        $.set(this.sockT, NET_SOCK_HTTP.S_HADERR, $.get(this.OT, O_SOCKET, $.l(Q)), $.i(1));
        this.emit($, HL.OUT_ERROR, $.l(Q), $.g(this.parseErrGlobal()));
        $.ret();
      });
      $.put(INC, $.get(this.PT, P_INCOMING, $.l(P)));
      $.if($.andThen($.notNull($.l(INC)), $.eq($.get(this.IT, I_UPGRADE, $.l(INC)), $.i(1))), () => {
        // Upgrade / CONNECT: no 'upgrade' / 'connect' listener can exist
        // here, so the socket is destroyed.
        $.set(this.CT, C_RES, $.l(Q), $.l(INC));
        this.soff($, NET_LISTS.L_DATA, $.l(S), this.hcli($, $.l(S), 0));
        this.soff($, NET_LISTS.L_END, $.l(S), this.hcli($, $.l(S), 1));
        this.soff($, NET_LISTS.L_DRAIN, $.l(S), this.hcli($, $.l(S), 4));
        $.if($.get(this.CT, C_TIMEOUTCB, $.l(Q)), () => this.soff($, NET_LISTS.L_TIMEOUT, $.l(S), this.hcli($, $.l(S), 6)));
        this.soff($, NET_LISTS.L_TIMEOUT, $.l(S), this.hcli($, $.l(S), 5));
        $.drop($.call(this.finishFn(), $.l(P)));
        this.excReturn($);
        $.run(this.freeParserFn(), $.l(P), $.l(Q), $.l(S));
        $.run(this.net.destroyHelper(), $.l(S), $.nul(this.deps.errType()));
        $.ret();
      });
      $.if(
        $.andThen(
          $.notNull($.l(INC)),
          $.both($.get(this.IT, I_COMPLETE, $.l(INC)), $.not($.call(this.statusIsInformationalFn(), $.get(this.IT, I_STATUS, $.l(INC))))),
        ),
        () => {
          this.soff($, NET_LISTS.L_DATA, $.l(S), this.hcli($, $.l(S), 0));
          this.soff($, NET_LISTS.L_END, $.l(S), this.hcli($, $.l(S), 1));
          this.soff($, NET_LISTS.L_DRAIN, $.l(S), this.hcli($, $.l(S), 4));
          $.run(this.freeParserFn(), $.l(P), $.l(Q), $.l(S));
        },
      );
    });
  }

  private statusIsInformationalFn(): number {
    return this.fn("statusIsInformational", [I32], [I32], (f, $) => {
      $.do($.both($.both($.lt($.l(0), $.i(200)), $.ge($.l(0), $.i(100))), $.ne($.l(0), $.i(101))));
    });
  }

  /** socketOnEnd (the client's) */
  private cliSocketOnEndFn(): number {
    return this.tick("cliSocketOnEnd", ($, e, f) => {
      const S = f.local(this.sockRef);
      const Q = f.local(this.creqRef());
      const P = f.local(EQ_REF);
      $.put(S, $.cast(this.sockT, $.l(e.a)));
      $.put(Q, this.sockReq($, $.l(S)));
      $.put(P, $.get(this.sockT, NET_SOCK_HTTP.S_PARSER, $.l(S)));
      $.if($.both($.isNull($.get(this.CT, C_RES, $.l(Q))), $.not($.get(this.sockT, NET_SOCK_HTTP.S_HADERR, $.get(this.OT, O_SOCKET, $.l(Q))))), () => {
        $.set(this.sockT, NET_SOCK_HTTP.S_HADERR, $.get(this.OT, O_SOCKET, $.l(Q)), $.i(1));
        this.emit($, HL.OUT_ERROR, $.l(Q), this.connReset($, "socket hang up"));
        this.excReturn($);
      });
      $.if($.notNull($.l(P)), () => {
        $.drop($.call(this.finishFn(), $.cast(this.PT, $.l(P))));
        this.excReturn($);
        $.run(this.freeParserFn(), $.cast(this.PT, $.l(P)), $.l(Q), $.l(S));
      });
      $.run(this.net.destroyHelper(), $.l(S), $.nul(this.deps.errType()));
    });
  }

  /** socketCloseListener (this = socket) */
  private socketCloseListenerFn(): number {
    return this.tick("socketCloseListener", ($, e, f) => {
      const S = f.local(this.sockRef);
      const Q = f.local(this.creqRef());
      const P = f.local(EQ_REF);
      const RES = f.local(this.incRef());
      $.put(S, $.cast(this.sockT, $.l(e.a)));
      $.put(Q, this.sockReq($, $.l(S)));
      $.put(P, $.get(this.sockT, NET_SOCK_HTTP.S_PARSER, $.l(S)));
      $.put(RES, $.get(this.CT, C_RES, $.l(Q)));
      $.set(this.OT, O_DESTROYED, $.l(Q), $.i(1));
      $.if($.notNull($.l(RES)), () => {
        $.if($.not($.get(this.IT, I_COMPLETE, $.l(RES))), () => {
          $.run(this.incDestroyFn(), $.l(RES), this.connReset($, "aborted"));
          this.excReturn($);
        });
        $.set(this.OT, O_CLOSED, $.l(Q), $.i(1));
        this.emit($, HL.OUT_CLOSE, $.l(Q));
        this.excReturn($);
        $.if($.both($.not($.get(this.IT, I_ABORTED, $.l(RES))), $.call(this.incReadableFn(), $.l(RES))), () => {
          $.run(this.incPushNullFn(), $.l(RES));
        });
      }, () => {
        $.if($.not($.get(this.sockT, NET_SOCK_HTTP.S_HADERR, $.get(this.OT, O_SOCKET, $.l(Q)))), () => {
          $.set(this.sockT, NET_SOCK_HTTP.S_HADERR, $.get(this.OT, O_SOCKET, $.l(Q)), $.i(1));
          this.emit($, HL.OUT_ERROR, $.l(Q), this.connReset($, "socket hang up"));
          this.excReturn($);
        });
        $.set(this.OT, O_CLOSED, $.l(Q), $.i(1));
        this.emit($, HL.OUT_CLOSE, $.l(Q));
        this.excReturn($);
      });
      $.set(this.OT, O_OD, $.l(Q), $.nul(this.odArrT));
      $.set(this.OT, O_OD_N, $.l(Q), $.i(0));
      $.if($.notNull($.l(P)), () => {
        $.drop($.call(this.finishFn(), $.cast(this.PT, $.l(P))));
        this.excReturn($);
        $.run(this.freeParserFn(), $.cast(this.PT, $.l(P)), $.l(Q), $.l(S));
      });
    });
  }

  /** socketErrorListener(err) (this = socket) */
  private socketErrorListenerFn(): number {
    return this.closFn("socketErrorListener", "err", ($, e, f, arg) => {
      const S = f.local(this.sockRef);
      const M = f.local(EQ_REF);
      const P = f.local(EQ_REF);
      $.put(S, $.cast(this.sockT, $.l(e.a)));
      $.put(M, $.get(this.sockT, NET_SOCK_HTTP.S_HTTPMSG, $.l(S)));
      $.if($.notNull($.l(M)), () => {
        $.set(this.sockT, NET_SOCK_HTTP.S_HADERR, $.l(S), $.i(1));
        this.emit($, HL.OUT_ERROR, $.cast(this.OT, $.l(M)), $.l(arg));
        this.excReturn($);
      });
      $.put(P, $.get(this.sockT, NET_SOCK_HTTP.S_PARSER, $.l(S)));
      $.if($.notNull($.l(P)), () => {
        $.drop($.call(this.finishFn(), $.cast(this.PT, $.l(P))));
        this.excReturn($);
        $.run(this.freeParserFn(), $.cast(this.PT, $.l(P)), $.l(M), $.l(S));
      });
      this.soff($, NET_LISTS.L_DATA, $.l(S), this.hcli($, $.l(S), 0));
      this.soff($, NET_LISTS.L_END, $.l(S), this.hcli($, $.l(S), 1));
      $.run(this.net.destroyHelper(), $.l(S), $.nul(this.deps.errType()));
    });
  }

  /** parserOnIncomingClient(res, shouldKeepAlive) (this = parser) */
  private parserOnIncomingClientFn(): number {
    return this.fn("parserOnIncomingClient", [this.parserRef(), this.incRef(), I32], [I32], (f, $) => {
      const [P, RES, KEEP] = [0, 1, 2];
      const CT = this.CT;
      const IT = this.IT;
      const S = f.local(this.sockRef);
      const Q = f.local(this.creqRef());
      const R = f.local(I32);
      $.put(S, $.get(this.PT, P_SOCK, $.l(P)));
      $.put(Q, this.sockReq($, $.l(S)));
      $.if($.notNull($.get(CT, C_RES, $.l(Q))), () => {
        $.run(this.net.destroyHelper(), $.l(S), $.nul(this.deps.errType()));
        $.if($.notNull($.get(this.sockT, NET_SOCK_HTTP.S_PARSER, $.l(S))), () => {
          const sp = $.cast(this.PT, $.get(this.sockT, NET_SOCK_HTTP.S_PARSER, $.l(S)));
          $.set(this.PT, P_INCOMING, sp, $.get(CT, C_RES, $.l(Q)));
          $.set(IT, I_SKIP, $.get(CT, C_RES, $.l(Q)), $.i(1));
        });
        $.ret($.i(0));
      });
      $.set(CT, C_RES, $.l(Q), $.l(RES));
      $.if($.eq($.get(IT, I_UPGRADE, $.l(RES)), $.i(1)), () => $.ret($.i(2)));
      $.if(this.streq($, $.get(CT, C_METHOD, $.l(Q)), this.lit($, "CONNECT")), () => {
        $.set(IT, I_UPGRADE, $.l(RES), $.i(1));
        $.ret($.i(2));
      });
      $.if($.call(this.statusIsInformationalFn(), $.get(IT, I_STATUS, $.l(RES))), () => {
        // 'continue' / 'information': no listener can exist here.
        $.set(CT, C_RES, $.l(Q), $.nul(IT));
        $.ret($.i(1));
      });
      $.if($.both($.both($.get(this.OT, O_KEEPALIVE, $.l(Q)), $.not($.l(KEEP))), $.not($.get(CT, C_UPGRADEORCONNECT, $.l(Q)))), () =>
        $.set(this.OT, O_KEEPALIVE, $.l(Q), $.i(0)),
      );
      $.set(CT, C_RES, $.l(Q), $.l(RES));
      $.set(IT, I_REQ, $.l(RES), $.l(Q));
      this.on($, HL.INC_END, $.l(RES), this.clos($, this.responseOnEndFn(), "void", { a: $.l(RES) }));
      this.on($, HL.OUT_FINISH, $.l(Q), this.clos($, this.requestOnFinishFn(), "void", { a: $.l(Q) }));
      this.son($, NET_LISTS.L_TIMEOUT, $.l(S), this.hcli($, $.l(S), 5));
      $.if($.get(CT, C_ABORTED, $.l(Q)), () => $.run(this.incDumpFn(), $.l(RES)), () => {
        $.put(R, $.call(this.emitFn(HL.CREQ_RESPONSE), $.l(Q), $.l(RES)));
        this.excReturn($, $.i(0));
        $.if($.not($.l(R)), () => $.run(this.incDumpFn(), $.l(RES)));
      });
      $.if(this.streq($, $.get(CT, C_METHOD, $.l(Q)), this.lit($, "HEAD")), () => $.ret($.i(1)));
      $.if($.eq($.get(IT, I_STATUS, $.l(RES)), $.i(304)), () => {
        $.set(IT, I_COMPLETE, $.l(RES), $.i(1));
        $.ret($.i(1));
      });
      $.do($.i(0));
    });
  }

  /** responseOnEnd (this = res) */
  private responseOnEndFn(): number {
    return this.tick("responseOnEnd", ($, e, f) => {
      const RES = f.local(this.incRef());
      const Q = f.local(this.creqRef());
      const S = f.local(this.sockRef);
      $.put(RES, $.cast(this.IT, $.l(e.a)));
      $.put(Q, $.cast(this.CT, $.get(this.IT, I_REQ, $.l(RES))));
      $.put(S, $.get(this.OT, O_SOCKET, $.l(Q)));
      $.if($.notNull($.l(S)), () => {
        $.if($.get(this.CT, C_TIMEOUTCB, $.l(Q)), () => this.soff($, NET_LISTS.L_TIMEOUT, $.l(S), this.hcli($, $.l(S), 6)));
        this.soff($, NET_LISTS.L_TIMEOUT, $.l(S), this.hcli($, $.l(S), 5));
      });
      $.set(this.CT, C_ENDED, $.l(Q), $.i(1));
      $.if($.not($.get(this.OT, O_KEEPALIVE, $.l(Q))), () => {
        $.if($.call(this.net.writableGetterHelper(), $.l(S)), () => $.run(this.net.destroySoonHelper(), $.l(S)));
      }, () => {
        $.if($.both($.call(this.outWritableFinishedFn(), $.l(Q)), $.not($.get(this.IT, I_ABORTED, $.l(RES)))), () => $.run(this.responseKeepAliveFn(), $.l(Q)));
      });
    });
  }

  /** requestOnFinish (this = req) */
  private requestOnFinishFn(): number {
    return this.tick("requestOnFinish", ($, e) => {
      const q = $.cast(this.CT, $.l(e.a));
      $.if($.both($.both($.get(this.OT, O_KEEPALIVE, q), $.get(this.CT, C_ENDED, q)), $.not($.get(this.OT, O_DESTROYED, q))), () =>
        $.run(this.responseKeepAliveFn(), q),
      );
    });
  }

  /** responseKeepAlive(req) */
  private responseKeepAliveFn(): number {
    return this.fn("responseKeepAlive", [this.creqRef()], [], (f, $) => {
      const Q = 0;
      const S = f.local(this.sockRef);
      $.put(S, $.get(this.OT, O_SOCKET, $.l(Q)));
      $.if($.get(this.CT, C_TIMEOUTCB, $.l(Q)), () => {
        // socket.setTimeout(0, req.timeoutCb)
        $.run(this.net.setTimeoutHelper(), $.l(S), $.d(0));
        this.soff($, NET_LISTS.L_TIMEOUT, $.l(S), this.hcli($, $.l(S), 6));
        $.set(this.CT, C_TIMEOUTCB, $.l(Q), $.i(0));
      });
      this.soff($, NET_LISTS.L_CLOSE, $.l(S), this.hcli($, $.l(S), 2));
      this.soff($, NET_LISTS.L_ERROR, $.l(S), this.hcli($, $.l(S), 3));
      this.soff($, NET_LISTS.L_DATA, $.l(S), this.hcli($, $.l(S), 0));
      this.soff($, NET_LISTS.L_END, $.l(S), this.hcli($, $.l(S), 1));
      this.nextTick($, this.tick("emitFreeNT", ($2, e) => {
        const q = $2.cast(this.CT, $2.l(e.a));
        $2.set(this.OT, O_CLOSED, q, $2.i(1));
        this.emit($2, HL.OUT_CLOSE, q);
        this.excReturn($2);
        $2.if($2.notNull($2.get(this.OT, O_SOCKET, q)), () => $2.drop(this.semit($2, NET_LISTS.L_FREE, $2.get(this.OT, O_SOCKET, q))));
      }), { a: $.l(Q) });
      $.set(this.OT, O_DESTROYED, $.l(Q), $.i(1));
      $.if($.notNull($.get(this.CT, C_RES, $.l(Q))), () => $.set(this.IT, I_SOCK, $.get(this.CT, C_RES, $.l(Q)), $.nul(this.sockT)));
    });
  }

  /** ClientRequest.prototype.destroy(err) */
  clientDestroyFn(): number {
    return this.fn("clientDestroy", [this.creqRef(), this.errRef], [], (f, $) => {
      const [Q, ERR] = [0, 1];
      $.if($.get(this.OT, O_DESTROYED, $.l(Q)), () => $.ret());
      $.set(this.OT, O_DESTROYED, $.l(Q), $.i(1));
      $.if($.notNull($.get(this.CT, C_RES, $.l(Q))), () => $.run(this.incDumpFn(), $.get(this.CT, C_RES, $.l(Q))));
      $.set(this.CT, C_ERROR, $.l(Q), $.l(ERR));
      $.if($.notNull($.get(this.OT, O_SOCKET, $.l(Q))), () => $.run(this.net.destroyHelper(), $.get(this.OT, O_SOCKET, $.l(Q)), $.l(ERR)));
    });
  }

  /* ── http.Agent (lib/_http_agent.js) ─────────────────────────────── */

  private get AT(): number {
    return this.agentT();
  }

  /** new Agent(options) — the lowered options: numbers < 0 are unset
   * (each reads Node's `|| default`). */
  agentNewFn(): number {
    return this.fn("agentNew", [I32, F64, F64, F64, F64, F64, I32], [this.agentRef()], (f, $) => {
      const [KEEP, KAMS, MAXS, MAXF, TMO, PORT, SECURE] = [0, 1, 2, 3, 4, 5, 6];
      const c = f.c;
      const orDefault = (v: number, d: number): X => $.sel(F64, $.dgt($.l(v), $.d(0)), $.l(v), $.d(d));
      c.localGet(KEEP); // A_KEEPALIVE
      orDefault(KAMS, 1000)(); // A_KAMSECS
      orDefault(MAXS, Infinity)(); // A_MAXSOCKETS
      orDefault(MAXF, 256)(); // A_MAXFREE
      c.f64Const(Infinity); // A_MAXTOTAL
      c.f64Const(0); // A_TOTAL
      c.i32Const(0); // A_FIFO (scheduling 'lifo')
      $.do($.sel(F64, $.dgt($.l(TMO), $.d(0)), $.l(TMO), $.d(-1))); // A_TIMEOUT
      $.do($.sel(F64, $.l(SECURE), $.d(443), $.d(80))); // A_DEFPORT (options.defaultPort || 80)
      this.deps.pushStrLit(c, "http:"); // A_PROTOCOL
      c.i32Const(1); // A_NODELAY
      c.f64Const(1000); // A_KABUFFER
      c.refNull(this.amapArrT);
      c.i32Const(0);
      c.refNull(this.amapArrT);
      c.i32Const(0);
      c.refNull(this.amapArrT);
      c.i32Const(0);
      $.do($.sel(F64, $.dgt($.l(PORT), $.d(0)), $.l(PORT), $.d(-1))); // A_OPTPORT
      c.localGet(SECURE);
      c.structNew(this.AT);
    });
  }

  /** The global agent: new Agent({ keepAlive: true, scheduling: 'lifo',
   * timeout: 5000 }). */
  globalAgentFn(): number {
    return this.fn("globalAgent", [], [this.agentRef()], (f, $) => {
      const g = this.g();
      $.if($.isNull($.g(g.globalAgent)), () => $.gput(g.globalAgent, $.call(this.agentNewFn(), $.i(1), $.d(-1), $.d(-1), $.d(-1), $.d(5000), $.d(-1), $.i(0))));
      $.do($.g(g.globalAgent));
    });
  }

  /** getName(options) for the request options (host, port; no
   * localAddress / family / socketPath reach here). */
  private agentNameFn(): number {
    return this.fn("agentName", [this.agentRef(), this.creqRef()], [this.strRef], (f, $) => {
      const [AG, Q] = [0, 1];
      const PORT = f.local(F64);
      // options = { ...options, ...this.options }: an agent's own port wins.
      $.put(PORT, $.sel(F64, $.dgt($.get(this.AT, A_OPTPORT, $.l(AG)), $.d(0)), $.get(this.AT, A_OPTPORT, $.l(AG)), $.get(this.CT, C_PORT, $.l(Q))));
      $.do(this.cat($, $.get(this.CT, C_HOST, $.l(Q)), this.lit($, ":"), $.sel(this.strRef, $.dne($.l(PORT), $.d(0)), this.num2str($, $.l(PORT)), this.lit($, "")), this.lit($, ":")));
    });
  }

  /* the requests / sockets / freeSockets objects: ordered keys */

  /** The $amap for `name` in the table at `field`, or null. */
  private amapGetFn(field: number): number {
    return this.fn(`amapGet${field}`, [this.agentRef(), this.strRef], [this.ref(this.amapT)], (f, $) => {
      const [AG, N] = [0, 1];
      const I = f.local(I32);
      $.for(I, $.i(0), $.get(this.AT, field + 1, $.l(AG)), () => {
        const e = $.aget(this.amapArrT, $.get(this.AT, field, $.l(AG)), $.l(I));
        $.if(this.streq($, $.get(this.amapT, M_NAME, e), $.l(N)), () => $.ret(e));
      });
      $.do($.nul(this.amapT));
    });
  }

  /** this[table][name] ||= [] -> the $amap. */
  private amapEnsureFn(field: number): number {
    return this.fn(`amapEnsure${field}`, [this.agentRef(), this.strRef], [this.ref(this.amapT)], (f, $) => {
      const [AG, N] = [0, 1];
      const E = f.local(this.ref(this.amapT));
      const NA = f.local(this.ref(this.amapArrT));
      $.put(E, $.call(this.amapGetFn(field), $.l(AG), $.l(N)));
      $.if($.notNull($.l(E)), () => $.ret($.l(E)));
      $.put(E, $.new_(this.amapT, $.l(N), $.anew(this.eqArrT, $.i(2)), $.i(0), $.i(0)));
      $.if($.isNull($.get(this.AT, field, $.l(AG))), () => $.set(this.AT, field, $.l(AG), $.anew(this.amapArrT, $.i(2))));
      const arr = $.get(this.AT, field, $.l(AG));
      const n = $.get(this.AT, field + 1, $.l(AG));
      $.if($.geU(n, $.alen(arr)), () => {
        $.put(NA, $.anew(this.amapArrT, $.shl($.alen(arr), $.i(1))));
        $.do($.l(NA), $.i(0), arr, $.i(0), n);
        f.c.arrayCopy(this.amapArrT, this.amapArrT);
        $.set(this.AT, field, $.l(AG), $.l(NA));
      });
      $.aset(this.amapArrT, arr, n, $.l(E));
      $.set(this.AT, field + 1, $.l(AG), $.add(n, $.i(1)));
      $.do($.l(E));
    });
  }

  /** delete this[table][name] */
  private amapDeleteFn(field: number): number {
    return this.fn(`amapDelete${field}`, [this.agentRef(), this.strRef], [], (f, $) => {
      const [AG, N] = [0, 1];
      const I = f.local(I32);
      const arr = $.get(this.AT, field, $.l(AG));
      const n = $.get(this.AT, field + 1, $.l(AG));
      $.for(I, $.i(0), n, () => {
        $.if(this.streq($, $.get(this.amapT, M_NAME, $.aget(this.amapArrT, arr, $.l(I))), $.l(N)), () => {
          $.do(arr, $.l(I), arr, $.add($.l(I), $.i(1)), $.sub($.sub(n, $.l(I)), $.i(1)));
          f.c.arrayCopy(this.amapArrT, this.amapArrT);
          $.set(this.AT, field + 1, $.l(AG), $.sub(n, $.i(1)));
          $.ret();
        });
      });
    });
  }

  /** list.push(v) on an $amap */
  private amapPushFn(): number {
    return this.fn("amapPush", [this.ref(this.amapT), EQ_REF], [], (f, $) => {
      const [E, V] = [0, 1];
      const NA = f.local(this.ref(this.eqArrT));
      const arr = $.get(this.amapT, M_ARR, $.l(E));
      const n = $.get(this.amapT, M_N, $.l(E));
      $.if($.geU(n, $.alen(arr)), () => {
        $.put(NA, $.anew(this.eqArrT, $.add($.shl($.alen(arr), $.i(1)), $.i(1))));
        $.do($.l(NA), $.i(0), arr, $.i(0), n);
        f.c.arrayCopy(this.eqArrT, this.eqArrT);
        $.set(this.amapT, M_ARR, $.l(E), $.l(NA));
      });
      $.aset(this.eqArrT, $.get(this.amapT, M_ARR, $.l(E)), n, $.l(V));
      $.set(this.amapT, M_N, $.l(E), $.add(n, $.i(1)));
    });
  }

  /** list.splice(i, 1) on an $amap -> the removed value. */
  private amapRemoveAtFn(): number {
    return this.fn("amapRemoveAt", [this.ref(this.amapT), I32], [EQ_REF], (f, $) => {
      const [E, I] = [0, 1];
      const V = f.local(EQ_REF);
      const arr = $.get(this.amapT, M_ARR, $.l(E));
      const n = $.get(this.amapT, M_N, $.l(E));
      $.put(V, $.aget(this.eqArrT, arr, $.l(I)));
      $.do(arr, $.l(I), arr, $.add($.l(I), $.i(1)), $.sub($.sub(n, $.l(I)), $.i(1)));
      f.c.arrayCopy(this.eqArrT, this.eqArrT);
      $.set(this.amapT, M_N, $.l(E), $.sub(n, $.i(1)));
      $.aset(this.eqArrT, arr, $.get(this.amapT, M_N, $.l(E)), $.nul(EQ_HEAP));
      $.do($.l(V));
    });
  }

  /** list.indexOf(v) on an $amap */
  private amapIndexOfFn(): number {
    return this.fn("amapIndexOf", [this.ref(this.amapT), EQ_REF], [I32], (f, $) => {
      const [E, V] = [0, 1];
      const I = f.local(I32);
      $.for(I, $.i(0), $.get(this.amapT, M_N, $.l(E)), () => {
        $.if($.refEq($.aget(this.eqArrT, $.get(this.amapT, M_ARR, $.l(E)), $.l(I)), $.l(V)), () => $.ret($.l(I)));
      });
      $.do($.i(-1));
    });
  }

  private amapLen($: A, e: X): X {
    return $.sel(I32, $.isNull(e), $.i(0), $.get(this.amapT, M_N, e));
  }

  /** Agent.prototype.addRequest(req, options) */
  private agentAddRequestFn(): number {
    return this.fn("addRequest", [this.agentRef(), this.creqRef()], [], (f, $) => {
      const [AG, Q] = [0, 1];
      const AT = this.AT;
      const NAME = f.local(this.strRef);
      const FREE = f.local(this.ref(this.amapT));
      const S = f.local(this.sockRef);
      const FREELEN = f.local(I32);
      const SOCKLEN = f.local(I32);
      $.put(NAME, $.call(this.agentNameFn(), $.l(AG), $.l(Q)));
      $.drop($.call(this.amapEnsureFn(A_SOCKETS), $.l(AG), $.l(NAME)));
      $.put(FREE, $.call(this.amapGetFn(A_FREE), $.l(AG), $.l(NAME)));
      $.if($.notNull($.l(FREE)), () => {
        $.while(
          $.andThen($.gt($.get(this.amapT, M_N, $.l(FREE)), $.i(0)), $.call(this.net.destroyedHelper(), $.cast(this.sockT, $.aget(this.eqArrT, $.get(this.amapT, M_ARR, $.l(FREE)), $.i(0))))),
          () => $.drop($.call(this.amapRemoveAtFn(), $.l(FREE), $.i(0))),
        );
        $.if($.gt($.get(this.amapT, M_N, $.l(FREE)), $.i(0)), () => {
          $.put(S, $.cast(this.sockT, $.call(this.amapRemoveAtFn(), $.l(FREE), $.sel(I32, $.get(AT, A_FIFO, $.l(AG)), $.i(0), $.sub($.get(this.amapT, M_N, $.l(FREE)), $.i(1))))));
        });
        $.if($.eq($.get(this.amapT, M_N, $.l(FREE)), $.i(0)), () => $.run(this.amapDeleteFn(A_FREE), $.l(AG), $.l(NAME)));
      });
      $.put(FREELEN, this.amapLen($, $.l(FREE)));
      $.put(SOCKLEN, $.add($.l(FREELEN), $.get(this.amapT, M_N, $.call(this.amapGetFn(A_SOCKETS), $.l(AG), $.l(NAME)))));
      $.if($.notNull($.l(S)), () => {
        // reuseSocket, setRequestSocket, sockets[name].push(socket)
        this.soff($, NET_LISTS.L_ERROR, $.l(S), this.hcli($, $.l(S), 11));
        $.set(this.sockT, NET_SOCK_HTTP.S_FREEGUARD, $.l(S), $.i(0));
        $.set(this.CT, C_REUSED, $.l(Q), $.i(1));
        $.run(this.net.refHelper(true), $.l(S));
        $.run(this.setRequestSocketFn(), $.l(AG), $.l(Q), $.l(S));
        $.run(this.amapPushFn(), $.call(this.amapGetFn(A_SOCKETS), $.l(AG), $.l(NAME)), $.l(S));
        $.ret();
      });
      $.if($.both($.dlt($.i2d($.l(SOCKLEN)), $.get(AT, A_MAXSOCKETS, $.l(AG))), $.dlt($.get(AT, A_TOTAL, $.l(AG)), $.get(AT, A_MAXTOTAL, $.l(AG)))), () => {
        $.put(S, $.call(this.agentCreateSocketFn(), $.l(AG), $.l(Q)));
        this.excReturn($);
        $.run(this.setRequestSocketFn(), $.l(AG), $.l(Q), $.l(S));
        $.ret();
      });
      // wait for a socket
      $.run(this.amapPushFn(), $.call(this.amapEnsureFn(A_REQUESTS), $.l(AG), $.l(NAME)), $.l(Q));
    });
  }

  /** Agent.prototype.createSocket(req, options, cb) -> the socket (the
   * callback's work, which oncreate does synchronously, is done here). */
  private agentCreateSocketFn(): number {
    return this.fn("createSocket", [this.agentRef(), this.creqRef()], [this.sockRef], (f, $) => {
      const [AG, Q] = [0, 1];
      const AT = this.AT;
      const NAME = f.local(this.strRef);
      const S = f.local(this.sockRef);
      const TMO = f.local(F64);
      const PORT = f.local(F64);
      const H = f.local(this.ref(this.hcliT));
      // timeout = req.timeout || this.options.timeout || undefined
      $.put(TMO, $.get(this.CT, C_TIMEOUT, $.l(Q)));
      $.if($.not($.dgt($.l(TMO), $.d(0))), () => $.put(TMO, $.get(AT, A_TIMEOUT, $.l(AG))));
      $.if($.not($.dgt($.l(TMO), $.d(0))), () => $.put(TMO, $.d(0)));
      $.put(NAME, $.call(this.agentNameFn(), $.l(AG), $.l(Q)));
      $.put(PORT, $.sel(F64, $.dgt($.get(AT, A_OPTPORT, $.l(AG)), $.d(0)), $.get(AT, A_OPTPORT, $.l(AG)), $.get(this.CT, C_PORT, $.l(Q))));
      // this.createConnection(options, oncreate) = net.createConnection
      $.put(S, $.call(this.net.connectExHelper(), $.l(PORT), $.get(this.CT, C_HOST, $.l(Q)), $.get(AT, A_NODELAY, $.l(AG)), $.l(TMO)));
      this.excReturn($, $.nul(this.sockT));
      $.if($.get(AT, A_KEEPALIVE, $.l(AG)), () => $.run(this.net.setKeepAliveHelper(), $.l(S), $.i(1)));
      // oncreate(null, s)
      $.run(this.amapPushFn(), $.call(this.amapEnsureFn(A_SOCKETS), $.l(AG), $.l(NAME)), $.l(S));
      $.set(AT, A_TOTAL, $.l(AG), $.dadd($.get(AT, A_TOTAL, $.l(AG)), $.d(1)));
      // installListeners(agent, s, options)
      $.put(H, $.call(this.hcliFn(), $.l(S)));
      $.set(this.hcliT, 7, $.l(H), this.clos($, this.agentOnFreeFn(), "void", { a: $.l(AG), b: $.l(S), c: $.l(NAME) }));
      $.set(this.hcliT, 8, $.l(H), this.clos($, this.agentOnCloseFn(), "void", { a: $.l(AG), b: $.l(S), c: $.l(NAME) }));
      $.set(this.hcliT, 9, $.l(H), this.clos($, this.agentOnTimeoutFn(), "void", { a: $.l(AG), b: $.l(S) }));
      $.set(this.hcliT, 10, $.l(H), this.clos($, this.agentOnRemoveFn(), "void", { a: $.l(AG), b: $.l(S), c: $.l(NAME) }));
      this.son($, NET_LISTS.L_FREE, $.l(S), $.get(this.hcliT, 7, $.l(H)));
      this.son($, NET_LISTS.L_CLOSE, $.l(S), $.get(this.hcliT, 8, $.l(H)));
      this.son($, NET_LISTS.L_TIMEOUT, $.l(S), $.get(this.hcliT, 9, $.l(H)));
      this.son($, NET_LISTS.L_AGENTRM, $.l(S), $.get(this.hcliT, 10, $.l(H)));
      $.do($.l(S));
    });
  }

  /** setRequestSocket(agent, req, socket) */
  private setRequestSocketFn(): number {
    return this.fn("setRequestSocket", [this.agentRef(), this.creqRef(), this.sockRef], [], (f, $) => {
      const [AG, Q, S] = [0, 1, 2];
      const AGT = f.local(F64);
      $.run(this.onSocketFn(), $.l(Q), $.l(S));
      $.put(AGT, $.sel(F64, $.dgt($.get(this.AT, A_TIMEOUT, $.l(AG)), $.d(0)), $.get(this.AT, A_TIMEOUT, $.l(AG)), $.d(0)));
      $.if($.or($.dlt($.get(this.CT, C_TIMEOUT, $.l(Q)), $.d(0)), $.deq($.get(this.CT, C_TIMEOUT, $.l(Q)), $.l(AGT))), () => $.ret());
      $.run(this.net.setTimeoutHelper(), $.l(S), $.get(this.CT, C_TIMEOUT, $.l(Q)));
    });
  }

  /** onFree: agent.emit('free', s, options) -> the Agent constructor's
   * 'free' listener. */
  private agentOnFreeFn(): number {
    return this.tick("agentOnFree", ($, e, f) => {
      const AG = f.local(this.agentRef());
      const S = f.local(this.sockRef);
      const NAME = f.local(this.strRef);
      const REQS = f.local(this.ref(this.amapT));
      const Q = f.local(this.creqRef());
      const M = f.local(EQ_REF);
      const FREE = f.local(this.ref(this.amapT));
      const FREELEN = f.local(I32);
      const COUNT = f.local(I32);
      const AT = this.AT;
      $.put(AG, $.cast(AT, $.l(e.a)));
      $.put(S, $.cast(this.sockT, $.l(e.b)));
      $.put(NAME, $.cast(this.strT, $.l(e.c)));
      $.if($.not($.call(this.net.writableGetterHelper(), $.l(S))), () => {
        $.run(this.net.destroyHelper(), $.l(S), $.nul(this.deps.errType()));
        $.ret();
      });
      $.put(REQS, $.call(this.amapGetFn(A_REQUESTS), $.l(AG), $.l(NAME)));
      $.if($.andThen($.notNull($.l(REQS)), $.gt($.get(this.amapT, M_N, $.l(REQS)), $.i(0))), () => {
        $.put(Q, $.cast(this.CT, $.call(this.amapRemoveAtFn(), $.l(REQS), $.i(0))));
        $.run(this.setRequestSocketFn(), $.l(AG), $.l(Q), $.l(S));
        $.if($.eq($.get(this.amapT, M_N, $.l(REQS)), $.i(0)), () => $.run(this.amapDeleteFn(A_REQUESTS), $.l(AG), $.l(NAME)));
        $.ret();
      });
      $.put(M, $.get(this.sockT, NET_SOCK_HTTP.S_HTTPMSG, $.l(S)));
      $.if(
        $.orElse($.isNull($.l(M)), $.orElse($.not($.get(this.OT, O_KEEPALIVE, $.cast(this.OT, $.l(M)))), $.not($.get(AT, A_KEEPALIVE, $.l(AG))))),
        () => {
          $.run(this.net.destroyHelper(), $.l(S), $.nul(this.deps.errType()));
          $.ret();
        },
      );
      $.put(FREE, $.call(this.amapGetFn(A_FREE), $.l(AG), $.l(NAME)));
      $.put(FREELEN, this.amapLen($, $.l(FREE)));
      $.put(COUNT, $.add($.l(FREELEN), this.amapLen($, $.call(this.amapGetFn(A_SOCKETS), $.l(AG), $.l(NAME)))));
      $.if(
        $.orElse(
          $.or($.dgt($.get(AT, A_TOTAL, $.l(AG)), $.get(AT, A_MAXTOTAL, $.l(AG))), $.dgt($.i2d($.l(COUNT)), $.get(AT, A_MAXSOCKETS, $.l(AG)))),
          $.orElse($.dge($.i2d($.l(FREELEN)), $.get(AT, A_MAXFREE, $.l(AG))), $.not($.call(this.keepSocketAliveFn(), $.l(AG), $.l(S)))),
        ),
        () => {
          $.run(this.net.destroyHelper(), $.l(S), $.nul(this.deps.errType()));
          $.ret();
        },
      );
      // this.freeSockets[name] = freeSockets (the key now, before removeSocket)
      $.put(FREE, $.call(this.amapEnsureFn(A_FREE), $.l(AG), $.l(NAME)));
      $.set(this.sockT, NET_SOCK_HTTP.S_HTTPMSG, $.l(S), $.nul(EQ_HEAP));
      $.run(this.agentRemoveSocketFn(), $.l(AG), $.l(S), $.l(NAME));
      this.excReturn($);
      this.son($, NET_LISTS.L_ERROR, $.l(S), this.hcli($, $.l(S), 11), true);
      // installFreeSocketDataGuard(socket)
      $.if($.gt($.call(this.net.rlenHelper(), $.l(S)), $.i(0)), () => $.run(this.net.destroyHelper(), $.l(S), $.nul(this.deps.errType())), () => {
        $.set(this.sockT, NET_SOCK_HTTP.S_FREEGUARD, $.l(S), $.i(1));
        $.if($.both($.get(this.sockT, NET_SOCK_HTTP.S_HAS_HANDLE, $.l(S)), $.not($.get(this.sockT, NET_SOCK_HTTP.S_READING, $.l(S)))), () => {
          $.run(this.net.readStartHandleHelper(), $.l(S));
        });
      });
      $.run(this.amapPushFn(), $.l(FREE), $.l(S));
    });
  }

  /** keepSocketAlive(socket) */
  private keepSocketAliveFn(): number {
    return this.fn("keepSocketAlive", [this.agentRef(), this.sockRef], [I32], (f, $) => {
      const [AG, S] = [0, 1];
      const AT = this.AT;
      const AGT = f.local(F64);
      const CAN = f.local(I32);
      const M = f.local(EQ_REF);
      const HINT = f.local(this.strRef);
      const I = f.local(I32);
      const V = f.local(F64);
      const CH = f.local(I32);
      const HT = f.local(F64);
      $.run(this.net.setKeepAliveHelper(), $.l(S), $.i(1));
      $.run(this.net.refHelper(false), $.l(S));
      $.put(AGT, $.sel(F64, $.dgt($.get(AT, A_TIMEOUT, $.l(AG)), $.d(0)), $.get(AT, A_TIMEOUT, $.l(AG)), $.d(0)));
      $.put(CAN, $.i(1));
      $.put(M, $.get(this.sockT, NET_SOCK_HTTP.S_HTTPMSG, $.l(S)));
      $.if($.andThen($.andThen($.notNull($.l(M)), $.test(this.CT, $.l(M))), $.notNull($.get(this.CT, C_RES, $.cast(this.CT, $.l(M))))), () => {
        $.put(HINT, $.call(this.incHeaderFn(), $.get(this.CT, C_RES, $.cast(this.CT, $.l(M))), this.lit($, "keep-alive")));
        $.if($.andThen($.notNull($.l(HINT)), $.gt($.alen($.l(HINT)), $.i(0))), () => {
          // /^timeout=(\d+)/
          $.if($.call(this.startsWithFn(), $.l(HINT), this.lit($, "timeout=")), () => {
            $.put(I, $.i(8));
            $.put(V, $.d(0));
            $.while($.andThen($.lt($.l(I), $.alen($.l(HINT))), $.raw((c) => {
              c.localGet(HINT);
              c.localGet(I);
              c.arrayGetU(this.strT);
              c.localTee(CH);
              c.i32Const(48);
              c.i32GeS();
              c.localGet(CH);
              c.i32Const(57);
              c.i32LeS();
              c.i32And();
            })), () => {
              $.put(V, $.dadd($.raw((c) => {
                c.localGet(V);
                c.f64Const(10);
                c.f64Mul();
              }), $.i2d($.sub($.l(CH), $.i(48)))));
              $.put(I, $.add($.l(I), $.i(1)));
            });
            $.if($.gt($.l(I), $.i(8)), () => {
              $.put(HT, $.dsub($.raw((c) => {
                c.localGet(V);
                c.f64Const(1000);
                c.f64Mul();
              }), $.get(AT, A_KABUFFER, $.l(AG))));
              $.if($.not($.dgt($.l(HT), $.d(0))), () => $.put(HT, $.d(0)));
              $.if($.deq($.l(HT), $.d(0)), () => $.put(CAN, $.i(0)), () => {
                $.if($.dlt($.l(HT), $.l(AGT)), () => $.put(AGT, $.l(HT)));
              });
            });
          });
        });
      });
      $.if($.dne($.get(this.sockT, NET_SOCK_HTTP.S_TIMEOUT, $.l(S)), $.l(AGT)), () => $.run(this.net.setTimeoutHelper(), $.l(S), $.l(AGT)));
      $.do($.l(CAN));
    });
  }

  private startsWithFn(): number {
    return this.fn("startsWith", [this.strRef, this.strRef], [I32], (f, $) => {
      const I = f.local(I32);
      $.if($.lt($.alen($.l(0)), $.alen($.l(1))), () => $.ret($.i(0)));
      $.for(I, $.i(0), $.alen($.l(1)), () => {
        $.if($.ne($.agetU(this.strT, $.l(0), $.l(I)), $.agetU(this.strT, $.l(1), $.l(I))), () => $.ret($.i(0)));
      });
      $.do($.i(1));
    });
  }

  /** onClose: totalSocketCount--, removeSocket(s, options). */
  private agentOnCloseFn(): number {
    return this.tick("agentOnClose", ($, e) => {
      const ag = $.cast(this.AT, $.l(e.a));
      $.set(this.AT, A_TOTAL, ag, $.dsub($.get(this.AT, A_TOTAL, ag), $.d(1)));
      $.run(this.agentRemoveSocketFn(), ag, $.cast(this.sockT, $.l(e.b)), $.cast(this.strT, $.l(e.c)));
    });
  }

  /** onTimeout: a socket in any freeSockets list is destroyed. */
  private agentOnTimeoutFn(): number {
    return this.tick("agentOnTimeout", ($, e, f) => {
      const AG = f.local(this.agentRef());
      const I = f.local(I32);
      $.put(AG, $.cast(this.AT, $.l(e.a)));
      $.for(I, $.i(0), $.get(this.AT, A_FREE_N, $.l(AG)), () => {
        $.if($.ge($.call(this.amapIndexOfFn(), $.aget(this.amapArrT, $.get(this.AT, A_FREE, $.l(AG)), $.l(I)), $.l(e.b)), $.i(0)), () => {
          $.run(this.net.destroyHelper(), $.cast(this.sockT, $.l(e.b)), $.nul(this.deps.errType()));
          $.ret();
        });
      });
    });
  }

  /** onRemove */
  private agentOnRemoveFn(): number {
    return this.tick("agentOnRemove", ($, e, f) => {
      const AG = f.local(this.agentRef());
      const S = f.local(this.sockRef);
      const H = f.local(this.ref(this.hcliT));
      $.put(AG, $.cast(this.AT, $.l(e.a)));
      $.put(S, $.cast(this.sockT, $.l(e.b)));
      $.set(this.AT, A_TOTAL, $.l(AG), $.dsub($.get(this.AT, A_TOTAL, $.l(AG)), $.d(1)));
      $.run(this.agentRemoveSocketFn(), $.l(AG), $.l(S), $.cast(this.strT, $.l(e.c)));
      $.put(H, $.call(this.hcliFn(), $.l(S)));
      this.soff($, NET_LISTS.L_CLOSE, $.l(S), $.get(this.hcliT, 8, $.l(H)));
      this.soff($, NET_LISTS.L_FREE, $.l(S), $.get(this.hcliT, 7, $.l(H)));
      this.soff($, NET_LISTS.L_TIMEOUT, $.l(S), $.get(this.hcliT, 9, $.l(H)));
      this.soff($, NET_LISTS.L_AGENTRM, $.l(S), $.get(this.hcliT, 10, $.l(H)));
    });
  }

  /** freeSocketErrorListener (this = socket) */
  private freeSocketErrorListenerFn(): number {
    return this.closFn("freeSocketErrorListener", "err", ($, e) => {
      const s = $.cast(this.sockT, $.l(e.a));
      $.run(this.net.destroyHelper(), s, $.nul(this.deps.errType()));
      $.drop(this.semit($, NET_LISTS.L_AGENTRM, s));
    });
  }

  /** Agent.prototype.removeSocket(s, options) */
  private agentRemoveSocketFn(): number {
    return this.fn("removeSocket", [this.agentRef(), this.sockRef, this.strRef], [], (f, $) => {
      const [AG, S, NAME] = [0, 1, 2];
      const AT = this.AT;
      const E = f.local(this.ref(this.amapT));
      const IDX = f.local(I32);
      const Q = f.local(this.creqRef());
      const RN = f.local(this.ref(this.amapT));
      const I = f.local(I32);
      const STOP = f.local(I32);
      const NS = f.local(this.sockRef);
      const removeFrom = (field: number): void => {
        $.put(E, $.call(this.amapGetFn(field), $.l(AG), $.l(NAME)));
        $.if($.notNull($.l(E)), () => {
          $.put(IDX, $.call(this.amapIndexOfFn(), $.l(E), $.l(S)));
          $.if($.ne($.l(IDX), $.i(-1)), () => {
            $.drop($.call(this.amapRemoveAtFn(), $.l(E), $.l(IDX)));
            $.if($.eq($.get(this.amapT, M_N, $.l(E)), $.i(0)), () => $.run(this.amapDeleteFn(field), $.l(AG), $.l(NAME)));
          });
        });
      };
      removeFrom(A_SOCKETS);
      $.if($.not($.call(this.net.writableGetterHelper(), $.l(S))), () => removeFrom(A_FREE));
      $.put(E, $.call(this.amapGetFn(A_REQUESTS), $.l(AG), $.l(NAME)));
      $.if($.andThen($.notNull($.l(E)), $.gt($.get(this.amapT, M_N, $.l(E)), $.i(0))), () => {
        $.put(Q, $.cast(this.CT, $.aget(this.eqArrT, $.get(this.amapT, M_ARR, $.l(E)), $.i(0))));
      }, () => {
        $.for(I, $.i(0), $.get(AT, A_REQUESTS_N, $.l(AG)), () => {
          $.if($.not($.l(STOP)), () => {
            $.put(RN, $.aget(this.amapArrT, $.get(AT, A_REQUESTS, $.l(AG)), $.l(I)));
            $.if($.gt(this.amapLen($, $.call(this.amapGetFn(A_SOCKETS), $.l(AG), $.get(this.amapT, M_NAME, $.l(RN)))), $.i(0)), () => $.put(STOP, $.i(1)), () => {
              $.put(Q, $.cast(this.CT, $.aget(this.eqArrT, $.get(this.amapT, M_ARR, $.l(RN)), $.i(0))));
              $.put(STOP, $.i(1));
            });
          });
        });
      });
      $.if($.notNull($.l(Q)), () => {
        // createSocket(req, options, (err, socket) => socket.emit('free'))
        $.put(NS, $.call(this.agentCreateSocketFn(), $.l(AG), $.l(Q)));
        this.excReturn($);
        $.drop(this.semit($, NET_LISTS.L_FREE, $.l(NS)));
      });
    });
  }

  /** Agent.prototype.destroy() */
  agentDestroyFn(): number {
    return this.fn("agentDestroy", [this.agentRef()], [], (f, $) => {
      const AG = 0;
      const I = f.local(I32);
      const J = f.local(I32);
      const E = f.local(this.ref(this.amapT));
      const SNAP = f.local(this.ref(this.eqArrT));
      const N = f.local(I32);
      for (const field of [A_FREE, A_SOCKETS]) {
        $.for(I, $.i(0), $.get(this.AT, field + 1, $.l(AG)), () => {
          $.put(E, $.aget(this.amapArrT, $.get(this.AT, field, $.l(AG)), $.l(I)));
          // for (let n = 0; n < setName.length; n++): the live list
          $.put(J, $.i(0));
          $.while($.lt($.l(J), $.get(this.amapT, M_N, $.l(E))), () => {
            $.run(this.net.destroyHelper(), $.cast(this.sockT, $.aget(this.eqArrT, $.get(this.amapT, M_ARR, $.l(E)), $.l(J))), $.nul(this.deps.errType()));
            $.put(J, $.add($.l(J), $.i(1)));
          });
        });
      }
      void SNAP;
      void N;
    });
  }

  /* ── the statically typed surface's readers and writers ──────────── */

  /** A named fence: a catchable Error "<what> is not supported yet". */
  private fenceErr($: A, what: string): void {
    this.deps.newError($.c, "%Error", "Error", (c) => this.deps.pushStrLit(c, `${what} is not supported yet`), (c) => c.refNull(this.strT));
    this.deps.throwStack($.c);
  }

  /** server's joinDuplicateHeaders: true (the createServer option). */
  serverJoinDupFn(): number {
    return this.fn("serverJoinDup", [this.srvRef], [], (f, $) => {
      $.if($.notNull($.get(this.srvT, NET_SRV_HTTP.V_HTTP, $.l(0))), () => $.set(this.HT, H_JOINDUP, this.hsrvOf($, $.l(0)), $.i(1)));
    });
  }

  /** server.on('request', listener) `(srv, clos, once, prepend)` — dead
   * weight on a server with no HTTP parser (a net.Server), as in Node. */
  serverOnRequestFn(): number {
    return this.fn("serverOnRequest", [this.srvRef, EQ_REF, I32, I32], [], (f, $) => {
      $.if($.notNull($.get(this.srvT, NET_SRV_HTTP.V_HTTP, $.l(0))), () => {
        $.run(this.addFn(HL.SRV_REQUEST), this.hsrvOf($, $.l(0)), $.l(1), $.l(2), $.l(3));
      });
    });
  }

  incUrlFn(): number {
    return this.fn("incUrl", [this.incRef()], [this.strRef], (f, $) => $.do($.get(this.IT, I_URL, $.l(0))));
  }

  /** req.method — null on a client response (fenced: the static type
   * reads a string). */
  incMethodFn(): number {
    return this.fn("incMethod", [this.incRef()], [this.strRef], (f, $) => {
      $.if($.isNull($.get(this.IT, I_METHOD, $.l(0))), () => {
        this.fenceErr($, "reading 'method' of a client response (null)");
        $.ret($.nul(this.strT));
      });
      $.do($.get(this.IT, I_METHOD, $.l(0)));
    });
  }

  /** httpVersion: '1.1', or `${major}.${minor}`. */
  incHttpVersionFn(): number {
    return this.fn("incHttpVersion", [this.incRef()], [this.strRef], (f, $) => {
      const IT = this.IT;
      $.if($.both($.eq($.get(IT, I_MAJOR, $.l(0)), $.i(1)), $.eq($.get(IT, I_MINOR, $.l(0)), $.i(1))), () => $.ret(this.lit($, "1.1")));
      $.do(this.cat($, this.num2str($, $.i2d($.get(IT, I_MAJOR, $.l(0)))), this.lit($, "."), this.num2str($, $.i2d($.get(IT, I_MINOR, $.l(0))))));
    });
  }

  incVersionPartFn(major: boolean): number {
    return this.fn(`incVersion${major ? "Major" : "Minor"}`, [this.incRef()], [F64], (f, $) => {
      $.do($.i2d($.get(this.IT, major ? I_MAJOR : I_MINOR, $.l(0))));
    });
  }

  incFlagFn(which: "aborted" | "complete"): number {
    return this.fn(`incFlag.${which}`, [this.incRef()], [I32], (f, $) => {
      $.do($.get(this.IT, which === "aborted" ? I_ABORTED : I_COMPLETE, $.l(0)));
    });
  }

  /** req.headers[key] for the typed surface: a set-cookie (an array in
   * Node) is fenced. */
  incHeaderStaticFn(): number {
    return this.fn("incHeaderStatic", [this.incRef(), this.strRef], [this.strRef], (f, $) => {
      const R = f.local(this.strRef);
      $.put(R, $.call(this.incHeaderFn(), $.l(0), $.l(1)));
      $.if($.both($.notNull($.l(R)), this.streq($, $.l(1), this.lit($, "set-cookie"))), () => {
        this.fenceErr($, "reading the set-cookie header (an array) as a string");
        $.ret($.nul(this.strT));
      });
      $.do($.l(R));
    });
  }

  /** statusCode is null on a server request (the static type reads a
   * number or undefined): fenced. */
  incStatusCheckFn(): number {
    return this.fn("incStatusCheck", [this.incRef()], [], (f, $) => {
      $.if($.lt($.get(this.IT, I_STATUS, $.l(0)), $.i(0)), () => this.fenceErr($, "reading 'statusCode' of a server request (null)"));
    });
  }

  incStatusFn(): number {
    return this.fn("incStatus", [this.incRef()], [F64], (f, $) => $.do($.i2d($.get(this.IT, I_STATUS, $.l(0)))));
  }

  incStatusMessageFn(): number {
    return this.fn("incStatusMessage", [this.incRef()], [this.strRef], (f, $) => {
      $.if($.isNull($.get(this.IT, I_STATUSMSG, $.l(0))), () => {
        this.fenceErr($, "reading 'statusMessage' of a server request (null)");
        $.ret($.nul(this.strT));
      });
      $.do($.get(this.IT, I_STATUSMSG, $.l(0)));
    });
  }

  /** req.rawHeaders (a fresh array). */
  incRawHeadersFn(): number {
    return this.fn("incRawHeaders", [this.incRef()], [this.ref(this.strArrT)], (f, $) => {
      const O = f.local(this.ref(this.strArrT));
      $.put(O, $.anew(this.strArrT, $.get(this.IT, I_RAWH_N, $.l(0))));
      $.do($.l(O), $.i(0), $.get(this.IT, I_RAWH, $.l(0)), $.i(0), $.get(this.IT, I_RAWH_N, $.l(0)));
      f.c.arrayCopy(this.strArrT, this.strArrT);
      $.do($.l(O));
    });
  }

  /** { ...req.headers } as pairs — a set-cookie is fenced. */
  incHeaderPairsStaticFn(): number {
    return this.fn("incHeaderPairsStatic", [this.incRef()], [this.ref(this.strArrT)], (f, $) => {
      const O = f.local(this.ref(this.strArrT));
      const I = f.local(I32);
      $.put(O, $.call(this.incHeaderPairsFn(), $.l(0)));
      $.for(I, $.i(0), $.alen($.l(O)), () => {
        $.if(this.streq($, $.aget(this.strArrT, $.l(O), $.l(I)), this.lit($, "set-cookie")), () => {
          this.fenceErr($, "the set-cookie header (an array) in a headers record");
          $.ret($.nul(this.strArrT));
        });
        $.put(I, $.add($.l(I), $.i(1)));
      });
      $.do($.l(O));
    });
  }

  /** req.socket — null once a kept-alive response let it go (fenced). */
  incSocketFn(): number {
    return this.fn("incSocket", [this.incRef()], [this.sockRef], (f, $) => {
      $.if($.isNull($.get(this.IT, I_SOCK, $.l(0))), () => {
        this.fenceErr($, "reading 'socket' of a response whose socket went back to the agent (null)");
        $.ret($.nul(this.sockT));
      });
      $.do($.get(this.IT, I_SOCK, $.l(0)));
    });
  }

  /** req.pipe(dest): one destination per source. */
  incPipeCheckedFn(): number {
    return this.fn("incPipeChecked", [this.incRef(), this.outRef()], [], (f, $) => {
      $.if($.notNull($.get(this.IT, I_PIPE, $.l(0))), () => {
        this.fenceErr($, "piping an IncomingMessage into a second destination");
        $.ret();
      });
      $.run(this.incPipeFn(), $.l(0), $.l(1));
    });
  }

  resStatusGetFn(): number {
    return this.fn("resStatusGet", [this.resRef()], [F64], (f, $) => $.do($.get(this.RT, R_STATUS, $.l(0))));
  }

  resStatusSetFn(): number {
    return this.fn("resStatusSet", [this.resRef(), F64], [], (f, $) => $.set(this.RT, R_STATUS, $.l(0), $.l(1)));
  }

  /** res.statusMessage — undefined until set or written (fenced: the
   * static type reads a string). */
  resStatusMsgGetFn(): number {
    return this.fn("resStatusMsgGet", [this.resRef()], [this.strRef], (f, $) => {
      $.if($.isNull($.get(this.RT, R_STATUSMSG, $.l(0))), () => {
        this.fenceErr($, "reading 'statusMessage' before it is set (undefined)");
        $.ret($.nul(this.strT));
      });
      $.do($.get(this.RT, R_STATUSMSG, $.l(0)));
    });
  }

  resStatusMsgSetFn(): number {
    return this.fn("resStatusMsgSet", [this.resRef(), this.strRef], [], (f, $) => $.set(this.RT, R_STATUSMSG, $.l(0), $.l(1)));
  }

  resSetHeaderStrFn(): number {
    return this.fn("resSetHeaderStr", [this.outRef(), this.strRef, this.strRef], [], (f, $) => {
      $.run(this.setHeaderFn(), $.l(0), $.l(1), this.hvStrNew($, $.l(2)));
    });
  }

  /** getHeader for the typed surface: a value that is not a string (a
   * number or an array set through a dynamic value) is fenced. */
  resGetHeaderStrFn(): number {
    return this.fn("resGetHeaderStr", [this.outRef(), this.strRef], [this.strRef], (f, $) => {
      const V = f.local(this.ref(this.hvT));
      $.put(V, $.call(this.getHeaderFn(), $.l(0), $.l(1)));
      $.if($.isNull($.l(V)), () => $.ret($.nul(this.strT)));
      $.if($.ne($.get(this.hvT, V_KIND, $.l(V)), $.i(0)), () => {
        this.fenceErr($, "reading a header set to a number or an array as a string");
        $.ret($.nul(this.strT));
      });
      $.do($.get(this.hvT, V_STR, $.l(V)));
    });
  }

  headersSentFn(): number {
    return this.fn("headersSent", [this.outRef()], [I32], (f, $) => $.do($.notNull($.get(this.OT, O_HEADER, $.l(0)))));
  }

  outDestroyedFn(): number {
    return this.fn("outDestroyed", [this.outRef()], [I32], (f, $) => $.do($.get(this.OT, O_DESTROYED, $.l(0))));
  }

  outFinishedFn(): number {
    return this.fn("outFinished", [this.outRef()], [I32], (f, $) => $.do($.get(this.OT, O_FINISHED, $.l(0))));
  }

  outCorkedFn(): number {
    return this.fn("outCorked", [this.outRef()], [I32], (f, $) => $.do($.get(this.OT, O_CORKED, $.l(0))));
  }

  /** The lowered `end(cb)` registers its callback first; it is held here
   * for the end call that follows (which registers it where Node's end
   * does). */
  resPendingEndCbFn(): number {
    return this.fn("resPendingEndCb", [this.resRef(), this.vclosRef], [], (f, $) => $.set(this.RT, R_PENDCB, $.l(0), $.l(1)));
  }

  resTakeEndCbFn(): number {
    return this.fn("resTakeEndCb", [this.resRef()], [this.vclosRef], (f, $) => {
      const CB = f.local(EQ_REF);
      $.put(CB, $.get(this.RT, R_PENDCB, $.l(0)));
      $.set(this.RT, R_PENDCB, $.l(0), $.nul(EQ_HEAP));
      $.do($.sel(this.vclosRef, $.isNull($.l(CB)), $.nul(this.deps.voidClos().clos), $.cast(this.deps.voidClos().clos, $.l(CB))));
    });
  }

  resWriteHeadStatusFn(): number {
    return this.fn("resWriteHeadStatus", [this.resRef(), F64], [], (f, $) => {
      $.run(this.writeHeadFn(), $.l(0), $.l(1), $.nul(this.strT), $.i(0), $.nul(this.hentArrT), $.i(0));
    });
  }

  /** A headers list from parallel names / values (an object literal). */
  resWriteHeadNVFn(): number {
    return this.fn("resWriteHeadNV", [this.resRef(), F64, I32, this.ref(this.strArrT), this.ref(this.strArrT)], [], (f, $) => {
      const [R, SC, N, NAMES, VALUES] = [0, 1, 2, 3, 4];
      const L = f.local(this.ref(this.hentArrT));
      const I = f.local(I32);
      $.put(L, $.anew(this.hentArrT, $.l(N)));
      $.for(I, $.i(0), $.l(N), () => {
        const name = $.aget(this.strArrT, $.l(NAMES), $.l(I));
        $.aset(this.hentArrT, $.l(L), $.l(I), $.new_(this.hentT, name, name, this.hvStrNew($, $.aget(this.strArrT, $.l(VALUES), $.l(I)))));
      });
      $.run(this.writeHeadFn(), $.l(R), $.l(SC), $.nul(this.strT), $.i(1), $.l(L), $.l(N));
    });
  }

  /** A headers list from flat [name, value, ...] pairs; `kind` 1 is a
   * record (an object), 2 the flat array form (its odd length is Node's
   * ERR_INVALID_ARG_VALUE). */
  resWriteHeadPairsFn(): number {
    return this.fn("resWriteHeadPairs", [this.resRef(), F64, I32, this.ref(this.strArrT), I32], [], (f, $) => {
      const [R, SC, N, PAIRS, KIND] = [0, 1, 2, 3, 4];
      const L = f.local(this.ref(this.hentArrT));
      const I = f.local(I32);
      $.if($.both($.eq($.l(KIND), $.i(2)), $.ne($.and($.l(N), $.i(1)), $.i(0))), () => {
        $.run(this.writeHeadOddFn(), $.l(R), $.l(SC), $.l(PAIRS), $.l(N));
        $.ret();
      });
      $.put(L, $.anew(this.hentArrT, $.shrU($.l(N), $.i(1))));
      $.for(I, $.i(0), $.shrU($.l(N), $.i(1)), () => {
        const name = $.aget(this.strArrT, $.l(PAIRS), $.shl($.l(I), $.i(1)));
        $.aset(this.hentArrT, $.l(L), $.l(I), $.new_(this.hentT, name, name, this.hvStrNew($, $.aget(this.strArrT, $.l(PAIRS), $.add($.shl($.l(I), $.i(1)), $.i(1))))));
      });
      $.run(this.writeHeadFn(), $.l(R), $.l(SC), $.nul(this.strT), $.l(KIND), $.l(L), $.shrU($.l(N), $.i(1)));
    });
  }

  /** writeHead(status, oddArray): the status checks and statusMessage,
   * then ERR_INVALID_ARG_VALUE('headers', obj) — before the statusMessage
   * character check when headers were set, after it (in _storeHeader)
   * when not. The array is rendered by util.inspect (the emitter's
   * inspectStrArr) and cut as the error's message builder cuts it. */
  private writeHeadOddFn(): number {
    return this.fn("writeHeadOdd", [this.resRef(), F64, this.ref(this.strArrT), I32], [], (f, $) => {
      const [R, SC, ARR, N] = [0, 1, 2, 3];
      // Run writeHead's own checks up to the headers (they throw first).
      $.run(this.writeHeadFn(), $.l(R), $.l(SC), $.nul(this.strT), $.i(3), $.nul(this.hentArrT), $.i(0));
      $.if($.g(this.deps.excKind()), () => $.ret());
      $.run(this.invalidHeadersArgFn(), $.call(this.deps.inspectStrArr(), $.l(ARR), $.l(N)));
    });
  }

  /** throw new ERR_INVALID_ARG_VALUE('headers', value) from the value's
   * inspection: longer than 128 code units, it is cut to 128 and '...'
   * (lib/internal/errors.js). */
  invalidHeadersArgFn(): number {
    return this.fn("invalidHeadersArg", [this.strRef], [], (f, $) => {
      const S = f.local(this.strRef);
      $.put(S, $.l(0));
      $.if($.gt($.alen($.l(S)), $.i(128)), () => $.put(S, this.cat($, $.call(this.substrFn(), $.l(S), $.i(0), $.i(128)), this.lit($, "..."))));
      this.throwErr($, "%TypeError", this.cat($, this.lit($, "The argument 'headers' is invalid. Received "), $.l(S)), "ERR_INVALID_ARG_VALUE");
    });
  }

  /* ── field access for the emitter's checked-dynamic surface ──────── */

  readonly incHeadersField = I_HEADERS;
  readonly incRawDynField = I_RAWDYN;
  readonly incRawVecField = I_RAWVEC;
  readonly incMethodField = I_METHOD;
  readonly incStatusField = I_STATUS;
  readonly incStatusMsgField = I_STATUSMSG;
  readonly incReqField = I_REQ;
  readonly incUrlField = I_URL;
  readonly incRawField = I_RAWH;
  readonly incHCountField = I_HCOUNT;
  readonly resReqField = R_REQ;
  readonly resStatusMsgField = R_STATUSMSG;
  readonly creqMethodField = C_METHOD;
  readonly creqPathField = C_PATH;
  readonly creqHostField = C_HOST;
  readonly creqProtocolField = C_PROTOCOL;
  readonly creqReusedField = C_REUSED;

  get eqArrTPublic(): number {
    return this.eqArrT;
  }

  agentField(name: string): number {
    const m: Record<string, number> = {
      keepAlive: A_KEEPALIVE,
      keepAliveMsecs: A_KAMSECS,
      maxSockets: A_MAXSOCKETS,
      maxFreeSockets: A_MAXFREE,
      maxTotalSockets: A_MAXTOTAL,
      totalSocketCount: A_TOTAL,
      fifo: A_FIFO,
      defaultPort: A_DEFPORT,
      protocol: A_PROTOCOL,
      requests: A_REQUESTS,
      sockets: A_SOCKETS,
      freeSockets: A_FREE,
    };
    const f = m[name];
    if (f === undefined) throw new Error(`agentField: ${name}`);
    return f;
  }

  incReadableEndedFn(): number {
    return this.incEndedFn();
  }

  /** kOutHeaders' entries (null = none) and their count. */
  outHeadersListFn(): number {
    return this.fn("outHeadersList", [this.outRef()], [this.ref(this.hentArrT)], (f, $) => $.do($.get(this.OT, O_HDRS, $.l(0))));
  }

  outHeadersCountFn(): number {
    return this.fn("outHeadersCount", [this.outRef()], [I32], (f, $) => $.do($.get(this.OT, O_HDRS_N, $.l(0))));
  }

  /* @@CONTINUE@@ */
}
