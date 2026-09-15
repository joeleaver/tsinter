// Set<http.Server> — handle elements stored under REFERENCE IDENTITY
// (SameValueZero for objects), the portless auxiliary-server registry:
// add/has/delete answer by identity, re-adding the same handle dedupes
// (first insertion position kept), and the [...a, ...b] drain walks
// insertion order. The servers never listen — the set semantics are the
// whole story here (the server differential owns the listening side).
import * as http from "node:http";

function mk(): ReturnType<typeof http.createServer> {
  return http.createServer(() => {});
}

const a = mk();
const b = mk();
const servers = new Set<ReturnType<typeof mk>>();
servers.add(a);
servers.add(b);
servers.add(a); // identity dedupe: still 2, a keeps position 0
console.log(servers.size, servers.has(a), servers.has(b), servers.has(mk()));

const extras = new Set<ReturnType<typeof mk>>();
extras.add(mk());

// The teardown-loop shape: spread both registries into one array.
const all = [...servers, ...extras];
console.log(all.length);
let visited = 0;
for (const s of all) {
  visited = visited + 1;
  s.close();
}
console.log("visited", visited);

console.log(servers.delete(a), servers.delete(a), servers.size);
servers.clear();
console.log(servers.size, extras.size);
