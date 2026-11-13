declare module "pw" {
  export function note_f64(x: number): void;
  export function rand_u64(): bigint;
  export function report(code: number, text: string): void;
}
