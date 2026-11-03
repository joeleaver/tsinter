import meta from "./meta.json" with { type: "json" };
console.log("other evaluated");
export const label: string = `v${meta.version}`;
