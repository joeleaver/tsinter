// AbortSignal: validation, state, a pre-aborted signal, abort mid-body
async function main(): Promise<void> {
  for (const d of [-1, 1.5, 4294967296, NaN]) {
    try {
      AbortSignal.timeout(d);
      console.log("ok", d);
    } catch (e) {
      if (e instanceof Error) console.log("timeout:", e.name, e.message);
    }
  }
  const s = AbortSignal.timeout(10);
  console.log("sig:", s.aborted, s.reason === undefined);
  await new Promise<void>((res) => setTimeout(res, 40));
  console.log("sig2:", s.aborted);
  const ab = AbortSignal.abort();
  console.log("abort:", ab.aborted);
  try {
    await fetch("__BASE__/text", { signal: ab });
  } catch (e) {
    if (e instanceof Error) console.log("pre:", e.name, e.message);
  }
  const r = await fetch("__BASE__/drip", { signal: AbortSignal.timeout(300) });
  console.log("drip:", r.status);
  try {
    await r.text();
  } catch (e) {
    if (e instanceof Error) console.log("drip-body:", e.name, e.message);
  }
}
main();
