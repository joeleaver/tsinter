// #147 T-7 fixture (delta-01 §B-3): the HOST-CYCLED posture (the profile
// declares a result_reset_symbol, so the outbound arena resets only when
// the host calls it — never automatically at entry). entry1 returns a
// buffer-class result, which MOVES into the outbound arena (untouched by
// #147); entry2 performs the SAME OOB trap traps/lib.ts's boom does,
// allocating its own array first. The row asserts entry1's result is
// STILL READABLE by the host AFTER entry2's trap — the arena and the
// live set are disjoint structures, so entry2's trap-path sweep can
// never reach entry1's outbound result.
// The concatenation is DELIBERATE, not decoration: a bare string LITERAL
// return compiles to an IMMORTAL static (never routed through
// scr_str_alloc), which would never enter the #147 live set at all —
// M-5b's own mutation (drop removed) needs a result that IS tracked, so
// entry1 must force a REAL runtime construction.
export function entry1(prefix: string): string {
  return prefix + "-kept";
}

export function entry2(i: number): number {
  const xs = [1, 2, 3];
  return xs[i]!;
}

console.log("traps-cycled ready");
