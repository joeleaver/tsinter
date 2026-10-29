// localeCompare (SEMANTICS.md S120). What lowers: a.localeCompare(b), with
// the locales argument absent, undefined, "en" or "en-US" (Node's collation
// for those is the root one this tier carries) and the options argument
// absent or undefined; a const bound to an accepted tag, [] and a one-element
// list of one, and the case variants Intl canonicalizes ("EN-us") lower too.
// Everything else fences by NAME: another locale
// (CLDR tailors its order), a locale known only at run time, a list of two
// or more, a parameter that shadows `undefined`, and any options bag — even
// an empty one.
const plain = "a".localeCompare("b");
const en = "a".localeCompare("b", "en-US");
const swedish = "a".localeCompare("b", "sv");
const numeric = "a".localeCompare("b", "en-u-kn-true");
const loc = process.argv.length > 3 ? "de" : "en";
const runtime = "a".localeCompare("b", loc);
const list = "a".localeCompare("b", ["en", "fr"]);
const opts = "a".localeCompare("b", "en", { numeric: true });
const empty = "a".localeCompare("b", undefined, {});
console.log(plain, en, swedish, numeric, runtime, list, opts, empty);
