// the named fences
async function main(): Promise<void> {
  const r = await fetch("__BASE__/text");
  try {
    const b = r.body;
    console.log("body ok", b === null);
  } catch (e) {
    if (e instanceof Error) console.log("body:", e.name, e.message);
  }
  try {
    const s = JSON.stringify(r.headers);
    console.log("json ok", s);
  } catch (e) {
    if (e instanceof Error) console.log("json:", e.name, e.message);
  }
  console.log("typeof:", typeof r);
}
main();
