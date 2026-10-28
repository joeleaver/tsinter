// `arguments.length` cannot fold to the declared count in a function
// that is also reachable as a value: Array.prototype.map passes element,
// index and array (Node prints 3,3), and a function declaration passed
// as a callback gets the same. Refused by name, never a silent 0 (GH #22).
console.log([1, 2].map(function () { return arguments.length; }).join(","));
function direct(): number { return arguments.length; }
console.log(direct(), [7].map(direct).join(","));
