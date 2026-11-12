"""Refused-construct families: generalizes tests/real-apps-round2/harness/idioms.py to the survey's messages.
classify(code, message, shape) -> family id, or None for a cascade (a site that only repeats a blocker
reported elsewhere). Order matters: first match wins, specific before general. Shapes are anonymized source
(see worker.mjs shapeOf), so `_._ = function` means `a.b = function`."""
import re

CASCADE = re.compile(r"inherit the blocker|whose class has no lowering|the class declaration itself was rejected|declaration was rejected")
DEP_EDGE = re.compile(r"^importing '[^']+' requires the embedded dynamic engine|^values from the '[^']+' package run")

NODE_BUILTINS = set("""assert async_hooks buffer child_process cluster console constants crypto dgram diagnostics_channel dns domain events fs http
http2 https inspector module net os path perf_hooks process punycode querystring readline repl sqlite stream string_decoder sys test timers tls
trace_events tty url util v8 vm wasi worker_threads zlib""".split())

# id, title, predicate(message, shape, code)
RULES = [
    ("ice", "internal compiler error (SC9001)", lambda m, s, c: c == "SC9001"),
    ("wasm:backend", "lowered, then refused by the WasmGC emitter (SC3001; seen only on the first entry of each package)", lambda m, s, c: c == "SC3001"),
    ("tsgo:panic", "typescript-go checker panic (SC0004)", lambda m, s, c: c == "SC0004"),
    ("tsc:missing-dep", "unresolved import (dependency or generated file absent; survey artifact, not a language gap)",
     lambda m, s, c: "imports-field" in m or "nothing installed resolves it" in m or "runtime resolution fails" in m or c == "SC0001" and re.search(r"Cannot find module|Could not find a declaration|cannot find module|Cannot find type definition|has no exported member|implicitly has an 'any' type.*module|Invalid module name in augmentation", m)),
    ("tsc:dom", "browser globals: no DOM lib (document, window, HTMLElement, fetch types)",
     lambda m, s, c: c == "SC0001" and re.search(r"Cannot find (name|namespace) '(document|window|navigator|localStorage|sessionStorage|location|history|self|alert|confirm|prompt|"
                                                 r"requestAnimationFrame|cancelAnimationFrame|requestIdleCallback|getComputedStyle|matchMedia|customElements|"
                                                 r"(HTML|SVG|CSS|DOM|Dom|Mouse|Keyboard|Touch|Pointer|Wheel|Focus|Input|Drag|Clipboard|Media|Mutation|Resize|Intersection|"
                                                 r"Animation|Canvas|File|Event|Node|Element|Window|Document|Shadow|Text|Range|Selection|Image|Audio|Video|Worker|"
                                                 r"Headers|Body|Request|Response|Location|History|Navigator|Storage|IDB|Web|RTC|XML|Child|Blob|FormData|Abort|"
                                                 r"ClipboardItem|Gamepad|Screen|Performance|Notification|ServiceWorker|Broadcast|Message|Port|Cache|Crypto)\w*)'", m)),
    ("tsc:jsx", "JSX / React types (no JSX config is adopted)", lambda m, s, c: c == "SC0001" and re.search(r"JSX|--jsx|React", m)),
    ("tsc:ambient", "name not found: usually an ambient .d.ts the tsconfig includes, which tsinter does not load unless imported, or a missing @types",
     lambda m, s, c: c == "SC0001" and re.search(r"Cannot find name|Cannot find namespace|refers to a value", m)),
    ("tsc:knock-on", "type errors downstream of an unresolved import or lost ambient types (implicit any, missing property, assignability)",
     lambda m, s, c: c == "SC0001"),
    ("cfg:strict-off", "tsconfig disables strictNullChecks (SC0002)", lambda m, s, c: c == "SC0002"),
    # Before bigint/types rules: the message names the copied type ("a 'bigint[]' value converted ...").
    ("dyn:copy", "observable copies at the typed/dynamic boundary (SEMANTICS.md S125 (c) / S115 (d)): a value checked into a typed slot, "
     "converted to dynamic, or a function crossing, where JavaScript would share the object",
     lambda m, s, c: re.search(r"would (be|hold) a COPY where JavaScript shares the object", m)),
    ("bigint", "bigint", lambda m, s, c: re.search(r"\bbigint\b|BigIntLiteral|BigInt\b", m)),
    ("es5:proto", "ES5 constructors and prototype wiring: X.prototype.m = fn, new on a function, Object.create, setPrototypeOf, props on function objects",
     lambda m, s, c: ("assignment to non-variables" in m and re.search(r"\.prototype\b|^_\._ = function|^_\._ = \(|^_ = function", s))
     or re.search(r"constructing values other than classes declared|^constructing '|setPrototypeOf|\.prototype'|Object\.create|'prototype'", m)),
    ("fn:call-bind", "Function.prototype.call/apply/bind and `arguments` on compiled functions",
     lambda m, s, c: re.search(r"Function\.prototype\.(call|bind|apply)|'arguments'|bound method references|\.(call|apply|bind)' on|method references", m)),
    ("bundler:interop", "bundler output: createRequire banners (node:module), __toESM interop helpers",
     lambda m, s, c: re.search(r"__toESM|bundler|imports node:module", m)),
    ("module:cycle", "import cycles (SC1016) and require() below code that reaches its binding (SC1013)",
     lambda m, s, c: c == "SC1016" or (c == "SC1013" and "require() below" in m)),
    ("esm-in-cjs", "ES module syntax in a .ts/.js file Node would load as CommonJS (package has no \"type\": \"module\")",
     lambda m, s, c: "ES module syntax in a file Node loads as CommonJS" in m),
    ("module:default", "default exports and default imports (SC1012)", lambda m, s, c: "default exports/imports" in m),
    ("module:form", "module forms: require() of JSON, default/namespace import forms, re-exports from packages, export = / import = require",
     lambda m, s, c: c in ("SC1012", "SC1013", "SC1014", "SC1015") or re.search(r"assignments \(use named ESM exports|export = |import = require", m)),
    ("cjs:shape", "CommonJS shapes: module.exports = <non-literal>, exports aliasing, members attached before reassign, table entries beyond name: value",
     lambda m, s, c: re.search(r"module\.exports|'exports'|export members attached|exports table|assignment to 'exports'", m)),
    ("cjs:require", "require() off top level, computed, or as a value; createRequire; import.meta",
     lambda m, s, c: re.search(r"require\(\)|'require'|createRequire|circular|import\.meta|cycle|CJS module globals", m)),
    ("dep-edge", "import of an npm package that is not compiled statically",
     lambda m, s, c: c == "SC1010" and (mm := re.match(r"the '([^']+)' module", m)) and mm.group(1).replace("node:", "").split("/")[0] not in NODE_BUILTINS),
    ("module:builtin", "Node builtin module with no support (SC1010, node:* import fences)",
     lambda m, s, c: c == "SC1010"),
    ("global:sniff", "reads or typeof of undeclared globals (UMD define/module/self/window, build flags like ngDevMode, devtools hooks)",
     lambda m, s, c: re.search(r"binding form with no lowering", m) and re.search(r"'(define|self|window|module|exports|global|globalThis|root|document|navigator|location|FileReader|Deno|Bun|WorkerGlobalScope|ngDevMode|ngServerMode|ngI18nClosureMode|Zone|__\w+__|__DEV__|Ember|jQuery|\$)'", m)),
    ("var:hoist", "`var` read inside a hoisted function declared above it (generated parsers, bundles)",
     lambda m, s, c: re.search(r"above its 'var' declaration", m)),
    ("binding:blocked", "reference to a binding whose declaration was refused or has no lowering (mostly knock-on sites)",
     lambda m, s, c: re.search(r"binding form with no lowering", m)),
    ("op:any", "operators on any-typed values (|, >>>, ===, +=, comparisons), loose equality, truthiness coercions",
     lambda m, s, c: re.search(r"operator on 'any'-typed|operators on '|comparisons of union|switch case tests of|comparing non-number, non-string|loose equality|arithmetic on|values where 'boolean' is expected|logical operators on", m)),
    ("decorator", "decorators (field, method, and generic class decorators)", lambda m, s, c: re.search(r"decorators", m)),
    ("types:narrow", "narrowing forms: hand-written type predicates, ?? that changes the result type, tuple/string index shapes",
     lambda m, s, c: re.search(r"hand-written type predicate|where the default changes the result type|tuple indexing|string indexing with this|non-nullish result is a sub-union", m)),
    ("destructure", "destructuring beyond typed record sources: absent fields, optional patterns, rest over dynamic values, catch bindings",
     lambda m, s, c: re.search(r"destructuring|rest elements over|optional destructuring", m) and "builtin" not in m),
    ("error:shape", "Error specifics: constructor options (cause), overriding Error methods, non-Error throws read as Error",
     lambda m, s, c: c in ("SC1062", "SC1063") or re.search(r"Error constructor options|builtin Error method|only the Error classes answer|on Error receivers|catch binding|catch-binding", m)),
    ("generator", "async generators, generator methods, for-await beyond streams, .next(value)",
     lambda m, s, c: c in ("SC1070", "SC1071") or re.search(r"generator", m) and "generic" not in m),
    ("generic:fn", "generic methods and arrows in forms with no monomorphized home",
     lambda m, s, c: re.search(r"generic method|generic arrow|generic function", m)),
    ("export:mutable", "exporting a mutable binding by reference (live bindings)", lambda m, s, c: "exporting the mutable" in m),
    ("spread", "spreads beyond same-shape arrays and one-property conditional object spreads",
     lambda m, s, c: re.search(r"conditional spreads|spreading '|spreading ", m)),
    ("ts-emit:enum", "compiled TypeScript enums in shipped JS: E[E[\"A\"] = 0] = \"A\"",
     lambda m, s, c: s.startswith('_[_[""] =') or s.startswith('_[_._ = ')),
    ("cjs:shape", "CommonJS shapes: writes to exports.x / module.exports.x / exports[k]",
     lambda m, s, c: re.match(r"(module\.)?exports\b", s) and re.search(r"assignment to non-|dynamic keyed writes", m)),
    ("write:untyped", "writes through untyped or nested receivers: o.a.b = v, o[k] = v, o.n++, compound on member chains",
     lambda m, s, c: re.search(r"^assignment to non-variables|assignment to non-array elements|dynamic keyed writes|increment/decrement of|^assignment to '|on non-variable targets|logical assignment|compound assignment to unsupported|compound assignment to fields of computed|compound array-element|indexing records with non-string|indexing with non-number keys|fields assigned outside", m)),
    ("in:computed", "`in` / hasOwnProperty with computed keys, dyn.hasKey",
     lambda m, s, c: re.search(r"'in' with computed|'in' over index-signature|dyn\.hasKey", m)),
    ("fn:value", "functions as values: optional/defaulted params, overloads, generics kept open",
     lambda m, s, c: re.search(r"optional or defaulted parameters as values|multiple call signatures|keeps its type parameters|generic functions as values|selecting an overload|generic method '[^']*' with no defining|passing '.*' function values", m)),
    ("builtin:value", "builtin globals, Math or string methods as values (#84)",
     lambda m, s, c: re.search(r"builtin '[^']*' used as a value|Math methods as values|string methods as values|destructuring the member", m)),
    ("date", "Date values", lambda m, s, c: re.search(r"'new Date'|Date values|extending classes not declared|instanceof' right-hand sides other than classes", m)),
    ("types:shape", "types with no static representation: unions with fields, intersections, recursive records, any-typed members",
     lambda m, s, c: c in ("SC2001", "SC2002", "SC2003", "SC2005", "SC2006", "SC2007", "SC2008", "SC2009", "SC2011") or re.search(r"intersection resolves to no runtime shape|have no static representation|record shape is supported, but|union shape is supported, but|function shape is supported|reading '[^']*' on a union-typed|'\?\.' on|'unknown'-typed class fields|union types must match|record shapes must match|mapped|conditional type", m)),
    ("generic:class", "generic class hierarchies", lambda m, s, c: re.search(r"extending the generic class|extending generic classes|generic classes whose 'extends'|overriding the inherited generic method", m)),
    ("stdlib:node", "Node API member with no lowering (path.parse, process.*, fs.*, stream.*)",
     lambda m, s, c: re.search(r"typed by @types/node", m)),
    ("stdlib:js", "ECMAScript stdlib member with no lowering (reverse, splice/3, substr, toString(radix), Object.assign, new Set(iter), ...)",
     lambda m, s, c: re.search(r"part of the standard library types but has no scriptc lowering|runs in the embedded dynamic engine|'\.split\(\)' on a|replacement value of this type|Set elements of type|no lowering yet", m)),
    ("closure:capture", "bindings captured through a plain nested function with no static storage",
     lambda m, s, c: re.search(r"captured through a plain nested function", m)),
    ("class:local", "classes declared inside functions, class expressions, mixins",
     lambda m, s, c: re.search(r"class expressions inside functions|class declarations inside functions|classes as values|class values", m)),
    ("class:dyn", "class objects used dynamically: statics via a class value, extending builtins as values",
     lambda m, s, c: re.search(r"through a class value|extending builtin bases|classes extending builtin|'super'|getter|setter|accessor|extending computed|-typed static fields|overriding a method|computed method names|in static methods|in object literal methods", m) and "computed-key" not in m),
    ("obj:computed", "runtime-keyed (computed-key) object literals holding methods, spreads, or non-scalar values",
     lambda m, s, c: re.search(r"computed-key|runtime-keyed|computed (property|member|key)", m)),
    ("module:ns", "module namespace objects as values; library functions as values",
     lambda m, s, c: re.search(r"namespace objects as values|namespace imports|library functions as values", m)),
    ("expr:assign", "assignments and side effects in expression position (x op= e as a value, void effectful, comma forms)",
     lambda m, s, c: re.search(r"compound assignment as an expression|with an effectful operand|assignment as an expression|assignment expressions|comma", m)),
    ("symbol", "symbol-keyed access outside class fields", lambda m, s, c: re.search(r"symbol-keyed|[Ss]ymbol", m)),
    ("container:elem", "Map/Set/array element types outside the supported kinds",
     lambda m, s, c: re.search(r"Map keys of type|Map values of type|Set elements|WeakMap|WeakSet", m)),
    ("call:arity", "calls omitting required parameters, optional-chaining on unusual values, delete",
     lambda m, s, c: re.search(r"calls omitting|optional chaining on|delete expressions", m)),
    ("dyn:receiver", "method calls, member reads, for-in, switch, spread on any/unknown receivers",
     lambda m, s, c: re.search(r"method calls like|reading '[^']*' from a value of type|element access on non-array|for-in over|switch statements on|converting typed values to 'unknown'|spread elements|spread arguments|object spread|string conversions of unions|checked-dynamic|dynamic \(unknown|dynamic keyed reads|checked cast|instanceof '[^']*' on 'unknown'|Error messages of type|statically-decided Array\.isArray|'delete' on|values where '[^']*' is expected", m)),
    ("syntax", "other syntax forms the frontend names as unsupported", lambda m, s, c: re.search(r"^syntax ", m)),
    ("typeof:static", "typeof on statically typed values", lambda m, s, c: re.search(r"typeof expressions on statically", m)),
    ("for:multi", "multi-declarator `for (let i = 0, n = ...)`", lambda m, s, c: "multi-declaration for-loop" in m),
    ("dyn:import", "dynamic import()", lambda m, s, c: "import()" in m),
]
TITLES = {}
for _r in RULES:
    TITLES.setdefault(_r[0], _r[1])  # a family split over several rules keeps its first title
TITLES["other"] = "uncategorized"


def classify(code, m, s):
    if CASCADE.search(m):
        return None
    if DEP_EDGE.search(m):
        return "dep-edge"
    for fid, _t, fn in RULES:
        if fn(m, s, code):
            return fid
    return "other"
