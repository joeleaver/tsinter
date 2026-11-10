/* The one vitest surface the shared wasm test host uses (see ts-resolve.mjs). */
export function expect(value) {
  return {
    toBeInstanceOf(ctor) {
      if (!(value instanceof ctor)) {
        const err = new Error(`expected an instance of ${ctor.name}, got ${value instanceof Error ? value.stack : String(value)}`);
        err.actual = value;
        throw err;
      }
    },
  };
}
