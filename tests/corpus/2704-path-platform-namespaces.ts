// path.posix and path.win32 through the namespace import — the
// platform-specific namespaces answer THEIR platform's rules on any host
// (Node behaves identically on darwin/linux/win32 here, so the oracle is
// exact). posix.join IS path.join (POSIX semantics are the pinned
// default); win32.join is Node's win32 join+normalize: backslash output,
// both slashes recognized on input, UNC prefixes preserved, drive-letter
// roots, dot-segment resolution.
import * as path from "node:path";

// posix.join — the defaultStateDir idiom (service.ts).
console.log(path.posix.join("/Users/me", ".portless"));
console.log(path.posix.join("/var", "state//", "..", "log", "./service.log"));
console.log(path.posix.join("relative", "bits"));
console.log(path.posix.join("", ""));

// win32.join — the buildWindowsScript idioms (programData paths).
console.log(path.win32.join("C:\\ProgramData", "portless", "service"));
console.log(path.win32.join("C:/ProgramData", "portless/service", "portless-service.cmd"));
console.log(path.win32.join("C:\\Users\\me", ".portless"));
console.log(path.win32.join("relative", "parts", "here"));
console.log(path.win32.join("a", "..", "b", ".", "c"));
console.log(path.win32.join("..", "..", "up"));
console.log(path.win32.join("C:\\", "windows\\..\\temp\\", ""));
console.log(path.win32.join("\\\\server", "share", "folder"));
console.log(path.win32.join("\\\\server\\share", "file.txt"));
console.log(path.win32.join("/", "/foo", "bar/"));
console.log(path.win32.join("C:", "file.txt"));
console.log(path.win32.join(""));
console.log(path.win32.join("", ""));
console.log(path.win32.join(".", "x"));

// The platform constants answer their own platform.
console.log(path.sep, path.delimiter);
console.log(path.posix.sep, path.posix.delimiter);
console.log(path.win32.sep === "\\", path.win32.delimiter);
