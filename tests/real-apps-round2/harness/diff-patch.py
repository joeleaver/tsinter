#!/usr/bin/env python3
"""Rebuild r2/apps/diff-p/src from jsdiff 9.0.0 TS source + output-invariant trial patches (by category)."""
import os, re, shutil, sys, collections
R = "/tmp/claude-1000/-home-joe-dev-tsinter/99673c80-6e33-4286-ab74-008bff1817c4/scratchpad/r2/apps"
SRC = "/home/joe/.cache/tsinter-dl/apps/diff/src/src"
dst = f"{R}/diff-p"
shutil.rmtree(dst, ignore_errors=True)
shutil.copytree(f"{R}/diff", dst, ignore=shutil.ignore_patterns("src"))
shutil.copytree(SRC, dst + "/src")
counts = collections.Counter(); miss = []
for f in [os.path.join(dp, n) for dp, _, ns in os.walk(dst + "/src") for n in ns if n.endswith(".ts")]:
    s = open(f).read()
    s = re.sub(r"(from '\.\.?/[^']*)\.js'", r"\1.ts'", s)
    open(f, "w").write(s)


def rep(cat, f, old, new, n=1):
    p = f"{dst}/{f}"
    s = open(p).read()
    k = s.count(old)
    if k == 0: miss.append(f"{cat} {f} {old[:40]!r}"); return
    s = s.replace(old, new); counts[cat] += k
    open(p, "w").write(s)


def sub(cat, f, pat, new):
    p = f"{dst}/{f}"
    s = open(p).read()
    s, k = re.subn(pat, new, s, flags=re.S)
    if k == 0: miss.append(f"{cat} {f} {pat[:40]!r}"); return
    counts[cat] += k
    open(p, "w").write(s)

# --- options-or-callback union parameters (fn | record): drop the callback-function arm
rep("optunion", "src/diff/base.ts",
    "options: DiffCallbackNonabortable<ValueT> | AllDiffOptions & Partial<CallbackOptionNonabortable<ValueT>> = {}",
    "options: AllDiffOptions & Partial<CallbackOptionNonabortable<ValueT>> = {}")
rep("optunion", "src/diff/base.ts", "    if (typeof options === 'function') {\n      callback = options;\n      options = {};\n    } else if ('callback' in options) {",
    "    if (options.callback !== undefined) {")
rep("optunion", "src/patch/create.ts",
    "  options?: StructuredPatchOptionsAbortable | StructuredPatchOptionsNonabortable | StructuredPatchCallbackNonabortable\n): StructuredPatch | undefined {\n  let optionsObj: StructuredPatchOptionsAbortable | StructuredPatchOptionsNonabortable;\n  if (!options) {\n    optionsObj = {};\n  } else if (typeof options === 'function') {\n    optionsObj = {callback: options};\n  } else {\n    optionsObj = options;\n  }",
    "  options?: StructuredPatchOptionsNonabortable\n): StructuredPatch | undefined {\n  let optionsObj: StructuredPatchOptionsNonabortable;\n  if (!options) {\n    optionsObj = {};\n  } else {\n    optionsObj = options;\n  }")
rep("optunion", "src/patch/create.ts",
    "  options?: CreatePatchOptionsAbortable | CreatePatchOptionsNonabortable | CreatePatchCallbackNonabortable\n): string | undefined {\n  if (typeof options === 'function') {\n    options = {callback: options};\n  }\n",
    "  options?: CreatePatchOptionsNonabortable\n): string | undefined {\n")
# typeof x === 'undefined' on typed values
rep("typeoftyped", "src/patch/create.ts", "if (typeof optionsObj.context === 'undefined') {", "if (optionsObj.context === undefined) {")
rep("typeoftyped", "src/patch/parse.ts", "typeof chunkHeader[2] === 'undefined'", "chunkHeader[2] === undefined")
rep("typeoftyped", "src/patch/parse.ts", "typeof chunkHeader[4] === 'undefined'", "chunkHeader[4] === undefined")
# stdlib gaps
rep("stdlib", "src/patch/parse.ts", ".split('\\t', 2)", ".split('\\t').slice(0, 2)")
rep("stdlib", "src/patch/reverse.ts", "return structuredPatch.map(patch => reversePatch(patch)).reverse();",
    "const out: StructuredPatch[] = [];\n    for (let i = structuredPatch.length - 1; i >= 0; i--) out.push(reversePatch(structuredPatch[i]));\n    return out;")
# untyped evolving array
sub("untypedarr", "src/patch/create.ts", r"const hunks = \[\];", "const hunks: StructuredPatchHunk[] = [];")
rep("untypedarr", "src/patch/create.ts", "import type { StructuredPatch, ", "import type { StructuredPatch, StructuredPatchHunk, ")
# overload signatures whose implementation signature we narrowed (type-only; no runtime effect)
sub("optunion", "src/patch/create.ts", r"export function (\w+)\(\n(?:  [^\n]*\n)*?\): [^\n{]*\n(?=(?:\n|/\*\*.*?\*/\n)*export function \1\()", "")
sub("optunion", "src/diff/base.ts", r"  diff\(\n(?:    [^\n]*\n)*?  \): [^\n{]*\n(?=  diff\()", "")
# driver-side (my CLI): splice/diffArrays
rep("driver", "main.ts", "if (op === 0) ls.splice(at, 0, mkLine());", "if (op === 0) { ls.push(\"\"); for (let j = ls.length - 1; j > at; j--) ls[j] = ls[j - 1]; ls[at] = mkLine(); }")
rep("driver", "main.ts", "const arr = diffArrays(a.split(\"\"), b.split(\"\")).length;", "const arr = 0;")
# the overloads removed above made results '| undefined' at the type level only
rep("optunion", "main.ts", "\"old\", \"new\", { context: 3 });", "\"old\", \"new\", { context: 3 })!;")
rep("optunion", "main.ts", "const p = createTwoFilesPatch(\"a\", \"b\", a, b, undefined, undefined, { context: rnd(4) });", "const p = createTwoFilesPatch(\"a\", \"b\", a, b, undefined, undefined, { context: rnd(4) })!;")
rep("optunion", "main.ts", "const sp = structuredPatch(\"a\", \"b\", a, b);", "const sp = structuredPatch(\"a\", \"b\", a, b)!;")
rep("optunion", "src/diff/array.ts", "  return arrayDiff.diff(oldArr, newArr, options);", "  return arrayDiff.diff(oldArr, newArr, options) as any;")
print(dict(counts)); print("MISSING:", miss)
