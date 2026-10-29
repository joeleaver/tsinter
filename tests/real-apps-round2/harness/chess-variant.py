#!/usr/bin/env python3
"""chess-variant.py <skip,cats|none> : rebuild r2/apps/chess-v from chess.js 1.4.0 + round-1 patches,
skipping the named categories.  Categories:
 bigint      64-bit bigint Zobrist keys -> 32-bit numbers
 formulti    for (let i = 0, len = x; ...) -> single declarator
 sparse      new Array<Piece>(128) + delete -> dense (Piece|undefined)[]  (+ the bangs it forces)
 privbracket chess['_private'] bracket access to private methods
 tsgocrash   (x.match(re) || []).length
 throwbang   throw new Error(error!)   (error: string|undefined narrowed by control flow)
 compound    this._castling.w |= ... / ^= on Record fields
 inop        `k in obj` on records / Ox88
 untypedarr  const xs = [] (evolving any[]) -> annotated
 looseeq     == / == null
 pgnheaders  parsedPgn.headers / result casts (pgn.d.ts any-typed)
 typeofargs  typeof args[i] === 'string' on a rest-args array
 defparam    captured: PieceSymbol | undefined = undefined
 recundef    Record<string,string> read of missing key (comments)
 popguard    const x = arr.pop() on maybe-empty array
 pgn_in      pgn.js: `k in peg$startRuleFunctions`
 pgn_proto   pgn.js: peg$subclass / prototype assignments
"""
import re, sys, os, subprocess, shutil

R = "/tmp/claude-1000/-home-joe-dev-tsinter/99673c80-6e33-4286-ab74-008bff1817c4/scratchpad/r2/apps"
W = "/home/joe/dev/tsinter/.claude/worktrees/agent-a16bf40c249d36838"
NODE = os.path.expanduser("~/.nvm/versions/node/v24.18.1/bin/node")
skip = set() if sys.argv[1] == "none" else set(sys.argv[1].split(","))
dst = sys.argv[2] if len(sys.argv) > 2 else "chess-v"
on = lambda c: c not in skip

os.makedirs(f"{R}/{dst}/src", exist_ok=True)
for f in ["main.ts", "bench.pgn", "package.json", "tsconfig.json"]:
    shutil.copy(f"{R}/chess/{f}", f"{R}/{dst}/{f}")
shutil.copy(f"{R}/chess/src/node.ts", f"{R}/{dst}/src/node.ts")

src = open(f"{R}/chess/src/chess.ts").read()
lines = src.split("\n")
if on("bigint"):
    head = open(f"{R}/chess/nobigint-head.ts").read()
    s = "\n".join(lines[:29]) + "\n" + head + "\n".join(lines[58:])
    s = re.sub(r"\b0n\b", "0", s); s = re.sub(r"\bbigint\b", "number", s)
else:
    s = src
log = []


def rep(cat, old, new, count=None):
    global s
    if not on(cat): return
    n = s.count(old)
    if n == 0: log.append(f"MISSING {cat} {old[:50]!r}")
    s = s.replace(old, new)


def sub(cat, pat, fn):
    global s
    if not on(cat): return
    s, k = re.subn(pat, fn, s)
    if k == 0: log.append(f"MISSING {cat} {pat[:50]}")

# patch 1
sub("formulti", r"for \(let (\w+) = 0, len = ([^;]+); \1 < len;", lambda m: f"for (let {m.group(1)} = 0; {m.group(1)} < {m.group(2)};")
rep("sparse", "private _board = new Array<Piece>(128)", "private _board: (Piece | undefined)[] = emptyBoard()")
rep("sparse", "this._board = new Array<Piece>(128)", "this._board = emptyBoard()")
rep("sparse", "delete this._board[sq]", "this._board[sq] = undefined")
rep("sparse", "delete this._board[from]", "this._board[from] = undefined")
rep("sparse", "export class Chess {", "function emptyBoard(): (Piece | undefined)[] {\n  const b: (Piece | undefined)[] = []\n  for (let i = 0; i < 128; i++) b.push(undefined)\n  return b\n}\n\nexport class Chess {")
for m in ["_moveToSan", "_moves", "_makeMove", "_undoMove"]:
    rep("privbracket", f"chess['{m}']", f"chess.{m}")
    sub("privbracket", rf"\n  private {m}\(", lambda mm, m=m: f"\n  {m}(")
rep("tsgocrash", "if ((tokens[0].match(regex) || []).length > 1) {", "const kingMatches = tokens[0].match(regex)\n    if (kingMatches !== null && kingMatches.length > 1) {")
# patch 3
rep("throwbang", "        throw new Error(error)", "        throw new Error(error!)")
sub("compound", r"(this\._castling(?:\.\w|\[\w+\])) ([&|^])= (.+)", lambda m: f"{m.group(1)} = {m.group(1)} {m.group(2)} ({m.group(3)})")
rep("inop", "if (!(square in Ox88)) {", "if (Ox88[square as Square] === undefined) {")
rep("inop", "if (!(forSquare in Ox88)) {", "if (Ox88[forSquare as Square] === undefined) {")
rep("inop", "if (square in Ox88) {", "if (Ox88[square] !== undefined) {")
rep("inop", "pieces[piece.type] = piece.type in pieces ? pieces[piece.type] + 1 : 1", "pieces[piece.type] = (pieces[piece.type] ?? 0) + 1")
rep("untypedarr", "    const legalMoves = []\n", "    const legalMoves: InternalMove[] = []\n")
rep("untypedarr", "    const reversedHistory = []\n    while", "    const reversedHistory: (InternalMove | null)[] = []\n    while")
rep("untypedarr", "    const moves = []\n    let moveString = ''", "    const moves: string[] = []\n    let moveString = ''")
rep("looseeq", "promotion.toLowerCase() == moves[i].promotion", "promotion.toLowerCase() === moves[i].promotion")
rep("looseeq", "if (this._board[i] == null) {", "if (this._board[i] === undefined) {")
rep("untypedarr", "    const output = []\n    let row = []", "    const output: ({ square: Square; type: PieceSymbol; color: Color } | null)[][] = []\n    let row: ({ square: Square; type: PieceSymbol; color: Color } | null)[] = []")
rep("untypedarr", "    const reversedHistory = []\n    const moveHistory = []", "    const reversedHistory: (InternalMove | null)[] = []\n    const moveHistory: (Move | string)[] = []")
rep("untypedarr", "    const reversedHistory = []\n    const currentComments", "    const reversedHistory: (InternalMove | null)[] = []\n    const currentComments")
# patch 4
rep("pgnheaders", "    const headers = parsedPgn.headers\n", "    const headers = parsedPgn.headers as Record<string, string>\n")
rep("pgnheaders", "    const result = parsedPgn.result\n", "    const result = parsedPgn.result as string | undefined\n")
rep("typeofargs", "if (typeof args[i] === 'string' && typeof args[i + 1] === 'string') {", "if (i + 1 < args.length) {")
rep("inop", "if (!('FEN' in headers)) {", "if (headers['FEN'] === undefined) {")
rep("defparam", "  captured: PieceSymbol | undefined = undefined,\n", "  captured?: PieceSymbol,\n")
rep("recundef", "  private _comments: Record<string, string> = {}\n", "  private _comments: Record<string, string | undefined> = {}\n")
rep("recundef", "    const currentComments: Record<string, string> = {}\n", "    const currentComments: Record<string, string | undefined> = {}\n")
rep("recundef", "    return this._comments[this.fen()]\n", "    return this._comments[this.fen()]!\n")
rep("recundef", "    delete this._comments[this.fen()]\n    return comment\n", "    delete this._comments[this.fen()]\n    return comment!\n")
rep("recundef", "      return { fen: fen, comment: this._comments[fen] }\n", "      return { fen: fen, comment: this._comments[fen]! }\n")
rep("recundef", "      return { fen: fen, comment: comment }\n", "      return { fen: fen, comment: comment! }\n")
sub("popguard", r"const (\w+) = ([\w.]+)\.pop\(\)\n", lambda m: f"const {m.group(1)} = {m.group(2)}.length > 0 ? {m.group(2)}.pop() : undefined\n")
open(f"{R}/{dst}/src/chess.ts", "w").write(s)

# pgn.js
p = open(f"{R}/chess/src/pgn.js").read()
def prep(cat, old, new):
    global p
    if not on(cat): return
    if p.count(old) == 0: log.append(f"MISSING {cat} {old[:50]!r}")
    p = p.replace(old, new)
prep("pgn_in", 'if (!(options.startRule in peg$startRuleFunctions)) {', 'if (peg$startRuleFunctions[options.startRule] === undefined) {')
prep("pgn_proto", '\npeg$subclass(peg$SyntaxError, Error);', '\n// peg$subclass(peg$SyntaxError, Error) removed')
prep("pgn_proto", 'peg$SyntaxError.prototype.format = function(sources) {', 'const peg$SyntaxError_format = function(sources) {')
prep("pgn_proto", 'peg$SyntaxError.buildMessage = function(expected, found) {', 'const peg$SyntaxError_buildMessage = function(expected, found) {')
prep("pgn_proto", '      peg$SyntaxError.buildMessage(expected, found),', '      peg$SyntaxError_buildMessage(expected, found),')
open(f"{R}/{dst}/src/pgn.js", "w").write(p)
d = open(f"{R}/chess/src/pgn.d.ts").read().replace('import("./node")', 'import("./node.js")')
open(f"{R}/{dst}/src/pgn.d.ts", "w").write(d)

# sparse forces bangs where tsc now sees (Piece|undefined)
if on("sparse"):
    r = subprocess.run([NODE, W + "/node_modules/typescript/bin/tsc", "--noEmit", "--strict", "--target", "es2022", "--module", "nodenext",
                        "--moduleResolution", "nodenext", "--allowImportingTsExtensions", "--allowJs", "--types", "node",
                        "--typeRoots", W + "/node_modules/@types", "main.ts"], capture_output=True, text=True, cwd=f"{R}/{dst}")
    L = s.split("\n"); fixed = set()
    for m in re.finditer(r"src/chess\.ts\((\d+),(\d+)\): error (TS\d+): (.*)", r.stdout):
        ln = int(m.group(1)) - 1
        if ln in fixed: continue
        fixed.add(ln)
        x = re.sub(r"this\._board\[([^\]]+)\](?=\.|\s*$)", r"this._board[\1]!", L[ln])
        if "'piece' is possibly" in m.group(4): x = re.sub(r"\bpiece\.", "piece!.", x)
        L[ln] = x
    s = "\n".join(L)
    open(f"{R}/{dst}/src/chess.ts", "w").write(s)
    log.append(f"sparse-bangs {len(fixed)}")
print("skip:", sorted(skip), " | ".join(log))
