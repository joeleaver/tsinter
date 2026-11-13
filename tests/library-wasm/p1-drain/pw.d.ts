declare module "pw" {
  export function note_f64(x: number): void;
  export function note_s64(x: bigint): void;
  export function report(code: number, text: string): void;
}
