/* The node column's module hooks (driver.mjs): the host modules a row
 * imports ("pw", ...) resolve to the test host's table, so the row's
 * TypeScript runs unchanged under Node — the oracle — while the compiled
 * module takes the same names as wasm imports.
 *
 * LIBMODE_HOSTS: the host module names, comma-separated. */
import { register } from "node:module";

register("./hooks.mjs", import.meta.url, {
  data: { hosts: (process.env.LIBMODE_HOSTS ?? "").split(",").filter((s) => s !== "") },
});
