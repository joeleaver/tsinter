// The full stat record: statSync/lstatSync/fstatSync with { bigint: true }
// (BigIntStats: every numeric field a bigint, the *Ms times *Ns / 1000000n),
// plain fstatSync, and fs/promises stat/lstat. The files are made fresh each
// run, so inode numbers and times print as relations, never as values.
import { closeSync, fstatSync, lstatSync, mkdtempSync, openSync, rmSync, statSync, writeFileSync } from "node:fs";
import { lstat, stat } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dir = mkdtempSync(join(tmpdir(), "scr-bigstat-"));
const file = join(dir, "data.bin");
writeFileSync(file, "0123456789abcdef");
execFileSync("ln", ["-s", file, join(dir, "link")], { stdio: "pipe" });

const b = statSync(file, { bigint: true });
const n = statSync(file);
console.log(typeof b.size, b.size, b.size === BigInt(n.size), typeof b.ino, typeof b.dev);
console.log(b.isFile(), b.isDirectory(), b.isSymbolicLink(), b.isFIFO(), b.isSocket(), b.isBlockDevice(), b.isCharacterDevice());
console.log((b.mode & 0o170000n) === 0o100000n, b.nlink, b.blksize > 0n, b.blocks >= 0n, b.rdev);
console.log(b.mtimeMs === b.mtimeNs / 1000000n, b.atimeMs === b.atimeNs / 1000000n, b.ctimeMs === b.ctimeNs / 1000000n);
console.log(Number(b.mtimeMs) === Math.trunc(n.mtimeMs), b.mtimeNs > 0n, b.ctimeNs >= b.mtimeNs - 1000000000n);

const l = lstatSync(join(dir, "link"), { bigint: true });
const viaLink = statSync(join(dir, "link"), { bigint: true });
console.log(l.isSymbolicLink(), l.isFile(), viaLink.isFile(), viaLink.ino === b.ino, l.ino !== b.ino, l.dev === b.dev);
const plain = statSync(file, { bigint: false });
console.log(typeof plain.size, plain.size, plain.isFile());

const fd = openSync(file, "r");
const fb = fstatSync(fd, { bigint: true });
const fp = fstatSync(fd);
console.log(fb.ino === b.ino, fb.size, fp.size, fp.isFile(), fp.mtimeMs === n.mtimeMs);
closeSync(fd);

const d = statSync(dir, { bigint: true });
console.log(d.isDirectory(), d.isFile(), (d.mode & 0o170000n).toString(8));

try {
  statSync(join(dir, "missing"), { bigint: true });
} catch (e) {
  if (e instanceof Error) console.log((e as NodeJS.ErrnoException).code, e.message.replace(dir, "<dir>"));
}
try {
  lstatSync(join(dir, "missing"), { bigint: true });
} catch (e) {
  if (e instanceof Error) console.log((e as NodeJS.ErrnoException).code, e.message.replace(dir, "<dir>"));
}
for (const bad of [9999, -1, 1.5]) {
  try {
    fstatSync(bad, { bigint: true });
  } catch (e) {
    if (e instanceof Error) console.log(e.name, (e as NodeJS.ErrnoException).code, e.message);
  }
}

// Optional reads of a BigIntStats read the same bigints (review: they fell
// to the plain reader), on a definite and on a maybe-undefined receiver.
{
  const ob = statSync(file, { bigint: true });
  console.log(ob?.size, ob?.mtimeMs === ob.mtimeNs / 1000000n, ob?.size === 16n);
  const mb: import("node:fs").BigIntStats | undefined = file.length > 0 ? statSync(file, { bigint: true }) : undefined;
  console.log(mb?.size, mb?.blocks === ob.blocks, mb?.ino === ob.ino);
  const nb: import("node:fs").BigIntStats | undefined = file.length < 0 ? statSync(file, { bigint: true }) : undefined;
  console.log(nb?.size, nb?.mtimeMs);
}

async function main(): Promise<void> {
  const ps = await stat(file, { bigint: true });
  const pl = await lstat(join(dir, "link"), { bigint: true });
  const pn = await lstat(file);
  console.log(ps.ino === b.ino, ps.size, pl.isSymbolicLink(), pn.isFile(), pn.size);
  try {
    await lstat(join(dir, "missing"), { bigint: true });
  } catch (e) {
    if (e instanceof Error) console.log("rejected", (e as NodeJS.ErrnoException).code);
  }
  rmSync(dir, { recursive: true, force: true });
}
void main();
