// zlib unit: inflateSync over Node v24.18.1-produced streams (levels 0-9,
// Z_FIXED, Z_HUFFMAN_ONLY, Z_RLE at memLevel 1, windowBits 9, Z_FILTERED at
// memLevel 9), one hand-built input per zlib error (every message inflate
// can raise, plus Node's "Missing dictionary" and "unexpected end of file"),
// every truncation of several streams, a byte flip at every offset of one,
// and seeded mutation fuzz. Each line prints the outcome: the output's
// length and sha256 prefix, or the thrown Error's name, message and code.
// Node is the oracle for every line, on every lane (zlib-lanes.test.ts runs
// Node, wasm, c and llvm); the data below was generated once with Node's own
// zlib and a bit writer.
import { deflateSync, inflateSync } from "node:zlib";
import { createHash } from "node:crypto";

const ROWS: [string, string][] = [
  ["too-far", "789c03020000"],
  ["bad-dist-code", "789c4b043e0000"],
  ["bad-litlen-code", "789c4b1c030000"],
  ["far-after-one", "789c4b04120000"],
  ["too-many-syms", "789cf500000000"],
  ["too-many-dists", "789c051e000000"],
  ["cl-incomplete", "789c050000040000"],
  ["cl-oversub", "789c050092040000"],
  ["repeat-first", "789c050002240000"],
  ["no-eob", "789c0500020400000000000000000000000000000000000000000000000000000000000000000000"],
  ["repeat-overflow", "789c050002c4ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff0000"],
  ["litlen-oversub", "789c05c0010400000000900100000000000000000000000000000000000000000000000000000000000080010000"],
  ["dist-oversub", "789c05c2010400000000900000000000000000000000000000000000000000000000000000000000000080070000"],
  ["empty", ""],
  ["one-byte", "78"],
  ["header-only", "789c"],
  ["no-final", "789c03"],
  ["bad-header", "00112233"],
  ["gzip", "1f8b08000000000000ff"],
  ["raw", "cb48cdc9c90700"],
  ["btype3", "789c07"],
  ["stored-len", "789c0105000000"],
  ["fdict", "78bb00000001"],
  ["fdict-short", "78bb0000"],
  ["empty-ok", "789c030000000001"],
  ["trailing", "789c03000000000178787878"],
  ["cmf-7", "0706030000000001"],
  ["cmf-77", "7709030000000001"],
  ["cmf-88", "881c030000000001"],
  ["cmf-f8", "f800030000000001"],
  ["bad-adler", "789ccb48cdc9c957c8c02093f3730b8a528b8b33f3f314caf38bb28b0146580fd8"],
];
const STREAMS: [string, string][] = [
  [
    "level0",
    "780101a0025ffd4c6f72656d20697073756d20646f6c6f722073697420616d65742c20636f6e73656374657475722061" +
      "646970697363696e6720656c69742c2073656420646f20656975736d6f642074656d706f7220696e6369646964756e74" +
      "207574206c61626f726520657420646f6c6f7265206d61676e6120616c697175612e204c6f72656d20697073756d2064" +
      "6f6c6f722073697420616d65742c20636f6e73656374657475722061646970697363696e6720656c69742c2073656420" +
      "646f20656975736d6f642074656d706f7220696e6369646964756e74207574206c61626f726520657420646f6c6f7265" +
      "206d61676e6120616c697175612e204c6f72656d20697073756d20646f6c6f722073697420616d65742c20636f6e7365" +
      "6374657475722061646970697363696e6720656c69742c2073656420646f20656975736d6f642074656d706f7220696e" +
      "6369646964756e74207574206c61626f726520657420646f6c6f7265206d61676e6120616c697175612e2021466b365b" +
      "264b703b602b5075406530557a456a355a254a6f3a5f2a4f743f642f54794469345924496e395e294e733e632e537843" +
      "68335823486d385d284d723d622d52774267325722476c375c274c713c612c51764166315621466b365b264b703b602b" +
      "5075406530557a456a355a254a6f3a5f2a4f743f642f54794469345924496e395e294e733e632e53784368335823486d" +
      "385d284d723d622d52774267325722476c375c274c713c612c51764166315621466b365b264b703b602b507540653055" +
      "7a456a355a254a6f3a5f2a4f743f642f54794469345924496e395e294e733e632e53784368335823486d385d284d723d" +
      "622d52774267325722476c375c274c713c612c51764166315621466b365b264b703b602b5075406530557a456a355a25" +
      "4a6f3a5f2a4f74f9a2e3c5",
  ],
  [
    "level1",
    "7801e5cd554204311005c0ab3cdc86c5dddd0677279b3443436436e960a7e7835bc005aaca10c981eb941d4cb02122b1" +
      "403992023af8445a487284325c73d2ec2b90652990c8c00410e7e4828190ab43047bcd864df6822cb0aa192281e49726" +
      "3855790565b9955503e53fbddb36df266fbbf7eab9a781a3bc4cc3e7df1baf13375dbb61f6b1ff5096ccd0d9d73a8f5f" +
      "77eef89987be83b4a81ba79f6b2f63571ddb6efabe773f2e34074f3e56abd1cbf62d3b75d753b6e65571fcbef23c72f1" +
      "f7e41ff9a2e3c5",
  ],
  [
    "level2",
    "785ee5cd554204311005c0ab3cdc86c5dddd0677279b3443436436e960a7e7835bc005aaca10c981eb941d4cb02122b1" +
      "403992023af8445a487284325c73d2ec2b90652990c8c00410e7e4828190ab43047bcd864df6822cb0aa192281e49726" +
      "3855790565b9955503e53fbddb36df266fbbf7eab9a781a3bc4cc3e7df1baf13375dbb61f6b1ff5096ccd0d9d73a8f5f" +
      "77eef89987be83b4a81ba79f6b2f63571ddb6efabe773f2e34074f3e56abd1cbf62d3b75d753b6e65571fcbef23c72f1" +
      "f7e41ff9a2e3c5",
  ],
  [
    "level3",
    "785ee5cd554204311005c0ab3cdc86c5dddd0677279b3443436436e960a7e7835bc005aaca10c981eb941d4cb02122b1" +
      "403992023af8445a487284325c73d2ec2b90652990c8c00410e7e4828190ab43047bcd864df6822cb0aa192281e49726" +
      "3855790565b9955503e53fbddb36df266fbbf7eab9a781a3bc4cc3e7df1baf13375dbb61f6b1ff5096ccd0d9d73a8f5f" +
      "77eef89987be83b4a81ba79f6b2f63571ddb6efabe773f2e34074f3e56abd1cbf62d3b75d753b6e65571fcbef23c72f1" +
      "f7e41ff9a2e3c5",
  ],
  [
    "level4",
    "785ee5cd554204311005c0ab3cdc86c5dddd0677279b3443436436e960a7e7835bc005aaca10c981eb941d4cb02122b1" +
      "403992023af8445a487284325c73d2ec2b90652990c8c00410e7e4828190ab43047bcd864df6822cb0aa192281e49726" +
      "3855790565b9955503e53fbddb36df266fbbf7eab9a781a3bc4cc3e7df1baf13375dbb61f6b1ff5096ccd0d9d73a8f5f" +
      "77eef89987be83b4a81ba79f6b2f63571ddb6efabe773f2e34074f3e56abd1cbf62d3b75d753b6e65571fcbef23c72f1" +
      "f7e41ff9a2e3c5",
  ],
  [
    "level5",
    "785ee5cd554204311005c0ab3cdc86c5dddd0677279b3443436436e960a7e7835bc005aaca10c981eb941d4cb02122b1" +
      "403992023af8445a487284325c73d2ec2b90652990c8c00410e7e4828190ab43047bcd864df6822cb0aa192281e49726" +
      "3855790565b9955503e53fbddb36df266fbbf7eab9a781a3bc4cc3e7df1baf13375dbb61f6b1ff5096ccd0d9d73a8f5f" +
      "77eef89987be83b4a81ba79f6b2f63571ddb6efabe773f2e34074f3e56abd1cbf62d3b75d753b6e65571fcbef23c72f1" +
      "f7e41ff9a2e3c5",
  ],
  [
    "level6",
    "789ce5cd554204311005c0ab3cdc86c5dddd0677279b3443436436e960a7e7835bc005aaca10c981eb941d4cb02122b1" +
      "403992023af8445a487284325c73d2ec2b90652990c8c00410e7e4828190ab43047bcd864df6822cb0aa192281e49726" +
      "3855790565b9955503e53fbddb36df266fbbf7eab9a781a3bc4cc3e7df1baf13375dbb61f6b1ff5096ccd0d9d73a8f5f" +
      "77eef89987be83b4a81ba79f6b2f63571ddb6efabe773f2e34074f3e56abd1cbf62d3b75d753b6e65571fcbef23c72f1" +
      "f7e41ff9a2e3c5",
  ],
  [
    "level7",
    "78dae5cd554204311005c0ab3cdc86c5dddd0677279b3443436436e960a7e7835bc005aaca10c981eb941d4cb02122b1" +
      "403992023af8445a487284325c73d2ec2b90652990c8c00410e7e4828190ab43047bcd864df6822cb0aa192281e49726" +
      "3855790565b9955503e53fbddb36df266fbbf7eab9a781a3bc4cc3e7df1baf13375dbb61f6b1ff5096ccd0d9d73a8f5f" +
      "77eef89987be83b4a81ba79f6b2f63571ddb6efabe773f2e34074f3e56abd1cbf62d3b75d753b6e65571fcbef23c72f1" +
      "f7e41ff9a2e3c5",
  ],
  [
    "level8",
    "78dae5cd554204311005c0ab3cdc86c5dddd0677279b3443436436e960a7e7835bc005aaca10c981eb941d4cb02122b1" +
      "403992023af8445a487284325c73d2ec2b90652990c8c00410e7e4828190ab43047bcd864df6822cb0aa192281e49726" +
      "3855790565b9955503e53fbddb36df266fbbf7eab9a781a3bc4cc3e7df1baf13375dbb61f6b1ff5096ccd0d9d73a8f5f" +
      "77eef89987be83b4a81ba79f6b2f63571ddb6efabe773f2e34074f3e56abd1cbf62d3b75d753b6e65571fcbef23c72f1" +
      "f7e41ff9a2e3c5",
  ],
  [
    "level9",
    "78dae5cd554204311005c0ab3cdc86c5dddd0677279b3443436436e960a7e7835bc005aaca10c981eb941d4cb02122b1" +
      "403992023af8445a487284325c73d2ec2b90652990c8c00410e7e4828190ab43047bcd864df6822cb0aa192281e49726" +
      "3855790565b9955503e53fbddb36df266fbbf7eab9a781a3bc4cc3e7df1baf13375dbb61f6b1ff5096ccd0d9d73a8f5f" +
      "77eef89987be83b4a81ba79f6b2f63571ddb6efabe773f2e34074f3e56abd1cbf62d3b75d753b6e65571fcbef23c72f1" +
      "f7e41ff9a2e3c5",
  ],
  [
    "fixed",
    "7801f3c92f4acd55c82c282ecd5548c9cfc92f5228ce2c5148cc4d2dd15148cecf2b4e4d2e492d292d52484cc92cc82c" +
      "4ececc4b5748cdc92cd151284e4d5148c95748cd2c2dcecd4f512849cd2dc82f52c8cc4bce4cc94c29cd2b51282d51c8" +
      "494cca2f4a55482d81189daa909b989e97a890989359589aa8a7e03342ed5674cb368b56f32eb04ed00e2875483508ad" +
      "72cd328d52f5cab78ad7f22fb14fd10fa974c9348954f1ccb38cd3f42bb64bd60bae70ce308e50f6c8b588d5f02db24d" +
      "d20d2a774a370a5772cf318f51f729b449d4092c734c330c1b7e260300f9a2e3c5",
  ],
  [
    "huffman",
    "780105c1894241411400d05fb92a2a5ed242458b162a142d5aa8186f6eafcbccdc6796165fdf391db6a8815217344856" +
      "6cc19107a1d14710b371187bf4c1829094928bc924808a7c040e254806a4e0344bf0a853b64026264932180fc1831213" +
      "b608e841b2628ba04562040845f3208ad0618b1a2875418364c5161c79101a7d04311b87b1471f2c084929b9984c02a8" +
      "c847e0508264400a4eb3048f3a650b6462922483f1103c2831618b801e242bb6085a24468050340fa2081db6a8815217" +
      "3448566cc19107a1d14710b371187bf4c1829094928bc924808a7c040e254806a4e0344bf0a853b64026264932180fc1" +
      "831213b608e841b2628ba04562040845f3208a9069ce2ac35c3bad8d0bbd50c7527fd1989607d9165747f9ae3f919b8f" +
      "7f17b4fbba726d0e3ed66fdd715c7cf83dffda7959bed2fbef6b37f668b271ff73966c3f2f5daabdb7d5cefc504477df" +
      "a79f5b4f99e6ac32ccb5d3dab8d00b752cf5178d6979906d717594effa13b9f9f87741bbaf2bd7e6e063fdd61dc7c587" +
      "dff3af9d97e52bbdffbe76638f261bf73f67c9f6f3d2a5da7b5bedcc0f4574f77dfab9f59469ce2ac35c3bad8d0bbd50" +
      "c7527fd1989607d9165747f9ae3f919b8f7f17b4fbba726d0e3ed66fdd715c7cf83dffda7959bed2fbef6b37f668b271" +
      "ff73966c3f2f5daabdb7d5cefc504477dfa79f5b4f99e6ac32ccb5d3dab8d00b752cf5178d6979906d717594effa7ff9" +
      "a2e3c5",
  ],
  [
    "rle-mem1",
    "780104c1890dc3400804c056b6002b95b80972206ba5e37078facfcc1d690ebe350e8d1d896243dcfac28a53b6da7a12" +
      "a27c598be7816df6853285068c531e8a367f23c1b3a8d4398d696cf9461aaca1b1230d2ecf11c8e66fe4833bf24f109c" +
      "d8300c8440006c650bb052499a20c7ca423a0e9ba7ffccd0614f8d436347a2ac21cebeb0e21457b327216a8fd5b27383" +
      "dbfa4251a101da9487a2e94f24ec2c53d3398d696cf945126c68ec48c2e53e02d9f68e7cf08da4e34f101ce32010c340" +
      "00fccad2509d2869e86978029589add38a240eb1fd7f66b8a206d4bb6f0413322c0f349f612d2d6b43948bd1384f5867" +
      "1e0853a8c358315c9136966f70362ab566a2125d3ebe0d9650efbe0d43ce2990ce5fc90d97e7f7febebed6e3af04ed80" +
      "52875483d02ad72cd32855af7cab782dff12fb14fd904a974c934815cf3ccb384dbf62bb64bde00ae70ce308658f5c8b" +
      "580ddf22db24dda072a774a37025f71cf318759f429b449dc032c734c33045b76cb36835ef02eb04ed8052875483d02a" +
      "d72cd32855af7cab782dff12fb14fd904a974c934815cf3ccb384d3f808aed92f5822b9c338c23943d722d62357c8b6c" +
      "937483ca9dd28dc295dc73cc63d47d0a6d127502cb1cd30cc314ddb2cda2d5bc0bac13b4034a1d520d42ab5cb34ca354" +
      "bdf2ade2b5fc4bec53f4432a5d324d22553cf32ce334fd8aed92f5822b9c338c23943d722d62357c8b6c937483ca9dd2" +
      "8dc295dc73cc63d47d0a6d1201d3092c734c330c5374cb368b56f32eb04ed00e2875483508ad72cd328d52f5cab78ad7" +
      "f22f0100f9a2e3c5",
  ],
  [
    "wbits9",
    "1895e5cd554204311005c0ab3cdc86c5dddd0677279b3443436436e960a7e7835bc005aaca10c981eb941d4cb02122b1" +
      "403992023af8445a487284325c73d2ec2b90652990c8c00410e7e4828190ab43047bcd864df6822cb0aa192281e49726" +
      "3855790565b9955503e53fbddb36df266fbbf7eab9a781a3bc4cc3e7df1baf13375dbb61f6b1ff5096ccd0d9d73a8f5f" +
      "77eef89987be83b4a81ba79f6b2f63571ddb6efabe773f2e34074f3e56abd1cbf62d3b75d753b6e65571fcbef23c72f1" +
      "f7e41ff9a2e3c5",
  ],
  [
    "filtered-mem9",
    "789ce5cd554204311005c0ab3cdc86c5dddd0677279b3443436436e960a7e7835bc005aaca10c981eb941d4cb02122b1" +
      "403992023af8445a487284325c73d2ec2b90652990c8c00410e7e4828190ab43047bcd864df6822cb0aa192281e49726" +
      "3855790565b9955503e53fbddb36df266fbbf7eab9a781a3bc4cc3e7df1baf13375dbb61f6b1ff5096ccd0d9d73a8f5f" +
      "77eef89987be83b4a81ba79f6b2f63571ddb6efabe773f2e34074f3e56abd1cbf62d3b75d753b6e65571fcbef23c72f1" +
      "f7e41ff9a2e3c5",
  ],
];
const TEXT = "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. !Fk6[&Kp;`+Pu@e0UzEj5Z%Jo:_*Ot?d/TyDi4Y$In9^)Ns>c.SxCh3X#Hm8](Mr=b-RwBg2W\"Gl7\\'Lq<a,QvAf1V!Fk6[&Kp;`+Pu@e0UzEj5Z%Jo:_*Ot?d/TyDi4Y$In9^)Ns>c.SxCh3X#Hm8](Mr=b-RwBg2W\"Gl7\\'Lq<a,QvAf1V!Fk6[&Kp;`+Pu@e0UzEj5Z%Jo:_*Ot?d/TyDi4Y$In9^)Ns>c.SxCh3X#Hm8](Mr=b-RwBg2W\"Gl7\\'Lq<a,QvAf1V!Fk6[&Kp;`+Pu@e0UzEj5Z%Jo:_*Ot";

function attempt(label: string, input: Buffer): void {
  try {
    const out = inflateSync(input);
    console.log(label, "ok", out.length, createHash("sha256").update(out).digest("hex").slice(0, 16));
  } catch (e) {
    if (e instanceof Error) console.log(label, "err", e.name, e.message, (e as NodeJS.ErrnoException).code);
  }
}

for (const [label, hex] of ROWS) attempt(label, Buffer.from(hex, "hex"));
const SWEEP = new Set(["level0", "level1", "level6", "level9", "fixed", "huffman"]);
for (const [label, hex] of STREAMS) {
  const b = Buffer.from(hex, "hex");
  attempt(label, b);
  if (SWEEP.has(label)) for (let cut = 0; cut < b.length; cut++) attempt(`${label}@${cut}`, b.subarray(0, cut));
}
// this tier's own deflate output, truncated everywhere
const ours = deflateSync(Buffer.from(TEXT));
attempt("ours", ours);
for (let cut = 0; cut < ours.length; cut++) attempt(`ours@${cut}`, ours.subarray(0, cut));
// one byte flipped at every offset of the level-6 stream
const l6 = Buffer.from(STREAMS[6]![1], "hex");
for (let i = 0; i < l6.length; i++) {
  const m = Buffer.from(l6);
  m[i] = m[i]! ^ (1 << (i % 8));
  attempt(`flip@${i}`, m);
}
// seeded mutation fuzz of every stream above and of deflateSync's own
// output (one byte, four bytes, or a byte near the header changed): the
// decode-time errors past the header
let seed = 20261026;
function rnd(n: number): number {
  seed = (seed * 48271) % 2147483647;
  return seed % n;
}
const fuzzSources: [string, Buffer][] = [];
for (const [label, hex] of STREAMS) fuzzSources.push([label, Buffer.from(hex, "hex")]);
fuzzSources.push(["ours", ours]);
const words: string[] = [];
const VOCAB = ["deflate", "inflate", "window", "tree", "code", "length", "\n"];
for (let i = 0; i < 2500; i++) words.push(VOCAB[rnd(VOCAB.length)]!);
fuzzSources.push(["ours-words", deflateSync(Buffer.from(words.join(" ")))]);
for (const [label, st] of fuzzSources) {
  for (let k = 0; k < 40; k++) {
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
    attempt(`mut-${label}-${k}`, m);
  }
}
