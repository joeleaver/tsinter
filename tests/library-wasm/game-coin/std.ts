// A typed slice of a game standard library over the host imports (after
// Playweft's tsinter spike, tools/tsinter-spike/typed/pw.ts): fields by
// handle, a system registry of closures, contacts, events and tick-driven
// tasks (`await wait(seconds)`).
import * as pw from "pw";

export type Vec3 = [number, number, number];

const kinds = new Map<string, number>();
export function kind(name: string): number {
  let k = kinds.get(name);
  if (k === undefined) {
    k = 1 << (pw.register_component(name) - 1);
    kinds.set(name, k);
  }
  return k;
}

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
  addOnce(f: Field, by: number): void {
    this.setNum(f, this.num(f) + by);
  }
}

export interface Tick {
  objects: Obj[];
  began: [Obj, Obj][];
  events: string[];
  dt: number;
}

interface Decl {
  include: string[];
  contactsBetween?: [string, string];
  events?: string[];
}

class System {
  touching = new Set<string>();
  constructor(readonly name: string, readonly decl: Decl, readonly body: (t: Tick) => void) {}
}

const systems: System[] = [];
let said: string[] = [];
let now = 0;

export function registerSystem(name: string, decl: Decl, body: (t: Tick) => void): void {
  systems.push(new System(name, decl, body));
}

export function say(event: string): void {
  said.push(event);
}

export function spawn(kinds: string[], at: Vec3): Obj {
  let mask = 0;
  for (const k of kinds) mask |= kind(k);
  const o = new Obj(pw.spawn(mask));
  o.setVec(POSITION, at);
  return o;
}

export const POSITION = new Vec3Field(0, 0);

function matched(mask: number): Obj[] {
  const cur = pw.query_begin(mask);
  const out: Obj[] = [];
  for (let e = pw.query_next(cur); e !== 0n; e = pw.query_next(cur)) out.push(new Obj(e));
  return out;
}

function began(s: System, between: [string, string]): [Obj, Obj][] {
  const out: [Obj, Obj][] = [];
  const nowTouching = new Set<string>();
  for (const a of matched(kind(between[0]))) {
    for (const b of matched(kind(between[1]))) {
      if (a.id === b.id) continue;
      const p = a.vec(POSITION);
      const q = b.vec(POSITION);
      const dx = p[0] - q[0];
      const dz = p[2] - q[2];
      if (dx * dx + dz * dz < 1) {
        const key = a.id + "|" + b.id;
        nowTouching.add(key);
        if (!s.touching.has(key)) out.push([a, b]);
      }
    }
  }
  s.touching = nowTouching;
  return out;
}

// Tasks: a promise resolved by the tick, so `await wait(s)` resumes in the
// drain of the pw_run call whose tick passes its deadline.
interface Sleeper {
  at: number;
  wake: () => void;
}
let sleepers: Sleeper[] = [];
export function wait(seconds: number): Promise<void> {
  return new Promise<void>((resolve) => {
    sleepers.push({ at: now + seconds, wake: resolve });
  });
}

export function runSystem(index: number, dt: number): void {
  if (index === 0) {
    now += dt;
    const due = sleepers.filter((s) => s.at <= now);
    sleepers = sleepers.filter((s) => s.at > now);
    for (const s of due) s.wake();
  }
  const s = systems[index];
  if (s === undefined) return;
  let mask = 0;
  for (const k of s.decl.include) mask |= kind(k);
  const want = s.decl.events ?? [];
  const events = said.filter((e) => want.indexOf(e) >= 0);
  const between = s.decl.contactsBetween;
  s.body({ objects: matched(mask), began: between === undefined ? [] : began(s, between), events, dt });
  if (index === systems.length - 1) said = [];
}

export function systemCount(): number {
  return systems.length;
}

export function command(name: string, ...args: number[]): void {
  pw.emit_command(name + " " + args.map((a) => a.toFixed(2)).join(" "));
}
