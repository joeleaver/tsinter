// process.arch — the binary's own architecture, the same answer Node
// gives for its own build on the same machine, so the raw value is
// oracle-comparable. process.versions.node reports the runtime's Node
// COMPATIBILITY TARGET (SEMANTICS.md S072) — the raw string
// differs from a live Node's patch level by design, so the corpus pins
// the DERIVED facts portless's doctor actually uses: the dotted shape and
// the major-version gate.
console.log(process.arch);
console.log(process.arch === "arm64" || process.arch === "x64");

const v = process.versions.node;
console.log(v.split(".").length);
const major = parseInt(v.split(".")[0]!, 10);
console.log(major >= 24);
console.log(Number.isNaN(major));

// The doctor's exact idiom: interpolate, then gate.
const line = `Node.js: ${v.length > 0 ? "present" : "missing"}`;
console.log(line);

// getuid/getgid — the POSIX identities (same user runs both worlds, so
// the raw values are oracle-comparable); the ?. spelling is the
// @types/node optionality and lowers as the plain call.
console.log(process.getuid?.() ?? -1, process.getgid?.() ?? -1);
