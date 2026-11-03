import { a } from "./a.ts";
console.log("b start");
export const b: string = a + "B";
console.log("b end", b);
