/* process.stdin.setRawMode under a NON-TTY stdin (the harness pipes
 * stdio): Node's process.stdin is a Socket with no setRawMode member, so
 * the call throws the exact catchable TypeError — the portless exit-hook
 * wraps setRawMode(false) in try/catch and relies on it. Both arms (true
 * and false) throw identically off a pipe. The TTY arm (termios raw
 * mode) cannot run under a differential harness and is hand-verified. */
if (process.stdin.isTTY) {
  console.log("unexpected: harness stdin is a TTY");
} else {
  try {
    process.stdin.setRawMode(false);
    console.log("unexpected: setRawMode(false) returned");
  } catch (e) {
    if (e instanceof Error) console.log(`${e.name}: ${e.message}`);
  }
  try {
    process.stdin.setRawMode(true);
    console.log("unexpected: setRawMode(true) returned");
  } catch (e) {
    if (e instanceof Error) console.log(`${e.name}: ${e.message}`);
  }
  console.log("still alive");
}
