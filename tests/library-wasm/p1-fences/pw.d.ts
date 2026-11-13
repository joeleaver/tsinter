declare module "pw" {
  export function note_u32(x: number): void;
  export function note_s32(x: number): void;
  export function note_s64(x: bigint): void;
  export function report(code: number, text: string): void;
}
