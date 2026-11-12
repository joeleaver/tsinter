// Coin Rush, after Playweft's examples/coin-rush and the spike's typed port:
// two ducks, coins worth a point each, a hazard that costs three. First to
// GOAL wins the round; "again" starts the next one.
import * as pw from "pw";
import { Field, Obj, POSITION, registerSystem, say, spawn, wait, command, type Vec3 } from "./std.ts";

export const GOAL = 3;
const ARENA = 3;

export const points = new Field(1, 0);
export const player = new Field(1, 1);
const over = new Field(2, 0);
const winner = new Field(2, 1);

export function setup(): void {
  const spot = (): Vec3 => [Math.random() * 2 * ARENA - ARENA, 0.5, Math.random() * 2 * ARENA - ARENA];
  const start = (duck: Obj): Vec3 => [duck.num(player) === 1 ? -3 : 3, duck.vec(POSITION)[1], 0];

  let playing = true;
  registerSystem("round", { include: ["round"] }, ({ objects }) => {
    for (const r of objects) playing = r.num(over) === 0;
  });

  registerSystem("walking", { include: ["controls"] }, ({ objects, dt }) => {
    if (!playing) return;
    for (const duck of objects) {
      const p = duck.vec(POSITION);
      const t = Math.random() * Math.PI * 2;
      duck.setVec(POSITION, [Math.max(-ARENA, Math.min(ARENA, p[0] + Math.cos(t) * 6 * dt)), p[1], Math.max(-ARENA, Math.min(ARENA, p[2] + Math.sin(t) * 6 * dt))]);
    }
  });

  registerSystem("collecting", { include: [], contactsBetween: ["coin", "score"] }, ({ began }) => {
    if (!playing) return;
    for (const pair of began) {
      const coin = pair[0];
      const duck = pair[1];
      coin.setVec(POSITION, spot());
      duck.addOnce(points, 1);
      command("pickup", duck.num(player), duck.num(points));
    }
  });

  registerSystem("hurting", { include: [], contactsBetween: ["hazard", "score"] }, ({ began }) => {
    if (!playing) return;
    for (const pair of began) pair[1].addOnce(points, -3);
  });

  let won = 0;
  registerSystem("judging", { include: ["score", "controls"] }, ({ objects }) => {
    won = 0;
    for (const duck of objects) if (duck.num(points) >= GOAL) won = duck.num(player);
  });

  registerSystem("winning", { include: ["round"] }, ({ objects }) => {
    for (const r of objects) {
      if (r.num(over) === 0 && won !== 0) {
        r.setNum(over, 1);
        r.setNum(winner, won);
        pw.log("player " + won + " wins");
        void celebrate(won);
      }
    }
  });

  registerSystem("again", { include: ["round", "score", "controls"], events: ["again"] }, ({ objects, events }) => {
    if (events.length === 0) return;
    for (const o of objects) {
      o.setNum(over, 0);
      o.setNum(winner, 0);
      o.setNum(points, 0);
      o.setVec(POSITION, start(o));
    }
  });
}

// A task across ticks: the fanfare plays, and two seconds later the next
// round starts by itself.
async function celebrate(who: number): Promise<void> {
  command("fanfare", who);
  await wait(2);
  pw.log("again after player " + who);
  say("again");
}

export function placeAll(ducks: number, coins: number): void {
  for (let i = 0; i < ducks; i++) spawn(["controls", "score", "round"], [i % 2 === 0 ? -3 : 3, 0.5, 0]).setNum(player, (i % 2) + 1);
  for (let i = 0; i < coins; i++) spawn(["coin"], [(i % 5) * 1.5 - 3, 0.5, -2 + (i % 3)]);
  spawn(["hazard"], [0, 0.5, 2]);
}
