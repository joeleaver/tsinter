/* INC-29 U4 — node:tls and node:https on the WasmGC tier.
 *
 * THE SPLIT (abi.ts tlsCall). The TLS engine is the HOST's: it builds a
 * secure context from the bytes the module hands it, secures an open net
 * handle as client or server, and answers facts — a context handle, the
 * handshake's completion with the X.509 verification code of the peer's
 * chain and the peer's leaf certificate as DER, a TLS failure's text.
 * Plaintext then travels over netCall's READ / WRITE path exactly as a
 * plain socket's bytes do. Everything Node does lives HERE, transcribed
 * from Node v24.18.1's lib/internal/tls/wrap.js, lib/tls.js,
 * lib/internal/tls/secure-context.js, lib/internal/tls/common.js,
 * lib/https.js and lib/_http_agent.js:
 *
 *   - createSecureContext's option ladders in configSecureContext's own
 *     order, with Node's exact texts; the tls.Server constructor's and
 *     tls.connect's checks around it.
 *   - the TLSSocket life cycle on the same $sock a net.Socket uses
 *     (net.ts carries S_TLS and the 'secureConnect' / 'secureConnection'
 *     lists in TLS modules only): _start, onConnectSecure (the host's
 *     verification code mapped to Node's code and OpenSSL's text, then
 *     tls.checkServerIdentity over the DER — tls-x509.ts), onConnectEnd,
 *     onServerSocketSecure, the 'secureConnect' / 'secureConnection'
 *     emits, socket.authorized / authorizationError.
 *   - the CA store: tls.rootCertificates and getCACertificates('bundled')
 *     from Node's own bundled roots (tls-roots.ts, data in the modules
 *     that read the store), 'system' / 'extra' from the host, 'default'
 *     as Node assembles it, setDefaultCACertificates with OpenSSL's PEM
 *     reading, X509_cmp's order and its errors. A client whose trust
 *     store is unmodified tells the host to use its default trust; once
 *     the store is replaced (or a `ca` option is given) the module sends
 *     the certificates themselves.
 *   - https: the server is an http server whose connection listener runs
 *     on 'secureConnection' (http.ts), the client an http ClientRequest
 *     whose Agent dials through tls.connect (http.ts hooks).
 *
 * SEMANTICS.md S090 registers where this tier and Node part. */
import { Code } from "./code.js";
import { A, Fn, type X } from "./asm.js";
import { F64, I32, ModuleBuilder, type ValType } from "./module.js";
import { EV_SECURE, EV_TLS_ERROR, NET_LISTS, NET_SOCK_HTTP, NetBuilder, type NetList } from "./net.js";
import { PEM_ASN1, PEM_BAD_BASE64, PEM_BAD_END_LINE, PEM_NONCANON, X509Builder, XI_BAD, XI_CN, XI_CN_N, XI_DNS, XI_DNS_N, XI_IPS, XI_IPS_N, XI_SAN } from "./tls-x509.js";
import { TLS_ROOTS_COUNT, tlsRootsBytes } from "./tls-roots.js";

const EQ_HEAP = -0x13;
const EQ_REF: ValType = { kind: "ref", nullable: true, typeIndex: EQ_HEAP };

/* tlsCall's ops (abi.ts). */
const OP_CTX_NEW = 1;
const OP_CTX_ROOTS = 2;
const OP_CTX_ADD_CA = 3;
const OP_CTX_SET_CERT = 4;
const OP_CTX_SET_KEY = 5;
const OP_SECURE = 6;
const OP_CA_STORE = 7;

const HOST_FAILURE = "tlsCall: host failure";
/** The reply room every material op gets (abi.ts: a failure's two runs). */
const REPLY_ROOM = 4096;

/* checked-dynamic kinds (dyn.ts DK). */
const K_NULL = 0;
const K_BOOL = 1;
const K_NUM = 2;
const K_STR = 3;
const K_ARR = 4;
const K_OBJ = 5;
const K_UNDEF = 6;
const K_BYTES = 7;
const K_FUNC = 8;

/** OpenSSL 3.5's X509_V_ERR_* numbering: Node's code name
 * (ncrypto X509Pointer::ErrorCode, "UNSPECIFIED" for the rest) and
 * X509_verify_cert_error_string's text. */
const VERIFY: readonly (readonly [number, string, string])[] = [
  [1, "UNSPECIFIED", "unspecified certificate verification error"],
  [2, "UNABLE_TO_GET_ISSUER_CERT", "unable to get issuer certificate"],
  [3, "UNABLE_TO_GET_CRL", "unable to get certificate CRL"],
  [4, "UNABLE_TO_DECRYPT_CERT_SIGNATURE", "unable to decrypt certificate's signature"],
  [5, "UNABLE_TO_DECRYPT_CRL_SIGNATURE", "unable to decrypt CRL's signature"],
  [6, "UNABLE_TO_DECODE_ISSUER_PUBLIC_KEY", "unable to decode issuer public key"],
  [7, "CERT_SIGNATURE_FAILURE", "certificate signature failure"],
  [8, "CRL_SIGNATURE_FAILURE", "CRL signature failure"],
  [9, "CERT_NOT_YET_VALID", "certificate is not yet valid"],
  [10, "CERT_HAS_EXPIRED", "certificate has expired"],
  [11, "CRL_NOT_YET_VALID", "CRL is not yet valid"],
  [12, "CRL_HAS_EXPIRED", "CRL has expired"],
  [13, "ERROR_IN_CERT_NOT_BEFORE_FIELD", "format error in certificate's notBefore field"],
  [14, "ERROR_IN_CERT_NOT_AFTER_FIELD", "format error in certificate's notAfter field"],
  [15, "ERROR_IN_CRL_LAST_UPDATE_FIELD", "format error in CRL's lastUpdate field"],
  [16, "ERROR_IN_CRL_NEXT_UPDATE_FIELD", "format error in CRL's nextUpdate field"],
  [17, "OUT_OF_MEM", "out of memory"],
  [18, "DEPTH_ZERO_SELF_SIGNED_CERT", "self-signed certificate"],
  [19, "SELF_SIGNED_CERT_IN_CHAIN", "self-signed certificate in certificate chain"],
  [20, "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "unable to get local issuer certificate"],
  [21, "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "unable to verify the first certificate"],
  [22, "CERT_CHAIN_TOO_LONG", "certificate chain too long"],
  [23, "CERT_REVOKED", "certificate revoked"],
  [24, "UNSPECIFIED", "issuer certificate doesn't have a public key"],
  [25, "PATH_LENGTH_EXCEEDED", "path length constraint exceeded"],
  [26, "INVALID_PURPOSE", "unsuitable certificate purpose"],
  [27, "CERT_UNTRUSTED", "certificate not trusted"],
  [28, "CERT_REJECTED", "certificate rejected"],
  [29, "UNSPECIFIED", "subject issuer mismatch"],
  [30, "UNSPECIFIED", "authority and subject key identifier mismatch"],
  [31, "UNSPECIFIED", "authority and issuer serial number mismatch"],
  [32, "UNSPECIFIED", "key usage does not include certificate signing"],
  [33, "UNSPECIFIED", "unable to get CRL issuer certificate"],
  [34, "UNSPECIFIED", "unhandled critical extension"],
  [35, "UNSPECIFIED", "key usage does not include CRL signing"],
  [36, "UNSPECIFIED", "unhandled critical CRL extension"],
  [37, "UNSPECIFIED", "invalid non-CA certificate (has CA markings)"],
  [38, "UNSPECIFIED", "proxy path length constraint exceeded"],
  [39, "UNSPECIFIED", "key usage does not include digital signature"],
  [40, "UNSPECIFIED", "proxy certificates not allowed, please set the appropriate flag"],
  [41, "UNSPECIFIED", "invalid or inconsistent certificate extension"],
  [42, "UNSPECIFIED", "invalid or inconsistent certificate policy extension"],
  [43, "UNSPECIFIED", "no explicit policy"],
  [44, "UNSPECIFIED", "different CRL scope"],
  [45, "UNSPECIFIED", "unsupported extension feature"],
  [46, "UNSPECIFIED", "RFC 3779 resource not subset of parent's resources"],
  [47, "UNSPECIFIED", "permitted subtree violation"],
  [48, "UNSPECIFIED", "excluded subtree violation"],
  [49, "UNSPECIFIED", "name constraints minimum and maximum not supported"],
  [50, "UNSPECIFIED", "application verification failure"],
  [51, "UNSPECIFIED", "unsupported name constraint type"],
  [52, "UNSPECIFIED", "unsupported or invalid name constraint syntax"],
  [53, "UNSPECIFIED", "unsupported or invalid name syntax"],
  [54, "UNSPECIFIED", "CRL path validation error"],
  [55, "UNSPECIFIED", "path loop"],
  [56, "UNSPECIFIED", "Suite B: certificate version invalid"],
  [57, "UNSPECIFIED", "Suite B: invalid public key algorithm"],
  [58, "UNSPECIFIED", "Suite B: invalid ECC curve"],
  [59, "UNSPECIFIED", "Suite B: invalid signature algorithm"],
  [60, "UNSPECIFIED", "Suite B: curve not allowed for this LOS"],
  [61, "UNSPECIFIED", "Suite B: cannot sign P-384 with P-256"],
  [62, "HOSTNAME_MISMATCH", "hostname mismatch"],
  [63, "UNSPECIFIED", "email address mismatch"],
  [64, "UNSPECIFIED", "IP address mismatch"],
  [65, "UNSPECIFIED", "no matching DANE TLSA records"],
  [66, "UNSPECIFIED", "EE certificate key too weak"],
  [67, "UNSPECIFIED", "CA certificate key too weak"],
  [68, "UNSPECIFIED", "CA signature digest algorithm too weak"],
  [69, "UNSPECIFIED", "invalid certificate verification context"],
  [70, "UNSPECIFIED", "issuer certificate lookup error"],
  [71, "UNSPECIFIED", "Certificate Transparency required, but no valid SCTs found"],
  [72, "UNSPECIFIED", "proxy subject name violation"],
  [73, "UNSPECIFIED", "OCSP verification needed"],
  [74, "UNSPECIFIED", "OCSP verification failed"],
  [75, "UNSPECIFIED", "OCSP unknown cert"],
  [76, "UNSPECIFIED", "Cannot find certificate signature algorithm"],
  [77, "UNSPECIFIED", "subject signature algorithm and issuer public key algorithm mismatch"],
  [78, "UNSPECIFIED", "cert info signature and signature algorithm mismatch"],
  [79, "INVALID_CA", "invalid CA certificate"],
  [80, "UNSPECIFIED", "Path length invalid for non-CA cert"],
  [81, "UNSPECIFIED", "Path length given without key usage keyCertSign"],
  [82, "UNSPECIFIED", "Key usage keyCertSign invalid for non-CA cert"],
  [83, "UNSPECIFIED", "Issuer name empty"],
  [84, "UNSPECIFIED", "Subject name empty"],
  [85, "UNSPECIFIED", "Missing Authority Key Identifier"],
  [86, "UNSPECIFIED", "Missing Subject Key Identifier"],
  [87, "UNSPECIFIED", "Empty Subject Alternative Name extension"],
  [88, "UNSPECIFIED", "Subject empty and Subject Alt Name extension not critical"],
  [89, "UNSPECIFIED", "Basic Constraints of CA cert not marked critical"],
  [90, "UNSPECIFIED", "Authority Key Identifier marked critical"],
  [91, "UNSPECIFIED", "Subject Key Identifier marked critical"],
  [92, "UNSPECIFIED", "CA cert does not include key usage extension"],
  [93, "UNSPECIFIED", "Using cert extension requires at least X509v3"],
  [94, "UNSPECIFIED", "Certificate public key has explicit ECC parameters"],
  [95, "UNSPECIFIED", "Raw public key untrusted, no trusted keys configured"],
];

/* ── $tls: one TLSSocket's state (the $sock's S_TLS) ─────────────────── */
const X_MODE = 0; // i32: 1 client, 2 server
const X_CTX = 1; // i32: the host context
const X_SECURE = 2; // i32: _secureEstablished
const X_CTRL = 3; // i32: _controlReleased
const X_AUTH = 4; // i32: authorized
const X_AUTHERR = 5; // string: authorizationError (null)
const X_HOSTID = 6; // string: getSessionServerIdentity(options)
const X_SNI = 7; // string: the servername sent (null = none)
const X_REJECT = 8; // i32: options.rejectUnauthorized !== false
const X_PEER = 9; // bytes: the peer's leaf certificate (DER)
const X_HADERR = 10; // i32: _hadError
const X_SOCK = 11; // $sock
const X_SRV = 12; // $srv (server sockets)
const X_ENDCB = 13; // eqref: onConnectEnd, the prepended 'end' listener
const X_REL = 14; // i32: the module accepted the handshake: writes go to the host
const X_HELD = 15; // bytes: a write held until then (null)

/* ── $tsrv: a tls.Server's state (the $srv's V_TLS) ─────────────────── */
const TS_CTX = 0; // i32
const TS_HTTPS = 1; // i32

/* ── $tlso: an https request's TLS options (http.ts carries it) ─────── */
export const TO_REJECT = 0; // i32
export const TO_CA = 1; // bytes, null = none
export const TO_CANAME = 2; // string: `options.ca` as getName prints it ("" = none)

/* closure environment fields */
const E_A = 1;
const E_B = 2;
const E_N = 3;

type Env = { a: number; b: number; n: number };

export interface TlsDeps {
  net: () => NetBuilder;
  strRef: () => ValType;
  strType: () => number;
  pushStrLit: (c: Code, value: string) => void;
  concat: () => number;
  f64ToStr: () => number;
  strEq: () => number;
  tlsCallFunc: () => number;
  ensureCapacity: (c: Code, need: () => void) => void;
  stageCursor: () => number;
  namedTrap: (c: Code, message: string) => void;
  voidClos: () => { clos: number; fn: number };
  errClos: () => { clos: number; fn: number };
  sockClos: () => { clos: number; fn: number };
  nextTickEnqueue: () => number;
  excKind: () => number;
  errType: () => number;
  newError: (c: Code, className: string, name: string, pushMessage: (c: Code) => void, pushCode: (c: Code) => void) => void;
  throwStack: (c: Code) => void;
  bytesType: () => number;
  bufType: () => number;
  /** `(string) -> bytes`, Buffer.from(s, 'utf8'). */
  strToBytes: () => number;
  /** `(bytes) -> string`, buf.toString('utf8'). */
  utf8Decode: () => number;
  /** `(f64) -> string`, ERR_OUT_OF_RANGE's "Received" rendering. */
  numReceived: () => number;
  /** `(string) -> string`, util.inspect of a string. */
  inspectStr: () => number;
  /** `(dyn, recurse f64, depth f64) -> string`, util.inspect. */
  inspectDyn: () => number;
  /** `(dyn) -> string`, util.format's %j. */
  formatJ: () => number;
  dynRef: () => ValType;
  dynT: () => number;
  objT: () => number;
  /** `(obj, key) -> dyn | null` */
  objGet: () => number;
  /** `(dyn) -> i32` */
  truthy: () => number;
  /** `(dyn) -> string`: ERR_INVALID_ARG_TYPE's "Received ..." */
  specificType: () => number;
  /** `(dyn) -> bytes`: a BYTES value's bytes. */
  dynBytes: () => number;
  /** The checked-dynamic ARR payload: vec struct, its buffer type. */
  dynArrVec: () => { struct: number; bufType: number };
  /** The string[] vector: struct (len, buf), its buffer type. */
  strVec: () => { struct: number; bufType: number };
  /** The module can replace the default CA set (tls.setDefaultCACertificates). */
  caSet: boolean;
  /** The module's one X509Builder (shared with crypto.ts). */
  x509: () => X509Builder;
}

export class TlsBuilder {
  private readonly fns = new Map<string, number>();
  private readonly types = new Map<string, number>();
  private globalsField: {
    user: number;
    userN: number;
    bundled: number;
    dflt: number;
    system: number;
    extra: number;
    roots: number;
    rootsLen: number;
  } | null = null;
  private x509Field: X509Builder | null = null;

  constructor(
    private readonly mb: ModuleBuilder,
    private readonly deps: TlsDeps,
  ) {}

  /* ── plumbing ─────────────────────────────────────────────────────── */

  get net(): NetBuilder {
    return this.deps.net();
  }

  get x509(): X509Builder {
    this.x509Field ??= this.deps.x509();
    return this.x509Field;
  }

  private fn(name: string, params: ValType[], results: ValType[], build: (f: Fn, $: A) => void): number {
    const hit = this.fns.get(name);
    if (hit !== undefined) return hit;
    const idx = this.mb.declareFunc(this.mb.funcType(params, results), `%w.tls.${name}`);
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
  private get B(): number {
    return this.deps.bufType();
  }
  private get sockRef(): ValType {
    return this.net.sockRef();
  }
  private get sockT(): number {
    return this.net.sockType();
  }
  private get srvRef(): ValType {
    return this.net.srvRef();
  }
  private get srvT(): number {
    return this.net.srvType();
  }
  private get dynRef(): ValType {
    return this.deps.dynRef();
  }
  private get DT(): number {
    return this.deps.dynT();
  }
  private get tf(): ReturnType<NetBuilder["tlsFields"]> {
    return this.net.tlsFields();
  }

  private type(key: string, make: () => number): number {
    const hit = this.types.get(key);
    if (hit !== undefined) return hit;
    const t = make();
    this.types.set(key, t);
    return t;
  }

  /** $tls */
  xT(): number {
    return this.type("x", () =>
      this.mb.openStructType("tls:sock", [
        { storage: I32, mutable: true }, // X_MODE
        { storage: I32, mutable: true }, // X_CTX
        { storage: I32, mutable: true }, // X_SECURE
        { storage: I32, mutable: true }, // X_CTRL
        { storage: I32, mutable: true }, // X_AUTH
        { storage: this.strRef, mutable: true }, // X_AUTHERR
        { storage: this.strRef, mutable: true }, // X_HOSTID
        { storage: this.strRef, mutable: true }, // X_SNI
        { storage: I32, mutable: true }, // X_REJECT
        { storage: this.bytesRef, mutable: true }, // X_PEER
        { storage: I32, mutable: true }, // X_HADERR
        { storage: this.sockRef, mutable: true }, // X_SOCK
        { storage: this.srvRef, mutable: true }, // X_SRV
        { storage: EQ_REF, mutable: true }, // X_ENDCB
        { storage: I32, mutable: true }, // X_REL
        { storage: this.bytesRef, mutable: true }, // X_HELD
      ]),
    );
  }
  private get xRef(): ValType {
    return this.ref(this.xT());
  }

  /** $tsrv */
  private tsT(): number {
    return this.type("ts", () =>
      this.mb.openStructType("tls:srv", [
        { storage: I32, mutable: true },
        { storage: I32, mutable: true },
      ]),
    );
  }

  /** $tlso */
  tlsoT(): number {
    return this.type("tlso", () =>
      this.mb.openStructType("tls:opts", [
        { storage: I32, mutable: false },
        { storage: this.bytesRef, mutable: false },
        { storage: this.strRef, mutable: false },
      ]),
    );
  }
  tlsoRef(): ValType {
    return this.ref(this.tlsoT());
  }

  /** type:secureCtx — tls.createSecureContext's answer: the host context. */
  sctxT(): number {
    return this.type("sctx", () => this.mb.openStructType("tls:ctx", [{ storage: I32, mutable: false }]));
  }
  sctxRef(): ValType {
    return this.ref(this.sctxT());
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
  private excReturn($: A, v?: X): void {
    $.if($.g(this.deps.excKind()), () => $.ret(v));
  }

  /* ── errors ───────────────────────────────────────────────────────── */

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
  /** A named fence: "<what> is not supported yet". */
  private fence($: A, what: X): void {
    this.throwErr($, "%Error", this.cat($, what, this.lit($, " is not supported yet")), null);
  }
  /** ERR_INVALID_ARG_TYPE: `The "<name>" property|argument must be <expected>. Received ...` */
  private argType($: A, name: string, expected: string, d: X): void {
    const kind = name.includes(".") ? "property" : "argument";
    this.throwErr($, "%TypeError", this.cat($, this.lit($, `The "${name}" ${kind} must be ${expected}. Received `), $.call(this.deps.specificType(), d)), "ERR_INVALID_ARG_TYPE");
  }
  /** ERR_INVALID_ARG_VALUE: `The property|argument '<name>' <reason>. Received <inspect>` */
  private argValue($: A, name: string, rendered: X, reason = "is invalid"): void {
    const kind = name.includes(".") ? "property" : "argument";
    this.throwErr($, "%TypeError", this.cat($, this.lit($, `The ${kind} '${name}' ${reason}. Received `), $.call(this.cut128Fn(), rendered)), "ERR_INVALID_ARG_VALUE");
  }

  /** inspect's ERR_INVALID_ARG_VALUE cut: over 128 chars -> 128 + '...' */
  private cut128Fn(): number {
    return this.fn("cut128", [this.strRef], [this.strRef], (f, $) => {
      const R = f.local(this.strRef);
      $.if($.le($.alen($.l(0)), $.i(128)), () => $.ret($.l(0)));
      $.put(R, $.anew(this.S, $.i(128)));
      $.do($.l(R), $.i(0), $.l(0), $.i(0), $.i(128));
      f.c.arrayCopy(this.S, this.S);
      $.do(this.cat($, $.l(R), this.lit($, "...")));
    });
  }

  private inspectDyn($: A, d: X): X {
    return $.call(this.deps.inspectDyn(), d, $.d(0), $.d(2));
  }

  /* ── dyn reading ──────────────────────────────────────────────────── */

  /** A member's kind; an absent member (null) reads as undefined. */
  private kind($: A, d: X): X {
    return $.sel(I32, $.isNull(d), $.i(K_UNDEF), $.get(this.DT, 0, d));
  }
  /** `d == null` (absent, undefined or null) */
  private nullish($: A, d: X): X {
    return $.orElse($.isNull(d), $.either($.eq(this.kind($, d), $.i(K_UNDEF)), $.eq(this.kind($, d), $.i(K_NULL))));
  }
  private truthy($: A, d: X): X {
    return $.andThen($.notNull(d), $.call(this.deps.truthy(), d));
  }
  private isKind($: A, d: X, k: number): X {
    return $.andThen($.notNull(d), $.eq(this.kind($, d), $.i(k)));
  }
  private dstr($: A, d: X): X {
    return $.cast(this.S, $.get(this.DT, 2, d));
  }
  /** A string or ArrayBufferView's bytes (validateKeyOrCertOption has
   * passed): a string's UTF-8, a view's bytes. */
  private pemBytes($: A, d: X): X {
    return $.sel(this.bytesRef, $.eq(this.kind($, d), $.i(K_STR)), $.call(this.deps.strToBytes(), this.dstr($, d)), $.call(this.deps.dynBytes(), d));
  }

  /* ── closures ─────────────────────────────────────────────────────── */

  private pairOf(kind: "void" | "sock" | "err"): { clos: number; fn: number } {
    return kind === "void" ? this.deps.voidClos() : kind === "sock" ? this.deps.sockClos() : this.deps.errClos();
  }

  private envT(kind: "void" | "sock" | "err"): number {
    const pair = this.pairOf(kind);
    return this.type(`env:${kind}`, () =>
      this.mb.subStructType(
        `%w.tls.env.${kind}`,
        [
          { storage: { kind: "ref", nullable: false, typeIndex: pair.fn }, mutable: false },
          { storage: EQ_REF, mutable: false },
          { storage: EQ_REF, mutable: false },
          { storage: I32, mutable: false },
        ],
        pair.clos,
      ),
    );
  }

  private closFn(name: string, kind: "void" | "sock" | "err", body: ($: A, env: Env, f: Fn, arg: number) => void): number {
    const key = `clos.${name}`;
    const hit = this.fns.get(key);
    if (hit !== undefined) return hit;
    const pair = this.pairOf(kind);
    const idx = this.mb.declareFunc(pair.fn, `%w.tls.${name}`);
    this.fns.set(key, idx);
    const env = this.envT(kind);
    const nparams = kind === "void" ? 1 : 2;
    const f = new Fn(nparams);
    const $ = new A(f);
    const e: Env = { a: f.local(EQ_REF), b: f.local(EQ_REF), n: f.local(I32) };
    $.put(e.a, $.get(env, E_A, $.cast(env, $.l(0))));
    $.put(e.b, $.get(env, E_B, $.cast(env, $.l(0))));
    $.put(e.n, $.get(env, E_N, $.cast(env, $.l(0))));
    body($, e, f, nparams > 1 ? 1 : -1);
    this.mb.setBody(idx, f.locals, f.c.bytes());
    return idx;
  }

  private clos($: A, fn: number, kind: "void" | "sock" | "err", parts: { a?: X; b?: X; n?: X }): X {
    return () => {
      this.mb.declareFuncRef(fn);
      $.c.refFunc(fn);
      (parts.a ?? (() => $.c.refNull(EQ_HEAP)))();
      (parts.b ?? (() => $.c.refNull(EQ_HEAP)))();
      (parts.n ?? (() => $.c.i32Const(0)))();
      $.c.structNew(this.envT(kind));
    };
  }

  private son($: A, list: NetList, owner: X, clos: X, once = false, prepend = false): void {
    $.run(this.net.addHelper(list), owner, clos, $.i(once ? 1 : 0), $.i(prepend ? 1 : 0));
  }

  /* ── the host ─────────────────────────────────────────────────────── */

  private tlsCall($: A, op: number, ptr: X, len: X, h: X, x: X): X {
    return $.call(this.deps.tlsCallFunc(), $.i(op), ptr, len, h, x);
  }
  private trap($: A): void {
    this.deps.namedTrap($.c, HOST_FAILURE);
  }
  /** local = the stage base (the cursor rounded up to 4) */
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
  /** The byte size of the UTF-16 run at addr. */
  private runSize($: A, addr: X): X {
    return $.add($.i(4), $.and($.add($.shl(this.loadU32($, addr), $.i(1)), $.i(3)), $.i(-4)));
  }

  /** `(ptr) -> err`: a failure reply — the message run, the code run. */
  private hostErrFn(): number {
    return this.fn("hostErr", [I32], [this.errRef], (f, $) => {
      const P = 0;
      const MSG = f.local(this.strRef);
      const CODE = f.local(this.strRef);
      $.put(MSG, $.call(this.net.readRunHelper(), $.l(P)));
      $.put(CODE, $.call(this.net.readRunHelper(), $.add($.l(P), this.runSize($, $.l(P)))));
      $.do(() => this.deps.newError(f.c, "%Error", "Error", (c) => c.localGet(MSG), (c) => {
        c.localGet(CODE);
        c.arrayLen();
        c.ifResult(this.strRef);
        c.localGet(CODE);
        c.else_();
        c.refNull(this.S);
        c.end();
      }));
    });
  }

  /** Stage a blob (u32 byte count, the bytes, padding) at ptr -> the next ptr. */
  private stageBlobFn(): number {
    return this.fn("stageBlob", [I32, this.bytesRef], [I32], (f, $) => {
      const [P, V] = [0, 1];
      const I = f.local(I32);
      const N = f.local(I32);
      const BUF = f.local(this.ref(this.B));
      const OFF = f.local(I32);
      $.put(N, $.get(this.BT, 2, $.l(V)));
      $.put(BUF, $.get(this.BT, 0, $.l(V)));
      $.put(OFF, $.get(this.BT, 1, $.l(V)));
      this.storeU32($, $.l(P), $.l(N));
      $.for(I, $.i(0), $.l(N), () => {
        $.do($.add($.add($.l(P), $.i(4)), $.l(I)), $.agetU(this.B, $.l(BUF), $.add($.l(OFF), $.l(I))));
        f.c.i32Store8();
      });
      $.do($.add($.add($.l(P), $.i(4)), $.and($.add($.l(N), $.i(3)), $.i(-4))));
    });
  }

  /** Stage a string run at ptr -> the next ptr (an empty run for null). */
  private stageRunFn(): number {
    return this.fn("stageRun", [I32, this.strRef], [I32], (f, $) => {
      const [P, S] = [0, 1];
      const I = f.local(I32);
      const N = f.local(I32);
      $.if($.notNull($.l(S)), () => $.put(N, $.alen($.l(S))));
      this.storeU32($, $.l(P), $.l(N));
      $.for(I, $.i(0), $.l(N), () => {
        $.do($.add($.add($.l(P), $.i(4)), $.shl($.l(I), $.i(1))), $.agetU(this.S, $.l(S), $.l(I)));
        f.c.i32Store8();
        $.do($.add($.add($.l(P), $.i(5)), $.shl($.l(I), $.i(1))), $.shrU($.agetU(this.S, $.l(S), $.l(I)), $.i(8)));
        f.c.i32Store8();
      });
      $.do($.add($.add($.l(P), $.i(4)), $.and($.add($.shl($.l(N), $.i(1)), $.i(3)), $.i(-4))));
    });
  }

  /* ── contexts ─────────────────────────────────────────────────────── */

  /** `(server) -> ctx` */
  private ctxNewFn(): number {
    return this.fn("ctxNew", [I32], [I32], (f, $) => {
      const R = f.local(I32);
      $.put(R, this.tlsCall($, OP_CTX_NEW, $.i(0), $.i(0), $.i(0), $.l(0)));
      $.if($.lt($.l(R), $.i(1)), () => this.trap($));
      $.do($.l(R));
    });
  }

  /** `(op, ctx, bytes) -> i32`: CTX_ADD_CA / SET_CERT / SET_KEY; 0 with
   * the host's error pending. */
  private ctxPutFn(): number {
    return this.fn("ctxPut", [I32, I32, this.bytesRef], [I32], (f, $) => {
      const [OP, CTX, V] = [0, 1, 2];
      const BASE = f.local(I32);
      const END = f.local(I32);
      const R = f.local(I32);
      this.deps.ensureCapacity(f.c, () => {
        $.do($.add($.get(this.BT, 2, $.l(V)), $.i(REPLY_ROOM + 16)));
      });
      this.base($, BASE);
      $.put(END, $.call(this.stageBlobFn(), $.l(BASE), $.l(V)));
      $.put(R, $.call(this.deps.tlsCallFunc(), $.l(OP), $.l(BASE), $.sub($.l(END), $.l(BASE)), $.l(CTX), $.add($.sub($.l(END), $.l(BASE)), $.i(REPLY_ROOM))));
      $.if($.eq($.l(R), $.i(0)), () => $.ret($.i(1)));
      $.if($.ne($.l(R), $.i(-1)), () => this.trap($));
      $.do($.call(this.hostErrFn(), $.l(BASE)));
      this.deps.throwStack(f.c);
      $.do($.i(0));
    });
  }

  /** context.addRootCerts(): the default store — the host's own, or the
   * set setDefaultCACertificates installed. -> i32 (0 = error pending). */
  private ctxRootsFn(): number {
    return this.fn("ctxRoots", [I32], [I32], (f, $) => {
      const CTX = 0;
      const I = f.local(I32);
      if (this.deps.caSet) {
        const g = this.g();
        $.if($.notNull($.g(g.user)), () => {
          $.for(I, $.i(0), $.g(g.userN), () => {
            $.if($.not($.call(this.ctxPutFn(), $.i(OP_CTX_ADD_CA), $.l(CTX), $.call(this.deps.strToBytes(), $.aget(this.x509.SA, $.g(g.user), $.l(I))))), () => $.ret($.i(0)));
          });
          $.ret($.i(1));
        });
      }
      $.if($.ne(this.tlsCall($, OP_CTX_ROOTS, $.i(0), $.i(0), $.l(CTX), $.i(0)), $.i(0)), () => this.trap($));
      $.do($.i(1));
    });
  }

  /** tls.createServer(cert, key) / https.createServer(cert, key): a server
   * context from the two PEM values -> ctx (0 = error pending). */
  serverCtxFn(): number {
    return this.fn("serverCtx", [this.bytesRef, this.bytesRef], [I32], (f, $) => {
      const [CERT, KEY] = [0, 1];
      const CTX = f.local(I32);
      $.put(CTX, $.call(this.ctxNewFn(), $.i(1)));
      $.if($.not($.call(this.ctxRootsFn(), $.l(CTX))), () => $.ret($.i(0)));
      $.if($.gt($.get(this.BT, 2, $.l(CERT)), $.i(0)), () => {
        $.if($.not($.call(this.ctxPutFn(), $.i(OP_CTX_SET_CERT), $.l(CTX), $.l(CERT))), () => $.ret($.i(0)));
      });
      $.if($.gt($.get(this.BT, 2, $.l(KEY)), $.i(0)), () => {
        $.if($.not($.call(this.ctxPutFn(), $.i(OP_CTX_SET_KEY), $.l(CTX), $.l(KEY))), () => $.ret($.i(0)));
      });
      $.do($.l(CTX));
    });
  }

  /** `(ctx) -> $sctx` */
  sctxNewFn(): number {
    return this.fn("sctxNew", [I32], [this.sctxRef()], (f, $) => $.do($.new_(this.sctxT(), $.l(0))));
  }

  /** A version option's toV: -1 for an invalid value (thrown), 0 for the
   * default, 1 for another valid version. */
  private versionFn(which: "minimum" | "maximum"): number {
    const dflt = which === "minimum" ? "TLSv1.2" : "TLSv1.3";
    return this.fn(`toV.${which}`, [this.dynRef], [I32], (f, $) => {
      const D = 0;
      $.if(this.nullish($, $.l(D)), () => $.ret($.i(0)));
      $.if($.eq(this.kind($, $.l(D)), $.i(K_STR)), () => {
        $.if(this.streq($, this.dstr($, $.l(D)), this.lit($, dflt)), () => $.ret($.i(0)));
        for (const v of ["TLSv1", "TLSv1.1", "TLSv1.2", "TLSv1.3"]) {
          $.if(this.streq($, this.dstr($, $.l(D)), this.lit($, v)), () => $.ret($.i(1)));
        }
      });
      this.throwErr($, "%TypeError", this.cat($, $.call(this.deps.formatJ(), $.l(D)), this.lit($, ` is not a valid ${which} TLS protocol version`)), "ERR_TLS_INVALID_PROTOCOL_VERSION");
      $.do($.i(-1));
    });
  }

  /** validateKeyOrCertOption(name, d): a string or an ArrayBufferView. */
  private keyOrCert($: A, name: string, d: X, onFail: () => void): void {
    $.if($.not($.either($.eq(this.kind($, d), $.i(K_STR)), $.eq(this.kind($, d), $.i(K_BYTES)))), () => {
      this.argType($, name, "of type string or an instance of Buffer, TypedArray, or DataView", d);
      onFail();
    });
  }

  /** createSecureContext(options) over a checked-dynamic options value:
   * Node's SecureContext constructor and configSecureContext, in order.
   * `pick` is tls.Server's setSecureContext, which passes the falsy
   * members it tests with `if (options.x)` as undefined. An option this
   * tier does not implement is a named fence at the point Node would use
   * it. -> ctx (0 = error pending). */
  ctxFromDynFn(pick: boolean): number {
    return this.fn(`ctxFromDyn${pick ? ".pick" : ""}`, [this.dynRef, I32, this.strRef], [I32], (f, $) => {
      const [OPTS, SERVER, API] = [0, 1, 2];
      const O = f.local(this.ref(this.deps.objT()));
      const V = f.local(this.dynRef);
      const V2 = f.local(this.dynRef);
      const KEYV = f.local(this.dynRef);
      const PASS = f.local(this.dynRef);
      const CTX = f.local(I32);
      const I = f.local(I32);
      const N = f.local(I32);
      const E = f.local(this.dynRef);
      const R = f.local(I32);
      const vec = this.deps.dynArrVec();
      const PICKED = new Set(["pfx", "key", "passphrase", "cert", "clientCertEngine", "ca", "minVersion", "maxVersion", "secureProtocol", "crl", "ciphers", "dhparam", "sessionIdContext", "sessionTimeout", "ticketKeys", "secureOptions"]);
      const get = (key: string): X => () => {
        $.do($.sel(this.dynRef, $.isNull($.l(O)), $.nul(this.DT), $.call(this.deps.objGet(), $.l(O), this.lit($, key))));
        if (pick && PICKED.has(key)) {
          f.c.localSet(V2);
          $.do(this.truthy($, $.l(V2)));
          f.c.ifResult(this.dynRef);
          $.do($.l(V2));
          f.c.else_();
          f.c.refNull(this.DT);
          f.c.end();
        }
      };
      const fenceKey = (key: string): void => {
        this.fence($, this.cat($, $.l(API), this.lit($, ` option '${key}'`)));
        $.ret($.i(0));
      };
      const fail = (): void => $.ret($.i(0));
      // options ||= kEmptyObject
      $.if($.both($.call(this.deps.truthy(), $.l(OPTS)), $.eq(this.kind($, $.l(OPTS)), $.i(K_OBJ))), () => $.put(O, $.cast(this.deps.objT(), $.get(this.DT, 2, $.l(OPTS)))));
      // new SecureContext(secureProtocol, secureOptions, minVersion, maxVersion)
      $.put(V, get("secureProtocol"));
      $.if(this.truthy($, $.l(V)), () => {
        $.put(E, get("minVersion"));
        $.if($.not(this.nullish($, $.l(E))), () => {
          this.throwErr($, "%TypeError", this.cat($, this.lit($, "TLS protocol version "), $.call(this.deps.formatJ(), $.l(E)), this.lit($, " conflicts with secureProtocol "), $.call(this.deps.formatJ(), $.l(V))), "ERR_TLS_PROTOCOL_VERSION_CONFLICT");
          fail();
        });
        $.put(E, get("maxVersion"));
        $.if($.not(this.nullish($, $.l(E))), () => {
          this.throwErr($, "%TypeError", this.cat($, this.lit($, "TLS protocol version "), $.call(this.deps.formatJ(), $.l(E)), this.lit($, " conflicts with secureProtocol "), $.call(this.deps.formatJ(), $.l(V))), "ERR_TLS_PROTOCOL_VERSION_CONFLICT");
          fail();
        });
        fenceKey("secureProtocol");
      });
      $.put(R, $.call(this.versionFn("minimum"), get("minVersion")));
      $.if($.lt($.l(R), $.i(0)), fail);
      $.put(N, $.l(R));
      $.put(R, $.call(this.versionFn("maximum"), get("maxVersion")));
      $.if($.lt($.l(R), $.i(0)), fail);
      $.if($.l(N), () => fenceKey("minVersion"));
      $.if($.l(R), () => fenceKey("maxVersion"));
      $.put(CTX, $.call(this.ctxNewFn(), $.l(SERVER)));
      // secureOptions (honorCipherOrder's SSL_OP_CIPHER_SERVER_PREFERENCE
      // is the server's own preference order: not observable here)
      $.put(V, get("secureOptions"));
      $.if($.both($.not(this.truthy($, get("honorCipherOrder"))), this.truthy($, $.l(V))), () => {
        $.if($.ne(this.kind($, $.l(V)), $.i(K_NUM)), () => {
          this.argType($, "secureOptions", "of type number", $.l(V));
          fail();
        });
        fenceKey("secureOptions");
      });
      // configSecureContext: validateObject(options, 'options')
      $.if($.both($.call(this.deps.truthy(), $.l(OPTS)), $.ne(this.kind($, $.l(OPTS)), $.i(K_OBJ))), () => {
        this.argType($, "options", "of type object", $.l(OPTS));
        fail();
      });
      // ciphers
      $.put(V, get("ciphers"));
      $.if($.not(this.nullish($, $.l(V))), () => {
        $.if($.ne(this.kind($, $.l(V)), $.i(K_STR)), () => {
          this.argType($, "options.ciphers", "of type string", $.l(V));
          fail();
        });
        fenceKey("ciphers");
      });
      // ca, else addRootCerts
      $.put(V, get("ca"));
      $.if(this.truthy($, $.l(V)), () => {
        $.if($.eq(this.kind($, $.l(V)), $.i(K_ARR)), () => {
          $.put(N, $.get(vec.struct, 0, $.cast(vec.struct, $.get(this.DT, 2, $.l(V)))));
          $.for(I, $.i(0), $.l(N), () => {
            $.put(E, $.aget(vec.bufType, $.get(vec.struct, 1, $.cast(vec.struct, $.get(this.DT, 2, $.l(V)))), $.l(I)));
            this.keyOrCert($, "options.ca", $.l(E), fail);
            $.if($.not($.call(this.ctxPutFn(), $.i(OP_CTX_ADD_CA), $.l(CTX), this.pemBytes($, $.l(E)))), fail);
          });
        }, () => {
          this.keyOrCert($, "options.ca", $.l(V), fail);
          $.if($.not($.call(this.ctxPutFn(), $.i(OP_CTX_ADD_CA), $.l(CTX), this.pemBytes($, $.l(V)))), fail);
        });
      }, () => {
        $.if($.not($.call(this.ctxRootsFn(), $.l(CTX))), fail);
      });
      $.if(this.truthy($, get("allowPartialTrustChain")), () => fenceKey("allowPartialTrustChain"));
      // cert
      $.put(V, get("cert"));
      $.if(this.truthy($, $.l(V)), () => {
        $.if($.eq(this.kind($, $.l(V)), $.i(K_ARR)), () => {
          $.put(N, $.get(vec.struct, 0, $.cast(vec.struct, $.get(this.DT, 2, $.l(V)))));
          $.for(I, $.i(0), $.l(N), () => {
            $.put(E, $.aget(vec.bufType, $.get(vec.struct, 1, $.cast(vec.struct, $.get(this.DT, 2, $.l(V)))), $.l(I)));
            this.keyOrCert($, "options.cert", $.l(E), fail);
            $.if($.gt($.l(I), $.i(0)), () => fenceKey("cert"));
            $.if($.not($.call(this.ctxPutFn(), $.i(OP_CTX_SET_CERT), $.l(CTX), this.pemBytes($, $.l(E)))), fail);
          });
        }, () => {
          this.keyOrCert($, "options.cert", $.l(V), fail);
          $.if($.not($.call(this.ctxPutFn(), $.i(OP_CTX_SET_CERT), $.l(CTX), this.pemBytes($, $.l(V)))), fail);
        });
      });
      // key (then the passphrase)
      $.put(KEYV, get("key"));
      $.put(PASS, get("passphrase"));
      const setKey = (k: X): void => {
        this.keyOrCert($, "options.key", k, fail);
        $.if($.not(this.nullish($, $.l(PASS))), () => {
          $.if($.ne(this.kind($, $.l(PASS)), $.i(K_STR)), () => {
            this.argType($, "options.passphrase", "of type string", $.l(PASS));
            fail();
          });
          fenceKey("passphrase");
        });
        $.if($.not($.call(this.ctxPutFn(), $.i(OP_CTX_SET_KEY), $.l(CTX), this.pemBytes($, k))), fail);
      };
      $.if(this.truthy($, $.l(KEYV)), () => {
        $.if($.eq(this.kind($, $.l(KEYV)), $.i(K_ARR)), () => {
          $.put(N, $.get(vec.struct, 0, $.cast(vec.struct, $.get(this.DT, 2, $.l(KEYV)))));
          $.for(I, $.i(0), $.l(N), () => {
            $.put(E, $.aget(vec.bufType, $.get(vec.struct, 1, $.cast(vec.struct, $.get(this.DT, 2, $.l(KEYV)))), $.l(I)));
            // { pem, passphrase } entries
            $.if($.eq(this.kind($, $.l(E)), $.i(K_OBJ)), () => fenceKey("key"));
            $.if($.gt($.l(I), $.i(0)), () => fenceKey("key"));
            setKey($.l(E));
          });
        }, () => setKey($.l(KEYV)));
      });
      // sigalgs
      $.put(V, get("sigalgs"));
      $.if($.not(this.nullish($, $.l(V))), () => {
        $.if($.ne(this.kind($, $.l(V)), $.i(K_STR)), () => {
          this.argType($, "options.sigalgs", "of type string", $.l(V));
          fail();
        });
        $.if($.eq($.alen(this.dstr($, $.l(V))), $.i(0)), () => {
          this.argValue($, "options.sigalgs", this.lit($, "''"));
          fail();
        });
        fenceKey("sigalgs");
      });
      // privateKeyIdentifier / privateKeyEngine
      $.put(V, get("privateKeyIdentifier"));
      $.put(E, get("privateKeyEngine"));
      $.if($.not(this.nullish($, $.l(V))), () => {
        $.if(this.nullish($, $.l(E)), () => {
          this.argValue($, "options.privateKeyEngine", $.sel(this.strRef, $.isNull($.l(E)), this.lit($, "undefined"), this.inspectDyn($, $.l(E))));
          fail();
        });
        $.if(this.truthy($, $.l(KEYV)), () => {
          this.argValue($, "options.privateKeyIdentifier", this.inspectDyn($, $.l(V)));
          fail();
        });
        $.if($.both($.eq(this.kind($, $.l(V)), $.i(K_STR)), $.eq(this.kind($, $.l(E)), $.i(K_STR))), () => fenceKey("privateKeyEngine"));
        $.if($.ne(this.kind($, $.l(V)), $.i(K_STR)), () => {
          this.argType($, "options.privateKeyIdentifier", "of type string or one of null or undefined", $.l(V));
          fail();
        });
        this.argType($, "options.privateKeyEngine", "of type string or one of null or undefined", $.l(E));
        fail();
      });
      // ecdhCurve (undefined is the 'auto' default; null is validated)
      $.put(V, get("ecdhCurve"));
      $.if($.not($.orElse($.isNull($.l(V)), $.eq(this.kind($, $.l(V)), $.i(K_UNDEF)))), () => {
        $.if($.ne(this.kind($, $.l(V)), $.i(K_STR)), () => {
          this.argType($, "options.ecdhCurve", "of type string", $.l(V));
          fail();
        });
        $.if($.not(this.streq($, this.dstr($, $.l(V)), this.lit($, "auto"))), () => fenceKey("ecdhCurve"));
      });
      // dhparam
      $.put(V, get("dhparam"));
      $.if($.not(this.nullish($, $.l(V))), () => {
        this.keyOrCert($, "options.dhparam", $.l(V), fail);
        fenceKey("dhparam");
      });
      // crl
      $.put(V, get("crl"));
      $.if($.not(this.nullish($, $.l(V))), () => {
        $.if($.eq(this.kind($, $.l(V)), $.i(K_ARR)), () => {
          $.put(N, $.get(vec.struct, 0, $.cast(vec.struct, $.get(this.DT, 2, $.l(V)))));
          $.if($.gt($.l(N), $.i(0)), () => {
            $.put(E, $.aget(vec.bufType, $.get(vec.struct, 1, $.cast(vec.struct, $.get(this.DT, 2, $.l(V)))), $.i(0)));
            this.keyOrCert($, "options.crl", $.l(E), fail);
            fenceKey("crl");
          });
        }, () => {
          this.keyOrCert($, "options.crl", $.l(V), fail);
          fenceKey("crl");
        });
      });
      // sessionIdContext (sessions are not resumed here: inert)
      $.put(V, get("sessionIdContext"));
      $.if($.not(this.nullish($, $.l(V))), () => {
        $.if($.ne(this.kind($, $.l(V)), $.i(K_STR)), () => {
          this.argType($, "options.sessionIdContext", "of type string", $.l(V));
          fail();
        });
      });
      // pfx
      $.if($.not(this.nullish($, get("pfx"))), () => fenceKey("pfx"));
      // clientCertEngine
      $.put(V, get("clientCertEngine"));
      $.if($.not(this.nullish($, $.l(V))), () => {
        $.if($.eq(this.kind($, $.l(V)), $.i(K_STR)), () => fenceKey("clientCertEngine"));
        this.argType($, "options.clientCertEngine", "of type string or one of null or undefined", $.l(V));
        fail();
      });
      // ticketKeys (inert: no session tickets are resumed)
      $.put(V, get("ticketKeys"));
      $.if($.not(this.nullish($, $.l(V))), () => {
        $.if($.ne(this.kind($, $.l(V)), $.i(K_BYTES)), () => {
          this.argType($, "options.ticketKeys", "an instance of Buffer, TypedArray, or DataView", $.l(V));
          fail();
        });
        $.put(N, $.get(this.BT, 2, $.call(this.deps.dynBytes(), $.l(V))));
        $.if($.ne($.l(N), $.i(48)), () => {
          this.argValue($, "options.ticketKeys", $.call(this.deps.f64ToStr(), $.i2d($.l(N))), "must be exactly 48 bytes");
          fail();
        });
      });
      // sessionTimeout: validateInt32(v, name, 0) (inert)
      $.put(V, get("sessionTimeout"));
      $.if($.not(this.nullish($, $.l(V))), () => {
        $.if($.ne(this.kind($, $.l(V)), $.i(K_NUM)), () => {
          this.argType($, "options.sessionTimeout", "of type number", $.l(V));
          fail();
        });
        $.if($.not($.call(this.int32CheckFn("options.sessionTimeout", 0), $.get(this.DT, 1, $.l(V)))), fail);
      });
      $.do($.l(CTX));
    });
  }

  /** validateInt32(n, name, min): 1, or 0 with ERR_OUT_OF_RANGE pending. */
  private int32CheckFn(name: string, min: number): number {
    return this.fn(`int32.${name}`, [F64], [I32], (f, $) => {
      const N = 0;
      $.if($.either($.dne($.raw((c) => {
        c.localGet(N);
        c.f64Trunc();
      }), $.l(N)), $.dne($.dsub($.l(N), $.l(N)), $.d(0))), () => {
        this.throwErr($, "%RangeError", this.cat($, this.lit($, `The value of "${name}" is out of range. It must be an integer. Received `), $.call(this.deps.numReceived(), $.l(N))), "ERR_OUT_OF_RANGE");
        $.ret($.i(0));
      });
      $.if($.either($.dlt($.l(N), $.d(min)), $.dgt($.l(N), $.d(2147483647))), () => {
        this.throwErr($, "%RangeError", this.cat($, this.lit($, `The value of "${name}" is out of range. It must be >= ${min} && <= 2147483647. Received `), $.call(this.deps.numReceived(), $.l(N))), "ERR_OUT_OF_RANGE");
        $.ret($.i(0));
      });
      $.do($.i(1));
    });
  }

  /** tls.Server's constructor over a checked-dynamic options value (and
   * https.Server's around it when `https`) -> ctx (0 = error pending). */
  serverCtxFromDynFn(https: boolean): number {
    return this.fn(`serverCtxDyn${https ? ".https" : ""}`, [this.dynRef, this.strRef], [I32], (f, $) => {
      const [OPTS, API] = [0, 1];
      const O = f.local(this.ref(this.deps.objT()));
      const V = f.local(this.dynRef);
      const CTX = f.local(I32);
      const get = (key: string): X => $.sel(this.dynRef, $.isNull($.l(O)), $.nul(this.DT), $.call(this.deps.objGet(), $.l(O), this.lit($, key)));
      const fail = (): void => $.ret($.i(0));
      const fenceKey = (key: string): void => {
        this.fence($, this.cat($, $.l(API), this.lit($, ` option '${key}'`)));
        $.ret($.i(0));
      };
      $.if($.eq(this.kind($, $.l(OPTS)), $.i(K_OBJ)), () => $.put(O, $.cast(this.deps.objT(), $.get(this.DT, 2, $.l(OPTS)))));
      if (https) {
        // validateObject(opts, 'options') (null takes kEmptyObject)
        $.if($.both($.ne(this.kind($, $.l(OPTS)), $.i(K_OBJ)), $.not(this.nullish($, $.l(OPTS)))), () => {
          this.argType($, "options", "of type object", $.l(OPTS));
          fail();
        });
        // storeHTTPOptions: the http server options this tier's https
        // server does not carry
        for (const k of ["IncomingMessage", "ServerResponse", "requireHostHeader", "joinDuplicateHeaders", "maxHeaderSize", "insecureHTTPParser", "requestTimeout", "headersTimeout", "connectionsCheckingInterval", "keepAliveTimeout", "keepAliveTimeoutBuffer", "uniqueHeaders", "rejectNonStandardBodyWrites", "optimizeEmptyRequests", "shouldUpgradeCallback", "maxHeadersCount"]) {
          $.if($.not($.orElse($.isNull(get(k)), $.eq(this.kind($, get(k)), $.i(K_UNDEF)))), () => fenceKey(k));
        }
      } else {
        // options: a function, an object or null, else ERR_INVALID_ARG_TYPE
        $.if($.both($.ne(this.kind($, $.l(OPTS)), $.i(K_OBJ)), $.not(this.nullish($, $.l(OPTS)))), () => {
          this.argType($, "options", "an instance of Object", $.l(OPTS));
          fail();
        });
      }
      // this.requestCert = options.requestCert === true
      $.put(V, get("requestCert"));
      $.if($.andThen(this.isKind($, $.l(V), K_BOOL), $.dne($.get(this.DT, 1, $.l(V)), $.d(0))), () => fenceKey("requestCert"));
      $.if($.both(this.truthy($, get("ALPNCallback")), this.truthy($, get("ALPNProtocols"))), () => {
        this.throwErr($, "%TypeError", this.lit($, "The ALPNCallback and ALPNProtocols TLS options are mutually exclusive"), "ERR_TLS_ALPN_CALLBACK_WITH_PROTOCOLS");
        fail();
      });
      $.if(this.truthy($, get("ALPNProtocols")), () => fenceKey("ALPNProtocols"));
      // setSecureContext(options)
      $.put(CTX, $.call(this.ctxFromDynFn(true), $.l(OPTS), $.i(1), $.l(API)));
      $.if($.eq($.l(CTX), $.i(0)), fail);
      // options.handshakeTimeout || 120000: validateNumber (the timer is
      // not modelled: SEMANTICS.md S090)
      $.put(V, get("handshakeTimeout"));
      $.if($.both(this.truthy($, $.l(V)), $.ne(this.kind($, $.l(V)), $.i(K_NUM))), () => {
        this.argType($, "options.handshakeTimeout", "of type number", $.l(V));
        fail();
      });
      $.if(this.truthy($, get("ALPNCallback")), () => fenceKey("ALPNCallback"));
      for (const k of ["SNICallback", "pskCallback", "pskIdentityHint"]) {
        $.put(V, get(k));
        $.if(this.truthy($, $.l(V)), () => {
          if (k === "pskIdentityHint") {
            $.if($.ne(this.kind($, $.l(V)), $.i(K_STR)), () => {
              this.argType($, `options.${k}`, "of type string", $.l(V));
              fail();
            });
          } else {
            $.if($.ne(this.kind($, $.l(V)), $.i(K_FUNC)), () => {
              this.argType($, `options.${k}`, "of type function", $.l(V));
              fail();
            });
          }
          fenceKey(k);
        });
      }
      // net.Server(options): the members a TLS server here does not carry
      for (const k of ["allowHalfOpen", "pauseOnConnect", ...(https ? [] : ["noDelay"]), "keepAlive", "highWaterMark", "blockList", "enableTrace"]) {
        $.if(this.truthy($, get(k)), () => fenceKey(k));
      }
      $.do($.l(CTX));
    });
  }

  /* ── the server ───────────────────────────────────────────────────── */

  /** A server becomes a tls.Server: its context, and tlsConnectionListener
   * on 'connection'. */
  serverSetupFn(): number {
    return this.fn("serverSetup", [this.srvRef, I32, I32], [], (f, $) => {
      const [V, CTX, HTTPS] = [0, 1, 2];
      $.set(this.srvT, this.tf.V_TLS, $.l(V), $.new_(this.tsT(), $.l(CTX), $.l(HTTPS)));
      this.son($, NET_LISTS.LV_CONN, $.l(V), this.clos($, this.connListenerFn(), "sock", { a: $.l(V) }));
    });
  }

  /** server.on('connection', ...) on a tls.Server: this tier keeps one
   * socket for the raw and the TLS sides, so it is a named fence. */
  connGuardFn(): number {
    return this.fn("connGuard", [this.srvRef], [I32], (f, $) => {
      $.if($.notNull($.get(this.srvT, this.tf.V_TLS, $.l(0))), () => {
        this.fence($, this.lit($, "a 'connection' listener on a tls.Server"));
        $.ret($.i(0));
      });
      $.do($.i(1));
    });
  }

  /** tlsConnectionListener(rawSocket) */
  private connListenerFn(): number {
    return this.closFn("tlsConnectionListener", "sock", ($, e, f, arg) => {
      const V = f.local(this.srvRef);
      const X_ = f.local(this.xRef);
      $.put(V, $.cast(this.srvT, $.l(e.a)));
      $.put(X_, $.raw((c) => c.structNewDefault(this.xT())));
      $.set(this.xT(), X_MODE, $.l(X_), $.i(2));
      $.set(this.xT(), X_CTX, $.l(X_), $.get(this.tsT(), TS_CTX, $.cast(this.tsT(), $.get(this.srvT, this.tf.V_TLS, $.l(V)))));
      $.set(this.xT(), X_SOCK, $.l(X_), $.l(arg));
      $.set(this.xT(), X_SRV, $.l(X_), $.l(V));
      $.set(this.sockT, this.tf.S_TLS, $.l(arg), $.l(X_));
      // this.on('error', this._tlsError) and socket.on('error',
      // onSocketTLSError): the TLS server socket's internal 'error'
      // listeners (no tlsClientError listener reaches here).
      this.son($, NET_LISTS.L_ERROR, $.l(arg), this.clos($, this.nopErrFn(), "err", {}));
      $.run(this.secureFn(), $.l(X_));
    });
  }

  private nopErrFn(): number {
    return this.closFn("onSocketTLSError", "err", () => {});
  }

  /** The SECURE op for a socket (handle.start() / the server wrap). */
  private secureFn(): number {
    return this.fn("secure", [this.xRef], [], (f, $) => {
      const X_ = 0;
      const S = f.local(this.sockRef);
      const BASE = f.local(I32);
      const P = f.local(I32);
      $.put(S, $.get(this.xT(), X_SOCK, $.l(X_)));
      // Socket was destroyed before the connection was established
      $.if($.not($.get(this.sockT, NET_SOCK_HTTP.S_HAS_HANDLE, $.l(S))), () => $.ret());
      this.deps.ensureCapacity(f.c, () => {
        $.do($.add($.mul($.sel(I32, $.isNull($.get(this.xT(), X_SNI, $.l(X_))), $.i(0), $.alen($.get(this.xT(), X_SNI, $.l(X_)))), $.i(2)), $.i(32)));
      });
      this.base($, BASE);
      this.storeU32($, $.l(BASE), $.get(this.xT(), X_CTX, $.l(X_)));
      this.storeU32($, $.add($.l(BASE), $.i(4)), $.sub($.get(this.xT(), X_MODE, $.l(X_)), $.i(1)));
      $.put(P, $.call(this.stageRunFn(), $.add($.l(BASE), $.i(8)), $.get(this.xT(), X_SNI, $.l(X_))));
      $.if($.ne(this.tlsCall($, OP_SECURE, $.l(BASE), $.sub($.l(P), $.l(BASE)), $.get(this.sockT, 0, $.l(S)), $.i(0)), $.i(0)), () => this.trap($));
    });
  }

  /** A TLS event on a socket (net.ts's hook): `(sock, kind, a, ptr, len)`. */
  eventFn(): number {
    return this.fn("event", [this.sockRef, I32, I32, I32, I32], [], (f, $) => {
      const [S, KIND, A_, PTR] = [0, 1, 2, 3];
      const X_ = f.local(this.xRef);
      const N = f.local(I32);
      const VER = f.local(I32);
      const ERR = f.local(this.errRef);
      $.if($.isNull($.get(this.sockT, this.tf.S_TLS, $.l(S))), () => this.trap($));
      $.put(X_, $.cast(this.xT(), $.get(this.sockT, this.tf.S_TLS, $.l(S))));
      $.if($.eq($.l(KIND), $.i(EV_SECURE)), () => {
        $.if($.ne($.l(A_), $.i(0)), () => this.trap($));
        $.put(VER, this.loadU32($, $.l(PTR)));
        $.put(N, this.loadU32($, $.add($.l(PTR), $.i(4))));
        $.set(this.xT(), X_PEER, $.l(X_), $.call(this.net.bytesAtHelper(), $.add($.l(PTR), $.i(8)), $.l(N)));
        // _finishInit: guard against onhandshakedone after destroy()
        $.if($.not($.get(this.sockT, NET_SOCK_HTTP.S_HAS_HANDLE, $.l(S))), () => $.ret());
        $.set(this.xT(), X_SECURE, $.l(X_), $.i(1));
        // emit('secure')
        $.if($.eq($.get(this.xT(), X_MODE, $.l(X_)), $.i(1)), () => $.run(this.onConnectSecureFn(), $.l(X_), $.l(VER)), () => $.run(this.onServerSecureFn(), $.l(X_)));
        $.ret();
      });
      // TLS_ERROR: ssl.onerror
      $.put(ERR, $.call(this.hostErrFn(), $.l(PTR)));
      $.if($.get(this.xT(), X_HADERR, $.l(X_)), () => $.ret());
      $.set(this.xT(), X_HADERR, $.l(X_), $.i(1));
      // before the handshake: destroy(err); after it, _emitTLSError —
      // and this tier destroys too (SEMANTICS.md S090).
      $.run(this.net.destroyHelper(), $.l(S), $.l(ERR));
    });
  }

  /** onServerSocketSecure */
  private onServerSecureFn(): number {
    return this.fn("onServerSecure", [this.xRef], [], (f, $) => {
      const X_ = 0;
      const S = f.local(this.sockRef);
      $.put(S, $.get(this.xT(), X_SOCK, $.l(X_)));
      $.run(this.releaseFn(), $.l(X_));
      $.if($.both($.not($.call(this.net.destroyedHelper(), $.l(S))), $.not($.get(this.xT(), X_CTRL, $.l(X_)))), () => {
        $.set(this.xT(), X_CTRL, $.l(X_), $.i(1));
        $.drop($.call(this.net.emitHelper(this.tf.LV_SECCONN), $.get(this.xT(), X_SRV, $.l(X_)), $.l(S)));
      });
    });
  }

  /* ── the client ───────────────────────────────────────────────────── */

  /** onConnectSecure(verifyCode) */
  private onConnectSecureFn(): number {
    return this.fn("onConnectSecure", [this.xRef, I32], [], (f, $) => {
      const [X_, VER] = [0, 1];
      const S = f.local(this.sockRef);
      const ERR = f.local(this.errRef);
      const CODE = f.local(this.strRef);
      const MSG = f.local(this.strRef);
      $.put(S, $.get(this.xT(), X_SOCK, $.l(X_)));
      $.if($.ne($.l(VER), $.i(0)), () => {
        $.put(CODE, this.lit($, "UNSPECIFIED"));
        $.put(MSG, this.lit($, "unknown certificate verification error"));
        for (const [n, code, text] of VERIFY) {
          $.if($.eq($.l(VER), $.i(n)), () => {
            $.put(CODE, this.lit($, code));
            // crypto_common.cc GetValidationErrorReason: Node suggests
            // --use-system-ca for these three (the flag is never set here)
            $.put(MSG, this.lit($, n === 18 || n === 21 ? `${text}; if the root CA is installed locally, try running Node.js with --use-system-ca` : text));
          });
        }
        $.put(ERR, () => this.deps.newError(f.c, "%Error", "Error", (c) => c.localGet(MSG), (c) => c.localGet(CODE)));
      }, () => {
        // checkServerIdentity(getSessionServerIdentity(options), cert)
        $.put(ERR, $.call(this.checkIdentityFn(), $.get(this.xT(), X_HOSTID, $.l(X_)), $.get(this.xT(), X_PEER, $.l(X_))));
        this.excReturn($);
      });
      $.if($.notNull($.l(ERR)), () => {
        $.set(this.xT(), X_AUTH, $.l(X_), $.i(0));
        // verifyError.code || verifyError.message
        $.set(this.xT(), X_AUTHERR, $.l(X_), $.sel(this.strRef, $.notNull($.get(this.deps.errType(), 3, $.l(ERR))), $.get(this.deps.errType(), 3, $.l(ERR)), $.get(this.deps.errType(), 2, $.l(ERR))));
        $.if($.get(this.xT(), X_REJECT, $.l(X_)), () => {
          $.run(this.net.destroyHelper(), $.l(S), $.l(ERR));
          $.ret();
        });
      }, () => $.set(this.xT(), X_AUTH, $.l(X_), $.i(1)));
      $.drop($.call(this.net.emitHelper(this.tf.L_SECURE), $.l(S)));
      this.excReturn($);
      // the verdict is in: a write held until now goes to the host
      $.run(this.releaseFn(), $.l(X_));
      this.excReturn($);
      $.run(this.net.removeHelper(NET_LISTS.L_END), $.l(S), $.get(this.xT(), X_ENDCB, $.l(X_)));
    });
  }

  /** net.ts's hold hook: `(sock, bytes) -> i32`. */
  holdFn(): number {
    return this.fn("hold", [this.sockRef, this.bytesRef], [I32], (f, $) => {
      const [S, B] = [0, 1];
      const X_ = f.local(this.xRef);
      $.if($.isNull($.get(this.sockT, this.tf.S_TLS, $.l(S))), () => $.ret($.i(0)));
      $.put(X_, $.cast(this.xT(), $.get(this.sockT, this.tf.S_TLS, $.l(S))));
      $.if($.get(this.xT(), X_REL, $.l(X_)), () => $.ret($.i(0)));
      $.set(this.xT(), X_HELD, $.l(X_), $.l(B));
      $.do($.i(1));
    });
  }

  /** The module accepted the handshake: a held write goes to the host. */
  private releaseFn(): number {
    return this.fn("release", [this.xRef], [], (f, $) => {
      const X_ = 0;
      const S = f.local(this.sockRef);
      const B = f.local(this.bytesRef);
      $.set(this.xT(), X_REL, $.l(X_), $.i(1));
      $.put(S, $.get(this.xT(), X_SOCK, $.l(X_)));
      $.put(B, $.get(this.xT(), X_HELD, $.l(X_)));
      $.if($.isNull($.l(B)), () => $.ret());
      $.set(this.xT(), X_HELD, $.l(X_), $.nul(this.BT));
      $.if($.either($.not($.get(this.sockT, NET_SOCK_HTTP.S_HAS_HANDLE, $.l(S))), $.call(this.net.destroyedHelper(), $.l(S))), () => $.ret());
      $.run(this.net.issueHeldHelper(), $.l(S), $.l(B));
    });
  }

  /** onConnectEnd (a prepended 'end' listener, env a = $tls) */
  private onConnectEndFn(): number {
    return this.closFn("onConnectEnd", "void", ($, e, f) => {
      const X_ = f.local(this.xRef);
      $.put(X_, $.cast(this.xT(), $.l(e.a)));
      $.if($.get(this.xT(), X_HADERR, $.l(X_)), () => $.ret());
      $.set(this.xT(), X_HADERR, $.l(X_), $.i(1));
      $.run(this.net.destroyHelper(), $.get(this.xT(), X_SOCK, $.l(X_)), this.err($, "%Error", this.lit($, "Client network socket disconnected before secure TLS connection was established"), "ECONNRESET"));
    });
  }

  /** TLSSocket.prototype._start (the 'connect' listener, env a = $tls) */
  private startFn(): number {
    return this.closFn("start", "void", ($, e) => {
      $.run(this.secureFn(), $.cast(this.xT(), $.l(e.a)));
    });
  }

  /** The client socket after its connect began: S_TLS, the 'end' guard.
   * -> the socket */
  private clientAttachFn(): number {
    return this.fn("clientAttach", [this.sockRef, this.xRef], [this.sockRef], (f, $) => {
      const [S, X_] = [0, 1];
      $.set(this.xT(), X_SOCK, $.l(X_), $.l(S));
      $.set(this.sockT, this.tf.S_TLS, $.l(S), $.l(X_));
      $.set(this.xT(), X_CTRL, $.l(X_), $.i(1)); // tlssock._releaseControl()
      $.set(this.xT(), X_ENDCB, $.l(X_), this.clos($, this.onConnectEndFn(), "void", { a: $.l(X_) }));
      this.son($, NET_LISTS.L_END, $.l(S), $.cast(this.deps.voidClos().clos, $.get(this.xT(), X_ENDCB, $.l(X_))), false, true);
      $.do($.l(S));
    });
  }

  /** A fresh client $tls. */
  private xNew($: A, ctx: X, hostId: X, sni: X, reject: X): X {
    return () => {
      const c = $.c;
      c.i32Const(1); // X_MODE
      ctx(); // X_CTX
      c.i32Const(0);
      c.i32Const(0);
      c.i32Const(0);
      c.refNull(this.S); // X_AUTHERR
      hostId();
      sni();
      reject();
      c.refNull(this.BT);
      c.i32Const(0);
      c.refNull(this.sockT);
      c.refNull(this.srvT);
      c.refNull(EQ_HEAP);
      c.i32Const(0); // X_REL
      c.refNull(this.BT); // X_HELD
      c.structNew(this.xT());
    };
  }

  /** tls.connect(port, host, options[, cb]): port -1 / host "" are
   * absent. -> the socket, or null with the error pending. */
  connectFn(): number {
    return this.fn("connect", [F64, this.strRef, this.dynRef, this.ref(this.deps.voidClos().clos)], [this.sockRef], (f, $) => {
      const [PORT0, HOST0, OPTS, CB] = [0, 1, 2, 3];
      const O = f.local(this.ref(this.deps.objT()));
      const V = f.local(this.dynRef);
      const PORT = f.local(F64);
      const HOST = f.local(this.strRef);
      const SNI = f.local(this.strRef);
      const CTX = f.local(I32);
      const X_ = f.local(this.xRef);
      const S = f.local(this.sockRef);
      const REJ = f.local(I32);
      const has = (key: string): X => $.andThen($.notNull($.l(O)), $.notNull($.call(this.deps.objGet(), $.l(O), this.lit($, key))));
      const get = (key: string): X => $.sel(this.dynRef, $.isNull($.l(O)), $.nul(this.DT), $.call(this.deps.objGet(), $.l(O), this.lit($, key)));
      const fail = (): void => $.ret($.nul(this.sockT));
      const fenceKey = (key: string): void => {
        this.fence($, this.lit($, `tls.connect option '${key}'`));
        fail();
      };
      $.if($.eq(this.kind($, $.l(OPTS)), $.i(K_OBJ)), () => $.put(O, $.cast(this.deps.objT(), $.get(this.DT, 2, $.l(OPTS)))));
      // { rejectUnauthorized: true, ciphers, checkServerIdentity, minDHSize: 1024, ...options }
      $.if(has("checkServerIdentity"), () => {
        $.put(V, get("checkServerIdentity"));
        $.if($.ne(this.kind($, $.l(V)), $.i(K_FUNC)), () => {
          this.argType($, "options.checkServerIdentity", "of type function", $.l(V));
          fail();
        });
        fenceKey("checkServerIdentity");
      });
      $.if(has("minDHSize"), () => {
        $.put(V, get("minDHSize"));
        $.if($.ne(this.kind($, $.l(V)), $.i(K_NUM)), () => {
          this.argType($, "options.minDHSize", "of type number", $.l(V));
          fail();
        });
        $.if($.dlt($.get(this.DT, 1, $.l(V)), $.d(1)), () => {
          this.throwErr($, "%RangeError", this.cat($, this.lit($, 'The value of "options.minDHSize" is out of range. It must be >= 1. Received '), $.call(this.deps.numReceived(), $.get(this.DT, 1, $.l(V)))), "ERR_OUT_OF_RANGE");
          fail();
        });
      });
      $.if(this.truthy($, get("secureContext")), () => fenceKey("secureContext"));
      // createSecureContext(options)
      $.put(CTX, $.call(this.ctxFromDynFn(false), $.l(OPTS), $.i(0), this.lit($, "tls.connect")));
      $.if($.eq($.l(CTX), $.i(0)), fail);
      $.if($.not(this.nullish($, get("session"))), () => fenceKey("session"));
      // new TLSSocket(options.socket, { ... })
      for (const k of ["socket", "allowHalfOpen", "path", "ALPNProtocols", "requestOCSP", "pskCallback", "onread", "signal", "noDelay", "lookup", "timeout"]) {
        $.if(this.truthy($, get(k)), () => fenceKey(k));
      }
      for (const k of ["enableTrace", "highWaterMark", "keepAlive", "keepAliveInitialDelay", "family", "hints", "localAddress", "localPort", "autoSelectFamily", "autoSelectFamilyAttemptTimeout", "fd", "readable", "writable"]) {
        $.if($.not(this.nullish($, get(k))), () => fenceKey(k));
      }
      // the merged port / host (options members override the arguments)
      $.put(PORT, $.l(PORT0));
      $.if(has("port"), () => {
        $.put(V, get("port"));
        $.if($.eq(this.kind($, $.l(V)), $.i(K_NUM)), () => $.put(PORT, $.get(this.DT, 1, $.l(V))), () => {
          $.if($.eq(this.kind($, $.l(V)), $.i(K_UNDEF)), () => $.put(PORT, $.d(-1)), () => {
            $.if($.eq(this.kind($, $.l(V)), $.i(K_STR)), () => fenceKey("port"));
            this.argType($, "options.port", "one of type number or string", $.l(V));
            fail();
          });
        });
      });
      $.put(HOST, $.l(HOST0));
      $.if(has("host"), () => {
        $.put(V, get("host"));
        $.if($.eq(this.kind($, $.l(V)), $.i(K_STR)), () => $.put(HOST, this.dstr($, $.l(V))), () => {
          $.if(this.nullish($, $.l(V)), () => $.put(HOST, this.lit($, "")), () => {
            this.argType($, "options.host", "of type string", $.l(V));
            fail();
          });
        });
      });
      $.if($.dlt($.l(PORT), $.d(0)), () => {
        this.throwErr($, "%TypeError", this.lit($, 'The "options" or "port" or "path" argument must be specified'), "ERR_MISSING_ARGS");
        fail();
      });
      // servername: a string (an IP warns DEP0123 in Node: not modelled)
      $.put(V, get("servername"));
      $.if(this.truthy($, $.l(V)), () => {
        $.if($.ne(this.kind($, $.l(V)), $.i(K_STR)), () => fenceKey("servername"));
        $.put(SNI, this.dstr($, $.l(V)));
        $.if($.call(this.net.isIPHelper(), $.l(SNI)), () => fenceKey("servername"));
      });
      // rejectUnauthorized !== false
      $.put(V, get("rejectUnauthorized"));
      $.put(REJ, $.not($.andThen(this.isKind($, $.l(V), K_BOOL), $.deq($.get(this.DT, 1, $.l(V)), $.d(0)))));
      $.put(X_, this.xNew($, $.l(CTX), $.sel(this.strRef, $.notNull($.l(SNI)), $.l(SNI), $.sel(this.strRef, $.gt($.alen($.l(HOST)), $.i(0)), $.l(HOST), this.lit($, "localhost"))), $.l(SNI), $.l(REJ)));
      // tlssock.connect(options, tlssock._start)
      $.put(S, $.call(this.net.connectHelper(), $.l(PORT), $.l(HOST), $.cast(this.deps.voidClos().clos, this.clos($, this.startFn(), "void", { a: $.l(X_) })), $.nul(this.DT)));
      this.excReturn($, $.nul(this.sockT));
      $.drop($.call(this.clientAttachFn(), $.l(S), $.l(X_)));
      // if (cb) tlssock.once('secureConnect', cb)
      $.if($.notNull($.l(CB)), () => this.son($, this.tf.L_SECURE, $.l(S), $.l(CB), true));
      $.do($.l(S));
    });
  }

  /** The https Agent's createConnection: tls.connect over the request's
   * options -> the socket, or null with the error pending.
   * `(port, host, noDelay, timeout, tlso, servername)` */
  agentConnectFn(): number {
    return this.fn("agentConnect", [F64, this.strRef, I32, F64, this.tlsoRef(), this.strRef], [this.sockRef], (f, $) => {
      const [PORT, HOST, NODELAY, TMO, TO, SN] = [0, 1, 2, 3, 4, 5];
      const CTX = f.local(I32);
      const X_ = f.local(this.xRef);
      const S = f.local(this.sockRef);
      const SNI = f.local(this.strRef);
      $.put(CTX, $.call(this.ctxNewFn(), $.i(0)));
      $.if($.notNull($.get(this.tlsoT(), TO_CA, $.l(TO))), () => {
        $.if($.not($.call(this.ctxPutFn(), $.i(OP_CTX_ADD_CA), $.l(CTX), $.get(this.tlsoT(), TO_CA, $.l(TO)))), () => $.ret($.nul(this.sockT)));
      }, () => {
        $.if($.not($.call(this.ctxRootsFn(), $.l(CTX))), () => $.ret($.nul(this.sockT)));
      });
      $.if($.gt($.alen($.l(SN)), $.i(0)), () => $.put(SNI, $.l(SN)));
      $.put(X_, this.xNew($, $.l(CTX), $.sel(this.strRef, $.gt($.alen($.l(SN)), $.i(0)), $.l(SN), $.sel(this.strRef, $.gt($.alen($.l(HOST)), $.i(0)), $.l(HOST), this.lit($, "localhost"))), $.l(SNI), $.get(this.tlsoT(), TO_REJECT, $.l(TO))));
      $.put(S, $.call(this.net.connectExCbHelper(), $.l(PORT), $.l(HOST), $.l(NODELAY), $.l(TMO), $.cast(this.deps.voidClos().clos, this.clos($, this.startFn(), "void", { a: $.l(X_) }))));
      this.excReturn($, $.nul(this.sockT));
      $.do($.call(this.clientAttachFn(), $.l(S), $.l(X_)));
    });
  }

  /** `(reject, ca bytes | null, caName) -> $tlso` */
  tlsoNewFn(): number {
    return this.fn("tlsoNew", [I32, this.bytesRef, this.strRef], [this.tlsoRef()], (f, $) => $.do($.new_(this.tlsoT(), $.l(0), $.l(1), $.l(2))));
  }

  /* ── tls.checkServerIdentity ──────────────────────────────────────── */

  /** `(hostname, der) -> err | null` (a construct this tier does not
   * read leaves its fence pending and answers null). */
  checkIdentityFn(): number {
    const x = this.x509;
    const IT = x.infoT();
    return this.fn("checkServerIdentity", [this.strRef, this.bytesRef], [this.errRef], (f, $) => {
      const [HOST0, DER] = [0, 1];
      const INFO = f.local(this.ref(IT));
      const HOST = f.local(this.strRef);
      const ASCII = f.local(this.strRef);
      const FAM = f.local(I32);
      const IPB = f.local(this.ref(this.B));
      const CANON = f.local(this.strRef);
      const I = f.local(I32);
      const VALID = f.local(I32);
      const REASON = f.local(this.strRef);
      const LIST = f.local(this.strRef);
      const CN = f.local(this.strRef);
      $.if($.isNull($.l(DER)), () => $.put(DER, $.new_(this.BT, $.raw((c) => {
        c.i32Const(0);
        c.arrayNewDefault(this.B);
      }), $.i(0), $.i(0))));
      $.put(INFO, $.call(x.x509InfoFn(), $.l(DER)));
      $.if($.get(IT, XI_BAD, $.l(INFO)), () => {
        this.fence($, this.lit($, "checkServerIdentity over a certificate whose subject or subjectAltName this tier does not read"));
        $.ret($.nul(this.deps.errType()));
      });
      // domainToASCII(hostname), then unfqdn
      $.put(ASCII, $.call(this.domainToAsciiFn(), $.l(HOST0)));
      $.if($.isNull($.l(ASCII)), () => {
        this.fence($, this.lit($, "checkServerIdentity of a host name outside lower-case-able ASCII"));
        $.ret($.nul(this.deps.errType()));
      });
      $.put(HOST, $.call(this.unfqdnFn(), $.l(HOST0)));
      $.put(ASCII, $.call(this.unfqdnFn(), $.l(ASCII)));
      $.put(REASON, this.lit($, "Unknown reason"));
      $.put(FAM, $.call(this.net.isIPHelper(), $.l(ASCII)));
      $.if($.l(FAM), () => {
        // canonicalizeIP(hostname) in the cert's list
        $.if($.eq($.l(FAM), $.i(4)), () => $.put(CANON, $.l(ASCII)), () => {
          $.put(IPB, $.call(x.pton6Fn(), $.l(ASCII)));
          $.if($.isNull($.l(IPB)), () => {
            this.fence($, this.lit($, "checkServerIdentity of an IPv6 host with a zone id"));
            $.ret($.nul(this.deps.errType()));
          });
          $.put(CANON, $.call(x.ntop6Fn(), $.l(IPB), $.i(0)));
        });
        $.for(I, $.i(0), $.get(IT, XI_IPS_N, $.l(INFO)), () => {
          $.if(this.streq($, $.aget(x.SA, $.get(IT, XI_IPS, $.l(INFO)), $.l(I)), $.l(CANON)), () => $.put(VALID, $.i(1)));
        });
        $.if($.not($.l(VALID)), () => {
          $.put(LIST, this.lit($, ""));
          $.for(I, $.i(0), $.get(IT, XI_IPS_N, $.l(INFO)), () => {
            $.if($.l(I), () => $.put(LIST, this.cat($, $.l(LIST), this.lit($, ", "))));
            $.put(LIST, this.cat($, $.l(LIST), $.aget(x.SA, $.get(IT, XI_IPS, $.l(INFO)), $.l(I))));
          });
          $.put(REASON, this.cat($, this.lit($, "IP: "), $.l(HOST), this.lit($, " is not in the cert's list: "), $.l(LIST)));
        });
      }, () => {
        // subject?.CN: one empty CN is falsy (two or more are an array)
        $.if($.either($.gt($.get(IT, XI_DNS_N, $.l(INFO)), $.i(0)), $.orElse($.gt($.get(IT, XI_CN_N, $.l(INFO)), $.i(1)), $.andThen($.eq($.get(IT, XI_CN_N, $.l(INFO)), $.i(1)), $.gt($.alen($.aget(x.SA, $.get(IT, XI_CN, $.l(INFO)), $.i(0))), $.i(0))))), () => {
          $.if($.gt($.get(IT, XI_DNS_N, $.l(INFO)), $.i(0)), () => {
            $.for(I, $.i(0), $.get(IT, XI_DNS_N, $.l(INFO)), () => {
              $.if($.call(this.wildcardFn(), $.l(ASCII), $.aget(x.SA, $.get(IT, XI_DNS, $.l(INFO)), $.l(I))), () => $.put(VALID, $.i(1)));
            });
            $.if($.not($.l(VALID)), () => $.put(REASON, this.cat($, this.lit($, "Host: "), $.l(HOST), this.lit($, ". is not in the cert's altnames: "), $.get(IT, XI_SAN, $.l(INFO)))));
          }, () => {
            $.put(CN, this.lit($, ""));
            $.for(I, $.i(0), $.get(IT, XI_CN_N, $.l(INFO)), () => {
              $.if($.call(this.wildcardFn(), $.l(ASCII), $.aget(x.SA, $.get(IT, XI_CN, $.l(INFO)), $.l(I))), () => $.put(VALID, $.i(1)));
              $.if($.l(I), () => $.put(CN, this.cat($, $.l(CN), this.lit($, ","))));
              $.put(CN, this.cat($, $.l(CN), $.aget(x.SA, $.get(IT, XI_CN, $.l(INFO)), $.l(I))));
            });
            $.if($.not($.l(VALID)), () => $.put(REASON, this.cat($, this.lit($, "Host: "), $.l(HOST), this.lit($, ". is not cert's CN: "), $.l(CN))));
          });
        }, () => $.put(REASON, this.lit($, "Cert does not contain a DNS name")));
      });
      $.if($.l(VALID), () => $.ret($.nul(this.deps.errType())));
      $.do(this.err($, "%Error", this.cat($, this.lit($, "Hostname/IP does not match certificate's altnames: "), $.l(REASON)), "ERR_TLS_CERT_ALTNAME_INVALID"));
    });
  }

  /** url.domainToASCII over the host names this tier reads: ASCII letters,
   * digits, '-', '_' and '.' lower-cased; a numeric last label must be a
   * dotted quad already; null for everything else (an 'xn--' label, any
   * other character), which the caller fences. */
  private domainToAsciiFn(): number {
    return this.fn("domainToAscii", [this.strRef], [this.strRef], (f, $) => {
      const S = 0;
      const R = f.local(this.strRef);
      const I = f.local(I32);
      const CH = f.local(I32);
      const N = f.local(I32);
      const LAST = f.local(I32);
      const NUM = f.local(I32);
      // an IPv4 literal stays itself; an IPv6 literal is not a domain:
      // Node's domainToASCII answers "" (so the DNS path runs and fails)
      $.put(N, $.call(this.net.isIPHelper(), $.l(S)));
      $.if($.eq($.l(N), $.i(4)), () => $.ret($.l(S)));
      $.if($.eq($.l(N), $.i(6)), () => $.ret($.anew(this.S, $.i(0))));
      $.put(N, $.alen($.l(S)));
      $.put(R, $.anew(this.S, $.l(N)));
      $.for(I, $.i(0), $.l(N), () => {
        $.put(CH, $.agetU(this.S, $.l(S), $.l(I)));
        $.if($.both($.ge($.l(CH), $.i(65)), $.le($.l(CH), $.i(90))), () => $.put(CH, $.add($.l(CH), $.i(32))));
        $.if($.not($.either($.either($.both($.ge($.l(CH), $.i(97)), $.le($.l(CH), $.i(122))), $.both($.ge($.l(CH), $.i(48)), $.le($.l(CH), $.i(57)))), $.either($.either($.eq($.l(CH), $.i(45)), $.eq($.l(CH), $.i(95))), $.eq($.l(CH), $.i(46))))), () => $.ret($.nul(this.S)));
        $.aset(this.S, $.l(R), $.l(I), $.l(CH));
        // an 'xn--' label start
        $.if($.andThen($.both($.eq($.l(CH), $.i(45)), $.ge($.l(I), $.i(3))), $.both($.eq($.agetU(this.S, $.l(R), $.sub($.l(I), $.i(1))), $.i(45)), $.both($.eq($.agetU(this.S, $.l(R), $.sub($.l(I), $.i(2))), $.i(110)), $.eq($.agetU(this.S, $.l(R), $.sub($.l(I), $.i(3))), $.i(120))))), () => {
          $.if($.orElse($.eq($.l(I), $.i(3)), $.eq($.agetU(this.S, $.l(R), $.sub($.l(I), $.i(4))), $.i(46))), () => $.ret($.nul(this.S)));
        });
      });
      // the last label (a trailing dot dropped): all digits, or 0x...
      $.put(LAST, $.l(N));
      $.if($.andThen($.gt($.l(LAST), $.i(0)), $.eq($.agetU(this.S, $.l(R), $.sub($.l(LAST), $.i(1))), $.i(46))), () => $.put(LAST, $.sub($.l(LAST), $.i(1))));
      $.put(I, $.l(LAST));
      $.put(NUM, $.i(1));
      $.while($.andThen($.gt($.l(I), $.i(0)), $.ne($.agetU(this.S, $.l(R), $.sub($.l(I), $.i(1))), $.i(46))), () => {
        $.put(I, $.sub($.l(I), $.i(1)));
        $.put(CH, $.agetU(this.S, $.l(R), $.l(I)));
        $.if($.not($.both($.ge($.l(CH), $.i(48)), $.le($.l(CH), $.i(57)))), () => $.put(NUM, $.i(0)));
      });
      $.if($.andThen($.lt($.add($.l(I), $.i(1)), $.l(LAST)), $.eq($.agetU(this.S, $.l(R), $.l(I)), $.i(48))), () => {
        $.if($.eq($.agetU(this.S, $.l(R), $.add($.l(I), $.i(1))), $.i(120)), () => $.put(NUM, $.i(1)));
      });
      $.if($.both($.l(NUM), $.lt($.l(I), $.l(LAST))), () => $.ret($.nul(this.S)));
      $.do($.l(R));
    });
  }

  /** unfqdn: one trailing '.' dropped. */
  private unfqdnFn(): number {
    return this.fn("unfqdn", [this.strRef], [this.strRef], (f, $) => {
      const R = f.local(this.strRef);
      $.if($.andThen($.gt($.alen($.l(0)), $.i(0)), $.eq($.agetU(this.S, $.l(0), $.sub($.alen($.l(0)), $.i(1))), $.i(46))), () => {
        $.put(R, $.anew(this.S, $.sub($.alen($.l(0)), $.i(1))));
        $.do($.l(R), $.i(0), $.l(0), $.i(0), $.sub($.alen($.l(0)), $.i(1)));
        f.c.arrayCopy(this.S, this.S);
        $.ret($.l(R));
      });
      $.do($.l(0));
    });
  }

  /** tls.js check(hostParts, pattern, true) over the ASCII host name and
   * one pattern (a DNS alt name or a CN) -> i32. */
  private wildcardFn(): number {
    return this.fn("wildcard", [this.strRef, this.strRef], [I32], (f, $) => {
      const [HOST, PAT0] = [0, 1];
      const PAT = f.local(this.strRef);
      const HN = f.local(I32);
      const PN = f.local(I32);
      const I = f.local(I32);
      const CH = f.local(I32);
      const HD = f.local(I32); // the host's first '.'
      const PD = f.local(I32);
      const STARS = f.local(I32);
      const STAR = f.local(I32);
      const HL = f.local(I32);
      const PL = f.local(I32);
      // if (!pattern) return false
      $.if($.eq($.alen($.l(PAT0)), $.i(0)), () => $.ret($.i(0)));
      // splitHost(pattern): unfqdn, ASCII upper -> lower
      $.put(PAT, $.call(this.unfqdnFn(), $.l(PAT0)));
      $.put(PN, $.alen($.l(PAT)));
      $.put(HN, $.alen($.l(HOST)));
      // the same number of labels; no empty pattern label; no character
      // outside U+0021-U+007F
      $.put(HD, $.i(0));
      $.put(PD, $.i(0));
      $.for(I, $.i(0), $.l(HN), () => $.if($.eq($.agetU(this.S, $.l(HOST), $.l(I)), $.i(46)), () => $.put(HD, $.add($.l(HD), $.i(1)))));
      $.for(I, $.i(0), $.l(PN), () => {
        $.put(CH, $.agetU(this.S, $.l(PAT), $.l(I)));
        $.if($.eq($.l(CH), $.i(46)), () => {
          $.put(PD, $.add($.l(PD), $.i(1)));
          $.if($.orElse($.eq($.l(I), $.i(0)), $.eq($.agetU(this.S, $.l(PAT), $.sub($.l(I), $.i(1))), $.i(46))), () => $.ret($.i(0)));
        });
        $.if($.either($.lt($.l(CH), $.i(0x21)), $.gt($.l(CH), $.i(0x7f))), () => $.ret($.i(0)));
      });
      $.if($.either($.eq($.l(PN), $.i(0)), $.eq($.agetU(this.S, $.l(PAT), $.sub($.l(PN), $.i(1))), $.i(46))), () => $.ret($.i(0)));
      $.if($.ne($.l(HD), $.l(PD)), () => $.ret($.i(0)));
      // the first labels' ends
      $.put(HL, $.l(HN));
      $.for(I, $.i(0), $.l(HN), () => $.if($.eq($.agetU(this.S, $.l(HOST), $.l(I)), $.i(46)), () => {
        $.put(HL, $.l(I));
        f.c.br(2);
      }));
      $.put(PL, $.l(PN));
      $.for(I, $.i(0), $.l(PN), () => $.if($.eq($.agetU(this.S, $.l(PAT), $.l(I)), $.i(46)), () => {
        $.put(PL, $.l(I));
        f.c.br(2);
      }));
      // every later label equal (case-folded)
      $.if($.ne($.sub($.l(HN), $.l(HL)), $.sub($.l(PN), $.l(PL))), () => $.ret($.i(0)));
      $.for(I, $.i(0), $.sub($.l(HN), $.l(HL)), () => {
        $.if($.ne($.call(this.lowerFn(), $.agetU(this.S, $.l(HOST), $.add($.l(HL), $.l(I)))), $.call(this.lowerFn(), $.agetU(this.S, $.l(PAT), $.add($.l(PL), $.l(I))))), () => $.ret($.i(0)));
      });
      // the pattern's first label: '*' split (at most 3 parts)
      $.put(STARS, $.i(0));
      $.put(STAR, $.i(-1));
      $.for(I, $.i(0), $.l(PL), () => $.if($.eq($.agetU(this.S, $.l(PAT), $.l(I)), $.i(42)), () => {
        $.if($.eq($.l(STARS), $.i(0)), () => $.put(STAR, $.l(I)));
        $.put(STARS, $.add($.l(STARS), $.i(1)));
      }));
      const firstEq = (): void => {
        $.if($.ne($.l(HL), $.l(PL)), () => $.ret($.i(0)));
        $.for(I, $.i(0), $.l(HL), () => {
          $.if($.ne($.call(this.lowerFn(), $.agetU(this.S, $.l(HOST), $.l(I))), $.call(this.lowerFn(), $.agetU(this.S, $.l(PAT), $.l(I)))), () => $.ret($.i(0)));
        });
        $.ret($.i(1));
      };
      // no '*', or an 'xn--' first label: plain equality
      $.if($.eq($.l(STARS), $.i(0)), firstEq);
      $.if($.call(this.hasXnFn(), $.l(PAT), $.l(PL)), firstEq);
      $.if($.gt($.l(STARS), $.i(1)), () => $.ret($.i(0)));
      $.if($.le($.l(PD), $.i(1)), () => $.ret($.i(0)));
      // prefix + '*' + suffix
      $.if($.gt($.sub($.l(PL), $.i(1)), $.l(HL)), () => $.ret($.i(0)));
      $.for(I, $.i(0), $.l(STAR), () => {
        $.if($.ne($.call(this.lowerFn(), $.agetU(this.S, $.l(HOST), $.l(I))), $.call(this.lowerFn(), $.agetU(this.S, $.l(PAT), $.l(I)))), () => $.ret($.i(0)));
      });
      $.for(I, $.i(0), $.sub($.sub($.l(PL), $.l(STAR)), $.i(1)), () => {
        $.if($.ne($.call(this.lowerFn(), $.agetU(this.S, $.l(HOST), $.sub($.sub($.l(HL), $.i(1)), $.l(I)))), $.call(this.lowerFn(), $.agetU(this.S, $.l(PAT), $.sub($.sub($.l(PL), $.i(1)), $.l(I))))), () => $.ret($.i(0)));
      });
      $.do($.i(1));
    });
  }

  private lowerFn(): number {
    return this.fn("lower", [I32], [I32], (f, $) => $.do($.sel(I32, $.both($.ge($.l(0), $.i(65)), $.le($.l(0), $.i(90))), $.add($.l(0), $.i(32)), $.l(0))));
  }

  /** The first label (of length n) contains 'xn--'. */
  private hasXnFn(): number {
    return this.fn("hasXn", [this.strRef, I32], [I32], (f, $) => {
      const I = f.local(I32);
      $.for(I, $.i(0), $.sub($.l(1), $.i(3)), () => {
        $.if($.both($.both($.eq($.agetU(this.S, $.l(0), $.l(I)), $.i(120)), $.eq($.agetU(this.S, $.l(0), $.add($.l(I), $.i(1))), $.i(110))), $.both($.eq($.agetU(this.S, $.l(0), $.add($.l(I), $.i(2))), $.i(45)), $.eq($.agetU(this.S, $.l(0), $.add($.l(I), $.i(3))), $.i(45)))), () => $.ret($.i(1)));
      });
      $.do($.i(0));
    });
  }

  /* ── TLSSocket members ────────────────────────────────────────────── */

  /** socket.authorized (false on a plain socket — Node's is undefined
   * there, which the lowering reads as its boolean) */
  authorizedFn(): number {
    return this.fn("authorized", [this.sockRef], [I32], (f, $) => {
      $.if($.isNull($.get(this.sockT, this.tf.S_TLS, $.l(0))), () => $.ret($.i(0)));
      $.do($.get(this.xT(), X_AUTH, $.cast(this.xT(), $.get(this.sockT, this.tf.S_TLS, $.l(0)))));
    });
  }

  /** socket.authorizationError: the string, or null */
  authErrorFn(): number {
    return this.fn("authError", [this.sockRef], [this.strRef], (f, $) => {
      $.if($.isNull($.get(this.sockT, this.tf.S_TLS, $.l(0))), () => $.ret($.nul(this.S)));
      $.do($.get(this.xT(), X_AUTHERR, $.cast(this.xT(), $.get(this.sockT, this.tf.S_TLS, $.l(0)))));
    });
  }

  /* ── the CA store ─────────────────────────────────────────────────── */

  private g(): NonNullable<TlsBuilder["globalsField"]> {
    if (this.globalsField === null) {
      const nul = (t: number): number =>
        this.mb.addGlobal(this.ref(t), true, (w) => {
          w.u8(0xd0);
          w.sleb(t);
        });
      const sv = this.deps.strVec().struct;
      this.globalsField = {
        user: nul(this.x509.SA),
        userN: this.mb.addGlobal(I32, true, (w) => {
          w.u8(0x41);
          w.sleb(0);
        }),
        bundled: nul(sv),
        dflt: nul(sv),
        system: nul(sv),
        extra: nul(sv),
        roots: -1,
        rootsLen: 0,
      };
    }
    return this.globalsField;
  }

  /** The bundled roots' data offset (interned on first use). */
  private rootsData(): number {
    const g = this.g();
    if (g.roots < 0) {
      const bytes = tlsRootsBytes();
      g.roots = this.mb.internData(bytes);
      g.rootsLen = bytes.length;
    }
    return g.roots;
  }

  private newVec($: A, n: X): X {
    const sv = this.deps.strVec();
    return $.new_(sv.struct, n, $.raw((c) => {
      n();
      c.arrayNewDefault(sv.bufType);
      c.refAsNonNull();
    }));
  }

  /** tls.rootCertificates / getCACertificates('bundled'): Node's strings
   * regenerated from the DER, cached. */
  bundledFn(): number {
    const sv = this.deps.strVec();
    return this.fn("bundled", [], [this.ref(sv.struct)], (f, $) => {
      const g = this.g();
      const V = f.local(this.ref(sv.struct));
      const P = f.local(I32);
      const I = f.local(I32);
      const N = f.local(I32);
      const K = f.local(I32);
      const BUF = f.local(this.ref(this.B));
      const ALL = f.local(this.ref(this.B));
      $.if($.notNull($.g(g.bundled)), () => $.ret($.g(g.bundled)));
      $.put(V, this.newVec($, $.i(TLS_ROOTS_COUNT)));
      // the blob is in the module's passive data segment
      f.c.i32Const(this.rootsData());
      f.c.i32Const(g.rootsLen);
      f.c.arrayNewData(this.B, 0);
      f.c.localSet(ALL);
      $.put(P, $.i(0));
      void K;
      $.for(I, $.i(0), $.i(TLS_ROOTS_COUNT), () => {
        $.put(N, $.or($.agetU(this.B, $.l(ALL), $.l(P)), $.shl($.agetU(this.B, $.l(ALL), $.add($.l(P), $.i(1))), $.i(8))));
        $.put(BUF, $.anew(this.B, $.l(N)));
        $.do($.l(BUF), $.i(0), $.l(ALL), $.add($.l(P), $.i(2)), $.l(N));
        f.c.arrayCopy(this.B, this.B);
        $.aset(sv.bufType, $.get(sv.struct, 1, $.l(V)), $.l(I), $.call(this.x509.pemFn(72, false), $.l(BUF), $.i(0), $.l(N)));
        $.put(P, $.add($.add($.l(P), $.i(2)), $.l(N)));
      });
      $.gput(g.bundled, $.l(V));
      $.do($.l(V));
    });
  }

  /** getCACertificates('system' | 'extra'): the host's store (op 7). */
  private hostStoreFn(kind: 1 | 2): number {
    const sv = this.deps.strVec();
    return this.fn(`store${kind}`, [], [this.ref(sv.struct)], (f, $) => {
      const g = this.g();
      const cache = kind === 1 ? g.system : g.extra;
      const V = f.local(this.ref(sv.struct));
      const CAP = f.local(I32);
      const R = f.local(I32);
      const BASE = f.local(I32);
      const P = f.local(I32);
      const N = f.local(I32);
      const I = f.local(I32);
      const L = f.local(I32);
      const K = f.local(I32);
      const BUF = f.local(this.ref(this.B));
      $.if($.notNull($.g(cache)), () => $.ret($.g(cache)));
      $.put(CAP, $.i(65536));
      $.while($.i(1), () => {
        this.deps.ensureCapacity(f.c, () => $.do($.add($.l(CAP), $.i(4))));
        this.base($, BASE);
        $.put(R, this.tlsCall($, OP_CA_STORE, $.l(BASE), $.l(CAP), $.i(0), $.i(kind)));
        $.if($.ge($.l(R), $.i(4)), () => f.c.br(2));
        $.if($.either($.ge($.l(R), $.i(0)), $.le($.sub($.i(0), $.l(R)), $.l(CAP))), () => this.trap($));
        $.put(CAP, $.sub($.i(0), $.l(R)));
      });
      $.put(N, this.loadU32($, $.l(BASE)));
      $.put(V, this.newVec($, $.l(N)));
      $.put(P, $.add($.l(BASE), $.i(4)));
      $.for(I, $.i(0), $.l(N), () => {
        $.put(L, this.loadU32($, $.l(P)));
        $.if($.gt($.add($.add($.sub($.l(P), $.l(BASE)), $.i(4)), $.l(L)), $.l(R)), () => this.trap($));
        $.put(BUF, $.anew(this.B, $.l(L)));
        $.for(K, $.i(0), $.l(L), () => {
          $.do($.l(BUF), $.l(K), $.add($.add($.l(P), $.i(4)), $.l(K)));
          f.c.i32Load8U();
          f.c.arraySet(this.B);
        });
        $.aset(sv.bufType, $.get(sv.struct, 1, $.l(V)), $.l(I), $.call(this.x509.pemFn(64, true), $.l(BUF), $.i(0), $.l(L)));
        $.put(P, $.add($.add($.l(P), $.i(4)), $.and($.add($.l(L), $.i(3)), $.i(-4))));
      });
      $.gput(cache, $.l(V));
      $.do($.l(V));
    });
  }

  /** getCACertificates('default'): the user's set when one was given,
   * else the bundled roots (S090 (d): NODE_EXTRA_CA_CERTS's certificates
   * are not listed here; connections still trust them through the host's
   * default trust). */
  defaultFn(): number {
    const sv = this.deps.strVec();
    return this.fn("default", [], [this.ref(sv.struct)], (f, $) => {
      const g = this.g();
      const V = f.local(this.ref(sv.struct));
      const B = f.local(this.ref(sv.struct));
      const I = f.local(I32);
      $.if($.notNull($.g(g.dflt)), () => $.ret($.g(g.dflt)));
      if (this.deps.caSet) {
        $.if($.notNull($.g(g.user)), () => {
          $.put(V, this.newVec($, $.g(g.userN)));
          $.for(I, $.i(0), $.g(g.userN), () => $.aset(sv.bufType, $.get(sv.struct, 1, $.l(V)), $.l(I), $.aget(this.x509.SA, $.g(g.user), $.l(I))));
          $.gput(g.dflt, $.l(V));
          $.ret($.l(V));
        });
      }
      // the bundled roots (an array of its own, as Node's)
      $.put(B, $.call(this.bundledFn()));
      $.put(V, this.newVec($, $.get(sv.struct, 0, $.l(B))));
      $.do($.get(sv.struct, 1, $.l(V)), $.i(0), $.get(sv.struct, 1, $.l(B)), $.i(0), $.get(sv.struct, 0, $.l(B)));
      f.c.arrayCopy(sv.bufType, sv.bufType);
      $.gput(g.dflt, $.l(V));
      $.do($.l(V));
    });
  }

  /** getCACertificates(type) -> the cached array (null with the error
   * pending for an unknown type). */
  getFn(): number {
    const sv = this.deps.strVec();
    return this.fn("get", [this.strRef], [this.ref(sv.struct)], (f, $) => {
      const T = 0;
      $.if(this.streq($, $.l(T), this.lit($, "default")), () => $.ret($.call(this.defaultFn())));
      $.if(this.streq($, $.l(T), this.lit($, "bundled")), () => $.ret($.call(this.bundledFn())));
      $.if(this.streq($, $.l(T), this.lit($, "system")), () => $.ret($.call(this.hostStoreFn(1))));
      $.if(this.streq($, $.l(T), this.lit($, "extra")), () => $.ret($.call(this.hostStoreFn(2))));
      this.argValue($, "type", $.call(this.deps.inspectStr(), $.l(T)));
      $.do($.nul(sv.struct));
    });
  }

  /** tls.getCACertificates over a checked-dynamic type: validateString,
   * then getFn. */
  getDynFn(): number {
    const sv = this.deps.strVec();
    return this.fn("getDyn", [this.dynRef], [this.ref(sv.struct)], (f, $) => {
      const D = 0;
      $.if($.not(this.isKind($, $.l(D), K_STR)), () => {
        this.argType($, "type", "of type string", $.l(D));
        $.ret($.nul(sv.struct));
      });
      $.do($.call(this.getFn(), this.dstr($, $.l(D))));
    });
  }

  /** tls.setDefaultCACertificates(certs): every string's certificates
   * (OpenSSL's PEM reading), deduplicated and ordered by X509_cmp (the
   * SHA-1 of the DER, then the encoding). Errors leave the set as it was. */
  setFn(): number {
    const sv = this.deps.strVec();
    const x = this.x509;
    return this.fn("set", [this.ref(sv.struct)], [], (f, $) => {
      const CERTS = 0;
      const g = this.g();
      const I = f.local(I32);
      const J = f.local(I32);
      const K = f.local(I32);
      const N = f.local(I32);
      const DERS = f.local(this.ref(x.BA));
      const ALL = f.local(this.ref(x.BA));
      const ALLN = f.local(I32);
      const HS = f.local(this.ref(this.mb.arrayType(this.ref(x.I32A), true)));
      const SORT = f.local(this.ref(x.BA));
      const SORTN = f.local(I32);
      const H = f.local(this.ref(x.I32A));
      const HA = this.mb.arrayType(this.ref(x.I32A), true);
      const SH = f.local(this.ref(HA));
      const CMP = f.local(I32);
      const D = f.local(this.bytesRef);
      const B8 = f.local(this.bytesRef);
      const OUT = f.local(this.ref(x.SA));
      const E = f.local(I32);
      void HS;
      $.put(N, $.get(sv.struct, 0, $.l(CERTS)));
      // the empty array: the user set is empty (trust nothing)
      $.if($.eq($.l(N), $.i(0)), () => {
        $.gput(g.user, $.anew(x.SA, $.i(0)));
        $.gput(g.userN, $.i(0));
        $.gput(g.dflt, $.nul(sv.struct));
        $.ret();
      });
      $.for(I, $.i(0), $.l(N), () => {
        $.put(B8, $.call(this.deps.strToBytes(), $.aget(sv.bufType, $.get(sv.struct, 1, $.l(CERTS)), $.l(I))));
        $.put(D, $.call(this.bytesCopyFn(), $.l(B8)));
        $.put(DERS, $.call(x.pemReadFn(), $.get(this.BT, 0, $.l(D)), $.get(this.BT, 2, $.l(D))));
        $.put(E, $.g(x.errGlobal()));
        $.if($.ne($.l(E), $.i(0)), () => {
          $.if($.eq($.l(E), $.i(PEM_BAD_BASE64)), () => {
            this.throwErr($, "%Error", this.lit($, "error:04800064:PEM routines::bad base64 decode"), "ERR_OSSL_PEM_BAD_BASE64_DECODE");
            $.ret();
          });
          $.if($.eq($.l(E), $.i(PEM_ASN1)), () => {
            this.throwErr($, "%Error", this.lit($, "error:0488000D:PEM routines::ASN1 lib"), "ERR_OSSL_PEM_ASN1_LIB");
            $.ret();
          });
          $.if($.eq($.l(E), $.i(PEM_BAD_END_LINE)), () => {
            this.throwErr($, "%Error", this.lit($, "error:04800066:PEM routines::bad end line"), "ERR_OSSL_PEM_BAD_END_LINE");
            $.ret();
          });
          $.if($.eq($.l(E), $.i(PEM_NONCANON)), () => {
            this.fence($, this.lit($, "tls.setDefaultCACertificates of a certificate whose DER OpenSSL would re-encode (a non-minimal or indefinite length inside it)"));
            $.ret();
          });
          this.fence($, this.lit($, "tls.setDefaultCACertificates of a PEM block with header lines or a line over 253 bytes"));
          $.ret();
        });
        $.if($.notNull($.l(DERS)), () => {
          $.put(J, $.i(0));
          $.while($.andThen($.lt($.l(J), $.alen($.l(DERS))), $.notNull($.aget(x.BA, $.l(DERS), $.l(J)))), () => {
            $.put(ALL, $.call(x.baPushFn(), $.l(ALL), $.l(ALLN), $.aget(x.BA, $.l(DERS), $.l(J))));
            $.put(ALLN, $.add($.l(ALLN), $.i(1)));
            $.put(J, $.add($.l(J), $.i(1)));
          });
        });
      });
      $.if($.eq($.l(ALLN), $.i(0)), () => {
        this.throwErr($, "%Error", this.lit($, "No valid certificates found in the provided array"), "ERR_CRYPTO_OPERATION_FAILED");
        $.ret();
      });
      // the std::set<X509*, X509Less>: an insertion sort with dedupe
      $.put(SORT, $.anew(x.BA, $.l(ALLN)));
      $.put(SH, $.anew(HA, $.l(ALLN)));
      $.for(I, $.i(0), $.l(ALLN), () => {
        $.put(D, $.aget(x.BA, $.l(ALL), $.l(I)));
        $.put(H, $.call(x.sha1Fn(), $.get(this.BT, 0, $.l(D)), $.get(this.BT, 1, $.l(D)), $.get(this.BT, 2, $.l(D))));
        // the insertion point
        $.put(J, $.i(0));
        $.put(CMP, $.i(1));
        f.c.block();
        $.while($.lt($.l(J), $.l(SORTN)), () => {
          $.put(CMP, $.call(this.x509CmpFn(), $.l(H), $.l(D), $.aget(HA, $.l(SH), $.l(J)), $.aget(x.BA, $.l(SORT), $.l(J))));
          $.if($.le($.l(CMP), $.i(0)), () => f.c.br(3));
          $.put(J, $.add($.l(J), $.i(1)));
        });
        f.c.end();
        $.if($.ne($.l(CMP), $.i(0)), () => {
          $.put(K, $.l(SORTN));
          $.while($.gt($.l(K), $.l(J)), () => {
            $.aset(x.BA, $.l(SORT), $.l(K), $.aget(x.BA, $.l(SORT), $.sub($.l(K), $.i(1))));
            $.aset(HA, $.l(SH), $.l(K), $.aget(HA, $.l(SH), $.sub($.l(K), $.i(1))));
            $.put(K, $.sub($.l(K), $.i(1)));
          });
          $.aset(x.BA, $.l(SORT), $.l(J), $.l(D));
          $.aset(HA, $.l(SH), $.l(J), $.l(H));
          $.put(SORTN, $.add($.l(SORTN), $.i(1)));
        });
      });
      $.put(OUT, $.anew(x.SA, $.l(SORTN)));
      $.for(I, $.i(0), $.l(SORTN), () => {
        $.put(D, $.aget(x.BA, $.l(SORT), $.l(I)));
        $.aset(x.SA, $.l(OUT), $.l(I), $.call(x.pemFn(64, true), $.get(this.BT, 0, $.l(D)), $.get(this.BT, 1, $.l(D)), $.get(this.BT, 2, $.l(D))));
      });
      $.gput(g.user, $.l(OUT));
      $.gput(g.userN, $.l(SORTN));
      $.gput(g.dflt, $.nul(sv.struct));
    });
  }

  /** A bytes value as one fresh buffer from offset 0. */
  private bytesCopyFn(): number {
    return this.fn("bytesCopy", [this.bytesRef], [this.bytesRef], (f, $) => {
      const R = f.local(this.ref(this.B));
      $.put(R, $.anew(this.B, $.get(this.BT, 2, $.l(0))));
      $.do($.l(R), $.i(0), $.get(this.BT, 0, $.l(0)), $.get(this.BT, 1, $.l(0)), $.get(this.BT, 2, $.l(0)));
      f.c.arrayCopy(this.B, this.B);
      $.do($.new_(this.BT, $.raw((c) => {
        c.localGet(R);
        c.refAsNonNull();
      }), $.i(0), $.get(this.BT, 2, $.l(0))));
    });
  }

  /** X509_cmp: the SHA-1, then the encoding's length and bytes. */
  private x509CmpFn(): number {
    const x = this.x509;
    return this.fn("x509Cmp", [this.ref(x.I32A), this.bytesRef, this.ref(x.I32A), this.bytesRef], [I32], (f, $) => {
      const [H1, D1, H2, D2] = [0, 1, 2, 3];
      const R = f.local(I32);
      const I = f.local(I32);
      const A1 = f.local(I32);
      const A2 = f.local(I32);
      $.put(R, $.call(x.sha1CmpFn(), $.l(H1), $.l(H2)));
      $.if($.ne($.l(R), $.i(0)), () => $.ret($.l(R)));
      $.if($.lt($.get(this.BT, 2, $.l(D1)), $.get(this.BT, 2, $.l(D2))), () => $.ret($.i(-1)));
      $.if($.gt($.get(this.BT, 2, $.l(D1)), $.get(this.BT, 2, $.l(D2))), () => $.ret($.i(1)));
      $.for(I, $.i(0), $.get(this.BT, 2, $.l(D1)), () => {
        $.put(A1, $.agetU(this.B, $.get(this.BT, 0, $.l(D1)), $.add($.get(this.BT, 1, $.l(D1)), $.l(I))));
        $.put(A2, $.agetU(this.B, $.get(this.BT, 0, $.l(D2)), $.add($.get(this.BT, 1, $.l(D2)), $.l(I))));
        $.if($.lt($.l(A1), $.l(A2)), () => $.ret($.i(-1)));
        $.if($.gt($.l(A1), $.l(A2)), () => $.ret($.i(1)));
      });
      $.do($.i(0));
    });
  }

  /** tls.pemDyn: a runtime cert / key value as PEM bytes — a string, an
   * ArrayBufferView, or a one-element array of those; anything else is
   * the named fence (`what` names the option). */
  pemDynFn(): number {
    return this.fn("pemDyn", [this.dynRef, this.strRef], [this.bytesRef], (f, $) => {
      const [D, WHAT] = [0, 1];
      const V = f.local(this.dynRef);
      const vec = this.deps.dynArrVec();
      $.put(V, $.l(D));
      $.if($.eq(this.kind($, $.l(V)), $.i(K_ARR)), () => {
        $.if($.ne($.get(vec.struct, 0, $.cast(vec.struct, $.get(this.DT, 2, $.l(V)))), $.i(1)), () => {
          this.fence($, this.cat($, $.l(WHAT), this.lit($, " holding an array of other than one entry")));
          $.ret($.nul(this.BT));
        });
        $.put(V, $.aget(vec.bufType, $.get(vec.struct, 1, $.cast(vec.struct, $.get(this.DT, 2, $.l(V)))), $.i(0)));
      });
      $.if($.eq(this.kind($, $.l(V)), $.i(K_STR)), () => $.ret($.call(this.deps.strToBytes(), this.dstr($, $.l(V)))));
      $.if($.eq(this.kind($, $.l(V)), $.i(K_BYTES)), () => $.ret($.call(this.deps.dynBytes(), $.l(V))));
      this.fence($, this.cat($, $.l(WHAT), this.lit($, " holding a value other than PEM material (a string or a Buffer)")));
      $.do($.nul(this.BT));
    });
  }
}

export { EV_SECURE, EV_TLS_ERROR, X_HOSTID };
