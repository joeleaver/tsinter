// SC2009: supported shapes over a component type outside its slot — the
// container is not the blocker, and each message names the component.

// Map keys may be anything but a generator (no SameValueZero story).
const byFlag = new Map<Generator<number>, string>();
console.log(byFlag);

// Map values have no slot for dynamic values.
const listeners = new Map<string, unknown>();
console.log(listeners);

// Set elements may be anything but a generator.
const flags = new Set<Generator<number>>();
console.log(flags);

// Arrays cannot hold Map elements yet.
const rows: Map<string, number>[] = [];
console.log(rows);

// A Map arm beside a data arm has no home in a compiled union (beside
// undefined/null it does).
function report(maybe: Map<string, number> | string): number {
  return typeof maybe === "string" ? 0 : maybe.size;
}
console.log(report("none"));

// A rest parameter has no compiled calling convention.
const sum = (...xs: number[]): number => xs.length;
const storedSum = sum;
console.log(storedSum(1, 2));

// A function's return type carries the failure. The value arrives through
// a cast, not an ambient declare (a declare-rooted chain would compile to
// Node's ReferenceError at the root instead).
const makeWeak = (0 as unknown) as () => WeakMap<object, unknown>;
const storedMake = makeWeak;
console.log(storedMake());

// A record member's type carries the failure.
interface Holder {
  label: string;
  cache: WeakMap<object, unknown>;
}
const held = (0 as unknown) as Holder;
const kept = held;
console.log(kept.label);
