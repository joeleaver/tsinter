// String conversion of the fetch values: their toStringTag
async function main(): Promise<void> {
  const r = await fetch("__BASE__/json");
  const s = AbortSignal.timeout(10);
  console.log(`${r}`, String(r), `${r.headers}`, `${s}`);
  const ab = await r.arrayBuffer();
  console.log(`${ab}`, String(ab), ab.byteLength);
}
main();
