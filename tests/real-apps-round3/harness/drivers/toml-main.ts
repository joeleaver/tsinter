// A TOML CLI over smol-toml 1.9.1's own TypeScript source (imports rewritten .js -> .ts):
//   main.ts json <file>        parse, print as JSON (2-space)
//   main.ts roundtrip <file>   parse, stringify, re-parse; print the TOML and whether the two parses agree
//   main.ts stats <file>       count tables / arrays / strings / numbers / booleans / dates
//   main.ts errors             a fixed list of malformed documents and the TomlError each raises
import { readFileSync } from "node:fs";
import { parse, stringify, TomlError, TomlDate } from "./src/index.ts";

const args = process.argv.slice(2);

function read(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch (e) {
    console.error(`cannot read ${file}: ${(e as Error).message.split(",")[0]}`);
    process.exit(1);
  }
}

function stats(v: unknown, c: Record<string, number>): void {
  if (v instanceof TomlDate) c["dates"]++;
  else if (Array.isArray(v)) {
    c["arrays"]++;
    for (const x of v) stats(x, c);
  } else if (typeof v === "object" && v !== null) {
    c["tables"]++;
    for (const k of Object.keys(v)) {
      c["keys"]++;
      stats((v as Record<string, unknown>)[k], c);
    }
  } else if (typeof v === "string") c["strings"]++;
  else if (typeof v === "number" || typeof v === "bigint") c["numbers"]++;
  else if (typeof v === "boolean") c["booleans"]++;
}

const cmd = args[0];
if (cmd === "json" || cmd === "roundtrip" || cmd === "stats") {
  const text = read(args[1]!);
  if (text !== undefined) {
    const doc = parse(text);
    if (cmd === "json") console.log(JSON.stringify(doc, null, 2));
    else if (cmd === "stats") {
      const c: Record<string, number> = { tables: 0, keys: 0, arrays: 0, strings: 0, numbers: 0, booleans: 0, dates: 0 };
      stats(doc, c);
      console.log(Object.keys(c).map((k) => `${k}=${c[k]}`).join(" "));
    } else {
      const out = stringify(doc);
      console.log(out);
      console.log("roundtrip equal:", JSON.stringify(parse(out)) === JSON.stringify(doc));
    }
  }
} else if (cmd === "errors") {
  const bad = ["a = ", "a = 1\na = 2", "[t]\n[t]", "s = \"unterminated", "x = 1979-13-45", "arr = [1, 2", "k = {a = 1,}", "= 3", "n = 0x", "b = tru", "[a.b]\nc = 1\n[a]\nb = 2"];
  for (const t of bad) {
    try {
      const v = parse(t);
      console.log(JSON.stringify(t), "parsed", JSON.stringify(v));
    } catch (e) {
      if (e instanceof TomlError) console.log(JSON.stringify(t), `line=${e.line} col=${e.column}`, e.message.split("\n")[0]);
      else throw e;
    }
  }
} else {
  console.error("usage: json|roundtrip|stats <file> | errors");
  process.exit(2);
}
