// A JSON module is ONE module: every importer's default binding is the same
// object, evaluated once — a mutation one module makes is what the next
// importer sees. Node requires the `type: "json"` import attribute.
import "./tweak.ts";
import { describe } from "./report.ts";
import cfg from "./settings.json" with { type: "json" };
console.log(describe());
console.log(cfg.name, cfg.retries, cfg.tags.join("+"));
cfg.retries = 0;
console.log(describe());
