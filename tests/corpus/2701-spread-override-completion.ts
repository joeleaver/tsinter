// Spread-then-override completion: a later contributor overrides a spread
// field, so the dead copy neither lowers nor width-checks — an optional
// source field narrows into a required target slot exactly like Node's
// last-write-wins (the config-normalization idiom `{ ...config, stateDir }`).
type Config = { stateDir?: string; port: number; tag: string };
type Normalized = Config & { stateDir: string };

const base: Config = { port: 7070, tag: "dev" };
const stateDir = "/var/state";
const norm: Normalized = { ...base, stateDir };
console.log(norm.stateDir, norm.port, norm.tag);

// A POPULATED optional source field is genuinely replaced by the override.
const withDir: Config = { stateDir: "/old", port: 1, tag: "t" };
const replaced: Normalized = { ...withDir, stateDir: "/new" };
console.log(replaced.stateDir, replaced.port);

// The override may also come from a LATER SPREAD (still last-write-wins).
const filler: { stateDir: string } = { stateDir: "/from-spread" };
const viaSpread: Normalized = { ...base, ...filler };
console.log(viaSpread.stateDir, viaSpread.port, viaSpread.tag);

// Round-trip through a function boundary: the completed record IS the
// required-field shape everywhere downstream.
function useNormalized(c: Normalized): string {
  return `${c.stateDir}:${c.port}`;
}
console.log(useNormalized({ ...base, stateDir: "/fn" }));

// String-literal override keys count too.
type Wide = { "content-type"?: string; n: number };
type Exact = Wide & { "content-type": string };
const w: Wide = { n: 3 };
const e: Exact = { ...w, "content-type": "text/plain" };
console.log(e["content-type"], e.n);
