// npm-static pilot: the real fast-string-truncated-width@3.0.3 (vendored
// unmodified, pure ESM + own .d.ts; @clack/prompts measures every line it
// draws through it, and paperclip's start-up evaluates its module-level
// regexes) compiled STATICALLY. Its dist/index.js holds a multi-declarator
// `for (let i = 0, l = …; …)` and an array of [RegExp, any] pairs (its
// width options are untyped `{}` reads) read through destructuring, so its
// sticky /yu regexes cross into dynamic code and are driven there
// (lastIndex written and read, test), compared by identity against the
// typed regexes (`BLOCK_RE === CJKT_WIDE_RE`); utils.js holds a
// closure-held global regex. Byte-compared with Node.
import getStringTruncatedWidth from "fast-string-truncated-width";

const SAMPLES: string[] = [
  "",
  "hello world",
  "漢字かなカナ한글",
  "abc中文def",
  "ｱｲｳ half-width kana ！？　",
  "\u{17000}\u{20000}\u{2a6df}\u{30000}々〇",
  "\u{1f600}\u{1f44d}\u{1f44d}\u{1f3fd} \u{1f469}‍\u{1f4bb}",
  "\u{1f468}‍\u{1f469}‍\u{1f467}‍\u{1f466}!",
  "\u{1f1ef}\u{1f1f5}\u{1f1fa}\u{1f1f8}\u{1f1e6}",
  "\u{1f3f4}\u{e0067}\u{e0062}\u{e0065}\u{e006e}\u{e0067}\u{e007f} flag",
  "1️⃣#️⃣ ❤️ ☺️",
  "©®‼™ ⌚⌛〈⏰⭐〰〽㊗",
  "\x1b[31mred\x1b[0m\t\ttabs\x07\x7f",
  "\x1b]8;;https://example.com\x07link\x1b]8;;\x07 after",
  "mix: a一b\u{1f600}cあd가e\u{17000}f́g",
  "é̂ ñ कि ゙ー⿰︐︰",
  "│  Config file missing: /home/user/.paperclip/config.json",
  "┌  paperclip env",
  "\u{1f4ce} ✔ done ✘ failed ◆ ○ ●",
];

for (const s of SAMPLES) {
  const r = getStringTruncatedWidth(s);
  console.log(`${JSON.stringify(s)} ${r.width} ${r.index} ${r.truncated} ${r.ellipsed}`);
}
// Every prefix of a mixed line, as clack's wrapping measures them.
const line = "a一\u{1f600}あ가\u{17000}\x1b[1mB\x1b[0m\t́\u{1f1ef}\u{1f1f5}\u{1f44d}\u{1f3fd}z";
const widths: number[] = [];
for (let i = 0; i <= line.length; i++) widths.push(getStringTruncatedWidth(line.slice(0, i)).width);
console.log(widths.join(","));
