// node stack-sample.mjs <pid> [port=9229] : print one JS stack sample of a busy Node process (nico-top only).
// SIGUSR1 opens the target's inspector (Node handles it off the main thread, so it works while the
// compiler is in a long synchronous phase, unlike --report-on-signal, whose handler waits for the event
// loop). Debugger.pause then answers the main thread's call frames; the target resumes right after.
const [pid, portArg] = process.argv.slice(2);
const port = Number(portArg ?? 9229);
process.kill(Number(pid), "SIGUSR1");
let list;
for (let i = 0; i < 50 && !list; i++) {
  await new Promise((r) => setTimeout(r, 200));
  list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json()).catch(() => undefined);
}
if (!list?.[0]) { console.log("no inspector answer"); process.exit(1); }
const ws = new WebSocket(list[0].webSocketDebuggerUrl);
let id = 0;
const send = (method, params = {}) => ws.send(JSON.stringify({ id: ++id, method, params }));
const scripts = new Map();
const done = setTimeout(() => { console.log("no pause within 60s"); process.exit(1); }, 60000);
ws.onopen = () => { send("Debugger.enable"); send("Debugger.pause"); };
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.method === "Debugger.scriptParsed") scripts.set(m.params.scriptId, m.params.url);
  if (m.method === "Debugger.paused") {
    for (const f of m.params.callFrames.slice(0, 30)) {
      const url = (scripts.get(f.location.scriptId) ?? f.url ?? "").replace(/^.*\/packages\//, "packages/");
      console.log(`  ${f.functionName || "(anon)"}  ${url}:${f.location.lineNumber + 1}`);
    }
    send("Debugger.resume");
    send("Debugger.disable");
    clearTimeout(done);
    setTimeout(() => { ws.close(); process.exit(0); }, 300);
  }
};
