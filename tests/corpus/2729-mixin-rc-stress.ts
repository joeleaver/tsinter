// RC stress over mixin instantiations: churn constructions through every
// layer, hold and drop references through base-typed slots, unwind
// constructors mid-chain, and keep instances alive across closures — the
// sanitizer lane turns this into a leak/use-after-free test.
type Ctor<T = object> = new (...args: any[]) => T;

class Node2 {
  label: string;
  next: Node2 | null = null;
  constructor(label: string) {
    this.label = label;
  }
  describe() {
    return this.label;
  }
}

function Linked<T extends Ctor<Node2>>(B: T) {
  return class extends B {
    link(other: Node2) {
      this.next = other;
      return this;
    }
  };
}

function Audited<T extends Ctor<Node2>>(B: T) {
  class Audited extends B {
    log: string[] = [];
    constructor(...args: any[]) {
      super(...args);
      this.log.push(`born:${this.label}`);
    }
    describe() {
      return `${super.describe()}(${this.log.length})`;
    }
  }
  return Audited;
}

const AL = Audited(Linked(Node2));

// Churn: build chains, drop them, rebuild.
for (let round = 0; round < 50; round++) {
  let head: Node2 | null = null;
  for (let i = 0; i < 20; i++) {
    const n = new AL(`r${round}n${i}`);
    n.log.push("linked");
    if (head) n.link(head);
    head = n;
  }
  if (round % 25 === 0 && head) console.log(head.describe());
}

// Cycles through the mixin layer's fields: the collector must reclaim.
for (let i = 0; i < 10; i++) {
  const a = new AL("a" + i);
  const b = new AL("b" + i);
  a.link(b);
  b.link(a);
}
console.log("cycles done");

// Exceptions mid-construction release the half-built layers.
class Fussy extends Node2 {
  constructor(label: string) {
    super(label);
    if (label.startsWith("bad")) throw new Error("rejected " + label);
  }
}
const AF = Audited(Linked(Fussy));
let caught = 0;
for (let i = 0; i < 20; i++) {
  try {
    const n = new AF(i % 3 === 0 ? `bad${i}` : `ok${i}`);
    n.log.push("kept");
  } catch {
    caught++;
  }
}
console.log("caught", caught);

// Instances captured by closures survive the loop that made them.
const keepers: (() => string)[] = [];
for (let i = 0; i < 5; i++) {
  const n = new AL(`kept${i}`);
  keepers.push(() => n.describe());
}
console.log(keepers.map((k) => k()).join(" "));
