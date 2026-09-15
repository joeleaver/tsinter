// s.matchAll(/re/g): every match as its honest string[] slice (match's
// rule — [whole, ...captures], nonparticipating captures read ""), in
// the two lowered consumer shapes: the immediate [...spread] + map (the
// portless plist scraper) and the direct for-of walk. Empty matches
// advance one position (the spec's AdvanceStringIndex). A non-global
// regex throws Node's exact TypeError, catchably.
const block = "<key>PATH</key> <string>/usr/bin</string>\n<key>HOME</key> <string>/root</string>";

const strings = [...block.matchAll(/<string>([\s\S]*?)<\/string>/g)].map((match) => match[1]);
console.log(strings.length, strings.join("|"));

for (const match of block.matchAll(/<key>([\s\S]*?)<\/key>\s*<string>([\s\S]*?)<\/string>/g)) {
  console.log(match.length, match[0].length, match[1], match[2]);
}

// No match drains to the empty array; empty matches advance.
console.log([...("abc".matchAll(/x/g))].length);
const empties = [...("ab".matchAll(/z?/g))];
console.log(empties.length);

// A nonparticipating capture reads "" where Node's slot is undefined —
// match's documented honest-slice divergence, shared here; the corpus
// prints it through ?? so both worlds agree on the observable.
for (const m of "a1 b".matchAll(/([ab])(\d)?/g)) {
  console.log(`[${m[0]}|${m[1]}|${(m[2] as string | undefined) ?? ""}]`);
}

// The non-global form throws Node's exact TypeError.
const re = /never-global/;
try {
  "x".matchAll(re);
  console.log("no-throw");
} catch (e) {
  console.log("caught", e instanceof TypeError, (e as Error).message);
}
