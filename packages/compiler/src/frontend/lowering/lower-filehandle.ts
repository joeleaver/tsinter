/* fs/promises FileHandle on the WasmGC lanes: open() and the handle's
 * methods, each an already-settled promise (SEMANTICS.md S074) over the
 * fsCall ops of abi.ts (21, 25-30). The handle is the "fileHandle" IR kind
 * (a struct holding the descriptor, -1 once closed); every method on a
 * closed handle rejects Node's Error 'file closed' (code EBADF), and a
 * second close() resolves, as Node's own. The forms with no lowering
 * refuse by name: the streams and async iteration are the next step
 * ("not yet"); AbortSignal options, readv/writev, readLines and the
 * 'close' event have none. */
import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";
import { BYTES_U8, F64, FILEHANDLE_T, STATS_T, STRING, VOID, type IrExpr, type IrLibFn, type IrType } from "../../ir/nodes.js";
import { locOf } from "../program.js";

const NOT_YET = new Set(["createReadStream", "createWriteStream", "readableWebStream", "readLines"]);

const promiseOf = (inner: IrType): IrType => ({ kind: "promise", inner });

function isNullish(e: ts.Expression): boolean {
  return e.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(e) && e.text === "undefined");
}

/** A literal encoding argument naming UTF-8 ("utf8", "utf-8", or
 * { encoding: one of them }); null when absent; "other" for any other. */
function utf8Arg(e: ts.Expression | undefined): "utf8" | null | "other" {
  // absent, null, or { encoding: null | undefined }: no encoding (a Buffer)
  if (e === undefined || isNullish(e)) return null;
  const isUtf8 = (x: ts.Expression): boolean => ts.isStringLiteral(x) && (x.text === "utf8" || x.text === "utf-8");
  if (isUtf8(e)) return "utf8";
  if (
    ts.isObjectLiteralExpression(e) && e.properties.length === 1 &&
    ts.isPropertyAssignment(e.properties[0]!) && ts.isIdentifier(e.properties[0]!.name) &&
    e.properties[0]!.name.text === "encoding"
  ) {
    const v = e.properties[0]!.initializer;
    if (isUtf8(v)) return "utf8";
    if (isNullish(v)) return null;
  }
  return "other";
}

/** fs/promises open(path, flags?, mode?) -> Promise<FileHandle>. Null for
 * any other call. */
export function lowerFspOpenCall(L: Lowerer, call: ts.CallExpression, module: string, member: string): IrExpr | null {
  if (module !== "fs/promises" || member !== "open") return null;
  const args = call.arguments;
  const loc = locOf(call);
  if (args.some((a) => ts.isSpreadElement(a)) || args.length < 1 || args.length > 3) {
    return L.noLowering(`open with ${args.length} arguments`, call);
  }
  const path = L.lowerExprExpecting(args[0]!, STRING);
  if (path.type.kind !== "string") return L.noLowering(`open of a '${L.fmt(path.type)}' path`, args[0]!, "a string path is the lowered form");
  let fn: IrLibFn = "fsp.open";
  let flags: IrExpr = { kind: "strLit", value: "r", type: STRING, loc };
  const f = args[1];
  if (f !== undefined && !isNullish(f)) {
    const ft = L.typeOf(f);
    if (ts.isStringLiteral(f) || ts.isNoSubstitutionTemplateLiteral(f)) flags = { kind: "strLit", value: f.text, type: STRING, loc };
    else if (ft.isStringLiteralType()) flags = { kind: "strLit", value: ft.value, type: STRING, loc };
    else if ((ft.flags & ts.TypeFlags.NumberLike) !== 0) {
      fn = "fsp.openNum";
      flags = L.lowerExprExpecting(f, F64);
    } else {
      return L.noLowering("open with these flags", f, "a string literal ('r', 'wx', ...) or numeric fs.constants flags are the lowered forms");
    }
  }
  let mode: IrExpr = { kind: "numLit", value: 0o666, type: F64, loc };
  const m = args[2];
  if (m !== undefined && !isNullish(m)) {
    if (!ts.isNumericLiteral(m) || !Number.isInteger(Number(m.text)) || Number(m.text) > 0o7777) {
      return L.noLowering("open with this mode argument", m, "an integer literal mode (0o600, 0o644, ...) is the lowered form");
    }
    mode = { kind: "numLit", value: Number(m.text), type: F64, loc };
  }
  return { kind: "libCall", fn, args: [path, flags, mode], type: promiseOf(FILEHANDLE_T), loc };
}

function isFileHandle(L: Lowerer, e: ts.Expression): boolean {
  return L.mapTypeOf(L.typeOf(e))?.kind === "fileHandle";
}

/** handle.fd (the descriptor, -1 once closed); every other member read
 * refuses by name. */
export function lowerFileHandleProperty(L: Lowerer, expr: ts.PropertyAccessExpression): IrExpr {
  const name = expr.name.text;
  if (name === "fd" && expr.questionDotToken === undefined) {
    return { kind: "libCall", fn: "fh.fd", args: [L.lowerExpr(expr.expression)], type: F64, loc: locOf(expr) };
  }
  return L.noLowering(
    `FileHandle.${name}${NOT_YET.has(name) ? " (not yet)" : ""}`,
    expr,
    "fd and the methods close, stat, read, write, writeFile, readFile, sync, datasync, chmod and truncate are the lowered FileHandle members",
  );
}

/** The FileHandle methods. Null for any other receiver. */
export function lowerFileHandleMethodCall(L: Lowerer, call: ts.CallExpression, access: ts.PropertyAccessExpression): IrExpr | null {
  if (!isFileHandle(L, access.expression)) return null;
  const name = access.name.text;
  const loc = locOf(call);
  const args = call.arguments;
  const refuse = (what: string, hint?: string): never => L.noLowering(what, call, hint);
  if (call.questionDotToken || access.questionDotToken) refuse(`FileHandle.${name} through ?.`);
  if (args.some((a) => ts.isSpreadElement(a))) refuse(`FileHandle.${name} with a spread argument`);
  if (NOT_YET.has(name)) refuse(`FileHandle.${name} (not yet)`, "FileHandle streams and async iteration are the next step for this surface");
  const h = L.lowerExpr(access.expression);
  const num = (e: ts.Expression, what: string): IrExpr => {
    const x = L.lowerExprExpecting(e, F64);
    if (x.type.kind !== "f64") refuse(`FileHandle.${name} with a '${L.fmt(x.type)}' ${what}`);
    return x;
  };
  const bytes = (e: ts.Expression): IrExpr => {
    const x = L.lowerExpr(e);
    if (x.type.kind !== "bytes" || x.type.elem !== "u8") refuse(`FileHandle.${name} with a '${L.fmt(x.type)}' buffer`, "a Buffer or Uint8Array is the lowered buffer");
    return x;
  };
  const resultRecord = (count: string): IrType => {
    const t = L.mapTypeOf(L.typeOf(call));
    if (t?.kind !== "promise" || t.inner.kind !== "record") return refuse(`FileHandle.${name}'s result`);
    const shape = L.shapes.get(t.inner.shapeId);
    if (shape === undefined || !shape.fields.some((f) => f.name === count) || !shape.fields.some((f) => f.name === "buffer")) {
      return refuse(`FileHandle.${name}'s result`);
    }
    return t;
  };
  const lib = (fn: IrLibFn, rest: IrExpr[], type: IrType): IrExpr => ({ kind: "libCall", fn, args: [h, ...rest], type, loc });
  switch (name) {
    case "close":
      if (args.length !== 0) refuse(`FileHandle.close with ${args.length} arguments`);
      return lib("fh.close", [], promiseOf(VOID));
    case "stat": {
      if (args.length > 1) refuse(`FileHandle.stat with ${args.length} arguments`);
      const o = args[0];
      if (
        o !== undefined &&
        !(ts.isObjectLiteralExpression(o) && o.properties.every((p) => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === "bigint" &&
          (p.initializer.kind === ts.SyntaxKind.TrueKeyword || p.initializer.kind === ts.SyntaxKind.FalseKeyword)))
      ) {
        refuse("FileHandle.stat with this options argument", "a literal { bigint: true } or { bigint: false } is the lowered options bag");
      }
      return lib("fh.stat", [], promiseOf(STATS_T));
    }
    case "read": {
      if (args.length < 1 || args.length > 4) {
        refuse(`FileHandle.read with ${args.length} arguments`, "read(buffer[, offset[, length[, position]]]) is the lowered form");
      }
      const t = resultRecord("bytesRead");
      const buf = bytes(args[0]!);
      // Node: offset ??= 0; length ??= buffer.byteLength - offset (the
      // emitter computes it after the offset check: hasLength 0)
      const o = args[1];
      if (o !== undefined && !isNullish(o) && ts.isObjectLiteralExpression(o)) refuse("FileHandle.read with an options object", "read(buffer, offset, length, position) is the lowered form");
      const off = o === undefined || isNullish(o) ? { kind: "numLit" as const, value: 0, type: F64, loc } : num(o, "offset");
      const l = args[2];
      const hasLen = l !== undefined && !isNullish(l);
      const len = hasLen ? num(l, "length") : { kind: "numLit" as const, value: 0, type: F64, loc };
      const p = args[3];
      let pos: IrExpr = { kind: "numLit", value: -1, type: F64, loc };
      if (p !== undefined && !isNullish(p)) {
        if ((L.typeOf(p).flags & ts.TypeFlags.NumberLike) === 0) refuse("FileHandle.read with this position", "a number (or null) is the lowered position");
        pos = num(p, "position");
      }
      return lib("fh.read", [buf, off, len, pos, { kind: "numLit", value: hasLen ? 1 : 0, type: F64, loc }], t);
    }
    case "write": {
      if (args.length !== 1) refuse(`FileHandle.write with ${args.length} arguments`, "write(buffer) and write(string) are the lowered forms");
      const t = resultRecord("bytesWritten");
      const a = args[0]!;
      if ((L.typeOf(a).flags & ts.TypeFlags.StringLike) !== 0) {
        const text = L.lowerExprExpecting(a, STRING);
        const tmp = L.declareHiddenLocal("%fhText", STRING);
        const ref: IrExpr = { kind: "varRef", localId: tmp.id, type: STRING, loc };
        const enc: IrExpr = { kind: "strLit", value: "utf8", type: STRING, loc };
        return {
          kind: "seqExpr",
          stmts: [{ kind: "varDecl", localId: tmp.id, init: text, loc }],
          result: lib("fh.writeStr", [ref, { kind: "libCall", fn: "buffer.fromStr", args: [ref, enc], type: BYTES_U8, loc }], t),
          type: t,
          loc,
        };
      }
      return lib("fh.write", [bytes(a)], t);
    }
    case "writeFile": {
      if (args.length < 1 || args.length > 2) refuse(`FileHandle.writeFile with ${args.length} arguments`);
      if (utf8Arg(args[1]) === "other") refuse("FileHandle.writeFile with this options argument", "'utf8' (or { encoding: 'utf8' }) is the lowered option");
      const a = args[0]!;
      let data: IrExpr;
      if ((L.typeOf(a).flags & ts.TypeFlags.StringLike) !== 0) {
        const text = L.lowerExprExpecting(a, STRING);
        data = { kind: "libCall", fn: "buffer.fromStr", args: [text, { kind: "strLit", value: "utf8", type: STRING, loc }], type: BYTES_U8, loc };
      } else data = bytes(a);
      return lib("fh.writeFile", [data], promiseOf(VOID));
    }
    case "readFile": {
      if (args.length > 1) refuse(`FileHandle.readFile with ${args.length} arguments`);
      const enc = utf8Arg(args[0]);
      if (enc === "other") refuse("FileHandle.readFile with this encoding", "no encoding (a Buffer) or 'utf8' (a string) is the lowered form");
      return enc === "utf8" ? lib("fh.readFileStr", [], promiseOf(STRING)) : lib("fh.readFile", [], promiseOf(BYTES_U8));
    }
    case "sync":
    case "datasync":
      if (args.length !== 0) refuse(`FileHandle.${name} with ${args.length} arguments`);
      return lib("fh.sync", [{ kind: "numLit", value: name === "datasync" ? 1 : 0, type: F64, loc }], promiseOf(VOID));
    case "chmod":
      if (args.length !== 1) refuse(`FileHandle.chmod with ${args.length} arguments`);
      return lib("fh.chmod", [num(args[0]!, "mode")], promiseOf(VOID));
    case "truncate":
      if (args.length > 1) refuse(`FileHandle.truncate with ${args.length} arguments`);
      // Node's `len = 0` default: an absent or undefined length is 0
      return lib("fh.truncate", [args[0] === undefined || (ts.isIdentifier(args[0]) && args[0].text === "undefined") ? { kind: "numLit", value: 0, type: F64, loc } : num(args[0], "length")], promiseOf(VOID));
    default:
      return refuse(
        `FileHandle.${name}`,
        "fd and the methods close, stat, read, write, writeFile, readFile, sync, datasync, chmod and truncate are the lowered FileHandle members",
      );
  }
}
