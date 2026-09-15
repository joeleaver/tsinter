// String.raw — the one lowered template tag: the template's RAW text,
// escape sequences staying characters (the Windows-path idiom). Other tags
// keep the tagged-template fence.
console.log(String.raw`C:\Windows\System32\certutil.exe`);
console.log(String.raw`\n\t\\ stay three escapes`);
console.log(String.raw`plain text`);
console.log(String.raw``);

// Substitutions splice exactly like an untagged template, over raw spans.
const dir = "Temp";
console.log(String.raw`C:\Users\${dir}\file.txt`);
console.log(String.raw`${1 + 1} = two A raw`);
const who: string | number = "world";
console.log(String.raw`hello ${who}\!`);

// Raw text feeding string machinery downstream.
const p = String.raw`a\b\c`;
console.log(p.split("\\").join("/"), p.length);
console.log("done");
