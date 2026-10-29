// Files (node-only: a browser has no file system): write, read back and delete small files.
// @bench-node-only
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tsinter-bench-"));
let total = 0;
for (let i = 0; i < 3000; i++) {
  const p = path.join(dir, `f${i % 50}.txt`);
  fs.writeFileSync(p, `line ${i}\n`.repeat(20));
  total += fs.readFileSync(p, "utf8").length;
}
fs.rmSync(dir, { recursive: true, force: true });
console.log(total);
