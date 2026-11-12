/* BigInt operators: arithmetic, comparison, bitwise and shifts, their
 * RangeErrors, huge values, negative shifts, asIntN/asUintN wraparound,
 * -0n, and comparisons against NaN and the infinities (fixtures/bigint/).
 * Every row runs under Node and must match it byte for byte on the wasm and
 * wasm-native lanes. */
import { bigintRows } from "./wasm-bigint-harness.js";

bigintRows("BigInt operators", ["arith", "errors-containers", "edges", "size-limit"]);
