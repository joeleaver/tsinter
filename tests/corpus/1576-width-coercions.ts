// Width coercions at typed slots. (1) An object literal in a UNION-typed
// slot with one record arm builds AS that arm, so an index-signature env
// bag (`{...base, PORT: ...}` — its checker type would be a declared
// merge) flows into an `env?: {[k: string]: string | undefined}` option
// exactly like Node. (2) A zero-param function returning a WIDER record
// array adapts into the narrower slot: each call maps results through the
// record width copy (fresh records carrying the shared fields).
type EnvBag = { [key: string]: string | undefined };

function runWith(options?: { env?: EnvBag; label?: string }): void {
  const env = options?.env;
  console.log(options?.label ?? "nolabel", env?.PORT ?? "?", env?.HOST ?? "nohost", env?.EXTRA ?? "noextra");
}

const base: EnvBag = { EXTRA: "kept", OLD: "still-here" };
const hostBind: string | undefined = undefined;
const withHost: string | undefined = "0.0.0.0";
runWith({
  env: {
    ...base,
    PORT: (3000).toString(),
    ...(hostBind ? { HOST: hostBind } : {}),
  },
  label: "spawn",
});
runWith({
  env: {
    ...base,
    PORT: "4000",
    ...(withHost ? { HOST: withHost } : {}),
  },
});
runWith({ label: "bare" });

// The function-return width adapter (the getRoutes shape).
type WideRoute = {
  hostname: string;
  port: number;
  pid: number;
  ngrokUrl: string | undefined;
  tailscaleUrl: string | undefined;
};
type NarrowRoute = { hostname: string; port: number; tailscaleUrl: string | undefined };

const cachedRoutes: WideRoute[] = [
  { hostname: "a.localhost", port: 3000, pid: 11, ngrokUrl: undefined, tailscaleUrl: "https://a.ts.net" },
  { hostname: "b.localhost", port: 4000, pid: 22, ngrokUrl: "https://b.ngrok.app", tailscaleUrl: undefined },
];

function createProxy(opts: { getRoutes: () => NarrowRoute[]; tld: string }): () => void {
  return () => {
    for (const r of opts.getRoutes()) {
      console.log(`${r.hostname}${opts.tld}:${r.port} ts=${r.tailscaleUrl ?? "none"}`);
    }
  };
}

const proxy = createProxy({ getRoutes: () => cachedRoutes, tld: ".dev" });
proxy();

// (A later write to the backing array, `cachedRoutes.push(...)`, is
// refused by name since GH #109: the adapter hands out a COPY of the
// array, and a caller holding one would not see the write —
// SEMANTICS.md S125, pinned in wasm-width-identity.test.ts.)
proxy();
