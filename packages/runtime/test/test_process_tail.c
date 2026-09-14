/* Oracle test for board #143's three C-lane fixes (P5 R-A/R-B/R-C):
 * scr_process_chdir's two-path error, scr_process_kill's numeric signal
 * gate, and scr_process_umask's validation + its own separated read form.
 * Reads tab-separated case lines from argv[1] (see
 * gen-process-tail-cases.mjs — every EXPECTED field there is Node's own
 * measured answer), runs the matching scr_process_* call, and compares
 * either the pending exception's name/code/message (path.test.ts's own
 * "committed oracle cases" shape, test_lib.c's own scr_exc_pending()/
 * direct ScrError field-read idiom for the comparison itself) or the
 * plain numeric return value.
 *
 * chdir("/") first: process.kill/umask cases do not depend on cwd, but
 * the chdir case itself is generated from a KNOWN "before" cwd of "/"
 * (path.test.ts's own "generated under the same cwd" rule) — this
 * driver's OWN first line does the SAME chdir("/") before running any
 * case, so the two agree structurally even though this file has only
 * ONE chdir case to run.
 *
 * Exit 0 = all cases passed; prints each mismatch (capped) and exits 1
 * otherwise.
 */
#include "scr_runtime.h"

#include <math.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

#define MAX_FIELD 512
#define MAX_FIELDS 8

static long total = 0, failed = 0;

static void fail_line(const char *line, const char *why) {
  failed++;
  if (failed <= 40) fprintf(stderr, "MISMATCH: %s (%s)\n", line, why);
}

static ScrStr *S(const char *s) { return scr_str_new(s, strlen(s)); }

static bool str_is(const ScrStr *s, const char *want) {
  return s != NULL && s->len == strlen(want) && memcmp(s->data, want, s->len) == 0;
}

/* Parses Node's own %s rendering of a double (the case file's own field
 * format — see gen-process-tail-cases.mjs's `String(sig)`/plain numeric
 * literals), including the two spellings this file's cases need beyond
 * plain strtod: "-0" and "NaN". */
static double parse_num(const char *s) {
  if (strcmp(s, "-0") == 0) return -0.0;
  if (strcmp(s, "NaN") == 0) return NAN;
  return strtod(s, NULL);
}

/* Checks the CURRENT pending exception against an expected {name, code,
 * message}, then clears it (test_lib.c's own scr_exc_pending()/direct
 * ScrError field-read idiom — the catch-binding ScrCaught machinery is
 * for compiler-emitted code, not needed by a raw C driver). */
static void expect_throw(const char *line, const char *want_name, const char *want_code, const char *want_msg) {
  total++;
  if (!scr_exc_pending()) {
    fail_line(line, "did not throw");
    return;
  }
  ScrExcCell *cell = scr_exc_current_cell();
  if (cell->kind != SCR_EXC_OBJ) {
    fail_line(line, "pending exception is not an Error-shaped object");
    scr_exc_clear();
    return;
  }
  ScrError *e = (ScrError *)cell->payload;
  bool ok = str_is(e->name, want_name) && str_is(e->message, want_msg) &&
            ((e->code == NULL && want_code[0] == 0) || str_is(e->code, want_code));
  if (!ok) fail_line(line, "name/code/message mismatch");
  scr_exc_clear();
}

static void expect_no_throw(const char *line) {
  total++;
  if (scr_exc_pending()) {
    fail_line(line, "threw unexpectedly");
    scr_exc_print_uncaught();
  }
}

static void expect_num(const char *line, double got, double want) {
  total++;
  if (got != want) fail_line(line, "return value mismatch");
}

/* M-19 (POST-ACK #17/#19, delta-3f a8d22cbc): SEVEN of the kill cases
 * above (0, -0, NaN, 15, 6, both int32 bounds) all converge on the SAME
 * observable against a nonexistent pid (ESRCH) — they pin accept-vs-
 * reject, never WHICH signal was actually selected, so a C that maps NaN
 * to raw 0 (instead of Node's own SIGTERM default) would redden nothing
 * above. A LIVE child makes the selected signal observable directly. */
static void expect_child_alive(pid_t child, const char *label) {
  total++;
  int status;
  pid_t r = waitpid(child, &status, WNOHANG);
  if (r != 0) {
    failed++;
    if (failed <= 40) fprintf(stderr, "MISMATCH: %s (child unexpectedly not alive, waitpid returned %d)\n", label, (int)r);
  }
}
static void expect_child_sigterm(pid_t child, const char *label) {
  total++;
  int status;
  pid_t r = waitpid(child, &status, 0);
  if (r != child || !WIFSIGNALED(status) || WTERMSIG(status) != SIGTERM) {
    failed++;
    if (failed <= 40) fprintf(stderr, "MISMATCH: %s (expected WIFSIGNALED && WTERMSIG==SIGTERM, got status=0x%x)\n", label, status);
  }
}
static pid_t spawn_sleeper(void) {
  pid_t pid = fork();
  if (pid == 0) {
    execl("/bin/sleep", "sleep", "5", (char *)NULL);
    _exit(127); /* execl failed */
  }
  return pid;
}
static void run_live_child_kill_cases(void) {
  pid_t c1 = spawn_sleeper();
  scr_process_kill(c1, 0);
  expect_child_alive(c1, "live-child: kill(child, 0) leaves the child alive");
  kill(c1, SIGKILL);
  waitpid(c1, NULL, 0);

  pid_t c2 = spawn_sleeper();
  scr_process_kill(c2, NAN);
  expect_child_sigterm(c2, "live-child: kill(child, NaN) terminates the child BY SIGTERM, not silently-alive (a C mapping NaN to raw 0 reddens THIS row, which no ESRCH-only case above can see)");

  pid_t c3 = spawn_sleeper();
  scr_process_kill(c3, 15);
  expect_child_sigterm(c3, "live-child: kill(child, 15) terminates the child BY SIGTERM (the literal-SIGTERM sibling of the NaN case)");
}

int main(int argc, char **argv) {
  scr_init();
  scr_lib_init(argc, argv);

  if (argc < 2) {
    fputs("usage: test_process_tail <cases-file>\n", stderr);
    return 2;
  }
  FILE *f = fopen(argv[1], "r");
  if (!f) {
    perror("fopen");
    return 2;
  }
  if (chdir("/") != 0) {
    fputs("chdir(\"/\") failed\n", stderr);
    return 2;
  }
  /* PRIME the umask chain to a known state (0), UNASSERTED — the exact
   * same priming call gen-process-tail-cases.mjs made before generating
   * the "umask-valid" sequence's own expected prev-mask chain, so the
   * chain is deterministic regardless of the shell's own starting
   * umask (see that file's own header comment). */
  scr_process_umask(0);

  char line[MAX_FIELD * MAX_FIELDS];
  while (fgets(line, sizeof line, f)) {
    size_t linelen = strlen(line);
    while (linelen > 0 && (line[linelen - 1] == '\n' || line[linelen - 1] == '\r')) line[--linelen] = 0;
    if (linelen == 0) continue;
    char orig[MAX_FIELD * MAX_FIELDS];
    memcpy(orig, line, linelen + 1);

    char *fields[MAX_FIELDS];
    int nfields = 0;
    char *cursor = line;
    while (nfields < MAX_FIELDS) {
      fields[nfields++] = cursor;
      char *tab = strchr(cursor, '\t');
      if (!tab) break;
      *tab = 0;
      cursor = tab + 1;
    }
    const char *op = fields[0];

    if (strcmp(op, "kill") == 0) {
      /* kill \t pid \t sig \t name \t code \t message */
      double pid = parse_num(fields[1]);
      double sig = parse_num(fields[2]);
      scr_process_kill(pid, sig);
      expect_throw(orig, fields[3], fields[4], fields[5]);
    } else if (strcmp(op, "chdir") == 0) {
      /* chdir \t target \t name \t code \t message */
      ScrStr *target = S(fields[1]);
      scr_process_chdir(target);
      scr_str_release(target);
      expect_throw(orig, fields[2], fields[3], fields[4]);
    } else if (strcmp(op, "umask-invalid") == 0) {
      /* umask-invalid \t mask \t name \t code \t message */
      double mask = parse_num(fields[1]);
      scr_process_umask(mask);
      expect_throw(orig, fields[2], fields[3], fields[4]);
    } else if (strcmp(op, "umask-valid") == 0) {
      /* umask-valid \t mask \t expected-prev */
      double mask = parse_num(fields[1]);
      double want_prev = parse_num(fields[2]);
      double got_prev = scr_process_umask(mask);
      expect_no_throw(orig);
      expect_num(orig, got_prev, want_prev);
    } else if (strcmp(op, "umaskread") == 0) {
      /* umaskread \t expected-prev */
      double want = parse_num(fields[1]);
      double got = scr_process_umask_read(-1);
      expect_no_throw(orig);
      expect_num(orig, got, want);
    } else {
      fprintf(stderr, "unknown op: %s\n", op);
      return 2;
    }
  }
  fclose(f);

  run_live_child_kill_cases();

  fprintf(stderr, "%ld/%ld cases passed\n", total - failed, total);
  return failed ? 1 : 0;
}
