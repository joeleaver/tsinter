// A string literal that BEGINS with a raw U+FEFF keeps it: the TS7 API
// decodes source text with a TextDecoder, which drops a leading byte-order
// mark from every decode unless told not to (board #219). Escaped and
// computed BOMs, and a BOM after a lone surrogate, for comparison.
const raw = "﻿";
const esc = "\uFEFF";
console.log(raw.length, raw.charCodeAt(0), raw === esc);
const lead = "﻿abc";
console.log(lead.length, lead.charCodeAt(0), lead.slice(1));
const tpl = `﻿t`;
console.log(tpl.length, tpl.charCodeAt(0));
const twice = "﻿﻿";
console.log(twice.length);
const afterSurrogate = "\uD800﻿";
console.log(afterSurrogate.length, afterSurrogate.charCodeAt(1));
const computed = String.fromCharCode(0xfeff) + "x";
console.log(computed === "﻿x", "﻿".trim().length);
const key: Record<string, number> = { "﻿k": 1 };
console.log(Object.keys(key)[0]!.length, key["\uFEFFk"]);
