// Width flows involving INDEX-SIGNATURE (hybrid) record shapes, both
// directions. scriptc reshapes by copy (the width family's stance):
// reads happen after the narrow, and key orders are arranged so the
// documented declared-then-overflow enumeration coincides with Node's
// insertion order.

// Hybrid source -> declared-only target: declared fields copy off their
// struct slots, the overflow drops with the width.
type Priced = { base: number; [k: string]: number };
const priced: Priced = { base: 10, surge: 2, tax: 1 };
function describe(p: { base: number }): string {
  return `base=${p.base}`;
}
console.log(describe(priced));
const justBase: { base: number } = priced;
console.log(justBase.base);

// Array of hybrids -> array of the declared subset (per-element copy).
const rows: Priced[] = [
  { base: 1, extra: 9 },
  { base: 2, other: 8 },
];
const bases: { base: number }[] = rows;
console.log(bases.map((b) => b.base).join(","));

// Union slot: the hybrid width-lifts into the single record arm.
function baseOrNothing(p: { base: number } | undefined): string {
  return p === undefined ? "none" : String(p.base);
}
console.log(baseOrNothing(priced), baseOrNothing(undefined));

// Declared-only source -> hybrid target with a REQUIRED declared field:
// the declared field initializes directly off the source, every other
// source field lands in the overflow.
type Table = { id: number; [k: string]: number };
const row = { id: 7, width: 3, height: 4 };
const table: Table = row;
console.log(table.id, table["width"], table["height"]);
table["depth"] = 5;
console.log(Object.keys(table).join(","));
console.log(JSON.stringify(table));

// Hybrid -> hybrid: the declared subset initializes directly (required
// fields included — the declared field's type IS the slot's), dropped
// declared fields and the overflow carry through as overflow entries.
type Wide = { id: number; extra: number; [k: string]: number };
type Slim = { id: number; [k: string]: number };
const wide: Wide = { id: 3, extra: 30, plus: 300 };
const slim: Slim = wide;
console.log(slim.id, slim["extra"], slim["plus"]);
console.log(Object.keys(slim).join(","));
console.log(JSON.stringify(slim));

// All-optional hybrid -> hybrid (the capture's historic shape): unset
// optionals skip, present ones keyed-write through.
type Opts = { alpha?: number; beta?: number; [k: string]: number | undefined };
type FewerOpts = { alpha?: number; [k: string]: number | undefined };
const opts: Opts = { alpha: 1, gamma: 3 };
const fewer: FewerOpts = opts;
const alphaRead = fewer.alpha;
const betaRead = fewer["beta"];
const gammaRead = fewer["gamma"];
console.log(
  alphaRead === undefined ? -1 : alphaRead,
  betaRead === undefined ? -1 : betaRead,
  gammaRead === undefined ? -1 : gammaRead,
);
console.log(Object.keys(fewer).join(","));
