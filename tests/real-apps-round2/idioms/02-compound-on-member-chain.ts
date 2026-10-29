// Queue #1, TypeScript half (chess.js, 12 sites): compound assignment whose receiver is a member chain.
class Board {
  castling: Record<"w" | "b", number> = { w: 0, b: 0 };
  arr: number[] = [0, 0];
  set(us: "w" | "b"): void {
    this.castling.w |= 1; // compound assignment to fields of computed receivers
    this.castling[us] ^= 4;
    this.arr[1] += 2; // compound array-element assignment
  }
}
const b = new Board();
b.set("b");
console.log(b.castling.w, b.castling.b, b.arr[1]);
