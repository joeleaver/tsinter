// Catch-binding narrowing, the portless idioms: the isErrnoException
// type-guard (single-return predicate inlined over the caught value),
// `"code" in err` on instanceof-narrowed bindings, the typeof-code
// presence test through the as-cast spelling, `(err as Error).message`
// checked casts on Error payloads, and guard results driving err.code
// comparisons.
import { readFileSync } from "node:fs";

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return (
    err instanceof Error &&
    "code" in err &&
    typeof (err as Record<string, unknown>).code === "string"
  );
}

function isCodedError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

try {
  readFileSync("/definitely-nope-xyz", "utf8");
} catch (err) {
  if (isErrnoException(err) && err.code === "ENOENT") {
    console.log("enoent");
  } else {
    console.log("other");
  }
  console.log(isCodedError(err), (err as Error).message.includes("no such file"));
}

try {
  throw new Error("plain construction");
} catch (err) {
  console.log(isErrnoException(err), isCodedError(err));
  if (err instanceof Error && "code" in err) {
    console.log("unexpected code");
  } else {
    console.log("no code slot");
  }
  console.log((err as Error).message);
}

try {
  throw "a bare string";
} catch (err) {
  console.log(isErrnoException(err), isCodedError(err));
}

try {
  throw 7;
} catch (err) {
  console.log(isErrnoException(err) ? "coded" : "just a number");
}

// The guard's false branch keeps the un-narrowed binding usable via the
// String(e) rendering.
try {
  throw new RangeError("out of range");
} catch (err) {
  console.log(isErrnoException(err) ? "errno" : String(err));
}
