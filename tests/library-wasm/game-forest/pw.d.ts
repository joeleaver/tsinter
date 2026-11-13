// The engine's host module, as an engine-generated .d.ts declares it. No
// profile: number crosses as f64, bigint as s64.
declare module "pw" {
  export function spawn(kind: number): bigint;
  export function query_begin(mask: number): number;
  export function query_next(cursor: number): bigint;
  export function get_f32(e: bigint, comp: number, field: number): number;
  export function set_f32(e: bigint, comp: number, field: number, v: number): void;
}
