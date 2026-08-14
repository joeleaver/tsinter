// The async analog of 2683: a catch nested between the suspending inner
// finally and an outer finally. The same nesting-order question, on the
// promise-rejecting lane — the near-miss here is silent: skipping the
// catch does not trap, it just rejects where Node resolves.
function tick(): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(() => {
      resolve();
    }, 1);
  });
}
async function f(): Promise<string> {
  try {
    try {
      try {
        await tick();
        throw new Error("boom");
      } finally {
        await tick();
        console.log("inner-fin");
      }
    } catch (e) {
      console.log("caught:" + (e as Error).message);
    }
  } finally {
    await tick();
    console.log("outer-fin");
  }
  return "end";
}
async function main(): Promise<void> {
  try {
    console.log("resolved", await f());
  } catch (e) {
    if (e instanceof Error) console.log("rejected", e.message);
  }
}
main();
console.log("spawned");
