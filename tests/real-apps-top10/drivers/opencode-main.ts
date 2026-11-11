// opencode workload: two engine packages under opencode's agent tools and its session view, from source.
// (The CLI entry itself needs Bun or opencode's vite build: Solid JSX in the TUI and `.txt` text imports.)
//   opencode-main.ts patch     -> @opencode/util/patch: parse apply_patch envelopes, derive the new file text
//   opencode-main.ts badpatch  -> the parser's typed errors
//   opencode-main.ts markdown  -> @opencode/patchmark: stream a markdown reply in chunks, render settled blocks to HTML
import { Result } from "effect";
import { Patch } from "../src/patch.ts";
import { createMarkdownStream, renderBlocksToHtml } from "../../patchmark/src/index.ts";

const ORIGINAL = ["import { a } from './a'", "", "export function add(x: number, y: number) {", "  return x + y", "}", "",
  "export function sub(x: number, y: number) {", "  return x - y", "}", ""].join("\n");

const PATCHES = [
  `*** Begin Patch
*** Update File: src/math.ts
@@ export function add(x: number, y: number) {
-  return x + y
+  // checked
+  return Number(x) + Number(y)
 }
@@ export function sub(x: number, y: number) {
-  return x - y
+  return x - y // unchanged math
*** Add File: src/new.ts
+export const answer = 42
+export const question = "?"
*** Delete File: src/old.ts
*** End Patch`,
  `<<'EOF'
*** Begin Patch
*** Update File: src/math.ts
*** Move to: src/arith.ts
@@
-import { a } from './a'
+import { a } from "./a.js"
*** End Patch
EOF`,
];

function cmdPatch(): void {
  for (const text of PATCHES) {
    const r = Patch.parse(text);
    if (Result.isFailure(r)) {
      console.log("parse failed:", JSON.stringify(r.failure));
      continue;
    }
    for (const h of r.success) {
      if (h.type === "update") {
        const next = Patch.derive(h.path, h.chunks, "﻿" + ORIGINAL);
        console.log(`update ${h.path}${h.movePath ? " -> " + h.movePath : ""} bom=${next.bom}`);
        console.log(next.content);
        console.log("--- rejoined bom length", Patch.joinBom(next.content, next.bom).length);
      } else if (h.type === "add") {
        console.log(`add ${h.path}: ${JSON.stringify(h.contents)}`);
      } else {
        console.log(`${h.type} ${h.path}`);
      }
    }
  }
}

function cmdBadPatch(): void {
  const bad = [
    "no envelope at all",
    "*** Begin Patch\n*** Frobnicate File: x\n*** End Patch",
    "*** Begin Patch\n*** Delete File: a.ts\nstray line\n*** End Patch",
    "*** Begin Patch\n*** Update File: a.ts\n*** Move to: \n*** End Patch",
    "*** Begin Patch\n*** Add File: a.ts\n",
  ];
  for (const b of bad) {
    const r = Patch.parse(b);
    console.log(Result.isFailure(r) ? `${r.failure._tag}: ${r.failure.message}` : `ok ${r.success.length}`);
  }
  try {
    Patch.derive("src/math.ts", [{ oldLines: ["does not exist"], newLines: ["x"] }], ORIGINAL);
    console.log("derive: no error");
  } catch (e) {
    console.log(`derive error: ${(e as Error).message}`);
  }
}

const REPLY = `# Plan

Here is **what** I'll do, with \`code\` and a [link](https://example.com):

1. Read the file
2. Apply the *patch*
   - nested item

\`\`\`ts
const x: number = 1 < 2 ? 3 : 4
\`\`\`

| col a | col b |
|:------|------:|
| 1     | two   |

> quoted & <escaped>

Done.`;

function cmdMarkdown(): void {
  const s = createMarkdownStream();
  for (let i = 0; i < REPLY.length; i += 17) {
    const f = s.append(REPLY.slice(i, i + 17));
    console.log(`frame settled=${f.settledOffset} blocks=${f.blocks.length} patches=${f.patches.map((p) => p.op).join(",")} held=${JSON.stringify(f.heldMarker)}`);
  }
  const last = s.finalize();
  console.log(renderBlocksToHtml(last.blocks));
}

const cmd = process.argv[2] ?? "patch";
if (cmd === "patch") cmdPatch();
else if (cmd === "badpatch") cmdBadPatch();
else if (cmd === "markdown") cmdMarkdown();
else {
  console.error("usage: opencode-main.ts patch|badpatch|markdown");
  process.exitCode = 2;
}
