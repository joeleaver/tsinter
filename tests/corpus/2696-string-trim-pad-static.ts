// trimStart/trimEnd/padStart/padEnd, static (no island): the exact JS
// whitespace set one-sided, pad targets around the length, the omitted
// fill's " " default, and multi-unit fills the target truncates.
const s = "\t\r\n hi \n\r\t";
console.log("[" + s.trimStart() + "]");
console.log("[" + s.trimEnd() + "]");
console.log(("[" + "  x ﻿".trimEnd() + "]").length, " x ".trimStart().length);
console.log("[" + "​zwsp​".trimEnd() + "]"); // ZERO WIDTH SPACE is NOT JS whitespace
console.log("".trimStart().length, "   ".trimEnd().length);
console.log("5".padStart(3, "0"), "5".padEnd(3, "0"), "7".padStart(3));
console.log("[" + "ab".padEnd(5) + "]", "[" + "ab".padStart(5) + "]");
console.log("wide".padEnd(2, "-"), "wide".padStart(0, "-"), "x".padEnd(1, "-"));
console.log("v".padStart(6, "ab"), "v".padEnd(6, "ab"), "ab".padStart(7, "xyz"));
console.log("".padEnd(4, "ab"), "".padStart(3, "xyz"));
// Unicode fills and receivers: UTF-16 unit counts, not bytes.
console.log("é".padStart(4, "é"), "世".padEnd(3, "界"), "日本".padStart(5, "語"));
console.log("😀".padEnd(4, "!").length, "😀".padEnd(4, "!"));
console.log("x".padStart(5, "🌍").length); // whole astral reps fit: 2+2+1
// Table alignment — the composed everyday shape.
const labels = ["Input", "Cache write"];
const cents = [3, 30];
for (let i = 0; i < labels.length; i++) {
  console.log(labels[i].padEnd(14) + String(cents[i]).padStart(4, "0"));
}
