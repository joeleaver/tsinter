// Headers: argument errors, names, iteration
async function main(): Promise<void> {
  const r = await fetch("__BASE__/header-echo", { headers: { "X-Echo-One": "uno", "x-echo-two": "dos" } });
  const h = r.headers;
  const t1: string = await r.text();
  console.log("echo:", t1);
  const g1 = h.get("X-MULTI");
  const g2 = h.get("Content-Type");
  const g3 = h.get("nope");
  console.log("get:", g1, g2, g3);
  try {
    h.get("a b");
  } catch (e) {
    if (e instanceof Error) console.log("bad:", e.name, e.message);
  }
  try {
    h.has("é");
  } catch (e) {
    if (e instanceof Error) console.log("bad2:", e.name, e.message);
  }
  try {
    h.get("Āx");
  } catch (e) {
    if (e instanceof Error) console.log("bad3:", e.name, e.message);
  }
  const names: string[] = [];
  h.forEach((v, k) => {
    if (k !== "date") names.push(`${k}=${v}`);
  });
  console.log("each:", names.join(" | "));
  console.log("cookies:", h.getSetCookie().length);
  try {
    await fetch("__BASE__/header-echo", { headers: h });
  } catch (e) {
    if (e instanceof Error) console.log("pass-through:", e.name, e.message);
  }
  for (const f of [() => h.set("a", "b"), () => h.append("a b", "v"), () => h.delete("x"), () => h.set("a", " x\u0000 ")]) {
    try {
      f();
    } catch (e) {
      if (e instanceof Error) console.log("mut:", e.name, e.message);
    }
  }
}
main();
