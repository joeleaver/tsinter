// No profile: number is f64, bigint s64, boolean bool; every export
// function is exported, plus an empty _initialize.
import { note_f64, note_s64, note_bool, give_f64, give_s64, give_bool } from "pw";

note_f64(1);

export function round(k: number): void {
  note_f64(give_f64(k));
  note_s64(give_s64(k));
  note_bool(give_bool(k));
}

export function add(a: number, b: bigint, c: boolean): bigint {
  note_f64(a);
  return c ? b + 1n : b - 1n;
}

export function big(): bigint {
  return 2n ** 63n;
}
