# Cloud environment probe (Claude Code on the web)

First trial of running tsinter's heavy testing in a cloud session instead of the
shared laptop. Probed on 2026-11-03 at main `d844ab9`. The test runs below are on that base plus the lint fix. `main` moved to
`a3e7b78` during the probe, so the branch `cloud/lint-probe` is rebased onto it, and lint, build, `tsc --noEmit`
and the non-harness suite were re-run on the rebased tree (section 3).
Everything below was run in the session; times are wall-clock.

## Verdict

| workload | move to cloud? | needs |
|---|---|---|
| wasm census (`wasm-differential.test.ts`) | **yes** | `scripts/cloud-setup.sh` (Node 24.18.1 + pnpm). 1132/1135 claimed, same as the laptop. 10m46s with 4 workers. 4 row failures come from the container (no IPv6). Two child-process ordering rows (U3-ORD-01, U3-BIG-01) also fail **on main**, while Node orders them correctly here, so they are a real divergence that this slower box exposes. See below |
| non-harness suite (`vitest run packages`) | **yes** | clang 21 on PATH (some package tests call `clang`). 3 failures, all `fs-errno-rows` because the container runs as root. They pass as `nobody`. ~12 min |
| wasm-native tests | **yes** | clang 21.1.8 from the LLVM GitHub release (apt.llvm.org is blocked), `/usr/bin/time`, and run in a bare environment (`cleanenv`). Differential: 1132/1135 claimed, **1136/1136 passed** (12m19s). Host rows: 245/252. 5 failures come from the environment and pass once it is fixed, and 2 TLS-hint rows still fail in a bare environment (see below) |
| full run (`SCRIPTC_NO_CACHE=1 npx vitest run`) | **yes** | everything above. **33.5 min** on 4 cores (laptop ≈30). 7930 passed, 14 failed. Every failure is one of the rows classified in this doc |
| survey re-runs | **yes, with two changes** | `SURVEY_MEMMAX=0` (no systemd) and `@types/node` pre-seeded into `$SURVEY_CACHE/node-types` (`SURVEY=1 scripts/cloud-setup.sh`) |
| **pushing results** | **blocked in this session** | `git push` and the GitHub connector both got HTTP 403 for joeleaver/tsinter (see "Git push"). Fix: install the Claude GitHub App on the repo with Contents write, then reconnect GitHub in claude.ai |

The constraints that shape all of this:

- **4 cores, 15 GB RAM.** That is about a sixth of the laptop's 24 cores, so anything CPU-bound takes several
  times longer. Several sessions in parallel (one per lane) would claw that back.
- **The VM can be recycled between turns.** In this session it rebooted while idle (uptime reset to 2 min
  about 30 min after the last command). `/opt`, `/home/user` and the scratchpad survived, but running
  processes did not. Long runs should be detached (`nohup setsid ...`) and should write logs and a status file
  to disk, so a later turn can pick up the results. A run that is in flight when the VM is recycled is lost.
- **No IPv6.** The kernel has no IPv6 at all (`/proc/net/if_inet6` is missing, binding `::1` fails with
  `EAFNOSUPPORT`, and `localhost` resolves only to 127.0.0.1). Node-oracle rows that bind `::`/`::1` or that
  expect `localhost` to resolve to two addresses fail on both sides of the comparison in an environment-specific way.
- **Runs as root.** Tests that assert a non-root uid class fail.
- **The session environment leaks into tests.** It exports `NODE_OPTIONS=--use-openssl-ca`, `NODE_EXTRA_CA_CERTS`,
  `SSL_CERT_FILE`, `HTTPS_PROXY` and a `NO_PROXY` that lists localhost. The Node oracle and the compiled programs
  both inherit them. Run tests under `cleanenv` (from `env.sh`); they need no network.
- **`/usr/bin/time` is not installed** (one host row measures RSS with it). The setup script installs it.

## 1. Hardware

| | |
|---|---|
| CPU | 4 × Intel Xeon @ 2.80 GHz (1 thread per core) |
| RAM | 15.7 GiB, no swap |
| Disk | 30 GB available for the session (`/` reports 252 GB, but the per-session allowance is what counts) |
| OS | Ubuntu 24.04.5 LTS, kernel 6.18 (Firecracker VM) |
| Long processes | Detached `nohup setsid` jobs ran unattended: census, wasm-native and host rows back to back (31 min), then the full run (33.5 min), 65 min in all with no intervention. Between turns, while idle, the VM rebooted once (see above) |

## 2. Toolchain

| tool | what I tried | result |
|---|---|---|
| Node v24.18.1 | the nodejs.org tarball, SHA256 checked against `SHASUMS256.txt` | **works.** `node-v24.18.1-linux-x64.tar.xz: OK`. Download 1.6 s |
| | preinstalled nvm (`/opt/nvm`, 0.39.7): `nvm install 24.18.1` | **works** (nvm checks the checksum too). 7 s |
| | what the image ships | `node` on PATH is v22 (`/opt/node22`), and `/opt/node24` is **v24.22.1**: both wrong. PATH must put 24.18.1 first |
| pnpm | `COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm@10` | **works**: pnpm 10.34.9 |
| clang 21 | apt.llvm.org (`llvm.sh` script or its packages) | **blocked**: the egress proxy answers 403 to `apt.llvm.org:443` |
| | Ubuntu noble apt | no `clang-21` package. The newest is clang-20 (20.1.2). The image has clang 18.1.3 |
| | the official LLVM release tarball from GitHub: `LLVM-21.1.8-Linux-X64.tar.xz` (1.9 GB) | **works.** Download 83 s. Its SHA256 `b3b7f280…732b` matches the subject digest in the release's sigstore attestation (`.jsonl`). The signature itself was not verified (no cosign). Extracting only clang, lld and the resource dir takes 3 min and 2.5 GB. **`clang version 21.1.8`** |
| network: npm | `registry.npmjs.org` | works (proxy bypass list) |
| network: nodejs.org | dist tarballs | works |
| network: GitHub | `git clone`/`fetch` of public repos, release downloads | works |
| apt (archive.ubuntu.com) | `apt-get install time` | works |
| | `gh api search/...` | works |
| | `gh api repos/<owner>/<repo>` for repos outside the session | **denied** (403 "GitHub access to this repository is not enabled for this session") |
| | `git push` to joeleaver/tsinter | **denied**, see below |

Proxy note: all HTTPS goes through a local agent proxy with its own CA (`/root/.ccr/ca-bundle.crt`). Node, curl
and git already trust it. Nothing needed configuring.

## 3. Build and tests

Setup: `corepack pnpm@10 install` took **6.4 s**. `corepack pnpm@10 build` took **75 s** cold and 7 s
incremental.

`tsc --noEmit` (run as in each package's build script): compiler **OK** (5.0 s), cli **OK** (1.0 s).
Both pass before and after the lint fix.

### Lint (GH #115)

`corepack pnpm@10 lint` (30 s): **56 errors** before, **0** after. See the commit message for what changed and why.

### Non-harness suite

`SCRIPTC_TEST_WORKERS=4 corepack pnpm@10 exec vitest run packages`, after the lint fix, with clang 21.1.8 on PATH:

```
 Test Files  1 failed | 142 passed (143)
      Tests  3 failed | 4484 passed | 24 skipped (4511)
   Duration  710.29s
```

All 3 failures are in `packages/compiler/test/fs-errno-rows.test.ts`, and the cause is the **environment**: the
container runs as root, and the test asserts the uid class the committed rows were generated under
(`committed file was generated under uid class "non-root"; this run is "root"`). Run as `nobody`
(`runuser -u nobody -- … vitest run packages/compiler/test/fs-errno-rows.test.ts`), the file passes 16/16.

**On the rebased branch** (`a3e7b78` + lint fix; the conflict in `lower-calls.ts` was only the import line, which
keeps main's new `afterArgs, evaluateArgsFirst` and drops `slotUndefOf, undefElse`): main has the same 56 lint
errors, and after the fix lint reports **0**, the build passes (67 s), and `tsc --noEmit` passes for the compiler
and the cli. The non-harness suite under `env -i`:

```
 Test Files  1 failed | 143 passed (144)
      Tests  3 failed | 4593 passed | 24 skipped (4620)
   Duration  730.86s
```

The 3 failures are the same root-only `fs-errno-rows` tests.

### wasm census

`SCRIPTC_WASM_REFUSALS=1 SCRIPTC_TEST_WORKERS=4 corepack pnpm@10 exec vitest run tests/harness/wasm-differential.test.ts`

Run 1 (pre-fix tree, while I was also linting and fetching, so the box was loaded):

```
wasm tier: 1132/1135 corpus programs claimed; first refusals: module:embedded×3
wasm work queue (2 distinct constructs, by programs needing them): libCall:island.import×3, module:embedded×3
 Test Files  1 failed (1)
      Tests  5 failed | 1567 passed (1572)
   Duration  682.10s
real 11m23s
```

Run 2 (final tree after the lint fix, box otherwise idle):

```
wasm tier: 1132/1135 corpus programs claimed; first refusals: module:embedded×3
wasm work queue (2 distinct constructs, by programs needing them): libCall:island.import×3, module:embedded×3
 Test Files  1 failed (1)
      Tests  6 failed | 1566 passed (1572)
   Duration  634.16s
```

The claimed number matches the laptop: **1132/1135**, and the only refusals are the 3 `module:embedded` programs.
Every corpus program passes. The failures are all hand-written rows:

| row | cause |
|---|---|
| INC-29 U1 N1-ERR-02 (EADDRINUSE on a `::` bind) | environmental: no IPv6 (`b error false` vs Node's `true`) |
| INC-29 U1 N1-ERR-03 (refused connect through `localhost`, AggregateError) | environmental: `localhost` has only one address here, so Node gives a plain Error, not an AggregateError |
| INC-29 U1 N1-REG-01 (S087 (a), same AggregateError) | environmental: same cause |
| INC-29 U4 U4-R-03 (IPv6 literal host, checkServerIdentity) | environmental: no IPv6 |
| INC-28 U3 U3-ORD-01 (child stdout `data` vs `setImmediate` order) | **real, timing-exposed.** tsinter runs the immediate before the child's chunk arrives |
| INC-28 U3 U3-BIG-01 (1 MB child output: `end` before `exit`) | **real, timing-exposed.** tsinter delivers `exit` before the stream's `end` (run 2 only) |

For the two U3 rows I extracted each row's source and ran it under Node 24.18.1 here. Node prints the expected
order 5 out of 5 times. Re-run alone, both rows fail 3/3 on an untouched `main` worktree (`d844ab9`), and on the
lint branch ORD-01 failed 0/3 and BIG-01 3/3. So the lint change did not cause this. The wasm lane's
child-process host orders pipe data/EOF against `setImmediate`/`exit` differently from libuv when the child is
slower to start (this VM), and the laptop presumably wins the race. That makes these flaky rows over a real
ordering gap, not cloud noise.

### wasm-native

With clang 21.1.8 on PATH:

`SCRIPTC_TEST_WORKERS=4 corepack pnpm@10 exec vitest run tests/harness/wasmnative-differential.test.ts`

```
wasm-native lane: 1132/1135 corpus programs claimed; refusals by reason: module:embedded×3
 Test Files  1 passed (1)
      Tests  1136 passed (1136)
   Duration  738.00s
```

That matches the laptop: **1132/1135**, only `module:embedded`, and nothing fails.

`SCRIPTC_TEST_WORKERS=4 corepack pnpm@10 exec vitest run tests/harness/wasmnative-host-rows.test.ts`

```
 Test Files  1 failed (1)
      Tests  7 failed | 245 passed (252)
   Duration  397.30s
```

I re-ran the 7 failures alone after installing `time`, and again under `env -i` (PATH and HOME only):

| row | first run | `env -i` + `time` | cause |
|---|---|---|---|
| U1-RUN-06 (#1) `spawnSync` timeout kill, SIGPIPE | fail (`trapped: 7 null` vs `null SIGPIPE`) | pass | environmental: it ran under `nohup setsid`. It passes from an ordinary shell |
| N1-ERR-03 (#128) | fail (port in the message) | fail | environmental: no IPv6, `localhost` has one address |
| notes: … IPv6 host … | fail (`EAFNOSUPPORT ::ffff:7f00:1`) | fail | environmental: no IPv6 |
| TLS back-pressure (256 MiB flood) | fail (`ENOENT …/rss.txt`) | pass | environmental: `/usr/bin/time` missing. `cloud-setup.sh` installs it |
| proxy-optin (fetch fixtures) | fail (proxy hits 0, want 2) | pass | environmental: the session's `NO_PROXY` lists 127.0.0.1/localhost |
| U4-R-10 (#183) chain-trust-inter-only | fail | **fail** | **unresolved**: Node appends `; if the root CA is installed locally, try running Node.js with --use-system-ca` to UNABLE_TO_GET_ISSUER_CERT, and tsinter does not |
| SECURITY 2-3 partial_chain(_leafonly) | fail | **fail** | **unresolved**, same hint |

The two hint rows fail even with a bare environment, and both sides run on this machine. Either the laptop's own
environment hides this (e.g. `NODE_USE_SYSTEM_CA=1` or `--use-system-ca` in its `NODE_OPTIONS`, which turn the
hint off for Node and the native host alike), or it is a gap in tsinter. Check it on the laptop before treating it
as cloud noise.

### Full run

`SCRIPTC_NO_CACHE=1 SCRIPTC_TEST_WORKERS=4 npx vitest run` from the repo root (4 is all the cores here, so this is
the default run), detached, with clang 21.1.8 and `time` installed but without `cleanenv`:

```
 Test Files  3 failed | 167 passed (170)
      Tests  14 failed | 7930 passed | 29 skipped (7973)
   Duration  2008.74s
```

| file | failures | which |
|---|---|---|
| wasm-differential | 6 | N1-ERR-02, N1-ERR-03, N1-REG-01, U4-R-03 (no IPv6); U3-BIG-01 (the ordering gap above; U3-ORD-01 passed this time); **U1-RES-01** |
| wasmnative-host-rows | 5 | N1-ERR-03 and the IPv6 notes row (no IPv6); proxy-optin (`NO_PROXY`); U4-R-10 and SECURITY 2-3 (the unresolved CA hint) |
| fs-errno-rows | 3 | root |

U1-RES-01 is new in this run. Its `trapped` case (a `spawnSync` timeout on a shell that traps the signal and keeps
writing) gave `status=4 signal=null` where Node gives `status=null signal=SIGPIPE`. It is the same case that
failed host row U1-RUN-06 once. Both rows passed in the other runs, so this case is a timing flake here: whether
the shell dies of SIGPIPE or exits first depends on the race.

Every failure is classified. None points to the lint change: the ones that are not environmental (U3-ORD-01,
U3-BIG-01) fail the same way on untouched `main`.

## 4. Survey

`tests/real-apps-round3/survey` was checked by downloading only. Nothing fetched was installed, built or executed.

- **npm tarballs** work. The survey's own `lib.mjs` (`packument` + `storeTarball`, which checks each tarball
  against the registry's `integrity`) fetched the pinned versions of react, lodash, chalk, debug, semver and
  @babel/core. Each took 0.1–0.4 s, and every SHA256 matched the one recorded in `data/npm-packages.jsonl`.
  `npm pack ms@2.1.3 --ignore-scripts` also works and reports the sha512 integrity.
- **Shallow clones** work, with the survey's hardened flags (`core.hooksPath=/dev/null`, `core.symlinks=false`,
  `--depth 1 --single-branch --no-tags --recurse-submodules=no --template=`). isaacs/rimraf, kentcdodds/cross-env,
  uuidjs/uuid and postcss/postcss each took 13–15 s through the proxy. For a pinned commit,
  `git fetch --depth 1 origin <sha>` works too (5 s for postcss at the recorded `2faedf9`).
- **The analyzer runs.** `node run.mjs npm --only react --workers 1` analysed react (12 entries, 9 s), writing to
  scratch dirs via `SURVEY_CACHE` / `SURVEY_RAW`. Two things had to change:
  1. `run.mjs` caps each worker with `systemd-run --user --scope`, and that fails here ("Failed to connect to
     bus"; PID 1 is not systemd). `SURVEY_MEMMAX=0` runs workers uncapped. With 15 GB and the default
     `--max-old-space-size=6144`, keep `--workers` at 2 or less.
  2. `plan.mjs` expects `@types/node` and `undici-types` at `$SURVEY_CACHE/node-types/node_modules`, and
     nothing in the survey creates them. The README does not mention it. Without them, every plan fails
     with `cp: cannot stat …/node-types/node_modules/@types/node`. `SURVEY=1 scripts/cloud-setup.sh` seeds
     them (tarballs only, through `lib.installClosure`).
- **`gh` use.** `lists.mjs repos` uses `gh api search/repositories`, which works. `fetch-repos.mjs` calls
  `gh api repos/<x>` only when `data/repo-libs.json` is missing. That file is committed, so the call is not needed
  (and it would be denied here).
- Throughput estimate: ~300 npm packages at <1 s each to fetch, and ~100 clones at ~15 s each (≈25 min serially,
  less with the fetcher's pool of 4). Analysis is the long part, and at 4 cores it will be several times the
  laptop's.

## 5. Git push

`git push -u origin cloud/lint-probe` → `HTTP 403`, "Claude doesn't have GitHub access to joeleaver/tsinter for
your organization. An org admin can install the Claude GitHub App …". Pushing to the session's own assigned branch
was refused the same way, so the block is not about the branch name. Reads worked: `git ls-remote`, and reading
issue #115 through the GitHub connector. Before cloud sessions can hand results back, the owner needs to install
the Claude GitHub App on joeleaver/tsinter or reconnect GitHub in claude.ai settings. The GitHub connector was refused as well: `create_branch` for `cloud/lint-probe` returned
`403 Resource not accessible by integration`. **Nothing can be written to GitHub from this session**, by git or
by API. The branch is committed in the session's checkout, ready to push once access is fixed. The files were also
handed to the user as attachments, along with a `git am` patch series against `a3e7b78`.

## 6. Setup script

`scripts/cloud-setup.sh` reproduces the working toolchain from a fresh clone: Node 24.18.1 (checksum-verified),
`pnpm install --frozen-lockfile` + build, clang 21.1.8 (pinned SHA256, cross-checked against the attestation), and
optionally (`SURVEY=1`) the survey's node types. It writes `$TSINTER_TOOLS/env.sh` (default `/opt/tsinter-tools`),
and every shell then needs `source /opt/tsinter-tools/env.sh`. Tested end to end: a fresh `git clone` of this branch, run under `env -i` with the empty
tools directory (the LLVM tarball was reused through `TSINTER_DL`; its download was timed separately at 83 s),
finished with exit 0 in **4m39s** at `nice 19` while the wasm-native run had the CPU. The first attempt found a
bug, now fixed: the root `build` script calls bare `pnpm -r`, a clean PATH has no `pnpm`, and in the interactive
shell the build had silently used the image's `/opt/node22/bin/pnpm`. The script now puts a `pnpm` shim
(`corepack pnpm@10`) on PATH. It also installs `time` and defines `cleanenv`, which runs a command with
`NODE_OPTIONS`, the proxy variables and `NO_PROXY` stripped.

Suggested cloud recipe for a gate run:

```bash
bash scripts/cloud-setup.sh && source /opt/tsinter-tools/env.sh
export SCRIPTC_WASM_REFUSALS=1 SCRIPTC_TEST_WORKERS=4
cleanenv corepack pnpm@10 exec vitest run tests/harness/wasm-differential.test.ts > census.log 2>&1
```

For runs longer than a turn, detach the job and write a status file, as in this probe's chain
(`nohup setsid chain.sh &`, with each step appending `START`/`END rc= secs=` lines to a status file). A later turn
reads the logs. A VM recycle kills the job, so check `uptime` first.

Rows that will always fail in this container (no IPv6, root): N1-ERR-02, N1-ERR-03, N1-REG-01, U4-R-03
(census), N1-ERR-03 and the IPv6 notes row (host rows), and the three `fs-errno-rows` tests. A cloud gate needs either an allow-list for these or a container with IPv6 and a
non-root user.
