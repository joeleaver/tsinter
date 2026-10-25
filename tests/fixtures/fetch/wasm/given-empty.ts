// An empty method or redirect mode is a value the host checks, not its default
async function main(): Promise<void> {
  try {
    const r = await fetch("__BASE__/text", { method: "" });
    console.log("method resolved", r.status);
  } catch (e) {
    if (e instanceof Error) console.log("method", e.name, e.message);
  }
  try {
    const r = await fetch("__BASE__/redirect", { redirect: "" as "manual" });
    console.log("redirect resolved", r.status);
  } catch (e) {
    if (e instanceof Error) console.log("redirect", e.name, e.message);
  }
  const ok = await fetch("__BASE__/post-echo", { method: "GET" });
  console.log("explicit GET", ok.status);
}
main();
