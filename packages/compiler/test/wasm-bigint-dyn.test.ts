/* BigInt in the dynamic world (unknown, any, JavaScript sources): the
 * BIGINT kind's typeof/truthiness/===/String/inspect/JSON/keys, any-typed
 * arithmetic and comparisons with V8's mixing TypeError, and zod 4's
 * BIGINT_FORMAT_RANGES construction (fixtures/bigint/). */
import { bigintRows } from "./wasm-bigint-harness.js";

bigintRows("BigInt dynamic values", ["dyn-unknown", "dyn-narrow", "dyn-any", "zod-ranges.js", "js-mixed.js", "dyn-review"]);
