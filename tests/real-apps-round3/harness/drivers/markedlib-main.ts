// Markdown through marked 18.1.2 as published (minified ESM, --npm-static marked):
//   main.ts <file.md> [--tokens] [--no-gfm]
import { marked } from "marked";
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const text = readFileSync(args[0]!, "utf8");
if (args.includes("--tokens")) {
  for (const t of marked.lexer(text)) console.log(t.type, JSON.stringify(t.raw.slice(0, 40)));
} else {
  process.stdout.write(marked.parse(text, { gfm: !args.includes("--no-gfm"), async: false }) as string);
}
