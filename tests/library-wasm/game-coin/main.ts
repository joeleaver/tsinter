// The game module's entry. The profile names pw_setup as init: a pw_setup
// call evaluates every module first, then runs this body.
import * as pw from "pw";
import { runSystem } from "./std.ts";
import { placeAll, points, player, setup } from "./coin.ts";
import { Obj } from "./std.ts";

const ducks: Obj[] = [];

export function pw_abi_version(): number {
  return 7;
}

export function pw_setup(): void {
  setup();
  placeAll(2, 5);
  const cur = pw.query_begin(1);
  for (let e = pw.query_next(cur); e !== 0n; e = pw.query_next(cur)) ducks.push(new Obj(e));
  pw.log("setup: " + ducks.length + " ducks");
}

export function pw_run(sys: number, tick: bigint, dt: number): void {
  runSystem(sys, dt);
}

export function pw_score(who: number): string {
  for (const d of ducks) if (d.num(player) === who) return "player " + who + ": " + d.num(points).toFixed(0);
  return "player " + who + ": none";
}
