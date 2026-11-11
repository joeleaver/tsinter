// Map support boundaries: what stays rejected at LOWERING, with specific
// messages (the checker-level fences — seeded constructors, keys()/values()/
// entries(), spread, set-chaining — live in maps-surface.ts: the ambient
// declaration makes those type errors before lowering).

// Keys may be any value but a generator (docs/design/object-keys.md)
// — the new-site diagnostic names the key type.
const byFlag = new Map<Generator<number>, string>();

// Values exclude dynamic values.
const handlers = new Map<string, unknown>();

// ... and generators.
const nested = new Map<string, Generator<number>>();

// Map-typed slots elsewhere report the ordinary unsupported-type diagnostic.
function useBad(m: Map<string, unknown>): number {
  return m.size;
}

// Maps as union arms beside a data arm have no narrowing test (beside
// undefined/null they map: the tag is the test).
function maybeMap(cond: boolean): Map<string, number> | string {
  return "none";
}

// Maps as array elements: ScrArr has no map element kind.
const rows: Map<string, number>[] = [];

// Maps are not JSON (Node stringifies them as the useless "{}" husk;
// scriptc rejects instead of shipping that).
const m = new Map<string, number>();
console.log(JSON.stringify(m));

// Map methods have no bound-value form — call them directly.
const getter = m.get;

// Reached: collection defers its diagnostics until a reference makes
// them relevant; these references are what makes them count.
useBad(new Map<string, unknown>());
maybeMap(true);
