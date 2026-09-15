// Promise.all over a UNIFORM array literal — the portless
// generateHostCertAsync shape: the checker types `[readFile(a),
// readFile(b)]` as a TUPLE of promises, but with one shared Promise<T>
// the entries lower as Promise<T>[] and the result destructures exactly
// like the tuple. Also the void pair (fire-and-forget effects) and
// same-type string promises through a helper.
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dir = fs.mkdtempSync(join(tmpdir(), "scr-pall-"));
const certPath = join(dir, "cert.pem");
const keyPath = join(dir, "key.pem");
fs.writeFileSync(certPath, "CERT BYTES");
fs.writeFileSync(keyPath, "KEY BYTES");

async function readPair(): Promise<void> {
  const [hostCert, key] = await Promise.all([
    fs.promises.readFile(certPath),
    fs.promises.readFile(keyPath),
  ]);
  console.log("cert:", hostCert.toString("utf8"));
  console.log("key:", key.toString("utf8"));
  console.log("lengths:", hostCert.length, key.length);
}

async function delayed(v: string, ms: number): Promise<string> {
  return new Promise((resolve) => setTimeout(() => resolve(v), ms));
}

async function main(): Promise<void> {
  await readPair();
  const [x, y, z] = await Promise.all([delayed("one", 20), delayed("two", 5), delayed("three", 10)]);
  console.log(x, y, z);
  await Promise.all([
    fs.promises.writeFile(join(dir, "a.txt"), "A"),
    fs.promises.writeFile(join(dir, "b.txt"), "B"),
  ]);
  console.log("both written:", fs.readFileSync(join(dir, "a.txt"), "utf8"), fs.readFileSync(join(dir, "b.txt"), "utf8"));
  fs.rmSync(dir, { recursive: true, force: true });
  console.log("done");
}
main();
