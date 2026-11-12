/* deepseek step 3: small node-API shapes from deepseek's CLI.
 * - process.stderr.write(text, callback): apps/cli/src/startup-diagnostics.ts
 *   waits for the write; Node calls back with null on the tick queue.
 * - fs.promises.writeFile(path, data, { flag: "wx", mode: 0o600 }): the
 *   startup report's exclusive, private create.
 * - Object.freeze([...] satisfies T): app-boot's frozen platform list (the
 *   fresh literal seen through `satisfies`).
 * Synthetic rows written from reading the project; each runs under Node and
 * on both WasmGC lanes. */
import { describe, test } from "vitest";
import { checkRefuses, checkRow, type Row, scratchDir } from "./top10-paperclip-rows.js";

const scratch = scratchDir("ds-node-api");

const ROWS: Row[] = [
  {
    id: "DS3-04 an invalid mode rejects (promise) and throws (sync) with Node's ERR_OUT_OF_RANGE, before any file is touched",
    files: {
      "main.ts": `import { writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
const modes = [384.7, -1, 2 ** 32, NaN, Infinity, 2 ** 40];
for (const mode of modes) {
  try {
    await writeFile("/nonexistent-dir/x", "data", { flag: "wx", mode });
    console.log("p ok");
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    console.log("p", err.name, err.code, err.message);
  }
  try {
    writeFileSync("/nonexistent-dir/x", "data", { mode });
    console.log("sync ok");
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    console.log("sync", err.name, err.code, err.message);
  }
}`,
    },
  },
  {
    id: "DS3-10 mkdir modes: mkdirSync throws as 'options.mode', fs.promises calls reject (never throw) as 'mode'",
    files: {
      "main.ts": `import { mkdir, writeFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
const show = (tag: string, e: unknown): void => {
  if (e instanceof Error) console.log(tag, e.name, (e as NodeJS.ErrnoException).code, e.message);
};
for (const mode of [1.5, -1, 2 ** 32, NaN, 2 ** 40]) {
  try {
    mkdirSync("/nonexistent-dir/a", { mode });
  } catch (e) {
    show("sync", e);
  }
  try {
    mkdirSync("/nonexistent-dir/a/b", { recursive: true, mode });
  } catch (e) {
    show("sync-r", e);
  }
  const p3 = writeFile("/nonexistent-dir/x", "data", { mode });
  console.log("returned the promise");
  await p3.catch((e: unknown) => show("p-write", e));
  try {
    await mkdir("/nonexistent-dir/a/b", { recursive: true, mode });
  } catch (e) {
    show("p-mkdir-r", e);
  }
}`,
    },
  },
  {
    id: "DS3-01 stderr and stdout writes with a callback: null on the tick queue, before later ticks and promise jobs",
    files: {
      "main.ts": `export {};
function writeStderr(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    process.stderr.write(text, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
const r = process.stdout.write("out\\n", (e) => console.log("stdout cb", e));
console.log("returned", r);
process.nextTick(() => console.log("later tick"));
Promise.resolve().then(() => console.log("promise job"));
await writeStderr("err line\\n");
console.log("awaited the stderr write");`,
    },
  },
  {
    id: "DS3-03 Object.freeze of a fresh array literal through 'satisfies'",
    files: {
      "main.ts": `type Platform = "linux" | "darwin" | "win32";
const PLATFORMS: readonly string[] = Object.freeze(["linux", "darwin", "win32"] satisfies Platform[]);
console.log(PLATFORMS.length, PLATFORMS.includes("linux"), PLATFORMS.join(","));`,
    },
  },
];

/* The real file system: the wasm-native lane's C host performs fsCall; the
 * wasm lane's in-process test host stubs fs loudly by design (wasm-host.ts),
 * and its real-fs coverage is the differential harness's corpus host. */
const FS_ROWS: Row[] = [
  {
    id: "DS3-05 fs.promises.writeFile(path, data, 'utf8'): the bare-encoding options",
    files: {
      "main.ts": `import { writeFile, readFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const p = join(tmpdir(), "ds3-utf8-" + process.pid + "-" + Date.now() + ".txt");
await writeFile(p, "héllo\\n", "utf8");
await writeFile(p, "wörld\\n", "utf-8");
console.log(await readFile(p, "utf8"));
rmSync(p, { force: true });`,
    },
  },
  {
    id: "DS3-02 fs.promises.writeFile with { flag: 'wx', mode }: private exclusive create, EEXIST rejects",
    files: {
      "main.ts": `import { writeFile, mkdir, readFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const dir = join(tmpdir(), "ds3-" + process.pid + "-" + Date.now());
await mkdir(dir, { recursive: true, mode: 0o700 });
const p = join(dir, "report.log");
await writeFile(p, "first\\n", { flag: "wx", mode: 0o600 });
console.log(await readFile(p, "utf8"));
try {
  await writeFile(p, "second\\n", { flag: "wx", mode: 0o600 });
  console.log("no error");
} catch (e) {
  console.log("rejected", (e as NodeJS.ErrnoException).code);
}
await writeFile(p, "third\\n", { mode: 0o644 });
await writeFile(join(dir, "plain.txt"), "w\\n", { flag: "w", encoding: "utf8" });
console.log(await readFile(p, "utf8"), await readFile(join(dir, "plain.txt"), "utf8"));
rmSync(dir, { recursive: true, force: true });`,
    },
  },
];

for (const backend of ["wasm", "wasm-native"] as const) {
  describe(`deepseek step 3: node-API shapes (${backend} lane vs Node)`, () => {
    test.for(ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
      await checkRow(scratch, row, backend);
    }, 600_000);
  });
}

describe("deepseek step 3: fs.promises.writeFile options (wasm-native lane vs Node)", () => {
  test.for(FS_ROWS.map((r) => [r.id, r] as const))("%s", async ([, row]) => {
    await checkRow(scratch, row, "wasm-native");
  }, 600_000);
});

/* Object.freeze's frozen-ness is unobservable only while every reference is
 * typed readonly; a cast of the result to a mutable type would let the
 * program write where Node throws, so it refuses by name. */
describe("deepseek step 3: a frozen literal cast to a mutable type refuses", () => {
  const FROZEN = "a cast of an Object.freeze result to a mutable type";
  test.for([
    ["DS3-06 through satisfies, then as", 'const a = (Object.freeze(["a"] satisfies string[]) as string[]);\na.push("x");\nconsole.log(a);'],
    ["DS3-07 a plain as", 'const a = Object.freeze(["a"]) as string[];\na.push("x");\nconsole.log(a);'],
    ["DS3-08 a record through an as chain", 'const o = Object.freeze({ n: 1 }) as unknown as { n: number };\no.n = 2;\nconsole.log(o.n);'],
  ] as const)("%s", async ([id, src]) => {
    await checkRefuses(scratch, { id, nodeTypes: false, files: { "main.ts": src } }, FROZEN);
  }, 600_000);
  test("DS3-09 a readonly cast still compiles and runs", async () => {
    await checkRow(scratch, {
      id: "DS3-09 readonly casts keep the frozen literal",
      nodeTypes: false,
      files: {
        "main.ts": 'const r = Object.freeze({ a: 1 }) as Readonly<{ a: number }>;\nconst xs = Object.freeze([1, 2]) as readonly number[];\nconst c = Object.freeze(["k"] as const);\nconsole.log(r.a, xs.length, c[0]);',
      },
    }, "wasm");
  }, 600_000);
});
