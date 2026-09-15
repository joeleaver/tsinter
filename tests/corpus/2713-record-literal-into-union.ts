// A literal whose own shape re-tags into NO arm of the contextual union,
// where the union has exactly ONE record arm: `{}` (the fieldless own type)
// and keyed literals against a pure index-signature arm both build as that
// arm — the memoized-env pattern (`_opensslEnv = {}` / `{ OPENSSL_CONF: p }`
// against `Record<string, string> | undefined`).
let _env: Record<string, string> | undefined;
function opensslEnv(which: number): Record<string, string> | undefined {
  if (_env !== undefined) return _env;
  if (which === 1) {
    _env = {};
    return _env;
  }
  if (which === 2) {
    _env = { OPENSSL_CONF: "/etc/ssl/openssl.cnf" };
    return _env;
  }
  _env = {};
  return _env;
}
const a = opensslEnv(2);
console.log(a ? Object.keys(a).join(",") : "(none)", a ? Object.keys(a).length : -1);
_env = undefined;
const b = opensslEnv(1);
console.log(b ? Object.keys(b).length : -1);
_env = undefined;
const c = opensslEnv(3);
console.log(c ? Object.keys(c).length : -1);

let opt: { a?: number; b?: string } | undefined;
opt = {};
console.log(opt.a ?? -1, opt.b ?? "(unset)");
