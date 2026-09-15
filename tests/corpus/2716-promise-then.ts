function slow(v: string, ms: number): Promise<string> {
  return new Promise<string>((resolve) => setTimeout(() => resolve(v), ms));
}
function failing(msg: string): Promise<string> {
  return new Promise<string>(() => {
    throw new Error(msg);
  });
}

async function main(): Promise<void> {
  // fulfilled path: the handler transforms the value
  const a = await slow("ok", 5).then((v) => v + "!");
  console.log("a:", a);
  // zero-param handler: the value settles first, then the handler runs
  const b = await slow("ignored", 5).then(() => "fixed");
  console.log("b:", b);
  // promise-returning handler flattens (the certs generate-then-read shape)
  const c = await slow("outer", 5).then((v) => slow(v + ":inner", 5));
  console.log("c:", c);
  // async handler: same flattening through the async return path
  const d = await slow("x", 5).then(async (v) => {
    const w = await slow(v + "y", 5);
    return w + "z";
  });
  console.log("d:", d);
  // rejection passes through .then untouched — the handler never runs
  const e = await failing("skipped")
    .then((v) => {
      console.log("never:", v);
      return "unreachable";
    })
    .catch((err) => {
      if (err instanceof Error) return "caught:" + err.message;
      return "caught:non-error";
    });
  console.log("e:", e);
  // a throwing handler rejects the combined result
  const f = await slow("fine", 5)
    .then((v): string => {
      throw new Error("handler-boom:" + v);
    })
    .catch((err) => {
      if (err instanceof Error) return err.message;
      return "non-error";
    });
  console.log("f:", f);
}
// more() sequences AFTER main through .then itself — deterministic
// interleaving regardless of timer granularity.
main().then(() => more());
console.log("top");

// statement position over Promise<void>: the pending-cache shape —
// then(cb) delivering the value into a callback, catch cleaning up
function work(n: number): Promise<number> {
  return new Promise<number>((resolve) => setTimeout(() => resolve(n * 2), 5));
}
const seen: number[] = [];
function deliver(v: number): void {
  seen.push(v);
}
async function more(): Promise<void> {
  work(21).then((v) => deliver(v));
  await slow("wait", 20);
  console.log("seen:", seen.join(","));
  // then over Promise<void>
  async function chore(): Promise<void> {
    await slow("c", 5);
    console.log("chore-done");
  }
  await chore().then(() => console.log("after-chore"));
}
