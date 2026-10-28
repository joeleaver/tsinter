// A let declared in one case clause and written by a nested function in
// another clause: the closure may run while the binding is still in its
// temporal dead zone (Node throws ReferenceError), and the switch's TDZ
// flag is not a capture — refused by name, never run unguarded (GH #49).
function closure(k: number): string {
  switch (k) {
    case 0:
      let x = 1;
      return "x=" + x;
    case 1:
      const set = (): void => {
        x = 3;
      };
      set();
      return "set";
  }
  return "none";
}
console.log(closure(1));
