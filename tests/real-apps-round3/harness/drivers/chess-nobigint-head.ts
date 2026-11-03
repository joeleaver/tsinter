// tsinter trial patch (category `bigint`): 32-bit xorshift Zobrist keys in place of
// chess.js's 64-bit bigint xoroshiro128** generator. Every `bigint` in chess.ts becomes
// `number` and `0n` becomes `0`; the keys only feed the repetition hash.
let randState = 0x9e3779b9

function rand(): number {
  let x = randState
  x ^= x << 13
  x ^= x >>> 17
  x ^= x << 5
  randState = x >>> 0
  return randState
}
