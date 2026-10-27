/* The native runner's driver (native-runner phase N0): instantiate the
 * translated module, run `_start`, then pump `_tick` / `_loop` as abi.ts's
 * host contract says — with a REAL clock: the host sleeps (nanosleep) until
 * the next deadline the module answers, it never spins — and exit with the
 * program's status: 0, `_status()` for a top-level-await module, the code
 * a `tsinter.exit` import was given, or 1 for a trap.
 *
 * The program runs on its own thread with a large stack (deep recursion
 * that fits Node's stack fits here; past it the guard page is a stack
 * overflow trap — SEMANTICS.md S117 (b)), and the collector scans that
 * thread's stack. Faults are
 * classified: an access inside a linear memory's reservation is wasm's
 * "memory access out of bounds" trap; one in the stack's guard region is a
 * stack overflow; anything else is a runner bug and says so (exit 70).
 * A trap's text is V8's wording (SEMANTICS.md S117 (d)). */
#define _GNU_SOURCE
#include <errno.h>
#include <math.h>
#include <pthread.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>

#include "wn_rt.h"

void host_setup(int argc, char **argv);
double host_now(void);
void host_sleep(double ms);
void w_gc_set_stack_top(void *top);

#define MEM_RESERVE ((size_t)8 << 30)
#define STACK_BYTES ((size_t)512 << 20)

static uint8_t *mems[8];
static int nmems;
static uintptr_t stack_lo, stack_hi;

static void say(const char *s) { (void)!write(2, s, strlen(s)); }

_Noreturn void w_trap(int kind) {
  static const char *const msg[] = {
      [W_TRAP_UNREACHABLE] = NULL,
      [W_TRAP_NULL] = "RuntimeError: dereferencing a null pointer\n",
      [W_TRAP_BOUNDS] = "RuntimeError: array element access out of bounds\n",
      [W_TRAP_DIV0] = "RuntimeError: divide by zero\n",
      [W_TRAP_IOVF] = "RuntimeError: divide result unrepresentable\n",
      [W_TRAP_CONV] = "RuntimeError: float unrepresentable in integer range\n",
      [W_TRAP_REM0] = "RuntimeError: remainder by zero\n",
      [W_TRAP_DATA] = "RuntimeError: data segment out of bounds\n",
      [W_TRAP_ARRAY_SIZE] = "RuntimeError: requested new array is too large\n",
      [W_TRAP_CAST] = "RuntimeError: illegal cast\n",
      [W_TRAP_MEM] = "RuntimeError: memory access out of bounds\n",
      [W_TRAP_TABLE] = "RuntimeError: table index is out of bounds\n",
      [W_TRAP_SIG] = "RuntimeError: null function or function signature mismatch\n",
      [W_TRAP_OOM] = "RuntimeError: requested allocation is too large\n",
      [W_TRAP_STACK] = "RangeError: Maximum call stack size exceeded\n",
  };
  if (kind >= 0 && kind < (int)(sizeof msg / sizeof msg[0]) && msg[kind] != NULL) say(msg[kind]);
  exit(1);
}

uint8_t *w_mem_reserve(uint32_t pages) {
  uint8_t *p = mmap(NULL, MEM_RESERVE, PROT_NONE, MAP_PRIVATE | MAP_ANONYMOUS | MAP_NORESERVE, -1, 0);
  if (p == MAP_FAILED) {
    say("native runner: cannot reserve linear memory\n");
    exit(70);
  }
  if (pages && mprotect(p, (size_t)pages << 16, PROT_READ | PROT_WRITE) != 0) {
    say("native runner: cannot commit linear memory\n");
    exit(70);
  }
  if (nmems < 8) mems[nmems++] = p;
  return p;
}

int32_t w_mem_grow(uint8_t **base, uint32_t *pages, int32_t delta, uint32_t max) {
  uint32_t old = *pages, d = (uint32_t)delta;
  if ((uint64_t)old + d > max || (uint64_t)old + d > 65536) return -1;
  if (d && mprotect(*base + ((size_t)old << 16), (size_t)d << 16, PROT_READ | PROT_WRITE) != 0) return -1;
  *pages = old + d;
  return (int32_t)old;
}

static void on_fault(int sig, siginfo_t *si, void *ctx) {
  (void)ctx;
  if (si->si_code <= 0) {
    /* sent, not raised by an access (process.kill(process.pid, "SIGSEGV")):
     * die of it as Node does (status 128 + signal) */
    signal(sig, SIG_DFL);
    raise(sig);
    return;
  }
  uintptr_t a = (uintptr_t)si->si_addr;
  for (int k = 0; k < nmems; k++)
    if (a >= (uintptr_t)mems[k] && a < (uintptr_t)mems[k] + MEM_RESERVE) {
      say("RuntimeError: memory access out of bounds\n");
      _exit(1);
    }
  if (stack_lo != 0 && a >= stack_lo - ((uintptr_t)1 << 20) && a < stack_lo + ((uintptr_t)1 << 16)) {
    say("RangeError: Maximum call stack size exceeded\n");
    _exit(1);
  }
  say("native runner: internal fault (a runner bug, not the program's)\n");
  _exit(70);
}

/* each thread its own alternate stack (the handler runs on it) */
static void install_fault_handler(char *alt, size_t n) {
  stack_t ss = {.ss_sp = alt, .ss_size = n};
  sigaltstack(&ss, NULL);
  struct sigaction sa;
  memset(&sa, 0, sizeof sa);
  sa.sa_sigaction = on_fault;
  sa.sa_flags = SA_ONSTACK | SA_SIGINFO;
  sigaction(SIGSEGV, &sa, NULL);
  sigaction(SIGBUS, &sa, NULL);
}

static int status;

static void *run(void *arg) {
  (void)arg;
  /* the collector's stack bound: this frame and everything it calls */
  volatile char top_marker = 0;
  w_gc_set_stack_top((void *)(&top_marker + 64));
  static char alt[1 << 16];
  install_fault_handler(alt, sizeof alt);
  w_init();
  w_export__start();
  if (w_has__tick) {
    double now = host_now();
    for (;;) {
      double due = w_export__tick(now);
      if (due < 0) break;
      now = host_now();
      if (due > now) {
        host_sleep(due - now);
        now = host_now();
        if (now < due) now = due;
      }
    }
  } else if (w_has__loop) {
    double now = host_now();
    for (;;) {
      double due = w_export__loop(now);
      if (due < 0) break;
      if (isinf(due)) {
        say("native runner: the module waits for an event no source can deliver\n");
        status = 70;
        return NULL;
      }
      now = host_now();
      if (due > now) {
        host_sleep(due - now);
        now = host_now();
        if (now < due) now = due;
      }
    }
  }
  status = w_has__status ? (int)w_export__status() : 0;
  return NULL;
}

int main(int argc, char **argv) {
  host_setup(argc, argv);
  signal(SIGPIPE, SIG_IGN);
  pthread_attr_t at;
  pthread_attr_init(&at);
  pthread_attr_setstacksize(&at, STACK_BYTES);
  void *stk = mmap(NULL, STACK_BYTES, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS | MAP_NORESERVE | MAP_STACK, -1, 0);
  if (stk == MAP_FAILED) {
    say("native runner: cannot map the program stack\n");
    return 70;
  }
  /* the lowest 64 KiB is the guard: an overflow faults there */
  mprotect(stk, (size_t)1 << 16, PROT_NONE);
  stack_lo = (uintptr_t)stk + ((uintptr_t)1 << 16);
  stack_hi = (uintptr_t)stk + STACK_BYTES;
  pthread_attr_setstack(&at, stk, STACK_BYTES);
  static char alt_main[1 << 16];
  install_fault_handler(alt_main, sizeof alt_main);
  pthread_t th;
  if (pthread_create(&th, &at, run, NULL) != 0) {
    say("native runner: cannot start the program thread\n");
    return 70;
  }
  /* the program thread is the process to the outside: a signal sent to the
   * process (process.kill(process.pid, ...)) must reach IT, at once, as it
   * reaches Node's one JS thread — so this waiting thread takes none */
  sigset_t all;
  sigfillset(&all);
  pthread_sigmask(SIG_BLOCK, &all, NULL);
  pthread_join(th, NULL);
  return status;
}
