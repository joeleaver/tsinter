// zlib unit: deflateSync's bytes over generated inputs at the boundary
// sizes (0, 1, MIN_MATCH, MAX_MATCH, the 16 KiB symbol buffer and output
// chunk, the 32 KiB window and MAX_DIST, 64 KiB, past 1 MiB), each kind of
// data (incompressible, text, repetitive, low-entropy, structured); small
// outputs print in full, large ones as their sha256. Every round trip is
// checked. Node is the oracle for every line (wasm-zlib.test.ts runs both).
import { deflateSync, inflateSync } from "node:zlib";
import { createHash } from "node:crypto";

let seed = 20261026;
function rnd(n: number): number {
  seed = (seed * 48271) % 2147483647;
  return seed % n;
}
const WORDS = ["the", "quick", "brown", "fox", "jumps", "over", "lazy", "dog", "zlib", "deflate", "window", "huffman", "tree", "\n"];

function make(kind: string, n: number): Buffer {
  const b = Buffer.alloc(n);
  if (kind === "random") {
    for (let i = 0; i < n; i++) b[i] = rnd(256);
  } else if (kind === "words") {
    let i = 0;
    while (i < n) {
      const w = WORDS[rnd(WORDS.length)]!;
      for (let j = 0; j < w.length && i < n; j++) b[i++] = w.charCodeAt(j);
      if (i < n) b[i++] = 32;
    }
  } else if (kind === "zeros") {
    // Buffer.alloc's zeros
  } else if (kind === "period7") {
    for (let i = 0; i < n; i++) b[i] = 97 + (i % 7);
  } else if (kind === "lowent") {
    for (let i = 0; i < n; i++) b[i] = rnd(4) === 0 ? 98 : 97;
  } else if (kind === "ramp") {
    for (let i = 0; i < n; i++) b[i] = i % 251;
  } else if (kind === "json") {
    let i = 0;
    let k = 0;
    while (i < n) {
      const s = `{"id":${k},"name":"user${rnd(1000)}","ok":${rnd(2) === 0}},`;
      for (let j = 0; j < s.length && i < n; j++) b[i++] = s.charCodeAt(j);
      k++;
    }
  } else {
    // mixed: runs of random bytes between repeated words
    let i = 0;
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
  }
  return b;
}

function show(label: string, input: Buffer): void {
  const d = deflateSync(input);
  const body = d.length <= 96 ? d.toString("hex") : createHash("sha256").update(d).digest("hex");
  const back = inflateSync(d);
  const rt = back.length === input.length && createHash("sha256").update(back).digest("hex") === createHash("sha256").update(input).digest("hex");
  console.log(label, input.length, d.length, body, rt ? "rt" : "RT-FAIL");
}

const SMALL = [0, 1, 2, 3, 4, 12, 100, 257, 258, 259, 262, 263, 1000];
const MID = [16383, 16384, 16385, 32506, 32767, 32768, 32769, 65535, 65536, 65537];
const KINDS = ["random", "words", "zeros", "period7", "lowent", "ramp", "json", "mixed"];
for (const kind of KINDS) {
  for (const n of SMALL) show(`${kind}`, make(kind, n));
  for (const n of MID) show(`${kind}`, make(kind, n));
}
for (const kind of ["random", "words", "zeros", "lowent", "mixed"]) show(`${kind}-big`, make(kind, 300007));
show("words-1m", make("words", (1 << 20) + 7));
show("zeros-1m", make("zeros", (1 << 20) + 7));
// a view with a nonzero offset
const whole = make("words", 5000);
show("subarray", whole.subarray(17, 4017));
// fuzzed lengths
for (let k = 0; k < 40; k++) {
  const kind = KINDS[rnd(KINDS.length)]!;
  const n = rnd(3) === 0 ? rnd(70000) : rnd(2000);
  show(`fuzz-${kind}`, make(kind, n));
}
