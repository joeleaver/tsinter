// node:http options that reach the backends with Node's own values: an
// Agent keeps negative keepAliveMsecs / maxSockets / maxFreeSockets
// (Node's `|| default` only replaces falsy values), validates scheduling
// ('' reads 'lifo', anything but fifo/lifo throws), and its negative
// timeout or port make a request through it throw; a request's timeout is
// validated (-1, NaN throw) and timeout: 0 clears the agent's socket
// timeout; agent: false is a fresh one-shot Agent even when the headers
// set Connection: keep-alive; requireHostHeader decides whether a
// Host-less HTTP/1.1 request is answered 400; writeHead checks its status
// before taking the reason; setHeader keeps a number. Causally ordered:
// one step at a time.
import * as http from "node:http";
import * as net from "node:net";

function attempt(label: string, fn: () => void): void {
  try {
    fn();
    console.log(`${label}: ok`);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    console.log(`${label}: ${err.name} ${err.code} ${err.message}`);
  }
}

const neg = new http.Agent({ keepAliveMsecs: -5, maxSockets: -1, maxFreeSockets: -2 });
console.log("negatives kept:", neg.keepAliveMsecs, neg.maxSockets, neg.maxFreeSockets);
const zero = new http.Agent({ keepAliveMsecs: 0, maxSockets: 0, maxFreeSockets: 0 });
console.log("zeros default:", zero.keepAliveMsecs, zero.maxSockets, zero.maxFreeSockets);
attempt("scheduling fifo", () => {
  new http.Agent({ scheduling: "fifo" });
});
const empty: string = "";
attempt("scheduling ''", () => {
  new http.Agent({ scheduling: empty as "lifo" });
});
const bogus: string = "bogus";
attempt("scheduling bogus", () => {
  new http.Agent({ scheduling: bogus as "fifo" });
});

// Raw HTTP/1.1 without a Host header against three servers.
function hostless(server: http.Server, label: string, done: () => void): void {
  server.listen(0, "127.0.0.1", () => {
    const c = net.connect(server.address().port, "127.0.0.1");
    let got = "";
    c.on("data", (d: Buffer) => {
      got += d.toString("latin1");
    });
    c.on("end", () => {
      console.log(`${label}: ${got.split("\r\n")[0]}`);
      server.close(() => done());
    });
    c.write("GET / HTTP/1.1\r\nConnection: close\r\n\r\n");
  });
}

function hostChecks(done: () => void): void {
  const off = http.createServer({ requireHostHeader: false }, (req, res) => {
    res.end("listener ran");
  });
  hostless(off, "requireHostHeader false", () => {
    const on = http.createServer({ requireHostHeader: true }, (req, res) => {
      res.end("listener ran");
    });
    hostless(on, "requireHostHeader true", () => {
      const dflt = http.createServer((req, res) => {
        res.end("listener ran");
      });
      hostless(dflt, "requireHostHeader default", done);
    });
  });
}

function clientChecks(done: () => void): void {
  let connections = 0;
  let held: http.ServerResponse | null = null;
  const server = http.createServer((req, res) => {
    console.log(`srv ${req.url} connection=${req.headers["connection"]}`);
    if (req.url === "/hold") {
      held = res;
      return;
    }
    if (req.url === "/slow") {
      setTimeout(() => res.end("slow"), 300);
      return;
    }
    if (req.url === "/raw") {
      // an Agent with unlimited sockets and no keep-alive: Connection:
      // close, after Host, as _storeHeader writes it
      console.log("raw", JSON.stringify(req.rawHeaders.filter((h) => h.indexOf("127.0.0.1") !== 0)));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const hdrs: any = { "X-A": "1" };
      res.writeHead(201, "Okay Then", hdrs);
      res.end("raw");
      return;
    }
    res.statusMessage = "Before";
    res.setHeader("X-Count", 5);
    const count = res.getHeader("X-Count");
    console.log("getHeader keeps the number:", count === 5, count === "5");
    try {
      res.writeHead(99, "Odd");
    } catch (e) {
      console.log("writeHead threw:", (e as Error).message);
    }
    console.log("statusMessage after:", res.statusMessage);
    res.end("done");
  });
  server.on("connection", () => {
    connections++;
  });
  server.listen(0, "127.0.0.1", () => {
    const port = server.address().port;
    attempt("agent timeout -3", () => {
      http.request({ hostname: "127.0.0.1", port, agent: new http.Agent({ timeout: -3 }) });
    });
    attempt("agent port -4", () => {
      http.request({ hostname: "127.0.0.1", port, agent: new http.Agent({ port: -4 }) });
    });
    attempt("request timeout -1", () => {
      http.request({ hostname: "127.0.0.1", port, timeout: -1 });
    });
    attempt("request timeout NaN", () => {
      http.request({ hostname: "127.0.0.1", port, timeout: NaN });
    });
    const timed = new http.Agent({ timeout: 50 });
    // No request timeout: the agent's 50 ms socket timeout fires.
    const a = http.request({ hostname: "127.0.0.1", port, path: "/hold", agent: timed }, (res) => {
      res.resume();
      res.on("end", () => {
        // timeout: 0 clears the agent's timeout on the socket.
        const b = http.request({ hostname: "127.0.0.1", port, path: "/slow", agent: timed, timeout: 0 }, (res2) => {
          res2.resume();
          res2.on("end", () => {
            console.log("timeout 0: no timeout fired, status", res2.statusCode);
            const raw = http.request(
              { hostname: "127.0.0.1", port, path: "/raw", agent: new http.Agent({}), headers: { "X-A": "1" } },
              (res3) => {
                console.log("reason through a headers record:", res3.statusCode, res3.statusMessage);
                res3.resume();
                res3.on("end", () => {
                  oneShot(port, () => {
                    console.log("connections:", connections);
                    server.close(() => done());
                  });
                });
              },
            );
            raw.end();
          });
        });
        b.on("timeout", () => {
          console.log("timeout 0: timeout fired (wrong)");
        });
        b.end();
      });
    });
    a.on("timeout", () => {
      console.log("agent timeout fired");
      held!.end("released");
    });
    a.end();
  });
}

// agent: false with Connection: keep-alive — each request is its own
// Agent, so each dials its own connection (the global agent would reuse).
function oneShot(port: number, done: () => void): void {
  const before = Date.now();
  const r1 = http.request(
    { hostname: "127.0.0.1", port, path: "/one", agent: false, headers: { Connection: "keep-alive" } },
    (res) => {
      res.resume();
      res.on("end", () => {
        const r2 = http.request(
          { hostname: "127.0.0.1", port, path: "/two", agent: false, headers: { Connection: "keep-alive" } },
          (res2) => {
            res2.resume();
            res2.on("end", () => {
              console.log("one-shot pair done", Date.now() - before < 4000);
              done();
            });
          },
        );
        r2.end();
      });
    },
  );
  r1.end();
}

hostChecks(() => {
  clientChecks(() => {
    console.log("done");
  });
});
