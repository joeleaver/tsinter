// Queue #3 (5 apps / ~119 sites): ES5 constructor functions, prototype methods, Parent.call(this), Object.create,
// props on function objects (expr-eval, papaparse, marked's `marked.setOptions = ...`, peggy's peg$subclass).
function Streamer(config) { this.config = config; this.rows = 0; }
Streamer.prototype.push = function (r) { this.rows += r.length; return this; };
function StringStreamer(config) { Streamer.call(this, config); }
StringStreamer.prototype = Object.create(Streamer.prototype);
StringStreamer.prototype.constructor = StringStreamer;
function api(x) { return x * 2; }
api.version = "1.0";
api.twice = function (x) { return api(api(x)); };
const s = new StringStreamer({ d: "," }).push([1, 2]);
console.log(s.rows, s instanceof Streamer, api.twice(3), api.version);
