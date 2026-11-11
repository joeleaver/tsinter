// Set support boundaries: what stays rejected at LOWERING, with specific
// messages. Elements are Map's KEY types (any value but a generator —
// docs/design/object-keys.md); the rest is fenced.

// Array, Set, string and tuple seeds lower (Step 2B); a seed whose values
// are not legal elements — a Map's [key, value] entries — typechecks
// against the lib but keeps the fence: never silently an empty set.
const seeded = new Set(new Map([["a", 1]]));

// Generators are no elements — the new-site diagnostic names the
// element type.
const byFlag = new Set<Generator<number>>();

// ... whatever they yield.

const recs = new Set<Generator<string>>();

// Set-typed slots elsewhere report the ordinary unsupported-type diagnostic.
function useBad(s: Set<Generator<number>>): number {
  return s.size;
}

// Sets as union arms beside a data arm have no narrowing test (beside
// undefined/null they map).
function maybeSet(cond: boolean): Set<string> | string {
  return "none";
}

// Sets as array elements: ScrArr has no set element kind.
const rows: Set<string>[] = [];

// Sets are not JSON (Node stringifies them as the useless "{}" husk;
// scriptc rejects instead of shipping that).
const s = new Set<string>();
console.log(JSON.stringify(s));

// Set methods have no bound-value form — call them directly.
const adder = s.add;

// Reached: collection defers its diagnostics until a reference makes
// them relevant; these references are what makes them count.
useBad(new Set<Generator<number>>());
maybeSet(true);
