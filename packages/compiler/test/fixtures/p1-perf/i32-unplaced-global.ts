// P1 review: a binding no write ever placed (its only write reads itself)
// is unknown to its readers, not empty — module globals.
let s: number;
function step(): void { s = ((s | 0) + 1) | 0; }
let y = 0;
function show(): void { step(); y = s + 1; }
show();
show();
console.log(y);
