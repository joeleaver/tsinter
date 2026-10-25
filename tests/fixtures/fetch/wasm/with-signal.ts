// fetch beside a signal listener: one poll phase reads both sources
const onTerm = (): void => console.log("term");
process.on("SIGTERM", onTerm);
async function main(): Promise<void> {
  const r = await fetch("__BASE__/text");
  const t: string = await r.text();
  console.log("text", t);
  process.kill(process.pid, "SIGTERM");
  setTimeout(() => {
    process.off("SIGTERM", onTerm);
    console.log("off");
  }, 30);
}
main();
