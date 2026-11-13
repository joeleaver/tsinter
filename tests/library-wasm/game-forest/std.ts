// A typed slice of a game standard library over the host imports (after
// Playweft's tsinter spike, tools/tsinter-spike/typed/pw.ts).
import * as pw from "pw";

export type Vec3 = [number, number, number];
export const TRANSFORM = 1;

export class Field {
  constructor(readonly comp: number, readonly field: number) {}
}
export class Vec3Field {
  constructor(readonly comp: number, readonly field: number) {}
}

export class Obj {
  constructor(readonly id: bigint) {}
  num(f: Field): number {
    return pw.get_f32(this.id, f.comp, f.field);
  }
  setNum(f: Field, v: number): void {
    pw.set_f32(this.id, f.comp, f.field, v);
  }
  vec(f: Vec3Field): Vec3 {
    return [pw.get_f32(this.id, f.comp, f.field), pw.get_f32(this.id, f.comp, f.field + 1), pw.get_f32(this.id, f.comp, f.field + 2)];
  }
  setVec(f: Vec3Field, v: Vec3): void {
    pw.set_f32(this.id, f.comp, f.field, v[0]);
    pw.set_f32(this.id, f.comp, f.field + 1, v[1]);
    pw.set_f32(this.id, f.comp, f.field + 2, v[2]);
  }
}

export interface Tick {
  objects: Obj[];
  dt: number;
  tick: bigint;
}

interface System {
  name: string;
  mask: number;
  body: (t: Tick) => void;
}

const systems: System[] = [];

export function registerSystem(name: string, mask: number, body: (t: Tick) => void): void {
  systems.push({ name, mask, body });
}

export function spawn(kind: number): Obj {
  return new Obj(pw.spawn(kind));
}

export function runSystem(index: number, tick: bigint, dt: number): void {
  const s = systems[index];
  if (s === undefined) return;
  const cur = pw.query_begin(s.mask);
  const objects: Obj[] = [];
  for (let e = pw.query_next(cur); e !== 0n; e = pw.query_next(cur)) objects.push(new Obj(e));
  s.body({ objects, dt, tick });
}

export function systemCount(): number {
  return systems.length;
}
