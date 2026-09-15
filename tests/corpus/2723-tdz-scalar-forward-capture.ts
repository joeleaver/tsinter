// Scalar forward capture: a closure declared ABOVE a scalar const it
// captures (the ngrok settle/timer shape — `clearTimeout(timer)` inside a
// handler defined before `const timer = setTimeout(...)`). JS hoists the
// BINDING to scope entry (TDZ) and initializes it at the declaration; a
// read through the closure AFTER initialization sees the value, a read
// while the box is empty throws Node's exact catchable ReferenceError.
function settleShape(): Promise<string> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (v: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => settle("timeout"), 1000);
    setTimeout(() => settle("fast"), 5);
  });
}

async function main(): Promise<void> {
  console.log(await settleShape());

  // The number value itself round-trips through the box.
  const readNum = () => `${port}`;
  const port = 4321;
  console.log("port:", readNum());

  // Bool scalars take the same cell.
  const readFlag = () => (flag ? "on" : "off");
  const flag = true;
  console.log("flag:", readFlag());

  // A TDZ read BEFORE initialization: Node's exact ReferenceError, catchable.
  try {
    const early = () => count + 1;
    console.log("early:", early());
    const count = 7;
    void count;
  } catch (e) {
    console.log("tdz:", e instanceof Error ? `${e.name}: ${e.message}` : "?");
  }

  // Strings ride the pointer-backed path — same contract, mixed with the
  // scalar in one closure.
  const describe = () => `${label}:${size}`;
  const label = "big";
  const size = 42;
  console.log("mixed:", describe());
}

void main();
