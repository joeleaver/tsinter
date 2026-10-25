// body readers: unusable, json SyntaxError, bodyUsed timing, null bodies
async function main(): Promise<void> {
  const r = await fetch("__BASE__/text");
  console.log("used0:", r.bodyUsed);
  const p = r.text();
  console.log("used-sync:", r.bodyUsed);
  const pt: string = await p;
  console.log("t:", pt);
  try {
    await r.text();
    console.log("second: resolved");
  } catch (e) {
    if (e instanceof Error) console.log("second:", e.name, e.message);
  }
  try {
    await r.json();
  } catch (e) {
    if (e instanceof Error) console.log("third:", e.name, e.message);
  }
  const t = await fetch("__BASE__/text");
  try {
    const v: unknown = await t.json();
    console.log("json:", typeof v);
  } catch (e) {
    if (e instanceof Error) console.log("json:", e.name, e.message);
  }
  const h = await fetch("__BASE__/text", { method: "HEAD" });
  const a: string = await h.text();
  const b: string = await h.text();
  console.log("head:", h.status, JSON.stringify(a), JSON.stringify(b), h.bodyUsed);
  const j = await fetch("__BASE__/json");
  const v = (await j.json()) as { n: number; arr: (number | string)[] };
  console.log("json2:", v.n, v.arr[1]);
  console.log("type:", j.type, j.statusText);
}
main();
