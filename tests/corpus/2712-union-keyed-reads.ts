// The unionDisc generalization: keyed reads on union receivers whose arms
// answer DIFFERENT (but joinable) types — the env-bag parameter pattern
// (`ProcessEnv | Record<string, string>`, dot and bracket forms) and the
// optional-chain tail (`loaded?.config.script` — the undefined arm answers
// undefined, exactly the chain's short-circuit).
interface AppConfig {
  script?: string;
  name?: string;
  turbo?: boolean;
}
interface Loaded {
  config: AppConfig;
}
function load(x: number): Loaded | null {
  if (x > 0) {
    const c: AppConfig = { script: "dev-script", turbo: false };
    return { config: c };
  }
  return null;
}
console.log(load(1)?.config.script ?? "default");
console.log(load(-1)?.config.script ?? "default");
console.log(load(1)?.config.name ?? "anon");
console.log(load(1)?.config.turbo !== false ? "turbo" : "no-turbo");
console.log(load(-1)?.config.turbo !== false ? "turbo" : "no-turbo");

type EnvBag = Record<string, string | undefined> | Record<string, string>;
function readDot(env: EnvBag): string {
  if (env.SCRIPTC_TEST_ENV) {
    return env.SCRIPTC_TEST_ENV;
  }
  return "(unset)";
}
function readKey(env: EnvBag, key: string): string {
  const value = env[key];
  if (value) return value;
  return "(unset)";
}
const bag: Record<string, string> = { SCRIPTC_TEST_ENV: "from-bag", OTHER: "x" };
const empty: Record<string, string> = {};
console.log(readDot(process.env), readDot(bag), readDot(empty));
console.log(readKey(process.env, "SCRIPTC_TEST_ENV"), readKey(bag, "OTHER"), readKey(empty, "MISSING"));

// Mixed-type shared fields: the arms answer DIFFERENT types and the read
// joins them (number | string here) — narrowing tests extract as usual.
interface ArmA {
  kind: string;
  v: number;
}
interface ArmB {
  kind: string;
  v: string;
}
function mkAB(x: number): ArmA | ArmB {
  if (x > 0) return { kind: "a", v: 42 };
  return { kind: "b", v: "hello" };
}
const m1 = mkAB(1).v;
const m2 = mkAB(-1).v;
console.log(typeof m1 === "number" ? m1 : -1, typeof m2 === "string" ? m2 : "?");

// Multi-step chain over a record tail: the undefined-armed receiver joins
// into `number | undefined` — JS's whole-tail short-circuit exactly.
interface Inner {
  size: number;
}
interface Outer {
  inner: Inner;
}
function deepChain(o: Outer | undefined): number {
  return o?.inner.size ?? 0;
}
console.log(deepChain(undefined), deepChain({ inner: { size: 7 } }));
