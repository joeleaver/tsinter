/* S125 (paperclip's telemetry start-up, cli/src/telemetry.ts): a config
 * object read through a JavaScript package (zod's parse, here a stand-in that
 * writes to the parsed object as zod does) handed to an optional typed
 * parameter `fileConfig?: { enabled?: boolean }` is the caller's object, as
 * in Node; and a state object read back with JSON.parse, handed out through
 * a `() => State` factory a class keeps, is the same object to every holder. */
import { defineRows } from "./u3u4-rows.js";

const CFG: Record<string, string> = {
  "node_modules/cfg/package.json": `{"name":"cfg","version":"1.0.0","type":"module","exports":{".":{"types":"./index.d.ts","default":"./index.js"}}}`,
  "node_modules/cfg/index.js": `export function load(text) { const o = JSON.parse(text); o.loaded = true; if (o.telemetry === undefined) o.telemetry = { enabled: true }; return o; }`,
  "node_modules/cfg/index.d.ts": `export type Config = { name?: string; telemetry: { enabled?: boolean } };
export declare function load(text: string): Config;`,
};

const TELE = `import { load, type Config } from "cfg";
let held: { enabled?: boolean } | undefined;
export function readConfig(text: string): Config | null {
  if (text === "") return null;
  return load(text);
}
export function initTelemetry(fileConfig?: { enabled?: boolean }): string {
  held = fileConfig;
  return fileConfig?.enabled === false ? "off" : "on";
}
export function initTelemetryFromConfigFile(text: string): string {
  try {
    return initTelemetry(readConfig(text)?.telemetry);
  } catch {
    return initTelemetry();
  }
}
export function heldEnabled(): boolean | undefined { return held?.enabled; }`;

const STATE = `export type State = { installId: string; salt: string; createdAt: string };
export function loadOrCreateState(raw: string | null, version: string): State {
  if (raw !== null) {
    try {
      const parsed = JSON.parse(raw) as State;
      if (parsed.installId && parsed.salt) {
        return parsed;
      }
    } catch {
      // corrupted: recreate
    }
  }
  const state: State = { installId: "id-" + version, salt: "s", createdAt: "now" };
  return state;
}`;

const CLIENT = `import type { State } from "./state.ts";
export class Client {
  private readonly stateFactory: () => State;
  private state: State | null = null;
  constructor(stateFactory: () => State, readonly version: string) { this.stateFactory = stateFactory; }
  getState(): State {
    if (!this.state) this.state = this.stateFactory();
    return this.state;
  }
}`;

defineRows("S125 telemetry start-up", [
  {
    id: "S125-T-01 (cli/src/telemetry.ts:29) a package-parsed config's telemetry object into an optional typed parameter: the callee holds the caller's object",
    entry: "main.ts", npmStatic: ["cfg"], files: { ...CFG, "telemetry.ts": TELE },
    src: `import { initTelemetryFromConfigFile, initTelemetry, heldEnabled, readConfig } from "./telemetry.ts";
console.log(initTelemetryFromConfigFile('{"telemetry":{"enabled":false}}'), heldEnabled());
console.log(initTelemetryFromConfigFile('{"name":"x"}'), heldEnabled());
console.log(initTelemetryFromConfigFile(""), heldEnabled());
console.log(initTelemetryFromConfigFile("{bad"), heldEnabled());
const c = readConfig('{"telemetry":{"enabled":false,"extra":1}}');
console.log(initTelemetry(c?.telemetry), heldEnabled());
if (c) c.telemetry.enabled = true;
console.log(heldEnabled(), JSON.stringify(c));
console.log(initTelemetry({ enabled: false }), heldEnabled(), initTelemetry(), heldEnabled());`,
  },
  {
    id: "S125-T-02 (cli/src/telemetry.ts:23) a JSON.parse-read state handed out through a class's `() => State` factory: one object to every holder",
    entry: "main.ts", files: { "state.ts": STATE, "client.ts": CLIENT },
    src: `import { loadOrCreateState } from "./state.ts";
import { Client } from "./client.ts";
const version = "1.2.3";
const raws: (string | null)[] = ['{"installId":"abc","salt":"x","createdAt":"t0"}', null, "{oops", '{"installId":"","salt":"x","createdAt":"t"}'];
for (const raw of raws) {
  const client = new Client(() => loadOrCreateState(raw, version), version);
  const a = client.getState();
  const b = client.getState();
  console.log(a.installId, a.salt, a.createdAt, a === b);
}`,
  },
]);
