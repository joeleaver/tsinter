/* SEMANTICS.md S118: the module keeps signal and errno NAMES, the host
 * answers its OS's numbers. The names must be Node's own: the signal list
 * covers this Node's os.constants.signals in its order, the errno list is
 * util.getSystemErrorMap()'s names and texts in its order, and the native
 * hosts' tables (wn_os_names.h) are generated from the same lists. */
import { execFileSync } from "node:child_process";
import { constants as osConstants } from "node:os";
import { join } from "node:path";
import { getSystemErrorMap } from "node:util";
import { describe, expect, test } from "vitest";
import { ERRNO_NAMES, SIGNAL_NAMES } from "../src/backend/wasm/os-names.js";
import { osTableHostNum } from "./wasm-os-tables-host.js";

const root = join(import.meta.dirname, "..", "..", "..");

describe("the OS-name tables (S118)", () => {
  test("SIGNAL_NAMES holds this Node's os.constants.signals, in its order, and a number reads back as its FIRST name", () => {
    const keys = Object.keys(osConstants.signals);
    expect(SIGNAL_NAMES.filter((n) => keys.includes(n))).toEqual(keys);
    // the JS host's answers are this Node's numbers, 0 for a name it lacks
    SIGNAL_NAMES.forEach((n, i) => expect(osTableHostNum(16, i)).toBe((osConstants.signals as Record<string, number>)[n] ?? 0));
  });

  test("ERRNO_NAMES is util.getSystemErrorMap(), names and texts, in its order", () => {
    expect(ERRNO_NAMES.map(([n, m]) => [n, m])).toEqual([...getSystemErrorMap().values()].map(([n, m]) => [n, m]));
    ERRNO_NAMES.forEach(([n], i) => expect(getSystemErrorMap().get(osTableHostNum(17, i)!)?.[0]).toBe(n));
  });

  test("the generated files are current (scripts/gen-os-names.mjs --check)", () => {
    expect(execFileSync(process.execPath, [join(root, "scripts", "gen-os-names.mjs"), "--check"], { encoding: "utf8" })).toMatch(/^ok: /);
  });
});
