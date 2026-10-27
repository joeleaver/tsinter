// The service-registry composite shapes crossing INTO the island, pinned
// against Node: a STATIC record carrying methods (an async object-literal
// method, a record-returning fallback, an index-signature config with
// overflow keys) lifts field by field; package arrays/Maps/generators
// drive for-of through the engine's own iterator protocol; and optional
// MEMBER calls (reg.seed?.()) short-circuit on nullish members with
// `this` bound like JS.
import { gen, makeList, makeMap, register } from "svckit";

interface Entry {
  label: string;
  initConfig: Record<string, unknown>;
  load(): Promise<string>;
  defaultFallback(cfg: any): { login: string; id: number };
}

const entry: Entry = {
  label: "github",
  initConfig: { github: { users: ["octocat"] }, extra: 1 },
  async load() {
    await Promise.resolve();
    return "gh-loaded";
  },
  defaultFallback(cfg: any) {
    return { login: cfg ? "seeded-admin" : "admin", id: cfg ? 2 : 1 };
  },
};

async function main(): Promise<void> {
  const reg = register(entry);
  console.log(`${reg.describe()}`);
  console.log(`${reg.fallback.login}:${reg.fallback.id}`);
  console.log(`${reg.bare.login}:${reg.bare.id}`);
  console.log(`${await reg.load()}`);
  // The entry declared no seed: the optional member call short-circuits.
  console.log(`${reg.seed?.("store", "http://x")}`);

  // for-of over package values: an engine array of records...
  for (const item of makeList(3)) console.log(`${item.id}:${item.tag}`);
  // ...an engine Map (pair destructuring from island entries)...
  for (const [k, v] of makeMap()) console.log(`${k}=${v}`);
  // ...and an engine generator (the live protocol, not a snapshot).
  for (const g of gen(3)) console.log(`${g}`);
}
void main();
