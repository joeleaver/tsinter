// @dynamic
// TYPED parameters on island-marshaled callbacks: each incoming engine
// argument converts to the param's declared static type at call time
// through the validated-exit machinery — strict primitives, JSON
// round-trip records are no longer one of them: a typed RECORD or ARRAY
// parameter would be a COPY of the package's object, which SEMANTICS.md
// S115 refuses (npm.test.ts pins the refusal) — those callbacks take
// `any`, which shares the real object as in Node; `T | undefined` taking
// the undefined arm when the argument is
// absent, surplus arguments dropped (JS call semantics). Async callbacks
// return a real thenable the package can await; a rejection crosses as a
// real engine Error. Differential vs Node byte-for-byte.
import { catching, chainCatchLog, chainLog, collectTwice, extraArgs, fire, maybe, withBool, withNumbers, withOptions, withString } from "typedcb";


const sum: string = withNumbers((a: number, b: number) => a + b);
console.log(sum);

const up: string = withString((s: string) => s + s.length);
console.log(up);

const not: string = withBool((b: boolean) => !b);
console.log(not);

const describe = (s: string | undefined): string => (s === undefined ? "absent" : `got ${s}`);
const present: string = maybe(describe, true);
console.log(present);
const absent: string = maybe(describe, false);
console.log(absent);

const opts: string = withOptions((o: any) => {
  const extras: number = o.extra !== undefined ? o.extra.length : -1; // the package's own object
  return `${o.name}/${o.count}/${extras}`;
});
console.log(opts);

// The package passes five arguments; the declared three arrive, the rest
// drop (the third, the package's object, arrives as itself).
const extra: string = extraArgs((a: number, b: number, o: any) => `${a + b}:${o.tag}`);
console.log(extra);

// An honest throw from a typed callback bridges exactly like the all-'any'
// callbacks' (the package catches a real TypeError instance).
const thrown: string = catching((n: number) => {
  if (n > 4) throw new TypeError(`too big: ${n}`);
  return n;
}, 5);
console.log(thrown);

// A function with a DEFAULTED parameter as a value (commander's
// option-collector pattern): the defaulted `any[]` param (the package's
// own array, shared) takes the default when the package omits the
// argument, and the fresh `string[]` return marshals back as a copy
// nothing else holds, which the package hands to the next call.
function collect(value: string, previous: any[] = []): string[] {
  return [...previous, value];
}
const collected: string = collectTwice(collect);
console.log(collected);

// Async callbacks: the package awaits a real thenable (and logs
// island-side). The fulfillment marshals back; a rejection arrives as a
// real engine Error.
chainLog(async (s: string) => {
  return `${s}!`;
});

chainCatchLog(async (): Promise<void> => {
  throw new Error("boom");
});

// A fire-and-forget async callback: the package ignores the returned
// promise; the body still runs to completion on the shared loop.
const fired: string = fire(async (tag: string) => {
  console.log(`fired ${tag}`);
});
console.log(fired);
