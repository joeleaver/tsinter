// U8 poly4: the b2 loop with one read site seeing 4 shapes
const parts: string[] = [];
const sh = ['{"a":#,"b":1,"c":2,"d":$}', '{"b":1,"a":#,"c":2,"d":$}', '{"a":#,"b":1,"c":2,"d":$,"e":0}', '{"d":$,"c":2,"b":1,"a":#}'];
for (let i = 0; i < 1000; i++) parts.push(sh[i % 4]!.replace("#", String(i)).replace("$", String(i % 7)));
const text = "[" + parts.join(",") + "]";
const xs: any = JSON.parse(text);
let s = 0;
for (let r = 0; r < 5000; r++) for (let i = 0; i < xs.length; i++) { const p = xs[i]; const a: number = p.a, b: number = p.b, c: number = p.c, d: number = p.d; s += a + b + c + d; }
console.log(s);
