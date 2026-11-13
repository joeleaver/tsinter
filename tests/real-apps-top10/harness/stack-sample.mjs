// node stack-sample.mjs <port> : print one JS stack sample of a busy Node process (nico-top only) whose
// inspector already listens on 127.0.0.1:<port> (phase-probe.sh starts the compile with --inspect).
// No signal is sent: SIGUSR1 (opening the inspector late) interrupts a blocking read in the compiler's
// synchronous tsgo channel (EINTR) and kills the compile. Debugger.pause answers the main thread's call
// frames when it next runs JS (a long synchronous tsgo request delays the answer); the target resumes
// right after.
//
// Past the top frames, a deep type-mapping recursion collapses to the frames outside
// frontend/types.js with counts between; and the sample names WHERE it is: the class and member a
// class-shape collection is mapping (collectClassShapeInner's `decl`/`member`), and the property path
// the record mapping is walking (each mapRecordTypeInner frame's loop symbol `p`). Evaluation reads
// locals only — a property read on a compiler object, no tsgo request.
const port = Number(process.argv[2] ?? 9229);
let list;
for (let i = 0; i < 25 && !list; i++) {
  list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json()).catch(() => undefined);
  if (!list) await new Promise((r) => setTimeout(r, 200));
}
if (!list?.[0]) { console.log("no inspector answer"); process.exit(1); }
const ws = new WebSocket(list[0].webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const send = (method, params = {}) => {
  const my = ++id;
  ws.send(JSON.stringify({ id: my, method, params }));
  return new Promise((res) => pending.set(my, res));
};
const scripts = new Map();
const done = setTimeout(() => { console.log("no pause within 60s (the main thread is in one long synchronous call)"); process.exit(1); }, 60000);
ws.onopen = () => { send("Debugger.enable"); send("Debugger.pause"); };

const evalOn = async (frame, expression) => {
  const r = await send("Debugger.evaluateOnCallFrame", { callFrameId: frame.callFrameId, expression, silent: true, timeout: 500 });
  return r?.result?.result?.value;
};

const report = async (frames) => {
  let skipped = 0;
  let printed = 0;
  frames.forEach((f, i) => {
    const url = (scripts.get(f.location.scriptId) ?? f.url ?? "").replace(/^.*\/packages\//, "packages/");
    if (i >= 12 && url.includes("frontend/types.js")) { skipped++; return; }
    if (printed >= 60) return;
    if (skipped > 0) { console.log(`  … ${skipped} frames in frontend/types.js`); skipped = 0; }
    console.log(`  ${f.functionName || "(anon)"}  ${url}:${f.location.lineNumber + 1}`);
    printed++;
  });
  if (skipped > 0) console.log(`  … ${skipped} frames in frontend/types.js`);
  console.log(`  (${frames.length} frames)`);
  for (const f of frames) {
    if (f.functionName !== "collectClassShapeInner") continue;
    const at = await evalOn(f, `(() => { try { return String(decl?.name?.text ?? "<anon class>") + "." + String(member?.name?.text ?? "?") + " @ " + String(decl?.getSourceFile?.()?.fileName ?? "?"); } catch (e) { return "eval failed: " + e; } })()`);
    if (at !== undefined) { console.log(`  CLASS-SHAPE ${at}`); break; }
  }
  const path = [];
  for (const f of [...frames].reverse()) {
    if (f.functionName !== "mapRecordTypeInner") continue;
    const name = await evalOn(f, `(() => { try { return typeof p === "undefined" || p === undefined ? "·" : String(p.name ?? p.escapedName ?? "?"); } catch (e) { return "!"; } })()`);
    path.push(name ?? "?");
  }
  if (path.length > 0) console.log(`  RECORD-PATH (${path.length}) ${path.join(" > ")}`);
};

ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === "Debugger.scriptParsed") scripts.set(m.params.scriptId, m.params.url);
  if (m.method === "Debugger.paused") {
    report(m.params.callFrames).finally(() => {
      send("Debugger.resume");
      send("Debugger.disable");
      clearTimeout(done);
      setTimeout(() => { ws.close(); process.exit(0); }, 300);
    });
  }
};
