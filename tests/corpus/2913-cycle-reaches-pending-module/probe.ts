export function probe(f: () => string): string {
  try {
    return f();
  } catch (e) {
    return `${(e as Error).name}: ${(e as Error).message}`;
  }
}
