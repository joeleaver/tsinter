// ToBoolean over the dyn: truthy/falsy tests on 'unknown' values are
// JS-exact for every kind — null/undefined false, numbers falsy for 0/-0/NaN,
// strings falsy when empty, objects/arrays always true.
for (const t of ["null", "0", "-0", "0.5", '"0"', "true", "false", '""', '"x"', "{}", "[]", '{"a":1}', "[0]"]) {
  const v: unknown = JSON.parse(t);
  if (v) console.log(t, "truthy");
  else console.log(t, "falsy");
  console.log(t, !v, !!v);
}
const u: unknown = undefined;
console.log(u ? "t" : "f");
const zero: unknown = JSON.parse("0");
const one: unknown = JSON.parse("1");
console.log(zero && one ? "and-t" : "and-f", zero || one ? "or-t" : "or-f");
while (zero) {
  console.log("never");
  break;
}
