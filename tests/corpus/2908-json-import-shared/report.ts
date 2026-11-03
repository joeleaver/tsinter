import s from "./settings.json" with { type: "json" };
console.log("report loads", s.retries, s.tags.length);
export function describe(): string {
  return `${s.name}: ${s.retries} retries, ${s.tags.length} tags`;
}
