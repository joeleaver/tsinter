// zlib's compressed BYTES, printed: every lane links (native) or ports
// (wasm) the zlib Node v24.18.1 bundles — Chromium's fork, "1.3.1-e00f703"
// — and drives it as Node does, so deflateSync's output is Node's byte for
// byte. A system zlib differs from it on typical text from about 12
// bytes up (its canonical hash finds other matches). Also: inflate's
// errors with Node's message and code.
import { deflateSync, inflateSync } from "node:zlib";
import { createHash } from "node:crypto";

function show(label: string, input: Buffer): void {
  const d = deflateSync(input);
  const body = d.length <= 96 ? d.toString("hex") : createHash("sha256").update(d).digest("hex");
  const back = inflateSync(d);
  console.log(label, input.length, d.length, body, back.equals(input) ? "rt" : "RT-FAIL");
}

show("empty", Buffer.alloc(0));
show("one", Buffer.from("a"));
show("twelve", Buffer.from("abcabcabdabc"));
show("hello", Buffer.from("hello hello hello hello compression works"));
show("pangram", Buffer.from("The quick brown fox jumps over the lazy dog. The quick brown fox jumps over the lazy cat."));
show("json", Buffer.from(JSON.stringify({ id: 7, name: "user7", tags: ["a", "b", "c"], nested: { ok: true, list: [1, 2, 3, 1, 2, 3] } })));

// a deterministic text of words, at a few sizes either side of the 16 KiB
// output chunk and the 32 KiB window
const WORDS = ["alpha", "beta", "gamma", "delta", "window", "huffman", "tree", "lazy", "match", "the", "of", "\n"];
let seed = 12345;
function rnd(n: number): number {
  seed = (seed * 48271) % 2147483647;
  return seed % n;
}
function words(n: number): Buffer {
  const parts: string[] = [];
  let len = 0;
  while (len < n) {
    const w = WORDS[rnd(WORDS.length)]!;
    parts.push(w);
    len += w.length + 1;
  }
  return Buffer.from(parts.join(" ").slice(0, n));
}
for (const n of [100, 1000, 5000, 20000, 40000, 100000]) show(`words-${n}`, words(n));

// incompressible input: stored blocks sized by the 16 KiB output chunks
const noise = Buffer.alloc(50000);
for (let i = 0; i < noise.length; i++) noise[i] = rnd(256);
show("noise", noise);

// inflate errors: Node's message and code
function attempt(label: string, hex: string): void {
  try {
    const out = inflateSync(Buffer.from(hex, "hex"));
    console.log(label, "ok", out.toString("hex"));
  } catch (e) {
    if (e instanceof Error) console.log(label, e.name, e.message, (e as NodeJS.ErrnoException).code);
  }
}
attempt("bad-header", "00112233");
attempt("truncated", "789ccb48cdc9");
attempt("fdict", "78bb00000001");
attempt("btype3", "789c07");
attempt("bad-adler", "789c4b4c4a0600024d0126");
attempt("good", "789c4b4c4a0600024d0127");
