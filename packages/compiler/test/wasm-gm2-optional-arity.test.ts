/* GM-2 (docs/design/generic-method-receiver.md, group C): arity through
 * function values with optional or defaulted parameters
 * (fn-value-arity.ts). A call through a function value that omits
 * trailing optional arguments passes undefined for each, as JS does
 * (paperclip's `input.onPhase?.("snapshot", "started")` against
 * `(phase, status, message?: string) => void`, `owner.stop()` against
 * `stop(clean?: boolean)`). A function with defaulted or optional
 * parameters enters a slot that spells them `T | undefined`, or one that
 * passes fewer arguments, and its default runs on undefined (paperclip's
 * `waitUntilReady: waitUntilDashboardReady`, `readConfigFile = readConfig`,
 * a nested `function factory(…, from = false)`). Node-exact: the one
 * observable difference, a callee reading `arguments.length`, refuses by
 * name. Rows run under Node and on both WasmGC lanes. */
import { describe, test } from "vitest";
import { checkRefuses, checkRow, type Row, scratchDir } from "./top10-paperclip-rows.js";

const scratch = scratchDir("gm2-optional-arity");

const ROWS: Row[] = [
  {
    id: "GM2-01 an optional callback called with two of its three parameters through ?.",
    files: {
      "main.ts": `type Phase = "snapshot" | "restore";
type OnPhase = (phase: Phase, status: "started" | "succeeded", message?: string) => void;
function seed(input: { onPhase?: OnPhase }): void {
  input.onPhase?.("snapshot", "started");
  input.onPhase?.("snapshot", "succeeded", "Created backup.");
  input.onPhase?.("restore", "started");
}
const seen: string[] = [];
seed({ onPhase: (p, s, m) => { seen.push(p + "/" + s + "/" + (m === undefined ? "<none>" : m)); } });
seed({});
const direct: OnPhase = (p, s, m = "default") => { seen.push(p + ":" + s + ":" + m); };
seed({ onPhase: direct });
console.log(seen.join("\\n"));`,
    },
  },
  {
    id: "GM2-02 a record method stop(clean = false) called with no arguments through Owner",
    files: {
      "main.ts": `type Owner = { stop(clean?: boolean): Promise<void>; interrupt(): void };
const owners = new Set<Owner>();
const log: string[] = [];
function own(name: string) {
  const owner: Owner = {
    interrupt() { log.push("interrupt " + name); },
    stop(clean = false) { log.push("stop " + name + " clean=" + clean); return Promise.resolve(); },
  };
  owners.add(owner);
  return { stop: () => owner.stop(), stopGracefully: async () => { await owner.stop(true); } };
}
const zero: { stop(): string } = { stop(clean = false) { return "zero clean=" + clean; } };
async function main(): Promise<void> {
  const a = own("a");
  const b = own("b");
  await a.stop();
  await b.stopGracefully();
  for (const o of owners) o.interrupt();
  await Promise.all([...owners].map((o) => o.stop()));
  log.push("drained " + owners.size);
  log.push(zero.stop());
  console.log(log.join("\\n"));
}
main();`,
    },
  },
  {
    id: "GM2-03 an optional parameter after a defaulted one, through slots of each arity",
    files: {
      "main.ts": `function h(a: number, b = 10, c?: string): string {
  return a + "/" + b + "/" + (c === undefined ? "none" : c);
}
const one: (a: number) => string = h;
const two: (a: number, b?: number) => string = h;
const three: (a: number, b?: number, c?: string) => string = h;
console.log(one(1), two(2), two(2, undefined), two(2, 5), three(3), three(3, undefined, "c"), three(3, 4, "d"));
console.log(one === h, two === h, three === h);
const table: ((a: number) => string)[] = [h, (a) => "lambda " + a];
console.log(table.map((f) => f(7)).join(" | "));
const byName = new Map<string, (a: number, b?: number) => string>([["h", h]]);
console.log(byName.get("h")!(8), byName.get("h")!(8, 9));`,
    },
  },
  {
    id: "GM2-04 a default observes an omitted or undefined argument but not an explicit value",
    files: {
      "main.ts": `let evaluated = 0;
function fallback(): string { evaluated++; return "def" + evaluated; }
function label(a: string = fallback()): string { return "[" + a + "]"; }
const slot: (a?: string) => string = label;
console.log(slot(), slot(undefined), slot("x"), slot(""), evaluated, slot === label);
function readConfig(configPath?: string, strict = false): string | null {
  return configPath === undefined ? null : configPath + " strict=" + strict;
}
function check(configPath?: string, read: (path?: string) => string | null = readConfig): void {
  console.log(String(read(configPath)), String(read()));
}
check();
check("paperclip.json");
check("x", (p) => "custom " + String(p));
async function waitUntilReady(url: string, timeoutMs = 10, tag?: string): Promise<string> {
  return url + " " + timeoutMs + " " + String(tag);
}
type Deps = { wait: (url: string) => Promise<string>; waitFor: (url: string, timeoutMs?: number) => Promise<string> };
const deps: Deps = { wait: waitUntilReady, waitFor: waitUntilReady };
async function main(): Promise<void> {
  console.log(await deps.wait("a"), "|", await deps.waitFor("b"), "|", await deps.waitFor("c", 3));
  console.log(deps.wait === waitUntilReady, deps.waitFor === deps.wait);
}
main();`,
    },
  },
  {
    id: "GM2-05 a nested function declaration with a defaulted parameter as a value",
    files: {
      "main.ts": `function install(names: string[]): string[] {
  const out: string[] = [];
  function factory(value: string, step: string, from = false): void {
    out.push(step + ":" + value + (from ? " (from)" : ""));
  }
  for (const n of names) factory(n, "select");
  factory("t", "from", true);
  const later: ((value: string, step: string) => void)[] = [factory];
  later[0]!("late", "insert");
  names.forEach((n) => factory(n, "each"));
  return out;
}
console.log(install(["a", "b"]).join("\\n"));`,
    },
  },
  {
    id: "GM2-06 JavaScript: a defaulted method and a nested defaulted declaration called short",
    files: {
      "main.js": `const o = { stop(clean = false) { return "stop:" + clean; } };
const s = o.stop;
function run(cb) { return cb() + "|" + cb(true); }
function outer() {
  function factory(v, from = false) { return v + (from ? "!" : "."); }
  const f = factory;
  return [factory("a"), factory("b", true), f("c"), f("d", true)].join(" ");
}
console.log(s(), s(true), run(s), run(o.stop), outer());`,
    },
  },
];

const ARGUMENTS_ROW: Row = {
  id: "GM2-07 a JavaScript callee reading arguments.length refuses by name",
  files: {
    "main.js": `function f(a, b = 1) { return arguments.length + ":" + a + ":" + b; }
const g = f;
console.log(g(1), g(1, 2));`,
  },
};
const ARGUMENTS_STOP = "'arguments' in functions with declared parameters (use a rest parameter: (...args))";

describe("GM-2: optional and defaulted parameters through function values (wasm lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await checkRow(scratch, row, "wasm");
  });
  test(ARGUMENTS_ROW.id, async () => {
    await checkRefuses(scratch, ARGUMENTS_ROW, ARGUMENTS_STOP, undefined, "wasm");
  });
});

describe("GM-2: optional and defaulted parameters through function values (wasm-native lane vs Node)", () => {
  test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await checkRow(scratch, row, "wasm-native");
  }, 600_000);
  test(ARGUMENTS_ROW.id, async () => {
    await checkRefuses(scratch, ARGUMENTS_ROW, ARGUMENTS_STOP, undefined, "wasm-native");
  }, 600_000);
});
