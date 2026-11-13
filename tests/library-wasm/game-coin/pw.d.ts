// The engine's host module as its generated .d.ts declares it; the profile
// (profile.json, engine-generated too) gives each parameter its wasm class.
declare module "pw" {
  export function spawn(kind: number): bigint;
  export function query_begin(mask: number): number;
  export function query_next(cursor: number): bigint;
  export function get_f32(e: bigint, comp: number, field: number): number;
  export function set_f32(e: bigint, comp: number, field: number, v: number): void;
  export function rand_u64(): bigint;
  export function register_component(name: string): number;
  export function emit_command(cmd: string): void;
  export function log(msg: string): void;
  export function report(code: number, text: string): void;
}
