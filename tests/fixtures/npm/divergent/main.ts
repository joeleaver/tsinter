// @dynamic
// The typed-callback boundary DIVERGENCE (scriptc-only, asserted by
// npm.test.ts — never differential): a package passing an argument the
// callback's declared type refuses converts to a TypeError thrown back
// into the island BEFORE the body runs — trust-but-verify, like every
// dyn→static edge. Node would run the body with the lie; scriptc refuses
// to corrupt a number with a string (SEMANTICS.md).
import { catching } from "typedcb";

const primitive: string = catching((n: number) => {
  console.log("primitive body ran", n);
  return n * 2;
}, "lie");
console.log(primitive);

// (A typed RECORD parameter is refused at compile time since unit H —
// SEMANTICS.md S115; divergent/composite.ts pins it.)
