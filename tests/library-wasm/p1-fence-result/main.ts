// An export's result outside its class: the fence, then poison.
export function result(x: number): number {
  return x * 2;
}
export function wide(x: bigint): bigint {
  return x * 2n;
}
