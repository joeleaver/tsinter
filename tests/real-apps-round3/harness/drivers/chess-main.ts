// A chess CLI over chess.js 1.4.0's own TypeScript source:
//   main.ts perft <depth> [fen]     move-generation node count
//   main.ts pgn <file.pgn> [n]      replay the first n games, print summaries
//   main.ts play <seed> <plies>     deterministic pseudo-random game, prints PGN
import { readFileSync } from "node:fs";
import { Chess, validateFen } from "./src/chess.ts";

// (no array destructuring: the static tier traps reading past the end — SEMANTICS.md S003)
const args = process.argv.slice(2);
const at = (i: number): string | undefined => (i < args.length ? args[i] : undefined);
const cmd = at(0), a1 = at(1), a2 = at(2);

function perft(depth: number, fen?: string): void {
  const chess = fen === undefined ? new Chess() : new Chess(fen);
  console.log(chess.ascii());
  for (let d = 1; d <= depth; d++) console.log(`perft(${d}) = ${chess.perft(d)}`);
}

function pgn(file: string, limit: number): void {
  const text = readFileSync(file, "utf8");
  const games = text.split(/\n\n(?=\[Event)/);
  let n = 0;
  for (const g of games.slice(0, limit)) {
    const chess = new Chess();
    try {
      chess.loadPgn(g);
    } catch (e) {
      console.log(`game ${n}: error ${(e as Error).message}`);
      n++;
      continue;
    }
    const h = chess.getHeaders();
    const hist = chess.history({ verbose: true });
    const captures = hist.filter((m) => m.isCapture()).length;
    console.log(
      `game ${n}: ${h["White"]} vs ${h["Black"]} ${h["Result"]} plies=${hist.length} captures=${captures} ` +
        `check=${chess.isCheck()} mate=${chess.isCheckmate()} draw=${chess.isDraw()} fen=${chess.fen()}`,
    );
    n++;
  }
}

function play(seed: number, plies: number): void {
  let s = seed >>> 0;
  const rnd = (n: number): number => {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    return (s >>> 8) % n;
  };
  const chess = new Chess();
  chess.setHeader("Event", "tsinter trial");
  chess.setHeader("White", "lcg");
  chess.setHeader("Black", "lcg");
  for (let i = 0; i < plies && !chess.isGameOver(); i++) {
    const moves = chess.moves();
    const m = moves[rnd(moves.length)]!;
    chess.move(m);
  }
  console.log(chess.pgn({ maxWidth: 72 }));
  console.log(chess.fen());
  console.log(chess.ascii());
  console.log(JSON.stringify(chess.board()[0]));
  console.log(`over=${chess.isGameOver()} mate=${chess.isCheckmate()} stalemate=${chess.isStalemate()} insufficient=${chess.isInsufficientMaterial()} 3fold=${chess.isThreefoldRepetition()}`);
  let undone = 0;
  while (chess.undo() !== null) undone++;
  console.log(`undone ${undone}, back to start: ${chess.fen() === new Chess().fen()}`);
  try {
    chess.move("e5");
  } catch (e) {
    console.log("illegal:", (e as Error).message);
  }
}

// many seeded games exercising comments, undo, put/remove, verbose moves, fen reload
function fuzz(seed: number, games: number): void {
  let s = seed >>> 0;
  const rnd = (n: number): number => {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    return (s >>> 8) % n;
  };
  let h = 0;
  const mix = (t: string): void => {
    for (let i = 0; i < t.length; i++) h = (Math.imul(h, 31) + t.charCodeAt(i)) | 0;
  };
  const files = "abcdefgh";
  for (let g = 0; g < games; g++) {
    const chess = new Chess();
    const plies = 20 + rnd(120);
    let line = "";
    for (let i = 0; i < plies && !chess.isGameOver(); i++) {
      const vm = chess.moves({ verbose: true });
      const m = vm[rnd(vm.length)]!;
      const r = chess.move(rnd(2) === 0 ? m.san : m.lan);
      line += r.san + (r.isCapture() ? "x" : "") + (r.isPromotion() ? "=" : "") + (r.isKingsideCastle() ? "O" : "") + (r.isEnPassant() ? "e" : "") + " ";
      if (rnd(10) === 0) chess.setComment("c" + i);
      if (rnd(25) === 0) {
        const u = chess.undo();
        line += "U" + (u === null ? "null" : u.san) + " ";
      }
    }
    const sq = (files[rnd(8)] + String(1 + rnd(8))) as Parameters<Chess["get"]>[0];
    const got = chess.get(sq);
    line += `get(${sq})=${got === undefined ? "none" : got.color + got.type} `;
    line += `comment=${chess.getComment() ?? "undef"} removed=${chess.removeComment() ?? "undef"} `;
    const cs = chess.getComments();
    line += `comments=${cs.length}:${cs.map((c) => c.comment).join(",")} `;
    const fen = chess.fen();
    const again = new Chess(fen);
    line += `reload=${again.fen() === fen} moves=${again.moves().length} check=${chess.isCheck()} over=${chess.isGameOver()} draw=${chess.isDraw()} `;
    let undone = 0;
    while (chess.undo() !== null) undone++;
    line += `undone=${undone} hist=${chess.history().length} `;
    const rm = chess.remove(sq);
    line += `remove=${rm === undefined ? "none" : rm.type} fen=${chess.fen()}`;
    mix(line);
    if (g < 20 || g % 50 === 0) console.log(`g${g} ${line}`);
  }
  console.log(`fuzz hash ${h}`);
}

// mutated FENs through validateFen/load, and garbage/near-SAN strings through move()
function fuzzText(seed: number, n: number): void {
  let s = seed >>> 0;
  const rnd = (k: number): number => {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    return (s >>> 8) % k;
  };
  const alphabet = "pnbrqkPNBRQK12345678/ -wbKQkqa-h0x+#=O";
  const fens = [
    "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
    "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1",
    "8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1",
    "rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq c6 0 2",
  ];
  let ok = 0;
  for (let i = 0; i < n; i++) {
    let f = fens[rnd(fens.length)];
    const muts = rnd(4);
    for (let j = 0; j < muts; j++) {
      const at = rnd(f.length + 1);
      const op = rnd(3);
      const ch = alphabet[rnd(alphabet.length)];
      if (op === 0) f = f.slice(0, at) + ch + f.slice(at);
      else if (op === 1) f = f.slice(0, at) + f.slice(at + 1);
      else f = f.slice(0, at) + ch + f.slice(at + 1);
    }
    const v = validateFen(f);
    let line = `#${i} ${JSON.stringify(f)} ok=${v.ok} err=${v.error ?? "-"}`;
    if (v.ok) {
      ok++;
      const c = new Chess(f);
      const ms = c.moves();
      line += ` moves=${ms.length} check=${c.isCheck()} turn=${c.turn()} mn=${c.moveNumber()}`;
      // garbage and near-legal SAN
      for (let k = 0; k < 4; k++) {
        let cand = ms.length > 0 && rnd(2) === 0 ? ms[rnd(ms.length)] : "";
        const extra = rnd(3);
        for (let e = 0; e < extra; e++) cand += alphabet[rnd(alphabet.length)];
        try {
          const r = c.move(cand, { strict: rnd(2) === 0 });
          line += ` [${cand}->${r.san}/${r.lan}/${r.flags}]`;
        } catch (e) {
          line += ` [${cand}!${(e as Error).message}]`;
        }
      }
      line += ` fen=${c.fen()} pgn=${JSON.stringify(c.pgn())}`;
    } else {
      try {
        new Chess(f);
        line += " load=ok?";
      } catch (e) {
        line += ` load!${(e as Error).message}`;
      }
    }
    console.log(line);
  }
  console.log(`valid ${ok}/${n}`);
}

if (cmd === "perft") perft(Number(a1 ?? "NaN"), a2);
else if (cmd === "fuzztext") fuzzText(Number(a1 ?? "1"), Number(a2 ?? "10"));
else if (cmd === "fuzz") fuzz(Number(a1 ?? "1"), Number(a2 ?? "10"));
else if (cmd === "pgn") pgn(a1!, Number(a2 ?? "1000"));
else if (cmd === "play") play(Number(a1 ?? "NaN"), Number(a2 ?? "NaN"));
else {
  console.error("usage: perft|pgn|play");
  process.exit(2);
}
