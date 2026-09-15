// Optional callbacks typed `(...) => Promise<void> | void`: the caller must
// handle both arms at the await — parking on the promise arm, taking the
// one-microtask hop on the absent/void arm (await of a non-thenable). The
// background fiber's counter interleaves with each hook so the hop counts
// are pinned against Node tick-for-tick.
interface HookOpts {
  name: string;
  after?: (n: number) => Promise<void> | void;
}

async function pause(): Promise<void> {
  // One extra suspension so the returned promise is still PENDING when the
  // caller awaits it (the eager prefix runs to this await, then parks).
  await null_hop();
}

async function null_hop(): Promise<void> {}

async function slowHook(n: number): Promise<void> {
  console.log(`slow hook start ${n}`);
  await pause();
  console.log(`slow hook end ${n}`);
}

async function run(opts: HookOpts): Promise<void> {
  console.log(`${opts.name}: before`);
  await opts.after?.(7);
  console.log(`${opts.name}: after`);
}

async function background(rounds: number): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    console.log(`bg ${i}`);
    await null_hop();
  }
}

async function main(): Promise<void> {
  // Sync arrow returning the promise of an async call: the promise arm.
  const bg1 = background(4);
  await run({ name: "promise-arm", after: (n) => slowHook(n) });
  await bg1;

  // Sync arrow with a void block body: the void arm (one hop, no parking).
  const bg2 = background(4);
  await run({ name: "void-arm", after: (n) => { console.log(`sync hook ${n}`); } });
  await bg2;

  // Conditional returns: `Promise<void> | undefined` inferred — one call
  // takes the promise path, the other falls off the end (undefined arm).
  const mixed = (n: number) => {
    if (n > 5) return slowHook(n);
    console.log(`fast path ${n}`);
  };
  const bg3 = background(4);
  await run({ name: "mixed-promise", after: mixed });
  await bg3;
  await run({ name: "mixed-fast", after: (n) => mixed(n - 7) });

  // Bare `return;` inside a union-returning callback.
  await run({
    name: "bare-return",
    after: (n) => {
      if (n === 7) {
        console.log("bare return");
        return;
      }
      return slowHook(n);
    },
  });

  // Absent and explicitly-undefined hooks: the ?. short-circuit, still
  // awaited (one hop each).
  await run({ name: "absent" });
  await run({ name: "explicit-undefined", after: undefined });
}

main();
