// A variadic callback — a function reading `arguments`, or a rest
// parameter — handed to a builtin receives EVERY argument Node passes:
// element, index and array for the array iteration methods (the
// accumulator first for reduce/reduceRight), both operands for a sort
// comparator. GH #22: `arguments.length` used to read 0. (Reading an
// object or array argument through `arguments` refuses by name — it
// would be a copy here; these callbacks read only the count and the
// scalar positions.)
'use strict';
const xs = [10, 20, 30];
console.log(xs.map(function () { return arguments.length + ':' + arguments[0] + ':' + arguments[1]; }).join(' '));
console.log(xs.map((...a) => a.length).join(','));
console.log(xs.filter(function () { return arguments[1] !== 1; }).join(','));
xs.forEach(function () { console.log('each', arguments.length, arguments[0], arguments[1], arguments[3]); });
xs.forEach((...a) => console.log('rest', a.length));
console.log(xs.find(function () { return arguments[1] === 2; }));
console.log(xs.findIndex(function () { return arguments.length === 3 && arguments[0] === 20; }));
console.log(xs.some(function () { return arguments.length === 3; }), xs.every((...a) => a.length === 3));
console.log(xs.reduce(function () { return arguments[0] + arguments.length; }, 0));
console.log(xs.reduce((...a) => a[0] + a.length));
console.log(xs.reduceRight(function () { return arguments[0] + arguments[2]; }, 0));
console.log(xs.flatMap(function () { return [arguments.length]; }).join(','));
console.log([3, 1, 2].sort(function () { return arguments.length === 2 ? arguments[0] - arguments[1] : 0; }).join(','));
function counted() { return arguments.length; }
console.log([7, 8].map(counted).join(','), counted(1, 2), counted());
