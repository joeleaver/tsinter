console.log("util");
export const VERSION = "1.0";
export function slugify(s: string): string {
  return s.toLowerCase().split(" ").join("-");
}
