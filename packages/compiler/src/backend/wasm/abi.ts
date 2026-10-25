/* The .wasm artifact's embedding contract — the ONE list a host has to
 * satisfy, shared by the emitter (which mints the names into the binary)
 * and every host that instantiates one (the differential harness today,
 * `tsinter run` and embedders tomorrow). A name change here is an ABI
 * break for every host, so nothing else may spell these strings.
 *
 * The surface is deliberately minimal and WASI-shaped without being WASI:
 * console output and a clock are the only capabilities the tier needs yet,
 * and the clock half appears ONLY in modules that can arm a timer.
 *
 * INC-26 pass P1 (design-host-v7.txt cccf7d6e §2.1-§2.5, DECISIONS.md D2/D3):
 * the process host contract adds `hostStr`/`hostNum`/`exit`, each
 * conditionally minted, each carrying this file's own three-tier
 * enforcement doctrine PLUS A FOURTH TIER this file has not needed before
 * (rev-26 R-14): two of these imports perform an EFFECT rather than
 * answering a value, and none of the three tiers below says anything about
 * whether the effect happened. For every effect in this ABI the honest
 * answer is "NOTHING ENFORCES IT; the harness's own rows are the check",
 * and each entry below says so in those words rather than asserting the
 * obligation and moving on — §2.7's capability paragraph (below, D4/D6) is
 * the model this borrows: it names the enforcement instead of asserting
 * the duty.
 *
 *   (import "tsinter" "hostStr" (func (param i32 i32 i32 i32) (result i32)))
 *     hostStr(kind, index, ptr, cap) -> len. Writes at most `cap` UTF-16
 *     CODE UNITS (2 bytes each, little-endian) starting at `ptr` in the
 *     exported memory, and answers the datum's TRUE length in code units.
 *     Three answers, and only three: len <= cap means the datum was
 *     written and its length is len; len > cap means NOTHING was written —
 *     retry with a buffer of at least len; len === -1 means NO SUCH DATUM
 *     (an argv/env index past the end), distinct from an EMPTY datum
 *     (len 0). The retry contract exists so the module can start with a
 *     modest stack buffer and pay a second call only on long values.
 *     WHY UTF-16 AND NOT UTF-8: the tier stores UTF-16 (S002, `(array
 *     i16)`) and the host's strings are JS strings, which ARE UTF-16 —
 *     code units move with no transcoder on either side. THE HOST MAY SEND
 *     ANY UTF-16 SEQUENCE INCLUDING UNPAIRED SURROGATES, and the module
 *     stores whatever it is given: the tier's storage is faithful (S002)
 *     and its OWN write boundary already replaces a lone surrogate with
 *     U+FFFD on the way OUT, so a host that sends one produces exactly
 *     what Node would print — the module never re-validates on the way in.
 *     `cap` and `len` are CODE UNITS; the exported memory is BYTES. Getting
 *     that factor of two wrong at a call site is a silent truncation on
 *     odd-length data — it is a call-site concern, not this import's.
 *     KIND TABLE (module and host must agree; the numbers ARE the ABI: no
 *     gaps, no reuse, append-only — later passes consume kinds this pass
 *     does not mint, but the table below ships whole and once):
 *       0  argv[index]                      6  versions.node
 *       1  env key   at index                7  versions.openssl
 *       2  env value at index                8  os.tmpdir
 *       3  cwd                               9  os.homedir
 *       4  platform                         10  os.type
 *       5  arch                             11  os.release
 *      12  execPath                         13  os.userInfo.username
 *      14  os.userInfo.homedir              15  os.userInfo.shell
 *      16  os.networkInterfaces AS A JSON DOCUMENT
 *      17  the host's own text for errno `index` — the one consumer of the
 *          UNKNOWN arm in the fs errno enumeration (a later pass), and the
 *          one place `index` means something other than an ordinal.
 *     `index` is ignored for every kind but 0, 1, 2 and 17. P1 minted and
 *     consumed kinds 0-4. INC-26 P3 (design §3.2) consumes kinds 5, 6, 7
 *     and 12 (arch, versions.node, versions.openssl, execPath — S071/S072
 *     name what each answers on a non-Node lane) — P3's `process.chdir`
 *     ALSO reaches this import, for its OWN error message's "before" path
 *     (kind 3, cwd) rather than for a new kind. INC-26 P4 (design §3.5)
 *     consumes kinds 8 and 9 (os.tmpdir, os.homedir — THE VALUES PRINT,
 *     design §11). 10-11 and 13-17 are later passes' — see `hostNum`'s
 *     identical stance below for the reason both tables ship complete now
 *     rather than growing a gap at a time.
 *     hostStr's EFFECT TIER: that the host WROTE the bytes it claims to
 *     have written is enforced by NOTHING. A host that answers a length
 *     and writes nothing hands the module a run of NUL code units and no
 *     error anywhere — the harness's own rows are the check.
 *
 *   (import "tsinter" "hostNum" (func (param i32 i32) (result f64)))
 *     hostNum(kind, arg) -> f64 — every NUMBER-valued host fact.
 *       0  argc                              1  env pair count
 *       2  pid                               3  uid
 *       4  gid                               5  isTTY(fd = arg): 1 or 0
 *       6  columns(fd = arg): -1 = no width  7  uptime, in SECONDS since
 *          THE INSTANCE started (never the host process — see below)
 *       8  cpuUsage.user, microseconds       9  cpuUsage.system
 *      10  threadCpuUsage.user              11  threadCpuUsage.system
 *      12  availableMemory, bytes           13  constrainedMemory, bytes
 *      14  rusage field `arg`, 0..15        15  os.totalmem, bytes
 *     Kinds 0 and 1 are read ONCE each, at the argv/env snapshot (below);
 *     everything else is read at its own call site, every time. P1 minted
 *     and consumed kinds 0-1. INC-26 P3 (design §3.2) consumes kinds 2-14
 *     (pid through rusage) — the four `*Diff` process keys (cpuUserDiff,
 *     cpuSystemDiff, threadCpuUserDiff, threadCpuSystemDiff) are IN-MODULE
 *     subtractions over kinds 8-11's own raw counters and mint no kind of
 *     their own. 15 is a later pass' (same append-only stance as
 *     `hostStr`).
 *     Inherits the WEAK f64 result-kind case (§ the `now`/`wallClock`
 *     precedent above): a numeric-string host is indistinguishable from a
 *     correct one. THE VALUE ITSELF is enforced by nothing — a host
 *     reporting a zeroed rusage or a negative uptime runs silently; the
 *     text is the only guarantee (the `wallClock` shape, restated).
 *     KIND 7 (uptime) NAMES ITS OWN CLOCK EXPLICITLY, the SAME "the text
 *     IS the enforcement" shape `wallClock` already uses above: the
 *     compiled module IS its own process on every lane that runs one, so
 *     "uptime" MUST mean seconds since THIS INSTANCE started, never
 *     seconds since whatever long-lived HOST PROCESS happens to be
 *     servicing the import (a shared test harness driving many modules
 *     in one process, for instance) — the latter answers a number that
 *     keeps growing across unrelated instantiations and is not "this
 *     process's own uptime" by any program's own reading of the word. A
 *     host that samples its own per-instance base a few milliseconds
 *     BEFORE calling `instantiate` (the only order available to it) errs
 *     SLIGHTLY LARGE, never negative — small and harmless, and not a bug
 *     for a later pass to "fix" by moving the sample point.
 *     KINDS 8-11 (cpuUsage.user/system, threadCpuUsage.user/system) AND
 *     14's OWN CUMULATIVE FIELDS carry the SAME "since THIS INSTANCE
 *     started" clause (INC-26 P4 rider R-B, board #144, ERRATA E-P4-2):
 *     `process.cpuUsage()`/`threadCpuUsage()`/`resourceUsage()`'s twelve
 *     cumulative rusage fields are ALL counters over the HOST's own
 *     lifetime, not the module's, so a host that answers them directly
 *     reports a number that keeps growing across unrelated
 *     instantiations — kind 7's own bug, found again here. A host samples
 *     a per-instance BASELINE (the same ordering as kind 7's) and answers
 *     `<fresh> - <baseline>` for these twelve. rusage's maxRSS (a MAXIMUM,
 *     never a counter) and its three memory-size fields (sharedMemorySize,
 *     unsharedDataSize, unsharedStackSize — ALWAYS ZERO on Linux, so "real"
 *     and "zero" are indistinguishable there) pass through RAW, unsubtracted.
 *
 *   (import "tsinter" "exit" (func (param i32)))   [process.exit modules only]
 *     The host TERMINATES THE INSTANCE with this status. IT MUST NOT
 *     RETURN. The module emits a defensive `unreachable` immediately after
 *     the call — this both keeps the wasm stack types honest and turns a
 *     broken host into a loud trap rather than a program that runs on past
 *     its own exit. The host implements this by THROWING A SENTINEL it
 *     recognises: a JS exception thrown from a `tsinter` import unwinds
 *     through nested wasm frames with its identity intact — its own class,
 *     its own `.code`, and NOT a WebAssembly.RuntimeError — and nothing in
 *     the module after the call runs, identically from `_start` and from
 *     inside a timer callback under `_tick`. That is Node's "nothing after
 *     process.exit runs" with no in-module unwind machinery and no cost
 *     that grows with stack depth.
 *     THE PROPERTY THIS RESTS ON IS THE TIER'S, NOT THE ENGINE'S: a host
 *     throw is not INHERENTLY uncatchable inside wasm — the same throwing
 *     import IS catchable by a `try_table`/`catch_all` in a module that has
 *     one. It escapes THIS tier's modules only because THE TIER EMITS NO
 *     EXCEPTION-HANDLING OPCODES AT ALL: try/catch/finally lower through a
 *     pending-flag unwind, never through wasm's own exception-handling
 *     proposal, so there is no handler for a host throw to be caught by.
 *     Node's `try { process.exit(0) } finally { ... }` does NOT run the
 *     finally, and this reproduces that for free ONLY because there is no
 *     wasm EH — a later increment that lowers `finally` to
 *     `try_table`/`catch_all` would silently start running the finally and
 *     swallowing the exit. The dependency is invisible unless it is written
 *     down, which is why it is written down here.
 *     exit's EFFECT TIER: that the host actually TERMINATES, and does not
 *     return, is enforced by NOTHING. The module's defensive `unreachable`
 *     after the call turns a returning host into a trap rather than into a
 *     program that runs past its own exit — that is the MODULE defending
 *     itself, not enforcement, and the harness's own rows are the check.
 *
 * INC-26 pass P3 (design-host-v7.txt §2.7/§0.5, DECISIONS.md P3-J2, brief-
 * p3-v2.md §3B/§0.5): THREE more conditional imports, each an EFFECT with
 * its OWN errno enumeration — never §6.3's fs table (P4, not yet built)
 * and never each other's. THE CAPABILITY PARAGRAPH (D4, applying equally
 * to all three): THESE IMPORTS GRANT REAL AUTHORITY over the host
 * process — `kill` lets a module signal ANY process the host user may
 * signal; `chdir`/`umask` let it change the host process's own working
 * directory and file-mode mask. A host that does not want to grant a
 * capability DOES NOT SUPPLY THE IMPORT, and the module fails to
 * instantiate with a LinkError before a single instruction runs — the
 * engine enforces this half. A host that wants to grant a NARROWER
 * capability supplies the import and answers a permission-shaped failure
 * (kill: EPERM; chdir: EACCES/EPERM) for what it refuses; the module
 * renders that as Node's own permission error.
 *
 *   (import "tsinter" "kill" (func (param i32 i32) (result i32)))
 *     kill(pid, signum) -> 0 on success, kill's OWN three-code enumeration
 *     on failure: -1 ESRCH, -2 EPERM, -3 EINVAL, or -(256 + the raw
 *     platform errno) for anything else. 256 is a BASE, not a code; the
 *     raw errno beyond it is the PLATFORM's, not this ABI's — Linux
 *     ESRCH=3/EPERM=1/EINVAL=22 would collide with -1/-2/-3 if merged into
 *     one channel, which is why the carrier keeps the number instead of
 *     losing it. The module renders the first three as `Error("kill
 *     ESRCH"/"kill EPERM"/"kill EINVAL")` with `.code` set to the bare
 *     name, and the UNKNOWN arm as `Error("kill E<n>")` (n = -answer-256)
 *     with NO `.code` — reproducing the native lane's own asymmetry
 *     (scr_lib.c's `scr_kill_send`) rather than tidying it.
 *     THE SIGNAL NUMBER CROSSES IN LINUX NUMBERING — the tier's comparison
 *     platform. A host on another platform translates; two names share a
 *     number in Node's own table (SIGABRT=SIGIOT, SIGPOLL=SIGIO), so a
 *     translating host must know both spellings answer the same wire
 *     value. THE PID/SIGNAL VALIDATION AND THE NAME TABLE ARE PURE
 *     IN-MODULE WORK — this import's ONLY job is the syscall's residue;
 *     Node's exact wording for a bad pid or an unknown signal never
 *     reaches the host at all.
 *     kill's EFFECT TIER: that the host signalled the RIGHT process with
 *     the RIGHT signal is enforced by NOTHING — the harness's own forced-
 *     host rows and its real-host safety guard (never a semantic one) are
 *     the check.
 *
 *   (import "tsinter" "chdir" (func (param i32 i32) (result i32)))
 *     chdir(ptr, len of a UTF-16 path in module memory) -> 0 on success,
 *     -code on failure, in chdir's OWN eight-code enumeration (a NAMESPACE
 *     SEPARATE FROM kill's — codes 1-8 here are NOT kill's -1/-2/-3):
 *       1 ENOENT  2 ENOTDIR  3 EACCES  4 ENAMETOOLONG  5 ELOOP  6 EIO
 *       7 ENOMEM  8 EPERM (a namespace/container answer)
 *     and, for anything else, -(256 + the raw platform errno) — the SAME
 *     carrier shape as `kill`'s, a coincidence of convenience, not a
 *     shared table. The module renders `.message` from
 *     `util.getSystemErrorMessage`'s OWN texts (Node's exact wording,
 *     measured) inside the two-path fs form `"<CODE>: <text>, chdir
 *     '<cwd-before-the-call>' -> '<dir>'"`; the UNKNOWN arm renders code
 *     `E<n>` (n = -answer-256) with text `"Unknown system error -<n>"` —
 *     NOT a Node spelling (S077's own limitation). `.errno`/`.syscall`/
 *     `.path`/`.dest` are UNREPRESENTED on every non-Node lane (S077).
 *     ON SUCCESS the host's cwd changed; the module's OWN cwd snapshot
 *     (path.ts's `cwdSnapshot`, D2 ERRATUM 1) is invalidated by the arm
 *     itself so a later `path.resolve()` reads the NEW directory rather
 *     than a stale memo.
 *     chdir's EFFECT TIER: that the host performed the chdir(2) it was
 *     asked for is enforced by NOTHING — the harness's own rows are the
 *     check (and, in the DIFFERENTIAL harness specifically, `chdir` is a
 *     RECORDING STUB that mutates nothing, since the module runs
 *     in-process and a real chdir would move every LATER program's own
 *     cwd — design §3C).
 *
 *   (import "tsinter" "umask" (func (param i32 i32) (result i32)))
 *     umask(isRead, mask) -> the PREVIOUS mask (always <= 0o777, fits i32
 *     signed either way). isRead = 1: read without setting, `mask`
 *     IGNORED. isRead = 0: SET `mask`, whose 32 bits are UNSIGNED (the
 *     module passes `i32.trunc_f64_u` after its own range check; the host
 *     reads them back with `>>> 0`). THERE IS NO IN-BAND SENTINEL:
 *     4294967295 is a mask Node ACCEPTS (measured — the kernel then masks
 *     to 0o777) and is ALSO the i32 bit pattern of -1, so a single-i32
 *     "isRead if mask < 0" encoding cannot represent it; the explicit
 *     isRead PARAMETER is why this import takes two i32s instead of one.
 *     The MODULE performs Node's own validation before ever calling this
 *     import — INTEGER FIRST, RANGE SECOND (measured: a non-integer mask
 *     throws RangeError ERR_OUT_OF_RANGE 'The value of "mask" is out of
 *     range. It must be an integer. Received <n>' even when it is ALSO
 *     out of [0, 4294967295]; only an integral out-of-range mask throws
 *     'It must be >= 0 && <= 4294967295. Received <n>') — the host never
 *     sees an invalid mask.
 *     THE FRONTEND'S 0-ARY COMPLETION COLLIDES WITH A USER-WRITTEN
 *     `umask(-1)` (board #142): the read sentinel the frontend inserts for
 *     `process.umask()` is the SAME IR-level value Node treats as an
 *     out-of-range mask for an explicit `process.umask(-1)` call, so both
 *     read on every lane where Node throws. This is a FRONTEND defect
 *     (recorded, not fixed here — frontend/* is out of this pass's reach);
 *     the -1 IR value always means "read" at THIS import regardless of
 *     which source shape produced it.
 *     umask's EFFECT TIER: that the host answers the PROCESS'S REAL
 *     previous mask (on a read) or ACTUALLY sets it (on a write) is
 *     enforced by NOTHING — the `wallClock` shape, restated (and, in the
 *     DIFFERENTIAL harness, `umask` is a RECORDING STUB for the same
 *     in-process reason `chdir` is — design §3C).
 *
 * INC-26 pass P4 (design-host-v7.txt §2.6/§6.1-§6.4, DECISIONS.md P4-J1..J3,
 * brief-p4-v2.md §0/§1): ONE effect-dispatcher import behind THIRTEEN fs.*
 * keys — never eighteen separate imports, and never kill's/chdir's shape
 * (one key, one import, one errno table each).
 *
 *   (import "tsinter" "fsCall" (func (param i32 i32 i32 i32 i32 i32 i32) (result i32)))
 *     fsCall(op, aPtr, aLen, bPtr, bLen, x, y) -> status (i32).
 *     `op` SELECTS THE OPERATION — the numbers ARE the ABI, append-only,
 *     never renumbered, and this table ships WHOLE even though P4 builds
 *     only eleven of the twenty-three (the SAME stance hostStr's/hostNum's
 *     kind tables already take):
 *       READ-SHAPED (answer a length; content lands in the region the
 *       caller gave):
 *         1 readFile(pathA,bytes=x)->length   2 readdir(pathA)->JSON length
 *           (delta-3d a3c02af9, append-only: op 1's `x` was UNSPENT
 *           before P5 — readFileSync and readFileSyncBytes/
 *           fsp.readFileBytes share this ONE row, and the two keys need
 *           INCOMPATIBLE slot-B encodings [UTF-16 CODE UNITS vs RAW
 *           BYTES] from a wire call that was otherwise byte-for-byte
 *           identical — measured LIVE, not hypothetical: this pass's own
 *           STOP-AND-REPORT traced 1403/1574's actual bytes through the
 *           OLD ambiguous host and found a fragile round-trip coincidence
 *           masking the bug. x=1: the slot-B payload is RAW BYTES, bLen
 *           in BYTES, no ×2 [readFileSyncBytes, fsp.readFileBytes]; x=0
 *           (still the default, a DELIBERATE literal, never
 *           uninitialized — the text key's own row asserts it): UTF-16
 *           CODE UNITS, bLen in code units, exactly P4's own contract,
 *           unchanged.)
 *         3 mkdtemp(prefixA)->path length     4 realpath(pathA)->path length
 *                                              (on success; on failure, see
 *                                              OP 4's own paragraph below)
 *                                                                   [P5]
 *         5 readFd(fd=x)->byte length (ENCODED form only)          [P5]
 *         6 read(fd,off,len)->byte count                           [P5]
 *         7 stat(pathA)->0 or -errno, the FIXED 5-FIELD RECORD in slot B
 *           8 lstat(pathA)->0 or -errno, SAME record shape          [P5]
 *           (E-P5-1, CP1 delta 29286fa4 A-2/N-1 — REWRITES this line's
 *           ORIGINAL "->JSON length" text; append-only, no renumber: ops
 *           7/8 were UNBUILT before P5, so nothing else ever read the old
 *           text. NOT read-shaped's length-retry contract — the record is
 *           FIXED SIZE (20 bytes: 4 [isFile/isDirectory/isSymbolicLink/pad,
 *           four u8 at offsets 0-3] + 8 [size f64 at offset 4] + 8 [mtimeMs
 *           f64 at offset 12] = 20 — rev-26 B-1, findings-rev26-3c-p5.txt
 *           a1b0b98f: this line previously said 24, disagreeing with its
 *           own offset breakdown and with fs.ts's own "20-byte slot-B
 *           record" header and its i32Const(20) width/bLen; a host author
 *           taking 24 from here writes 4 bytes past what the module sizes
 *           and ensureCapacity's — silent corruption, the Float64Array/
 *           Int32Array class again), so status is 0 on success like a write-shaped op,
 *           never a length. THE HOST WRITES THE THREE BOOLEANS (computed
 *           host-side, A-1) and THE TWO f64 FIELDS THROUGH A DataView
 *           setFloat64(off, v, true) — NEVER a Float64Array (N-1, measured
 *           p5-f64-align.out b703a6c0: slot B is only 2-byte aligned,
 *           RangeError on 5 of 6 sampled bases). The MODULE reads the
 *           booleans with i32.load8_u and the f64s with a byte-aligned
 *           f64.load (align=0 hint) — unconstrained, per the general slot-B
 *           alignment note below.)
 *       WRITE-SHAPED (answer 0 or -errno):
 *         9 writeFile(pathA,bytesB,mode=x-1,bytes=y) 10 appendFile(pathA,bytesB)
 *           (delta-3d a3c02af9, append-only: the SAME shared-row hazard
 *           as op 1's own paragraph above, but op 9's `x` is ALREADY
 *           SPENT — writeFileModeSync forwards a REAL mode through it —
 *           so the bytes flag rides `y` instead [op 9's own `y` is the
 *           inert 0 everywhere else]. y=1: slot B is RAW BYTES, bLen in
 *           BYTES, no ×2 [writeFileSyncBytes]; y=0 (the text key's own
 *           row asserts it): UTF-16 CODE UNITS, bLen in code units,
 *           exactly P4's own contract, unchanged — writeFileSync,
 *           writeFileModeSync, and fsp.writeFile all keep y=0. delta-3db
 *           d7e1c3db, B-1, append-only: `x` is `mode + 1`, NEVER the raw
 *           mode — x=0 already means "absent" for writeFileSync/
 *           fsp.writeFile [the SAME row's mode-less keys], so an unbiased
 *           x would make an EXPLICIT, representable mode 0 indistinguish-
 *           able from "no mode" [measured: Node's own {mode:0} is a real,
 *           different mode — EACCES on the same process's own immediate
 *           re-read — board #142's collision rebuilt on x]. x=1 is mode
 *           0; x=N+1 is mode N; x=0 stays "omit mode, Node's own default"
 *           for writeFileSync/fsp.writeFile, unchanged.)
 *        11 mkdir(pathA,mode=x-1,recursive=y)  12 rmdir(pathA)
 *           (delta-3db d7e1c3db, B-1, append-only: the SAME mode+1 bias
 *           as op 9's own paragraph above — mkdirModeSync/
 *           mkdirRecursiveModeSync send x=mode+1; mkdirSync/
 *           mkdirRecursiveSync keep the unchanged literal x=0.)
 *        13 unlink(pathA)                     14 rm(pathA,recursive,force,
 *                                                    maxRetries,retryDelay)
 *           [P5, CP1 delta cp1b] maxRetries/retryDelay do NOT ride x/y —
 *           P4's rmOptsSync already spends both (x=recursive,y=force) —
 *           they ride SLOT B as a two-i32 LE record (bLen=8) when present,
 *           bLen=0 when absent (rmSync/rmOptsSync never send it). THE HOST
 *           READS AND WRITES THIS RECORD THROUGH A DataView getInt32/
 *           setInt32(off, v, true) — NEVER an Int32Array (N-1's rule at
 *           4-byte granularity: slot B sits at 2 mod 4 on every odd-code-
 *           unit path length, measured p5-i32-align.out 8e7aa7f6).
 *        15 copyFile(pathA,pathB)             16 chmod(pathA,mode)   [P5]
 *        17 chown(pathA,uid,gid)              18 close(fd)           [P5]
 *       PROBE-SHAPED (answer 0, or -errno, and NEVER build an error):
 *        19 exists(pathA)                     20 access(pathA,mode)
 *       HANDLE-SHAPED (P5): 21 open(pathA,flags=x,mode=y)->fd or -errno
 *       op 5's two sub-ops (P5): 22 fstatFd(fd=x)->byte size or -errno;
 *         23 readFdInto(fd=x,ptr,cap)->byte count or -errno.
 *     P4 BUILDS: 1, 2, 3, 9, 10, 11, 12, 13, 14, 19, 20. The rest are P5's.
 *     `x`/`y` carry integer options (mode, flags, fd, offset, length,
 *     recursive, force, maxRetries, retryDelay) per op.
 *
 *     THE STATUS: >= 0 is success (a LENGTH for read-shaped ops, content in
 *     the staging region the call was given); < 0 is -errno, using the
 *     MODULE's OWN small enumeration (fs.ts's hand-written table — the
 *     THIRD errno table in this ABI, sharing no number space with kill's or
 *     chdir's), NOT the host's raw platform errno. THE HOST NEVER THROWS:
 *     the module builds Node's Error itself, from a code it owns (design
 *     §6.1 — the sharpest reason is that a host throw across this boundary
 *     IS the tier's exit mechanism, M-12, and fs errors are CATCHABLE in
 *     Node, so they must not share that channel with `exit`).
 *
 *     A LENGTH-RETURNING op uses hostStr's OWN retry contract: if the
 *     answer exceeds the capacity offered, nothing is written and the true
 *     length comes back, and the module retries with a bigger region.
 *
 *     TWO SLOTS, TWO REGIONS, LIVE AT ONCE. `writeFile(path, content)`
 *     needs slot A (the path) and slot B (the content) populated
 *     simultaneously, so "at the cursor" cannot describe both: slot A is
 *     laid at the cursor exactly as hostStr's own outbound writes are; slot
 *     B begins at `cursor + roundUp(aLen, 2)`, and `emitEnsureCapacity` is
 *     called ONCE for the combined size before either is written. Neither
 *     slot advances the cursor. THE ALIGNMENT IS 2 BYTES, REQUIRED, AND THE
 *     REASON IS THE HOST, NOT THE MODULE (measured, CP1 delta (d)): nothing
 *     the MODULE writes needs 4/8-byte alignment (`stageStrUtf16` emits two
 *     `i32Store8`s per UTF-16 code unit — there is no wide store in this
 *     tier to align for), but BOTH hosts read module memory as `new
 *     Uint16Array(memory.buffer, ptr, len)`, and an ODD `ptr` makes THAT
 *     CONSTRUCTOR THROW `RangeError: start offset of Uint16Array should be
 *     a multiple of 2` — a host throw inside a `tsinter` import unwinds the
 *     module UNCATCHABLY (M-12, the SAME property `exit` relies on
 *     deliberately), so a misaligned slot B is an UNCATCHABLE CRASH naming
 *     the host, not subtle corruption. A byte-payload slot (raw bytes, no
 *     UTF-16 packing) needs no stricter alignment than 1.
 *
 *     fsCall's EFFECT TIER: that the host performed the syscall it was
 *     asked for, on the path it was given, is enforced by NOTHING — the
 *     harness's own rows are the check (§2.1's "fourth tier", restated).
 *
 *     STRUCTURED RESULTS: readdir's own JSON form (P4; readdirTypesSync
 *     shares its op 2 row, P5, via an `x` flag — see op 2 above) crosses as
 *     a JSON DOCUMENT, parsed by the tier's own parser. stat/lstat (P5)
 *     do NOT — E-P5-1 above moved them to the fixed slot-B record instead,
 *     once A-2's own measurement showed JSON.stringify(fs.Stats) silently
 *     omits the three boolean accessors (they are prototype methods, never
 *     own-enumerable properties) — the host would have had to hand-build
 *     the JSON payload anyway, so the fixed record costs nothing extra and
 *     avoids a parse this pass does not need.
 *
 *     OP 4 (realpathSync, P5) IS THE ONE OP WHOSE ERROR PATH IS A HOST
 *     FACT, NOT A FUNCTION OF THE INPUT (E-P5-2, B-3, measured
 *     p5-realpath-rule.out d26e5207): the failing PATH in Node's own
 *     message is the ARGUMENT RESOLVED (symlinks replaced by their
 *     targets, `.` dropped, `..` applied, relative made absolute against
 *     cwd) then TRUNCATED at the first failing component under ENOENT, or
 *     reported WHOLE under ENOTDIR — never simply the compile-time-known
 *     input string every other op's error message uses. ON FAILURE, op 4
 *     WRITES THE ERROR PATH INTO SLOT B (u16 code-unit count at slot B,
 *     payload at +2) instead of the usual "answer a length" read-shaped
 *     contract (INC-26 P5 3C-2, brief-p5-delta-3c.txt 0c29d591 — RULED
 *     over a NUL-terminated alternative: a fixed-width length prefix
 *     needs no scan loop and assumes nothing about content; slot B's
 *     2-byte alignment already makes `i32.load16_u` safe for the count,
 *     no DataView needed since there is no 4- or 8-byte field here); the
 *     module's op-4 failure arm reads the count then the payload from
 *     slot B instead of its own `pathALocal`, the ONE op built this way.
 *     Its syscall is ALSO
 *     PER-CODE (B-4, M-21, p5-eloop-netif.out 2ebde125): `lstat` under
 *     ENOENT/ENOTDIR, `stat` under ELOOP — realpath's own OP_TABLE
 *     `codeOverrides` entry, `{ELOOP:{syscall:"stat"}}`; every OTHER op
 *     keeps its own literal under ELOOP. A failing realpath that
 *     OVERSHOOTS slot B (the u16-prefixed error record does not fit the
 *     capacity offered) runs the underlying syscall TWICE — once to
 *     discover the overshoot, once more on the module's own retry with a
 *     bigger region (rev-26 3D read, findings-rev26-3d-p5.txt 04dca2b6)
 *     — the adapter recomputes rather than caching, exactly like every
 *     other read-shaped op's own retry loop.
 *
 * THE ARGV/ENV SNAPSHOT (D2). `process.argv` and the whole of `process.env`
 * are read ONCE, at first touch, into module-owned storage — never a live
 * per-read fetch. argv: at first touch, the module reads argc (`hostNum`
 * kind 0) then argv[0..argc) (`hostStr` kind 0) into ONE interned
 * module-global `string[]`; every later `process.argv` read answers that
 * SAME array (Node's own process.argv is one interned mutable array, and
 * this is that model, not a simplification of it — a per-read fetch would
 * break any program that mutates argv and reads the mutation back). env:
 * at first touch of ANY env key, the module reads the pair count (`hostNum`
 * kind 1) then all pairs (`hostStr` kinds 1 and 2) into one in-module map;
 * get/set/unset/`in`/spread/Object.keys all run against that map from then
 * on. THE ONE OBSERVABLE THAT DISTINGUISHES A SNAPSHOT FROM A LIVE PROXY is
 * a spawned CHILD inheriting a variable this module wrote. INC-28 U1 (the
 * first increment with a child_process surface, `cpCall` below) revisited
 * the decision and kept the snapshot as the model: every child the module
 * starts is given an environment BY THE MODULE — its own current map when
 * the call has no `env` option, the replacement pairs when it has one —
 * and the host never consults its own environment for a child. A child
 * therefore sees exactly the writes and deletes this module made, which
 * closes the one observable by construction rather than by a live proxy.
 * Node's process.env setter cuts a key or value at its first U+0000; when
 * the module sends its OWN map it applies the same cut to each key and
 * value, so the child sees Node's strings (an explicit `env` option is not
 * cut: Node validates it and throws, and so does the module).
 *
 *   (import "tsinter" "cpCall" (func (param i32 i32 i32 i32 i32) (result i32)))
 *     [modules that reach cp.spawnSync, cp.spawnSyncOpts,
 *      cp.spawnSyncStdioStr, cp.execSync or cp.execCapture only]
 *     cpCall(op, ptr, len, h, which) -> i32. INC-28 U1. ONE op-dispatched
 *     import for child_process's synchronous surface. A child cannot be
 *     re-run, so this import never uses the retry-on-short-buffer contract
 *     of hostStr/fsCall: the HOST runs the child once, HOLDS the finished
 *     result behind a small integer handle, and the module reads it out.
 *       op 1 RUN(ptr, len)     -> handle >= 0; < 0 = a HOST FAILURE
 *       op 2 META(ptr, h)      -> writes the 32-byte result record at ptr,
 *                                 answers 32
 *       op 3 READ(ptr, h, which) -> copies stream `which` (1 stdout,
 *                                 2 stderr; its length from META) to ptr,
 *                                 answers that length
 *       op 4 FREE(h)           -> 0; the handle is gone
 *     Unused parameters are 0. RUN, META, READ (0-2 times) and FREE run
 *     inside ONE module function; the module never holds a handle across
 *     a function boundary. Any answer outside these contracts (a negative
 *     RUN, a META other than 32, a READ length other than META's, a
 *     non-zero FREE) is a named trap in the module ("cpCall: host
 *     failure"): every program-reachable Node throw is validated in the
 *     MODULE before RUN, so a host failure is a host bug, never a program
 *     outcome. The host never builds message text — the module builds
 *     every error from the numbers in the result record.
 *     THE REQUEST RECORD (module -> host) at ptr, which the module rounds
 *     up to a multiple of 4, little-endian: header u32 stdinMode at +0
 *     (0 pipe at end-of-file, 1 pipe carrying the input below, 2 inherit,
 *     3 ignore), u32 stdoutMode at +4 and u32 stderrMode at +8 (0 capture,
 *     1 discard, 2 inherit), u32 killSignal at +12 (a validated Linux
 *     signal number), f64 timeoutMs at +16 (0 = none; any accepted value,
 *     however large, is passed through), u32 maxBufferMode at +24
 *     (0 = Node's default limit, 1 = unbounded), u32 reserved at +28 = 0 —
 *     4+4+4+4+8+4+4 = 32 bytes. Then, from +32, RUNS — each a u32 count of
 *     UTF-16 code units followed by 2*count bytes, padded with zeros to
 *     the next multiple of 4 so every run starts 4-aligned: the file; a
 *     u32 argument count and that many runs; the cwd (count 0 = no cwd,
 *     the child inherits the host's); a u32 pair count and that many
 *     (key run, value run) pairs — the WHOLE environment of the child;
 *     then a u32 byte count and the input's UTF-8 bytes (a lone surrogate
 *     encoded as EF BF BD, Node's Buffer.from(s, "utf8")). `len` is the
 *     record's total byte length. The host reads every u32 and the f64
 *     through a DataView and every run through a Uint16Array at a 4-aligned
 *     offset, each view built from memory.buffer AT CALL TIME (a grow
 *     detaches older views).
 *     THE RESULT RECORD (op 2), field by field from the host's own child
 *     result, written through a DataView: u32 hasStatus at +0, f64 status
 *     at +4, u32 signal at +12 (0 = none, else the Linux number), i32
 *     errCode at +16, u32 stdoutLen at +20, u32 stderrLen at +24, u32
 *     reserved at +28 — 4+8+4+4+4+4+4 = 32 bytes. ORTHOGONAL: a status and
 *     an error can both be present (a child that traps the timeout's
 *     signal and exits; EPIPE after a normal exit), and so can a signal
 *     and an error (ENOBUFS). errCode: 0 none; 1..15 index the module's
 *     own table (childproc.ts CP_CODES: ENOENT EACCES EPERM ENOTDIR ENOEXEC
 *     ELOOP ENAMETOOLONG E2BIG ENOMEM EAGAIN EIO EINVAL ETIMEDOUT EPIPE
 *     ENOBUFS); any other errno n is carried as -(256 + n), from which the
 *     module renders Node's own name for -n.
 *     STDIO: an inherited stream is EMULATED — the host captures it and
 *     the module writes the bytes, raw, to its own fd 1/2 right after
 *     RUN, before any echo or throw. A host may pass a real inherit
 *     through instead only if its fds are the program's own.
 *     THE CLOCK: RUN advances the host's monotonic clock (`now`, and the
 *     wall clock that follows it) by the child's measured duration, so a
 *     timer armed before a long child is due when the call returns, as
 *     in Node. The advance makes the clock FRACTIONAL; nothing observes
 *     that — Date.now is floored by the module (wallClock above) and
 *     performance.now is fractional in Node too.
 *     THE CAPABILITY (S004): this import runs arbitrary programs with the
 *     host user's authority. A host that does not grant it DOES NOT
 *     SUPPLY THE IMPORT, and a module reaching child_process fails to
 *     instantiate with a LinkError before a single instruction runs (the
 *     engine enforces that half). A host granting less answers a spawn
 *     failure (EACCES/EPERM) for what it refuses.
 *     cpCall's EFFECT TIER: that the host ran the program it was asked
 *     to, with the environment, cwd, input and stdio it was given, and
 *     transcribed the child's result faithfully, is enforced by NOTHING —
 *     the harness's own rows are the check.
 *     INC-28 U2 — FOUR MORE OPS for spawn's asynchronous surface, minted
 *     only in EVENT MODULES (those reaching cp.spawn or cp.spawnOpts) and
 *     in modules reaching child.kill, child.killNum or child.unref:
 *       op 5 SPAWN(ptr, len)   -> the host starts a child and answers at
 *                                 once (it does not wait for it)
 *       op 6 KILL(h, which)    -> `which` is the Linux signal number;
 *                                 answers 0 when the signal was sent, else
 *                                 a NEGATIVE Linux errno (ESRCH -3 for a
 *                                 child already reaped, EINVAL -22, ENOSYS
 *                                 -38, EPERM -1, ...)
 *       op 7 UNREF(h)          -> 0
 *       op 8 RELEASE(h)        -> 0; the module sends it once the child's
 *                                 exit has been delivered, and the handle
 *                                 is gone (INC-28 U3: in a module that
 *                                 pipes output, once every piped stream's
 *                                 END has been delivered too)
 *       op 9 FLOW(h, which)    -> 0. INC-28 U3: the piped stream `which`
 *                                 (1 stdout, 2 stderr) got its first
 *                                 'data' listener; the host attaches its
 *                                 own 'data' listener to that stream now,
 *                                 once, so its stream starts flowing (and
 *                                 stops back-pressuring the child) exactly
 *                                 when the program's would. Minted with
 *                                 cpCall wherever stream.onData is
 *                                 reachable.
 *     THE SPAWN REQUEST at ptr, little-endian: header u32 stdinMode at +0
 *     (0 ignore, 1 inherit), u32 stdoutMode at +4 and u32 stderrMode at +8
 *     (0 ignore, 1 inherit, 2 a file descriptor, 3 a pipe — INC-28 U3:
 *     child.stdout / child.stderr's stream, read by the host; a 3 is never
 *     beside a 1 or 2 in the other output slot), i32 outFd at +12 and
 *     i32 errFd at +16 (read only in mode 2), u32 detached at +20, two
 *     u32 reserved words at +24 and +28 = 0 — 4+4+4+4+4+4+4+4 = 32 bytes;
 *     then from +32 op 1's RUNS in op 1's order — the file, a u32 argument
 *     count and that many runs, the cwd (count 0 = no cwd), a u32 pair
 *     count and that many (key, value) runs, the child's WHOLE environment
 *     — and no input. `len` is the record's total byte length.
 *     THE SPAWN REPLY, written by the host over the same ptr: i32 errno at
 *     +0 (0, or the NEGATIVE Linux errno the spawn failed with), i32
 *     disposition at +4 (0 spawned, 1 the failure is reported later as an
 *     'error' event, 2 the failure is thrown now — Node's own split: EACCES,
 *     EAGAIN, EMFILE, ENFILE and ENOENT are reported later, every other
 *     errno is thrown), i32 pid at +8 — 4+4+4 = 12 bytes. The answer is
 *     the child's HANDLE, >= 1, exactly when disposition is 0, and 0
 *     exactly when it is 1 or 2 (there is no host child then) — INC-28 U3:
 *     except that a disposition-1 failure with a piped output slot has a
 *     handle too, for its streams (Node creates them, and they end; that
 *     handle never carries an EXIT, and KILL and UNREF never name it); a negative
 *     answer is a host failure. Handles are numbered from 1. The module
 *     derives the disposition from the errno itself and checks the host's
 *     agrees, and checks both directions of the answer rule: any mismatch
 *     is the named trap.
 *     A spawned child's events reach the module through `evPoll` below.
 *
 *   (import "tsinter" "evPoll" (func (param i32 i32) (result i32)))
 *     [event modules only — those reaching cp.spawn or cp.spawnOpts, and
 *     since INC-29 U1 those reaching a node:net key that can start host
 *     I/O (netCall below)]
 *     evPoll(ptr, cap) -> i32. INC-28 U2. The host's EVENT QUEUE, read one
 *     event at a time: the host writes the oldest queued event at ptr and
 *     answers its length; answers 0 when the queue is empty; and answers
 *     -(the length it needs) WITHOUT removing the event when `cap` is too
 *     small, so the module grows its buffer and asks again — the event is
 *     held, never lost and never re-created. THE RECORD, little-endian:
 *     u32 source at +0 (1 = a child, 2 = a net handle — INC-29 U1,
 *     netCall below), u32 handle at +4, u32 kind at +8,
 *     u32 payloadLen at +12, i32 a at +16, i32 b at +20 — 4+4+4+4+4+4 = 24
 *     bytes — then payloadLen bytes. A child's kinds: 1 EXIT (a = the exit
 *     code, or -1 when a signal ended the child; b = that signal's Linux
 *     number, else 0; no payload), 2 bytes for the PROGRAM'S stdout, 3
 *     bytes for the PROGRAM'S stderr (named by destination: a child's
 *     inherited stream, or its fd 1 or 2 given in either output slot, is
 *     captured by the host and written by the module, raw, when the
 *     module polls). The host queues a child's EXIT only after every
 *     stream it captures for that child has reached end of file.
 *     INC-28 U3 adds, for a piped slot (`a` = the slot, 1 stdout or 2
 *     stderr; `b` = 0): 4 STREAM-DATA (payload = one chunk, the bytes and
 *     boundaries of the host Node's own 'data' event; sent only after
 *     FLOW, never after that stream's END) and 5 STREAM-END (the host
 *     Node's 'end'; no payload; once per piped stream), and 6 STREAM-HELD
 *     (payload = one chunk the host's stream emitted after the child's
 *     'exit', for a stream that had not been FLOWed by then — the host
 *     attaches its own 'data' listener at its 'exit' for exactly those;
 *     the module emits the chunk where Node's flow() would, or drops it;
 *     a FLOW for such a stream answers 0 and changes nothing). A piped child's
 *     EXIT is queued at the host's 'exit' — in the order its Node emits it
 *     among the streams' events — once its captured (inherited) streams
 *     have closed. THE SCOPE BIT: in a module that pipes output, bit 8
 *     (0x100) of the kind word on an EXIT, DATA, END or HELD says the NEXT
 *     queued event was emitted in the same host callback scope (before
 *     that scope's ticks and microtasks drained): the module runs no
 *     microtask checkpoint between them. An event carrying it is never the
 *     last one queued. A header
 *     is 24 bytes, so 0 is never a valid length. Any record the module
 *     cannot read (an unknown source, kind or handle, a length that is not
 *     24 + payloadLen) is the named trap "cpCall: host failure".
 *     evPoll's EFFECT TIER: that the queue holds what the host's children
 *     did, in the order the host saw it, is enforced by NOTHING — the
 *     harness's own rows are the check.
 *
 *   (import "tsinter" "netCall" (func (param i32 i32 i32 i32 i32) (result i32)))
 *     [net modules only — INC-29 U1: those reaching a node:net key that
 *     can start host I/O; the attempt-budget pair
 *     (get/setDefaultAutoSelectFamilyAttemptTimeout) and connect's
 *     option-bag check alone do not mint it. INC-29 U4: node:tls /
 *     node:https keys that open a socket or a server, and every
 *     node:dgram key, mint it too. The LAST import but for tlsCall.]
 *     netCall(op, ptr, len, h, x) -> i32: raw TCP at the level of libuv's
 *     uv_tcp_* and uv_getaddrinfo, and nothing more. Every Node behaviour
 *     — validation and its texts, the errno-to-Error construction
 *     (ErrnoException, ExceptionWithHostPort, UVExceptionWithHostPort,
 *     DNSException, the AggregateError of a multi-address connect), the
 *     Readable / Writable state machine of a Socket, every nextTick and
 *     emit position, the closing phase — is built in the module (net.ts),
 *     so a host answers facts only: a HANDLE (>= 1, numbered from 1 in one
 *     space shared by servers, sockets and lookups), a NEGATIVE Linux
 *     errno (or a negative getaddrinfo code, Node's -3000 range), a
 *     completion. Strings travel as UTF-16 RUNS: u32 code-unit count, the
 *     units, zero padding to a multiple of 4. All words little-endian.
 *       op 1 LISTEN(ptr, len)   request at ptr: u32 port, u32 family
 *                               (4 or 6), u32 flags (bit 0 = ipv6Only),
 *                               u32 backlog (Node's 511), then the bind
 *                               address's run. The host creates, binds
 *                               and listens. REPLY written over ptr: u32
 *                               stage (0 listening; 1 the handle could not
 *                               be created or bound; 2 listen(2) failed),
 *                               u32 bound port, u32 bound family, the
 *                               bound address's run. Answers the server's
 *                               handle at stage 0, else the -errno. The
 *                               module retries an unbound '::' failure at
 *                               stage 1 on '0.0.0.0' itself, as Node does.
 *       op 2 CONNECT(ptr, len)  request: u32 port, u32 family, the
 *                               address's run (an IP literal; the module
 *                               resolved any name with op 9). Answers the
 *                               socket's handle at once; the outcome is a
 *                               CONNECT event. A -errno answer is a
 *                               connect that failed synchronously.
 *       op 3 READ_START(h)      -> 0. Start delivering DATA / EOF /
 *                               READ_ERROR for h.
 *       op 4 READ_STOP(h)       -> 0. Stop: no DATA, EOF or READ_ERROR
 *                               for h is delivered until the next
 *                               READ_START — including any the host has
 *                               already queued, which it HOLDS and
 *                               re-queues, in order, at that READ_START
 *                               (Node's readStop: the module's Readable
 *                               sits at its high-water mark, 64 KiB).
 *                               The host stops reading the socket itself
 *                               at once (uv_read_stop), so it never reads
 *                               ahead of the module or sees a read error
 *                               the module would not.
 *       op 5 WRITE(ptr, len, h) the len bytes at ptr, written to h. 0 =
 *                               written now (the module completes the
 *                               write synchronously, so the Writable
 *                               runs its callback on a nextTick, as
 *                               afterWriteDispatched does); 1 = pending,
 *                               completed by a WRITE_DONE; -errno = the
 *                               write failed now. One write is pending
 *                               per handle at a time.
 *       op 6 SHUTDOWN(h)        -> 0 accepted, or -errno (uv_shutdown's
 *                               own refusal: ENOTCONN for a stream no
 *                               longer writable, which Node's _final
 *                               takes as a synchronous finish). On 0 the
 *                               host shuts the write side down; the
 *                               MODULE completes the request — libuv's
 *                               uv_shutdown with an empty write queue
 *                               feeds the handle to the loop's pending
 *                               queue, and uv__drain completes it in the
 *                               next pending pass (see THE EVENT LOOP).
 *                               No event follows: Node's afterShutdown
 *                               ignores the status. Any other answer is a
 *                               host failure. (An empty write queue is
 *                               certain here: the Writable calls _final
 *                               only once every write has completed.)
 *       op 7 CLOSE(h)           -> 0. h is gone: the host drops every
 *                               event it still holds or has queued for h
 *                               (a queued ACCEPT's new socket is closed
 *                               with it) and never names h again. A
 *                               pending WRITE or SHUTDOWN on h needs no
 *                               completion: the module completes it with
 *                               ECANCELED in its own closing phase.
 *       op 8 NODELAY(h, x)      -> 0. TCP_NODELAY on h, on when x != 0.
 *       op 9 RESOLVE(ptr, len)  request: u32 family (0, 4 or 6), u32
 *                               hints (Node's ADDRCONFIG, 32), the name's
 *                               run. Answers a request handle at once;
 *                               the answer is a RESOLVE_DONE, after which
 *                               the request handle is gone.
 *     INC-29 U4 — UDP (node:dgram, IPv4), at the level of libuv's
 *     uv_udp_*: a UDP handle is in the same handle space; CLOSE (op 7)
 *     closes it (no event follows; the module emits 'close' itself).
 *       op 20 UDP_BIND(ptr, len) request: u32 port, u32 family (4), the
 *                               address's run (an IPv4 literal), u32
 *                               flags (bit 0 = reuseAddr). The host
 *                               creates the socket, binds it and starts
 *                               receiving (uv_udp_init, uv_udp_bind,
 *                               uv_udp_recv_start). Answers the handle,
 *                               or the -errno of a failed bind (no handle
 *                               then). REPLY over ptr on success: u32
 *                               bound port, u32 family, the bound
 *                               address's run (getsockname).
 *       op 21 UDP_CONNECT(ptr, len, h) request: u32 port, u32 family, the
 *                               address's run. uv_udp_connect, now:
 *                               answers 0 or the -errno; on 0 the REPLY
 *                               over ptr is the local address, as op 20's.
 *       op 22 UDP_SEND(ptr, len, h) request: u32 port, u32 family, the
 *                               destination's run (empty and port 0 on a
 *                               connected socket), then a blob (u32 byte
 *                               count, the bytes, padding to 4): one
 *                               datagram. Answers 0 (sent, or queued by
 *                               the host) or a -errno, which the module
 *                               drops as Node's doSend drops an error with
 *                               no callback. ORDER: datagrams leave in
 *                               the order of their UDP_SEND calls, across
 *                               every UDP handle (uv_udp_send's queue,
 *                               which Node reaches synchronously for an
 *                               IP literal): a host queues, it never
 *                               reorders or defers one behind a later
 *                               call.
 *       op 23 UDP_RECV_START(h) -> 0. A no-op kept for the contract's
 *                               shape: op 20 already receives.
 *     EVENTS, evPoll source 2, `handle` the server, socket or request:
 *       1 ACCEPT        on a server: a = the new socket's handle (not yet
 *                       reading); payload = the peer (u32 family, u32
 *                       port, address run).
 *       2 CONNECT       a = 0, payload = the peer; or a = -errno, no
 *                       payload. Once per CONNECT op.
 *       3 DATA          payload = the bytes, one host read.
 *       4 EOF           the peer's FIN; no payload. Once.
 *       5 READ_ERROR    a = -errno (ECONNRESET, ...).
 *       6 WRITE_DONE    a = 0 or -errno: the pending write finished.
 *       7               retired (INC-29 U1 review): a shutdown completes
 *                       in the module's pending pass, never by an event.
 *       8 RESOLVE_DONE  a = 0 and payload = u32 count, then (u32 family,
 *                       address run) per address, in the resolver's
 *                       order; or a = the negative getaddrinfo code.
 *       9 ACCEPT_ERROR  on a server: a = -errno (the harness host never
 *                       sends it).
 *       10 SECURE       INC-29 U4, tlsCall below: a secured socket's
 *                       handshake completed; a = 0; payload = u32 the
 *                       X.509 verification result of the peer's chain
 *                       (client mode; 0 in server mode), then a blob: the
 *                       peer's leaf certificate, DER (empty when none).
 *       11 TLS_ERROR    a TLS-protocol failure on a secured socket (the
 *                       engine's, before or after the handshake);
 *                       payload = the message's run, then the code's run
 *                       (empty when the engine has none). A transport
 *                       failure is still a READ_ERROR / EOF.
 *       20 UDP_MESSAGE  on a UDP handle: payload = the sender (u32
 *                       family, u32 port, address run), then the
 *                       datagram's bytes (the rest of the payload).
 *       21 UDP_ERROR    on a UDP handle: a = the receive's -errno.
 *     `b` is 0 on every net event. ONE HOST ITERATION, ONE POLL PHASE: a
 *     host answers 0 (no event) once the events it observed in one of its
 *     own loop iterations are delivered, though later ones are queued; the
 *     module ends that poll phase and gets them at its next one, as its
 *     own libuv would have read them in a later iteration. (A host whose
 *     loop is not libuv's maps "iteration" to its own nearest unit.) A
 *     WRITE that does not finish at once is answered by a WRITE_DONE in
 *     the poll phase (libuv's POLLOUT completion, uv__stream_io running
 *     the write callbacks directly). PLATFORM SCOPE: on Linux the
 *     shutdown is the only pending-queue completion lib/net.js reaches, and
 *     this contract models only it. Two more exist in libuv and are not
 *     modelled: a connect the kernel refuses at once (uv__tcp_connect keeps
 *     the ECONNREFUSED as a delayed error and feeds the handle to the
 *     pending queue; a non-blocking loopback connect on Linux answers
 *     EINPROGRESS instead, measured), and a write uv_write2 finishes
 *     synchronously after a partial try-write (uv__write_req_finish feeds
 *     the handle). Node completes those in a pending pass; this tier
 *     delivers them as a poll-phase CONNECT or WRITE_DONE (SEMANTICS.md
 *     S087 (j)). Any answer or record out of these
 *     shapes (an unknown kind, a handle the module does not hold, a WRITE
 *     answer other than 0, 1 or negative, a zero handle) is the named
 *     trap "netCall: host failure".
 *     THE CAPABILITY (S004): this import opens real sockets with the host
 *     user's authority. A host that does not grant it DOES NOT SUPPLY THE
 *     IMPORT, and a module reaching node:net fails to instantiate with a
 *     LinkError. A host granting less answers an errno (EACCES, EPERM,
 *     ECONNREFUSED) for what it refuses.
 *     netCall's EFFECT TIER: that the host did on the network what it was
 *     asked to and reported it faithfully, in the order it observed it,
 *     is enforced by NOTHING — the harness's own rows are the check.
 *     SEMANTICS.md S087 registers what differs from Node.
 *
 *   (import "tsinter" "tlsCall" (func (param i32 i32 i32 i32 i32) (result i32)))
 *     [TLS modules only — INC-29 U4: those reaching a node:tls or
 *     node:https key that needs the engine or the host's stores. A module
 *     that only reads the bundled roots (tls.rootCertificates,
 *     getCACertificates('bundled' / 'default') by literal) or calls
 *     setDefaultCACertificates does not import it. Always the LAST
 *     import.]
 *     tlsCall(op, ptr, len, h, x) -> i32: the HOST's TLS engine, asked
 *     for facts only. Every Node behaviour — the option ladders and their
 *     texts, the TLSSocket's events and their order, socket.authorized and
 *     authorizationError, Node's verification codes and texts, the
 *     host-name check (tls.checkServerIdentity, read from the peer's DER),
 *     the CA store's strings and setDefaultCACertificates' parse — is the
 *     module's (tls.ts, tls-x509.ts). A BLOB is a u32 byte count, the
 *     bytes, zero padding to a multiple of 4; strings are UTF-16 runs as
 *     in netCall. A material op's FAILURE answers -1 and writes over ptr
 *     the message's run then the code's run (the engine's own text; `x`
 *     is the room the module left at ptr for it, at least 4096 bytes).
 *       op 1 CTX_NEW            -> a secure context's handle (>= 1; its own
 *                               handle space). A context starts with no
 *                               trust, no certificate and no key; the
 *                               host's own protocol versions and ciphers.
 *                               It lives as long as the instance (the
 *                               module does not free it; a host may share
 *                               identical ones).
 *       op 2 CTX_ROOTS(h)       -> 0. Trust the host's default store for
 *                               this context's verification (Node's
 *                               addRootCerts). The module asks for it
 *                               only while the program has not replaced
 *                               the default set: after
 *                               setDefaultCACertificates it sends that
 *                               set's certificates with op 3 instead.
 *       op 3 CTX_ADD_CA(ptr, len, h, x)   request: a blob, PEM (as the
 *                               program gave it). Trust it. 0, or a
 *                               failure.
 *       op 4 CTX_SET_CERT(ptr, len, h, x) request: a blob, PEM. The
 *                               context's certificate (chain). 0 / failure.
 *       op 5 CTX_SET_KEY(ptr, len, h, x)  request: a blob, PEM. Its key;
 *                               a key that does not match the certificate
 *                               is a failure. 0 / failure.
 *       op 6 SECURE(ptr, len, h) request: u32 context, u32 mode (0 client,
 *                               1 server), the servername's run (client;
 *                               empty = no SNI). Secures the OPEN net
 *                               socket h (netCall's handle) — answers 0.
 *                               From then on netCall's WRITE, SHUTDOWN,
 *                               READ_START / READ_STOP and CLOSE act on
 *                               the plaintext, DATA /
 *                               EOF / READ_ERROR carry the plaintext side,
 *                               and the handshake's outcome is a SECURE
 *                               or TLS_ERROR event (evPoll source 2,
 *                               kinds 10 and 11 above). The host
 *                               VERIFIES the peer's chain against the
 *                               context's trust and REPORTS the result
 *                               (OpenSSL's X509_V_ERR numbering) — it
 *                               never fails a handshake for it (Node's
 *                               verify callback accepts), never checks a
 *                               host name, and never asks a server's peer
 *                               for a certificate. The host may read the
 *                               socket during the handshake whatever the
 *                               module's READ_START state; the plaintext
 *                               it reads is held until the module reads.
 *                               NO APPLICATION DATA BEFORE THE VERDICT:
 *                               the module issues no WRITE on a secured
 *                               socket until it has accepted the
 *                               handshake (after its SECURE event, its
 *                               verification and host-name decision,
 *                               and 'secureConnect' / 'secureConnection');
 *                               writes the program makes earlier are
 *                               held in the module and dropped when it
 *                               rejects the peer. A host therefore never
 *                               sends plaintext to a peer the module
 *                               refuses.
 *                               A HOST WHOSE ENGINE IS NOT OPENSSL maps
 *                               its own verdict to OpenSSL's X509_V_ERR
 *                               numbers (x509_vfy.h), which is what the
 *                               module turns into Node's codes and texts:
 *                               mbedTLS's MBEDTLS_X509_BADCERT_EXPIRED is
 *                               10 (CERT_HAS_EXPIRED), _FUTURE 9
 *                               (CERT_NOT_YET_VALID), _NOT_TRUSTED 20 for
 *                               a chain to no trusted root (18 when the
 *                               leaf is self-signed and alone, 19 when
 *                               the chain ends in a self-signed
 *                               untrusted root), _REVOKED 23, _BAD_KEY
 *                               66 / 67 (EE_ / CA_KEY_TOO_SMALL), _BAD_MD
 *                               68 (CA_MD_TOO_WEAK), _CN_MISMATCH never
 *                               (the host checks no
 *                               name), anything it cannot place 1
 *                               (UNSPECIFIED). Where an engine cannot
 *                               tell OpenSSL's cases apart the code and
 *                               text Node would print can differ
 *                               (SEMANTICS.md S090 (b)).
 *       op 7 CA_STORE(ptr, cap, x) the host's 'system' (x = 1) or 'extra'
 *                               (x = 2, NODE_EXTRA_CA_CERTS's) store, for
 *                               getCACertificates('system' / 'extra'): u32
 *                               count, then a DER blob per certificate,
 *                               written at ptr. Answers the bytes written,
 *                               or -(the bytes needed) when cap is short
 *                               (the module grows its room and asks
 *                               again).
 *     Any answer or record out of these shapes is the named trap
 *     "tlsCall: host failure".
 *     THE CAPABILITY (S004): a host without a TLS engine DOES NOT SUPPLY
 *     THE IMPORT, and a module reaching node:tls fails to instantiate with
 *     a LinkError.
 *     tlsCall's EFFECT TIER: that the host verified what it reports, with
 *     the trust it was given, is enforced by NOTHING — the harness's own
 *     rows are the check. SEMANTICS.md S090 registers what differs from
 *     Node.
 *
 *   (import "tsinter" "write" (func (param i32 i32 i32)))
 *     write(fd, ptr, len): the host writes len bytes at ptr from the
 *     exported memory to fd (1 = stdout, 2 = stderr), synchronously —
 *     the module reuses the staging region the moment the call returns.
 *
 *   (import "tsinter" "now" (func (result f64)))   [timer modules, and
 *                                                     perf.now modules]
 *     MONOTONIC milliseconds from an unspecified origin — the SAME clock
 *     `_tick`'s argument uses. Timers need a clock that never goes
 *     backwards, and this is that clock; `performance.now()` reads it too
 *     (widened, D3/P6 — the minting condition is now `timers.*` reachable
 *     OR `perf.now` reachable). NOT a wall clock: it says nothing about
 *     the date, and the difference between two readings is the only
 *     meaningful quantity — the origin is deliberately unspecified so a
 *     host may use whatever monotonic source it has (WASI 0.2's
 *     `monotonic-clock` is the same shape). The module reads it when it
 *     arms a timer or reads `performance.now()`, so every reader agrees
 *     on which clock this is.
 *
 *   (import "tsinter" "seed" (func (result i64)))   [Math.random modules only]
 *     ONE 64-bit value, read AT MOST ONCE per module instance, on the
 *     first `Math.random()` call. Present only in modules that reach
 *     `Math.random`. The module owns the generator: it seeds V8's
 *     xorshift128+ from this value (SEMANTICS.md S068) and every later
 *     draw is computed in-module, so the host is asked for entropy exactly
 *     once no matter how many numbers the program draws. THE HOST DECIDES
 *     WHAT RANDOMNESS MEANS HERE — a CSPRNG-backed host gets an
 *     unpredictable sequence, a fixed-value host gets a reproducible one
 *     (the `node --random-seed=N` contract). All 64 bits are used whole; a
 *     host returning a small nonnegative integer is legal.
 *     THIS IMPORT'S ENFORCEMENT SPLITS THREE WAYS, not the usual two —
 *     measured directly against the engine (WebAssembly.instantiate /
 *     WebAssembly.Module.imports):
 *       PRESENCE AND CALLABILITY — ENFORCED BY THE ENGINE, at
 *         instantiation, exactly like `write`/`now`: a missing or
 *         non-callable `seed` is a LinkError before a single instruction
 *         runs ("function import requires a callable").
 *       THE RESULT'S TYPE (an actual BigInt) — ALSO ENFORCED BY THE
 *         ENGINE, but LATER: not at instantiation (an i64-returning
 *         import is not type-checked against its declared signature until
 *         it is actually called), but at the FIRST DRAW. A host whose
 *         `seed` returns a `number` throws `TypeError: Cannot convert
 *         12345 to a BigInt` the moment `Math.random()` first calls it —
 *         `now`'s f64 result has no such backstop (§8.3's own text: a
 *         wrong-typed `now` runs to completion and prints different
 *         output with no error at all). This is the one place this ABI's
 *         usual two-tier split (engine-enforced shape vs. unenforced
 *         value) does not hold: `seed`'s KIND is engine-enforced, just not
 *         until first use, while `now`'s KIND is not enforced at all.
 *       THE VALUE ITSELF (origin, quality, range) — ENFORCED BY NOTHING,
 *         same as every other value contract in this file: a host may
 *         return whatever 64-bit pattern it likes, including one from a
 *         BigInt outside the signed i64 range some source produced by
 *         mistake — WebAssembly reduces any BigInt mod 2^64 silently (a
 *         measured example: 2**70n + 5n arrives in the module as 5n).
 *         Whether that pattern came from a CSPRNG or a predictable counter
 *         is the host's business, exactly as `now`'s origin is — the
 *         guarantee here is the same shape as `now`'s, but it covers only
 *         this VALUE tier, not the result-type tier above it.
 *
 *   (import "tsinter" "wallClock" (func (result f64)))   [Date.now / no-arg `new Date()` modules only]
 *     Milliseconds since the Unix epoch on the host's REAL-TIME clock, as
 *     an f64. Present only in modules that read `Date.now()` or construct
 *     a no-argument `new Date()`. MAY JUMP BACKWARDS: a real-time clock is
 *     subject to NTP steps, manual changes and daylight transitions, and
 *     nothing in the tier smooths that — a backwards step in the host is a
 *     backwards step in `Date.now()`, exactly Node. Code that needs
 *     elapsed time uses `now` below, never this.
 *     THE MODULE FLOORS TO INTEGER MILLISECONDS (a genuine floor, not a
 *     truncation — `-0.5` reads as `-1`, matching Node's own negative-time
 *     handling), so the observable granularity is the tier's and not the
 *     host's. A printed value from this clock cannot match any other
 *     process, so nothing in the differential compares one; the guarantee
 *     that this is the wall clock and not some other clock lives in THIS
 *     TEXT and in the host contract (D3, DECISIONS.md).
 *     ENFORCEMENT, measured directly against the engine (two independent
 *     hand-built-module runs agree — this pass's own CP1 §(g)/§3B-6 and
 *     rev-25's Phase A §7):
 *       PRESENCE AND CALLABILITY — ENFORCED BY THE ENGINE, at
 *         instantiation, before a single instruction runs — the SAME
 *         LinkError/TypeError shape `now`/`seed` already get:
 *         `LinkError: WebAssembly.instantiate(): Import #N "tsinter"
 *         "wallClock": function import requires a callable` (missing or
 *         non-callable) and `TypeError: WebAssembly.instantiate(): Import
 *         #N "tsinter": module is not an object or function` (namespace
 *         absent) or `TypeError: Imports argument must be present and must
 *         be an object` (the whole imports argument omitted). THE ENTRY
 *         POINT NAMES ITSELF IN THE TEXT — `WebAssembly.instantiate():`
 *         through the differential harness's own call shape, but
 *         `WebAssembly.Instance():` through `new WebAssembly.Instance`
 *         instead, for the identical failure — and "#N" is an INDEX that
 *         MOVES WITH THE MODULE'S OWN IMPORT LIST (this import is minted
 *         right after `seed`, C-1); quote either text as what it is, never
 *         as a fixed string with a hand-picked index.
 *       THE RESULT'S KIND — WEAKER than `seed`'s three-way split: a host
 *         returning a BigInt throws `TypeError: Cannot convert a BigInt
 *         value to a number` at the CALL (the one kind check an f64-typed
 *         import DOES get, at the WebAssembly JS-API boundary). EVERY
 *         OTHER JS value coerces SILENTLY via ordinary ToNumber: a numeric
 *         string ("1700000000000.75") produces OUTPUT IDENTICAL to a
 *         correct host — worse than "different output, no error", because
 *         on a numeric string there is no observable difference AT ALL;
 *         `null` -> 0; `undefined` / a non-numeric string / a valueOf-less
 *         object -> NaN; an object with `valueOf`/`toString` coerces
 *         through it, silently.
 *       THE VALUE ITSELF (origin, monotonicity, unit) — ENFORCED BY
 *         NOTHING: a backwards sequence is followed exactly, a host
 *         returning seconds instead of milliseconds runs silently, and
 *         `-Infinity` runs silently. The text IS the enforcement.
 *
 *   (import "tsinter" "random" (func (param i32 i32)))   [node:crypto randomness modules only]
 *     random(ptr, len): the host fills len bytes of linear memory at ptr
 *     with OS entropy and returns — an entropy READ, getrandom(2)'s
 *     shape: a native host calls getrandom / arc4random_buf, a browser
 *     crypto.getRandomValues, an engine its OS RNG. Present only in modules
 *     that reach crypto.randomUUID or crypto.randomBytes (with or without
 *     the composed .toString). The module asks for at most 4096 bytes per
 *     call (inside getRandomValues' 65536-byte cap) and copies them out
 *     before anything else touches the staging region. It is NOT `seed`:
 *     that is one PRNG seed per instance that a host may make reproducible
 *     (the `--random-seed` contract), which crypto's randomness, like
 *     Node's, never is. The bytes' quality is the host's business — the
 *     text is the enforcement (SEMANTICS.md S093).
 *
 *   (import "tsinter" "sleep" (func (param f64)))   [Atomics.wait modules only]
 *     sleep(ms): BLOCK the calling thread for ms milliseconds, then return
 *     — nanosleep(2)'s shape (a native host: nanosleep / Sleep, resumed
 *     across EINTR; a browser worker: Atomics.wait on a private
 *     SharedArrayBuffer; never a spin on a clock). The module's ONE
 *     synchronous wait: `Atomics.wait` whose element equals the expected
 *     value (no thread can ever notify, so the wait is a sleep that always
 *     times out). `ms` is >= 0 and may be +Infinity: Node then blocks
 *     forever, and so does a host that honours it (a host may instead end
 *     the program loudly — the harness hosts do, rather than hang a test).
 *     Afterwards the MONOTONIC clock (`now`) and the wall clock must both
 *     read at least ms later: a host whose clock is virtual advances it by
 *     at least ms (the harness: by max(ms, the time it really slept), the
 *     same accounting as cpCall RUN). Nothing runs while it sleeps — no
 *     timer, microtask or event is delivered, exactly Node's blocked main
 *     thread. Present only in modules that reach `Atomics.wait`.
 *
 *   (export "_start" (func))            — the program; run it once.
 *   (export "_tick" (func (param f64) (result f64)))  [timer modules only]
 *   (export "_loop" (func (param f64) (result f64)))  [event modules only,
 *                                                      INSTEAD of _tick]
 *   (export "_status" (func (result i32)))  [top-level-await modules only]
 *   (export "memory" (memory))          — where write's bytes live.
 *
 * THE EVENT LOOP. `_start` runs the program to its first checkpoint: the
 * synchronous body, the microtask drain, and the unhandled-rejection
 * report. If the module exports `_tick`, the host then PUMPS it — the
 * module has no clock of its own and cannot sleep, so the waiting is the
 * host's job:
 *
 *     let now = <clock>;
 *     for (;;) {
 *       const due = tick(now);
 *       if (due < 0) break;              // quiescent: the program is done
 *       now = Math.max(now, due);        // due === now ⇒ run again NOW
 *     }
 *
 * One `_tick(now)` call is one loop turn: drain microtasks, fire every
 * timer due at `now` (each followed by its own microtask drain), then run
 * the check phase (setImmediate). Its result is the next deadline — a
 * future time to wait for, `now` itself when ready work remains (pending
 * immediates), or a NEGATIVE value when nothing ref'd is left and the
 * program is over. `_tick` never answers +Infinity.
 *
 * EVENT MODULES (INC-28 U2: a module reaching cp.spawn or cp.spawnOpts;
 * INC-29 U1: a module reaching node:net I/O) export `_loop(now)`
 * instead, a transcription of libuv's
 * uv_run(UV_RUN_DEFAULT) — the loop Node runs — restricted to the phases
 * this tier has. Its FIRST call: if nothing ref'd is alive (timers,
 * immediates, children whose exit has not been delivered; in a net module,
 * open servers and sockets, lookups in flight and handles waiting in the
 * closing phase) the 'exit'
 * listeners run and it answers -1; otherwise it runs the due timers once
 * and answers as libuv computes a poll timeout — never -1 on this path.
 * Every LATER call is one loop iteration: the POLL phase (every queued
 * `evPoll` event, each followed by a microtask checkpoint), INC-29 U1 in a
 * net module up to eight PENDING passes while the pending queue is not
 * empty (libuv's uv__run_pending after uv__io_poll: a socket fed by
 * uv_shutdown completes its shutdown there, each completion a callback
 * followed by a checkpoint; a socket fed during a pass waits for the
 * next), the check phase (setImmediate), in a net module the CLOSING
 * phase (the close callbacks of handles closed since the last one, the
 * handle closed LAST first — uv__make_close_pending pushes onto the
 * list's head: a pending write's or shutdown's ECANCELED completion, then
 * the Socket's 'close' — libuv's uv__run_closing_handles), the timers
 * phase, then the liveness test (-1 when nothing ref'd is left, after the
 * 'exit' listeners), and then, the next iteration having begun, in a net
 * module one more pending pass (the uv__run_pending at the top of
 * uv_run's loop body, before the timeout is computed; the FIRST call runs
 * it too, after its timers pass). A loop with closing or pending work
 * left answers `now`. The answer is -1,
 * `now` itself (ready work: run again without waiting), a deadline, or
 * +Infinity (only children or net handles hold the loop: wait for an
 * event). The DUE
 * test reads the loop time the module took at libuv's update points
 * (the `now` argument after the host's wait, and a fresh `now` import
 * right before the timers phase); ARMING reads the `now` import at the
 * arming call, as in every module. The host's side of the contract:
 *
 *     start(); let due = loop(clock());
 *     for (;;) {
 *       if (due < 0) break;
 *       if (no child of this run is live) {
 *         if (due === Infinity) fail("module waits for an event no source can deliver");
 *         <advance the virtual clock to due>; due = loop(clock()); continue;
 *       }
 *       await <one host loop turn, resolved from the host's own check
 *              phase once an event is queued or clock() >= due>;
 *       due = loop(clock());
 *     }
 *
 * The host YIELDS to its own event loop before every call while a child
 * is live, so that a child which exited while the module ran is reaped
 * where libuv's poll would reap it, and a batch reaped together is queued
 * together; it never resumes from inside one of its own event listeners.
 * While any child is live (spawned, its EXIT not yet read by the module)
 * the host's clock is REAL time, synchronous module time included —
 * `now` and the wall clock are evaluated at each call — anchored to the
 * virtual clock at every moment the first child goes live again; with no
 * child live the clock is virtual as above. INC-29 U1: the same holds for
 * net handles — while any server, socket or lookup of the run is open on
 * the host the clock is real time, re-anchored when the first one opens
 * after none were, and the host's wait ends when an event is queued.
 * Enforced by NOTHING beyond the harness's own rows.
 *
 * A TRAP IS THE EXIT CODE — 1, always. A trap out of `_start` or `_tick`
 * is the program dying with exit 1: an uncaught exception, an unhandled
 * rejection, or a rejected top-level-await root (SEMANTICS.md S007, S010).
 * A normal return with a negative deadline is exit 0, UNLESS the module
 * exports `_status`:
 *
 *     let code = 0;
 *     try { start(); pump(); code = status?.() ?? 0; }
 *     catch (trap) { code = 1; }
 *
 * `_status()` exists ONLY in a module whose entry is an async module —
 * i.e. one using top-level await — and answers Node's status for the
 * module evaluation promise at QUIESCENCE: 13 when it is still pending
 * (Node's "unsettled top-level await" exit — SEMANTICS.md S012), 0 when
 * it settled. It is a pure read of that promise's state, so it is
 * only meaningful once the pump has returned a negative deadline; calling
 * it earlier answers about a program that is still running. A trap
 * overrides it: the program is already dead with exit 1, and a rejected
 * root traps rather than answering here.
 */

export const IMPORT_MODULE = "tsinter";
export const IMPORT_WRITE = "write";
export const IMPORT_NOW = "now";
export const IMPORT_SEED = "seed";
export const IMPORT_WALL_CLOCK = "wallClock";
export const IMPORT_HOST_STR = "hostStr";
export const IMPORT_HOST_NUM = "hostNum";
export const IMPORT_EXIT = "exit";
export const IMPORT_KILL = "kill";
export const IMPORT_CHDIR = "chdir";
export const IMPORT_UMASK = "umask";
export const IMPORT_FS_CALL = "fsCall";
export const IMPORT_CP_CALL = "cpCall";
export const IMPORT_EV_POLL = "evPoll";
export const IMPORT_NET_CALL = "netCall";
export const IMPORT_TLS_CALL = "tlsCall";
export const IMPORT_RANDOM = "random";
export const IMPORT_SLEEP = "sleep";
export const EXPORT_ENTRY = "_start";
export const EXPORT_TICK = "_tick";
export const EXPORT_LOOP = "_loop";
export const EXPORT_STATUS = "_status";
export const EXPORT_MEMORY = "memory";

export const FD_STDOUT = 1;
export const FD_STDERR = 2;

/* hostStr's KIND table (0..17) — see the import's own doc comment above.
 * Append-only: a later pass adds a new constant at the next integer, never
 * renumbers one of these. INC-26 P1 mints and consumes 0-4; 5-17 are later
 * passes', declared now so the table ships whole and once. */
export const HOST_STR_KIND_ARGV = 0;
export const HOST_STR_KIND_ENV_KEY = 1;
export const HOST_STR_KIND_ENV_VALUE = 2;
export const HOST_STR_KIND_CWD = 3;
export const HOST_STR_KIND_PLATFORM = 4;
export const HOST_STR_KIND_ARCH = 5;
export const HOST_STR_KIND_VERSIONS_NODE = 6;
export const HOST_STR_KIND_VERSIONS_OPENSSL = 7;
export const HOST_STR_KIND_OS_TMPDIR = 8;
export const HOST_STR_KIND_OS_HOMEDIR = 9;
export const HOST_STR_KIND_OS_TYPE = 10;
export const HOST_STR_KIND_OS_RELEASE = 11;
export const HOST_STR_KIND_EXEC_PATH = 12;
export const HOST_STR_KIND_OS_USERINFO_USERNAME = 13;
export const HOST_STR_KIND_OS_USERINFO_HOMEDIR = 14;
export const HOST_STR_KIND_OS_USERINFO_SHELL = 15;
export const HOST_STR_KIND_OS_NETWORK_INTERFACES_JSON = 16;
export const HOST_STR_KIND_ERRNO_TEXT = 17;

/* hostNum's KIND table (0..15) — same append-only stance. INC-26 P1 mints
 * and consumes 0-1; 2-15 are later passes'. */
export const HOST_NUM_KIND_ARGC = 0;
export const HOST_NUM_KIND_ENV_PAIR_COUNT = 1;
export const HOST_NUM_KIND_PID = 2;
export const HOST_NUM_KIND_UID = 3;
export const HOST_NUM_KIND_GID = 4;
export const HOST_NUM_KIND_IS_TTY = 5;
export const HOST_NUM_KIND_COLUMNS = 6;
export const HOST_NUM_KIND_UPTIME = 7;
export const HOST_NUM_KIND_CPU_USER = 8;
export const HOST_NUM_KIND_CPU_SYSTEM = 9;
export const HOST_NUM_KIND_THREAD_CPU_USER = 10;
export const HOST_NUM_KIND_THREAD_CPU_SYSTEM = 11;
export const HOST_NUM_KIND_AVAILABLE_MEMORY = 12;
export const HOST_NUM_KIND_CONSTRAINED_MEMORY = 13;
export const HOST_NUM_KIND_RUSAGE = 14;
export const HOST_NUM_KIND_OS_TOTALMEM = 15;
