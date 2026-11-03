// Routing through polka 0.5.2 (+ trouter, matchit, @polka/url; --npm-static) without a socket:
// requests are plain objects handed to app.handler, responses record what the app writes.
import polka from "polka";

const log = [];
const app = polka({
  onNoMatch: (req, res) => {
    res.statusCode = 404;
    res.end("no route for " + req.url);
  },
})
  .use((req, res, next) => {
    log.push(`mw ${req.method} ${req.url}`);
    next();
  })
  .use("/api", (req, res, next) => {
    req.api = true;
    next();
  })
  .get("/", (req, res) => res.end("home"))
  .get("/users/:id", (req, res) => res.end(`user ${req.params.id} api=${req.api === true} query=${JSON.stringify(req.query)}`))
  .post("/api/items/:a/:b?", (req, res) => {
    res.setHeader("X-Item", req.params.a);
    res.end(`item ${req.params.a} ${req.params.b ?? "-"} api=${req.api === true}`);
  })
  .get("/fail", (req, res, next) => next(new Error("boom")))
  .get("/files/*", (req, res) => res.end(`wild ${req.params.wild}`));

function call(method, url) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      headers: {},
      setHeader(k, v) {
        this.headers[k.toLowerCase()] = v;
      },
      end(body) {
        resolve(`${method} ${url} -> ${this.statusCode} ${JSON.stringify(this.headers)} ${body}`);
      },
    };
    app.handler({ method, url, headers: {} }, res);
  });
}

const reqs = [
  ["GET", "/"],
  ["GET", "/users/42?x=1&y=two"],
  ["POST", "/api/items/7"],
  ["POST", "/api/items/7/8"],
  ["GET", "/fail"],
  ["GET", "/files/a/b/c.txt"],
  ["DELETE", "/users/1"],
  ["GET", "/nowhere"],
];
for (const [m, u] of reqs) console.log(await call(m, u));
console.log(log.join("\n"));
