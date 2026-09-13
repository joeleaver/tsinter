// ErrnoException.code — thrown fs (SEMANTICS.md S073) and kill
// (SEMANTICS.md S077) errors carry Node's `code` property now; exec's own
// case here is not yet a registered divergence (board #137). The errno
// name where Node stamps one, `undefined` where it doesn't (a plain new
// Error, a command that merely failed). The read types `string |
// undefined` and narrows like any env read; `e as NodeJS.ErrnoException`
// from an Error-narrowed
// catch binding is a no-op cast (the type maps to the same runtime
// Error).
import { readFileSync, mkdirSync, rmdirSync, writeFileSync, rmSync, mkdtempSync, statSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ENOENT: open
try {
  readFileSync("/definitely-nope-xyz", "utf8");
} catch (e) {
  if (e instanceof Error) {
    const errno = e as NodeJS.ErrnoException;
    console.log(`read: ${errno.code}`, errno.code === "ENOENT");
  }
}
// ENOENT: stat
try {
  statSync("/definitely-nope-xyz");
} catch (e) {
  if (e instanceof Error) {
    console.log(`stat: ${(e as NodeJS.ErrnoException).code}`);
  }
}
// EEXIST: mkdir over an existing path
const dir = mkdtempSync(join(tmpdir(), "scr-code-"));
try {
  mkdirSync(dir);
} catch (e) {
  if (e instanceof Error) {
    console.log(`mkdir: ${(e as NodeJS.ErrnoException).code}`);
  }
}
// ENOTEMPTY: rmdir of a non-empty directory
writeFileSync(join(dir, "f.txt"), "x");
try {
  rmdirSync(dir);
} catch (e) {
  if (e instanceof Error) {
    console.log(`rmdir: ${(e as NodeJS.ErrnoException).code}`);
  }
}
rmSync(dir, { recursive: true, force: true });

// execFileSync spawn failure: ENOENT; a plain command failure carries NO
// code (Node puts the exit status in .status, which stays unlowered).
try {
  execFileSync("definitely-not-a-binary-xyz", [], { encoding: "utf8", stdio: "pipe" });
} catch (e) {
  if (e instanceof Error) {
    console.log(`exec spawnfail: ${(e as NodeJS.ErrnoException).code}`);
  }
}
try {
  execFileSync("/bin/sh", ["-c", "exit 3"], { encoding: "utf8", stdio: "pipe" });
} catch (e) {
  if (e instanceof Error) {
    const errno = e as NodeJS.ErrnoException;
    console.log(`exec fail: ${errno.code}`, errno.code === undefined);
  }
}

// process.kill of a non-existent pid: ESRCH.
try {
  process.kill(999999999, "SIGTERM");
} catch (e) {
  if (e instanceof Error) {
    console.log(`kill: ${(e as NodeJS.ErrnoException).code}`);
  }
}

// A plain Error never has a code.
const plain = new Error("boom") as NodeJS.ErrnoException;
console.log(`plain: ${plain.code}`, plain.code === undefined);

// The spawn 'error' event's errnoException carries ENOENT too.
const child = spawn("definitely-not-a-binary-xyz", [], { stdio: "ignore" });
child.on("error", (err) => {
  console.log(`spawn error event: ${(err as NodeJS.ErrnoException).code}`);
});
console.log("main done");
