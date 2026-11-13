declare module "pw" {
  export function note_f64(x: number): void;
  export function note_f32(x: number): void;
  export function note_s32(x: number): void;
  export function note_u32(x: number): void;
  export function note_s64(x: bigint): void;
  export function note_u64(x: bigint): void;
  export function note_bool(x: boolean): void;
  export function give_f64(k: number): number;
  export function give_f32(k: number): number;
  export function give_s32(k: number): number;
  export function give_u32(k: number): number;
  export function give_s64(k: number): bigint;
  export function give_u64(k: number): bigint;
  export function give_bool(k: number): boolean;
  export function report(code: number, text: string): void;
}
