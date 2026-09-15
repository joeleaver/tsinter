// String.raw over substitution-free templates folds at compile time:
// escape sequences stay verbatim (the Windows-path idiom).
const winPath = String.raw`C:\Windows\System32\certutil.exe`;
console.log(winPath);
console.log(String.raw`no escapes here`);
console.log(String.raw`tab\t newline\n unicodeA backslash\\ tick\``.length);
console.log(String.raw`\d+(\.\d+)?`);
