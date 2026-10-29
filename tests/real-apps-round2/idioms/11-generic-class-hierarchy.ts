// Queue #11 (jsdiff, polka): a generic subclass whose base mentions its own type parameter (jsdiff's
// `class ArrayDiff<T> extends Diff<T, Array<T>>`). In jsdiff the root reads "generic classes whose 'extends'
// clause mentions their own type parameters"; this cut-down reports ONLY the use-site cascade
// "method calls like 'new ArrayDiff<number>().count'" — its root diagnostic is missing (cf. 90-orphan-cascade).
class Diff<TokenT, ValueT> {
  join(tokens: TokenT[]): ValueT[] { return [tokens as unknown as ValueT]; }
  count(v: TokenT[]): number { return this.join(v).length; }
}
class ArrayDiff<T> extends Diff<T, Array<T>> {}
console.log(new ArrayDiff<number>().count([1, 2]), new ArrayDiff<string>().count(["x"]));
