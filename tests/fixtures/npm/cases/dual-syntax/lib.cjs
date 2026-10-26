"use strict";
const ds = require("dualsync");
// require(esm): fakewrapesm's "require" target is an ES module (no "type",
// ESM syntax), so require() answers its namespace and the named export.
const fw = require("fakewrapesm");
exports.reqSide = ds.side;
exports.reqWeight = ds.weight(10);
exports.reqA = fw.a;
