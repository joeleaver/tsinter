// Generates bench.pgn for the chess `pgn` case (run once under Node by setup-apps.py, against
// the unpatched chess.js source): 200 seeded pseudo-random games with headers, comments and
// a mix of finished and unfinished results. Deterministic.
import { writeFileSync } from "node:fs";
import { Chess } from "./src/chess.ts";

let s = 2024;
const rnd = (n: number): number => {
  s = (Math.imul(s, 1103515245) + 12345) >>> 0;
  return (s >>> 8) % n;
};
const out: string[] = [];
for (let g = 0; g < 200; g++) {
  const c = new Chess();
  c.setHeader("Event", `bench ${g}`);
  c.setHeader("White", `w${rnd(50)}`);
  c.setHeader("Black", `b${rnd(50)}`);
  const plies = 10 + rnd(200);
  for (let i = 0; i < plies && !c.isGameOver(); i++) {
    const ms = c.moves();
    c.move(ms[rnd(ms.length)]);
    if (rnd(15) === 0) c.setComment(`note ${g}.${i}`);
  }
  const result = c.isCheckmate() ? (c.turn() === "w" ? "0-1" : "1-0") : c.isGameOver() ? "1/2-1/2" : "*";
  c.setHeader("Result", result);
  out.push(c.pgn());
}
writeFileSync(process.argv[2] ?? "bench.pgn", out.join("\n\n") + "\n");
