// M-27's own row (POST-ACK #17): process.umask's validation observed
// through a COMPILED program, not a direct C call — the direct-call cases
// in process-tail-cases.txt could never have reddened the MAY_THROW_LIB_FNS
// gap (delta-3eb 4db75f2c), because the C function itself was always
// correct; only a COMPILED call site skips the pending-exception check
// when its own IrLibFn name is missing from that set. Run on BOTH native
// lanes (llvm default, --backend c) by process-tail.test.ts; expected
// output is read directly from this repo's own committed
// process-tail-cases.txt (the SAME Node-measured "umask-invalid" rows for
// masks 1.5 and -1), never a second hand-typed copy.
try {
  process.umask(1.5);
  console.log("no-throw");
} catch (e) {
  if (e instanceof RangeError) console.log("caught:", e.message);
}
try {
  process.umask(-1);
  console.log("no-throw2");
} catch (e) {
  if (e instanceof RangeError) console.log("caught2:", e.message);
}
