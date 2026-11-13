// The game module's entry: module evaluation spawns the camera and registers
// the systems; the host then calls pw_run once per system per tick.
import { Field, runSystem, spawn, TRANSFORM } from "./std.ts";
import { FLY, setup } from "./forest.ts";

const cam = spawn(TRANSFORM | FLY);
cam.setNum(new Field(FLY, 0), 1);
setup();

export function pw_run(sys: number, tick: bigint, dt: number): void {
  runSystem(sys, tick, dt);
}
