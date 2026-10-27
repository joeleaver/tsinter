// A dependency whose own top level calls a function reading a binding
// declared further down: the TDZ error is caught here, and the importer
// (which runs after this module finished) sees every binding initialized.
export function describeLimit(): string {
  return `limit=${LIMIT}`;
}
function safe(f: () => string): string {
  try {
    return f();
  } catch (e) {
    return e instanceof Error ? `${e.name}: ${e.message}` : "non-error";
  }
}
export const earlyReport = safe(describeLimit);
export const LIMIT = 3;
export let counter = 0;
export function bump(): number {
  counter++;
  return counter;
}
export const lateReport = safe(describeLimit);
