// Queue #6 (7 apps / 41 sites + probes): everyday stdlib members with no lowering on the static tier.
const xs = [10, 9, 1, 100];
console.log(xs.slice().reverse().join(","));          // number[].reverse
console.log(xs.slice().sort().join(","));             // sort() with 0 arguments on numbers
console.log(["a", "b"].join());                       // join() with 0 arguments
console.log((255).toString(16), (8).toString(2));     // number toString(radix): SC2012 "dynamic engine"
console.log((1234.5).toPrecision(3), (1234.5).toExponential(2));
const ls = ["a", "c"];
ls.splice(1, 0, "b");                                 // splice with 3 arguments
console.log(ls.join(""), "a\tb\tc".split("\t", 2).join("|"), "abcdef".substr(1, 3));
console.log([1, [2, [3]]].flat(2).length);
