/* abi.ts hostNum kinds 16, 17 and 18 for a JS host (SEMANTICS.md S118): the
 * number THIS Node's OS gives a signal / errno name — exactly what the
 * program's own Node would read from os.constants.signals and
 * util.getSystemErrorMap(), so the wasm lane under Node on any OS sees
 * that OS's numbers. Shared by the harness host
 * (tests/harness/wasm-differential.test.ts) and the unit-test hosts. */
import { constants as osConstants } from "node:os";
import { getSystemErrorMap } from "node:util";
import { HOST_NUM_KIND_ERRNO_NUMBER, HOST_NUM_KIND_PLATFORM_ID, HOST_NUM_KIND_SIGNAL_NUMBER } from "../src/backend/wasm/abi.js";
import { ERRNO_NAMES, SIGNAL_NAMES } from "../src/backend/wasm/os-names.js";

const errnoByName = new Map<string, number>([...getSystemErrorMap()].map(([n, [name]]) => [name, n]));
const signals = osConstants.signals as Record<string, number | undefined>;

/** This Node OS's libuv number for errno `name` (what the host sends). */
export function uvErrno(name: string): number {
  const n = errnoByName.get(name);
  if (n === undefined) throw new Error(`uvErrno: no errno ${name}`);
  return n;
}

/** The answer for hostNum(kind, arg) when kind is 16 or 17; undefined for
 * every other kind (the caller's own table). */
export function osTableHostNum(kind: number, arg: number): number | undefined {
  if (kind === HOST_NUM_KIND_SIGNAL_NUMBER) {
    const name = SIGNAL_NAMES[arg];
    if (name === undefined) throw new Error(`hostNum: no signal name #${arg}`);
    return Object.hasOwn(signals, name) ? (signals[name] ?? 0) : 0;
  }
  if (kind === HOST_NUM_KIND_ERRNO_NUMBER) {
    const entry = ERRNO_NAMES[arg];
    if (entry === undefined) throw new Error(`hostNum: no errno name #${arg}`);
    return errnoByName.get(entry[0]) ?? 0;
  }
  if (kind === HOST_NUM_KIND_PLATFORM_ID) {
    return process.platform === "linux" ? 0 : process.platform === "darwin" ? 1 : process.platform === "win32" ? 2 : 3;
  }
  return undefined;
}
