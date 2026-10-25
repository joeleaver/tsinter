// the failure cause, through a checked conversion
async function main(): Promise<void> {
  try {
    await fetch("__REFUSED__");
  } catch (e) {
    const u: unknown = e;
    const c = (u as { cause: { name: string; code: string; message: string } }).cause;
    console.log("cause:", c.name, c.code, c.message.startsWith("connect ECONNREFUSED"));
  }
  try {
    await fetch("/rel");
  } catch (e) {
    const u: unknown = e;
    const c = (u as { cause: { name: string; code: string; message: string } }).cause;
    console.log("cause2:", c.name, c.code, c.message);
  }
}
main();
