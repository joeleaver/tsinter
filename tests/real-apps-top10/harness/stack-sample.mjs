// node stack-sample.mjs <port> : print one JS stack sample of a busy Node process (nico-top only) whose
// inspector already listens on 127.0.0.1:<port> (phase-probe.sh starts the compile with --inspect).
// No signal is sent: SIGUSR1 (opening the inspector late) interrupts a blocking read in the compiler's
// synchronous tsgo channel (EINTR) and kills the compile. Debugger.pause answers the main thread's call
// frames when it next runs JS (a long synchronous tsgo request delays the answer); the target resumes
// right after.
const port = Number(process.argv[2] ?? 9229);
let list;
for (let i = 0; i < 25 && !list; i++) {
  list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json()).catch(() => undefined);
  if (!list) await new Promise((r) => setTimeout(r, 200));
}
if (!list?.[0]) { console.log("no inspector answer"); process.exit(1); }
const ws = new WebSocket(list[0].webSocketDebuggerUrl);
let id = 0;
const send = (method, params = {}) => ws.send(JSON.stringify({ id: ++id, method, params }));
const scripts = new Map();
const done = setTimeout(() => { console.log("no pause within 60s (the main thread is in one long synchronous call)"); process.exit(1); }, 60000);
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
