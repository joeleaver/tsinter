// The regex slice fences. (g/y regexes are stateful and compile since
// board #301 — lastIndex is modelled.) The d/v flags are outside the
// slice; .groups needs a statically-known regex (named capture groups
// themselves compile — corpus 2604); method-as-value has no value form;
// regexes stay out of union arms (ARRAYS of regexes compile — corpus
// 2448); an exec result's .index outside its binding's companions (here,
// a parameter, an alias) keeps its fence, and a global match()'s .index
// (Node: undefined) refuses.
const indices = /cat/d;
const sets = /[\p{L}]/v;
const asValue = /x/.test;
const maybe: RegExp | undefined = /a/;
function readGroups(re: RegExp): void {
  const m = re.exec("2024-07");
  if (m) console.log(m.groups);
}
readGroups(/(?<year>\d{4})/);
function indexOf(m: RegExpExecArray): number {
  return m.index;
}
console.log(indexOf(/b/.exec("ab")!));
const k = /a/.exec("a");
const alias = k;
if (alias) console.log(alias.input);
const every = "aa".match(/a/g);
if (every) console.log(every.index);
