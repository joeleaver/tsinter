declare module "pw" {
  export function put_bytes(b: Uint8Array): void;
  export function put_u32s(b: Uint32Array): void;
  export function put_f32s(b: Float32Array): void;
  export function report(code: number, text: string): void;
}
