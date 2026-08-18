// @dynamic
// TWO independent .then() subscriptions on ONE dynamic-import promise —
// the two-independent-observers equivalence nodes.ts:4887 asserts for
// jsBridgePromise ("bridging one engine promise twice makes two
// independent static observers of the same settlement"), pinned directly:
// unlike 2050's double import() (two SEPARATE promises, one per call),
// this program subscribes twice to the SAME stored promise `p`. Node
// evaluates the imported module's %init exactly once ("m-init" prints
// once, not twice) and BOTH handlers fire, each seeing the settled
// namespace, in subscription order.
const p = import("./m.ts");
p.then((ns: any) => { console.log(`a ${ns.v}`); });
p.then((ns: any) => { console.log(`b ${ns.v}`); });
