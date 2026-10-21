/* INC-29 U2 — llhttp on the WasmGC tier: the HTTP/1 parser Node v24.18.1
 * links (deps/llhttp, llhttp 9.4.3), as wasm.
 *
 * llhttp's parser proper is generated C (llparse): one function,
 * llhttp__internal__run, whose labelled blocks are the parser's states.
 * llhttp-tables.ts carries that function converted to data, block for
 * block; this file turns the data back into code — one wasm function with
 * a br_table dispatch over the state ids, every `goto` a jump back to the
 * dispatch, every `return <state>` a suspension the next execute resumes
 * from, exactly where the C resumes. The few parts llhttp writes by hand
 * (src/api.c's execute / finish / pause, src/http.c's header and message
 * hooks) are transcribed below as functions of their own.
 *
 * The parser state is llhttp__internal_t's fields, kept in the http
 * parser struct (http.ts owns the struct and hands this builder its field
 * indices). Pointers into the input become indices into the bytes being
 * parsed: `p`, `endp`, `_span_pos0` (-1 is NULL) and `error_pos`. The
 * span callbacks (on_url, on_header_value, on_body, ...) and the plain
 * ones (on_message_begin, on_headers_complete, ...) are http.ts's
 * transcription of Node's Parser (src/node_http_parser.cc); the callbacks
 * Node leaves NULL answer 0, exactly as CALLBACK_MAYBE does for them. */
import { Code } from "./code.js";
import { A, Fn, type X } from "./asm.js";
import { I32, I64, ModuleBuilder, type ValType } from "./module.js";
import { LL_BLOBS, LL_HELPERS, LL_START, LL_STATES, LL_TABLES, type LlExpr, type LlStmt } from "./llhttp-tables.js";

/** The llhttp__internal_t fields, as struct field indices of the parser. */
export interface LlFields {
  _index: number;
  _span_pos0: number;
  _span_cb0: number;
  error: number;
  reason: number;
  error_pos: number;
  _current: number;
  content_length: number;
  type: number;
  method: number;
  http_major: number;
  http_minor: number;
  header_state: number;
  lenient_flags: number;
  upgrade: number;
  finish: number;
  flags: number;
  status_code: number;
  initial_message_completed: number;
}

/** The C field widths (stores truncate to them). */
const FIELD_BITS: Record<string, number> = {
  _index: 32, error: 32, error_pos: 32, _span_pos0: 32, _span_cb0: 32, _current: 32,
  type: 8, method: 8, http_major: 8, http_minor: 8, header_state: 8, lenient_flags: 16,
  upgrade: 8, finish: 8, flags: 16, status_code: 16, initial_message_completed: 8,
};

/** Span callback ids (the value `_span_cb0` holds). */
export const SPAN_CB: Record<string, number> = {
  llhttp__on_body: 1,
  llhttp__on_url: 2,
  llhttp__on_status: 3,
  llhttp__on_header_field: 4,
  llhttp__on_header_value: 5,
  llhttp__on_method: 6,
  llhttp__on_protocol: 7,
  llhttp__on_version: 8,
  llhttp__on_chunk_extension_name: 9,
  llhttp__on_chunk_extension_value: 10,
};

/* llhttp.h */
export const HPE_OK = 0;
export const HPE_INVALID_EOF_STATE = 14;
export const HPE_PAUSED = 21;
export const HPE_PAUSED_UPGRADE = 22;
export const HPE_USER = 24;
export const F_CONNECTION_KEEP_ALIVE = 0x1;
export const F_CONNECTION_CLOSE = 0x2;
export const F_CONNECTION_UPGRADE = 0x4;
export const F_CHUNKED = 0x8;
export const F_UPGRADE = 0x10;
export const F_CONTENT_LENGTH = 0x20;
export const F_SKIPBODY = 0x40;
export const F_TRANSFER_ENCODING = 0x200;
export const HTTP_REQUEST = 1;
export const HTTP_RESPONSE = 2;
export const HTTP_CONNECT = 5;
export const LENIENT_CHUNKED_LENGTH = 0x2;
export const LENIENT_TRANSFER_ENCODING = 0x8;
export const HTTP_FINISH_SAFE = 0;
export const HTTP_FINISH_SAFE_WITH_CB = 1;
export const HTTP_FINISH_UNSAFE = 2;

/** llhttp_errno_name's table (HTTP_ERRNO_MAP). */
export const HPE_NAMES: readonly (readonly [number, string])[] = [
  [0, "HPE_OK"], [1, "HPE_INTERNAL"], [2, "HPE_STRICT"], [25, "HPE_CR_EXPECTED"], [3, "HPE_LF_EXPECTED"],
  [4, "HPE_UNEXPECTED_CONTENT_LENGTH"], [30, "HPE_UNEXPECTED_SPACE"], [5, "HPE_CLOSED_CONNECTION"],
  [6, "HPE_INVALID_METHOD"], [7, "HPE_INVALID_URL"], [8, "HPE_INVALID_CONSTANT"], [9, "HPE_INVALID_VERSION"],
  [10, "HPE_INVALID_HEADER_TOKEN"], [11, "HPE_INVALID_CONTENT_LENGTH"], [12, "HPE_INVALID_CHUNK_SIZE"],
  [13, "HPE_INVALID_STATUS"], [14, "HPE_INVALID_EOF_STATE"], [15, "HPE_INVALID_TRANSFER_ENCODING"],
  [16, "HPE_CB_MESSAGE_BEGIN"], [17, "HPE_CB_HEADERS_COMPLETE"], [18, "HPE_CB_MESSAGE_COMPLETE"],
  [19, "HPE_CB_CHUNK_HEADER"], [20, "HPE_CB_CHUNK_COMPLETE"], [21, "HPE_PAUSED"], [22, "HPE_PAUSED_UPGRADE"],
  [23, "HPE_PAUSED_H2_UPGRADE"], [24, "HPE_USER"], [26, "HPE_CB_URL_COMPLETE"], [27, "HPE_CB_STATUS_COMPLETE"],
  [32, "HPE_CB_METHOD_COMPLETE"], [33, "HPE_CB_VERSION_COMPLETE"], [38, "HPE_CB_PROTOCOL_COMPLETE"],
  [28, "HPE_CB_HEADER_FIELD_COMPLETE"], [29, "HPE_CB_HEADER_VALUE_COMPLETE"],
  [34, "HPE_CB_CHUNK_EXTENSION_NAME_COMPLETE"], [35, "HPE_CB_CHUNK_EXTENSION_VALUE_COMPLETE"], [31, "HPE_CB_RESET"],
];

/** What the builder needs from http.ts. */
export interface LlDeps {
  /** The parser struct type and its llhttp fields. */
  parserType: () => number;
  fields: LlFields;
  /** The bytes array type (`(array (mut i8))`). */
  bufType: () => number;
  /** Push a string literal (the tier's string value). */
  pushStrLit: (c: Code, s: string) => void;
  strRef: () => ValType;
  /** Node's span callbacks: `(parser, buf, start, end) -> i32` by C name
   * (null = the callback is NULL in Node's settings: answers 0). */
  spanCb: (name: string) => number | null;
  /** Node's plain callbacks: `(parser) -> i32` by C name (null = NULL). */
  plainCb: (name: string) => number | null;
  /** llhttp_should_keep_alive is used by the hooks below and by Node. */
}

export class LlhttpBuilder {
  private readonly fns = new Map<string, number>();
  private blobG: number | null = null;
  private tableG: number | null = null;
  private i8ArrT: number | null = null;

  constructor(
    private readonly mb: ModuleBuilder,
    private readonly deps: LlDeps,
  ) {}

  private fn(name: string, params: ValType[], results: ValType[], build: (f: Fn, $: A) => void): number {
    const hit = this.fns.get(name);
    if (hit !== undefined) return hit;
    const idx = this.mb.declareFunc(this.mb.funcType(params, results), `%w.http.ll.${name}`);
    this.fns.set(name, idx);
    const f = new Fn(params.length);
    build(f, new A(f));
    this.mb.setBody(idx, f.locals, f.c.bytes());
    return idx;
  }

  private get PT(): number {
    return this.deps.parserType();
  }

  private get pref(): ValType {
    return { kind: "ref", nullable: true, typeIndex: this.PT };
  }

  private get bufRef(): ValType {
    return { kind: "ref", nullable: true, typeIndex: this.deps.bufType() };
  }

  private fieldIdx(name: string): number {
    const f = (this.deps.fields as unknown as Record<string, number>)[name];
    if (f === undefined) throw new Error(`llhttp: no field ${name}`);
    return f;
  }

  /* ── constant data ──────────────────────────────────────────────── */

  private get i8Arr(): number {
    this.i8ArrT ??= this.mb.arrayType("i8", true);
    return this.i8ArrT;
  }

  private blobOffsets: number[] = [];

  /** The global holding every match blob back to back (lazily built). */
  private blobGlobal(): number {
    if (this.blobG === null) {
      const all: number[] = [];
      for (const b of LL_BLOBS) {
        this.blobOffsets.push(all.length);
        all.push(...b);
      }
      const T = this.i8Arr;
      this.blobG = this.mb.addGlobal({ kind: "ref", nullable: true, typeIndex: T }, true, (w) => {
        w.u8(0xd0);
        w.sleb(T);
      });
      this.blobData = { offset: this.mb.internData(Uint8Array.from(all)), len: all.length };
    }
    return this.blobG;
  }

  private blobData: { offset: number; len: number } | null = null;
  private tableData: { offset: number; len: number } | null = null;

  private tableGlobal(): number {
    if (this.tableG === null) {
      const all: number[] = [];
      for (const t of LL_TABLES) all.push(...t);
      const T = this.i8Arr;
      this.tableG = this.mb.addGlobal({ kind: "ref", nullable: true, typeIndex: T }, true, (w) => {
        w.u8(0xd0);
        w.sleb(T);
      });
      this.tableData = { offset: this.mb.internData(Uint8Array.from(all)), len: all.length };
    }
    return this.tableG;
  }

  /** Make sure the constant arrays exist (called at the top of run). */
  private emitInitConsts($: A): void {
    const bg = this.blobGlobal();
    const tg = this.tableGlobal();
    const T = this.i8Arr;
    $.if($.isNull($.g(bg)), () => {
      $.c.i32Const(this.blobData!.offset);
      $.c.i32Const(this.blobData!.len);
      $.c.arrayNewData(T, 0);
      $.c.globalSet(bg);
      $.c.i32Const(this.tableData!.offset);
      $.c.i32Const(this.tableData!.len);
      $.c.arrayNewData(T, 0);
      $.c.globalSet(tg);
    });
  }

  /* ── field access ───────────────────────────────────────────────── */

  private fset($: A, P: number, name: string, v: X, is64: boolean): void {
    const c = $.c;
    c.localGet(P);
    v();
    const bits = FIELD_BITS[name];
    if (!is64 && bits !== undefined && bits < 32) {
      c.i32Const((1 << bits) - 1);
      c.i32And();
    }
    c.structSet(this.PT, this.fieldIdx(name));
  }

  /** The Code currently being emitted (the interpreter's target). */
  private c: Code | null = null;

  /* ── the C-subset interpreter ───────────────────────────────────── */

  /** Locals of the function under construction. */
  private L: Record<string, number> = {};
  /** Extra block depth inside the current state's body (if-blocks). */
  private depth = 0;
  /** The dispatch loop's depth from the state body's top level. */
  private loopDepth = 0;
  /** Are we emitting a c_* helper (return = function return)? */
  private inHelper = false;
  /** The state ids that are resumable (C `case` labels). */
  private readonly resumable = new Set(LL_STATES.flatMap((s, i) => (s.resumable ? [i] : [])));

  /** Is this expression 64-bit (content_length involved)? */
  private is64(e: LlExpr): boolean {
    switch (e[0]) {
      case "f":
        return e[1] === "content_length";
      case "n64":
        return true;
      case "l":
        return e[1] === "need";
      case "bin":
        return this.is64(e[2] as LlExpr) || this.is64(e[3] as LlExpr);
      default:
        return false;
    }
  }

  /** Emit `e` as i32 (or as i64 when `as64`, widening an i32 operand the
   * way C's usual conversions do: an int sign-extends). */
  private ex(e: LlExpr, as64 = false): void {
    const c = this.c!;
    const P = this.L["P"]!;
    const widen = (): void => {
      if (as64) c.i64ExtendI32S();
    };
    switch (e[0]) {
      case "n":
        if (as64) c.i64Const(BigInt(e[1] as number));
        else c.i32Const(e[1] as number);
        return;
      case "n64": {
        const v = BigInt(e[1] as string);
        c.i64Const(BigInt.asIntN(64, v));
        if (!as64) c.i32WrapI64();
        return;
      }
      case "p":
        c.localGet(this.L["p"]!);
        widen();
        return;
      case "endp":
        c.localGet(this.L["endp"]!);
        widen();
        return;
      case "null":
        c.i32Const(-1);
        return;
      case "byte":
        c.localGet(this.L["buf"]!);
        c.localGet(this.L["p"]!);
        c.arrayGetU(this.deps.bufType());
        widen();
        return;
      case "tbl": {
        c.globalGet(this.tableGlobal());
        c.i32Const(this.curTable * 256);
        this.ex(e[1] as LlExpr);
        c.i32Add();
        c.arrayGetU(this.i8Arr);
        widen();
        return;
      }
      case "f": {
        const name = e[1] as string;
        c.localGet(P);
        c.structGet(this.PT, this.fieldIdx(name));
        if (name === "content_length") {
          if (!as64) c.i32WrapI64();
        } else widen();
        return;
      }
      case "l": {
        const name = e[1] as string;
        const idx = this.L[name];
        if (idx === undefined) throw new Error(`llhttp: local ${name}`);
        c.localGet(idx);
        if (name === "need") {
          if (!as64) c.i32WrapI64();
        } else widen();
        return;
      }
      case "m": {
        const which = e[2] as string;
        c.localGet(which === "status" ? this.L["mss"]! : this.L["msc"]!);
        widen();
        return;
      }
      case "?:": {
        this.ex(e[1] as LlExpr);
        c.ifResult(as64 ? I64 : I32);
        this.ex(e[2] as LlExpr, as64);
        c.else_();
        this.ex(e[3] as LlExpr, as64);
        c.end();
        return;
      }
      case "un": {
        const op = e[1] as string;
        if (op === "-") {
          if (as64) {
            c.i64Const(0n);
            this.ex(e[2] as LlExpr, true);
            c.i64Sub();
          } else {
            c.i32Const(0);
            this.ex(e[2] as LlExpr);
            c.i32Sub();
          }
          return;
        }
        throw new Error(`llhttp: unary ${op}`);
      }
      case "bin": {
        const op = e[1] as string;
        const a = e[2] as LlExpr;
        const b = e[3] as LlExpr;
        const wide = this.is64(a) || this.is64(b);
        if (["==", "!=", "<", ">", "<=", ">="].includes(op)) {
          // C compares in the common type: unsigned 64 when either side is
          // content_length (uint64_t), else int (every narrow field
          // promotes to int).
          this.ex(a, wide);
          this.ex(b, wide);
          if (wide) {
            if (op === "==") c.i64Eq();
            else if (op === "!=") c.i64Ne();
            else if (op === "<") c.i64LtU();
            else if (op === ">") c.i64GtU();
            else if (op === "<=") c.i64LeU();
            else c.i64GeU();
          } else {
            if (op === "==") c.i32Eq();
            else if (op === "!=") c.i32Ne();
            else if (op === "<") c.i32LtS();
            else if (op === ">") c.i32GtS();
            else if (op === "<=") c.i32LeS();
            else c.i32GeS();
          }
          if (as64) c.i64ExtendI32U();
          return;
        }
        if (op === "&&" || op === "||") {
          this.ex(a);
          c.ifResult(I32);
          if (op === "&&") {
            this.ex(b);
            c.i32Const(0);
            c.i32Ne();
            c.else_();
            c.i32Const(0);
          } else {
            c.i32Const(1);
            c.else_();
            this.ex(b);
            c.i32Const(0);
            c.i32Ne();
          }
          c.end();
          if (as64) c.i64ExtendI32U();
          return;
        }
        const w = wide || as64;
        this.ex(a, w);
        this.ex(b, w);
        if (w) {
          if (op === "+") c.i64Add();
          else if (op === "-") c.i64Sub();
          else if (op === "*") c.i64Mul();
          else if (op === "/") c.i64DivU();
          else if (op === "&") c.i64And();
          else if (op === "|") c.i64Or();
          else throw new Error(`llhttp: binop ${op}`);
          if (!as64) c.i32WrapI64();
        } else {
          if (op === "+") c.i32Add();
          else if (op === "-") c.i32Sub();
          else if (op === "*") c.i32Mul();
          else if (op === "/") c.i32DivS();
          else if (op === "&") c.i32And();
          else if (op === "|") c.i32Or();
          else throw new Error(`llhttp: binop ${op}`);
        }
        return;
      }
      case "call":
        this.callExpr(e);
        widen();
        return;
      case "state":
        c.i32Const(e[1] as number);
        widen();
        return;
      default:
        throw new Error(`llhttp: expression ${String(e[0])}`);
    }
  }

  /** The table index of the state being emitted (its lookup_table). */
  private curTable = -1;

  private callExpr(e: LlExpr): void {
    const c = this.c!;
    const name = e[1] as string;
    const args = e[2] as LlExpr[];
    const P = this.L["P"]!;
    if (name.startsWith("llhttp__internal__c_")) {
      const h = this.helper(name);
      c.localGet(P);
      if (LL_HELPERS[name]!.match) this.ex(args[3]!);
      c.call(h);
      return;
    }
    if (name.startsWith("llparse__match_sequence_")) {
      const mode = name === "llparse__match_sequence_id" ? 0 : name === "llparse__match_sequence_to_lower" ? 1 : 2;
      const blob = (args[3] as LlExpr)[1] as number;
      const len = (args[4] as LlExpr)[1] as number;
      c.localGet(P);
      c.localGet(this.L["buf"]!);
      c.localGet(this.L["p"]!);
      c.localGet(this.L["endp"]!);
      c.i32Const(this.blobOff(blob));
      c.i32Const(len);
      c.i32Const(mode);
      c.call(this.matchSeqFn());
      return;
    }
    if (name === "llhttp__before_headers_complete") {
      c.localGet(P);
      c.call(this.beforeHeadersCompleteFn());
      return;
    }
    if (name === "llhttp__after_headers_complete") {
      c.localGet(P);
      c.call(this.afterHeadersCompleteFn());
      return;
    }
    if (name === "llhttp__after_message_complete") {
      c.localGet(P);
      c.call(this.afterMessageCompleteFn());
      return;
    }
    if (SPAN_CB[name] !== undefined) {
      // (st, start, p)
      const cb = this.deps.spanCb(name);
      if (cb === null) {
        c.i32Const(0);
        return;
      }
      c.localGet(P);
      c.localGet(this.L["buf"]!);
      this.ex(args[1]!);
      this.ex(args[2]!);
      c.call(cb);
      return;
    }
    if (name.startsWith("llhttp__on_")) {
      const cb = this.deps.plainCb(name);
      if (cb === null) {
        c.i32Const(0);
        return;
      }
      c.localGet(P);
      c.call(cb);
      return;
    }
    throw new Error(`llhttp: call ${name}`);
  }

  private blobOff(i: number): number {
    this.blobGlobal();
    return this.blobOffsets[i]!;
  }

  /** Statements. Every C path ends in goto / return, so control never
   * falls out of a state's body (the trailing `unreachable` is C's own
   * UNREACHABLE). */
  private stmts(list: readonly LlStmt[]): void {
    for (const s of list) this.stmt(s);
  }

  private stmt(s: LlStmt): void {
    const c = this.c!;
    switch (s[0]) {
      case "goto": {
        c.i32Const(s[1] as number);
        c.localSet(this.L["cur"]!);
        c.br(this.depth + this.loopDepth);
        return;
      }
      case "return": {
        const v = s[1] as LlExpr;
        if (this.inHelper) {
          this.ex(v);
          c.return_();
          return;
        }
        if (v[0] !== "state") throw new Error("llhttp: return of a non-state");
        c.i32Const(v[1] as number);
        c.return_();
        return;
      }
      case "if": {
        this.ex(s[1] as LlExpr);
        c.ifVoid();
        this.depth++;
        this.stmts(s[2] as LlStmt[]);
        if (s[3] !== null) {
          c.else_();
          this.stmts(s[3] as LlStmt[]);
        }
        this.depth--;
        c.end();
        return;
      }
      case "switch": {
        const SW = this.L["sw"]!;
        this.ex(s[1] as LlExpr);
        c.localSet(SW);
        const cases = s[2] as [number[], LlStmt[]][];
        const dflt = s[3] as LlStmt[] | null;
        let opened = 0;
        for (const [vals, body] of cases) {
          vals.forEach((v, i) => {
            c.localGet(SW);
            c.i32Const(v);
            c.i32Eq();
            if (i > 0) c.i32Or();
          });
          c.ifVoid();
          this.depth++;
          opened++;
          this.stmts(body);
          c.else_();
        }
        if (dflt !== null) this.stmts(dflt);
        for (let i = 0; i < opened; i++) {
          c.end();
          this.depth--;
        }
        return;
      }
      case "expr":
        this.exprStmt(s[1] as LlExpr);
        return;
      default:
        throw new Error(`llhttp: statement ${String(s[0])}`);
    }
  }

  private exprStmt(e: LlExpr): void {
    const c = this.c!;
    const P = this.L["P"]!;
    if (e[0] === "post++") {
      const t = e[1] as LlExpr;
      if (t[0] !== "p") throw new Error("llhttp: ++ of a non-p");
      c.localGet(this.L["p"]!);
      c.i32Const(1);
      c.i32Add();
      c.localSet(this.L["p"]!);
      return;
    }
    if (e[0] === "call") {
      this.ex(e);
      c.drop();
      return;
    }
    if (e[0] !== "assign") throw new Error(`llhttp: expression statement ${String(e[0])}`);
    const op = e[1] as string;
    const lhs = e[2] as LlExpr;
    const rhs = e[3] as LlExpr;
    const valueOf = (wide: boolean): void => {
      if (op === "=") {
        this.rvalue(rhs, wide);
        return;
      }
      this.ex(lhs, wide);
      this.ex(rhs, wide);
      const o = op.slice(0, 1);
      if (wide) {
        if (o === "+") c.i64Add();
        else if (o === "-") c.i64Sub();
        else if (o === "*") c.i64Mul();
        else if (o === "|") c.i64Or();
        else if (o === "&") c.i64And();
        else throw new Error(`llhttp: compound ${op}`);
      } else {
        if (o === "+") c.i32Add();
        else if (o === "-") c.i32Sub();
        else if (o === "*") c.i32Mul();
        else if (o === "|") c.i32Or();
        else if (o === "&") c.i32And();
        else throw new Error(`llhttp: compound ${op}`);
      }
    };
    switch (lhs[0]) {
      case "p":
        valueOf(false);
        c.localSet(this.L["p"]!);
        return;
      case "f": {
        const name = lhs[1] as string;
        const wide = name === "content_length";
        c.localGet(P);
        valueOf(wide);
        const bits = FIELD_BITS[name];
        if (!wide && bits !== undefined && bits < 32) {
          c.i32Const((1 << bits) - 1);
          c.i32And();
        }
        c.structSet(this.PT, this.fieldIdx(name));
        return;
      }
      case "l": {
        const name = lhs[1] as string;
        if (name === "match_seq") {
          // (status, current): the call pushes both.
          this.ex(rhs);
          c.localSet(this.L["msc"]!);
          c.localSet(this.L["mss"]!);
          return;
        }
        valueOf(name === "need");
        c.localSet(this.L[name]!);
        return;
      }
      default:
        throw new Error(`llhttp: assignment target ${String(lhs[0])}`);
    }
  }

  /** The right side of a plain assignment: the pointer-ish and string
   * values have their own encodings. */
  private rvalue(e: LlExpr, wide: boolean): void {
    const c = this.c!;
    switch (e[0]) {
      case "s":
        this.deps.pushStrLit(c, e[1] as string);
        return;
      case "fnref": {
        const id = SPAN_CB[e[1] as string];
        if (id === undefined) throw new Error(`llhttp: fnref ${String(e[1])}`);
        c.i32Const(id);
        return;
      }
      default:
        this.ex(e, wide);
    }
  }

  /* ── the generated parts ────────────────────────────────────────── */

  /** `llhttp__internal__c_<name>(parser[, match]) -> i32`. */
  private helper(name: string): number {
    const h = LL_HELPERS[name];
    if (h === undefined) throw new Error(`llhttp: helper ${name}`);
    const params: ValType[] = h.match ? [this.pref, I32] : [this.pref];
    return this.fn(`c.${name.slice("llhttp__internal__c_".length)}`, params, [I32], (f) => {
      const saved = { c: this.c, L: this.L, depth: this.depth, inHelper: this.inHelper };
      this.c = f.c;
      this.L = { P: 0, ...(h.match ? { match: 1 } : {}) };
      this.depth = 0;
      this.inHelper = true;
      this.stmts(h.body);
      f.c.unreachable();
      this.c = saved.c;
      this.L = saved.L;
      this.depth = saved.depth;
      this.inHelper = saved.inHelper;
    });
  }

  /** llparse__match_sequence_{id,to_lower,to_lower_unsafe}:
   * `(parser, buf, p, endp, blobOff, len, mode) -> (status, current)`. */
  private matchSeqFn(): number {
    return this.fn("matchSeq", [this.pref, this.bufRef, I32, I32, I32, I32, I32], [I32, I32], (f, $) => {
      const [P, B, PP, E, OFF, LEN, MODE] = [0, 1, 2, 3, 4, 5, 6];
      const IDX = f.local(I32);
      const CUR = f.local(I32);
      const idxF = this.fieldIdx("_index");
      $.put(IDX, $.get(this.PT, idxF, $.l(P)));
      $.while($.ne($.l(PP), $.l(E)), () => {
        $.put(CUR, $.agetU(this.deps.bufType(), $.l(B), $.l(PP)));
        // to_lower: 'A'..'Z' | 0x20; to_lower_unsafe: | 0x20.
        $.if($.eq($.l(MODE), $.i(1)), () => {
          $.if($.both($.ge($.l(CUR), $.i(65)), $.le($.l(CUR), $.i(90))), () => $.put(CUR, $.or($.l(CUR), $.i(0x20))));
        });
        $.if($.eq($.l(MODE), $.i(2)), () => $.put(CUR, $.or($.l(CUR), $.i(0x20))));
        $.if(
          $.eq($.l(CUR), $.agetU(this.i8Arr, $.g(this.blobGlobal()), $.add($.l(OFF), $.l(IDX)))),
          () => {
            $.put(IDX, $.add($.l(IDX), $.i(1)));
            $.if($.eq($.l(IDX), $.l(LEN)), () => {
              // kMatchComplete: reset, current = p (the matched byte).
              $.set(this.PT, idxF, $.l(P), $.i(0));
              $.do($.i(0), $.l(PP));
              $.ret();
            });
          },
          () => {
            $.set(this.PT, idxF, $.l(P), $.i(0));
            $.do($.i(2), $.l(PP));
            $.ret();
          },
        );
        $.put(PP, $.add($.l(PP), $.i(1)));
      });
      $.set(this.PT, idxF, $.l(P), $.l(IDX));
      $.do($.i(1), $.l(PP));
    });
  }

  /** llhttp__internal__run(parser, buf, p, endp) -> next state (-1 = s_error). */
  run(): number {
    return this.fn("run", [this.pref, this.bufRef, I32, I32], [I32], (f, $) => {
      const c = f.c;
      this.c = c;
      this.L = {
        P: 0,
        buf: 1,
        p: 2,
        endp: 3,
        cur: f.local(I32),
        match: f.local(I32),
        start: f.local(I32),
        err: f.local(I32),
        avail: f.local(I32),
        need: f.local(I64),
        mss: f.local(I32),
        msc: f.local(I32),
        sw: f.local(I32),
      };
      this.inHelper = false;
      this.emitInitConsts($);
      const n = LL_STATES.length;
      $.put(this.L["cur"]!, $.get(this.PT, this.fieldIdx("_current"), $.l(0)));
      // The resumable check: llhttp only resumes in a `case` state.
      c.loop();
      for (let i = n - 1; i >= 0; i--) c.block();
      c.block(); // the default: not a resumable state
      c.localGet(this.L["cur"]!);
      // Inside n + 1 blocks: label k targets block k from the inside.
      c.brTable(Array.from({ length: n }, (_, i) => i + 1), 0);
      c.end();
      c.unreachable();
      for (let i = 0; i < n; i++) {
        c.end();
        // State i's body: the dispatch loop is (n - 1 - i) blocks out.
        const st = LL_STATES[i]!;
        this.loopDepth = n - 1 - i;
        this.depth = 0;
        this.curTable = st.table;
        this.stmts(st.body);
        c.unreachable();
      }
      c.end(); // loop
      c.unreachable();
      this.c = null;
      void this.resumable;
      void LL_START;
    });
  }

  /* ── src/http.c ─────────────────────────────────────────────────── */

  private g$(P: number, name: string, $: A): X {
    return $.get(this.PT, this.fieldIdx(name), $.l(P));
  }

  /** llhttp_message_needs_eof */
  messageNeedsEofFn(): number {
    return this.fn("messageNeedsEof", [this.pref], [I32], (f, $) => {
      const P = 0;
      const flags = this.g$(P, "flags", $);
      const st = this.g$(P, "status_code", $);
      $.if($.eq(this.g$(P, "type", $), $.i(HTTP_REQUEST)), () => $.ret($.i(0)));
      $.if(
        $.or(
          $.or($.eq($.raw((c) => { st(); c.i32Const(100); c.i32DivS(); }), $.i(1)), $.eq(st, $.i(204))),
          $.or($.eq(st, $.i(304)), $.ne($.and(flags, $.i(F_SKIPBODY)), $.i(0))),
        ),
        () => $.ret($.i(0)),
      );
      $.if(
        $.both($.ne($.and(flags, $.i(F_TRANSFER_ENCODING)), $.i(0)), $.eq($.and(flags, $.i(F_CHUNKED)), $.i(0))),
        () => $.ret($.i(1)),
      );
      $.if($.ne($.and(flags, $.i(F_CHUNKED | F_CONTENT_LENGTH)), $.i(0)), () => $.ret($.i(0)));
      $.do($.i(1));
    });
  }

  /** llhttp_should_keep_alive */
  shouldKeepAliveFn(): number {
    return this.fn("shouldKeepAlive", [this.pref], [I32], (f, $) => {
      const P = 0;
      const flags = this.g$(P, "flags", $);
      $.if(
        $.both($.gt(this.g$(P, "http_major", $), $.i(0)), $.gt(this.g$(P, "http_minor", $), $.i(0))),
        () => $.if($.ne($.and(flags, $.i(F_CONNECTION_CLOSE)), $.i(0)), () => $.ret($.i(0))),
        () => $.if($.eq($.and(flags, $.i(F_CONNECTION_KEEP_ALIVE)), $.i(0)), () => $.ret($.i(0))),
      );
      $.do($.not($.call(this.messageNeedsEofFn(), $.l(P))));
    });
  }

  private beforeHeadersCompleteFn(): number {
    return this.fn("beforeHeadersComplete", [this.pref], [I32], (f, $) => {
      const P = 0;
      const flags = this.g$(P, "flags", $);
      $.if(
        $.both($.ne($.and(flags, $.i(F_UPGRADE)), $.i(0)), $.ne($.and(flags, $.i(F_CONNECTION_UPGRADE)), $.i(0))),
        () => this.fset($, P, "upgrade", $.or($.eq(this.g$(P, "type", $), $.i(HTTP_REQUEST)), $.eq(this.g$(P, "status_code", $), $.i(101))), false),
        () => this.fset($, P, "upgrade", $.eq(this.g$(P, "method", $), $.i(HTTP_CONNECT)), false),
      );
      $.do($.i(0));
    });
  }

  private afterHeadersCompleteFn(): number {
    return this.fn("afterHeadersComplete", [this.pref], [I32], (f, $) => {
      const P = 0;
      const HAS = f.local(I32);
      const flags = this.g$(P, "flags", $);
      const st = this.g$(P, "status_code", $);
      const isResp = $.eq(this.g$(P, "type", $), $.i(HTTP_RESPONSE));
      $.put(HAS, $.or($.ne($.and(flags, $.i(F_CHUNKED)), $.i(0)), $.raw((c) => {
        c.localGet(P);
        c.structGet(this.PT, this.fieldIdx("content_length"));
        c.i64Const(0n);
        c.i64GtU();
      })));
      $.if(
        $.or(
          $.both(
            $.ne(this.g$(P, "upgrade", $), $.i(0)),
            $.or($.or($.eq(this.g$(P, "method", $), $.i(HTTP_CONNECT)), $.ne($.and(flags, $.i(F_SKIPBODY)), $.i(0))), $.not($.l(HAS))),
          ),
          $.both(isResp, $.eq(st, $.i(101))),
        ),
        () => $.ret($.i(1)),
      );
      $.if($.both(isResp, $.eq(st, $.i(100))), () => $.ret($.i(0)));
      $.if(
        $.or(
          $.ne($.and(flags, $.i(F_SKIPBODY)), $.i(0)),
          $.both(isResp, $.or($.or($.eq(st, $.i(102)), $.eq(st, $.i(103))), $.or($.eq(st, $.i(204)), $.eq(st, $.i(304))))),
        ),
        () => $.ret($.i(0)),
      );
      $.if($.ne($.and(flags, $.i(F_CHUNKED)), $.i(0)), () => $.ret($.i(2)));
      $.if($.ne($.and(flags, $.i(F_TRANSFER_ENCODING)), $.i(0)), () => {
        $.if(
          $.both(
            $.eq(this.g$(P, "type", $), $.i(HTTP_REQUEST)),
            $.eq($.and(this.g$(P, "lenient_flags", $), $.i(LENIENT_CHUNKED_LENGTH | LENIENT_TRANSFER_ENCODING)), $.i(0)),
          ),
          () => $.ret($.i(5)),
        );
        $.ret($.i(4));
      });
      $.if($.eq($.and(flags, $.i(F_CONTENT_LENGTH)), $.i(0)), () => {
        $.if($.not($.call(this.messageNeedsEofFn(), $.l(P))), () => $.ret($.i(0)));
        $.ret($.i(4));
      });
      $.if($.raw((c) => {
        c.localGet(P);
        c.structGet(this.PT, this.fieldIdx("content_length"));
        c.i64Eqz();
      }), () => $.ret($.i(0)));
      $.do($.i(3));
    });
  }

  private afterMessageCompleteFn(): number {
    return this.fn("afterMessageComplete", [this.pref], [I32], (f, $) => {
      const P = 0;
      const K = f.local(I32);
      $.put(K, $.call(this.shouldKeepAliveFn(), $.l(P)));
      this.fset($, P, "finish", $.i(HTTP_FINISH_SAFE), false);
      this.fset($, P, "flags", $.i(0), false);
      $.do($.l(K));
    });
  }

  /* ── src/api.c ──────────────────────────────────────────────────── */

  /** llhttp_init(parser, type, settings) — llhttp__internal_init's
   * memset, then the type. */
  initFn(): number {
    return this.fn("init", [this.pref, I32], [], (f, $) => {
      const P = 0;
      const PT = this.PT;
      const F = this.deps.fields;
      for (const name of Object.keys(F)) {
        const idx = (F as unknown as Record<string, number>)[name]!;
        if (name === "content_length") {
          f.c.localGet(P);
          f.c.i64Const(0n);
          f.c.structSet(PT, idx);
        } else if (name === "reason") {
          f.c.localGet(P);
          f.c.refNull((this.deps.strRef() as { typeIndex: number }).typeIndex);
          f.c.structSet(PT, idx);
        } else if (name === "_span_pos0") {
          $.set(PT, idx, $.l(P), $.i(-1));
        } else {
          $.set(PT, idx, $.l(P), $.i(0));
        }
      }
      $.set(PT, F._current, $.l(P), $.i(LL_START));
      $.set(PT, F.type, $.l(P), $.l(1));
    });
  }

  /** The span callback named by `_span_cb0`'s id. */
  private callSpanById($: A, P: number, B: number, id: X, start: X, end: X): X {
    return () => {
      const c = $.c;
      const R = $.local(I32);
      c.i32Const(0);
      c.localSet(R);
      for (const [name, n] of Object.entries(SPAN_CB)) {
        const cb = this.deps.spanCb(name);
        if (cb === null) continue;
        $.if($.eq(id, $.i(n)), () => $.put(R, $.call(cb, $.l(P), $.l(B), start, end)));
      }
      c.localGet(R);
    };
  }

  /** llhttp_execute(parser, buf, p, endp) -> errno (llhttp__internal_execute). */
  executeFn(): number {
    return this.fn("execute", [this.pref, this.bufRef, I32, I32], [I32], (f, $) => {
      const [P, B, PP, E] = [0, 1, 2, 3];
      const NEXT = f.local(I32);
      const ERR = f.local(I32);
      const F = this.deps.fields;
      const PT = this.PT;
      $.if($.ne($.get(PT, F.error, $.l(P)), $.i(0)), () => $.ret($.get(PT, F.error, $.l(P))));
      $.if($.ne($.get(PT, F._span_pos0, $.l(P)), $.i(-1)), () => $.set(PT, F._span_pos0, $.l(P), $.l(PP)));
      $.put(NEXT, $.call(this.run(), $.l(P), $.l(B), $.l(PP), $.l(E)));
      $.if($.eq($.l(NEXT), $.i(-1)), () => $.ret($.get(PT, F.error, $.l(P))));
      $.set(PT, F._current, $.l(P), $.l(NEXT));
      $.if($.ne($.get(PT, F._span_pos0, $.l(P)), $.i(-1)), () => {
        $.put(ERR, this.callSpanById($, P, B, $.get(PT, F._span_cb0, $.l(P)), $.get(PT, F._span_pos0, $.l(P)), $.l(E)));
        $.if($.ne($.l(ERR), $.i(0)), () => {
          $.set(PT, F.error, $.l(P), $.l(ERR));
          $.set(PT, F.error_pos, $.l(P), $.l(E));
          $.ret($.l(ERR));
        });
      });
      $.do($.i(0));
    });
  }

  /** llhttp_finish(parser) -> errno; `onComplete` is the
   * on_message_complete callback (CALLBACK_MAYBE). */
  finishFn(onComplete: number): number {
    return this.fn("finish", [this.pref], [I32], (f, $) => {
      const P = 0;
      const ERR = f.local(I32);
      const F = this.deps.fields;
      const PT = this.PT;
      $.if($.ne($.get(PT, F.error, $.l(P)), $.i(0)), () => $.ret($.i(0)));
      $.if($.eq($.get(PT, F.finish, $.l(P)), $.i(HTTP_FINISH_SAFE_WITH_CB)), () => {
        $.put(ERR, $.call(onComplete, $.l(P)));
        $.if($.ne($.l(ERR), $.i(HPE_OK)), () => $.ret($.l(ERR)));
        $.ret($.i(HPE_OK));
      });
      $.if($.eq($.get(PT, F.finish, $.l(P)), $.i(HTTP_FINISH_SAFE)), () => $.ret($.i(HPE_OK)));
      $.if($.eq($.get(PT, F.finish, $.l(P)), $.i(HTTP_FINISH_UNSAFE)), () => {
        f.c.localGet(P);
        this.deps.pushStrLit(f.c, "Invalid EOF state");
        f.c.structSet(PT, F.reason);
        $.ret($.i(HPE_INVALID_EOF_STATE));
      });
      $.trap(); // abort()
    });
  }

  /** llhttp_pause / llhttp_resume / llhttp_resume_after_upgrade. */
  pauseFn(): number {
    return this.fn("pause", [this.pref], [], (f, $) => {
      const P = 0;
      const F = this.deps.fields;
      $.if($.ne($.get(this.PT, F.error, $.l(P)), $.i(HPE_OK)), () => $.ret());
      $.set(this.PT, F.error, $.l(P), $.i(HPE_PAUSED));
      f.c.localGet(P);
      this.deps.pushStrLit(f.c, "Paused");
      f.c.structSet(this.PT, F.reason);
    });
  }

  resumeFn(): number {
    return this.fn("resume", [this.pref], [], (f, $) => {
      const P = 0;
      const F = this.deps.fields;
      $.if($.eq($.get(this.PT, F.error, $.l(P)), $.i(HPE_PAUSED)), () => $.set(this.PT, F.error, $.l(P), $.i(0)));
    });
  }

  resumeAfterUpgradeFn(): number {
    return this.fn("resumeAfterUpgrade", [this.pref], [], (f, $) => {
      const P = 0;
      const F = this.deps.fields;
      $.if($.eq($.get(this.PT, F.error, $.l(P)), $.i(HPE_PAUSED_UPGRADE)), () => $.set(this.PT, F.error, $.l(P), $.i(0)));
    });
  }
}
