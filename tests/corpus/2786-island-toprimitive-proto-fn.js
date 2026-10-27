// @dynamic
// Board #251 (review H1): ToPrimitive on an island operand finds valueOf /
// toString on the object's PROTOTYPE chain (Object.create over an island
// prototype), through an accessor, and on a FUNCTION's own properties —
// for the binary operators and the unary ones alike.
"use strict";
const grab = (...args) => args[0];

const viaProto = Object.create(grab({ valueOf() { return 5; } }));
console.log(`${viaProto + 1}`, `${viaProto * 2}`, `${viaProto < 6}`, `${-viaProto}`);

const strProto = Object.create(grab({ toString() { return "Q"; } }));
console.log(`${strProto + 1}`, `${strProto * 2}`);

const deep = Object.create(Object.create(grab({ valueOf() { return 11; } })));
console.log(`${deep + 1}`, `${+deep}`);

const shadow = Object.create(grab({ valueOf() { return 1; } }));
shadow.valueOf = () => 2;
console.log(`${shadow + 1}`);

const getter = grab({ get valueOf() { return () => 9; } });
console.log(`${getter + 1}`, `${-getter}`);

const fn = grab(function () { return 1; });
fn.valueOf = () => 7;
console.log(`${fn + 1}`, `${fn * 2}`, `${fn < 8}`, `${-fn}`);

const noStr = grab(function () { return 1; });
noStr.toString = undefined;
try {
  console.log(`${noStr + 1}`);
} catch (e) {
  console.log("caught", e.name);
}
const objNoStr = grab({ toString: undefined });
try {
  console.log(`${objNoStr * 1}`);
} catch (e) {
  console.log("caught", e.name);
}
