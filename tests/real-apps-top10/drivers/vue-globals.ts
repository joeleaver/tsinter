// Vue 2.7's build-time defines (scripts/config.js: @rollup/plugin-replace and scripts/feature-flags.js),
// supplied at run time because the trial runs the unbuilt source. Values as in the CommonJS build
// (vue.runtime.common.js): __DEV__ follows NODE_ENV, the two feature flags as shipped.
const g = globalThis as unknown as Record<string, unknown>;
g["__DEV__"] = process.env["NODE_ENV"] !== "production";
g["__TEST__"] = false;
g["__GLOBAL__"] = false;
process.env["NEW_SLOT_SYNTAX"] = "true";
export {};
