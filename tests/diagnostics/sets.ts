// Set support boundaries: what stays rejected at LOWERING, with specific
// messages. Elements are Map's KEY types (string or number — SameValueZero
// hashing is honest for exactly those); everything else is fenced.

// Array, Set, string and tuple seeds lower (Step 2B); a seed whose values
// are not legal elements — a Map's [key, value] entries — typechecks
// against the lib but keeps the fence: never silently an empty set.
const seeded = new Set(new Map([["a", 1]]));

// Elements must be string or number — the new-site diagnostic names the
// element type.
const byFlag = new Set<boolean>();

// Record elements would need pointer-identity hashing and cycle tracing —
// fenced for now.
const recs = new Set<{ id: number }>();

// Set-typed slots elsewhere report the ordinary unsupported-type diagnostic.
function useBad(s: Set<boolean>): number {
  return s.size;
}

// Sets as union arms have no narrowing test — rejected like Map arms.
function maybeSet(cond: boolean): Set<string> | undefined {
  return undefined;
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
useBad(new Set<boolean>());
maybeSet(true);
