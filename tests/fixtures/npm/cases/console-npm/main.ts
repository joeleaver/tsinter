// @dynamic
// The island console in an npm-embedding build is the same console as in a
// plain --dynamic build (board #306): consolezoo logs through it, byte-exact
// against Node, stdout and stderr.
import { logAll } from "consolezoo";

logAll();
console.log("static after");
