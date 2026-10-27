// Regenerates the string-width table inside packages/runtime/src/
// scr_web_prelude.js (between the BEGIN/END GENERATED string-width table
// markers) from THIS Node's ICU: the column width node_i18n.cc
// GetStringWidth gives every code point (ambiguous as narrow, emoji
// sequences expanded — the arguments util.inspect's getStringWidth
// passes). The island's inspector sums these per code point after NFC,
// exactly as GetStringWidth does (SEMANTICS.md S114). Run from the repo
// root with the oracle Node (v24.18.1):
//   node scripts/gen-string-width.mjs          # rewrite the region
//   node scripts/gen-string-width.mjs --check  # require the checked-in one
// then node scripts/gen-web-prelude.mjs and node scripts/build-engine-wasm.mjs.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const JS_PATH = join(root, "packages/runtime/src/scr_web_prelude.js");
const BEGIN = "  /* BEGIN GENERATED string-width table */\n";
const END = "  /* END GENERATED string-width table */\n";

/** Per-code-point widths from ICU, as runs: "<delta base36><width>". */
export function widthRuns() {
  const src = `
    const { internalBinding } = require('internal/test/binding');
    const icu = internalBinding('icu');
    const runs = [];
    let prevStart = 0, prevW = -1;
    for (let cp = 0; cp <= 0x10ffff; cp++) {
      const w = icu.getStringWidth(String.fromCodePoint(cp));
      if (w !== prevW) { runs.push((cp - prevStart).toString(36) + w); prevStart = cp; prevW = w; }
    }
    // Additivity: GetStringWidth over a string is the sum over its code points.
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let t = 0; t < 2000; t++) {
      let s = '', sum = 0;
      for (let k = 0; k < 6; k++) {
        const cp = Math.floor(rnd() * 0x30000);
        const c = String.fromCodePoint(cp);
        s += c; sum += icu.getStringWidth(c);
      }
      if (icu.getStringWidth(s) !== sum) throw new Error('not additive: ' + JSON.stringify(s));
    }
    process.stdout.write(JSON.stringify({ runs: runs.join(','), node: process.version, icu: process.versions.icu, unicode: process.versions.unicode }));
  `;
  return JSON.parse(execFileSync(process.execPath, ["--expose-internals", "--no-warnings", "-e", src], { encoding: "utf8", maxBuffer: 1 << 26 }));
}

export function renderRegion(info) {
  return `${BEGIN}  /* Node ${info.node}, ICU ${info.icu}, Unicode ${info.unicode}. */\n  const WIDTH_RUNS =\n` +
    info.runs.match(/.{1,96}(,|$)/g).map((l) => `    '${l}'`).join(" +\n") + ";\n" + END;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const js = readFileSync(JS_PATH, "utf8");
  const a = js.indexOf(BEGIN);
  const b = js.indexOf(END);
  if (a < 0 || b < a) throw new Error("string-width markers not found in scr_web_prelude.js");
  const out = js.slice(0, a) + renderRegion(widthRuns()) + js.slice(b + END.length);
  if (process.argv.includes("--check")) {
    if (out !== js) {
      console.error("scr_web_prelude.js's string-width table is stale: run node scripts/gen-string-width.mjs");
      process.exit(1);
    }
    console.log("string-width table matches this Node's ICU");
  } else {
    writeFileSync(JS_PATH, out);
    console.log(`wrote ${JS_PATH}`);
  }
}
