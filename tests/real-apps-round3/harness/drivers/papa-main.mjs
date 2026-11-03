// A CSV CLI over papaparse 5.7.0 as published (UMD JS, built with --npm-static papaparse):
//   main.mjs <file.csv> [--header] [--dynamic-typing]   parse, print meta, first rows and last row
//   main.mjs unparse                                     two fixed unparse calls
import Papa from "papaparse";
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
if (args[0] === "unparse") {
  console.log(Papa.unparse([{ a: 1, b: "x,y" }, { a: 2, b: 'q"uote' }, { a: 3, b: "multi\nline" }]));
  console.log(Papa.unparse({ fields: ["x", "y"], data: [[1, 2], [3, null]] }, { quotes: true, delimiter: ";" }));
} else {
  const text = readFileSync(args[0], "utf8");
  const r = Papa.parse(text, { header: args.includes("--header"), dynamicTyping: args.includes("--dynamic-typing"), skipEmptyLines: true });
  console.log(`rows=${r.data.length} errors=${r.errors.length} fields=${JSON.stringify(r.meta.fields ?? null)} delimiter=${JSON.stringify(r.meta.delimiter)} linebreak=${JSON.stringify(r.meta.linebreak)}`);
  for (const row of r.data.slice(0, 5)) console.log(JSON.stringify(row));
  console.log("last", JSON.stringify(r.data[r.data.length - 1]));
  for (const e of r.errors.slice(0, 5)) console.log("error", e.type, e.code, e.row, e.message);
}
