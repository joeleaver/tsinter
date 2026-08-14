// The async analog of 2680: an exception escaping through a SUSPENDING
// finally must reject the function's own promise — reraisePending's THROW
// arm is shared by both lanes, and this is what catchArm's own
// trueDefault already does for an ordinary uncaught exception; the true
// final exit has to match it exactly, not settle for restoring the
// exception cell alone.
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
    throw new Error("boom");
  } finally {
    await tick();
    console.log("finally ran");
  }
}
async function main(): Promise<void> {
  try {
    const v = await f();
    console.log("resolved", v);
  } catch (e) {
    if (e instanceof Error) console.log("rejected", e.message);
  }
  console.log("main done");
}
main();
console.log("spawned");
