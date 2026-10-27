/* The native regex engine's translation harness (native-regex-engine.test.ts):
 * drives packages/runtime/src/scr_regex_engine.h -- the wasm regex engine
 * module translated to C -- over a line protocol so the test can hold its
 * every output equal to the wasm module's, run by Node's WebAssembly.
 *
 * Input lines (tab-separated; a string is the hex of its UTF-16 code units,
 * four digits each):
 *   c <pattern> <flags>                      compile
 *   x <pattern> <flags> <subject> <start>    compile, then one exec
 * Output, one line per input:
 *   ok <source> <flags> <bytecode hex> <captures> <names: -1, or n then n strings>
 *   syn <message>
 *   fence <id> <message> <code>
 *   m <exec result> <capture slots, comma-separated>
 * Collects after every line, so a use-after-free in the collector's roots
 * shows up under ASan. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "scr_regex_engine.h"

static _Noreturn void scr_rx_trap(void) {
  fprintf(stderr, "rxharness: trap\n");
  exit(3);
}
static _Noreturn void scr_rx_oom(void) {
  fprintf(stderr, "rxharness: out of memory\n");
  exit(4);
}

static RxObj *hexstr(const char *h, size_t n) {
  RxObj *s = scr_rx_strNew((int32_t)(n / 4));
  for (size_t i = 0; i + 4 <= n; i += 4) {
    unsigned v;
    sscanf(h + i, "%4x", &v);
    scr_rx_strSet(s, (int32_t)(i / 4), (int32_t)v);
  }
  return s;
}

static void putstr(RxObj *s) {
  int32_t n = scr_rx_strLen(s);
  if (n == 0) putchar('-');
  for (int32_t i = 0; i < n; i++) printf("%04x", (unsigned)scr_rx_strAt(s, i));
}

static char *field(char **p) {
  char *s = *p;
  char *t = strchr(s, '\t');
  if (t) {
    *t = 0;
    *p = t + 1;
  } else {
    *p = s + strlen(s);
  }
  return s;
}

int main(void) {
  static char line[1 << 20];
  while (fgets(line, sizeof line, stdin)) {
    size_t L = strlen(line);
    if (L > 0 && line[L - 1] == '\n') line[--L] = 0;
    char *p = line;
    char *cmd = field(&p);
    char *pat = field(&p);
    char *fl = field(&p);
    if (strcmp(pat, "-") == 0) pat = "";
    if (strcmp(fl, "-") == 0) fl = "";
    RxObj *r = scr_rx_compile(hexstr(pat, strlen(pat)), hexstr(fl, strlen(fl)));
    if (cmd[0] == 'c') {
      if (!scr_rx_isNull(r)) {
        printf("ok\t");
        putstr(scr_rx_reSource(r));
        putchar('\t');
        putstr(scr_rx_reFlags(r));
        putchar('\t');
        int32_t n = scr_rx_reBcLen(r);
        for (int32_t i = 0; i < n; i++) printf("%02x", (unsigned)scr_rx_reBcAt(r, i));
        printf("\t%d\t", scr_rx_reCap(r));
        int32_t nn = scr_rx_reNamesLen(r);
        printf("%d", nn);
        for (int32_t k = 0; k < nn; k++) {
          putchar(',');
          RxObj *nm = scr_rx_reName(r, k);
          if (nm) putstr(nm);
          else putchar('~');
        }
        putchar('\n');
      } else if (scr_rx_errKind() == 1) {
        printf("syn\t");
        putstr(scr_rx_errMessage());
        putchar('\n');
      } else {
        printf("fence\t%d\t", scr_rx_errId());
        putstr(scr_rx_errMessage());
        putchar('\t');
        putstr(scr_rx_errCode());
        putchar('\n');
      }
    } else {
      char *subj = field(&p);
      char *start = field(&p);
      if (strcmp(subj, "-") == 0) subj = "";
      if (scr_rx_isNull(r)) {
        printf("nocompile\n");
      } else {
        RxObj *bc = scr_rx_reBc(r);
        int32_t cap = scr_rx_reCap(r);
        int32_t regs = scr_rx_reBcAt(r, 3);
        RxObj *caps = scr_rx_newCaptureArray(cap + (regs + 1) / 2);
        int32_t rc = scr_rx_exec(bc, hexstr(subj, strlen(subj)), atoi(start), caps);
        printf("m\t%d\t", rc);
        int32_t n = scr_rx_capLen(caps);
        for (int32_t i = 0; i < n; i++) printf(i ? ",%d" : "%d", scr_rx_capGet(caps, i));
        putchar('\n');
      }
    }
    scr_rx_collect();
  }
  scr_rx_free_all();
  return 0;
}
