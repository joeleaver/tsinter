// Paused-mode consumption: 'readable' scheduling, read(n) slicing across
// chunk boundaries, read() draining the rest, unshift putting bytes back,
// and read() answering null at EOF before 'end' fires. Also the size-arg
// coercion matrix (D1/D4): a bare read() (NaN, "the whole buffer"), a
// negative/non-integer/non-finite explicit size, and a variable size — one
// fresh 4-byte stream per case so a consuming read never shadows the next
// line's expectation.
import { Readable } from "node:stream";

const r = new Readable({ read() {} });
r.push("abcd");
r.push("efgh");
let turns = 0;
r.on("readable", () => {
  turns++;
  let c: Buffer | null;
  while ((c = r.read(3)) !== null) {
    console.log("read3:", c.toString());
    if (turns === 1 && c.toString() === "abc") {
      r.unshift(Buffer.from("AB"));
      console.log("unshifted, length:", r.readableLength);
    }
  }
  const rest = r.read();
  console.log("rest:", rest === null ? "null" : rest.toString());
});
r.on("end", () => console.log("end"));
r.push(null);
console.log("tail");

const s1 = new Readable({ read() {} });
s1.push("abcd");
const v1: Buffer | null = s1.read(-1);
console.log("read(-1):", v1 === null ? "null" : v1.toString(), "len:", s1.readableLength);

const s2 = new Readable({ read() {} });
s2.push("abcd");
const v2: Buffer | null = s2.read(0);
console.log("read(0):", v2 === null ? "null" : v2.toString(), "len:", s2.readableLength);

const s3 = new Readable({ read() {} });
s3.push("abcd");
const v3: Buffer | null = s3.read(1.5);
console.log("read(1.5):", v3 === null ? "null" : v3.toString(), "len:", s3.readableLength);

const s4 = new Readable({ read() {} });
s4.push("abcd");
const v4: Buffer | null = s4.read(2.9);
console.log("read(2.9):", v4 === null ? "null" : v4.toString(), "len:", s4.readableLength);

const s5 = new Readable({ read() {} });
s5.push("abcd");
const v5: Buffer | null = s5.read(3.999);
console.log("read(3.999):", v5 === null ? "null" : v5.toString(), "len:", s5.readableLength);

const s6 = new Readable({ read() {} });
s6.push("abcd");
const v6: Buffer | null = s6.read(Infinity);
console.log("read(Infinity):", v6 === null ? "null" : v6.toString(), "len:", s6.readableLength);

const s7 = new Readable({ read() {} });
s7.push("abcd");
const v7: Buffer | null = s7.read(-Infinity);
console.log("read(-Infinity):", v7 === null ? "null" : v7.toString(), "len:", s7.readableLength);

const s8 = new Readable({ read() {} });
s8.push("abcd");
const v8: Buffer | null = s8.read(NaN);
console.log("read(NaN):", v8 === null ? "null" : v8.toString(), "len:", s8.readableLength);

const s9 = new Readable({ read() {} });
s9.push("abcd");
let vsize = 2.5;
const v9: Buffer | null = s9.read(vsize);
console.log("read(var=2.5):", v9 === null ? "null" : v9.toString(), "len:", s9.readableLength);

const s10 = new Readable({ read() {} });
s10.push("abcd");
const v10: Buffer | null = s10.read();
console.log("read():", v10 === null ? "null" : v10.toString(), "len:", s10.readableLength);
