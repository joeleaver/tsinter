// The validateConfig idiom over unknown JSON: typeof-object gating (null
// and array arms included), Array.isArray on unknown, and typeof tests on
// overflow reads BEHIND a `!== undefined` guard (the checker's narrowing
// residue `{}` — the read is still the dynamic value), with narrowed
// reads flowing into static string/number code.
function describe(raw: unknown): string {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return "not a plain object";
  }
  const obj = raw as Record<string, unknown>;
  const parts: string[] = [];
  if (obj.name !== undefined) {
    if (typeof obj.name !== "string" || !obj.name.trim()) {
      return "bad name";
    }
    parts.push("name=" + obj.name.trim());
  }
  if (obj.port !== undefined) {
    if (typeof obj.port !== "number" || obj.port < 1 || obj.port > 65535) {
      return "bad port";
    }
    parts.push("port=" + (obj.port + 0));
  }
  if (obj.proxy !== undefined) {
    if (typeof obj.proxy !== "boolean") {
      return "bad proxy";
    }
    parts.push("proxy=" + (obj.proxy ? "on" : "off"));
  }
  if (obj.apps !== undefined) {
    if (typeof obj.apps !== "object" || obj.apps === null || Array.isArray(obj.apps)) {
      return "bad apps";
    }
    parts.push("apps=object");
  }
  return parts.length > 0 ? parts.join(" ") : "empty";
}

console.log(describe(JSON.parse('{"name":" web ","port":3000,"proxy":true}')));
console.log(describe(JSON.parse('{"apps":{"a":1}}')));
console.log(describe(JSON.parse('{"apps":[1]}')));
console.log(describe(JSON.parse('{"name":"  "}')));
console.log(describe(JSON.parse('{"port":70000}')));
console.log(describe(JSON.parse('{"proxy":"yes"}')));
console.log(describe(JSON.parse("[1,2,3]")));
console.log(describe(JSON.parse("null")));
console.log(describe(JSON.parse("42")));
console.log(describe(JSON.parse("{}")));
// typeof-object and isArray over every dyn kind.
const cases: string[] = ['"s"', "1", "true", "null", "[]", "{}", '[{"deep":[]}]'];
for (const src of cases) {
  const v: unknown = JSON.parse(src);
  console.log(src, typeof v === "object", Array.isArray(v), typeof v !== "object");
}
// Static operands decide at compile time.
const xs = [1, 2];
const s = "str";
console.log(Array.isArray(xs), Array.isArray(s));
