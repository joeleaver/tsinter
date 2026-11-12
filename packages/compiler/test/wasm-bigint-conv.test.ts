/* BigInt conversions and containers: BigInt(x) over every argument kind
 * (unions included), toString/toLocaleString, Number/String/templates,
 * Map/Set keys by value, class fields, and the 64-bit Buffer/DataView
 * readers and writers with Node's range errors (fixtures/bigint/). */
import { bigintRows } from "./wasm-bigint-harness.js";

bigintRows("BigInt conversions", ["unions-hash", "buffers"]);
