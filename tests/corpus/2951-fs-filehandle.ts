// fs/promises open and the FileHandle methods: write, read at a position,
// stat (plain and bigint), sync/datasync, chmod, truncate, writeFile and
// readFile from the current position, the descriptor, close; every method
// on a closed handle rejects Node's 'file closed' Error (code EBADF), and a
// second close resolves. Fresh files each run: inode numbers and times
// print as relations, never as values.
import { constants, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dir = mkdtempSync(join(tmpdir(), "scr-fh-"));
const file = join(dir, "data.bin");

async function report<T>(what: string, p: Promise<T>): Promise<void> {
  try {
    await p;
    console.log(what, "resolved");
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    console.log(what, "rejected", err.name, err.code, err.message.split(dir).join("<dir>"));
  }
}

// The closed-handle Error's own properties, as Node's fsCall builds it:
// code EBADF and the method's syscall, no errno.
async function closed<T>(what: string, p: Promise<T>): Promise<void> {
  try {
    await p;
    console.log(what, "resolved");
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    console.log(what, err.name, err.message, err.code, err.syscall, err.errno, JSON.stringify(e));
  }
}

async function put(what: string, p: Promise<FileHandle>): Promise<void> {
  const f = await p;
  await f.write(what + ";");
  await f.close();
}

async function show(what: string, p: Promise<FileHandle>): Promise<void> {
  const f = await p;
  console.log(what, JSON.stringify(await f.readFile("utf8")));
  await f.close();
}

async function main(): Promise<void> {
  // "wx" creates; a second "wx" open of the same path rejects EEXIST
  const w: FileHandle = await open(file, "wx", 0o600);
  console.log(typeof w.fd, w.fd > 2, (statSync(file, { bigint: true }).mode & 0o777n).toString(8));
  const r1 = await w.write(Buffer.from("hello, "));
  console.log(r1.bytesWritten, r1.buffer.toString());
  const r2 = await w.write("world\n");
  console.log(r2.bytesWritten, r2.buffer);
  await w.writeFile("more text\n");
  await w.sync();
  await w.datasync();
  const ws = await w.stat();
  console.log(ws.isFile(), ws.size);
  await report("chmod -1", w.chmod(-1));
  await report("chmod 1.5", w.chmod(1.5));
  await report("chmod 2**32 + 0o600", w.chmod(2 ** 32 + 0o600));
  console.log((statSync(file, { bigint: true }).mode & 0o777n).toString(8));
  await w.chmod(0o644);
  console.log((statSync(file, { bigint: true }).mode & 0o777n).toString(8));
  await w.close();
  console.log(w.fd);
  await report("reopen wx", open(file, "wx"));

  // read at positions, then from the current one
  const h = await open(file);
  const buf = Buffer.alloc(8);
  const a = await h.read(buf, 0, 5, 0);
  console.log(a.bytesRead, a.buffer === buf, buf.subarray(0, a.bytesRead).toString());
  const b = await h.read(buf, 2, 6, 7);
  console.log(b.bytesRead, JSON.stringify(buf.subarray(2, 2 + b.bytesRead).toString()));
  const c = await h.read(buf, 0, 4, null);
  console.log(c.bytesRead, buf.subarray(0, 4).toString());
  // nullish offset / length take Node's defaults (offset 0, length the
  // rest of the buffer)
  const d1 = await h.read(buf, undefined, 4, 0);
  console.log(d1.bytesRead, buf.subarray(0, 4).toString());
  const d2 = await h.read(buf, null, 4, 1);
  console.log(d2.bytesRead, buf.subarray(0, 4).toString());
  const d3 = await h.read(buf, 0, undefined, 0);
  console.log(d3.bytesRead, buf.toString());
  const d4 = await h.read(buf, 2, null, 0);
  console.log(d4.bytesRead, JSON.stringify(buf.subarray(2).toString()));
  const tail = await h.readFile("utf8");
  console.log(JSON.stringify(tail));
  const end = await h.read(buf, 0, 8, 1000);
  console.log(end.bytesRead);
  const zero = await h.read(buf, 0, 0, 0);
  console.log(zero.bytesRead);
  const big = await h.stat({ bigint: true });
  console.log(typeof big.size, big.size, big.ino === statSync(file, { bigint: true }).ino);
  await report("read offset 9", h.read(buf, 9, 1, 0));
  await report("read length 9", h.read(buf, 0, 9, 0));
  await report("read offset -1", h.read(buf, -1, 1, 0));
  await report("read offset 1.5", h.read(buf, 1.5, 1, 0));
  await report("read offset Infinity", h.read(buf, Infinity, 1, 0));
  await report("read offset 2**32 + 1", h.read(buf, 2 ** 32 + 1, 1, 0));
  await report("read position Infinity", h.read(buf, 0, 1, Infinity));
  await report("read position 2**53", h.read(buf, 0, 1, 2 ** 53));
  await report("read position 1.5", h.read(buf, 0, 1, 1.5));
  await report("read position -2", h.read(buf, 0, 1, -2));
  await report("read position -1", h.read(buf, 0, 1, -1));
  await report("write to a read-only handle", h.write("x"));
  await h.close();

  // every method on a closed handle; a second close resolves
  await closed("stat after close", h.stat());
  await closed("read after close", h.read(buf, 0, 1, 0));
  await closed("write after close", h.write("x"));
  await closed("writeFile after close", h.writeFile("x"));
  await closed("readFile after close", h.readFile());
  await closed("sync after close", h.sync());
  await closed("datasync after close", h.datasync());
  await closed("chmod after close", h.chmod(0o600));
  await closed("truncate after close", h.truncate(0));
  await report("second close", h.close());
  console.log(h.fd);

  // "r+" and truncate; readFile as a Buffer
  const t = await open(file, "r+");
  await report("truncate 1.5", t.truncate(1.5));
  await report("truncate NaN", t.truncate(NaN));
  console.log((await t.stat()).size);
  await t.truncate(5);
  const rb = await t.readFile();
  console.log(rb.length, rb.toString());
  await t.truncate(3);
  console.log((await t.stat()).size);
  await t.truncate(-1);
  console.log((await t.stat()).size);
  await t.write("abcdef");
  console.log((await t.stat()).size);
  await t.truncate(undefined);
  console.log((await t.stat()).size);
  const d5 = await t.read(Buffer.alloc(3));
  console.log(d5.bytesRead);
  const ne = await open(file);
  const neBuf = await ne.readFile({ encoding: null });
  console.log(neBuf.length, neBuf.toString());
  await ne.close();
  await t.close();

  // numeric flags from fs.constants
  const n = await open(join(dir, "num.txt"), constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC, 0o640);
  await n.write("numeric\n");
  await n.close();
  const nr = await open(join(dir, "num.txt"), constants.O_RDONLY);
  console.log(JSON.stringify(await nr.readFile("utf8")), (statSync(join(dir, "num.txt"), { bigint: true }).mode & 0o777n).toString(8));
  await nr.close();

  // Node's other flag spellings: rs/sr, rs+/sr+ read (synchronously);
  // xw, xw+, xa, xa+ create exclusively; as/sa, as+/sa+ append synchronously
  await put("xw", open(join(dir, "xw.txt"), "xw"));
  await put("xw+", open(join(dir, "xw2.txt"), "xw+"));
  await put("xa", open(join(dir, "xa.txt"), "xa"));
  await put("xa+", open(join(dir, "xa2.txt"), "xa+"));
  await put("as", open(join(dir, "as.txt"), "as"));
  await put("sa", open(join(dir, "as.txt"), "sa"));
  await put("as+", open(join(dir, "as.txt"), "as+"));
  await put("sa+", open(join(dir, "as.txt"), "sa+"));
  await report("xw again", open(join(dir, "xw.txt"), "xw"));
  await report("xa again", open(join(dir, "xa.txt"), "xa"));
  await show("rs", open(join(dir, "as.txt"), "rs"));
  await show("sr", open(join(dir, "as.txt"), "sr"));
  await show("rs+", open(join(dir, "xw.txt"), "rs+"));
  await show("sr+", open(join(dir, "xa.txt"), "sr+"));

  // a file whose stat size is 0 reads to its end
  const pv = await open("/proc/version");
  const pvText = await pv.readFile("utf8");
  console.log(statSync("/proc/version").size, pvText.length > 10, pvText.startsWith("Linux version"));
  await pv.close();

  // open failures reject with the path
  await report("open missing", open(join(dir, "missing.txt")));
  await report("open dir for write", open(dir, "w"));
  writeFileSync(join(dir, "plain.txt"), "plain");
  await report("bad flags", open(join(dir, "plain.txt"), "rw"));
  rmSync(dir, { recursive: true, force: true });
}
void main();
