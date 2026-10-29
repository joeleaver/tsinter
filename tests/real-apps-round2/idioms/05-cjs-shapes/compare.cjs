// `module.exports = <const bound to an arrow>` ('module.exports =' with a non-literal value)
const compare = (a, b) => (a > b ? 1 : a < b ? -1 : 0);
module.exports = compare;
