// Statement-position `void e` — the fire-and-forget idiom (`void poll();`,
// `void main();`): the operand evaluates for effect, the undefined result is
// discarded. Value-position `void` stays fenced.
let n = 0;
function bump(): number {
  n += 1;
  return n;
}
async function tick(label: string): Promise<void> {
  console.log(label, bump());
}
void bump();
void tick("tick");
void (n += 10);
console.log("n =", n);
async function main(): Promise<void> {
  await tick("awaited");
  console.log("done", n);
}
void main();
