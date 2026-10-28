// @exit: 1
// A let declared in one case of a switch is in its temporal dead zone in
// every other case: the case clauses share one block scope, and entering
// at a later label jumps past the declaration. A write from another case
// throws Node's ReferenceError (after its right-hand side evaluates —
// PutValue order) — plain, expression, destructuring and for-of writes
// alike; falling through the declaration initializes it. (A READ from
// another case is tsc's TS2454, refused at compile time.) GH #49.
function write(k: number): string {
  switch (k) {
    case 0:
      let x = 1;
      return "x=" + x;
    case 1:
      x = 5;
      return "wrote " + x;
  }
  return "none";
}

function fallThrough(k: number): string {
  switch (k) {
    case 0:
      let n = 10;
      n = n + 1;
    // falls through
    case 1:
      n = 20;
      return "n=" + n;
    default:
      return "default";
  }
}

let effects = 0;
function bump(): number {
  effects++;
  return 7;
}
function rhsFirst(k: number): number {
  switch (k) {
    case 0:
      let y = 0;
      return y;
    case 1:
      y = bump();
      return y;
  }
  return -1;
}

function exprWrite(k: number): string {
  switch (k) {
    case 0:
      let x = 1;
      return "x=" + x;
    case 1:
      return "v=" + (x = 9);
  }
  return "none";
}
function destrWrite(k: number): string {
  switch (k) {
    case 0:
      let a = 1;
      return "a=" + a;
    case 1:
      [a] = [4];
      return "a=" + a;
  }
  return "none";
}
function forOfWrite(k: number): string {
  switch (k) {
    case 0:
      let e = "";
      return "e=" + e;
    case 1:
      for (e of ["p", "q"]) console.log("iter");
      return "done";
  }
  return "none";
}
type Tag = "on" | "off" | undefined;
function unionSwitch(t: Tag): string {
  switch (t) {
    case "on":
      let state = "lit";
      return state;
    case "off":
      state = "set";
      return "was " + state;
    default:
      return "unset";
  }
}

function attempt(label: string, f: () => unknown): void {
  try {
    console.log(label, f());
  } catch (e) {
    console.log(label, "caught", String(e));
  }
}

attempt("write0", () => write(0));
attempt("write1", () => write(1));
attempt("fall0", () => fallThrough(0));
attempt("fall1", () => fallThrough(1));
attempt("fall2", () => fallThrough(2));
attempt("rhs0", () => rhsFirst(0));
attempt("rhs1", () => rhsFirst(1));
console.log("effects", effects);
attempt("expr", () => exprWrite(1));
attempt("destr", () => destrWrite(1));
attempt("forof", () => forOfWrite(1));
attempt("forof0", () => forOfWrite(0));
attempt("union-on", () => unionSwitch("on"));
attempt("union-off", () => unionSwitch("off"));
attempt("union-none", () => unionSwitch(undefined));

// Top level: the same rule; the uncaught error exits 1.
for (const k of [0, 1]) {
  switch (k) {
    case 0:
      let top = "init";
      console.log("top", top);
      break;
    case 1:
      top = "late";
      console.log("unreached", top);
      break;
  }
}
