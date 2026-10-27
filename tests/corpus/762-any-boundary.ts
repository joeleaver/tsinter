// @dynamic
// The boundary: static values marshal INTO the island (primitives by
// value, typed composites as live views — SEMANTICS.md S115); `any` values
// exit through VALIDATED extraction (strict primitives; composites only
// when fresh, or a view returning to its own type).
// Node never checks an `as`, so only VALID casts are differential.
const point = { x: 1.5, y: -2 };
const d: any = point; // the record crosses as a live view (S115)
d.x = d.x * 2;
console.log(`${d.x} ${d.y}`);
const back = d as { x: number; y: number };
console.log(back.x + back.y);
const nums: any = [1, 2, 3];
const total = (JSON.parse("[1, 2, 3]") as number[]).length + (nums[0] as number);
console.log(total);
const astral: any = "ab🌍cd";
console.log(`${astral.length}`, `${astral.toUpperCase()}`, (astral as string).length);
const viaSlot: number = (7 as any) * 6; // implicit exit at the typed slot
console.log(viaSlot);
