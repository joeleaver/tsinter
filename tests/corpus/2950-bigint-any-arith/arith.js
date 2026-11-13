// Untyped JavaScript arithmetic: every operand is `any`, so the checker
// types each result `number`; Node computes a bigint for bigint operands.
export function sub(a, b) { return a - b; }
export function neg(a) { return -a; }
export function rem(a, b) { return (a % b).toString(); }
export function square(a) { const t = a * a; return t; }
export function less(a, b) { return a < b; }
export function pow(a, b) { return a ** b; }
export function gap(a, b) { const d = a - b; return d * d; }
