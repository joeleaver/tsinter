#!/bin/bash
# The repo checks the fuzzer must not disturb (run from the repo root):
# lint, tsc of the compiler and CLI, vitest's file list (no tools/fuzz
# file in it), and the published packages' contents (no tools/fuzz file).
set -u
fail=0
step() { echo "== $*"; }
step lint
corepack pnpm@10 lint || fail=1
step "tsc packages/compiler"
node packages/compiler/node_modules/typescript5/bin/tsc -p packages/compiler/tsconfig.json --noEmit || fail=1
step "tsc packages/cli"
node node_modules/typescript/bin/tsc -p packages/cli/tsconfig.json --noEmit || fail=1
step "vitest file list"
list=$(npx vitest list --filesOnly 2>&1) || { echo "$list" | tail -20; fail=1; }
echo "$list" | grep -c '\.test\.ts' | sed 's/^/test files: /'
if echo "$list" | grep -q 'tools/'; then echo "tools/ file in vitest's list:"; echo "$list" | grep 'tools/'; fail=1; else echo "no tools/ file in vitest's list"; fi
step "published package contents"
for p in packages/compiler packages/cli packages/runtime; do
  files=$(cd "$p" && npm pack --dry-run --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const f of JSON.parse(s)[0].files)console.log(f.path)})')
  n=$(echo "$files" | wc -l)
  if echo "$files" | grep -q 'fuzz'; then echo "$p: fuzz file packed"; fail=1; else echo "$p: $n files, none from tools/fuzz"; fi
done
step "build output"
if find packages -path '*/dist/*' -path '*fuzz*' | grep -q .; then echo "fuzz file in a dist/"; fail=1; else echo "no fuzz file in any dist/"; fi
echo "== result: $([ $fail = 0 ] && echo PASS || echo FAIL)"
exit $fail
