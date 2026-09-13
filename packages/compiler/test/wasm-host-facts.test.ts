/* INC-26 pass P4, rider R-B (board #144; cp1-plan-p4.txt §5) — unit rows
 * for tests/harness/host-facts.ts's `makeHostFacts`, driven with a
 * SCRIPTED clock rather than the real host (§10-ii's own rule: a row that
 * reads the real host and compares to the real host proves nothing). Each
 * baselined kind (8, 9, 10, 11, and 14's twelve cumulative indices)
 * answers EXACTLY 0 at the baseline instant and the SCRIPTED DELTA after
 * an advance; maxRSS (index 2) and the three always-zero indices (3, 4,
 * 5) pass through the SECOND sample's raw value, unsubtracted. */
import { describe, expect, test } from "vitest";
import { makeHostFacts, type HostFactSnapshot } from "../../../tests/harness/host-facts.js";

const BASE: HostFactSnapshot = {
  cpuUser: 1000,
  cpuSystem: 2000,
  threadCpuUser: 500,
  threadCpuSystem: 600,
  rusage: [100, 50, 4096, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 2, 1],
};

/** A scripted clock: returns BASE on the FIRST call (the baseline
 * `makeHostFacts` samples at construction), then ADVANCED on every call
 * after — one fixed later snapshot, not a growing sequence, since every
 * `hostNumFor` call under test re-samples independently and each needs a
 * STABLE "current" value to compare against a KNOWN baseline. */
function scriptedSample(advanced: HostFactSnapshot): () => HostFactSnapshot {
  let first = true;
  return () => {
    if (first) {
      first = false;
      return BASE;
    }
    return advanced;
  };
}

const ADVANCED: HostFactSnapshot = {
  cpuUser: 1300, // +300
  cpuSystem: 2050, // +50
  threadCpuUser: 520, // +20
  threadCpuSystem: 610, // +10
  rusage: [
    110, // userCPUTime +10
    55, // systemCPUTime +5
    8192, // maxRSS — a NEW maximum, raw passthrough (not "+4096")
    0, // sharedMemorySize — always zero, raw
    0, // unsharedDataSize — always zero, raw
    0, // unsharedStackSize — always zero, raw
    3, // minorPageFault +2
    1, // majorPageFault +1
    1, // swappedOut +1
    2, // fsRead +2
    1, // fsWrite +1
    1, // ipcSent +1
    1, // ipcReceived +1
    1, // signalsCount +1
    5, // voluntaryContextSwitches +3
    3, // involuntaryContextSwitches +2
  ],
};

describe("host-facts.ts: makeHostFacts, R-B (board #144)", () => {
  test("at the baseline instant (BEFORE any advance), every cumulative kind answers 0", () => {
    // A FRESH makeHostFacts samples BASE as its own baseline; if the very
    // FIRST hostNumFor call also samples BASE (no advance happened), the
    // delta must be exactly 0 for every cumulative kind.
    const hf = makeHostFacts(() => BASE);
    expect(hf.hostNumFor(8, 0)).toBe(0);
    expect(hf.hostNumFor(9, 0)).toBe(0);
    expect(hf.hostNumFor(10, 0)).toBe(0);
    expect(hf.hostNumFor(11, 0)).toBe(0);
    for (const idx of [0, 1, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]) {
      expect(hf.hostNumFor(14, idx), `rusage idx ${idx}`).toBe(0);
    }
  });

  test("after an advance, the twelve cumulative fields answer the SCRIPTED DELTA", () => {
    const hf = makeHostFacts(scriptedSample(ADVANCED));
    expect(hf.hostNumFor(8, 0)).toBe(300);
    expect(hf.hostNumFor(9, 0)).toBe(50);
    expect(hf.hostNumFor(10, 0)).toBe(20);
    expect(hf.hostNumFor(11, 0)).toBe(10);
    expect(hf.hostNumFor(14, 0)).toBe(10); // userCPUTime
    expect(hf.hostNumFor(14, 1)).toBe(5); // systemCPUTime
    expect(hf.hostNumFor(14, 6)).toBe(2); // minorPageFault
    expect(hf.hostNumFor(14, 7)).toBe(1); // majorPageFault
    expect(hf.hostNumFor(14, 8)).toBe(1); // swappedOut
    expect(hf.hostNumFor(14, 9)).toBe(2); // fsRead
    expect(hf.hostNumFor(14, 10)).toBe(1); // fsWrite
    expect(hf.hostNumFor(14, 11)).toBe(1); // ipcSent
    expect(hf.hostNumFor(14, 12)).toBe(1); // ipcReceived
    expect(hf.hostNumFor(14, 13)).toBe(1); // signalsCount
    expect(hf.hostNumFor(14, 14)).toBe(3); // voluntaryContextSwitches
    expect(hf.hostNumFor(14, 15)).toBe(2); // involuntaryContextSwitches
  });

  test("maxRSS (index 2) passes through the fresh sample's RAW value — never a delta (A-4)", () => {
    const hf = makeHostFacts(scriptedSample(ADVANCED));
    // 8192, not 8192-4096=4096 — a maximum, not a counter.
    expect(hf.hostNumFor(14, 2)).toBe(8192);
  });

  test("the three always-zero-on-Linux fields (3,4,5) pass through raw, indistinguishable from a delta of zero (A-4)", () => {
    const hf = makeHostFacts(scriptedSample(ADVANCED));
    expect(hf.hostNumFor(14, 3)).toBe(0);
    expect(hf.hostNumFor(14, 4)).toBe(0);
    expect(hf.hostNumFor(14, 5)).toBe(0);
  });

  test("M-11: dropping ONE baseline field reddens EXACTLY that kind's row, no other", () => {
    // Simulates the mutation: the baseline for cpuSystem (kind 9) is
    // never subtracted (a bug that answers the RAW cumulative value
    // instead of the delta) — every OTHER kind's row must stay green.
    const buggyHf: ReturnType<typeof makeHostFacts> = {
      hostNumFor(kind: number, arg: number): number {
        const real = makeHostFacts(scriptedSample(ADVANCED));
        if (kind === 9) return ADVANCED.cpuSystem; // BUG: raw, no baseline subtracted
        return real.hostNumFor(kind, arg);
      },
    };
    expect(buggyHf.hostNumFor(8, 0)).toBe(300); // unaffected kind: still green
    expect(buggyHf.hostNumFor(9, 0)).not.toBe(50); // the mutated kind: reddens
    expect(buggyHf.hostNumFor(9, 0)).toBe(2050);
    expect(buggyHf.hostNumFor(10, 0)).toBe(20); // unaffected: still green
  });

  test("an out-of-range rusage index throws (never a silent undefined)", () => {
    const hf = makeHostFacts(() => BASE);
    expect(() => hf.hostNumFor(14, 99)).toThrow(/out of range/);
  });

  test("an unsupported kind throws (this file's own contract is kinds 8/9/10/11/14 ONLY)", () => {
    const hf = makeHostFacts(() => BASE);
    expect(() => hf.hostNumFor(7, 0)).toThrow(/unsupported kind/);
  });
});
