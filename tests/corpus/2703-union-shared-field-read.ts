// Shared-field reads on union receivers beyond primitives: every arm
// carries a same-typed field, so the read tag-dispatches (the ServiceSpec
// pattern — three platform arms, one shared `config` record). Records,
// arrays, and nested chains through the shared field all read without
// narrowing first.
interface Config {
  port: number;
  tld: string;
}

type Spec =
  | { platform: "darwin"; label: string; config: Config; args: string[] }
  | { platform: "linux"; unit: string; config: Config; args: string[] }
  | { platform: "win32"; task: string; config: Config; args: string[] };

function mk(p: string): Spec {
  if (p === "darwin") {
    return { platform: "darwin", label: "com.portless", config: { port: 443, tld: "localhost" }, args: ["launchctl"] };
  }
  if (p === "linux") {
    return { platform: "linux", unit: "portless.service", config: { port: 8080, tld: "local" }, args: ["systemctl", "start"] };
  }
  return { platform: "win32", task: "Portless", config: { port: 80, tld: "test" }, args: [] as string[] };
}

for (const p of ["darwin", "linux", "win32"]) {
  const spec = mk(p);
  // The primitive discriminant still reads (the historic pattern)...
  console.log(spec.platform);
  // ...and the RECORD-typed shared field reads through the same dispatch.
  const config = spec.config;
  console.log(config.port, config.tld);
  // Chained access without binding: read, then member.
  console.log(spec.config.port + 1);
  // Array-typed shared fields too.
  console.log(spec.args.length, spec.args.join("+"));
}

// The shared record ALIASES like any record reference: a write through the
// extracted field is visible through a re-read.
const s = mk("linux");
s.config.port = 9999;
console.log(s.config.port);

// switch on the discriminant still narrows arms as before.
const t = mk("win32");
switch (t.platform) {
  case "win32":
    console.log(t.task, t.config.tld);
    break;
  default:
    console.log("other");
}
