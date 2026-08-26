// The "Received ..." tail of Node's ERR_INVALID_ARG_TYPE, rendered across
// determineSpecificType's number specials (NaN, both infinities, plain
// number, negative), boolean, null, quoted-string, and "an instance of X"
// container arms — one call site (finished()'s isNodeStream ladder) takes
// every shape. Re-derived by the corpus-scan census (board #94) from board
// #26's determineSpecificType renderer probes. (Formerly g6 in the
// corpus-scan re-derivation — renamed per board #94's fix round, task
// #94/94-D1.)
//
// CONSTRAINTS (task #94, both native-lane-only, unfixed as of board #93):
// no -0 cell (the renderer diverges from Node/wasm on the C lane there),
// and every string kept to 26 characters or fewer (the C-lane truncation
// threshold/prefix/quoting divergence starts at 27). FUNC/BYTES/UNDEF arms
// are left out because they are unreachable here: board #68's frontend
// fence (SC2020) refuses undefined/symbol and function/Buffer/Uint8Array
// values in this position before the renderer is ever reached.
'use strict';
const { finished } = require('stream');
const show = (fn) => { try { fn(); console.log('ok'); } catch (e) { console.log(`${e.name}|${e.code}|${e.message}`); } };

show(() => { finished(NaN, () => {}); });
show(() => { finished(Infinity, () => {}); });
show(() => { finished(-Infinity, () => {}); });
show(() => { finished(0, () => {}); });
show(() => { finished(1.5, () => {}); });
show(() => { finished(-7, () => {}); });
show(() => { finished(true, () => {}); });
show(() => { finished(false, () => {}); });
show(() => { finished(null, () => {}); });
show(() => { finished('short', () => {}); });
show(() => { finished('twenty-six-characters-ok!!', () => {}); });
show(() => { finished([1, 2, 3], () => {}); });
show(() => { finished({ a: 1 }, () => {}); });
console.log('done');
