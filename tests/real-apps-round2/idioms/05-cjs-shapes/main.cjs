// Queue #4 (4 apps / 143 sites, semver alone 131): CommonJS module shapes semver uses in every file.
const compare = require("./compare.cjs");
const Range = require("./range.cjs");
console.log(compare(2, 1), new Range("x").test(), typeof Range.ANY);
