// @dynamic
// The any-chaining family over a package surface: options literals with
// dashed header keys and union-typed fields (typed-array / URL /
// undefined arms), optional chaining on package results, package members
// DECLARED primitive exiting eagerly to static types (string intrinsics
// work on them directly), and a `Record<string, string> | undefined`
// result read through an `any` parameter (a typed record parameter would
// be a COPY of the package's object — SEMANTICS.md S115 refuses it).
import { generate, type MediaFile } from "mediakit";

function idFromHeaders(headers: any): string {
  if (headers === undefined) return "none";
  return `${headers["x-id"]}`;
}

// Dashed header keys build as engine property names; the payload union
// takes the bytes arm (a copy of the same element kind).
const first = generate({
  model: "mk-1",
  headers: { "content-type": "application/json", "x-title": "fixture" },
  payload: new Uint8Array([7, 200]),
  tag: undefined,
});

// text/count are DECLARED string/number — they exit eagerly, so static
// string intrinsics run on them directly.
console.log(first.text);
console.log(first.count + 1, first.text.startsWith("model=mk-1") ? "yes" : "no");

// Optional chaining on the package result: files is an engine array.
const image = first.files?.find((f) => f.mediaType.startsWith("image/"));
if (!image) {
  console.log("no image");
} else {
  console.log(`${image.mediaType}`, `${image.size}`);
}

// The headers result stays the package's object (an `any` parameter) —
// undefined or the record, read as it is.
console.log(idFromHeaders(first.headers));

// Union arms the other way: string payload, URL source, both branches of
// the undefined-armed result.
function mediaSource(flag: boolean): URL | Uint8Array {
  return flag ? new URL("https://cdn.dev/clip.mp3?v=2#t") : new Uint8Array([1, 2, 3, 4]);
}
const second = generate({
  model: "mk-2",
  prompt: "nofiles",
  payload: "inline-text",
  source: mediaSource(true),
  tag: "named",
});
console.log(second.text);
console.log(idFromHeaders(second.headers));
console.log(`${typeof second.files?.find((f) => f.size > 100)}`);

const third = generate({ model: "mk-3", source: mediaSource(false) });
console.log(third.text);

// A chained read whose declared type is a package interface: the handle
// rides further engine ops, and its primitive members exit on read.
const loud: MediaFile | undefined = first.files?.find((f) => f.size > 5);
console.log(loud === undefined ? "none" : loud.mediaType.toUpperCase());
