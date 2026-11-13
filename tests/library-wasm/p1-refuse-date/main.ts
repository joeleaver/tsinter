export function run(): void {
  const t = Date.now();
  if (t < 0) throw new Error("x");
}
