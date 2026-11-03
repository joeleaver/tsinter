/* What this machine's network stack can do, probed once per test file (GH #125).
 *
 * A few rows exercise Node behaviour that exists only when the machine has
 * IPv6, or when `localhost` resolves to both 127.0.0.1 and ::1. A container
 * without IPv6 (docs/cloud-env-probe.md) changes Node's own answer for those
 * rows, so they cannot pass there however correct tsinter is. Such a row
 * skips with the reason below, and only when the probe shows the capability
 * is absent. A machine that has it runs the row and its assertions unchanged.
 */
import { createServer } from "node:net";
import { lookup } from "node:dns/promises";

/** Resolves to null when `host` can be bound, else the error code. */
function bindError(host: string): Promise<string | null> {
  return new Promise((resolve) => {
    const s = createServer();
    s.once("error", (e: NodeJS.ErrnoException) => resolve(e.code ?? String(e)));
    s.listen(0, host, () => s.close(() => resolve(null)));
  });
}

async function localhostFamilies(): Promise<number[]> {
  try {
    const all = await lookup("localhost", { all: true });
    return [...new Set(all.map((a) => a.family))].sort();
  } catch {
    return [];
  }
}

const ipv6Error = await bindError("::1");
const families = await localhostFamilies();

/** Binding ::1 works (the kernel has IPv6). */
export const HAS_IPV6 = ipv6Error === null;
/** `localhost` resolves to an IPv4 and an IPv6 address, and IPv6 works, so
 * Node's connect through it tries two addresses (an AggregateError when both
 * are refused). */
export const LOCALHOST_DUAL = HAS_IPV6 && families.includes(4) && families.includes(6);

/** The skip notes, named so a gate log says why each row did not run. */
export const NO_IPV6 = `environment: no IPv6 (binding ::1 failed: ${ipv6Error ?? "-"})`;
export const NO_LOCALHOST_DUAL = `environment: 'localhost' does not resolve to two usable addresses (families [${families.join(",")}], IPv6 ${HAS_IPV6 ? "yes" : "no"})`;
