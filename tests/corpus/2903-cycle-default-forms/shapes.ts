import { report } from "./readers.ts";
console.log("shapes start");
export default class {
  static kind = "anon";
  area(): number {
    return 6;
  }
}
console.log("shapes end", report());
