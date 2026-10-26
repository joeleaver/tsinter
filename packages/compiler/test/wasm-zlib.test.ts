/* The zlib unit (corpus 1404): backend/wasm/zlib.ts — a port of the zlib
 * Node v24.18.1 bundles (Chromium's fork, "1.3.1-e00f703") — against
 * Node's own zlib, live.
 *
 * This file links the builder's real deflateSync / inflateSync into a
 * standalone module (wasm-zlib-standalone.ts) and compares them in-process
 * with this process's `node:zlib` over many inputs: deflate's bytes at the
 * default level and at every level, round trips both ways, Node-produced
 * streams, one hand-built input per inflate error, every truncation of
 * several streams, and seeded mutation fuzz. Compiled programs — through
 * the whole pipeline, on the wasm, c and llvm lanes alike, against Node's
 * run of the same source — are zlib-lanes.test.ts's one shared table.
 *
 * Errors: Node's are plain Errors with `code` and `errno`; every lane
 * carries name, message and code (SEMANTICS.md S101 (a)), so rows compare
 * message and code, and Z-ERR-01 pins Node's errno for each code. */
import * as zlib from "node:zlib";
import { beforeAll, describe, expect, test } from "vitest";
import { buildZlibModule, type ZlibModule } from "./wasm-zlib-standalone.js";

let z: ZlibModule;
beforeAll(async () => {
  z = await buildZlibModule();
});

/* ── inputs ───────────────────────────────────────────────────────────── */

let seed = 1;
function rnd(n: number): number {
  seed = (seed * 48271) % 2147483647;
  return seed % n;
}
const WORDS = ["the", "quick", "brown", "fox", "jumps", "over", "lazy", "dog", "zlib", "deflate", "window", "huffman", "tree", "\n"];
const KINDS = ["random", "words", "zeros", "period7", "period3000", "lowent", "ramp", "json", "mixed"] as const;
type Kind = (typeof KINDS)[number];

function make(kind: Kind, n: number): Buffer {
  const b = Buffer.alloc(n);
  let i = 0;
  switch (kind) {
    case "random":
      for (; i < n; i++) b[i] = rnd(256);
      break;
    case "words":
      while (i < n) {
        const w = WORDS[rnd(WORDS.length)]!;
        for (let j = 0; j < w.length && i < n; j++) b[i++] = w.charCodeAt(j);
        if (i < n) b[i++] = 32;
      }
      break;
    case "zeros":
      break;
    case "period7":
      for (; i < n; i++) b[i] = 97 + (i % 7);
      break;
    case "period3000": {
      // a period longer than MAX_MATCH, with matches at distance 3000
      const p = Buffer.alloc(3000);
      for (let j = 0; j < p.length; j++) p[j] = rnd(256);
      for (; i < n; i++) b[i] = p[i % 3000]!;
      break;
    }
    case "lowent":
      for (; i < n; i++) b[i] = rnd(4) === 0 ? 98 : 97;
      break;
    case "ramp":
      for (; i < n; i++) b[i] = i % 251;
      break;
    case "json":
      for (let k = 0; i < n; k++) {
        const s = `{"id":${k},"name":"user${rnd(1000)}","ok":${rnd(2) === 0}},`;
        for (let j = 0; j < s.length && i < n; j++) b[i++] = s.charCodeAt(j);
      }
      break;
    case "mixed":
      while (i < n) {
        if (rnd(3) === 0) {
          const r = 1 + rnd(300);
          for (let j = 0; j < r && i < n; j++) b[i++] = rnd(256);
        } else {
          const w = WORDS[rnd(WORDS.length)]!;
          const reps = 1 + rnd(30);
          for (let t = 0; t < reps; t++) for (let j = 0; j < w.length && i < n; j++) b[i++] = w.charCodeAt(j);
        }
      }
      break;
  }
  return b;
}

/** 0, 1, MIN_MATCH, MAX_MATCH and MIN_LOOKAHEAD edges, the 16 KiB symbol
 * buffer (sym_end 16383) and output chunk, MAX_DIST (32506), the 32 KiB
 * window, the 64 KiB window_size (the first slide). */
const SIZES = [0, 1, 2, 3, 4, 12, 100, 257, 258, 259, 261, 262, 263, 1000, 16383, 16384, 16385, 32506, 32767, 32768, 32769, 65535, 65536, 65537, 98304];

function firstDiff(a: Buffer, b: Buffer): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

/** Node's inflateSync outcome, as zlib.ts's standalone answers it. */
function nodeInflate(b: Uint8Array): Buffer | { message: string; code: string; errno: number } {
  try {
    return zlib.inflateSync(b);
  } catch (e) {
    const x = e as { message: string; code: string; errno: number };
    return { message: x.message, code: x.code, errno: x.errno };
  }
}
function outcome(r: Buffer | { message: string; code: string }): string {
  return r instanceof Buffer ? `ok ${r.length} ${r.toString("hex").slice(0, 64)}` : `err ${r.message} | ${r.code}`;
}

/* ── the hand-built error inputs ──────────────────────────────────────── */

/** An LSB-first bit writer (deflate's order); huff() writes a Huffman
 * code most significant bit first, as deflate stores codes. */
class Bits {
  private readonly out: number[] = [];
  private acc = 0;
  private n = 0;
  bits(v: number, n: number): this {
    for (let i = 0; i < n; i++) {
      this.acc |= ((v >> i) & 1) << this.n;
      if (++this.n === 8) {
        this.out.push(this.acc);
        this.acc = 0;
        this.n = 0;
      }
    }
    return this;
  }
  huff(code: number, len: number): this {
    for (let i = len - 1; i >= 0; i--) this.bits((code >> i) & 1, 1);
    return this;
  }
  done(): Buffer {
    this.bits(0, 16);
    if (this.n !== 0) this.out.push(this.acc);
    return Buffer.from(this.out);
  }
}
const zhdr = (): Bits => new Bits().bits(0x78, 8).bits(0x9c, 8);
const fixedLit = (w: Bits, s: number): Bits =>
  s < 144 ? w.huff(0x30 + s, 8) : s < 256 ? w.huff(0x190 + s - 144, 9) : s < 280 ? w.huff(s - 256, 7) : w.huff(0xc0 + s - 280, 8);
const fixed = (): Bits => zhdr().bits(1, 1).bits(1, 2);
const dynamic = (): Bits => zhdr().bits(1, 1).bits(2, 2);
/** HLIT 0, HDIST 0, HCLEN 0 with code-length code {0: "0", 16: "1"} */
const cl016 = (): Bits => dynamic().bits(0, 5).bits(0, 5).bits(0, 4).bits(1, 3).bits(0, 3).bits(0, 3).bits(1, 3);
/** code-length code {0: "0", 1: "1"} (HCLEN 14 reaches symbol 1's slot) */
const cl01 = (ndist: number): Bits => {
  const w = dynamic().bits(0, 5).bits(ndist - 1, 5).bits(14, 4);
  for (let i = 0; i < 18; i++) w.bits(i === 3 || i === 17 ? 1 : 0, 3);
  return w;
};
const hdrFor = (cmf: number): Buffer => {
  let flg = 0;
  while (((cmf << 8) | flg) % 31) flg++;
  return Buffer.from([cmf, flg, 3, 0, 0, 0, 0, 1]);
};

/** [label, input, the message Node answers] — every message zlib's inflate
 * can raise for a zlib stream, Node's "Missing dictionary", and Node's
 * end-of-input text. */
function errorRows(): [string, Buffer, string][] {
  const okStream = zlib.deflateSync(Buffer.from("hello hello hello hello compression works"));
  const badAdler = Buffer.from(okStream);
  badAdler[badAdler.length - 1] = badAdler[badAdler.length - 1]! ^ 1;
  const rows: [string, Buffer, string][] = [
    ["empty", Buffer.alloc(0), "unexpected end of file"],
    ["one byte", Buffer.from("78", "hex"), "unexpected end of file"],
    ["header only", Buffer.from("789c", "hex"), "unexpected end of file"],
    ["no final block", Buffer.from("789c03", "hex"), "unexpected end of file"],
    ["truncated by 1", okStream.subarray(0, okStream.length - 1), "unexpected end of file"],
    ["truncated by 4", okStream.subarray(0, okStream.length - 4), "unexpected end of file"],
    ["fdict, dictid cut", Buffer.from("78bb0000", "hex"), "unexpected end of file"],
    ["bad header", Buffer.from("00112233", "hex"), "incorrect header check"],
    ["gzip data", zlib.gzipSync(Buffer.from("x")), "incorrect header check"],
    ["raw data", zlib.deflateRawSync(Buffer.from("hello")), "incorrect header check"],
    ["CM 7", hdrFor(0x07), "unknown compression method"],
    ["CM 7, CINFO 7", hdrFor(0x77), "unknown compression method"],
    ["CINFO 8", hdrFor(0x88), "invalid window size"],
    ["CINFO 15", hdrFor(0xf8), "invalid window size"],
    ["fdict", Buffer.from("78bb00000001", "hex"), "Missing dictionary"],
    ["btype 3", Buffer.from("789c07", "hex"), "invalid block type"],
    ["stored lengths", Buffer.from("789c0105000000", "hex"), "invalid stored block lengths"],
    ["HLIT 30", dynamic().bits(30, 5).bits(0, 5).bits(0, 4).done(), "too many length or distance symbols"],
    ["HDIST 30", dynamic().bits(0, 5).bits(30, 5).bits(0, 4).done(), "too many length or distance symbols"],
    ["code-length code incomplete", dynamic().bits(0, 5).bits(0, 5).bits(0, 4).bits(0, 3).bits(0, 3).bits(0, 3).bits(1, 3).done(), "invalid code lengths set"],
    ["code-length code over-subscribed", dynamic().bits(0, 5).bits(0, 5).bits(0, 4).bits(1, 3).bits(1, 3).bits(1, 3).bits(1, 3).done(), "invalid code lengths set"],
    ["repeat first", cl016().huff(1, 1).done(), "invalid bit length repeat"],
    [
      "repeat past the end",
      (() => {
        const w = cl016().huff(0, 1);
        for (let i = 0; i < 86; i++) w.huff(1, 1).bits(3, 2);
        return w.done();
      })(),
      "invalid bit length repeat",
    ],
    [
      "no end-of-block",
      (() => {
        const w = cl016();
        for (let i = 0; i < 258; i++) w.huff(0, 1);
        return w.done();
      })(),
      "invalid code -- missing end-of-block",
    ],
    [
      "literal/length over-subscribed",
      (() => {
        const w = cl01(1).huff(1, 1).huff(1, 1);
        for (let i = 2; i < 256; i++) w.huff(0, 1);
        return w.huff(1, 1).huff(1, 1).done();
      })(),
      "invalid literal/lengths set",
    ],
    [
      "distances over-subscribed",
      (() => {
        const w = cl01(3).huff(1, 1);
        for (let i = 1; i < 256; i++) w.huff(0, 1);
        return w.huff(1, 1).huff(1, 1).huff(1, 1).huff(1, 1).done();
      })(),
      "invalid distances set",
    ],
    ["literal/length 286", fixedLit(fixedLit(fixed(), 97), 286).done(), "invalid literal/length code"],
    ["distance code 30", fixedLit(fixedLit(fixed(), 97), 257).huff(30, 5).done(), "invalid distance code"],
    ["distance before output", fixedLit(fixed(), 257).huff(0, 5).done(), "invalid distance too far back"],
    ["distance 5 after one byte", fixedLit(fixedLit(fixed(), 97), 257).huff(4, 5).bits(0, 1).done(), "invalid distance too far back"],
    ["bad adler", badAdler, "incorrect data check"],
  ];
  return rows;
}

/* ── layer 1: the builder against this process's zlib ─────────────────── */

describe("zlib.ts in a standalone module, against node:zlib in process", () => {
  test("Z-ORACLE-01 the oracle is Node's bundled Chromium zlib at the pinned revision", () => {
    expect(process.versions.zlib).toBe("1.3.1-e00f703");
  });

  test("Z-DEF-01 deflate at the default level: Node's bytes for every kind at every boundary size, and past 1 MiB", () => {
    seed = 11;
    let rows = 0;
    const check = (label: string, input: Buffer): void => {
      const ours = z.deflate(input);
      const node = zlib.deflateSync(input);
      if (!ours.equals(node)) {
        throw new Error(`${label} (${input.length} B): ${ours.length} vs Node ${node.length} bytes, first difference at ${firstDiff(ours, node)}`);
      }
      rows++;
    };
    for (const kind of KINDS) for (const n of SIZES) check(`${kind}/${n}`, make(kind, n));
    for (const kind of ["random", "words", "zeros", "lowent", "mixed", "period3000"] as const) check(`${kind}/big`, make(kind, (1 << 20) + 7));
    check("words/3M", make("words", 3 * (1 << 20) + 1));
    expect(rows).toBe(KINDS.length * SIZES.length + 7);
  }, 120000);

  test("Z-DEF-02 deflate at the default level: 300 fuzzed inputs (kind, length) equal Node's bytes", () => {
    seed = 22;
    for (let k = 0; k < 300; k++) {
      const kind = KINDS[rnd(KINDS.length)]!;
      const n = rnd(4) === 0 ? rnd(200000) : rnd(3000);
      const input = make(kind, n);
      const ours = z.deflate(input);
      const node = zlib.deflateSync(input);
      if (!ours.equals(node)) throw new Error(`fuzz ${k} ${kind}/${n}: first difference at ${firstDiff(ours, node)}`);
    }
  }, 120000);

  test("Z-DEF-03 every level 0-9 (the builder's level parameter; deflateSync passes -1, i.e. 6) equals Node's {level}", () => {
    seed = 33;
    let rows = 0;
    for (const kind of KINDS) {
      for (const n of [0, 1, 300, 16385, 40000, 70000, 200000]) {
        const input = make(kind, n);
        for (let level = 0; level <= 9; level++) {
          const ours = z.deflate(input, level);
          const node = zlib.deflateSync(input, { level });
          if (!ours.equals(node)) throw new Error(`${kind}/${n} level ${level}: first difference at ${firstDiff(ours, node)}`);
          rows++;
        }
      }
    }
    expect(rows).toBe(KINDS.length * 7 * 10);
  }, 120000);

  test("Z-RT-01 round trips: Node inflates ours, and ours inflates ours", () => {
    seed = 44;
    for (const kind of KINDS) {
      for (const n of [0, 1, 258, 32769, 65537, 300000]) {
        const input = make(kind, n);
        const packed = z.deflate(input);
        expect(zlib.inflateSync(packed).equals(input), `${kind}/${n} through Node`).toBe(true);
        const back = z.inflate(packed);
        expect(back instanceof Buffer && back.equals(input), `${kind}/${n} through ours`).toBe(true);
      }
    }
  }, 120000);

  test("Z-INF-01 Node-produced streams inflate to the input: levels 0-9, strategies, memLevels and windowBits", () => {
    seed = 55;
    const C = zlib.constants;
    const opts: zlib.ZlibOptions[] = [
      ...Array.from({ length: 10 }, (_, level) => ({ level })),
      { strategy: C.Z_FIXED },
      { strategy: C.Z_HUFFMAN_ONLY },
      { strategy: C.Z_RLE },
      { strategy: C.Z_FILTERED },
      { memLevel: 1 },
      { memLevel: 9, level: 9 },
      { windowBits: 9 },
      { windowBits: 12, level: 1 },
    ];
    let rows = 0;
    for (const kind of KINDS) {
      for (const n of [0, 1, 1000, 40000, 140000]) {
        const input = make(kind, n);
        for (const o of opts) {
          const back = z.inflate(zlib.deflateSync(input, o));
          if (!(back instanceof Buffer) || !back.equals(input)) throw new Error(`${kind}/${n} ${JSON.stringify(o)}: ${outcome(back)}`);
          rows++;
        }
      }
    }
    expect(rows).toBe(KINDS.length * 5 * opts.length);
  }, 120000);

  test("Z-ERR-01 every error row: the message and code are Node's (and Node's errno is its code's: S101 (a))", () => {
    const errno: Record<string, number> = { Z_DATA_ERROR: -3, Z_BUF_ERROR: -5, Z_NEED_DICT: 2 };
    const seen = new Set<string>();
    for (const [label, input, message] of errorRows()) {
      const node = nodeInflate(input);
      expect(node instanceof Buffer ? "ok" : node.message, `${label}: the row means what it says`).toBe(message);
      if (node instanceof Buffer) continue;
      expect(node.errno, `${label}: Node's errno`).toBe(errno[node.code]);
      const ours = z.inflate(input);
      expect(outcome(ours), label).toBe(outcome(node));
      seen.add(message);
    }
    // all seventeen texts
    expect(seen.size).toBe(17);
    // bytes after the stream end are ignored, as in Node
    const trailing = Buffer.concat([zlib.deflateSync(Buffer.from("abc")), Buffer.from("garbage")]);
    expect(outcome(z.inflate(trailing))).toBe(outcome(nodeInflate(trailing)));
  });

  test("Z-ERR-02 truncation at every byte offset of several streams (ours and Node's) answers Node's outcome", () => {
    seed = 66;
    const text = make("words", 1200);
    const streams = [
      z.deflate(text),
      zlib.deflateSync(text, { level: 0 }),
      zlib.deflateSync(text, { level: 1 }),
      zlib.deflateSync(text, { strategy: zlib.constants.Z_FIXED }),
      zlib.deflateSync(make("random", 300)),
      zlib.deflateSync(make("mixed", 5000)),
      zlib.deflateSync(Buffer.alloc(0)),
    ];
    let rows = 0;
    for (const [si, st] of streams.entries()) {
      for (let cut = 0; cut <= st.length; cut++) {
        const input = st.subarray(0, cut);
        expect(outcome(z.inflate(input)), `stream ${si} cut at ${cut}`).toBe(outcome(nodeInflate(input)));
        rows++;
      }
    }
    expect(rows).toBeGreaterThan(3000);
  }, 120000);

  test("Z-ERR-03 seeded mutation fuzz of valid streams answers Node's outcome", () => {
    seed = 77;
    const C = zlib.constants;
    const sources = [make("words", 40), make("words", 3000), make("mixed", 20000), make("random", 2000), make("json", 9000), make("zeros", 70000)];
    const streams: Buffer[] = [];
    for (const s of sources) {
      for (const level of [0, 1, 6, 9]) streams.push(zlib.deflateSync(s, { level }));
      streams.push(zlib.deflateSync(s, { strategy: C.Z_FIXED }));
      streams.push(zlib.deflateSync(s, { strategy: C.Z_HUFFMAN_ONLY }));
      streams.push(zlib.deflateSync(s, { windowBits: 9 }));
    }
    const hist = new Map<string, number>();
    for (const [si, st] of streams.entries()) {
      for (let k = 0; k < 150; k++) {
        const m = Buffer.from(st);
        const kind = rnd(4);
        const at = rnd(m.length);
        if (kind === 0) m[at] = m[at]! ^ (1 << rnd(8));
        else if (kind === 1) m[at] = rnd(256);
        else if (kind === 2) for (let j = 0; j < 4; j++) m[rnd(m.length)] = rnd(256);
        else {
          const h = Math.min(m.length - 1, 2 + rnd(8));
          m[h] = m[h]! ^ (1 << rnd(8));
        }
        const ours = outcome(z.inflate(m));
        expect(ours, `stream ${si} mutation ${k}`).toBe(outcome(nodeInflate(m)));
        const key = ours.startsWith("ok") ? "ok" : ours;
        hist.set(key, (hist.get(key) ?? 0) + 1);
      }
    }
    // the fuzz reaches the decode-time errors, not only the header's
    for (const m of ["invalid distance too far back", "invalid literal/lengths set", "invalid code lengths set", "incorrect data check", "unexpected end of file"]) {
      expect([...hist.keys()].some((k) => k.includes(m)), m).toBe(true);
    }
  }, 120000);
});
