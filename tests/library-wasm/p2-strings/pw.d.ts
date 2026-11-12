declare module "pw" {
  export function log(msg: string): void;
  export function emit_command(cmd: string): void;
  export function register_component(name: string): number;
  export function note_f64(x: number): void;
  export function report(code: number, text: string): void;
}
