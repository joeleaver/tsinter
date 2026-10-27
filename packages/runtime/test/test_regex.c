/* Unit tests for the regex runtime (scr_regex.c + vendored libregexp).
 * Built with ASan + -DSCR_RC_AUDIT by regex.test.ts. Prints "N/N cases
 * passed" to stderr.
 *
 * Focus areas beside the differential corpus (which re-checks the
 * observable results against Node): the C-level contracts — RC accounting
 * of results, catchable throws through the exception cell (replaceAll
 * without /g), lastIndex (board #301), the CESU-8 pattern re-encoding
 * for non-/u astral patterns, and the UTF-16 buffer round-trip.
 */
#include "../src/scr_runtime.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef SCR_RC_AUDIT
long scr_str_live_count(void); /* provided by scr_string.c */
#endif

static long total = 0, failed = 0;

static void check(bool ok, const char *what) {
  total++;
  if (!ok) {
    failed++;
    fprintf(stderr, "FAIL: %s\n", what);
  }
}

/* Immortal literals + regexes, exactly the layout the compiler emits. */
#define LIT(name, s) \
  static struct { size_t rc; size_t len; size_t cap; char data[sizeof(s)]; } name = \
      {SIZE_MAX, sizeof(s) - 1, sizeof(s) - 1, s}
#define RE(name, pat, fl)  \
  LIT(name##_pat, pat);    \
  LIT(name##_fl, fl);      \
  static ScrRegex name = { \
      SIZE_MAX, (ScrStr *)&name##_pat, (ScrStr *)&name##_fl, NULL}

RE(re_abc_i, "ab+c", "i");
RE(re_a_g, "a", "g");
RE(re_ab_g, "a|b", "g");
RE(re_group, "(b)", "");
RE(re_opt_group, "a(x)?c", "");
RE(re_astar_g, "a*", "g");
RE(re_a_first, "a", "");
RE(re_dot_g, "\\.", "g");
RE(re_dot_noglobal, "\\.", "");
RE(re_digit, "\\d", "");
RE(re_empty, "(?:)", "");
RE(re_empty_gu, "(?:)", "gu");
RE(re_bstar, "b*", "");
RE(re_b_y, "b", "y");
RE(re_letter_u, "\\p{L}", "u");
RE(re_caret_gm, "^", "gm");
RE(re_adotb_s, "a.b", "s");
RE(re_astral, "\xF0\x9F\x98\x80", "");        /* non-/u astral: CESU-8 path */
RE(re_astral_u, "\xF0\x9F\x98\x80", "u");
RE(re_split_group, "(,)", "g");
RE(re_named, "(?<y>\\d{4})-(?<m>\\d{2})", "");
RE(re_named_opt, "(?<a>a)(?<b>b)?", "");
RE(re_named_dup, "(?<x>\\d+)px|(?<x>\\d+)em", "g");
RE(re_backref, "(?<q>['\"]).*?\\k<q>", "");

static ScrStr *S(const char *s) { return scr_str_new(s, strlen(s)); }

static bool str_is(ScrStr *s, const char *want) {
  return s->len == strlen(want) && memcmp(s->data, want, s->len) == 0;
}

static void expect_str(ScrStr *got, const char *want, const char *what) {
  check(str_is(got, want), what);
  scr_str_release(got);
}

static void test_test(void) {
  ScrStr *s1 = S("xxABBBcyy");
  ScrStr *s2 = S("ab");
  check(scr_regex_test(&re_abc_i, s1), "test: /ab+c/i matches ABBBc");
  check(!scr_regex_test(&re_abc_i, s2), "test: /ab+c/i misses 'ab'");
  ScrStr *accent = S("\xC3\xA9"); /* é */
  check(scr_regex_test(&re_letter_u, accent), "test: /\\p{L}/u matches é (unicode tables linked)");
  ScrStr *newline = S("a\nb");
  check(scr_regex_test(&re_adotb_s, newline), "test: /a.b/s crosses the newline");
  ScrStr *emoji = S("\xF0\x9F\x98\x80");
  check(scr_regex_test(&re_astral, emoji), "test: non-/u astral pattern (CESU-8) matches the pair");
  check(scr_regex_test(&re_astral_u, emoji), "test: /u astral pattern matches");
  scr_str_release(s1);
  scr_str_release(s2);
  scr_str_release(accent);
  scr_str_release(newline);
  scr_str_release(emoji);
}

static void test_source_flags(void) {
  expect_str(scr_regex_source(&re_abc_i), "ab+c", "source readback");
  expect_str(scr_regex_flags(&re_abc_i), "i", "flags readback");
  expect_str(scr_regex_flags(&re_empty_gu), "gu", "flags keep source order");
}

static void test_replace(void) {
  ScrStr *s;

  s = S("aa");
  ScrStr *b = S("b");
  expect_str(scr_regex_replace(s, &re_a_first, b),
             "ba", "replace without /g replaces the first only");
  scr_str_release(b);
  scr_str_release(s);

  s = S("xaybz");
  ScrStr *rep = S("[$&|$`|$'|$1|$9|$$]");
  expect_str(scr_regex_replace(s, &re_ab_g, rep),
             "x[a|x|ybz|$1|$9|$]y[b|xay|z|$1|$9|$]z",
             "replace /g: $&, $`, $', out-of-range $1/$9 literal, $$");
  scr_str_release(rep);
  scr_str_release(s);

  s = S("abc");
  rep = S("<$01|$1|$2|$10>");
  expect_str(scr_regex_replace(s, &re_group, rep),
             "a<b|b|$2|b0>c",
             "replace: $01 two-digit form, out-of-range $2 literal, $10 falls back to $1+'0'");
  scr_str_release(rep);
  scr_str_release(s);

  s = S("ac");
  rep = S("[$1]");
  expect_str(scr_regex_replace(s, &re_opt_group, rep), "[]",
             "replace: unmatched group substitutes empty");
  scr_str_release(rep);
  scr_str_release(s);

  s = S("aaa");
  rep = S("-");
  expect_str(scr_regex_replace(s, &re_astar_g, rep), "--",
             "replace /g: zero-length matches advance (no infinite loop)");
  scr_str_release(rep);
  scr_str_release(s);

  s = S("\xF0\x9F\x98\x80x");
  rep = S("-");
  expect_str(scr_regex_replace(s, &re_empty_gu, rep), "-\xF0\x9F\x98\x80-x-",
             "replace /gu: AdvanceStringIndex respects surrogate pairs");
  scr_str_release(rep);
  scr_str_release(s);

  s = S("a\nb");
  rep = S(">");
  expect_str(scr_regex_replace(s, &re_caret_gm, rep), ">a\n>b",
             "replace /gm: ^ matches after every line break");
  scr_str_release(rep);
  scr_str_release(s);
}

static void test_replace_all(void) {
  ScrStr *s = S("a.b.c");
  ScrStr *rep = S("-");
  expect_str(scr_regex_replace_all(s, &re_dot_g, rep), "a-b-c",
             "replaceAll with /g replaces every match");

  check(!scr_exc_pending(), "no pending exception before the fence");
  ScrStr *r = scr_regex_replace_all(s, &re_dot_noglobal, rep);
  check(r == NULL && scr_exc_pending(),
        "replaceAll without /g throws catchably and returns NULL");
  scr_exc_clear();
  scr_str_release(rep);
  scr_str_release(s);
}

/* $<name> in GetSubstitution (the named arm) + \k<name> execution. */
static void test_named_groups(void) {
  ScrStr *s = S("2024-07");
  ScrStr *rep = S("$<m>/$<y>");
  expect_str(scr_regex_replace(s, &re_named, rep), "07/2024",
             "replace: $<name> substitutes the named captures");
  scr_str_release(rep);

  rep = S("[$<y>][$<nope>]");
  expect_str(scr_regex_replace(s, &re_named, rep), "[2024][]",
             "replace: a nonexistent $<name> substitutes empty");
  scr_str_release(rep);

  rep = S("[$<y]");
  expect_str(scr_regex_replace(s, &re_named, rep), "[$<y]",
             "replace: an unterminated $<name stays literal");
  scr_str_release(rep);
  scr_str_release(s);

  s = S("a");
  rep = S("[$<x>]");
  expect_str(scr_regex_replace(s, &re_a_first, rep), "[$<x>]",
             "replace: $<name> stays literal when the pattern has no named groups");
  scr_str_release(rep);

  rep = S("<$<a>|$<b>>");
  expect_str(scr_regex_replace(s, &re_named_opt, rep), "<a|>",
             "replace: a nonparticipating named group substitutes empty");
  scr_str_release(rep);
  scr_str_release(s);

  s = S("14px 9em");
  rep = S("[$<x>]");
  expect_str(scr_regex_replace_all(s, &re_named_dup, rep), "[14] [9]",
             "replace: ES2025 duplicate names resolve to the participating alternative");
  scr_str_release(rep);
  scr_str_release(s);

  s = S("say \"hi\" ok");
  check(scr_regex_test(&re_backref, s), "test: \\k<name> backreference matches");
  scr_str_release(s);
  s = S("say 'hi ok");
  check(!scr_regex_test(&re_backref, s), "test: \\k<name> backreference misses the unclosed quote");
  scr_str_release(s);
}

static void expect_split(ScrStr *s, ScrRegex *re, const char *const *want,
                         size_t want_len, const char *what) {
  ScrArr *a = scr_regex_split(s, re);
  bool ok = a != NULL && a->len == want_len;
  if (ok) {
    for (size_t i = 0; i < want_len; i++) {
      ScrStr *e = scr_arr_get_ref(a, (double)i);
      ok = ok && str_is(e, want[i]);
      scr_str_release(e);
    }
  }
  check(ok, what);
  scr_arr_release(a);
}

static void test_split(void) {
  ScrStr *s;

  s = S("a1b2c");
  expect_split(s, &re_digit, (const char *[]){"a", "b", "c"}, 3,
               "split by /\\d/");
  scr_str_release(s);

  s = S("abc");
  expect_split(s, &re_empty, (const char *[]){"a", "b", "c"}, 3,
               "split by the empty pattern separates every unit");
  scr_str_release(s);

  s = S("");
  expect_split(s, &re_empty, NULL, 0,
               "empty subject + matching pattern splits to []");
  expect_split(s, &re_digit, (const char *[]){""}, 1,
               "empty subject + non-matching pattern splits to ['']");
  scr_str_release(s);

  s = S("ab");
  expect_split(s, &re_bstar, (const char *[]){"a", ""}, 2,
               "split /b*/: trailing empty piece when the match ends the string");
  scr_str_release(s);

  s = S("abab");
  expect_split(s, &re_b_y, (const char *[]){"a", "a", ""}, 2 + 1,
               "split by a sticky pattern probes positions like the spec");
  scr_str_release(s);

  s = S("a,b");
  expect_split(s, &re_split_group, (const char *[]){"a", ",", "b"}, 3,
               "split with capture groups splices them in (board #301, S066)");
  scr_str_release(s);
}

/* lastIndex (board #301): a literal's fresh copy is stateful; the
 * immortal itself stands for a fresh object at every call. */
static void test_last_index(void) {
  ScrStr *s = S("a");
  ScrRegex *re = scr_regex_fresh(&re_a_g);
  check(scr_regex_test(re, s) && scr_regex_last_index(re) == 1, "test: /a/g matches, lastIndex 1");
  check(!scr_regex_test(re, s) && scr_regex_last_index(re) == 0, "test: /a/g misses from 1, lastIndex back to 0");
  scr_regex_set_last_index(re, 0.5);
  check(scr_regex_test(re, s), "test: lastIndex 0.5 is ToLength'd to 0");
  scr_regex_release(re);
  check(scr_regex_test(&re_a_g, s) && scr_regex_test(&re_a_g, s), "test: the immortal starts at 0 every call");
  scr_str_release(s);
}

int main(int argc, char **argv) {
  (void)argc;
  (void)argv;
  test_last_index();
  test_test();
  test_source_flags();
  test_replace();
  test_replace_all();
  test_named_groups();
  test_split();

#ifdef SCR_RC_AUDIT
  check(scr_str_live_count() == 0, "no live heap strings at exit (RC audit)");
#endif

  fprintf(stderr, "%ld/%ld cases passed\n", total - failed, total);
  return failed == 0 ? 0 : 1;
}
