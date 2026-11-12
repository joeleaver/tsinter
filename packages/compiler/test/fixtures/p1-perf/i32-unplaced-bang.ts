// P1 review: a never-assigned definite-assignment binding read into int32
// bindings (only through ToInt32 here: a bare read of one is GH #195,
// pre-existing).
let g!: number;
let gy = 0;
function fg(): void { gy = (g | 0) + 1; gy = (gy & 7) * 3; }
fg();
function f(): number {
  let x!: number;
  let y = 0;
  let k = 0;
  for (let i = 0; i < 3; i++) { y = (x | 0) + i; k = (x >>> 0) + (y << 1); }
  return y * 10 + k;
}
console.log(gy, f(), (g | 0) === 0);
