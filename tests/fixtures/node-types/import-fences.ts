/* An unsupported IMPORT no longer stops analysis at preflight: the module
 * fence joins the blockers, the imported bindings poison at their use
 * sites (grouping with the import line), and every other statement still
 * counts — the report shows a percentage. (net, then dgram, graduated to
 * supported modules, so the out-of-scope "v8" carries this test now.) Since
 * R2 (SEMANTICS.md S129) v8's bindings are stubs: the import line is no
 * longer a blocker, only the statement that touches one (a build runs up to
 * it and stops there by name). */
import { getHeapStatistics } from "v8";
import { join } from "node:path";

const cmd = join("/usr", "bin", "afplay");
console.log(cmd);
getHeapStatistics();
console.log("after");
