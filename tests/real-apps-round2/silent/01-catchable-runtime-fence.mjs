// A deferred (runtime) compile fence inside a user try/catch: Node runs the code; tsinter
// throws the fence as an ordinary Error the program's catch swallows -> exit 0, different stdout.
function parse(options) {
  return options.pos | 0; // SC2011: '|' on an any-typed value (deferred in a JS module)
}
let r;
try {
  r = parse({ pos: 7 });
} catch (e) {
  r = -1;
}
console.log("result", r);
