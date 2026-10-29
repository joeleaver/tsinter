// polka 0.5.2: `class Polka extends Trouter` overrides the untyped `add(method, pattern, ...fns)` it inherits
// ("overriding the inherited generic method 'add' with a non-generic method").
class Trouter {
  constructor() { this.routes = {}; }
  add(method, pattern, ...fns) { (this.routes[method] = this.routes[method] || []).push([pattern, fns.length]); return this; }
}
class Polka extends Trouter {
  add(method, pattern, ...fns) {
    if (pattern === "/bad") throw new Error("no");
    return super.add(method, pattern, ...fns);
  }
}
const app = new Polka();
app.add("GET", "/x", () => 1, () => 2);
console.log(JSON.stringify(app.routes));
