// Control for 2681: the same shape with no throw at all, permanently
// pinning that await-in-finally still resolves normally on the ordinary
// path — the near-miss this program guards against is a "make the
// uncaught-exception exit more correct" fix accidentally regressing the
// resolving path it was never meant to touch.
function tick(): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(() => {
      resolve();
    }, 1);
  });
}
async function f(): Promise<string> {
  try {
    await tick();
    return "ok";
  } finally {
    await tick();
    console.log("finally ran");
  }
}
async function main(): Promise<void> {
  const v = await f();
  console.log("resolved", v);
}
main();
console.log("spawned");
