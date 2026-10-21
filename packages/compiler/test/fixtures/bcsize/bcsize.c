/* bcsize — the regex assembler's byte-comparison oracle (regex-lre-oracle.ts).
 *
 * Feeds each input row to the vendored quickjs-ng lre_compile and prints
 * what it produced. The reference is lre_compile itself; this file is only
 * the I/O around it.
 *
 * Input, one row per line: <pattern bytes> TAB <flags> LF. The pattern is
 * passed to lre_compile byte for byte (the caller chooses UTF-8 or
 * per-code-unit WTF-8, see regex-lre-oracle.ts). Flags are JS flag letters.
 *
 * Output, one line per row:
 *   <pattern> TAB <flags> TAB captures=<n> TAB <hex>   on success, where <hex>
 *     is everything lre_compile returned: the 8-byte header, the bytecode,
 *     and the group-name trailer when the pattern has named groups;
 *   ERR TAB <lre_compile's message>                    on failure.
 *
 * Rebuilt from its documented contract in 2026-10 after the original
 * (an INC-24 out-of-repo probe) was lost; kept in-repo since. */
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "libregexp.h"

bool lre_check_stack_overflow(void *opaque, size_t alloca_size) { return false; }
int lre_check_timeout(void *opaque) { return 0; }
void *lre_realloc(void *opaque, void *ptr, size_t size) {
  if (size == 0) { free(ptr); return NULL; }
  return realloc(ptr, size);
}

static int parse_flags(const char *f, size_t n, int *out) {
  int r = 0;
  for (size_t i = 0; i < n; i++) {
    switch (f[i]) {
      case 'g': r |= LRE_FLAG_GLOBAL; break;
      case 'i': r |= LRE_FLAG_IGNORECASE; break;
      case 'm': r |= LRE_FLAG_MULTILINE; break;
      case 's': r |= LRE_FLAG_DOTALL; break;
      case 'u': r |= LRE_FLAG_UNICODE; break;
      case 'y': r |= LRE_FLAG_STICKY; break;
      case 'd': r |= LRE_FLAG_INDICES; break;
      case 'v': r |= LRE_FLAG_UNICODE_SETS; break;
      default: return -1;
    }
  }
  *out = r;
  return 0;
}

int main(void) {
  char *line = NULL;
  size_t cap = 0;
  ssize_t len;
  while ((len = getline(&line, &cap, stdin)) != -1) {
    if (len > 0 && line[len - 1] == '\n') line[--len] = '\0';
    char *tab = memchr(line, '\t', (size_t)len);
    if (!tab) { printf("ERR\tno tab in row\n"); continue; }
    size_t plen = (size_t)(tab - line);
    const char *flags = tab + 1;
    size_t flen = (size_t)len - plen - 1;
    int re_flags;
    if (parse_flags(flags, flen, &re_flags) < 0) { printf("ERR\tbad flags\n"); continue; }
    /* lre_compile reads buf[buf_len] as a terminator: give it a NUL there. */
    char *pat = malloc(plen + 1);
    memcpy(pat, line, plen);
    pat[plen] = '\0';
    char err[128];
    int bc_len;
    uint8_t *bc = lre_compile(&bc_len, err, sizeof err, pat, plen, re_flags, NULL);
    if (!bc) {
      printf("ERR\t%s\n", err);
    } else {
      size_t n = (size_t)bc_len;
      fwrite(line, 1, plen, stdout);
      printf("\t%.*s\tcaptures=%d\t", (int)flen, flags, lre_get_capture_count(bc));
      for (size_t i = 0; i < n; i++) printf("%02x", bc[i]);
      putchar('\n');
      free(bc);
    }
    free(pat);
  }
  free(line);
  return 0;
}
