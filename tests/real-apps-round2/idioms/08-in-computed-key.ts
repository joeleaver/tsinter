// Queue #7 (4 apps): `in` with a computed key (chess.js 4 sites; jsdiff `'callback' in options`).
const Ox88: Record<string, number> = { a8: 0, b8: 1 };
type Sym = "p" | "n";
function valid(square: string): boolean {
  return square in Ox88;
}
const pieces: Partial<Record<Sym, number>> = {};
for (const t of ["p", "n", "p"] as Sym[]) pieces[t] = t in pieces ? pieces[t]! + 1 : 1;
console.log(valid("a8"), valid("z9"), JSON.stringify(pieces));
