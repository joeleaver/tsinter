// os.release() — uname(2)'s release field, byte-identical to Node's on
// the same kernel — and spawnSync's runtime-string stdio: the
// defaultRunner idiom (`stdio: options?.stdio ?? "pipe"`), where the
// VALUE arrives at the call and the type proves it is a supported
// literal.
import * as os from "node:os";
import { spawnSync } from "node:child_process";

console.log(os.release());
console.log(os.release() === os.release(), os.release().length > 0);

function run(command: string, args: string[], options?: { stdio?: "pipe" | "inherit" }) {
  return spawnSync(command, args, {
    encoding: "utf-8",
    stdio: options?.stdio ?? "pipe",
  });
}

const piped = run("/bin/sh", ["-c", "echo captured-line"]);
console.log(piped.status ?? -1, JSON.stringify(piped.stdout));
const explicit = run("/bin/sh", ["-c", "echo explicit-pipe"], { stdio: "pipe" });
console.log(explicit.status ?? -1, JSON.stringify(explicit.stdout));
// inherit: the child's output lands on OUR stdout, ordering with the
// parent's own logs preserved. (The uncaptured stdout FIELD reads ""
// here where Node reads null — the documented spawnSync stance — so the
// corpus prints only the status.)
console.log("before-inherit");
const inherited = run("/bin/sh", ["-c", "echo inherited-line"], { stdio: "inherit" });
console.log("after-inherit", inherited.status ?? -1);

