// A constant export (one `return <literal-typed>`) answers without module
// evaluation; the first other export call evaluates.
import * as pw from "pw";
import { ABI_VERSION } from "./abi.ts";

pw.note_f64(1);

export function version(): number {
  return ABI_VERSION;
}

export function ready(): boolean {
  return true;
}

export function run(): void {
  pw.note_f64(2);
}
