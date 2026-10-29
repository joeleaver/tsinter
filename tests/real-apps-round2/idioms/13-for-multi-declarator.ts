// chess.js (8 sites): multi-declaration for-loop initializers.
const moves = [3, 1, 2];
let s = 0;
for (let i = 0, len = moves.length; i < len; i++) s += moves[i];
console.log(s);
