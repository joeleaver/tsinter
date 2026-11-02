/* Oracle test for scr_json.c (the dynamic-value dyn, the RFC 8259 parser,
 * the dynCheck failure path, and the stringify output buffer). Run by
 * json.test.ts; built with ASan + the RC audit, so a clean exit also proves
 * the checked-dynamic tree's recursive ownership (parse failures mid-tree included) leaks
 * nothing and frees nothing twice.
 *
 * EXACT ERROR MESSAGES are asserted here, against OUR strings: compiled
 * programs cannot observe them (the supported catch form is bindingless),
 * and the V8-flavored parse messages are documented as approximate
 * (SEMANTICS.md) — so the C tests, not the differential corpus, are where
 * the exact texts are pinned. Each expected failure routes through
 * scr_exc_print_uncaught(), and json.test.ts asserts the stderr lines.
 */
#include "scr_runtime.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int checks = 0;
static int failures = 0;

static void check(bool ok, const char *name) {
  checks++;
  if (!ok) {
    failures++;
    printf("FAIL %s\n", name);
  }
}

static ScrStr *S(const char *s) { return scr_str_new(s, strlen(s)); }

static bool str_is(const ScrStr *s, const char *want) {
  return s && s->len == strlen(want) && memcmp(s->data, want, s->len) == 0;
}

/* Parse `text`, expect success, return the checked-dynamic tree (+1). */
static ScrDyn *parse_ok(const char *text, const char *name) {
  ScrStr *t = S(text);
  ScrDyn *d = scr_json_parse(t);
  scr_str_release(t);
  check(d != NULL && !scr_exc_pending(), name);
  if (scr_exc_pending()) scr_exc_clear();
  return d;
}

/* Parse `text`, expect a throw; the message prints to stderr (asserted by
 * json.test.ts) which also clears the cell. */
static void parse_fail(const char *text, const char *name) {
  ScrStr *t = S(text);
  ScrDyn *d = scr_json_parse(t);
  scr_str_release(t);
  check(d == NULL && scr_exc_pending(), name);
  if (d) scr_dyn_release(d);
  if (scr_exc_pending()) scr_exc_print_uncaught();
}

static bool dyn_str_is(const ScrDyn *d, const char *want) {
  return d && d->kind == SCR_DYN_STR && str_is(d->v.str, want);
}

int main(int argc, char **argv) {
  scr_init();

  /* ── dynCheck failure (GH #86 review, SEMANTICS.md S122): a check Node
   * never makes ENDS the program — `test_json fail` runs only that path,
   * which prints the fence line and exits 1 (json.test.ts pins it). ── */
  if (argc > 1 && strcmp(argv[1], "fail") == 0) {
    ScrDyn *got = parse_ok("\"nope\"", "fail-path operand");
    ScrDynPath root = { NULL, "items", 0 };
    ScrDynPath idx = { &root, NULL, 2 };
    ScrDynPath leaf = { &idx, "price", 0 };
    scr_dyn_check_fail(&leaf, "number", got);
  }

  /* ── primitives ─────────────────────────────────────────────────── */
  ScrDyn *d = parse_ok("null", "parse null");
  check(d->kind == SCR_DYN_NULL, "null kind");
  scr_dyn_release(d);

  d = parse_ok("true", "parse true");
  check(d->kind == SCR_DYN_BOOL && d->v.b, "true value");
  scr_dyn_release(d);
  d = parse_ok("false", "parse false");
  check(d->kind == SCR_DYN_BOOL && !d->v.b, "false value");
  scr_dyn_release(d);

  d = parse_ok(" -12.5e2 ", "parse number with ws");
  check(d->kind == SCR_DYN_NUM && d->v.num == -1250.0, "number value");
  scr_dyn_release(d);
  d = parse_ok("0", "parse zero");
  check(d->kind == SCR_DYN_NUM && d->v.num == 0, "zero value");
  scr_dyn_release(d);
  d = parse_ok("1e308", "parse big");
  check(d->kind == SCR_DYN_NUM && d->v.num == 1e308, "big value");
  scr_dyn_release(d);
  d = parse_ok("1e999", "parse overflow to Infinity"); /* like JS */
  check(d->kind == SCR_DYN_NUM && isinf(d->v.num), "overflow is Infinity");
  scr_dyn_release(d);

  /* ── strings and escapes ────────────────────────────────────────── */
  d = parse_ok("\"a\\\"b\\\\c\\/d\\b\\f\\n\\r\\t\"", "parse escapes");
  check(dyn_str_is(d, "a\"b\\c/d\b\f\n\r\t"), "escape values");
  scr_dyn_release(d);

  d = parse_ok("\"\\u0041\\u00e9\\u65e5\"", "parse \\u BMP");
  check(dyn_str_is(d, "A\xC3\xA9\xE6\x97\xA5"), "\\u BMP encodes UTF-8");
  scr_dyn_release(d);

  d = parse_ok("\"\\uD83D\\uDE00\"", "parse surrogate pair");
  check(dyn_str_is(d, "\xF0\x9F\x98\x80"), "surrogate pair combines");
  scr_dyn_release(d);

  /* Lone surrogates become U+FFFD (house policy: strings stay well-formed
   * UTF-8; JS would keep the lone surrogate — documented divergence). */
  d = parse_ok("\"x\\uD800y\"", "parse lone high surrogate");
  check(dyn_str_is(d, "x\xEF\xBF\xBDy"), "lone high surrogate -> U+FFFD");
  scr_dyn_release(d);
  d = parse_ok("\"\\uDC00\"", "parse lone low surrogate");
  check(dyn_str_is(d, "\xEF\xBF\xBD"), "lone low surrogate -> U+FFFD");
  scr_dyn_release(d);
  /* High surrogate followed by a non-surrogate escape: U+FFFD, then the
   * escape parses normally. */
  d = parse_ok("\"\\uD800\\u0041\"", "high surrogate then BMP escape");
  check(dyn_str_is(d, "\xEF\xBF\xBD" "A"), "U+FFFD then A");
  scr_dyn_release(d);

  /* Raw UTF-8 passes through. */
  d = parse_ok("\"caf\xC3\xA9\"", "parse raw UTF-8");
  check(dyn_str_is(d, "caf\xC3\xA9"), "raw UTF-8 preserved");
  scr_dyn_release(d);

  /* ── arrays and objects ─────────────────────────────────────────── */
  d = parse_ok("[1, [2, []], \"three\"]", "parse nested array");
  check(d->kind == SCR_DYN_ARR && d->v.arr.len == 3, "array len");
  check(d->v.arr.items[0]->v.num == 1, "arr[0]");
  check(d->v.arr.items[1]->kind == SCR_DYN_ARR && d->v.arr.items[1]->v.arr.len == 2,
        "arr[1] nested");
  check(dyn_str_is(d->v.arr.items[2], "three"), "arr[2] string");
  scr_dyn_release(d);

  d = parse_ok("{\"a\":1,\"b\":{\"c\":[true]},\"a\":2}", "parse object");
  check(d->kind == SCR_DYN_OBJ && d->v.obj.len == 2, "dup keys collapse");
  const ScrDyn *m = scr_dyn_obj_get(d, "a", 1);
  check(m != NULL && m->kind == SCR_DYN_NUM && m->v.num == 2, "later dup key wins");
  m = scr_dyn_obj_get(d, "b", 1);
  check(m != NULL && m->kind == SCR_DYN_OBJ, "nested object");
  check(scr_dyn_obj_get(d, "zz", 2) == NULL, "absent key is NULL");
  scr_dyn_release(d);

  d = parse_ok("{}", "parse empty object");
  check(d->v.obj.len == 0, "empty object");
  scr_dyn_release(d);
  d = parse_ok("[]", "parse empty array");
  check(d->v.arr.len == 0, "empty array");
  scr_dyn_release(d);

  /* ── retain/release semantics ───────────────────────────────────── */
  d = parse_ok("[1,2]", "rc probe");
  ScrDyn *alias = scr_dyn_retain(d);
  scr_dyn_release(d);
  check(alias->v.arr.len == 2, "alias survives first release");
  scr_dyn_release(alias);

  /* ── parse errors (exact OUR-string messages, printed to stderr) ── */
  parse_fail("", "empty input fails");
  parse_fail("   ", "blank input fails");
  parse_fail("{oops", "bad token fails");
  parse_fail("[1,2,", "unterminated array fails");
  parse_fail("[1 2]", "missing comma fails");
  parse_fail("{\"a\"}", "missing colon fails");
  parse_fail("{\"a\":1,}", "trailing comma fails");
  parse_fail("{1:2}", "non-string key fails");
  parse_fail("\"unterminated", "unterminated string fails");
  parse_fail("\"bad \\q\"", "bad escape fails");
  parse_fail("\"ctrl \n\"", "control char in string fails");
  parse_fail("\"\\u12G4\"", "bad unicode escape fails");
  parse_fail("-", "lone minus fails");
  parse_fail("1.", "bare fraction fails");
  parse_fail("1e+", "empty exponent fails");
  parse_fail("1 2", "trailing content fails");
  parse_fail("nul", "truncated literal fails");

  /* Depth cap: 1001 nested arrays throw (catchably) instead of smashing
   * the native stack. */
  {
    size_t n = 1001;
    char *deep = malloc(2 * n + 2);
    for (size_t i = 0; i < n; i++) deep[i] = '[';
    deep[n] = '1';
    for (size_t i = 0; i < n; i++) deep[n + 1 + i] = ']';
    deep[2 * n + 1] = '\0';
    ScrStr *t = scr_str_new(deep, 2 * n + 1);
    free(deep);
    ScrDyn *too = scr_json_parse(t);
    scr_str_release(t);
    check(too == NULL && scr_exc_pending(), "depth cap throws");
    if (scr_exc_pending()) scr_exc_print_uncaught();
  }

  /* ── stringify buffer ───────────────────────────────────────────── */
  {
    ScrJsonBuf b;
    scr_jb_init(&b);
    scr_jb_putc(&b, '[');
    scr_jb_put_f64(&b, 0.0 / 0.0);
    scr_jb_putc(&b, ',');
    scr_jb_put_f64(&b, 1.0 / 0.0);
    scr_jb_putc(&b, ',');
    scr_jb_put_f64(&b, -0.0);
    scr_jb_putc(&b, ',');
    scr_jb_put_f64(&b, 0.1 + 0.2);
    scr_jb_putc(&b, ',');
    ScrStr *tricky = S("q\" b\\ n\n t\t ctl\x01 caf\xC3\xA9");
    scr_jb_put_json_str(&b, tricky);
    scr_str_release(tricky);
    scr_jb_putc(&b, ']');
    ScrStr *out = scr_jb_finish(&b);
    check(str_is(out,
                 "[null,null,0,0.30000000000000004,"
                 "\"q\\\" b\\\\ n\\n t\\t ctl\\u0001 caf\xC3\xA9\"]"),
          "stringify buffer output");
    scr_str_release(out);
  }

  printf("%d/%d checks passed\n", checks - failures, checks);
  return failures == 0 ? 0 : 1;
}
