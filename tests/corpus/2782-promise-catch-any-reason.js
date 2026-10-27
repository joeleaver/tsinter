// @dynamic
// Board #260: a `.catch((e) => ...)` handler whose rejection reason is
// typed `any` (the lib's onrejected parameter — a catch clause's binding is
// `unknown` instead) reads the reason as an island value: `e.message`,
// `e.name` and `typeof e` answer as in Node, for an Error and a thrown
// string alike, behind a Promise.all over island promises.
'use strict';
/** @returns {any} */
function mintLoader() {
  return {
    /** @returns {Promise<any>} */
    one: async (x) => {
      if (x === "b") throw new TypeError(`bad ${x}`);
      if (x === "s") throw "a string";
      return { got: `${x}` };
    },
  };
}
const loader = mintLoader();
function loadAll(xs = []) {
  return Promise.all(xs.map((x) => loader.one(x)));
}
loadAll(["a", "b"])
  .then((got) => console.log(`all ${got.length}`))
  .catch((e) => console.log(`caught: ${e.name} ${e.message} ${typeof e}`));
loadAll(["s"])
  .then((got) => console.log(`all ${got.length}`))
  .catch((e) => console.log(`caught s: ${typeof e} ${e}`));
loadAll(["a"])
  .then((got) => console.log(`fine ${got.length} ${got[0].got}`))
  .catch((e) => console.log(`never ${e}`));
