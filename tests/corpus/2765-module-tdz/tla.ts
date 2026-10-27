// Top-level await opens the window: a timer created before the await
// fires while the module is suspended, before `late` is declared.
const seen: string[] = [];
setTimeout(() => {
  try {
    seen.push(`timer saw ${late}`);
  } catch (e) {
    seen.push(e instanceof Error ? `${e.name}: ${e.message}` : "non-error");
  }
}, 0);
await new Promise<void>((resolve) => setTimeout(resolve, 20));
export const late = "late";
export function tlaLog(): string {
  return `${seen.join("; ")} / then ${late}`;
}
