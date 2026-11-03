import { report } from "./readers.ts";
console.log("label start");
const text: string = "label-text";
console.log("label mid", report());
export default text;
console.log("label end", report());
