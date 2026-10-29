// An optional capture group that did not participate: Node's exec() gives undefined for it.
const m = /(a)(b)?(?<c>c)?/.exec("a")!;
console.log(m[2], m[2] === undefined, typeof m[2], m.length);
console.log(m.groups?.["c"], m.groups?.["c"] === undefined, typeof m.groups?.["c"]);
console.log(JSON.stringify(m.groups), `${m.groups!["c"]}`);
const all = [..."xa".matchAll(/x(y)?/g)];
console.log(all[0][1] === undefined, "x".match(/x(y)?/)![1] === undefined);
console.log("x".replace(/x(y)?/, (_m, g: string | undefined) => String(g === undefined)));
