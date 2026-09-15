// spawn's option slice: stdio "inherit" (the child writes the parent's
// own fds — the parent's earlier output flushes first), env REPLACEMENT,
// cwd, detached (the child gets its own process group: pgid == its pid),
// and { stdio: "ignore", detached: false } (the mdns publisher shape)
// with the spawn-failure "error" event intact.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dir = mkdtempSync(join(tmpdir(), "scr-spawn-"));
console.log("before children");

// detached: the child leads its own process group, so the pgid ps
// reports equals the child's own pid. It records the answer in a file
// the parent reads after the exit event (no output interleave to race).
const recorder = spawn("sh", ["-c", `ps -o pgid= -p $$ > ${join(dir, "pgid.txt")}; echo "$PWD $FOO" > ${join(dir, "env.txt")}`], {
  stdio: "ignore",
  detached: true,
  cwd: "/",
  env: { PATH: "/bin:/usr/bin", FOO: "flag" },
});
recorder.on("exit", (code) => {
  console.log(`recorder exit: ${code}`);
  const pgid = readFileSync(join(dir, "pgid.txt"), "utf-8").trim();
  console.log("own group:", pgid === `${recorder.pid}`);
  console.log("env+cwd:", readFileSync(join(dir, "env.txt"), "utf-8").trim());
  rmSync(dir, { recursive: true, force: true });

  // inherit: the child's writes land on the parent's stdout, after
  // everything the parent logged before the spawn.
  const echo = spawn("sh", ["-c", "echo from-child"], { stdio: "inherit", detached: false });
  echo.on("exit", (code2) => {
    console.log(`echo exit: ${code2}`);
  });
});

// The mdns publisher shape: ignore + detached: false, error event on a
// missing binary (fires instead of exit, code stamped).
const ghost = spawn("definitely-not-a-binary-xyz", ["publish"], { stdio: "ignore", detached: false });
ghost.on("error", (err) => {
  console.log(`ghost error: ${(err as NodeJS.ErrnoException).code}`);
});
console.log("after spawns");
