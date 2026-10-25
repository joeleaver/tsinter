/* The options-record stance's FENCE half (the accept-and-drop half is
 * corpus 1750/1751): every key typechecks against the widened fallback
 * declarations, and the option walks fence BY NAME — documented keys the
 * compiler cannot honor, value shapes it cannot lower, and effectful
 * values on keys Node would ignore but still evaluate. Never a generic
 * excess-property error. */
import * as http from "node:http";
import * as net from "node:net";
import * as tls from "node:tls";
import * as fs from "node:fs";
import * as dns from "node:dns";
import * as readline from "node:readline";

// The Agent lowers to a checked-dynamic handle now — but only from a
// LITERAL options object; a runtime options value cannot be walked.
const agentOpts: http.AgentOptions = { maxSockets: 1 };
const agent = new http.Agent(agentOpts);
http.get({ port: 80, agent }, () => {});

// agent: false is Node's one-shot Agent, which dials with its own
// createConnection and ignores the option's dialer.
http.get({ path: "/", agent: false, createConnection: () => net.connect(80) }, () => {});

// Documented client options with no lowering fence by name.
http.get({ port: 80, socketPath: "/tmp/sock.s" }, () => {});
http.get({ port: 80, localAddress: "127.0.0.1" }, () => {});

// An UNDOCUMENTED key Node would ignore — but Node still evaluates the
// value, so an effectful one cannot silently drop.
function effect(): number {
  console.log("observed");
  return 1;
}
http.get({ port: 80, zorp: effect() }, () => {});

// Documented TLS server options with no lowering fence by name.
tls.createServer({ cert: "c", key: "k", ciphers: "TLS_AES_128_GCM_SHA256" }, () => {});
tls.createServer({ cert: "c", key: "k", ticketKeys: new Uint8Array(48) }, () => {});

// fs.watch: the options that would CHANGE behavior fence by name; the
// stated defaults are accepted (corpus 1751).
fs.watch("/tmp", { recursive: true }, () => {});
fs.watch("/tmp", { persistent: false }, () => {});

// dns.lookup: hints/all are documented knobs with no lowering.
dns.lookup("localhost", { family: 4, hints: 32 }, () => {});
dns.lookup("localhost", { family: 4, all: true }, () => {});

// readline: completer needs an interactive terminal (a finite crlfDelay
// lowers since unit G2: the splitter keeps Node's kSawReturnAt window).
readline.createInterface({ input: process.stdin, output: process.stdout, crlfDelay: 100 });
readline.createInterface({ input: process.stdin, output: process.stdout, completer: (l: string) => [[l], l] });
