## headline
| metric | base | u2 |
|---|---|---|
| with result | 294 | 295 |
| compileOk (wasm build of first entry) | 180 | 173 |
| clean | 11 | 11 |
| deferred-only | 175 | 153 |
| blocked | 108 | 131 |
| dep-unavailable | 0 | 0 |
| no-result | 8 | 7 |
| partial | 5 | 2 |
| budget-skipped entries | 38 | 38 |
| timeouts | 1 | 2 |
| analyzer crashes | 6 | 0 |
| complete-analysis population | 289 | 293 |
| loads (no hard, no init site; ENV ignored) | 29 | 30 |
| build passes (no hard site; ENV ignored) | 185 | 165 |
| clean files (per-file units w/o site) | 1539 | 1568 |
| per-file units | 7760 | 7851 |
| total sites (families) | 79467 | 85970 |
| SC9001 sites | 192 | 3 |
| SC3001 sites | 11 | 7 |

## families: packages (sites)
| family | base pkgs/hard/init (sites) | u2 pkgs/hard/init (sites) | Δpkgs | Δsites |
|---|---|---|---|---|
| `binding:blocked` | 189/0/118 (10131) | 190/2/118 (10080) | +1 | -51 |
| `dyn:receiver` | 182/2/48 (7595) | 183/4/51 (7383) | +1 | -212 |
| `stdlib:js` | 182/4/114 (6024) | 182/4/113 (5635) | +0 | -389 |
| `write:untyped` | 166/8/94 (6900) | 168/8/95 (6848) | +2 | -52 |
| `dep-edge` | 150/86/120 (9307) | 150/86/120 (8696) | +0 | -611 |
| `cjs:shape` | 134/0/110 (1774) | 134/0/110 (1777) | +0 | +3 |
| `cjs:require` | 134/0/102 (3486) | 134/0/102 (3489) | +0 | +3 |
| `types:shape` | 133/17/48 (2594) | 135/17/48 (2433) | +2 | -161 |
| `es5:proto` | 132/0/88 (5624) | 131/0/88 (6343) | -1 | +719 |
| `fn:call-bind` | 119/1/14 (1229) | 122/1/14 (1258) | +3 | +29 |
| `stdlib:node` | 110/0/50 (745) | 111/0/50 (748) | +1 | +3 |
| `date` | 108/12/43 (1538) | 109/13/44 (1480) | +1 | -58 |
| `destructure` | 101/3/44 (1374) | 101/3/44 (1361) | +0 | -13 |
| `op:any` | 92/0/6 (3461) | 92/0/6 (3377) | +0 | -84 |
| `obj:computed` | 90/0/33 (2519) | 92/0/33 (5555) | +2 | +3036 |
| `other` | 47/2/12 (239) | 125/79/86 (5309) | +78 | +5070 |
| `builtin:value` | 84/0/29 (1610) | 86/0/29 (1621) | +2 | +11 |
| `fn:value` | 83/0/30 (1490) | 82/0/30 (1463) | -1 | -27 |
| `module:ns` | 63/0/41 (1496) | 64/0/42 (1507) | +1 | +11 |
| `class:dyn` | 59/11/40 (623) | 60/14/42 (643) | +1 | +20 |
| `global:sniff` | 54/0/15 (1076) | 55/0/15 (755) | +1 | -321 |
| `var:hoist` | 53/0/3 (3370) | 49/0/3 (3336) | -4 | -34 |
| `symbol` | 46/0/7 (336) | 47/1/8 (323) | +1 | -13 |
| `generic:fn` | 44/2/30 (475) | 46/4/32 (480) | +2 | +5 |
| `in:computed` | 28/0/0 (87) | 29/0/0 (93) | +1 | +6 |
| `bundler:interop` | 28/28/28 (293) | 28/28/28 (293) | +0 | +0 |
| `error:shape` | 25/5/5 (102) | 27/6/6 (104) | +2 | +2 |
| `ts-emit:enum` | 22/0/22 (1472) | 22/0/22 (1368) | +0 | -104 |
| `expr:assign` | 21/0/3 (430) | 22/1/4 (446) | +1 | +16 |
| `closure:capture` | 20/0/0 (539) | 20/0/0 (463) | +0 | -76 |
| `call:arity` | 19/0/3 (249) | 18/0/3 (220) | -1 | -29 |
| `module:builtin` | 17/13/14 (30) | 18/14/15 (31) | +1 | +1 |
| `export:mutable` | 17/0/17 (61) | 17/0/17 (61) | +0 | +0 |
| `spread` | 16/0/1 (24) | 16/0/1 (24) | +0 | +0 |
| `container:elem` | 15/0/12 (57) | 15/0/12 (57) | +0 | +0 |
| `for:multi` | 14/0/0 (60) | 15/0/0 (62) | +1 | +2 |
| `module:form` | 17/17/17 (20) | 12/12/12 (14) | -5 | -6 |
| `bigint` | 13/0/5 (104) | 12/0/5 (103) | -1 | -1 |
| `class:local` | 12/0/2 (579) | 13/0/2 (584) | +1 | +5 |
| `generator` | 10/1/1 (50) | 11/1/1 (52) | +1 | +2 |
| `module:cycle` | 12/12/12 (25) | 7/7/7 (14) | -5 | -11 |
| `wasm:backend` | 11/11/11 (11) | 7/7/7 (7) | -4 | -4 |
| `ice` | 15/15/15 (192) | 2/2/2 (3) | -13 | -189 |
| `types:narrow` | 5/0/0 (10) | 5/0/0 (10) | +0 | +0 |
| `syntax` | 4/0/1 (33) | 4/0/1 (36) | +0 | +3 |
| `module:default` | 4/4/4 (4) | 4/4/4 (4) | +0 | +0 |
| `generic:class` | 2/1/2 (10) | 2/1/2 (10) | +0 | +0 |
| `tsgo:panic` | 2/0/0 (2) | 2/0/0 (2) | +0 | +0 |
| `cfg:strict-off` | 2/2/2 (4) | 2/2/2 (4) | +0 | +0 |
| `decorator` | 1/0/1 (1) | 2/0/1 (2) | +1 | +1 |
| `tsc:missing-dep` | 1/1/1 (1) | 1/1/1 (1) | +0 | +0 |
| `typeof:static` | 1/0/0 (1) | 1/0/0 (1) | +0 | +0 |
| `esm-in-cjs` | 0/0/0 (0) | 1/1/1 (1) | +1 | +1 |

## U2-targeted message buckets: packages (sites), non-cascade sites only
| dyn value checked into a typed slot (S115(d)/S125(c) exits: COPY) | 0 (0) | 73 (934) |
| typed value converted to dynamic (S125(c) entries: COPY) | 0 (0) | 91 (3687) |
| function crossing into a dynamic value (COPY) | 0 (0) | 36 (194) |
| any COPY refusal (sum of the three) | 0 (0) | 109 (4815) |
| callback params/results | 21 (50) | 23 (50) |
| casts / JSON.parse | 6 (27) | 10 (50) |
| messages naming any/unknown/dynamic | 226 (23058) | 236 (26765) |

## per-package changes base -> u2
verdict worse: 34
   ('@emotion/react', 'deferred-only', 'blocked', ['other'])
   ('@rollup/plugin-replace', 'clean', 'deferred-only', [])
   ('@testing-library/jest-dom', 'deferred-only', 'blocked', ['dyn:receiver', 'other'])
   ('@testing-library/user-event', 'deferred-only', 'blocked', ['other'])
   ('@vue/cli-plugin-eslint', 'deferred-only', 'blocked', ['wasm:backend'])
   ('babel-preset-env', 'deferred-only', 'blocked', ['other'])
   ('bluebird', 'deferred-only', 'blocked', ['other'])
   ('chalk', 'deferred-only', 'blocked', ['other'])
   ('cheerio', 'deferred-only', 'blocked', ['other'])
   ('coffee-script', 'deferred-only', 'blocked', ['other'])
   ('core-js', 'deferred-only', 'blocked', ['other'])
   ('date-fns', 'deferred-only', 'blocked', ['other'])
   ('eslint-plugin-node', 'deferred-only', 'blocked', ['other'])
   ('eslint-plugin-promise', 'deferred-only', 'blocked', ['other'])
   ('eslint-plugin-react', 'deferred-only', 'blocked', ['other'])
   ('eslint-plugin-react-hooks', 'deferred-only', 'blocked', ['other'])
   ('jest-cli', 'deferred-only', 'blocked', ['ice'])
   ('js-yaml', 'deferred-only', 'blocked', ['other'])
   ('jsdom', 'deferred-only', 'blocked', ['other'])
   ('jshint', 'deferred-only', 'blocked', ['other'])
   ('karma-sourcemap-loader', 'deferred-only', 'blocked', ['other'])
   ('lodash', 'deferred-only', 'blocked', ['other'])
   ('moment', 'deferred-only', 'blocked', ['other'])
   ('react-redux', 'deferred-only', 'blocked', ['other'])
   ('react-test-renderer', 'deferred-only', 'blocked', ['other'])
   ('rimraf', 'deferred-only', 'blocked', ['other'])
   ('rollup-plugin-peer-deps-external', 'deferred-only', 'blocked', ['other'])
   ('rollup-plugin-postcss', 'deferred-only', 'blocked', ['wasm:backend'])
   ('sinon', 'deferred-only', 'blocked', ['other'])
   ('tslib', 'deferred-only', 'blocked', ['other'])
   ('uglify-js', 'deferred-only', 'blocked', ['other'])
   ('uuid', 'deferred-only', 'blocked', ['ice'])
   ('web-vitals', 'deferred-only', 'blocked', ['wasm:backend'])
   ('webpack-merge', 'deferred-only', 'blocked', ['other'])
verdict better: 11
   ('@storybook/addon-essentials', 'blocked', 'deferred-only')
   ('babel-jest', 'blocked', 'deferred-only')
   ('dayjs', 'blocked', 'deferred-only')
   ('eslint-plugin-flowtype', 'blocked', 'deferred-only')
   ('jest', 'blocked', 'deferred-only')
   ('puppeteer', 'blocked', 'deferred-only')
   ('react-router-dom', 'blocked', 'clean')
   ('regenerator-runtime', 'blocked', 'deferred-only')
   ('rollup-plugin-commonjs', 'blocked', 'deferred-only')
   ('rollup-plugin-node-resolve', 'blocked', 'deferred-only')
   ('source-map-support', 'blocked', 'deferred-only')
compileOk lost: ['@vue/cli-plugin-eslint', 'eslint-plugin-promise', 'eslint-plugin-react', 'jest-cli', 'js-yaml', 'jshint', 'karma-sourcemap-loader', 'lodash', 'moment', 'rollup-plugin-peer-deps-external', 'rollup-plugin-postcss', 'sinon', 'ts-node', 'tslib', 'uglify-js', 'uuid', 'web-vitals']
compileOk gained: ['babel-jest', 'colors', 'dayjs', 'eslint-plugin-flowtype', 'jest', 'minimist', 'regenerator-runtime', 'rollup-plugin-commonjs', 'rollup-plugin-node-resolve', 'source-map-support']
families newly present in a package: [('other', 77), ('wasm:backend', 6), ('generic:fn', 2), ('ice', 2), ('error:shape', 2), ('fn:call-bind', 2), ('write:untyped', 1), ('stdlib:js', 1), ('obj:computed', 1), ('builtin:value', 1), ('generator', 1), ('types:shape', 1), ('decorator', 1), ('symbol', 1), ('module:ns', 1), ('var:hoist', 1), ('syntax', 1), ('class:local', 1), ('for:multi', 1), ('esm-in-cjs', 1)]
families gone from a package: [('ice', 15), ('wasm:backend', 10), ('var:hoist', 6), ('module:form', 5), ('module:cycle', 5), ('es5:proto', 2), ('stdlib:js', 2), ('call:arity', 1), ('cjs:require', 1), ('syntax', 1), ('binding:blocked', 1), ('fn:value', 1), ('bigint', 1), ('op:any', 1)]
