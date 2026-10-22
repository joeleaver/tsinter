// Generates packages/compiler/src/backend/wasm/tls-roots.ts: Node
// v24.18.1's bundled root store (tls.rootCertificates — src/node_root_certs.h)
// as DER, packed for the module's data segment. Run it UNDER Node v24.18.1:
// the store is read from the running Node, and the script refuses any other
// version.
// usage: node packages/compiler/test/gen-tls-roots.mjs packages/compiler/src/backend/wasm/tls-roots.ts
import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import tls from "node:tls";

const [outPath] = process.argv.slice(2);
if (process.version !== "v24.18.1") throw new Error(`run under Node v24.18.1, not ${process.version}`);
const roots = tls.rootCertificates;
const WIDTH = 72;
const parts = [];
for (const pem of roots) {
  // Every bundled root is "-----BEGIN CERTIFICATE-----\n", the base64 in
  // 72-column lines, "\n-----END CERTIFICATE-----" (no trailing newline):
  // the module regenerates exactly that text from the DER, so check it.
  const m = /^-----BEGIN CERTIFICATE-----\n([\s\S]*)\n-----END CERTIFICATE-----$/.exec(pem);
  if (!m) throw new Error("a bundled root outside the expected PEM shape");
  const der = Buffer.from(m[1].replace(/\n/g, ""), "base64");
  const again = `-----BEGIN CERTIFICATE-----\n${der.toString("base64").match(new RegExp(`.{1,${WIDTH}}`, "g")).join("\n")}\n-----END CERTIFICATE-----`;
  if (again !== pem) throw new Error("a bundled root does not round-trip through its DER");
  if (der.length > 0xffff) throw new Error("a root over 64 KiB");
  const len = Buffer.alloc(2);
  len.writeUInt16LE(der.length);
  parts.push(len, der);
}
const blob = Buffer.concat(parts);
const sha = createHash("sha256").update(roots.join("\n")).digest("hex");
const b64 = blob.toString("base64");
const lines = b64.match(/.{1,100}/g).map((l) => `  "${l}"`).join(",\n");
const out = `/* GENERATED from Node v24.18.1's bundled root store (tls.rootCertificates,
 * src/node_root_certs.h) by packages/compiler/test/gen-tls-roots.mjs, run
 * under Node v24.18.1. Do not edit by hand.
 *
 * ${roots.length} certificates as DER, each a u16 little-endian length then its
 * bytes, base64-wrapped. tls.ts interns the blob into the data segment of a
 * module that introspects the store (getCACertificates / rootCertificates)
 * and regenerates Node's exact strings from it: "-----BEGIN CERTIFICATE-----\\n",
 * the base64 in ${WIDTH}-column lines, "\\n-----END CERTIFICATE-----".
 * sha256 of the strings joined by "\\n": ${sha}
 */

export const TLS_ROOTS_COUNT = ${roots.length};
export const TLS_ROOTS_LINE = ${WIDTH};
export const TLS_ROOTS_SHA256 = "${sha}";

/** ${blob.length} bytes. */
export const TLS_ROOTS_DER = [
${lines},
].join("");

/** Decode the blob. */
export function tlsRootsBytes(): Uint8Array {
  return Uint8Array.from(Buffer.from(TLS_ROOTS_DER, "base64"));
}
`;
writeFileSync(outPath, out);
console.log(`${roots.length} roots, ${blob.length} bytes`);
