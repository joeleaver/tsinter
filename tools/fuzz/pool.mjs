/* A pool of forked workers (worker.mjs). `run(job)` resolves with the
 * worker's result; a job that outlives `timeoutMs` kills its worker (a
 * fresh one takes its place) and resolves as a timeout crash. */
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";

const WORKER = fileURLToPath(new URL("./worker.mjs", import.meta.url));
const RESOLVE = fileURLToPath(new URL("./ts-resolve.mjs", import.meta.url));

export class Pool {
  constructor(size, timeoutMs = 180_000) {
    this.size = size;
    this.timeoutMs = timeoutMs;
    this.idle = [];
    this.waiting = [];
    this.nextId = 1;
    this.all = new Set();
    for (let i = 0; i < size; i++) this.spawn();
  }
  spawn() {
    const child = fork(WORKER, [], {
      execArgv: ["--experimental-transform-types", "--disable-warning=ExperimentalWarning", "--import", RESOLVE],
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    child.stderr.on("data", () => {});
    const w = { child, job: null, ready: false };
    this.all.add(w);
    child.on("message", (m) => {
      if (m.ready) {
        w.ready = true;
        this.release(w);
        return;
      }
      const job = w.job;
      if (job === null || m.id !== job.id) return;
      clearTimeout(job.timer);
      w.job = null;
      job.resolve(m.result);
      this.release(w);
    });
    child.on("exit", () => {
      this.all.delete(w);
      if (this.closed) return;
      if (w.job !== null) {
        clearTimeout(w.job.timer);
        const j = w.job;
        w.job = null;
        j.resolve(j.timedOut ? { timeout: true } : { error: "worker exited" });
      }
      this.idle = this.idle.filter((x) => x !== w);
      this.spawn();
    });
  }
  release(w) {
    const next = this.waiting.shift();
    if (next) this.start(w, next);
    else this.idle.push(w);
  }
  start(w, job) {
    w.job = job;
    job.timer = setTimeout(() => {
      job.timedOut = true;
      w.child.kill("SIGKILL");
    }, this.timeoutMs);
    w.child.send({ id: job.id, ...job.payload });
  }
  run(payload) {
    return new Promise((resolve) => {
      const job = { id: this.nextId++, payload, resolve };
      const w = this.idle.shift();
      if (w) this.start(w, job);
      else this.waiting.push(job);
    });
  }
  close() {
    this.closed = true;
    for (const w of this.all) w.child.kill("SIGKILL");
  }
}
