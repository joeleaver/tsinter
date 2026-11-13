declare module "pw" {
  export function read_text(ptr: number, cap: number): number;
  export function get_vec3(e: bigint, c: number, f: number, out: number): void;
  export function spawn(kind: number): bigint;
  export function set_f32(e: bigint, c: number, f: number, v: number): void;
  export function note_f64(x: number): void;
  export function log(msg: string): void;
  export function report(code: number, text: string): void;
}
