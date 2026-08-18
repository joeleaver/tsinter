// @dynamic
// Dynamic import() of a SYNCHRONOUS (non-async) own module whose top-level
// body throws: distinct from 2660's cycle-rejection shape (whose thrown
// module is ASYNC, so the rejection surfaces through the import bridge's
// PROMISE-ADOPTION path). Here the builder's run-once %init call itself
// throws SYNCHRONOUSLY — no await anywhere in the imported module — so
// the bridge's `.then(builder)` handler call is what raises the pending
// exception, exercising the OTHER half of the bridge (increment 21 stage
// C's "the handler threw" absorption, turning a synchronous throw inside
// the builder call into the bridged promise's own rejection). `import()`
// never throws synchronously even so — evaluation failure always rejects
// the returned promise, so this is a plain catchable `await`.
console.log("before");
try {
  await import("./boom.ts");
  console.log("no throw");
} catch (e) {
  console.log("caught", String(e));
}
console.log("after");

export {};
