// @ts-nocheck
// GH #111: the export statement runs after hoisting, so it exports the
// LAST declaration of the function, as every reader in the module sees.
function greet() { return "hello"; }
exports.greet = greet;
module.exports.local = function () { return greet(); };
function greet() { return "hi"; }
