// Queue #5 (6 apps / 36 sites): option-bag types with no static representation, as jsdiff and smol-toml spell them:
// a callback|record union inside a generic class, an intersection of option interfaces, and an ErrorOptions intersection.
// (This cut-down Diff arm compiles; jsdiff's full `DiffCallbackNonabortable<ValueT> | AllDiffOptions & Partial<…>`,
// whose AllDiffOptions intersects five interfaces incl. a generic one, is SC2011 "no static representation".
// The TomlError half refuses here exactly as smol-toml does: SC2008.)
interface DiffCharsOptions { ignoreCase?: boolean }
interface DiffLinesOptions { stripTrailingCr?: boolean }
type AllDiffOptions = DiffCharsOptions & DiffLinesOptions;
type DiffCallback<V> = (result: V[]) => void;
class Diff<T> {
  diff(a: T[], b: T[], options: DiffCallback<T> | (AllDiffOptions & Partial<{ callback: DiffCallback<T> }>) = {}): number {
    if (typeof options === "function") { options(a); return -1; }
    return a.length - b.length + (options.ignoreCase === true ? 100 : 0);
  }
}
type TomlErrorOptions = ErrorOptions & { toml: string; ptr: number };
class TomlError extends Error {
  line: number;
  constructor(message: string, options: TomlErrorOptions) {
    super(message, options);
    this.line = options.toml.slice(0, options.ptr).split("\n").length;
  }
}
console.log(new Diff<string>().diff(["a"], [], { ignoreCase: true }), new TomlError("bad", { toml: "a\nb", ptr: 3 }).line);
