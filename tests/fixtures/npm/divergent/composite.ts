// @dynamic
// A typed RECORD parameter on a callback a package calls (SEMANTICS.md
// S115 (d)): each call would COPY the package's object into typed storage —
// the package could change it under the copy, or hand more than the type
// declares — so the program is refused at compile time, by name, on every
// lane (npm.test.ts asserts the diagnostic).
import { catching } from "typedcb";

const composite: string = catching((o: { name: string }) => o.name, { name: "x" });
console.log(composite);
