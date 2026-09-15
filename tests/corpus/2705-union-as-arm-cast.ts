// `u as Arm` on a union value: the checked single-arm extraction (`u!`'s
// spelling with a named arm — divergence 38). Sound programs never reach
// the trap, so behavior is Node-exact: the extracted arm flows into typed
// slots (parseInt's string, arithmetic, record fields) that the erased
// cast would have fenced as a union mismatch.
function hops(header: string | undefined): number {
  return parseInt(header as string, 10) || 0;
}
console.log(hops("3"), hops("12abc"), hops("x") + 1);

const values: (string | number)[] = ["a", 2, "c"];
function pick(i: number): string | number {
  return values[i];
}
const s = pick(0) as string;
console.log(s.toUpperCase(), s.length);
const n = pick(1) as number;
console.log(n * 10);

// Through record fields and reassembly into another union slot.
interface Row {
  label: string;
  value: string | null;
}
const row: Row = { label: "l", value: "v" };
const extracted = row.value as string;
console.log(extracted + "!");
const back: string | null | undefined = extracted;
console.log(back === "v");

// The trap is catchable where the assertion lies (scriptc throws the
// TypeError divergence 38 documents; this corpus keeps to sound paths).
