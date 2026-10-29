/* The native runner's host: abi.ts's `tsinter` imports over the OS
 * (native-runner phase N0). One C function per import, named host_<import>
 * with exactly the C types backend/wasm2c.ts declares from the wasm
 * signature (i32 → int32_t, i64 → int64_t, f64 → double); the import list
 * and signatures this file provides are backend/wasm-native.ts's
 * NATIVE_HOST_IMPORTS, and a module importing anything else is refused at
 * build time, by name, never linked against a stub.
 *
 * Module memory: every pointer argument is an offset into the module's
 * exported memory (wn_main.c sets w_hostmem once; the base never moves).
 * Strings cross as UTF-16LE code units (abi.ts), so this file carries the
 * UTF-8 <-> UTF-16 transcoders: decoding replaces each maximal ill-formed
 * subpart with U+FFFD (V8's and WHATWG's rule), encoding replaces a lone
 * surrogate with U+FFFD (what Node does to a path or a string it writes).
 *
 * This unit provides the process, clock, randomness, file-system, zone and
 * sleep imports; what a native process answers differently from Node (argv,
 * execPath, versions, a real clock) is SEMANTICS.md S117 (a). The event
 * sources (phase N1) are the other units' — wn_ev.c (evPoll, sigCall,
 * watchCall, stdinCall), wn_cp.c (cpCall), wn_net.c (netCall), wn_tls.c
 * (tlsCall), wn_fetch.c (fetch) — over the shared declarations in
 * wn_host.h. */
#define _GNU_SOURCE
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <ftw.h>
#include <ifaddrs.h>
#include <limits.h>
#include <math.h>
#include <net/if.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <netpacket/packet.h>
#include <pwd.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/random.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <sys/sysinfo.h>
#include <sys/types.h>
#include <sys/utsname.h>
#include <time.h>
#include <unistd.h>

#include "wn_rt.h"
#include "../scr_zone_names.h"
#include "wn_os_names.h"

extern char **environ;

uint8_t *w_hostmem;
static int g_argc;
static char **g_argv;
static struct timespec t_start;

void host_setup(int argc, char **argv) {
  g_argc = argc;
  g_argv = argv;
  clock_gettime(CLOCK_MONOTONIC, &t_start);
}
/* the invocation's argv[0], as a native process names itself in a
 * start-up error (wn_trust.c) */
const char *wn_host_argv0(void) { return g_argc > 0 && g_argv[0] ? g_argv[0] : "scriptc"; }

/* ── growable byte buffer ─────────────────────────────────────────────── */
typedef struct {
  char *p;
  size_t n, cap;
} Buf;
static void buf_put(Buf *b, const void *s, size_t n) {
  if (b->n + n + 1 > b->cap) {
    size_t c = b->cap ? b->cap : 256;
    while (c < b->n + n + 1) c *= 2;
    b->p = realloc(b->p, c);
    if (!b->p) abort();
    b->cap = c;
  }
  memcpy(b->p + b->n, s, n);
  b->n += n;
  b->p[b->n] = 0;
}
static void buf_str(Buf *b, const char *s) { buf_put(b, s, strlen(s)); }
static void buf_chr(Buf *b, char c) { buf_put(b, &c, 1); }

/* ── UTF-8 → UTF-16 (maximal-subpart replacement) ─────────────────────── */
size_t wn_utf8_to_16(const uint8_t *s, size_t n, uint16_t *out) {
  size_t len = 0, i = 0;
  while (i < n) {
    uint32_t c = s[i];
    if (c < 0x80) {
      if (out) out[len] = (uint16_t)c;
      len++;
      i++;
      continue;
    }
    size_t need;
    uint32_t lo = 0x80, hi = 0xbf;
    if (c >= 0xc2 && c <= 0xdf) need = 1, c &= 0x1f;
    else if (c >= 0xe0 && c <= 0xef) {
      need = 2;
      if (c == 0xe0) lo = 0xa0;
      if (c == 0xed) hi = 0x9f;
      c &= 0x0f;
    } else if (c >= 0xf0 && c <= 0xf4) {
      need = 3;
      if (c == 0xf0) lo = 0x90;
      if (c == 0xf4) hi = 0x8f;
      c &= 0x07;
    } else {
      if (out) out[len] = 0xfffd;
      len++;
      i++;
      continue;
    }
    size_t j = 1;
    for (; j <= need; j++) {
      if (i + j >= n) break;
      uint32_t b = s[i + j];
      if (b < lo || b > hi) break;
      lo = 0x80;
      hi = 0xbf;
      c = (c << 6) | (b & 0x3f);
    }
    if (j <= need) {
      if (out) out[len] = 0xfffd;
      len++;
      i += j;
      continue;
    }
    i += need + 1;
    if (c >= 0x10000) {
      if (out) {
        out[len] = (uint16_t)(0xd800 + ((c - 0x10000) >> 10));
        out[len + 1] = (uint16_t)(0xdc00 + ((c - 0x10000) & 0x3ff));
      }
      len += 2;
    } else {
      if (out) out[len] = (uint16_t)c;
      len++;
    }
  }
  return len;
}

/* ── UTF-16 (module memory) → UTF-8, NUL-terminated, malloc'd ────────── */
char *wn_utf16_to_8(uint32_t ptr, uint32_t n, size_t *outlen) {
  const uint8_t *p = w_hostmem + ptr;
  char *o = malloc((size_t)n * 3 + 1);
  if (!o) abort();
  size_t k = 0;
  for (uint32_t i = 0; i < n; i++) {
    uint32_t c = (uint32_t)p[2 * i] | ((uint32_t)p[2 * i + 1] << 8);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < n) {
      uint32_t d = (uint32_t)p[2 * i + 2] | ((uint32_t)p[2 * i + 3] << 8);
      if (d >= 0xdc00 && d <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
        i++;
      } else
        c = 0xfffd;
    } else if (c >= 0xd800 && c <= 0xdfff)
      c = 0xfffd;
    if (c < 0x80) o[k++] = (char)c;
    else if (c < 0x800) {
      o[k++] = (char)(0xc0 | (c >> 6));
      o[k++] = (char)(0x80 | (c & 0x3f));
    } else if (c < 0x10000) {
      o[k++] = (char)(0xe0 | (c >> 12));
      o[k++] = (char)(0x80 | ((c >> 6) & 0x3f));
      o[k++] = (char)(0x80 | (c & 0x3f));
    } else {
      o[k++] = (char)(0xf0 | (c >> 18));
      o[k++] = (char)(0x80 | ((c >> 12) & 0x3f));
      o[k++] = (char)(0x80 | ((c >> 6) & 0x3f));
      o[k++] = (char)(0x80 | (c & 0x3f));
    }
  }
  o[k] = 0;
  if (outlen) *outlen = k;
  return o;
}

/* hostStr's retry contract: write the UTF-16 of `s` (n bytes of UTF-8) at
 * ptr when it fits in cap code units; answer its length either way */
static int32_t put_utf8(const char *s, size_t n, uint32_t ptr, uint32_t cap) {
  size_t len = wn_utf8_to_16((const uint8_t *)s, n, NULL);
  if (len > cap) return (int32_t)len;
  uint16_t *tmp = malloc(len * 2 + 2);
  if (!tmp) abort();
  wn_utf8_to_16((const uint8_t *)s, n, tmp);
  memcpy(w_hostmem + ptr, tmp, len * 2);
  free(tmp);
  return (int32_t)len;
}
static int32_t put_str(const char *s, uint32_t ptr, uint32_t cap) { return put_utf8(s, strlen(s), ptr, cap); }

/* ── write / clocks / randomness / exit / sleep ───────────────────────── */
void host_write(int32_t fd, int32_t ptr, int32_t len) {
  const uint8_t *p = w_hostmem + (uint32_t)ptr;
  size_t left = (uint32_t)len;
  while (left) {
    ssize_t w = write(fd, p, left);
    if (w < 0) {
      if (errno == EINTR) continue;
      if (errno == EAGAIN) {
        /* a non-blocking descriptor we inherited: wait until writable */
        fd_set s;
        FD_ZERO(&s);
        FD_SET(fd, &s);
        select(fd + 1, NULL, &s, NULL, NULL);
        continue;
      }
      return; /* EPIPE and friends: Node drops the write too */
    }
    p += w;
    left -= (size_t)w;
  }
}

double host_now(void) {
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return (double)(t.tv_sec - t_start.tv_sec) * 1e3 + (double)(t.tv_nsec - t_start.tv_nsec) / 1e6;
}

int64_t host_seed(void) {
  uint64_t s;
  if (getrandom(&s, sizeof s, 0) != (ssize_t)sizeof s) s = (uint64_t)time(NULL) ^ ((uint64_t)getpid() << 32);
  return (int64_t)s;
}

double host_wallClock(void) {
  struct timespec t;
  clock_gettime(CLOCK_REALTIME, &t);
  return (double)t.tv_sec * 1e3 + (double)t.tv_nsec / 1e6;
}

void host_random(int32_t ptr, int32_t len) {
  size_t got = 0, n = (uint32_t)len;
  while (got < n) {
    ssize_t r = getrandom(w_hostmem + (uint32_t)ptr + got, n - got, 0);
    if (r > 0) got += (size_t)r;
    else if (errno != EINTR) abort();
  }
}

void host_exit(int32_t code) { exit(code); }

/* abi.ts sleep: block for ms (a real nanosleep, resumed across EINTR —
 * never a spin on the clock); +Infinity blocks forever, as Node does */
void host_sleep(double ms) {
  if (!(ms > 0)) return;
  if (!isfinite(ms)) {
    for (;;) pause();
  }
  struct timespec t = {(time_t)(ms / 1000), (long)(fmod(ms, 1000) * 1e6)};
  while (nanosleep(&t, &t) != 0 && errno == EINTR) {
  }
}

/* ── process facts: hostStr / hostNum ─────────────────────────────────── */
static int env_count(void) {
  int n = 0;
  while (environ[n]) n++;
  return n;
}

static void json_str(Buf *b, const char *s) {
  /* JSON.stringify of a UTF-8 string (ASCII escapes; other text as is) */
  buf_chr(b, '"');
  for (const unsigned char *p = (const unsigned char *)s; *p; p++) {
    unsigned c = *p;
    if (c == '"') buf_str(b, "\\\"");
    else if (c == '\\') buf_str(b, "\\\\");
    else if (c == '\b') buf_str(b, "\\b");
    else if (c == '\f') buf_str(b, "\\f");
    else if (c == '\n') buf_str(b, "\\n");
    else if (c == '\r') buf_str(b, "\\r");
    else if (c == '\t') buf_str(b, "\\t");
    else if (c < 0x20) {
      char e[8];
      snprintf(e, sizeof e, "\\u%04x", c);
      buf_str(b, e);
    } else
      buf_chr(b, (char)c);
  }
  buf_chr(b, '"');
}

/* os.networkInterfaces() as JSON, Node's shape and order (libuv's
 * uv_interface_addresses: getifaddrs order, up-and-running interfaces'
 * IPv4/IPv6 addresses, the MAC from the interface's AF_PACKET entry) */
static char *net_ifaces_json(void) {
  struct ifaddrs *ifs = NULL;
  Buf b = {0};
  buf_chr(&b, '{');
  if (getifaddrs(&ifs) != 0) {
    buf_chr(&b, '}');
    return b.p;
  }
  /* names in first-appearance order */
  const char *names[256];
  int nn = 0;
  for (struct ifaddrs *a = ifs; a; a = a->ifa_next) {
    if (!a->ifa_addr || !(a->ifa_flags & IFF_UP) || !(a->ifa_flags & IFF_RUNNING)) continue;
    int fam = a->ifa_addr->sa_family;
    if (fam != AF_INET && fam != AF_INET6) continue;
    int seen = 0;
    for (int k = 0; k < nn; k++)
      if (strcmp(names[k], a->ifa_name) == 0) seen = 1;
    if (!seen && nn < 256) names[nn++] = a->ifa_name;
  }
  for (int k = 0; k < nn; k++) {
    if (k) buf_chr(&b, ',');
    json_str(&b, names[k]);
    buf_str(&b, ":[");
    char mac[18] = "00:00:00:00:00:00";
    for (struct ifaddrs *a = ifs; a; a = a->ifa_next) {
      if (a->ifa_addr && a->ifa_addr->sa_family == AF_PACKET && strcmp(a->ifa_name, names[k]) == 0) {
        struct sockaddr_ll *s = (struct sockaddr_ll *)(void *)a->ifa_addr;
        snprintf(mac, sizeof mac, "%02x:%02x:%02x:%02x:%02x:%02x", s->sll_addr[0], s->sll_addr[1], s->sll_addr[2], s->sll_addr[3], s->sll_addr[4], s->sll_addr[5]);
      }
    }
    int first = 1;
    for (struct ifaddrs *a = ifs; a; a = a->ifa_next) {
      if (!a->ifa_addr || !(a->ifa_flags & IFF_UP) || !(a->ifa_flags & IFF_RUNNING) || strcmp(a->ifa_name, names[k]) != 0) continue;
      int fam = a->ifa_addr->sa_family;
      if (fam != AF_INET && fam != AF_INET6) continue;
      char addr[INET6_ADDRSTRLEN] = "", mask[INET6_ADDRSTRLEN] = "";
      int bits = 0;
      unsigned scope = 0;
      if (fam == AF_INET) {
        struct sockaddr_in *s = (struct sockaddr_in *)(void *)a->ifa_addr, *m = (struct sockaddr_in *)(void *)a->ifa_netmask;
        inet_ntop(AF_INET, &s->sin_addr, addr, sizeof addr);
        if (m) {
          inet_ntop(AF_INET, &m->sin_addr, mask, sizeof mask);
          bits = __builtin_popcount(m->sin_addr.s_addr);
        }
      } else {
        struct sockaddr_in6 *s = (struct sockaddr_in6 *)(void *)a->ifa_addr, *m = (struct sockaddr_in6 *)(void *)a->ifa_netmask;
        inet_ntop(AF_INET6, &s->sin6_addr, addr, sizeof addr);
        scope = s->sin6_scope_id;
        if (m) {
          inet_ntop(AF_INET6, &m->sin6_addr, mask, sizeof mask);
          for (int q = 0; q < 16; q++) bits += __builtin_popcount(m->sin6_addr.s6_addr[q]);
        }
      }
      if (!first) buf_chr(&b, ',');
      first = 0;
      char tail[64];
      buf_str(&b, "{\"address\":");
      json_str(&b, addr);
      buf_str(&b, ",\"netmask\":");
      json_str(&b, mask);
      buf_str(&b, fam == AF_INET ? ",\"family\":\"IPv4\",\"mac\":" : ",\"family\":\"IPv6\",\"mac\":");
      json_str(&b, mac);
      buf_str(&b, (a->ifa_flags & IFF_LOOPBACK) ? ",\"internal\":true,\"cidr\":" : ",\"internal\":false,\"cidr\":");
      snprintf(tail, sizeof tail, "/%d", bits);
      char cidr[INET6_ADDRSTRLEN + 8];
      snprintf(cidr, sizeof cidr, "%s%s", addr, tail);
      json_str(&b, cidr);
      if (fam == AF_INET6) {
        snprintf(tail, sizeof tail, ",\"scopeid\":%u", scope);
        buf_str(&b, tail);
      }
      buf_chr(&b, '}');
    }
    buf_chr(&b, ']');
  }
  buf_chr(&b, '}');
  freeifaddrs(ifs);
  return b.p;
}

static char *exec_path(void) {
  static char p[PATH_MAX];
  if (!p[0]) {
    ssize_t n = readlink("/proc/self/exe", p, sizeof p - 1);
    if (n < 0) n = 0;
    p[n] = 0;
  }
  return p;
}

int32_t host_hostStr(int32_t kind, int32_t index, int32_t ptr, int32_t cap) {
  uint32_t P = (uint32_t)ptr, CAP = (uint32_t)cap;
  switch (kind) {
    case 0: /* argv = ["scriptc", <the invocation>, ...args] (SEMANTICS.md S070) */
      if (index < 0 || index >= g_argc + 1) return -1;
      return put_str(index == 0 ? "scriptc" : g_argv[index - 1], P, CAP);
    case 1:
    case 2: {
      if (index < 0 || index >= env_count()) return -1;
      const char *e = environ[index];
      const char *eq = strchr(e, '=');
      if (kind == 2) return put_str(eq ? eq + 1 : "", P, CAP);
      return put_utf8(e, eq ? (size_t)(eq - e) : strlen(e), P, CAP);
    }
    case 3: {
      char b[PATH_MAX];
      return put_str(getcwd(b, sizeof b) ? b : "", P, CAP);
    }
    case 4: /* process.platform: the OS this host runs on (S118) */
#if defined(__linux__)
      return put_str("linux", P, CAP);
#elif defined(__APPLE__)
      return put_str("darwin", P, CAP);
#elif defined(_WIN32)
      return put_str("win32", P, CAP);
#else
#error "the native runner's host knows linux, darwin and win32"
#endif
    case 5:
#if defined(__x86_64__)
      return put_str("x64", P, CAP);
#elif defined(__aarch64__)
      return put_str("arm64", P, CAP);
#else
      return put_str("unknown", P, CAP);
#endif
    case 6: /* SEMANTICS.md S072: the compatibility target, not a live version */
      return put_str("24.0.0", P, CAP);
    case 7:
      return put_str("3.5.5", P, CAP);
    case 8: { /* os.tmpdir(): TMPDIR, TMP, TEMP, /tmp; one trailing slash dropped */
      const char *t = getenv("TMPDIR");
      if (!t || !*t) t = getenv("TMP");
      if (!t || !*t) t = getenv("TEMP");
      if (!t || !*t) t = "/tmp";
      char b[PATH_MAX];
      snprintf(b, sizeof b, "%s", t);
      size_t n = strlen(b);
      if (n > 1 && b[n - 1] == '/') b[n - 1] = 0;
      return put_str(b, P, CAP);
    }
    case 9: { /* os.homedir(): HOME, else the password database */
      const char *h = getenv("HOME");
      if (!h || !*h) {
        struct passwd *pw = getpwuid(getuid());
        h = pw ? pw->pw_dir : "";
      }
      return put_str(h, P, CAP);
    }
    case 10:
    case 11: {
      struct utsname u;
      if (uname(&u) != 0) return put_str("", P, CAP);
      return put_str(kind == 10 ? u.sysname : u.release, P, CAP);
    }
    case 12: /* SEMANTICS.md S071: the binary's own resolved path */
      return put_str(exec_path(), P, CAP);
    case 13:
    case 14:
    case 15: {
      struct passwd *pw = getpwuid(getuid());
      if (!pw) return put_str("", P, CAP);
      return put_str(kind == 13 ? pw->pw_name : kind == 14 ? pw->pw_dir : (pw->pw_shell ? pw->pw_shell : ""), P, CAP);
    }
    case 16: {
      static char *snap; /* one snapshot per run, as the harness host */
      if (!snap) snap = net_ifaces_json();
      return put_str(snap, P, CAP);
    }
    case 17:
      return put_str(strerror(index), P, CAP);
    default:
      fprintf(stderr, "native runner: hostStr kind %d is not part of the host contract\n", kind);
      exit(70);
  }
}

static double read_meminfo(const char *key) {
  FILE *f = fopen("/proc/meminfo", "r");
  if (!f) return 0;
  char line[256];
  double v = 0;
  size_t kl = strlen(key);
  while (fgets(line, sizeof line, f)) {
    if (strncmp(line, key, kl) == 0 && line[kl] == ':') {
      v = strtod(line + kl + 1, NULL) * 1024;
      break;
    }
  }
  fclose(f);
  return v;
}

/* cgroup v2 memory limit (bytes), or UINT64_MAX when unconstrained */
static double cgroup_limit(void) {
  FILE *f = fopen("/proc/self/cgroup", "r");
  char line[PATH_MAX], path[PATH_MAX + 64];
  double lim = 18446744073709551615.0;
  if (!f) return lim;
  while (fgets(line, sizeof line, f)) {
    if (strncmp(line, "0::", 3) != 0) continue;
    line[strcspn(line, "\n")] = 0;
    snprintf(path, sizeof path, "/sys/fs/cgroup%s/memory.max", line + 3);
    FILE *g = fopen(path, "r");
    if (g) {
      char v[64] = "";
      if (fgets(v, sizeof v, g) && strncmp(v, "max", 3) != 0) lim = strtod(v, NULL);
      fclose(g);
    }
  }
  fclose(f);
  return lim;
}

static double tv_us(struct timeval t) { return (double)t.tv_sec * 1e6 + (double)t.tv_usec; }

double host_hostNum(int32_t kind, int32_t arg) {
  struct rusage ru;
  switch (kind) {
    case 0:
      return g_argc + 1;
    case 1:
      return env_count();
    case 2:
      return getpid();
    case 3:
      return getuid();
    case 4:
      return getgid();
    case 5:
      return isatty(arg) ? 1 : 0;
    case 6: {
      struct winsize w;
      if (isatty(arg) && ioctl(arg, TIOCGWINSZ, &w) == 0 && w.ws_col > 0) return w.ws_col;
      return -1;
    }
    case 7:
      return host_now() / 1000;
    case 8:
    case 9:
      getrusage(RUSAGE_SELF, &ru);
      return tv_us(kind == 8 ? ru.ru_utime : ru.ru_stime);
    case 10:
    case 11:
      getrusage(RUSAGE_THREAD, &ru);
      return tv_us(kind == 10 ? ru.ru_utime : ru.ru_stime);
    case 12: {
      double avail = read_meminfo("MemAvailable");
      double lim = cgroup_limit();
      return lim < avail ? lim : avail;
    }
    case 13:
      return cgroup_limit();
    case 14: {
      getrusage(RUSAGE_SELF, &ru);
      const double f[16] = {tv_us(ru.ru_utime), tv_us(ru.ru_stime), (double)ru.ru_maxrss, (double)ru.ru_ixrss, (double)ru.ru_idrss, (double)ru.ru_isrss,
                            (double)ru.ru_minflt, (double)ru.ru_majflt, (double)ru.ru_nswap, (double)ru.ru_inblock, (double)ru.ru_oublock, (double)ru.ru_msgsnd,
                            (double)ru.ru_msgrcv, (double)ru.ru_nsignals, (double)ru.ru_nvcsw, (double)ru.ru_nivcsw};
      return arg >= 0 && arg < 16 ? f[arg] : 0;
    }
    case 15: {
      struct sysinfo si;
      if (sysinfo(&si) != 0) return 0;
      return (double)si.totalram * si.mem_unit;
    }
    /* SEMANTICS.md S118: the module keeps names, the host answers its OS's
     * numbers (wn_os_names.h, generated with the module's os-names.ts) */
    case 16:
      return arg >= 0 && arg < WN_NSIGNALS ? wn_signal_numbers[arg] : 0;
    case 17:
      return arg >= 0 && arg < WN_NERRNOS ? wn_errno_numbers[arg] : 0;
    case 18: /* the host's OS: 0 linux, 1 darwin, 2 win32, 3 other */
#if defined(__linux__)
      return 0;
#elif defined(__APPLE__)
      return 1;
#elif defined(_WIN32)
      return 2;
#else
      return 3;
#endif
    default:
      fprintf(stderr, "native runner: hostNum kind %d is not part of the host contract\n", kind);
      exit(70);
  }
}

/* ── kill / chdir / umask ─────────────────────────────────────────────── */
int32_t host_kill(int32_t pid, int32_t sig) {
  if (kill(pid, sig) == 0) return 0;
  if (errno == ESRCH) return -1;
  if (errno == EPERM) return -2;
  if (errno == EINVAL) return -3;
  return -(256 + errno);
}

int32_t host_chdir(int32_t ptr, int32_t len) {
  char *p = wn_utf16_to_8((uint32_t)ptr, (uint32_t)len, NULL);
  int rc = chdir(p);
  int e = errno;
  free(p);
  if (rc == 0) return 0;
  switch (e) {
    case ENOENT: return -1;
    case ENOTDIR: return -2;
    case EACCES: return -3;
    case ENAMETOOLONG: return -4;
    case ELOOP: return -5;
    case EIO: return -6;
    case ENOMEM: return -7;
    case EPERM: return -8;
    default: return -(256 + e);
  }
}

int32_t host_umask(int32_t isRead, int32_t mask) {
  mode_t old;
  if (isRead) {
    old = umask(0);
    umask(old);
  } else
    old = umask((mode_t)(uint32_t)mask);
  return (int32_t)old;
}

/* ── fsCall ───────────────────────────────────────────────────────────── */
/* the module's own errno enumeration (fs.ts), else the 256-based carrier */
int32_t wn_fs_err(int e) {
  static const int order[] = {ENOENT, EEXIST, EACCES, ENOTDIR, EISDIR, ENOTEMPTY, EPERM, EBADF, EMFILE, ENOSPC, EINVAL, EROFS, ELOOP, ENAMETOOLONG};
  for (int i = 0; i < 14; i++)
    if (order[i] == e) return -(i + 1);
  return -(256 + e);
}

/* reads a whole descriptor from its current position */
static int read_all(int fd, uint8_t **out, size_t *n) {
  size_t cap = 65536, len = 0;
  uint8_t *b = malloc(cap);
  if (!b) abort();
  for (;;) {
    if (len == cap) {
      cap *= 2;
      b = realloc(b, cap);
      if (!b) abort();
    }
    ssize_t r = read(fd, b + len, cap - len);
    if (r == 0) break;
    if (r < 0) {
      if (errno == EINTR) continue;
      int e = errno;
      free(b);
      return e;
    }
    len += (size_t)r;
  }
  *out = b;
  *n = len;
  return 0;
}

/* text or bytes into slot B, read-shaped (the retry contract) */
static int32_t put_content(const uint8_t *b, size_t n, int bytes, uint32_t bPtr, uint32_t bLen) {
  if (bytes) {
    if (n <= bLen) memcpy(w_hostmem + bPtr, b, n);
    return (int32_t)n;
  }
  size_t len = wn_utf8_to_16(b, n, NULL);
  if (len <= bLen) {
    uint16_t *tmp = malloc(len * 2 + 2);
    if (!tmp) abort();
    wn_utf8_to_16(b, n, tmp);
    memcpy(w_hostmem + bPtr, tmp, len * 2);
    free(tmp);
  }
  return (int32_t)len;
}

static int str_cmp(const void *a, const void *b) { return strcmp(*(char *const *)a, *(char *const *)b); }

/* JSON of a UTF-8 file name, as JSON.stringify writes the string Node
 * decoded from it */
static void json_name(Buf *b, const char *name) {
  size_t n = strlen(name);
  size_t len = wn_utf8_to_16((const uint8_t *)name, n, NULL);
  uint16_t *u = malloc(len * 2 + 2);
  if (!u) abort();
  wn_utf8_to_16((const uint8_t *)name, n, u);
  buf_chr(b, '"');
  for (size_t i = 0; i < len; i++) {
    uint32_t c = u[i];
    char e[16];
    if (c == '"') buf_str(b, "\\\"");
    else if (c == '\\') buf_str(b, "\\\\");
    else if (c == '\b') buf_str(b, "\\b");
    else if (c == '\f') buf_str(b, "\\f");
    else if (c == '\n') buf_str(b, "\\n");
    else if (c == '\r') buf_str(b, "\\r");
    else if (c == '\t') buf_str(b, "\\t");
    else if (c < 0x20) {
      snprintf(e, sizeof e, "\\u%04x", c);
      buf_str(b, e);
    } else if (c >= 0xd800 && c <= 0xdfff) {
      /* a pair re-encodes as UTF-8; a lone surrogate is \u-escaped */
      if (c <= 0xdbff && i + 1 < len && u[i + 1] >= 0xdc00 && u[i + 1] <= 0xdfff) {
        uint32_t cp = 0x10000 + ((c - 0xd800) << 10) + (u[i + 1] - 0xdc00u);
        char o[4] = {(char)(0xf0 | (cp >> 18)), (char)(0x80 | ((cp >> 12) & 0x3f)), (char)(0x80 | ((cp >> 6) & 0x3f)), (char)(0x80 | (cp & 0x3f))};
        buf_put(b, o, 4);
        i++;
      } else {
        snprintf(e, sizeof e, "\\u%04x", c);
        buf_str(b, e);
      }
    } else if (c < 0x80)
      buf_chr(b, (char)c);
    else if (c < 0x800) {
      char o[2] = {(char)(0xc0 | (c >> 6)), (char)(0x80 | (c & 0x3f))};
      buf_put(b, o, 2);
    } else {
      char o[3] = {(char)(0xe0 | (c >> 12)), (char)(0x80 | ((c >> 6) & 0x3f)), (char)(0x80 | (c & 0x3f))};
      buf_put(b, o, 3);
    }
  }
  buf_chr(b, '"');
  free(u);
}

/* libuv's dirent type (1 file, 2 dir, 3 link, 4 fifo, 5 socket, 6 char,
 * 7 block, 0 unknown), with lstat for DT_UNKNOWN */
static int dirent_type(const char *dir, struct dirent *d) {
  unsigned t = d->d_type;
  if (t == DT_UNKNOWN) {
    char p[PATH_MAX];
    struct stat st;
    snprintf(p, sizeof p, "%s/%s", dir, d->d_name);
    if (lstat(p, &st) != 0) return 0;
    if (S_ISREG(st.st_mode)) return 1;
    if (S_ISDIR(st.st_mode)) return 2;
    if (S_ISLNK(st.st_mode)) return 3;
    if (S_ISFIFO(st.st_mode)) return 4;
    if (S_ISSOCK(st.st_mode)) return 5;
    if (S_ISCHR(st.st_mode)) return 6;
    if (S_ISBLK(st.st_mode)) return 7;
    return 0;
  }
  switch (t) {
    case DT_REG: return 1;
    case DT_DIR: return 2;
    case DT_LNK: return 3;
    case DT_FIFO: return 4;
    case DT_SOCK: return 5;
    case DT_CHR: return 6;
    case DT_BLK: return 7;
    default: return 0;
  }
}

static int rm_cb(const char *p, const struct stat *sb, int fl, struct FTW *f) {
  (void)sb;
  (void)f;
  return fl == FTW_DP ? rmdir(p) : unlink(p);
}

static int mkdir_p(char *path, mode_t mode) {
  struct stat st;
  if (stat(path, &st) == 0) return S_ISDIR(st.st_mode) ? 0 : (errno = EEXIST, -1);
  for (char *q = path + 1; *q; q++) {
    if (*q != '/') continue;
    *q = 0;
    if (mkdir(path, mode) != 0 && errno != EEXIST) {
      *q = '/';
      return -1;
    }
    if (stat(path, &st) == 0 && !S_ISDIR(st.st_mode)) {
      *q = '/';
      errno = ENOTDIR;
      return -1;
    }
    *q = '/';
  }
  if (mkdir(path, mode) != 0 && errno != EEXIST) return -1;
  return 0;
}

/* path.resolve against the cwd, normalized (no "." / ".." / "//") */
static char *resolve_path(const char *p) {
  Buf b = {0};
  if (p[0] != '/') {
    char cwd[PATH_MAX];
    if (getcwd(cwd, sizeof cwd)) buf_str(&b, cwd);
    buf_chr(&b, '/');
  }
  buf_str(&b, p);
  /* normalize in place */
  char *s = b.p, *out = malloc(b.n + 2);
  if (!out) abort();
  size_t o = 0;
  out[o++] = '/';
  for (char *q = s; *q;) {
    while (*q == '/') q++;
    char *e = q;
    while (*e && *e != '/') e++;
    size_t n = (size_t)(e - q);
    if (n == 0) break;
    if (n == 1 && q[0] == '.') {
    } else if (n == 2 && q[0] == '.' && q[1] == '.') {
      if (o > 1) {
        o--;
        while (o > 1 && out[o - 1] != '/') o--;
        if (o > 1) o--;
        if (o == 0) o = 1;
      }
    } else {
      if (o > 1) out[o++] = '/';
      memcpy(out + o, q, n);
      o += n;
    }
    q = e;
  }
  out[o] = 0;
  free(b.p);
  return out;
}

/* fs.realpathSync: Node's own JS walk (lstat each component, follow links);
 * a failure reports the component path that failed */
static int realpath_walk(const char *input, char **result, char **errpath) {
  char *p = resolve_path(input);
  int links = 0;
  size_t pos;
  Buf cur = {0};
restart:
  free(cur.p);
  cur = (Buf){0};
  buf_chr(&cur, '/');
  pos = 1;
  while (pos < strlen(p)) {
    char *slash = strchr(p + pos, '/');
    size_t end = slash ? (size_t)(slash - p) : strlen(p);
    char *prev = strdup(cur.p);
    Buf base = {0};
    buf_str(&base, cur.p);
    buf_put(&base, p + pos, end - pos);
    buf_put(&cur, p + pos, end - pos);
    if (slash) buf_chr(&cur, '/');
    pos = slash ? end + 1 : end;
    struct stat st;
    if (lstat(base.p, &st) != 0) {
      int e = errno;
      *errpath = strdup(base.p);
      free(base.p);
      free(prev);
      free(cur.p);
      free(p);
      return e;
    }
    if (S_ISLNK(st.st_mode)) {
      if (++links > 40) {
        *errpath = strdup(base.p);
        free(base.p);
        free(prev);
        free(cur.p);
        free(p);
        return ELOOP;
      }
      char target[PATH_MAX];
      ssize_t n = readlink(base.p, target, sizeof target - 1);
      if (n < 0) {
        int e = errno;
        *errpath = strdup(base.p);
        free(base.p);
        free(prev);
        free(cur.p);
        free(p);
        return e;
      }
      target[n] = 0;
      Buf nb = {0};
      if (target[0] != '/') {
        buf_str(&nb, prev);
        buf_chr(&nb, '/');
      }
      buf_str(&nb, target);
      buf_chr(&nb, '/');
      buf_str(&nb, p + pos);
      free(p);
      p = resolve_path(nb.p);
      free(nb.p);
      free(base.p);
      free(prev);
      goto restart;
    }
    free(base.p);
    free(prev);
  }
  free(cur.p);
  *result = p;
  return 0;
}

static int open_flags(int code) {
  switch (code) {
    case 0: return O_RDONLY;
    case 1: return O_RDWR;
    case 2: return O_TRUNC | O_CREAT | O_WRONLY;
    case 3: return O_TRUNC | O_CREAT | O_WRONLY | O_EXCL;
    case 4: return O_TRUNC | O_CREAT | O_RDWR;
    case 5: return O_TRUNC | O_CREAT | O_RDWR | O_EXCL;
    case 6: return O_APPEND | O_CREAT | O_WRONLY;
    case 7: return O_APPEND | O_CREAT | O_WRONLY | O_EXCL;
    case 8: return O_APPEND | O_CREAT | O_RDWR;
    case 9: return O_APPEND | O_CREAT | O_RDWR | O_EXCL;
    default: return -1;
  }
}

static int write_all(int fd, const char *d, size_t n) {
  size_t off = 0;
  while (off < n) {
    ssize_t w = write(fd, d + off, n - off);
    if (w < 0) {
      if (errno == EINTR) continue;
      return errno;
    }
    off += (size_t)w;
  }
  return 0;
}

/* op 5's text read: a read that overshot the module's buffer is held for
 * the retry (the descriptor is already at EOF) */
static int held_fd = -1;
static uint8_t *held_buf;
static size_t held_n;

/* A path is a C string: one holding U+0000 would name a DIFFERENT, shorter
 * path (rmSync("d\0x") removing "d"). The module rejects such a path the
 * way Node does (ERR_INVALID_ARG_VALUE, before any syscall); this is the
 * host's own line behind it — refuse loudly, never act on a cut path. */
static char *path_arg(uint32_t ptr, uint32_t len, const char *what) {
  size_t n;
  char *p = wn_utf16_to_8(ptr, len, &n);
  if (strlen(p) != n) {
    fprintf(stderr, "native runner: %s holding U+0000 reached the host (the module must reject it, as Node does)\n", what);
    exit(70);
  }
  return p;
}

int32_t host_fsCall(int32_t op, int32_t aPtr, int32_t aLen, int32_t bPtr, int32_t bLen, int32_t x, int32_t y) {
  uint32_t B = (uint32_t)bPtr, BL = (uint32_t)bLen;
  char *path = (op == 5 || op == 6 || op == 18 || op == 22 || op == 23) ? NULL : path_arg((uint32_t)aPtr, (uint32_t)aLen, "an fs path");
  int32_t rc = 0;
  switch (op) {
    case 1: {
      int fd = open(path, O_RDONLY | O_CLOEXEC);
      if (fd < 0) {
        rc = wn_fs_err(errno);
        break;
      }
      struct stat st;
      if (fstat(fd, &st) == 0 && S_ISDIR(st.st_mode)) {
        close(fd);
        rc = wn_fs_err(EISDIR);
        break;
      }
      uint8_t *b;
      size_t n;
      int e = read_all(fd, &b, &n);
      close(fd);
      if (e) {
        rc = wn_fs_err(e);
        break;
      }
      rc = put_content(b, n, x == 1, B, BL);
      free(b);
      break;
    }
    case 2: {
      DIR *d = opendir(path);
      if (!d) {
        rc = wn_fs_err(errno);
        break;
      }
      char **names = NULL;
      int *types = NULL;
      size_t n = 0, cap = 0;
      struct dirent *de;
      while ((de = readdir(d)) != NULL) {
        if (strcmp(de->d_name, ".") == 0 || strcmp(de->d_name, "..") == 0) continue;
        if (n == cap) {
          cap = cap ? cap * 2 : 32;
          names = realloc(names, cap * sizeof *names);
          types = realloc(types, cap * sizeof *types);
          if (!names || !types) abort();
        }
        /* the type rides in front of the name so the sort keeps them paired */
        size_t ln = strlen(de->d_name);
        names[n] = malloc(ln + 2);
        if (!names[n]) abort();
        names[n][0] = (char)('0' + dirent_type(path, de));
        memcpy(names[n] + 1, de->d_name, ln + 1);
        n++;
      }
      closedir(d);
      /* libuv's scandir order: strcmp of the names */
      for (size_t i = 0; i < n; i++) names[i]++;
      qsort(names, n, sizeof *names, str_cmp);
      Buf b = {0};
      buf_chr(&b, '[');
      for (size_t i = 0; i < n; i++) {
        if (i) buf_chr(&b, ',');
        if (x == 1) {
          char t[32];
          snprintf(t, sizeof t, "{\"%%dtype\":%d,\"name\":", names[i][-1] - '0');
          buf_str(&b, t);
          json_name(&b, names[i]);
          buf_chr(&b, '}');
        } else
          json_name(&b, names[i]);
        free(names[i] - 1);
      }
      buf_chr(&b, ']');
      free(names);
      free(types);
      rc = put_content((const uint8_t *)b.p, b.n, 0, B, BL);
      free(b.p);
      break;
    }
    case 3: {
      size_t n = strlen(path);
      char *t = malloc(n + 7);
      if (!t) abort();
      memcpy(t, path, n);
      memcpy(t + n, "XXXXXX", 7);
      if (!mkdtemp(t)) rc = wn_fs_err(errno);
      else rc = put_str(t, B, BL);
      free(t);
      break;
    }
    case 4: {
      char *res = NULL, *errp = NULL;
      int e = realpath_walk(path, &res, &errp);
      if (e == 0) {
        rc = put_str(res, B, BL);
        free(res);
      } else {
        /* the failing path: u16 count at slot B, then the code units */
        size_t ln = strlen(errp);
        size_t len = wn_utf8_to_16((const uint8_t *)errp, ln, NULL);
        if (len + 1 > BL) rc = (int32_t)(len + 1);
        else {
          uint16_t *u = malloc(len * 2 + 2);
          if (!u) abort();
          u[0] = (uint16_t)len;
          wn_utf8_to_16((const uint8_t *)errp, ln, u + 1);
          memcpy(w_hostmem + B, u, (len + 1) * 2);
          free(u);
          rc = wn_fs_err(e);
        }
        free(errp);
      }
      break;
    }
    case 5: {
      if (held_fd == x && held_buf) {
        rc = put_content(held_buf, held_n, 0, B, BL);
        if ((uint32_t)rc <= BL) {
          free(held_buf);
          held_buf = NULL;
          held_fd = -1;
        }
        break;
      }
      uint8_t *b;
      size_t n;
      int e = read_all(x, &b, &n);
      if (e) {
        rc = wn_fs_err(e);
        break;
      }
      rc = put_content(b, n, 0, B, BL);
      if ((uint32_t)rc > BL) {
        held_fd = x;
        held_buf = b;
        held_n = n;
      } else
        free(b);
      break;
    }
    case 6:
    case 23: {
      ssize_t r;
      do r = read(x, w_hostmem + B, BL);
      while (r < 0 && errno == EINTR);
      rc = r < 0 ? wn_fs_err(errno) : (int32_t)r;
      break;
    }
    case 7:
    case 8: {
      struct stat st;
      if ((op == 7 ? stat(path, &st) : lstat(path, &st)) != 0) {
        rc = wn_fs_err(errno);
        break;
      }
      uint8_t *p = w_hostmem + B;
      p[0] = S_ISREG(st.st_mode);
      p[1] = S_ISDIR(st.st_mode);
      p[2] = S_ISLNK(st.st_mode);
      p[3] = 0;
      double sz = (double)st.st_size, mt = (double)st.st_mtim.tv_sec * 1e3 + (double)st.st_mtim.tv_nsec / 1e6;
      memcpy(p + 4, &sz, 8);
      memcpy(p + 12, &mt, 8);
      break;
    }
    case 9:
    case 10: {
      int fd = open(path, O_WRONLY | O_CREAT | O_CLOEXEC | (op == 9 ? O_TRUNC : O_APPEND), (op == 9 && x) ? (mode_t)(x - 1) : 0666);
      if (fd < 0) {
        rc = wn_fs_err(errno);
        break;
      }
      size_t n;
      char *data;
      int own = 0;
      if (op == 9 && y == 1) {
        data = (char *)(w_hostmem + B);
        n = BL;
      } else {
        data = wn_utf16_to_8(B, BL, &n);
        own = 1;
      }
      int e = write_all(fd, data, n);
      if (e) rc = wn_fs_err(e);
      if (own) free(data);
      close(fd);
      break;
    }
    case 11: {
      mode_t mode = x ? (mode_t)(x - 1) : 0777;
      if (y == 1) {
        if (mkdir_p(path, mode) != 0) rc = wn_fs_err(errno);
      } else if (mkdir(path, mode) != 0)
        rc = wn_fs_err(errno);
      break;
    }
    case 12:
      if (rmdir(path) != 0) rc = wn_fs_err(errno);
      break;
    case 13:
      if (unlink(path) != 0) rc = wn_fs_err(errno);
      break;
    case 14: {
      struct stat st;
      if (lstat(path, &st) != 0) {
        rc = (errno == ENOENT && y == 1) ? 0 : wn_fs_err(errno);
        break;
      }
      if (S_ISDIR(st.st_mode)) {
        if (x != 1) {
          rc = wn_fs_err(EISDIR);
          break;
        }
        if (nftw(path, rm_cb, 64, FTW_DEPTH | FTW_PHYS) != 0) rc = wn_fs_err(errno);
      } else if (unlink(path) != 0)
        rc = wn_fs_err(errno);
      break;
    }
    case 15: {
      char *dst = path_arg(B, BL, "an fs path");
      int in = open(path, O_RDONLY | O_CLOEXEC);
      if (in < 0) {
        rc = wn_fs_err(errno);
        free(dst);
        break;
      }
      struct stat st;
      fstat(in, &st);
      if (S_ISDIR(st.st_mode)) {
        close(in);
        free(dst);
        rc = wn_fs_err(EISDIR);
        break;
      }
      /* libuv's uv__fs_copyfile: open without truncating, and when the
       * destination IS the source, do nothing (truncating first would
       * empty the file) */
      int out = open(dst, O_WRONLY | O_CREAT | O_CLOEXEC, st.st_mode & 07777);
      if (out < 0) {
        rc = wn_fs_err(errno);
        close(in);
        free(dst);
        break;
      }
      struct stat dt;
      if (fstat(out, &dt) == 0 && dt.st_dev == st.st_dev && dt.st_ino == st.st_ino) {
        close(in);
        close(out);
        free(dst);
        break;
      }
      if (ftruncate(out, 0) != 0) {
        rc = wn_fs_err(errno);
        close(in);
        close(out);
        free(dst);
        break;
      }
      uint8_t *b;
      size_t n;
      int e = read_all(in, &b, &n);
      if (!e) {
        e = write_all(out, (const char *)b, n);
        free(b);
      }
      if (e) rc = wn_fs_err(e);
      fchmod(out, st.st_mode & 07777);
      close(in);
      close(out);
      free(dst);
      break;
    }
    case 16:
      if (chmod(path, (mode_t)x) != 0) rc = wn_fs_err(errno);
      break;
    case 17:
      if (chown(path, (uid_t)x, (gid_t)y) != 0) rc = wn_fs_err(errno);
      break;
    case 18:
      if (x == held_fd) {
        free(held_buf);
        held_buf = NULL;
        held_fd = -1;
      }
      if (x != 0 && close(x) != 0) rc = wn_fs_err(errno);
      break;
    case 19:
      rc = access(path, F_OK) == 0 ? 0 : -1;
      break;
    case 20:
      if (access(path, x) != 0) rc = wn_fs_err(errno);
      break;
    case 21: {
      int fl = open_flags(x);
      if (fl < 0) {
        fprintf(stderr, "native runner: fsCall open with flags code %d\n", x);
        exit(70);
      }
      int fd = open(path, fl | O_CLOEXEC, (mode_t)y);
      rc = fd < 0 ? wn_fs_err(errno) : fd;
      break;
    }
    case 22: {
      struct stat st;
      if (fstat(x, &st) != 0) rc = wn_fs_err(errno);
      else rc = (int32_t)st.st_size;
      break;
    }
    default:
      fprintf(stderr, "native runner: fsCall op %d is not part of the host contract\n", op);
      exit(70);
  }
  free(path);
  return rc;
}

/* ── tzCall: the zone Node would pick (ICU's choice; SEMANTICS.md S113),
 * the native lanes' scr_lib.c rule ─────────────────────────────────────── */
enum { TZ_SYSTEM = 0, TZ_ZONE = 1, TZ_FIXED = 2 };
static int tz_ready, tz_mode, tz_swap;
static char tz_id[256], tz_env[260];
static long tz_raw_s;

static int tz_valid_olson(const char *id) {
  size_t i = 0;
  while (id[i] != '\0' && !(id[i] >= '0' && id[i] <= '9') && id[i] != ',') i++;
  size_t max = i + 2;
  while (i < max && id[i] >= '0' && id[i] <= '9') i++;
  return id[i] == '\0' || strcmp(id, "PST8PDT") == 0 || strcmp(id, "MST7MDT") == 0 || strcmp(id, "CST6CDT") == 0 || strcmp(id, "EST5EDT") == 0;
}
static int tz_zone_file(const char *id) {
  if (id[0] == '\0' || id[0] == '/' || strstr(id, "..") != NULL) return 0;
  const char *dir = getenv("TZDIR");
  if (dir == NULL || dir[0] == '\0') dir = "/usr/share/zoneinfo";
  char path[PATH_MAX];
  if ((size_t)snprintf(path, sizeof path, "%s/%s", dir, id) >= sizeof path) return 0;
  struct stat st;
  return stat(path, &st) == 0 && S_ISREG(st.st_mode);
}
static void tz_resolve(void) {
  tz_ready = 1;
  tz_mode = TZ_SYSTEM;
  tz_swap = 0;
  tzset();
  const char *tz = getenv("TZ");
  const char *id = NULL;
  char link[PATH_MAX];
  if (tz != NULL && tz_valid_olson(tz)) {
    if (*tz == ':') tz++;
    if (strncmp(tz, "posix/", 6) == 0 || strncmp(tz, "right/", 6) == 0) tz += 6;
    if (strlen(tz) >= sizeof tz_id) return;
    strcpy(tz_id, tz);
    if (!tz_zone_file(tz)) {
      tz_mode = TZ_FIXED;
      tz_raw_s = -timezone;
      return;
    }
    id = tz_id;
  } else if (realpath("/etc/localtime", link) != NULL) {
    const char *tail = strstr(link, "/zoneinfo/");
    if (tail != NULL && tz_valid_olson(tail + 10) && tz_zone_file(tail + 10) && strlen(tail + 10) < sizeof tz_id) {
      strcpy(tz_id, tail + 10);
      id = tz_id;
    }
  }
  if (id == NULL) return;
  tz_mode = TZ_ZONE;
  const char *real = getenv("TZ");
  if (real != NULL && strcmp(real, id) != 0) {
    snprintf(tz_env, sizeof tz_env, "TZ=%s", id);
    tz_swap = 1;
  }
}
static int tz_localtime(time_t s, struct tm *tm) {
  if (!tz_ready) tz_resolve();
  if (tz_swap) {
    char *envp[2] = {tz_env, NULL};
    char **saved = environ;
    environ = envp;
    tzset();
    environ = saved;
  }
  return localtime_r(&s, tm) != NULL;
}
static time_t tz_seconds(double t) {
  if (t < -8640000000000000.0) t = -8640000000000000.0;
  if (t > 8640000000000000.0) t = 8640000000000000.0;
  return (time_t)floor(t / 1000.0);
}
static double tz_offset_ms(double t) {
  if (!tz_ready) tz_resolve();
  if (tz_mode == TZ_FIXED) return (double)tz_raw_s * 1000.0;
  struct tm tm;
  if (!tz_localtime(tz_seconds(t), &tm)) return 0;
  return (double)tm.tm_gmtoff * 1000.0;
}
static int zone_cmp(const void *key, const void *elem) { return strcmp((const char *)key, ((const ScrZoneName *)elem)->id); }

double host_tzCall(int32_t op, double ms, int32_t ptr, int32_t len) {
  if (op == 0) return tz_offset_ms(ms);
  if (op == 1) {
    if (!tz_ready) tz_resolve();
    const ScrZoneName *row = tz_mode != TZ_ZONE ? NULL : bsearch(tz_id, scr_zone_names, sizeof scr_zone_names / sizeof scr_zone_names[0], sizeof scr_zone_names[0], zone_cmp);
    char buf[64];
    const char *name;
    if (row != NULL) {
      struct tm tm;
      int dst = tz_localtime(tz_seconds(ms), &tm) && tm.tm_isdst > 0;
      name = scr_zone_name_strs[dst ? row->dst_name : row->std_name];
    } else {
      long east = (long)(tz_offset_ms(ms) / 1000.0);
      long a = east < 0 ? -east : east;
      if (a % 60 != 0) snprintf(buf, sizeof buf, "GMT%c%02ld:%02ld:%02ld", east < 0 ? '-' : '+', a / 3600, a / 60 % 60, a % 60);
      else snprintf(buf, sizeof buf, "GMT%c%02ld:%02ld", east < 0 ? '-' : '+', a / 3600, a / 60 % 60);
      name = buf;
    }
    return put_str(name, (uint32_t)ptr, (uint32_t)len);
  }
  if (op == 2) {
    if (len < 0) unsetenv("TZ");
    else {
      char *z = wn_utf16_to_8((uint32_t)ptr, (uint32_t)len, NULL);
      setenv("TZ", z, 1);
      free(z);
    }
    tz_resolve();
    return 0;
  }
  fprintf(stderr, "native runner: tzCall op %d is not part of the host contract\n", op);
  exit(70);
}
