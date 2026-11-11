## headline
| metric | base | u1b | u2 |
|---|---|---|---|
| with result | 73 | 73 | 73 |
| compileOk (wasm build of first entry) | 52 | 48 | 48 |
| clean | 1 | 1 | 1 |
| deferred-only | 46 | 38 | 38 |
| blocked | 26 | 34 | 34 |
| dep-unavailable | 0 | 0 | 0 |
| no-result | 0 | 0 | 0 |
| partial | 3 | 1 | 1 |
| budget-skipped entries | 38 | 38 | 38 |
| timeouts | 1 | 1 | 1 |
| analyzer crashes | 4 | 0 | 0 |
| complete-analysis population | 70 | 72 | 72 |
| loads (no hard, no init site; ENV ignored) | 3 | 2 | 2 |
| build passes (no hard site; ENV ignored) | 46 | 39 | 39 |
| clean files (per-file units w/o site) | 313 | 320 | 320 |
| per-file units | 2504 | 2544 | 2544 |
| total sites (families) | 30044 | 31849 | 31849 |
| SC9001 sites | 156 | 0 | 0 |
| SC3001 sites | 1 | 0 | 0 |

## families: packages (sites)
| family | base pkgs/hard/init (sites) | u1b pkgs/hard/init (sites) | u2 pkgs/hard/init (sites) | Δpkgs | Δsites |
|---|---|---|---|---|---|
| `stdlib:js` | 56/1/35 (2058) | 55/1/35 (1890) | 55/1/35 (1890) | -1 | -168 |
| `dyn:receiver` | 55/1/13 (3554) | 55/1/13 (3476) | 55/2/14 (3477) | +0 | -77 |
| `binding:blocked` | 52/0/37 (1697) | 52/1/37 (1676) | 52/1/37 (1676) | +0 | -21 |
| `write:untyped` | 48/5/26 (2650) | 48/5/26 (2652) | 48/5/26 (2652) | +0 | +2 |
| `cjs:require` | 47/0/34 (710) | 47/0/34 (711) | 47/0/34 (711) | +0 | +1 |
| `cjs:shape` | 46/0/36 (991) | 46/0/36 (994) | 46/0/36 (994) | +0 | +3 |
| `dep-edge` | 41/16/30 (1398) | 41/16/30 (929) | 41/16/30 (929) | +0 | -469 |
| `types:shape` | 38/5/16 (1094) | 39/5/16 (1092) | 39/5/16 (1092) | +1 | -2 |
| `es5:proto` | 38/0/27 (2052) | 38/0/27 (2050) | 38/0/27 (2050) | +0 | -2 |
| `fn:call-bind` | 36/0/5 (641) | 37/0/5 (646) | 37/0/5 (646) | +1 | +5 |
| `destructure` | 33/0/14 (525) | 33/0/14 (524) | 33/0/14 (524) | +0 | -1 |
| `stdlib:node` | 33/0/22 (348) | 33/0/22 (348) | 33/0/22 (348) | +0 | +0 |
| `other` | 17/0/3 (156) | 38/23/26 (2950) | 38/23/26 (2949) | +21 | +2793 |
| `obj:computed` | 29/0/9 (1107) | 29/0/9 (1102) | 29/0/9 (1102) | +0 | -5 |
| `fn:value` | 29/0/15 (445) | 28/0/14 (435) | 28/0/14 (435) | -1 | -10 |
| `builtin:value` | 28/0/11 (1216) | 28/0/11 (1214) | 28/0/11 (1214) | +0 | -2 |
| `date` | 28/2/12 (585) | 28/2/12 (589) | 28/2/12 (589) | +0 | +4 |
| `module:ns` | 28/0/18 (1155) | 28/0/18 (1162) | 28/0/18 (1162) | +0 | +7 |
| `op:any` | 26/0/2 (2354) | 25/0/2 (2347) | 25/0/2 (2347) | -1 | -7 |
| `symbol` | 18/0/3 (162) | 18/0/3 (161) | 18/0/3 (161) | +0 | -1 |
| `var:hoist` | 17/0/2 (2785) | 17/0/2 (2772) | 17/0/2 (2772) | +0 | -13 |
| `global:sniff` | 17/0/7 (142) | 17/0/7 (142) | 17/0/7 (142) | +0 | +0 |
| `class:dyn` | 15/1/12 (291) | 15/1/12 (291) | 15/1/12 (291) | +0 | +0 |
| `generic:fn` | 10/0/7 (115) | 10/0/7 (115) | 10/0/7 (115) | +0 | +0 |
| `error:shape` | 10/1/1 (65) | 10/1/1 (65) | 10/1/1 (65) | +0 | +0 |
| `in:computed` | 10/0/0 (27) | 10/0/0 (24) | 10/0/0 (24) | +0 | -3 |
| `module:builtin` | 9/6/7 (15) | 10/7/8 (16) | 10/7/8 (16) | +1 | +1 |
| `closure:capture` | 8/0/0 (365) | 8/0/0 (292) | 8/0/0 (292) | +0 | -73 |
| `bundler:interop` | 7/7/7 (267) | 7/7/7 (267) | 7/7/7 (267) | +0 | +0 |
| `container:elem` | 7/0/5 (35) | 7/0/5 (35) | 7/0/5 (35) | +0 | +0 |
| `spread` | 7/0/0 (13) | 7/0/0 (13) | 7/0/0 (13) | +0 | +0 |
| `expr:assign` | 6/0/0 (336) | 7/1/1 (359) | 7/1/1 (359) | +1 | +23 |
| `bigint` | 7/0/2 (44) | 6/0/2 (43) | 6/0/2 (43) | -1 | -1 |
| `export:mutable` | 6/0/6 (45) | 6/0/6 (45) | 6/0/6 (45) | +0 | +0 |
| `call:arity` | 6/0/2 (112) | 5/0/2 (92) | 5/0/2 (92) | -1 | -20 |
| `module:form` | 6/6/6 (7) | 5/5/5 (5) | 5/5/5 (5) | -1 | -2 |
| `for:multi` | 5/0/0 (41) | 5/0/0 (41) | 5/0/0 (41) | +0 | +0 |
| `class:local` | 3/0/1 (224) | 3/0/1 (225) | 3/0/1 (225) | +0 | +1 |
| `generator` | 2/1/1 (25) | 3/1/1 (27) | 3/1/1 (27) | +1 | +2 |
| `tsgo:panic` | 2/0/0 (2) | 2/0/0 (2) | 2/0/0 (2) | +0 | +0 |
| `ts-emit:enum` | 2/0/2 (15) | 2/0/2 (15) | 2/0/2 (15) | +0 | +0 |
| `ice` | 4/4/4 (156) | 0/0/0 (0) | 0/0/0 (0) | -4 | -156 |
| `module:cycle` | 2/2/2 (4) | 1/1/1 (2) | 1/1/1 (2) | -1 | -2 |
| `generic:class` | 1/1/1 (6) | 1/1/1 (6) | 1/1/1 (6) | +0 | +0 |
| `module:default` | 1/1/1 (1) | 1/1/1 (1) | 1/1/1 (1) | +0 | +0 |
| `types:narrow` | 1/0/0 (6) | 1/0/0 (6) | 1/0/0 (6) | +0 | +0 |
| `syntax` | 1/0/0 (1) | 0/0/0 (0) | 0/0/0 (0) | -1 | -1 |
| `wasm:backend` | 1/1/1 (1) | 0/0/0 (0) | 0/0/0 (0) | -1 | -1 |

## U2-targeted message buckets: packages (sites), non-cascade sites only
| dyn value checked into a typed slot (S115(d)/S125(c) exits: COPY) | 0 (0) | 27 (487) | 27 (487) |
| typed value converted to dynamic (S125(c) entries: COPY) | 0 (0) | 26 (2107) | 26 (2107) |
| function crossing into a dynamic value (COPY) | 0 (0) | 14 (81) | 14 (81) |
| any COPY refusal (sum of the three) | 0 (0) | 32 (2670) | 32 (2670) |
| callback params/results | 10 (26) | 12 (26) | 12 (26) |
| casts / JSON.parse | 3 (9) | 4 (25) | 4 (25) |
| messages naming any/unknown/dynamic | 61 (7282) | 65 (9329) | 65 (9330) |

## per-package changes base -> u2
verdict worse: 11
   ('babel-preset-env', 'deferred-only', 'blocked', ['other'])
   ('chalk', 'deferred-only', 'blocked', ['other'])
   ('core-js', 'deferred-only', 'blocked', ['other'])
   ('eslint-plugin-node', 'deferred-only', 'blocked', ['other'])
   ('eslint-plugin-promise', 'deferred-only', 'blocked', ['other'])
   ('eslint-plugin-react', 'deferred-only', 'blocked', ['other'])
   ('lodash', 'deferred-only', 'blocked', ['other'])
   ('moment', 'deferred-only', 'blocked', ['other'])
   ('rimraf', 'deferred-only', 'blocked', ['other'])
   ('sinon', 'deferred-only', 'blocked', ['other'])
   ('tslib', 'deferred-only', 'blocked', ['other'])
verdict better: 3
   ('babel-jest', 'blocked', 'deferred-only')
   ('jest', 'blocked', 'deferred-only')
   ('rollup-plugin-node-resolve', 'blocked', 'deferred-only')
compileOk lost: ['eslint-plugin-promise', 'eslint-plugin-react', 'lodash', 'moment', 'sinon', 'ts-node', 'tslib']
compileOk gained: ['babel-jest', 'jest', 'rollup-plugin-node-resolve']
families newly present in a package: [('other', 21), ('expr:assign', 1), ('types:shape', 1), ('generator', 1), ('module:builtin', 1), ('fn:call-bind', 1)]
families gone from a package: [('ice', 4), ('module:form', 1), ('stdlib:js', 1), ('call:arity', 1), ('syntax', 1), ('wasm:backend', 1), ('module:cycle', 1), ('fn:value', 1), ('bigint', 1), ('op:any', 1)]
