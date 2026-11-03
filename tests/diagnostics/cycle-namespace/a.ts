import { show } from "./b.ts";
export namespace Units {
  export const scale = 3;
}
export function size(): number {
  return Units.scale * 2;
}
show();
