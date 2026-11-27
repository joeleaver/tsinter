// U8 e5: an ES5 constructor's instances, 4 prototype-method reads per record
function P(i) { this.a = i; this.b = i * 2; this.c = i + 1; this.d = i % 7; }
P.prototype.f = function () { return 1; };
P.prototype.g = function () { return 2; };
P.prototype.h = function () { return 3; };
P.prototype.k = function () { return 4; };
const xs = [];
for (let i = 0; i < 1000; i++) xs.push(new P(i));
const n = xs.length;
let s = 0;
for (let r = 0; r < 5000; r++) for (let i = 0; i < n; i++) { const p = xs[i]; if (p.f !== undefined) s++; if (p.g !== undefined) s++; if (p.h !== undefined) s++; if (p.k !== undefined) s++; }
console.log(s);
