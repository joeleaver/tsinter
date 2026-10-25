// a URL input
async function main(): Promise<void> {
  try {
    const r = await fetch(new URL("__BASE__/text"));
    console.log("url:", r.status);
  } catch (e) {
    if (e instanceof Error) console.log("url:", e.name, e.message);
  }
}
main();
