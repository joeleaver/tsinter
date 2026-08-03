/* The abi.ts host contract, for the unit tests: instantiate a compiled
 * module, service `tsinter.write` into per-fd buffers, run `_start`, pump
 * `_tick` to quiescence, and read `_status` for the exit code. The
 * differential harness
 * (tests/harness/wasm-differential.test.ts) runs the same driver against
 * the corpus — this is the same loop, kept here so a test can assert on
 * output without a corpus program.
 *
 * THE CLOCK IS VIRTUAL: `tsinter.now` answers the deadline the pump last
 * jumped to, so nothing ever sleeps and a five-second timer costs
 * nothing. Timer programs are order-only by construction, so that is not
 * an approximation of anything observable. */
import { readFileSync } from "node:fs";
import { expect } from "vitest";

export interface HostRun {
  stdout: string;
  stderr: string;
  /** The process status the abi.ts contract answers with at quiescence:
   * `_status()` when the module exports one (13 = a top-level await that
   * never settled), 0 otherwise. A trap is exit 1 and never gets here —
   * runWasmToTrap is that path. */
  exitCode: number;
}

async function instantiate(modulePath: string) {
  const chunks: { 1: Buffer[]; 2: Buffer[] } = { 1: [], 2: [] };
  let memory: WebAssembly.Memory | null = null;
  let clock = 0;
  const { instance } = await WebAssembly.instantiate(readFileSync(modulePath), {
    tsinter: {
      write(fd: number, ptr: number, len: number): void {
        if (memory === null) throw new Error("write before instantiation completed");
        chunks[fd === 2 ? 2 : 1].push(Buffer.from(new Uint8Array(memory.buffer, ptr, len)));
      },
      now: (): number => clock,
    },
  });
  memory = instance.exports["memory"] as WebAssembly.Memory;
  let exitCode = 0;
  const drive = (): void => {
    (instance.exports["_start"] as () => void)();
    const tick = instance.exports["_tick"] as ((now: number) => number) | undefined;
    const status = instance.exports["_status"] as (() => number) | undefined;
    if (tick !== undefined) {
      for (let turns = 0; ; turns++) {
        if (turns > 1_000_000) throw new Error(`_tick pump did not settle for ${modulePath}`);
        const due = tick(clock);
        if (due < 0) break;
        clock = Math.max(clock, due);
      }
    }
    // Quiescence: the only point `_status` means anything (abi.ts).
    exitCode = status?.() ?? 0;
  };
  const out = (): HostRun => ({
    stdout: Buffer.concat(chunks[1]).toString("utf8"),
    stderr: Buffer.concat(chunks[2]).toString("utf8"),
    exitCode,
  });
  return { drive, out, instance };
}

export async function runWasm(modulePath: string): Promise<HostRun> {
  const { drive, out } = await instantiate(modulePath);
  drive();
  return out();
}

/** S007/S010's bridge shape: run to an EXPECTED trap (the tier's exit-1
 * channel), returning the output that preceded it. */
export async function runWasmToTrap(modulePath: string): Promise<HostRun> {
  const { drive, out } = await instantiate(modulePath);
  const trap = await Promise.resolve()
    .then(drive)
    .then(
      () => null,
      (err: unknown) => err,
    );
  expect(trap).toBeInstanceOf(WebAssembly.RuntimeError);
  return out();
}

/** Whether the module declares the timer half of the ABI at all — the
 * conditional-surface contract (abi.ts). */
export function hasTimerSurface(modulePath: string): boolean {
  const bytes = readFileSync(modulePath);
  return bytes.includes(Buffer.from("_tick"));
}
