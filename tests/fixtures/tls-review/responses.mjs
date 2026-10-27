/* Malformed and edge-case HTTP/1 responses for the wasm-native lane's
 * fetch (tests/harness/wasmnative-host-rows.test.ts, the security
 * re-review rows): each is served as is, and the lane's fetch must accept
 * or refuse it exactly as Node's (undici's parser over undici's llhttp).
 * R holds the re-review kit's cases; gen(i) is its deterministic mutation
 * fuzzer over them (insertions of the tokens llhttp is picky about,
 * deletions, byte flips, truncations, concatenations). */
const H = "HTTP/1.1 200 OK\r\n";
export const R = {
  p01: H + "X-A: a\x7fb\r\ncontent-length: 2\r\n\r\nok",
  p02: H + "content-length: 9223372036854775808\r\n\r\nhi",
  p03: H + "content-length: 18446744073709551615\r\n\r\nhi",
  p04: H + "transfer-encoding: chunked\r\n\r\n5;a\rb\r\nhello\r\n0\r\n\r\n",
  p05: H + "transfer-encoding: chunked\r\n\r\n5;a\x00b\r\nhello\r\n0\r\n\r\n",
  p06: H + "transfer-encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\nX: y\n\r\n",
  p07: H + "transfer-encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\nX y\x00: z\r\n\r\n",
  p08: H + "transfer-encoding: chunked\r\n\r\n5 \r\nhello\r\n0\r\n\r\n",
  p09: H + "transfer-encoding: chunked\r\n\r\n 5\r\nhello\r\n0\r\n\r\n",
  p10: H + "transfer-encoding: chunked\r\ntransfer-encoding: gzip\r\n\r\n5\r\nhello\r\n0\r\n\r\n",
  p11: H + "transfer-encoding: chunked, gzip\r\n\r\n5\r\nhello\r\n0\r\n\r\n",
  p12: H + "transfer-encoding: gzip, chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n",
  p13: H + "transfer-encoding: chunked\r\ncontent-length: 5\r\n\r\n5\r\nhello\r\n0\r\n\r\n",
  p14: "HTTP/1.0 200 OK\r\nx: y\r\n\r\nclose-delimited",
  p15: "HTTP/1.1 101 Switching\r\nupgrade: x\r\nconnection: upgrade\r\n\r\nraw",
  p16: "HTTP/1.1 204 NC\r\ncontent-length: 5\r\n\r\nhello",
  p17: "HTTP/1.1 304 NM\r\ncontent-length: 5\r\n\r\nhello",
  p18: "HTTP/1.1 100 Continue\r\n\r\n" + H + "content-length: 2\r\n\r\nok",
  p19: H + "X-A: a\r\n  folded\r\ncontent-length: 2\r\n\r\nok",
  p20: H + "X-A : a\r\ncontent-length: 2\r\n\r\nok",
  p21: H + "X-A: a\x00b\r\ncontent-length: 2\r\n\r\nok",
  p22: H + "X-A: a\rb\r\ncontent-length: 2\r\n\r\nok",
  p23: "HTTP/1.1 200 OK\nX-A: a\ncontent-length: 2\n\nok",
  p24: "\r\n" + H + "content-length: 2\r\n\r\nok",
  p25: "HTTP/2.0 200 OK\r\ncontent-length: 2\r\n\r\nok",
  p26: "HTTP/1.1 200 O\x00K\r\ncontent-length: 2\r\n\r\nok",
  p27: H + "transfer-encoding: chunked\r\n\r\nfffffffffffffffff\r\nhello",
  p28: H + "transfer-encoding: chunked\r\n\r\nffffffffffffffff\r\nhello",
  p29: H + "X-A: \xe9\xff\x80\r\ncontent-length: 2\r\n\r\nok",
  p30: H + "content-length: +2\r\n\r\nok",
  p31: H + "content-length: 2, 2\r\n\r\nok",
  p32: H + ": x\r\ncontent-length: 2\r\n\r\nok",
  p33: H + "transfer-encoding: chunked\r\n\r\n5\r\nhelloXX0\r\n\r\n",
  p34: H + "content-length: \t2 \r\n\r\nok",
  p35: H + "X-A:\tv\t \r\ncontent-length: 2\r\n\r\nok",
  p36: "HTTP/1.1 200\r\ncontent-length: 2\r\n\r\nok",
  p37: "HTTP/1.1 099 X\r\ncontent-length: 2\r\n\r\nok",
  p38: "http/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok",
  p39: "HTTP/1.1  200 OK\r\ncontent-length: 2\r\n\r\nok",
  p40: H + "transfer-encoding: chunked\r\n\r\n2\r\nok\r\n0\r\n\r\nGARBAGE",
  p41: H + "transfer-encoding: chunked\r\n\r\n2;ext=\"q\r\nx\"\r\nok\r\n0\r\n\r\n",
  p42: H + "transfer-encoding: chunked\r\n\r\n2;e=v\r\nok\r\n0;x\r\nT: v\r\n\r\n",
  p43: H + "transfer-encoding: xchunked\r\n\r\n2\r\nok\r\n0\r\n\r\n",
  p44: H + "transfer-encoding: Chunked \r\n\r\n2\r\nok\r\n0\r\n\r\n",
  p45: "HTTP/1.1 200 OK\r\r\ncontent-length: 2\r\n\r\nok",
  p46: H + "content-length: 2\r\n\r\nokEXTRA",
  p47: H + "content-length: 5\r\n\r\nok",
  p48: H + "x-a: " + "a".repeat(16370) + "\r\ncontent-length: 2\r\n\r\nok",
  p49: "HTTP/1.1 200 " + "R".repeat(200000) + "\r\ncontent-length: 2\r\n\r\nok",
  p50: H + "transfer-encoding: chunked\r\n\r\n2\r\nok\r\n0\r\n" + "t: v\r\n".repeat(5000) + "\r\n",
  p51: H + "transfer-encoding: chunked\r\n\r\n2\r\nok\r\n0\r\n\x01bad\r\n\r\n",
  p52: H + "transfer-encoding: chunked\r\n\r\n2\r\nok\r\n0", 
  p53: "HTTP/1.1 200 OK\r\nX-\x80: 1\r\ncontent-length: 2\r\n\r\nok",
  p54: "HTTP/1.1 1000 X\r\ncontent-length: 2\r\n\r\nok",
  p55: "HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok\r\n\r\n",
  p56: "HTTP/1.1 103 Early\r\nlink: x\r\n\r\nHTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok",
  p57: "HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\ntransfer-encoding: chunked\r\n\r\n2\r\nok\r\n0\r\n\r\n",
  p58: "HTTP/1.1 200 OK\r\ncontent-length: 2\r\ncontent-length: 2\r\n\r\nok",
  p59: "HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\n2\rok\r\n0\r\n\r\n",
  p60: "HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\n2\r\nok\n0\r\n\r\n",
};

const base = Object.values(R).map((s) => Buffer.from(s, "latin1"));
function rnd(seed) {
  let s = seed >>> 0 || 1;
  return () => (s = (s * 1103515245 + 12345) >>> 0) / 4294967296;
}
const toks = ["\r", "\n", "\r\n", "\x00", " ", "\t", ":", ";", "=", "\"", "0", "f", "ffffffff", "-", "chunked", "content-length: 3\r\n", "transfer-encoding: chunked\r\n", "connection: close\r\n", "upgrade: x\r\n", "\xff", "\x7f", "HTTP/1.1 100 C\r\n\r\n", "HTTP/1.1 103 E\r\nlink: x\r\n\r\n"];
/** the i-th fuzz case */
export function gen(i) {
  const r = rnd(i * 7919 + 13);
  let b = Buffer.from(base[Math.floor(r() * base.length)]);
  if (b.length > 4000) b = b.subarray(0, 4000);
  const n = 1 + Math.floor(r() * 4);
  for (let k = 0; k < n; k++) {
    const pos = Math.floor(r() * (b.length + 1));
    const op = r();
    if (op < 0.3) b = Buffer.concat([b.subarray(0, pos), b.subarray(pos + 1)]);
    else if (op < 0.6) b = Buffer.concat([b.subarray(0, pos), Buffer.from(toks[Math.floor(r() * toks.length)], "latin1"), b.subarray(pos)]);
    else if (op < 0.8 && pos < b.length) {
      b = Buffer.from(b);
      b[pos] = Math.floor(r() * 256);
    } else if (op < 0.92) b = b.subarray(0, pos);
    else if (b.length < 2000) b = Buffer.concat([b, base[Math.floor(r() * base.length)].subarray(0, 2000)]);
  }
  return b;
}
