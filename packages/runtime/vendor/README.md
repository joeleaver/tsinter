# Vendored third-party code

## ryu/

- Project: https://github.com/ulfjack/ryu
- Commit: 4c0618b0e44f7ef027ebae05d2cc7812048f7c8f
- License: Apache-2.0 OR BSL-1.0, used under the Boost Software License 1.0 (see ryu/LICENSE-Boost)

The double-to-shortest-decimal core of Ryū (d2s and its headers only — the float and fixed/exponent variants are not vendored). scr_number.c textually `#include`s d2s.c and calls its internal `d2d` digit generator; ECMA-262 digit *placement* stays in scr_number.c. The only modification to upstream files: `#include "ryu/x.h"` flattened to `#include "x.h"` in d2s.c and d2s_intrinsics.h so the directory is self-contained. To update, re-fetch the listed files at the new commit and re-apply that include flattening.

## quickjs-ng/

- Project: https://github.com/quickjs-ng/quickjs
- Version: v0.15.1
- Commit: 3c8f3d68953955950074c41c6e4d999562ae82a7
- License: MIT (see quickjs-ng/LICENSE)

The QuickJS-ng JavaScript engine, embedded by the opt-in `--dynamic` build mode (see packages/runtime/src/scr_island.c). Static builds never compile or link any of this.

The tree is a plain snapshot of the upstream commit with directories the library build does not need removed (tests/, docs/, examples/, test262 fixtures, CI config, generator scripts). No vendored file is modified; to update, re-clone upstream at the new commit, delete its .git directory, apply the same trim, and update this file.

The engine archive (libqjs.a) is built lazily on the first `--dynamic` compile into `.cache/<commit>-<flavor>/` next to this file — one flavor per lane (plain, asan). The cache directory is gitignored and safe to delete.

## zlib-chromium/

- Project: Chromium's fork of zlib, exactly as Node bundles it — Node v24.18.1's `deps/zlib` (https://github.com/nodejs/node/tree/v24.18.1/deps/zlib), which `process.versions.zlib` reports as `1.3.1-e00f703` (Chromium revision e00f703; upstream madler zlib 1.3.1, see README.chromium)
- License: zlib (see zlib-chromium/LICENSE, Node's `deps/zlib/LICENSE`); the Chromium-authored files (chromeconf.h, cpu_features.*, the `*simd*` headers, contrib/optimizations/insert_string.h) are under Chromium's BSD-3-Clause licence, copied from Chromium's `src/LICENSE` to zlib-chromium/LICENSE.chromium

node:zlib on the llvm and c lanes (see packages/runtime/src/scr_zlib.c, and scr_fetch.c's gzip/deflate response decoding). Every native zlib build compiles this copy — host and cross targets alike; no build links a system libz — because Chromium's deflate differs from canonical zlib's (a multiplicative `insert_string` hash, a four-byte `fill_window` insert, LIT_MEM symbol buffers), so a system libz's compressed bytes differ from Node's for about half of all inputs. With this copy and Node's driver (scr_zlib.c), the bytes are Node's, the same ones the wasm lane's port computes (SEMANTICS.md S101; packages/compiler/test/zlib-lanes.test.ts holds the lanes to Node over one table).

Vendored: the files Node's zlib.gyp compiles for a target without SIMD (adler32.c, cpu_features.c, crc32.c, deflate.c, inffast.c, inflate.c, inftrees.c, trees.c, zutil.c) and every header they include (gzguts.h only because zutil.c includes it), plus LICENSE and README.chromium. Not vendored: the gzFile units, infback.c, compress.c/uncompress.c (nothing calls them), the SIMD sources, contrib's other directories, BUILD.gn/zlib.gyp, tests. No vendored file is modified. The build is scalar exactly as zlib.gyp builds Node on such targets (`-DCPU_NO_SIMD`, plus `-DHAVE_HIDDEN` off Windows). Node's x64 and arm builds differ from it in two value-identical ways: they take the SIMD paths (checksums, slide_hash), and they compile contrib/optimizations/inflate.c and inffast_chunk.c in place of the root inflate.c/inffast.c (window padding and wide chunk copies only — the same codes, checks and messages; the unit's review fuzzed both builds' inflate against Node with no difference). So the bytes and errors are the same on every CPU. One build choice is our own, the symbol prefix: Node's copy of zconf.h comments out its `#include "chromeconf.h"` (Node exports plain zlib names to addons), and Chromium's own `Cr_z_` names would collide, or resolve to another zlib revision, in a host that also links Chromium's zlib (CEF and the like — an engine-plugin embedder of a library archive). So cc.ts force-includes packages/runtime/src/scr_zlib_prefix.h (`-include`; scr_zlib.c/scr_fetch.c include it before zlib.h), chromeconf.h's rename list respelled `scr_z_` plus the three cpu_features globals chromeconf.h leaves unprefixed. Every zlib symbol in an executable or a library archive is `scr_z_*` (packages/compiler/test/zlib-prefix.test.ts checks the header against chromeconf.h and runs nm over both) — symbol names only, no code changes. To update, re-fetch the same file set from the new Node tag's `deps/zlib`, bump `ZLIB_VERSION` in packages/compiler/src/backend/cc.ts to the new `process.versions.zlib`, and regenerate scr_zlib_prefix.h from the new chromeconf.h, and re-run zlib-lanes.test.ts, zlib-prefix.test.ts and wasm-zlib.test.ts (the wasm port, backend/wasm/zlib.ts, must follow the same revision).

The objects build lazily on the first zlib-using compile into `.cache/zlib-<version>-<recipe>-<flavor>/` (recipe: a hash of the defines and the prefix header) next to this file — one flavor per driver/target and lane (plain, asan; the lre-objects pattern). Zlib-free binaries never compile any of this.

## curl/

- Project: https://curl.se/ (Debian bookworm's libcurl4-openssl-dev 7.88.1, the exact library the Linux lane's pinned container image ships)
- Version: 7.88.1 (headers copied byte-for-byte from `node:24.15.0-bookworm`'s `/usr/include/aarch64-linux-gnu/curl/`; the arch-specific include dir is Debian multiarch layout — the headers themselves are architecture-independent, `system.h` selects per-arch typedefs at preprocessing time)
- License: curl (see curl/COPYRIGHT — the Debian machine-readable copyright file for the package the headers came from)

HEADERS ONLY — no curl C source is vendored and none is ever compiled. These headers now serve ONLY the RETIRED curl reference implementation of fetch (packages/runtime/src/scr_fetch_curl.c, selected by `SCRIPTC_FETCH_CURL=1`; kept compilable for one release as the native flip's reference — see scr_fetch.c, the default, which rides scr_net/scr_tls/scr_http/zlib and touches nothing here). Under the flag: host builds link the system `-lcurl` (macOS ships libcurl), and linux-gnu CROSS builds compile scr_fetch_curl.c against these headers, then link against a generated STUB `libcurl.so` (soname `libcurl.so.4`, empty definitions of exactly the symbols scr_fetch_curl.c calls — see CURL_STUB_SYMBOLS in packages/compiler/src/backend/cc.ts) so the produced binary records a plain `DT_NEEDED libcurl.so.4` that the TARGET system's real libcurl satisfies at load time, the standard cross-link import-stub technique. The 7.88.1 pin is a floor, not a lock: scr_fetch_curl.c's newest requirement is CURLOPT_PROTOCOLS_STR (7.85.0) and the unversioned symbol references bind to any libcurl.so.4. This whole directory leaves with scr_fetch_curl.c when the reference retires for good.

The stub builds lazily on the first flag-selected fetch cross compile into `.cache/curl-stub-<flavor>/` next to this file (the zlib-objects pattern). Default builds never see any of this, and no build ever compiles curl itself.

## mbedtls/

- Project: https://github.com/Mbed-TLS/mbedtls
- Version: mbedtls-3.6.7 (the 3.6 LTS line — 4.x moved the crypto core into the separate TF-PSA-Crypto repository; the self-contained LTS is what a vendored tree wants)
- License: Apache-2.0 (see mbedtls/LICENSE)

The TLS provider behind node:tls/node:https (see the design note atop packages/runtime/src/scr_tls.c for why mbedTLS over SecureTransport/BoringSSL/libtls). Only `include/` and `library/` are vendored (LICENSE beside them) — tests, docs, programs, scripts, and CMake machinery are not. No vendored file is modified and no custom config is applied (the stock `mbedtls_config.h` builds every `library/*.c` standalone with clang); to update, re-fetch the release tarball, copy the same two directories, and bump `MBEDTLS_VERSION` in packages/compiler/src/backend/cc.ts.

The archive (libmbedtls.a) is built lazily on the first TLS-using compile into `.cache/mbedtls-<version>-<flavor>/` next to this file — one flavor per lane (plain, asan), the libqjs.a pattern. TLS-free binaries never compile or link any of this.
