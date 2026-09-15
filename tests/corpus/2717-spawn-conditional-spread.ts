// The platform-conditional detached idiom: `...(isWindows ? {} : {
// detached: true })` (and the carrying-arm-first orientation) inside
// spawn's options — the condition decides setsid at runtime. The child
// reports its own process group into a file; detached ⇔ pgid == pid.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dir = mkdtempSync(join(tmpdir(), "scr-spawn-cs-"));
const isWindows = process.platform === "win32";

const detachedChild = spawn("sh", ["-c", `ps -o pgid= -p $$ > ${join(dir, "a.txt")}`], {
  stdio: "ignore",
  ...(isWindows ? {} : { detached: true }),
});
detachedChild.on("exit", (code) => {
  console.log(`detached exit: ${code}`);
  const pgid = readFileSync(join(dir, "a.txt"), "utf-8").trim();
  console.log("own group:", pgid === `${detachedChild.pid}`);

  // The other orientation, condition false: stays attached — the child's
  // pgid is the parent's, not its own.
  const attached = spawn("sh", ["-c", `ps -o pgid= -p $$ > ${join(dir, "b.txt")}`], {
    stdio: "ignore",
    ...(isWindows ? { detached: true } : {}),
  });
  attached.on("exit", (code2) => {
    console.log(`attached exit: ${code2}`);
    const pgid2 = readFileSync(join(dir, "b.txt"), "utf-8").trim();
    console.log("shares group:", pgid2 !== `${attached.pid}`);
    rmSync(dir, { recursive: true, force: true });
  });
});
console.log("spawned");
