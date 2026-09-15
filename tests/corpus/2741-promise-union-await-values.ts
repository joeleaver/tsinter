// Awaiting `Promise<T> | undefined` values directly: the promise arm parks
// (or hops when already settled) and produces T, the undefined arm hops and
// produces undefined — `await` of a non-thenable is one microtask turn.
async function hop(): Promise<void> {}

async function fetchName(id: number): Promise<string> {
  console.log(`fetch start ${id}`);
  await hop();
  console.log(`fetch end ${id}`);
  return `name-${id}`;
}

async function readThrough(p: Promise<string> | undefined): Promise<string> {
  const got = await p;
  if (got === undefined) return "(miss)";
  return got;
}

async function background(tag: string): Promise<void> {
  for (let i = 0; i < 3; i++) {
    console.log(`${tag} ${i}`);
    await hop();
  }
}

async function main(): Promise<void> {
  // Pending promise arm: the awaiter parks until the fetch finishes.
  const bg1 = background("a");
  console.log(`hit: ${await readThrough(fetchName(1))}`);
  await bg1;

  // Undefined arm: one hop, value is undefined.
  const bg2 = background("b");
  console.log(`miss: ${await readThrough(undefined)}`);
  await bg2;

  // Union built by a ternary, both directions.
  let want = true;
  const maybe = (): Promise<string> | undefined =>
    want ? fetchName(2) : undefined;
  console.log(`ternary hit: ${await readThrough(maybe())}`);
  want = false;
  console.log(`ternary miss: ${await readThrough(maybe())}`);

  // The awaited result feeds a union-typed local (string | undefined).
  const direct: Promise<string> | undefined = fetchName(3);
  const value: string | undefined = await direct;
  console.log(`direct: ${value ?? "(none)"}`);

  // Already-settled promise arm: still exactly one hop, like Node.
  const settled: Promise<string> | undefined = fetchName(4);
  await hop();
  await hop();
  const bg3 = background("c");
  console.log(`settled: ${await settled}`);
  await bg3;

  // A rejecting promise arm re-throws at the await, catchable as usual.
  const failing = async (): Promise<string> => {
    await hop();
    throw new Error("boom");
  };
  const doomed: Promise<string> | undefined = failing();
  try {
    console.log(`never: ${await doomed}`);
  } catch (err) {
    if (err instanceof Error) console.log(`caught: ${err.message}`);
  }
}

main();
