const out: (number | undefined)[] = [];
out[4] = 7;
console.log(out.length);
const m = new Map<string, number>([["k", 1]]);
console.log([m.get("k"), m.get("nope")].map((v) => v ?? -1).join(","));
