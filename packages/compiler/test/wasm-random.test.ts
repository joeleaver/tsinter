/* INC-25 pass P1 (design-number-v6.txt §2.3/§6.4/§8.1/§9.1 = SEMANTICS.md
 * S068, CP1 ack 2026-09-07 hash 13571c6e..., rulings R5-R9): the Math.
 * random seed pin. This is a UNIT TEST with its OWN host forcing `seed`
 * to a fixed value — the shared differential harness host and this
 * package's wasm-host.ts BOTH stay serviced from a CSPRNG (deliberately,
 * so no OTHER test can accidentally depend on a fixed sequence), so a
 * forced-seed pin needs its own instantiate() copy, per the design's own
 * "PRECEDENT FOR A HOST-FORCED UNIT PIN" (wasm-timers.test.ts drives
 * `now` through wasm-host.ts's virtual clock the same way `seed` cannot).
 *
 * All eight oracle values are captured from THIS session's Node
 * (v24.18.1, process.versions.v8 = 13.6.233.17-node.50 — matching
 * SEMANTICS.md S068's pinned version) via `node --random-seed=N`, at test
 * run time, never hand-typed into this file.
 *
 * NEGATIVE CONTROLS build STANDALONE hand-encoded wasm modules (their own
 * imported `seed`, no dependence on the real emitter's randomHelper) that
 * replicate the WRONG algorithm byte for byte — the mutation IS the
 * control, and each one is asserted SEEN RED against the same oracle the
 * real pin passes. */
import { mkdtemp, rm } from "node:fs/promises";
import { writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { compile } from "../src/index.js";
import { F64, I32, I64, ModuleBuilder } from "../src/backend/wasm/module.js";
import { Code } from "../src/backend/wasm/code.js";

let scratch: string;
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "tsinter-wasm-random-"));
});
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

function nodeDraws(seed: number, n: number): number[] {
  const out = execFileSync(
    process.execPath,
    [`--random-seed=${seed}`, "-e", `const v=[];for(let i=0;i<${n};i++)v.push(Math.random());console.log(JSON.stringify(v))`],
    { encoding: "utf8" },
  );
  return JSON.parse(out) as number[];
}

const SEEDS = [1, 2, 42, 1000, 123456789, 2147483646, 2147483647, -1];

/* ── the REAL compiled module, own host forcing `seed` ─────────────────── */

async function buildDrawNProgram(n: number): Promise<string> {
  const src = `
    const out: number[] = [];
    for (let i = 0; i < ${n}; i = i + 1) { out.push(Math.random()); }
    console.log(out.join(","));
  `;
  const file = join(scratch, `draw-${n}-${Math.random().toString(36).slice(2)}.ts`);
  await writeFile(file, src);
  const res = await compile(file, { outPath: `${file}.wasm`, outDir: scratch, dynamic: false, backend: "wasm" });
  if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
  return res.binaryPath;
}

async function runForcedSeed(binaryPath: string, seedValue: bigint): Promise<number[]> {
  const bytes = await readFile(binaryPath);
  const chunks: Buffer[] = [];
  let memory: WebAssembly.Memory | null = null;
  const { instance } = await WebAssembly.instantiate(bytes, {
    tsinter: {
      write(fd: number, ptr: number, len: number): void {
        if (fd === 1) chunks.push(Buffer.from(new Uint8Array(memory!.buffer, ptr, len)));
      },
      now: (): number => 0,
      seed: (): bigint => seedValue,
    },
  });
  memory = instance.exports["memory"] as WebAssembly.Memory;
  (instance.exports["_start"] as () => void)();
  const line = Buffer.concat(chunks).toString("utf8").trim();
  return line.length === 0 ? [] : line.split(",").map(Number);
}

describe("wasm Math.random — the seed-to-sequence pin (real compiled module, forced-seed host)", () => {
  test(`first 320 draws equal node --random-seed=N exactly, across all ${SEEDS.length} seeds (int32 edges + -1, the sign-extension witness)`, async () => {
    const binaryPath = await buildDrawNProgram(320);
    for (const seed of SEEDS) {
      const u64 = BigInt.asUintN(64, BigInt(seed));
      const wasmDraws = await runForcedSeed(binaryPath, u64);
      const nodeVals = nodeDraws(seed, 320);
      expect(wasmDraws.length).toBe(320);
      for (let i = 0; i < 320; i++) {
        expect(wasmDraws[i]).toBe(nodeVals[i]);
      }
    }
  }, 60_000);

  test("seed -1 is the sign-extension witness: the host returns -1n and the module sees 2^64-1, not a truncated/sign-misread value", async () => {
    const binaryPath = await buildDrawNProgram(5);
    const viaMinus1 = await runForcedSeed(binaryPath, -1n); // raw -1n, not asUintN
    const viaMax64 = await runForcedSeed(binaryPath, (1n << 64n) - 1n);
    expect(viaMinus1).toEqual(viaMax64);
    const nodeVals = nodeDraws(-1, 5);
    expect(viaMinus1).toEqual(nodeVals);
  });

  test("seed 0 is UNPINNABLE against Node: V8 treats --random-seed=0 as UNSEEDED (measured directly — two separate Node runs at seed 0 differ), so it is excluded from the pin set rather than silently passed or silently skipped (§12.2 residual named)", () => {
    const a = nodeDraws(0, 2);
    const b = nodeDraws(0, 2);
    expect(a).not.toEqual(b); // genuinely random each run — not a flake: this IS the point
  });

  test("invariant sweep: every draw in [0,1), typeof number, isFinite — reported as INVARIANTS, not exactness (§6.4)", async () => {
    const binaryPath = await buildDrawNProgram(2000);
    const draws = await runForcedSeed(binaryPath, 999999999999n);
    expect(draws.length).toBe(2000);
    for (const d of draws) {
      expect(typeof d).toBe("number");
      expect(Number.isFinite(d)).toBe(true);
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThan(1);
    }
  });

  test("chi-square SANITY check over a large sample (64 buckets) — reported as a sanity check, never as exactness evidence", async () => {
    const N = 20_000;
    const binaryPath = await buildDrawNProgram(N);
    const draws = await runForcedSeed(binaryPath, 424242424242n);
    const BUCKETS = 64;
    const counts = new Array(BUCKETS).fill(0);
    for (const d of draws) counts[Math.min(BUCKETS - 1, Math.floor(d * BUCKETS))]++;
    const expected = N / BUCKETS;
    let chiSq = 0;
    for (const c of counts) chiSq += ((c - expected) ** 2) / expected;
    // 63 degrees of freedom; a generous sanity bound (this is NOT a formal
    // distribution test, just "did the fold obviously break uniformity").
    expect(chiSq).toBeLessThan(150);
  });
});

describe("wasm Math.random — the `seed` import-section pin (WebAssembly.Module.imports, CP1 ack R9)", () => {
  async function importsOfSource(src: string): Promise<string[]> {
    const file = join(scratch, `imp-${Math.random().toString(36).slice(2)}.ts`);
    await writeFile(file, src);
    const res = await compile(file, { outPath: `${file}.wasm`, outDir: scratch, dynamic: false, backend: "wasm" });
    if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
    const bytes = await readFile(res.binaryPath);
    const mod = await WebAssembly.compile(bytes);
    return WebAssembly.Module.imports(mod).map((i) => `${i.module}.${i.name}`);
  }

  test("a module that never calls Math.random does NOT declare tsinter.seed", async () => {
    const names = await importsOfSource(`console.log(Math.round(1.5), Math.floor(2.7));`);
    expect(names).not.toContain("tsinter.seed");
  });

  test("a module that calls Math.random DOES declare tsinter.seed", async () => {
    const names = await importsOfSource(`console.log(Math.random() >= 0);`);
    expect(names).toContain("tsinter.seed");
  });

  test("STATIC reachability roots at mod.entry alone: Math.random inside a function never called from entry does NOT declare tsinter.seed", async () => {
    const { emitWasmModule } = await import("../src/backend/wasm/emitter.js");
    const { VOID } = await import("../src/ir/nodes.js");
    const loc = { file: "unreached.ts", start: 0, end: 0 };
    const neverFn = {
      name: "%never.0",
      params: [],
      returnType: F64,
      locals: [],
      body: [{ kind: "exprStmt" as const, loc, expr: { kind: "libCall" as const, fn: "math.random", type: F64, loc, args: [] } }],
      loc,
    };
    const entryFn = { name: "%init.0", params: [], returnType: VOID, locals: [], body: [], loc };
    const mod = { irVersion: 3 as const, sourceFile: "unreached.ts", entry: "%init.0", globals: [], functions: [entryFn, neverFn] };
    const bytes = emitWasmModule(mod as Parameters<typeof emitWasmModule>[0]);
    const wmod = await WebAssembly.compile(bytes);
    const names = WebAssembly.Module.imports(wmod).map((i) => `${i.module}.${i.name}`);
    expect(names).not.toContain("tsinter.seed");
  });

  test("RUNTIME laziness: the host is called ZERO times when Math.random sits on a branch not taken, and EXACTLY ONCE for 320 real draws (CP1 ack R5's counting-host control — the ABI's 'at most once, on the first call' contract)", async () => {
    async function countedRun(src: string): Promise<number> {
      const file = join(scratch, `count-${Math.random().toString(36).slice(2)}.ts`);
      await writeFile(file, src);
      const res = await compile(file, { outPath: `${file}.wasm`, outDir: scratch, dynamic: false, backend: "wasm" });
      if (!res.ok) throw new Error(`refused: ${res.diagnostics[0]?.message}`);
      const bytes = await readFile(res.binaryPath);
      let calls = 0;
      const chunks: Buffer[] = [];
      let memory: WebAssembly.Memory | null = null;
      const { instance } = await WebAssembly.instantiate(bytes, {
        tsinter: {
          write(fd: number, ptr: number, len: number): void {
            if (fd === 1) chunks.push(Buffer.from(new Uint8Array(memory!.buffer, ptr, len)));
          },
          now: (): number => 0,
          seed: (): bigint => {
            calls++;
            return 12345n;
          },
        },
      });
      memory = instance.exports["memory"] as WebAssembly.Memory;
      (instance.exports["_start"] as () => void)();
      return calls;
    }
    // A RUNTIME-opaque condition (a function call, not a compile-time
    // literal) so the branch survives constant-folding and the module
    // still STATICALLY declares seed while never drawing at runtime.
    const notTaken = await countedRun(`
      let takeIt = false;
      function decide(): boolean { return takeIt; }
      if (decide()) { console.log(Math.random()); } else { console.log("skip"); }
    `);
    expect(notTaken).toBe(0);
    const draws320 = await countedRun(`
      let last = 0;
      for (let i = 0; i < 320; i = i + 1) { last = Math.random(); }
      console.log("done", typeof last);
    `);
    expect(draws320).toBe(1);
  });
});

/* ── negative controls: standalone hand-encoded generators, own `seed` ──
 * import, never this backend's real source. Each replicates the WRONG
 * algorithm exactly; all must score (at most negligibly) against the same
 * oracle the real pin (above) matches exactly. */

type Mutation = "correct" | "shift" | "noReversal" | "readS1" | "seedFromState0" | "v8main";

function buildVariant(mutation: Mutation): Uint8Array {
  const mb = new ModuleBuilder();
  const seedFuncIdx = mb.importFunc("tsinter", "seed", mb.funcType([], [I64]));
  const cacheType = mb.arrayType(F64, true);
  const s0G = mb.addGlobal(I64, true, (w) => { w.u8(0x42); w.sleb64(0n); });
  const s1G = mb.addGlobal(I64, true, (w) => { w.u8(0x42); w.sleb64(0n); });
  const idxG = mb.addGlobal(I32, true, (w) => { w.u8(0x41); w.sleb(0); });
  const cacheG = mb.addGlobal({ kind: "ref", nullable: true, typeIndex: cacheType }, true, (w) => {
    w.u8(0xd0);
    w.sleb(cacheType);
  });

  const murmurIdx = mb.declareFunc(mb.funcType([I64], [I64]), "%test.murmur3");
  {
    const c = new Code();
    const H = 0;
    const xorShift33 = (): void => {
      c.localGet(H); c.localGet(H); c.i64Const(33n); c.i64ShrU(); c.i64Xor(); c.localSet(H);
    };
    const mulConst = (v: bigint): void => {
      c.localGet(H); c.i64Const(BigInt.asIntN(64, v)); c.i64Mul(); c.localSet(H);
    };
    xorShift33();
    mulConst(0xff51afd7ed558ccdn);
    xorShift33();
    mulConst(0xc4ceb9fe1a85ec53n);
    xorShift33();
    c.localGet(H);
    mb.setBody(murmurIdx, [], c.bytes());
  }

  const drawIdx = mb.declareFunc(mb.funcType([], [F64]), "%test.draw");
  const c = new Code();
  const SEED = 0, A = 1, B = 2, MIXED = 3, I = 4;
  const shiftAmt = mutation === "shift" ? 18n : 17n;

  if (mutation === "v8main") {
    // No cache at all: seed once (lazily, via cache-is-null as the
    // sentinel, same as the real arm), then EVERY draw is one XorShift128
    // step with ToDouble applied to the STEP'S RETURN VALUE (s0+s1),
    // never state0 alone, and no reversal (there is nothing to reverse).
    c.globalGet(cacheG);
    c.refIsNull();
    c.ifVoid();
    c.call(seedFuncIdx);
    c.localSet(SEED);
    c.localGet(SEED);
    c.call(murmurIdx);
    c.globalSet(s0G);
    c.localGet(SEED);
    c.i64Const(-1n);
    c.i64Xor();
    c.call(murmurIdx);
    c.globalSet(s1G);
    c.i32Const(1);
    c.arrayNewDefault(cacheType); // dummy 1-slot array, only its non-nullness matters
    c.globalSet(cacheG);
    c.end();
    c.globalGet(s0G);
    c.localSet(A);
    c.globalGet(s1G);
    c.localSet(B);
    c.localGet(B);
    c.globalSet(s0G);
    c.localGet(A);
    c.localSet(MIXED);
    c.localGet(MIXED); c.localGet(MIXED); c.i64Const(23n); c.i64Shl(); c.i64Xor(); c.localSet(MIXED);
    c.localGet(MIXED); c.localGet(MIXED); c.i64Const(17n); c.i64ShrU(); c.i64Xor(); c.localSet(MIXED);
    c.localGet(MIXED); c.localGet(B); c.i64Xor(); c.localSet(MIXED);
    c.localGet(MIXED); c.localGet(B); c.i64Const(26n); c.i64ShrU(); c.i64Xor(); c.localSet(MIXED);
    c.localGet(MIXED);
    c.globalSet(s1G);
    // ToDouble(s0 + s1) — the RETURN value, not state0 alone.
    c.globalGet(s0G);
    c.globalGet(s1G);
    c.i64Add();
    c.i64Const(11n);
    c.i64ShrU();
    c.f64ConvertI64U();
    c.f64Const(Math.pow(2, -53));
    c.f64Mul();
    mb.setBody(drawIdx, [I64, I64, I64, I64, I32], c.bytes());
  } else {
    c.globalGet(idxG);
    c.i32Eqz();
    c.ifVoid();
    c.globalGet(cacheG);
    c.refIsNull();
    c.ifVoid();
    c.call(seedFuncIdx);
    c.localSet(SEED);
    c.localGet(SEED);
    c.call(murmurIdx);
    c.globalSet(s0G);
    if (mutation === "seedFromState0") {
      // The generator CLASS's own SetSeed shape: s1 = MurmurHash3(~s0),
      // not MurmurHash3(~seed).
      c.globalGet(s0G);
      c.i64Const(-1n);
      c.i64Xor();
    } else {
      c.localGet(SEED);
      c.i64Const(-1n);
      c.i64Xor();
    }
    c.call(murmurIdx);
    c.globalSet(s1G);
    c.i32Const(64);
    c.arrayNewDefault(cacheType);
    c.globalSet(cacheG);
    c.end();
    c.i32Const(0);
    c.localSet(I);
    c.block();
    c.loop();
    c.localGet(I);
    c.i32Const(64);
    c.i32GeS();
    c.brIf(1);
    c.globalGet(s0G);
    c.localSet(A);
    c.globalGet(s1G);
    c.localSet(B);
    c.localGet(B);
    c.globalSet(s0G);
    c.localGet(A);
    c.localSet(MIXED);
    c.localGet(MIXED); c.localGet(MIXED); c.i64Const(23n); c.i64Shl(); c.i64Xor(); c.localSet(MIXED);
    c.localGet(MIXED); c.localGet(MIXED); c.i64Const(shiftAmt); c.i64ShrU(); c.i64Xor(); c.localSet(MIXED);
    c.localGet(MIXED); c.localGet(B); c.i64Xor(); c.localSet(MIXED);
    c.localGet(MIXED); c.localGet(B); c.i64Const(26n); c.i64ShrU(); c.i64Xor(); c.localSet(MIXED);
    c.localGet(MIXED);
    c.globalSet(s1G);
    c.globalGet(cacheG);
    c.localGet(I);
    if (mutation === "readS1") {
      // The POST-step s1 (equivalently, the PRE-step s0 — CP1 ack R7:
      // reading the PRE-step s1 would silently equal the correct
      // post-step s0 and could not discriminate this axis at all).
      c.globalGet(s1G);
    } else {
      c.globalGet(s0G);
    }
    c.i64Const(11n);
    c.i64ShrU();
    c.f64ConvertI64U();
    c.f64Const(Math.pow(2, -53));
    c.f64Mul();
    c.arraySet(cacheType);
    c.localGet(I);
    c.i32Const(1);
    c.i32Add();
    c.localSet(I);
    c.br(0);
    c.end();
    c.end();
    c.i32Const(64);
    c.globalSet(idxG);
    c.end();
    c.globalGet(idxG);
    c.i32Const(1);
    c.i32Sub();
    c.globalSet(idxG);
    c.globalGet(cacheG);
    if (mutation === "noReversal") {
      // Consume FORWARD (cache[63 - index], which counts 0,1,2,...,63 as
      // idxG counts 63,62,61,...,0 after the decrement above) instead of
      // the reverse order idxG itself gives — the first draw after a
      // refill reads cache[0] (the FIRST generated value) rather than
      // cache[63] (the LAST, correct).
      c.i32Const(63);
      c.globalGet(idxG);
      c.i32Sub();
    } else {
      c.globalGet(idxG);
    }
    c.arrayGet(cacheType);
    mb.setBody(drawIdx, [I64, I64, I64, I64, I32], c.bytes());
  }

  mb.exportFunc("draw", drawIdx);
  return mb.emit();
}

async function drawNFromVariant(bytes: Uint8Array, seedValue: bigint, n: number): Promise<number[]> {
  const { instance } = await WebAssembly.instantiate(bytes, { tsinter: { seed: () => seedValue } });
  const draw = instance.exports["draw"] as () => number;
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(draw());
  return out;
}

describe("wasm Math.random — negative controls, SEEN RED against the same oracle (design §6.4, CP1 ack R6/R7)", () => {
  async function scoreVariant(mutation: Mutation): Promise<{ matches: number; total: number }> {
    const bytes = buildVariant(mutation);
    let matches = 0, total = 0;
    for (const seed of [1, 2, 42]) {
      const u64 = BigInt.asUintN(64, BigInt(seed));
      const draws = await drawNFromVariant(bytes, u64, 320);
      const nodeVals = nodeDraws(seed, 320);
      for (let i = 0; i < 320; i++) {
        total++;
        if (draws[i] === nodeVals[i]) matches++;
      }
    }
    return { matches, total };
  }

  test("SANITY: the 'correct' variant (this file's own hand-encoding, independent of the real emitter) matches the oracle 960/960 — proves the TEST HARNESS itself is sound before trusting any control's red", async () => {
    const { matches, total } = await scoreVariant("correct");
    expect(matches).toBe(total);
  }, 30_000);

  test("CONTROL 1 — the >>17 shift mutated to >>18: reddens (near-total mismatch)", async () => {
    const { matches, total } = await scoreVariant("shift");
    expect(matches).toBeLessThan(total * 0.05);
  }, 30_000);

  test("CONTROL 2 — no 64-block reversal: reddens totally", async () => {
    const { matches } = await scoreVariant("noReversal");
    expect(matches).toBe(0);
  }, 30_000);

  test("CONTROL 3 — read the POST-STEP s1 instead of the post-step s0: reddens totally (R7: NOT the pre-step s1, which would equal the correct value)", async () => {
    const { matches } = await scoreVariant("readS1");
    expect(matches).toBe(0);
  }, 30_000);

  test("CONTROL 4 — seed s1 from ~state0 (the generator CLASS's own SetSeed) instead of ~seed (math-random.cc's OWN seeding): reddens totally", async () => {
    const { matches } = await scoreVariant("seedFromState0");
    expect(matches).toBe(0);
  }, 30_000);

  test("CONTROL 5 — a v8/main-shaped rewrite (no cache, no reversal, ToDouble of the step's RETURN VALUE s0+s1 rather than state0 alone — all three of S068's named axes at once): reddens totally", async () => {
    const { matches } = await scoreVariant("v8main");
    expect(matches).toBe(0);
  }, 30_000);
});
