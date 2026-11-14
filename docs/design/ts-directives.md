# TypeScript directives across checker versions (build acceptance)

Status: built, 2026-11-13 (the "cheap wins" unit for the top-10 projects; review FIX rulings applied).

## What changed

tsinter type-checks every project with TypeScript 7. Each package's tsconfig is honoured (SEMANTICS.md S136),
but the checker version is not the project's own. Two kinds of comment directive behave differently between
versions, which matters for projects pinned to an older TypeScript. Vue 2.7 pins 4.9.5 and shadcn pins 5.9.2;
both are clean under their own `tsc --noEmit` and failed here only because of a directive.

1. **An unused directive never blocks a build.** TS2578 ("Unused '@ts-expect-error' directive") is dropped from
   the gate on every source, TypeScript and JavaScript alike. The directive names a line that compiles the same
   either way. A directive is unused when the error it was written for:
   - is gone in TypeScript 7;
   - moved to another line (Vue's `locateNode`);
   - is never raised in tsinter's program: shadcn's `@ts-expect-error` over an untyped
     `@babel/plugin-transform-typescript` import expects TS7016, which tsinter's `--npm-static` typing of
     node_modules JavaScript (`maxNodeModuleJsDepth`) removes.

2. **A directive over an expression-like statement covers that whole statement.**
   - Which statements widen: a `return`, a variable statement, an expression statement, or a property
     declaration. It is the outermost node starting at the first token after the directive's line.
   - What it does: any TypeScript error whose start lies inside that statement is dropped from the gate.
   - Everything else keeps TypeScript's own one-line reach: `if`, loops, blocks, functions, classes, modules.
   - Where it lives: `frontend/ts-directives.ts`, used by `program.ts` `errorsOf`.
   - Why: where an error lands inside a multi-line statement moved between versions. TypeScript 4.9 reports
     a mismatched `return cond ? a : b` at the `return`. TypeScript 7 reports it at the offending branch, two
     lines down, beyond the directive's single-line reach. Vue's `src/platforms/web/runtime/directives/show.ts`
     is exactly this.
   - A directive must be a real comment that opens its line. Text that looks like a directive inside a string,
     template or regex literal is not one.

## Suppressed sites: what still holds

A directive decides whether an error gates the build; the checker types every expression as before. Every value
then meets the lowering's ordinary per-site coercions and checks:
- a checked narrowing where a dynamic or union value enters a narrower typed slot;
- the slot's `undefined` (S119) where a plain-typed slot receives it;
- a named refusal where no coercion exists.

That holds for the widened region exactly as for the line TypeScript itself suppresses. The review found three
places where a suppressed error used to be silent. They existed on main with any one-line directive, and are
closed now:

1. **An assignment to a `const` or `using` binding, or an import binding**, refuses by name at compile time
   (SC1090). Node throws `TypeError: Assignment to constant variable.` This covers `=`, compound assignment,
   `++`/`--`, a destructuring target, and a for-in/of head. It is found statically in every file that can
   suppress an error (`@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`); everywhere else TypeScript's own
   TS2588 gates.
2. **A member read through a value the checker types as possibly `undefined`/`null`** throws Node's
   `TypeError: Cannot read properties of undefined (reading 'k')`. Before, it answered `undefined`. Covered:
   `e.k` with `e: T | undefined`, the error suppressed or relaxed in JavaScript. A computed key there (`e[k]`)
   stops by name instead, because Node's message names the runtime key. A receiver the checker has narrowed,
   or an optional chain, is unchanged.
3. **A write to a read-only value refuses by name** (SC1090). The values in scope are a `Readonly<…>` (what
   `Object.freeze` answers) and a readonly array or tuple, in a TypeScript file. The writes covered are a
   member or element write, `delete`, `++`/`--`, and a mutating array method (`push`, `pop`, `shift`,
   `unshift`, `splice`, `sort`, `reverse`, `fill`, `copyWithin`).
   - This build keeps no runtime frozen bit. In strict code Node throws a TypeError there, so a refusal is the
     cheapest sound answer.
   - Not covered: a frozen value reached through a binding typed mutable (assignability ignores `readonly`).
     That is the separate, pre-existing hole the freeze lowering's own notes describe; a cast to a mutable
     type already refuses.

## Not covered

- A directive does not reach across statements, and does not cover a second error site that the older
  checker reported separately.
- This is build acceptance only. Nothing in Node's observable behaviour differs, so there is no SEMANTICS.md
  entry.

Rows: `packages/compiler/test/wasm-ts-directives.test.ts` (TSD-01..13).
