import settings from "./settings.json" with { type: "json" };
console.log("tweak sees", settings.retries);
settings.retries = settings.retries * 2;
settings.tags.push("tweaked");
