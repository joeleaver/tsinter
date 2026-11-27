// U8 len: i < xs.length on an any-held array, empty body (U8a's length cost)
const parts: string[] = [];
for (let i = 0; i < 1000; i++) parts.push('{"a":' + i + '}');
const xs: any = JSON.parse("[" + parts.join(",") + "]");
let s = 0;
for (let r = 0; r < 5000; r++) for (let i = 0; i < xs.length; i++) { s++; }
console.log(s);
