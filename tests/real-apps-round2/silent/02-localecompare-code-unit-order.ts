// String.prototype.localeCompare in static code: Node collates with ICU (case-insensitive first, accents second)
console.log("a".localeCompare("B"), "B".localeCompare("a"), "é".localeCompare("f"), "a".localeCompare("A"));
console.log(["b", "a", "C", "é", "E"].sort((x, y) => x.localeCompare(y)).join(","));
