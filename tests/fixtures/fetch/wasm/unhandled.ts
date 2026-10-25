// an unhandled fetch failure
async function main(): Promise<void> {
  await fetch("__REFUSED__");
}
main();
