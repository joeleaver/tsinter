/* A pool worker: one job at a time over IPC — { id, dir, entry, lanes } in,
 * { id, result } out. Forked by pool.mjs with
 * --experimental-transform-types and --import ./ts-resolve.mjs. */
import { runCase } from "./exec.mjs";

process.on("message", async (job) => {
  let result;
  try {
    result = await runCase(job.dir, job.entry, job.lanes);
  } catch (e) {
    result = { error: String(e?.stack ?? e) };
  }
  process.send({ id: job.id, result });
});
process.send({ ready: true });
