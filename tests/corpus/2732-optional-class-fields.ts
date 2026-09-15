// Optional class fields (`a?: string`): the record-field precedent applied
// to class shapes — the checker types the slot `string | undefined`, the
// allocation defines the property as undefined (exactly Node: `class C
// { a?: string }` produces `C { a: undefined }`), and reads/writes ride
// the ordinary undefined-armed union machinery (narrowing, `?.`, `!`).
import { inspect } from "node:util";

class Options {
  host?: string;
  port?: number;
  strict?: boolean;
  tags?: string[];
  retries? = 3;
}
const o = new Options();
console.log(inspect(o));
console.log(o.host === undefined, typeof o.port, `${o.retries}`);

// Writes flip the arm; narrowing reads the value side.
o.host = "localhost";
o.port = 8080;
o.tags = ["a", "b"];
if (o.host !== undefined) console.log(o.host.length);
console.log(o.port ?? -1, o.tags?.length, o.strict ?? false);
console.log(inspect(o));

// Writing undefined back re-arms the union.
o.host = undefined;
console.log(o.host === undefined, inspect(o));

// Optional fields in hierarchies: base and derived optional slots keep
// layout order (base prefix first), both start undefined.
class Base {
  b?: number;
  tag = "t";
}
class Kid extends Base {
  k?: string;
  n = 1;
}
const kid = new Kid();
console.log(inspect(kid));
kid.b = 5;
kid.k = "kk";
console.log(inspect(kid), kid.b + 1, kid.k.toUpperCase());

// Optional fields next to constructor assignment: the ctor may assign the
// slot conditionally — both paths honest.
class Conn {
  err?: string;
  constructor(ok: boolean) {
    if (!ok) this.err = "down";
  }
  status(): string {
    return this.err ?? "up";
  }
}
console.log(new Conn(true).status(), new Conn(false).status());
console.log(inspect(new Conn(true)), inspect(new Conn(false)));

// Methods reading/writing their own optional slots; unions with more arms.
class Cache {
  value?: number;
  last?: string;
  put(v: number): number {
    this.value = v;
    this.last = `v${v}`;
    return this.value;
  }
  clear(): void {
    this.value = undefined;
  }
  peek(): number {
    return this.value ?? -1;
  }
}
const cache = new Cache();
console.log(cache.peek());
console.log(cache.put(7), cache.peek(), `${cache.last}`);
cache.clear();
console.log(cache.peek(), inspect(cache));

// Generic classes with optional fields: per-instantiation undefined-armed
// slots.
class Slot<T> {
  current?: T;
  set(v: T): void {
    this.current = v;
  }
}
const sn = new Slot<number>();
const ss = new Slot<string>();
sn.set(2);
console.log(`${sn.current}`, ss.current === undefined, inspect(ss));

// RC stress: ref-typed optional slots retain/release across write cycles
// (including overwrite and re-arm to undefined).
class Ring {
  buf?: string[];
}
for (let i = 0; i < 100; i++) {
  const r = new Ring();
  r.buf = [`x${i}`, "y"];
  r.buf = [...r.buf, "z"];
  r.buf = undefined;
  r.buf = ["final"];
  if (i === 99) console.log(inspect(r));
}
