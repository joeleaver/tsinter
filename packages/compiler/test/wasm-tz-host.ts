/* The `tsinter.tzCall` host (abi.ts; SEMANTICS.md S113) the test hosts
 * share: the zone's questions answered by Node's OWN Date in this
 * process, so a module's local time is Node's by construction — the TZ
 * matrix (tests/harness/wasm-differential.test.ts) runs it under several
 * zones against a Node child given the same TZ.
 *
 *   OFFSET: local wall time minus the instant, read from the local getters
 *           (getTimezoneOffset is truncated to whole minutes; a local-mean-
 *           time offset keeps its seconds here).
 *   NAME:   the parenthesized suffix of String(new Date(ms)) — V8's own
 *           name for the zone at that instant.
 *   ZONE:   process.env.TZ = s (or delete it): Node re-reads its zone when
 *           TZ is assigned. `finish()` puts this process's TZ back, so one
 *           run's ZONE never leaks into the next test.
 *
 * Anything else throws: the module's contract has no other op. */
import { TZ_OP_NAME, TZ_OP_OFFSET, TZ_OP_ZONE } from "../src/backend/wasm/abi.js";

export interface TzHost {
  tzCall: (op: number, ms: number, ptr: number, len: number) => number;
  finish: () => void;
}

/** Days from 1970-01-01 to the civil date (Howard Hinnant's algorithm) —
 * plain arithmetic, because Date.UTC would clip a local time just past the
 * ±8.64e15 edge of the Date range to NaN. */
function daysFromCivil(y: number, m: number, d: number): number {
  y -= m <= 2 ? 1 : 0;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** local - utc at the instant `ms`, in milliseconds, from Node's Date. */
export function nodeZoneOffset(ms: number): number {
  const d = new Date(ms);
  const local =
    daysFromCivil(d.getFullYear(), d.getMonth() + 1, d.getDate()) * 86400000 +
    d.getHours() * 3600000 +
    d.getMinutes() * 60000 +
    d.getSeconds() * 1000 +
    d.getMilliseconds();
  return local - ms;
}

/** V8's zone name at the instant `ms` (Date#toString's suffix). */
export function nodeZoneName(ms: number): string {
  const s = String(new Date(ms));
  const open = s.indexOf("(");
  return open < 0 ? "" : s.slice(open + 1, -1);
}

export function makeTzHost(memory: () => WebAssembly.Memory): TzHost {
  const hadTz = Object.prototype.hasOwnProperty.call(process.env, "TZ");
  const savedTz = process.env["TZ"];
  let touched = false;
  return {
    tzCall(op: number, ms: number, ptr: number, len: number): number {
      if (op === TZ_OP_OFFSET) return nodeZoneOffset(ms);
      if (op === TZ_OP_NAME) {
        const name = nodeZoneName(ms);
        if (name.length > len) return name.length;
        const view = new Uint16Array(memory().buffer, ptr, name.length);
        for (let i = 0; i < name.length; i++) view[i] = name.charCodeAt(i);
        return name.length;
      }
      if (op === TZ_OP_ZONE) {
        touched = true;
        if (len < 0) {
          delete process.env["TZ"];
        } else {
          // Decoded in chunks: a spread of a long value would overflow the
          // argument list.
          const units = new Uint16Array(memory().buffer, ptr, len);
          let tz = "";
          for (let i = 0; i < units.length; i += 4096) tz += String.fromCharCode(...units.subarray(i, i + 4096));
          process.env["TZ"] = tz;
        }
        return 0;
      }
      throw new Error(`tzCall: unknown op ${op}`);
    },
    finish(): void {
      if (!touched) return;
      if (hadTz) process.env["TZ"] = savedTz;
      else delete process.env["TZ"];
    },
  };
}
