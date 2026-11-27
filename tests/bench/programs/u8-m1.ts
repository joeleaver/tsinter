// U8 m1: the m loop on a typed object literal (m's typed reference)
const lib = { k: 1, add(x: number, y: number): number { return x + y; } };
let s = 0;
for (let r = 0; r < 5000; r++) for (let i = 0; i < 4000; i++) { const v: number = lib.add(s, i); s = v % 1000003; }
console.log(s);
