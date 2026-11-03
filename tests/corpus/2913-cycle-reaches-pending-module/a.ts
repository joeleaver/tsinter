import "./b.ts";
import { read, readBox, readItems } from "./util.ts";
export function fn(): string {
  return read();
}
export function fnBox(): string {
  return readBox();
}
export function fnItems(): string {
  return readItems();
}
