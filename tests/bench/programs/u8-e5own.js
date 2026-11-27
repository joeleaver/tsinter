// U8 e5own: the e5 loop reading the instances' own keys (e5's reference)
function P(i) { this.a = i; this.b = i * 2; this.c = i + 1; this.d = i % 7; }
P.prototype.f = function () { return 1; };
P.prototype.g = function () { return 2; };
P.prototype.h = function () { return 3; };
P.prototype.k = function () { return 4; };
const xs = [];
for (let i = 0; i < 1000; i++) xs.push(new P(i));
const n = xs.length;
let s = 0;
for (let r = 0; r < 5000; r++) for (let i = 0; i < n; i++) { const p = xs[i]; if (p.a !== undefined) s++; if (p.b !== undefined) s++; if (p.c !== undefined) s++; if (p.d !== undefined) s++; }
console.log(s);
