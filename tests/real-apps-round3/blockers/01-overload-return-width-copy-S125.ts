// New since round 2 (GH #109, S125): chess.js's history() shape. One implementation fills a
// (Move | string)[] and the overloads hand it out as Move[] or string[]. tsc accepts it and Node
// shares the one array; tsinter now refuses both calls by name (SC1090, "the slot would hold a
// COPY ... (SEMANTICS.md S125)"). Round 2 built this. Loud, not silent.
// Node: "1 2". Splitting the implementation into one exactly-typed array per overload builds.
// Fixed by GH #118: the array is the call's own fresh result, so the copy is the only reference
// left; this builds and matches Node on both lanes (row gh118-overload-history in
// packages/compiler/test/wasm-width-identity.test.ts).
class Move {
  constructor(public san: string) {}
  isCapture(): boolean {
    return this.san.includes("x");
  }
}
class Game {
  private moves = ["e4", "exd5"];
  history(): string[];
  history(o: { verbose: true }): Move[];
  history(o: { verbose: boolean } = { verbose: false }) {
    const out: (Move | string)[] = [];
    for (const m of this.moves) {
      if (o.verbose) out.push(new Move(m));
      else out.push(m);
    }
    return out;
  }
}
const g = new Game();
const verbose = g.history({ verbose: true });
console.log(verbose.filter((m) => m.isCapture()).length, g.history().length);
