// The Forest Ruin flythrough, after Playweft's examples/forest-ruin and the
// spike's typed port: the camera flies round the shrine through six shots.
import { Field, Vec3Field, registerSystem, TRANSFORM, type Vec3 } from "./std.ts";

export const FLY = 2;

interface Shot {
  eye: Vec3;
  look: Vec3;
  seconds: number;
}

const SHOTS: Shot[] = [
  { eye: [5, 1.2, 19], look: [0, 1.9, 0], seconds: 1 },
  { eye: [3.5, 1.9, 11.5], look: [0, 1.7, 0], seconds: 6 },
  { eye: [1.5, 1.2, 3.4], look: [0, 0.8, 0.7], seconds: 6 },
  { eye: [-1.8, 1.1, 2.6], look: [0, 0.8, 0.5], seconds: 4 },
  { eye: [-7.5, 2.2, -0.5], look: [0, 1.4, -2], seconds: 6 },
  { eye: [9, 9, 15], look: [0, 1.0, -2], seconds: 8 },
];

export function setup(): void {
  const position = new Vec3Field(TRANSFORM, 0);
  const yaw = new Field(TRANSFORM, 3);
  const speed = new Field(FLY, 0);
  const elapsed = new Field(FLY, 1);

  const ease = (t: number): number => t * t * (3 - 2 * t);
  const mix = (a: Vec3, b: Vec3, t: number): Vec3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

  const at = (time: number): { eye: Vec3; look: Vec3 } => {
    let left = time;
    for (let i = 1; i < SHOTS.length; i++) {
      const shot = SHOTS[i]!;
      if (left < shot.seconds) {
        const t = ease(left / shot.seconds);
        return { eye: mix(SHOTS[i - 1]!.eye, shot.eye, t), look: mix(SHOTS[i - 1]!.look, shot.look, t) };
      }
      left -= shot.seconds;
    }
    const last = SHOTS[SHOTS.length - 1]!;
    return { eye: last.eye, look: last.look };
  };

  registerSystem("flying", TRANSFORM | FLY, ({ objects, dt }) => {
    for (const cam of objects) {
      const time = cam.num(elapsed);
      const view = at(Math.max(0, time - SHOTS[0]!.seconds));
      cam.setVec(position, view.eye);
      cam.setNum(yaw, Math.atan2(view.look[0] - view.eye[0], view.look[2] - view.eye[2]));
      cam.setNum(elapsed, time + dt * cam.num(speed));
    }
  });
}
