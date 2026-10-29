// Queue #10 (2 apps / 147 sites: every peggy/pegjs-generated parser): functions read a `var` declared
// later in the same scope; the functions only run after the var is initialized (SC1030, deferred).
function parse(input) {
  function peg$parseDigit() {
    if (input.charCodeAt(peg$currPos) >= 48) return input[peg$currPos++];
    return null;
  }
  var peg$currPos = 0;
  const out = [];
  let d;
  while ((d = peg$parseDigit()) !== null) out.push(d);
  return out.join("");
}
console.log(parse("123"));
