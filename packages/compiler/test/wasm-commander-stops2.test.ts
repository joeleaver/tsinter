/* Commander stops past the dynamic emitter (the emitter-dyn unit's
 * workload pass). Each row is a tiny program without third-party code
 * reproducing one construct commander@15's lib/command.js reached; rows
 * run under Node and on both WasmGC lanes and must match byte for byte. */
import { describe, test } from "vitest";
import { checkFenced, checkRow, type Row, scratchDir } from "./top10-paperclip-rows.js";

const scratch = scratchDir("cmdr-stops2");

const ROWS: Row[] = [
  {
    id: "CMDR2-01 instanceof on a primitive operand answers false (command.js:733 _optionEx)",
    files: {
      "main.cjs": `class Option {
  constructor(flags) { this.flags = flags; }
}
class Command {
  _optionEx(config, flags, description) {
    if (typeof flags === "object" && flags instanceof Option) {
      throw new Error("To add an Option object use addOption()");
    }
    return [config.mandatory === true, flags, description, flags instanceof Option];
  }
}
const c = new Command();
console.log(c._optionEx({}, "-d, --debug", "debug"));
console.log(c._optionEx({ mandatory: true }, "--port <n>", "port"));
const n = 5;
console.log("s" instanceof Option);
console.log(n instanceof Option);
function probe(x) {
  return [typeof x === "object" && x instanceof Option, x instanceof Option];
}
console.log(probe("str"), probe(7), probe(new Option("-o")));
const parts = ["a", "b"];
console.log(parts.join("") instanceof Option);`,
    },
  },
  {
    id: "CMDR2-02 a key a JS record's shape lacks reads undefined (command.js:735 !!config.mandatory)",
    files: {
      "main.cjs": `class Command {
  _optionEx(config, flags) {
    const mandatory = !!config.mandatory;
    return [flags, mandatory, config.mandatory, typeof config.other];
  }
  option(flags) {
    return this._optionEx({}, flags);
  }
  requiredOption(flags) {
    return this._optionEx({ mandatory: true }, flags);
  }
}
const c = new Command();
console.log(c.option("-d"), c.requiredOption("--port <n>"));
const cfg = {};
console.log(cfg.missing === undefined, String(cfg.missing));`,
    },
  },
];

describe("commander stops, pass 2 (wasm lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await checkRow(scratch, row, "wasm");
  });
});

describe("commander stops, pass 2 (wasm-native lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await checkRow(scratch, row, "wasm-native");
  }, 600_000);
});

describe("commander stops, pass 2: the primitive fold leaves Symbol.hasInstance alone", () => {
  test("CMDR2-03 a class with a static Symbol.hasInstance keeps the named refusal (Node runs the method)", async () => {
    const row: Row = {
      id: "CMDR2-03",
      files: {
        "main.cjs": `class Even {
  static [Symbol.hasInstance](n) {
    return n % 2 === 0;
  }
}
console.log(2 instanceof Even, 3 instanceof Even);`,
      },
    };
    await checkFenced(scratch, row, "wasm-native", "", "'instanceof' on values other than class instances");
  }, 600_000);
});

describe("commander stops, pass 2: other Symbol.hasInstance spellings keep the refusal too", () => {
  test("CMDR2-04 a static getter for Symbol.hasInstance", async () => {
    const row: Row = {
      id: "CMDR2-04",
      files: {
        "main.cjs": `class G {
  static get [Symbol.hasInstance]() {
    return (v) => v === 1;
  }
}
console.log(1 instanceof G, 2 instanceof G);`,
      },
    };
    await checkFenced(scratch, row, "wasm-native", "", "'instanceof' on values other than class instances");
  }, 600_000);

  test("CMDR2-05 the bracket spelling Symbol[\"hasInstance\"]", async () => {
    const row: Row = {
      id: "CMDR2-05",
      files: {
        "main.cjs": `class B {
  static [Symbol["hasInstance"]](v) {
    return v === 1;
  }
}
console.log(1 instanceof B, 2 instanceof B);`,
      },
    };
    await checkFenced(scratch, row, "wasm-native", "", "'instanceof' on values other than class instances");
  }, 600_000);
});
