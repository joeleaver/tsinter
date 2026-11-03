// Re-exports through PROJECT imports (package.json "imports"): a barrel
// re-exports `export * from "#models"` and `export { ... } from "#util"`
// — the same program modules a relative re-export names, evaluated in
// Node's order.
import { User, describeUser, slugify, VERSION } from "./barrel.ts";
const u = new User("Ada Lovelace");
console.log(describeUser(u), slugify(u.name), VERSION);
