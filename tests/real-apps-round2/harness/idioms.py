#!/usr/bin/env python3
"""Group every reached ROOT refusal site (compile diagnostics + deferred runtime fences, cascades dropped)
of the unpatched apps into idiom families; rank by #apps then #sites."""
import json, re, os, collections
D = "/tmp/claude-1000/-home-joe-dev-tsinter/99673c80-6e33-4286-ab74-008bff1817c4/scratchpad/r2/res/sites"
APPS = {"chess.js": ["chess", "chess-patched"], "smol-toml": ["toml"], "papaparse": ["papa"], "polka": ["polka"], "expr-eval": ["expr"],
        "marked(src)": ["marked"], "marked(npm)": ["markedlib"], "jsdiff": ["diff"], "semver": ["semver"]}
CASCADE = re.compile(r"inherit the blocker|whose class has no lowering|the class declaration itself was rejected")
RULES = [
    ("bigint", lambda m, s: re.search(r"bigint|BigIntLiteral|cannot be compiled yet", m)),
    ("ES5 constructor functions / prototype wiring / props on function objects", lambda m, s: ("assignment to non-variables" in m and re.search(r"\.prototype\b|^\w+\.\w+\s*=\s*function|^marked\.\w+\s*=|^\w+\.(options|getDefaults|defaults|setOptions|use|walkTokens|parseInline|parser|lexer|Parser|Lexer|Renderer|TextRenderer|Tokenizer|Hooks)\s*=", s))
     or "constructing values other than classes declared" in m or "setPrototypeOf" in m or "'(config: any) => void.prototype'" in m),
    ("Function.prototype.call/bind/apply and `arguments` on compiled functions", lambda m, s: re.search(r"Function\.prototype\.(call|bind|apply)|'arguments' in functions|bound method references", m)),
    ("CommonJS shapes: module.exports = <non-literal>, require() below use (cycle idiom), require() off top level, exports aliasing", lambda m, s: re.search(r"module\.exports =|require\(\) below|require\(\) with bindings outside|assignment to 'exports'|createRequire", m) or (re.search(r"binding form with no lowering", m) and not re.search(r"'(define|self|window|module|exports|FileReader|PAPA_BROWSER_CONTEXT)'", m))),
    ("typeof/feature-sniffing of undeclared globals (UMD: define, module, exports, self, window, FileReader)", lambda m, s: re.search(r"binding form with no lowering", m) and re.search(r"'(define|self|window|module|exports|FileReader|PAPA_BROWSER_CONTEXT)'", m)),
    ("`var` read in a hoisted function declared above the var (generated parsers)", lambda m, s: "above its 'var' declaration" in m),
    ("operators on any-typed values (|, >>>, ===, +=, x-- > 0, comparisons) in JS", lambda m, s: re.search(r"operator on 'any'-typed|comparing non-number, non-string", m)),
    ("writes/updates through untyped or nested receivers (o.a.b = v, o[k] = v, o.n++, this.a.b |= v)", lambda m, s: re.search(r"^assignment to non-variables|assignment to non-array elements|dynamic keyed writes|increment/decrement of|compound assignment to fields of computed|compound array-element|indexing records with non-string|indexing with non-number keys", m)),
    ("`in` / hasOwnProperty with computed keys", lambda m, s: re.search(r"'in' with computed|'in' over index-signature|dyn\.hasKey|hasOwnProperty", m + s) and "method calls like" not in m or "hasOwnProperty" in s and "method calls like" in m),
    ("untyped `const xs = []` (TS evolving array) inferred as number[]", lambda m, s: re.search(r"expected 'number', got '\{|'string' values where 'number' is expected|expected '\{ lines", m) and re.search(r"push|hunks|\bmoves\b|legalMoves|output|row|reversedHistory|ret\.push|=\s*\[\]", s)),
    ("types with no static representation: option bags (fn|record unions, A & B intersections, Partial<>), any-typed members, recursive Record<string, unknown>", lambda m, s: re.search(r"intersection resolves to no runtime shape|have no static representation|record shape is supported, but its member|union shape is supported, but its arm|function shape is supported|reading '[^']*' on a union-typed|'\?\.' on|logical operators on union", m)),
    ("generic class hierarchies (subclassing a generic base, overriding inherited generic methods)", lambda m, s: re.search(r"extending the generic class|generic classes whose 'extends'|overriding the inherited generic method", m)),
    ("overloads / generic functions as values", lambda m, s: re.search(r"multiple call signatures|keeps its type parameters|generic functions as values|selecting an overload|generic method '[^']*' with no defining|functions with optional or defaulted parameters as values", m)),
    ("builtin globals / Math methods / string methods as values (#84)", lambda m, s: re.search(r"builtin '[^']*' used as a value|Math methods as values|string methods as values|destructuring the member", m)),
    ("Date values (new Date, extends Date, instanceof Date)", lambda m, s: re.search(r"'new Date'|extending classes not declared|instanceof' right-hand sides other than classes", m)),
    ("stdlib members with no lowering (reverse, splice/3, split limit, substr, toString(radix), JSON.stringify replacer, Set<any>, defineProperty, fromEntries, flat, parseFloat/isFinite on any, globalThis, RegExp(dynamic))", lambda m, s: re.search(r"part of the standard library types but has no scriptc lowering|runs in the embedded dynamic engine|'\.split\(\)' on a|replacement value of this type|Set elements of type", m) and not re.search(r"'new Date'|operator on 'any'|values of type|import\(\)", m)),
    ("method calls / member reads on any/unknown receivers in JS", lambda m, s: re.search(r"method calls like|reading '[^']*' from a value of type|element access on non-array|for-in over|switch statements on|converting typed values to 'unknown'|spread elements in a dynamic|spread arguments|object spread of 'any'|string conversions of unions|instanceof [^']*' on 'unknown'|Error messages of type|statically-decided Array.isArray|'delete' on|values where '[^']*' is expected|record shapes must match|union types must match", m)),
    ("multi-declarator `for (let i = 0, n = …)`", lambda m, s: "multi-declaration for-loop" in m),
    ("RegExp-valued computed-key object literals (minified marked)", lambda m, s: re.search(r"runtime-keyed \(computed-key\) object literal|'unknown'-typed class fields|passing '.*' function values into 'unknown'", m)),
    ("dynamic import()", lambda m, s: "import()" in m),
    ("typeof on statically typed values / loose ==", lambda m, s: re.search(r"typeof expressions on statically|loose equality", m)),
    ("fields assigned outside the constructor's top level", lambda m, s: "fields assigned outside" in m),
]
groups = collections.defaultdict(lambda: collections.Counter())
samples = collections.defaultdict(list)
unmatched = collections.Counter()
for app, files in APPS.items():
    seen = set()
    for f in files:
        for x in json.load(open(f"{D}/{f}.json")):
            if CASCADE.search(x["message"]): continue
            if x["message"].startswith("method calls like") and (os.path.basename(x["file"]).startswith("main.") or re.search(r"\b(characterDiff|wordDiff|lineDiff|wordsWithSpaceDiff|sentenceDiff|cssDiff|jsonDiff|arrayDiff)\.", x["message"])): continue
            key = (x["file"], x["line"], x["col"], x["message"])
            if key in seen: continue
            seen.add(key)
            m, s = x["message"], x["src"]
            for name, fn in RULES:
                if fn(m, s):
                    groups[name][app] += 1
                    if len(samples[name]) < 3: samples[name].append(f"{os.path.basename(x['file'])}:{x['line']} {s[:90]}")
                    break
            else:
                unmatched[re.sub(r"'[^']*'", "_", m)[:120]] += 1
rank = sorted(groups.items(), key=lambda kv: (-len(kv[1]), -sum(kv[1].values())))
for i, (name, c) in enumerate(rank, 1):
    print(f"{i:2d}. [{len(c)} apps, {sum(c.values())} sites] {name}\n     {dict(c.most_common())}")
    for sm in samples[name]: print(f"       e.g. {sm}")
print("\nUNMATCHED:")
for k, n in unmatched.most_common(): print(f"  {n:3d} {k}")
