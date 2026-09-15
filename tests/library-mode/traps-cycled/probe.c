/* #147 T-7 probe (delta-01 §B-3, host-cycled posture): entry1's outbound
 * string result must stay readable across entry2's OWN trap in a
 * LATER entry — proving the outbound arena and the #147 live set are
 * disjoint structures (the arena is entry-scoped only by the HOST
 * calling the declared reset symbol, never automatically, and #147's
 * trap-path sweep never walks the arena at all). */
#include <setjmp.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

extern void kc_init(void);
extern void kc_set_panic_sink(void (*fn)(void *, const uint8_t *, size_t, uint64_t), void *ctx);
extern void kc_entry1(const uint8_t *p, size_t len, const uint8_t **out, size_t *out_len);
extern double kc_entry2(double i);
extern void kc_reset_results(void);

static jmp_buf trap_jmp;
static int sink_calls = 0;

static void sink(void *ctx, const uint8_t *msg, size_t len, uint64_t addr) {
  (void)ctx;
  sink_calls++;
  printf("sink[%d]: %.*s\n", sink_calls, (int)len, (const char *)msg);
  printf("addr: %s\n", addr != 0 ? "nonzero" : "zero");
  longjmp(trap_jmp, 1);
}

int main(void) {
  kc_set_panic_sink(sink, NULL);
  kc_init();

  const uint8_t *s;
  size_t n;
  kc_entry1((const uint8_t *)"survivor", 8, &s, &n);
  printf("entry1 (before trap): %.*s\n", (int)n, s);

  /* Deliberately NOT calling kc_reset_results() — the host-cycled posture
   * means entry1's result stays in the arena until the host asks for a
   * reset, which this probe never does. */
  if (setjmp(trap_jmp) == 0) {
    kc_entry2(9);
    printf("UNREACHABLE\n");
  } else {
    printf("survived, sink_calls=%d\n", sink_calls);
  }

  /* THE ASSERTION: entry1's result is STILL READABLE, unchanged, after
   * entry2's trap and its #147 live-set sweep. Read through memcpy into a
   * host buffer rather than printf's `%.*s` directly on `s`: on this libc,
   * vfprintf's precision-bounded %s copy is an internal, uninstrumented
   * read (not a publicly-interposed symbol), so a mutated build that
   * actually frees this string (M-5b: DROP removed) would print the
   * stale-but-unoverwritten bytes with NO AddressSanitizer report — a
   * silent false pass. memcpy IS an interposed symbol ASan always checks,
   * so this read is the one that actually stands watch (delta-13,
   * measured: freed by scr_library_live_sweep, allocated by
   * scr_str_concat, reddens as a clean heap-use-after-free under the
   * mutation; this negative control — DROP intact — exits 0). */
  if (n >= 256) { fprintf(stderr, "canary too small\n"); return 2; }
  {
    char canary[256];
    memcpy(canary, s, n);
    canary[n] = '\0';
    printf("entry1 (after trap): %s\n", canary);
  }
  return 0;
}
