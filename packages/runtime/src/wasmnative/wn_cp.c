/* The native runner's child processes (native-runner phase N1): abi.ts's
 * `cpCall` — RUN / META / READ / FREE (spawnSync's surface) and SPAWN /
 * KILL / UNREF / RELEASE / FLOW (spawn's), whose later events (source 1)
 * go through wn_ev.c's queue.
 *
 * The OS layer is libuv's, transcribed: a child is forked and exec'd with
 * every signal back at its default disposition and an empty mask, its
 * stdio descriptors dup2'd into place (a descriptor already sitting on
 * 0..2 is moved up first, so the three can be any permutation), its
 * working directory changed, and the file looked up on the CHILD's PATH
 * (the environment the module sends; "/usr/bin:/bin" when it has none —
 * libuv's uv__execvpe); an exec failure reaches the parent through a
 * close-on-exec pipe as the errno. A "pipe" is a socketpair, as libuv's
 * stdio pipes are; "ignore" is /dev/null.
 *
 * spawnSync is Node's SyncProcessRunner: output pipes drained together
 * with stdin's input written beside them, a kill timer (ETIMEDOUT) and the
 * maxBuffer limit (ENOBUFS, counted over every captured byte), each of
 * which kills the child with the request's signal and stops reading; the
 * call returns once the child is reaped and every pipe is done.
 *
 * INHERITED STREAMS PASS THROUGH: abi.ts lets a host whose descriptors are
 * the program's own hand a child the real fd 1/2 instead of capturing and
 * re-writing (SEMANTICS.md S117 (f)) — the native runner's are, so a child
 * writes where Node's child would, in the same order against the parent's
 * own writes. The same holds for a numbered descriptor (stdio [.., fd]): it
 * is the program's real descriptor, passed as libuv passes it.
 *
 * A spawned child's exit is watched through a pidfd in the poller; its
 * piped streams (child.stdout / child.stderr) are read as Node's net.Socket
 * reads them — 64 KiB reads, the reading paused once 64 KiB sit unclaimed
 * before the program's first 'data' listener (FLOW), resumed by FLOW or by
 * the exit (Node's flushStdio) — and the events are queued as the host
 * Node's own stream emits them (abi.ts kinds 4, 5, 6 and the scope bit). */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <math.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/epoll.h>
#include <sys/socket.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#include "wn_host.h"

extern void (*wn_cp_delivered)(const WnEv *e);

static int pidfd_open_(pid_t pid) { return (int)syscall(SYS_pidfd_open, pid, 0); }

/* ── decoding the request's runs ──────────────────────────────────────── */
typedef struct {
  char *file;
  char **argv; /* argv[0] = file */
  char *cwd;   /* NULL: inherit */
  char **envp;
} CpCmd;

static void cmd_free(CpCmd *c) {
  free(c->file);
  if (c->argv)
    for (char **a = c->argv + 1; *a; a++) free(*a);
  free(c->argv);
  free(c->cwd);
  if (c->envp)
    for (char **e = c->envp; *e; e++) free(*e);
  free(c->envp);
  memset(c, 0, sizeof *c);
}

/* the file, the arguments, the cwd and the environment, from *off */
static void cmd_decode(CpCmd *c, uint32_t *off) {
  c->file = wn_read_run(off, NULL);
  uint32_t argc = wn_rd32(*off);
  *off += 4;
  c->argv = calloc((size_t)argc + 2, sizeof(char *));
  if (!c->argv) abort();
  c->argv[0] = c->file;
  for (uint32_t i = 0; i < argc; i++) c->argv[i + 1] = wn_read_run(off, NULL);
  size_t cl;
  c->cwd = wn_read_run(off, &cl);
  if (cl == 0) {
    free(c->cwd);
    c->cwd = NULL;
  }
  uint32_t pairs = wn_rd32(*off);
  *off += 4;
  c->envp = calloc((size_t)pairs + 1, sizeof(char *));
  if (!c->envp) abort();
  for (uint32_t i = 0; i < pairs; i++) {
    size_t kl, vl;
    char *k = wn_read_run(off, &kl);
    char *v = wn_read_run(off, &vl);
    char *kv = malloc(kl + vl + 2);
    if (!kv) abort();
    memcpy(kv, k, kl);
    kv[kl] = '=';
    memcpy(kv + kl + 1, v, vl + 1);
    free(k);
    free(v);
    c->envp[i] = kv;
  }
}

/* ── the spawn (libuv's uv_spawn on Linux) ────────────────────────────── */
/* fd[i]: the descriptor the child gets as i; -1 is /dev/null */
static int spawn_child(CpCmd *c, const int fd[3], int detached, pid_t *out) {
  /* the PATH candidates, built before the fork (the child may not
   * allocate: the parent is multi-threaded) */
  char **cand = NULL;
  size_t ncand = 0;
  if (strchr(c->file, '/') != NULL || c->file[0] == 0) {
    cand = calloc(2, sizeof(char *));
    if (!cand) abort();
    cand[ncand++] = strdup(c->file);
  } else {
    const char *path = NULL;
    for (char **e = c->envp; *e; e++)
      if (strncmp(*e, "PATH=", 5) == 0) path = *e + 5;
    if (path == NULL) path = "/usr/bin:/bin";
    size_t fl = strlen(c->file), slots = 2;
    for (const char *p = path; *p; p++)
      if (*p == ':') slots++;
    cand = calloc(slots + 1, sizeof(char *));
    if (!cand) abort();
    const char *p = path;
    for (;;) {
      const char *end = strchr(p, ':');
      size_t dl = end ? (size_t)(end - p) : strlen(p);
      char *b = malloc(dl + fl + 2);
      if (!b) abort();
      if (dl == 0) memcpy(b, c->file, fl + 1); /* an empty entry: the cwd */
      else {
        memcpy(b, p, dl);
        b[dl] = '/';
        memcpy(b + dl + 1, c->file, fl + 1);
      }
      cand[ncand++] = b;
      if (!end) break;
      p = end + 1;
    }
  }
  int ep[2];
  if (pipe2(ep, O_CLOEXEC) != 0) {
    int e = errno;
    for (size_t i = 0; i < ncand; i++) free(cand[i]);
    free(cand);
    return -e;
  }
  pid_t pid = fork();
  if (pid == 0) {
    /* the child: async-signal-safe calls only */
    for (int n = 1; n < 32; n++) {
      if (n == SIGKILL || n == SIGSTOP) continue;
      signal(n, SIG_DFL);
    }
    sigset_t none;
    sigemptyset(&none);
    sigprocmask(SIG_SETMASK, &none, NULL);
    if (detached) setsid();
    int use[3];
    int err = 0;
    for (int i = 0; i < 3; i++) {
      use[i] = fd[i];
      if (use[i] < 0) {
        int nfd = open("/dev/null", (i == 0 ? O_RDONLY : O_RDWR) | O_CLOEXEC);
        if (nfd < 0) {
          err = errno;
          goto fail;
        }
        use[i] = nfd;
      }
    }
    /* a source already on 0..2 (and not its own slot) moves up first */
    for (int i = 0; i < 3; i++) {
      if (use[i] < 3 && use[i] != i) {
        int moved = fcntl(use[i], F_DUPFD_CLOEXEC, 3);
        if (moved < 0) {
          err = errno;
          goto fail;
        }
        use[i] = moved;
      }
    }
    for (int i = 0; i < 3; i++) {
      if (use[i] == i) {
        if (fcntl(i, F_SETFD, 0) != 0) {
          err = errno;
          goto fail;
        }
      } else if (dup2(use[i], i) < 0) {
        err = errno;
        goto fail;
      }
    }
    if (c->cwd && chdir(c->cwd) != 0) {
      err = errno;
      goto fail;
    }
    {
      int eacces = 0;
      err = ENOENT;
      for (size_t i = 0; i < ncand; i++) {
        execve(cand[i], c->argv, c->envp);
        int e = errno;
        if (ncand == 1) {
          err = e;
          break;
        }
        if (e == EACCES) {
          eacces = 1;
          continue;
        }
        if (e == ENOENT || e == ENOTDIR) continue;
        err = e;
        eacces = 0;
        break;
      }
      if (eacces) err = EACCES;
    }
  fail:
    (void)!write(ep[1], &err, sizeof err);
    _exit(127);
  }
  int fe = errno;
  for (size_t i = 0; i < ncand; i++) free(cand[i]);
  free(cand);
  close(ep[1]);
  if (pid < 0) {
    close(ep[0]);
    return -fe;
  }
  int err = 0;
  ssize_t r;
  do r = read(ep[0], &err, sizeof err);
  while (r < 0 && errno == EINTR);
  close(ep[0]);
  if (r == (ssize_t)sizeof err) {
    /* exec failed: reap the child that reported it */
    int st;
    while (waitpid(pid, &st, 0) < 0 && errno == EINTR) {
    }
    return -err;
  }
  *out = pid;
  return 0;
}

static int sock_pair(int sv[2]) { return socketpair(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0, sv); }

/* the module's errno table (childproc.ts CP_CODES), else -(256 + n) */
static int32_t cp_code(int e) {
  static const int order[] = {ENOENT, EACCES, EPERM, ENOTDIR, ENOEXEC, ELOOP, ENAMETOOLONG, E2BIG, ENOMEM, EAGAIN, EIO, EINVAL, ETIMEDOUT, EPIPE, ENOBUFS};
  if (e == 0) return 0;
  for (int i = 0; i < 15; i++)
    if (order[i] == e) return i + 1;
  return -(256 + e);
}

static double mono_ms(void) {
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return (double)t.tv_sec * 1e3 + (double)t.tv_nsec / 1e6;
}

/* ── spawnSync (ops 1-4) ──────────────────────────────────────────────── */
typedef struct {
  int used;
  int hasStatus;
  double status;
  int signal;
  int32_t errCode;
  WnBuf out, err;
} SyncRes;
static SyncRes *sres;
static int n_sres;

typedef struct {
  int fd;
  int open;
  WnBuf *cap;
} OutPipe;

static int32_t cp_run(uint32_t ptr, uint32_t len) {
  uint32_t stdinMode = wn_rd32(ptr), outMode = wn_rd32(ptr + 4), errMode = wn_rd32(ptr + 8);
  int killSig = (int)wn_rd32(ptr + 12);
  double timeoutMs = wn_rdf64(ptr + 16);
  uint32_t maxBufferMode = wn_rd32(ptr + 24);
  uint32_t off = ptr + 32;
  CpCmd c;
  memset(&c, 0, sizeof c);
  cmd_decode(&c, &off);
  uint32_t inLen = wn_rd32(off);
  const uint8_t *input = w_hostmem + off + 4;
  if (off + 4 + inLen != ptr + len) wn_host_fail("cpCall: the RUN request's parts do not add up to its length");
  if (stdinMode > 3 || outMode > 2 || errMode > 2) wn_host_fail("cpCall: a stdio mode outside the contract");

  int h = -1;
  for (int i = 0; i < n_sres; i++)
    if (!sres[i].used) h = i;
  if (h < 0) {
    sres = realloc(sres, sizeof *sres * (size_t)(n_sres + 1));
    if (!sres) abort();
    h = n_sres++;
  }
  SyncRes *r = &sres[h];
  memset(r, 0, sizeof *r);
  r->used = 1;

  int inP[2] = {-1, -1}, outP[2] = {-1, -1}, errP[2] = {-1, -1};
  int fd[3];
  int setup = 0;
  if (stdinMode <= 1 && sock_pair(inP) != 0) setup = errno;
  if (!setup && outMode == 0 && sock_pair(outP) != 0) setup = errno;
  if (!setup && errMode == 0 && sock_pair(errP) != 0) setup = errno;
  fd[0] = stdinMode <= 1 ? inP[1] : stdinMode == 2 ? 0 : -1;
  fd[1] = outMode == 0 ? outP[1] : outMode == 2 ? 1 : -1;
  fd[2] = errMode == 0 ? errP[1] : errMode == 2 ? 2 : -1;
  pid_t pid = -1;
  int se = setup ? -setup : spawn_child(&c, fd, 0, &pid);
  cmd_free(&c);
  if (inP[1] >= 0) close(inP[1]);
  if (outP[1] >= 0) close(outP[1]);
  if (errP[1] >= 0) close(errP[1]);
  if (se != 0) {
    if (inP[0] >= 0) close(inP[0]);
    if (outP[0] >= 0) close(outP[0]);
    if (errP[0] >= 0) close(errP[0]);
    r->errCode = cp_code(-se);
    return h;
  }
  int pfd = pidfd_open_(pid);
  if (pfd < 0) wn_host_fail("cpCall: pidfd_open failed (Linux 5.3 or later is required)");
  OutPipe outs[2] = {{outP[0], outP[0] >= 0, &r->out}, {errP[0], errP[0] >= 0, &r->err}};
  int inFd = inP[0];
  size_t inOff = 0;
  if (inFd >= 0) {
    fcntl(inFd, F_SETFL, O_NONBLOCK);
    if (stdinMode == 0 || inLen == 0) {
      shutdown(inFd, SHUT_WR);
      inOff = inLen;
    }
  }
  for (int i = 0; i < 2; i++)
    if (outs[i].open) fcntl(outs[i].fd, F_SETFL, O_NONBLOCK);
  int exited = 0, killed = 0, st = 0;
  int error = 0, pipeError = 0;
  double deadline = timeoutMs > 0 ? mono_ms() + timeoutMs : 0;
  size_t total = 0;
  const size_t maxBuffer = 1024 * 1024; /* Node's spawnSync default */
  int limited = maxBufferMode == 0 && (outMode == 0 || errMode == 0);
  /* SyncProcessRunner::Kill(): the signal (while the child runs), then
   * every stdio pipe closed — a child that outlives the signal and writes
   * meets a closed pipe, as under Node */
#define KILL_AND_CLOSE()                                                       \
  do {                                                                         \
    killed = 1;                                                                \
    if (!exited) kill(pid, killSig);                                           \
    if (inFd >= 0) close(inFd), inFd = -1;                                     \
    for (int q = 0; q < 2; q++)                                                \
      if (outs[q].fd >= 0) close(outs[q].fd), outs[q].fd = -1, outs[q].open = 0; \
  } while (0)
  for (;;) {
    int inOpen = inFd >= 0 && inOff < inLen && !killed;
    int anyOut = !killed && (outs[0].open || outs[1].open);
    if (exited && !anyOut && !inOpen) break;
    struct pollfd p[4];
    int n = 0, idx[4];
    for (int i = 0; i < 2; i++)
      if (!killed && outs[i].open) p[n].fd = outs[i].fd, p[n].events = POLLIN, idx[n++] = i;
    if (inOpen) p[n].fd = inFd, p[n].events = POLLOUT, idx[n++] = 2;
    if (!exited) p[n].fd = pfd, p[n].events = POLLIN, idx[n++] = 3;
    int wait = -1;
    if (deadline > 0 && !killed) {
      double left = deadline - mono_ms();
      /* any accepted timeout, however large: a wait is at most ~12 days
       * long, and the loop waits again */
      wait = left <= 0 ? 0 : left > 1e9 ? 1000000000 : (int)ceil(left);
    }
    int rc = poll(p, (nfds_t)n, wait);
    if (rc < 0) {
      if (errno == EINTR) continue;
      wn_host_fail("cpCall: poll failed");
    }
    if (deadline > 0 && !killed && mono_ms() >= deadline) {
      /* Node's kill timer: ETIMEDOUT, then Kill() */
      if (!error) error = ETIMEDOUT;
      KILL_AND_CLOSE();
      continue;
    }
    for (int k = 0; k < n; k++) {
      if (!p[k].revents) continue;
      int which = idx[k];
      if (which == 3) {
        if (waitpid(pid, &st, WNOHANG) == pid) exited = 1;
      } else if (which == 2) {
        while (inOff < inLen) {
          ssize_t w = send(inFd, input + inOff, inLen - inOff, MSG_NOSIGNAL);
          if (w < 0) {
            if (errno == EINTR) continue;
            if (errno == EAGAIN) break;
            if (!pipeError) pipeError = errno;
            inOff = inLen;
            break;
          }
          inOff += (size_t)w;
        }
        if (inOff >= inLen) shutdown(inFd, SHUT_WR);
      } else if (!killed) {
        OutPipe *o = &outs[which];
        for (;;) {
          /* the read lands in what is left of the current 64 KiB block
           * (SyncProcessOutputBuffer's allocation) */
          size_t room = 65536 - (o->cap->n % 65536);
          uint8_t buf[65536];
          ssize_t got = read(o->fd, buf, room);
          if (got < 0) {
            if (errno == EINTR) continue;
            if (errno != EAGAIN) o->open = 0;
            break;
          }
          if (got == 0) {
            o->open = 0;
            break;
          }
          wn_buf_put(o->cap, buf, (size_t)got);
          total += (size_t)got;
          if (limited && total > maxBuffer) {
            if (!error) error = ENOBUFS;
            KILL_AND_CLOSE();
            break;
          }
        }
      }
    }
  }
#undef KILL_AND_CLOSE
  if (inFd >= 0) close(inFd);
  for (int i = 0; i < 2; i++)
    if (outs[i].fd >= 0) close(outs[i].fd);
  close(pfd);
  if (WIFSIGNALED(st)) {
    r->hasStatus = 0;
    r->signal = WTERMSIG(st);
  } else {
    r->hasStatus = 1;
    r->status = WEXITSTATUS(st);
  }
  r->errCode = cp_code(error ? error : pipeError);
  return h;
}

/* ── spawn (ops 5-9) ──────────────────────────────────────────────────── */
typedef struct Chunk {
  struct Chunk *next;
  uint32_t n;
  uint8_t b[];
} Chunk;
typedef struct {
  int piped;
  int which; /* 1 stdout, 2 stderr */
  WnIo io;
  Chunk *buf, **buf_tail;
  size_t buffered;
  int flowing, held, eof, end_sent, end_read;
  struct Child *ch;
} CPipe;
typedef struct Child {
  int used;
  uint32_t handle;
  pid_t pid;
  WnIo pio;
  int reaped, exit_queued, exit_read, released;
  CPipe pipes[2];
  struct Child *next_live; /* the unreaped children, in spawn order */
  int pid_status;
} Child;
static Child **kids;
static uint32_t n_kids;
static Child *live_head, **live_tail = &live_head;

#define HWM 65536

static void pipe_stop(CPipe *p) {
  if (p->io.fd >= 0) wn_io_want(&p->io, 0);
}
static void pipe_close(CPipe *p) {
  if (p->io.fd >= 0) wn_io_close(&p->io);
  while (p->buf) {
    Chunk *c = p->buf;
    p->buf = c->next;
    free(c);
  }
  p->buf_tail = &p->buf;
  p->buffered = 0;
}
static void pipe_end(CPipe *p, int staged) {
  if (p->end_sent) return;
  p->end_sent = 1;
  WnEv *e = wn_ev_new(WN_SRC_CHILD, p->ch->handle, 5, p->which, 0, NULL, 0);
  if (staged) wn_ev_stage_late(e);
  else wn_ev_push(e);
}
/* FLOW: the buffered chunks flow on the host's next tick (kind 4), and the
 * 'end' after them when end of file is already in */
static void pipe_flush_staged(CPipe *p) {
  while (p->buf) {
    Chunk *c = p->buf;
    p->buf = c->next;
    wn_ev_stage(wn_ev_new(WN_SRC_CHILD, p->ch->handle, 4, p->which, 0, c->b, c->n));
    free(c);
  }
  p->buf_tail = &p->buf;
  p->buffered = 0;
  if (p->eof) pipe_end(p, 1);
}

static void pipe_ready(WnIo *io, uint32_t evs) {
  (void)evs;
  CPipe *p = io->ctx;
  static uint8_t buf[65536];
  for (int count = 0; count < 32; count++) {
    ssize_t r = read(io->fd, buf, sizeof buf);
    if (r < 0) {
      if (errno == EINTR) continue;
      if (errno == EAGAIN || errno == EWOULDBLOCK) return;
      r = 0; /* a read error ends the stream as end of file does */
    }
    if (r == 0) {
      p->eof = 1;
      pipe_stop(p);
      /* Node's 'end' fires once the buffer is empty */
      if (p->buf == NULL) {
        wn_ev_scope_begin();
        pipe_end(p, 0);
        wn_ev_scope_end();
      }
      return;
    }
    if (p->flowing) {
      wn_ev_scope_begin();
      wn_ev_push(wn_ev_new(WN_SRC_CHILD, p->ch->handle, p->held ? 6 : 4, p->which, 0, buf, (uint32_t)r));
      wn_ev_scope_end();
    } else {
      Chunk *c = malloc(sizeof *c + (size_t)r);
      if (!c) abort();
      c->next = NULL;
      c->n = (uint32_t)r;
      memcpy(c->b, buf, (size_t)r);
      *p->buf_tail = c;
      p->buf_tail = &c->next;
      p->buffered += (size_t)r;
      /* push() over the high-water mark: the socket stops reading */
      if (p->buffered >= HWM) {
        pipe_stop(p);
        return;
      }
    }
    /* uv__read: a short read ends this callback; the rest (an end of
     * file included) is the next iteration's */
    if ((size_t)r < sizeof buf) return;
  }
}

/* the exit, then (flushStdio's resume) every stream nobody consumed
 * flowing — its buffered chunks held (kind 6) and its 'end' — one scope */
static void exit_scope(Child *ch, int st) {
  int32_t a = WIFSIGNALED(st) ? -1 : WEXITSTATUS(st);
  int32_t b = WIFSIGNALED(st) ? WTERMSIG(st) : 0;
  wn_ev_scope_begin();
  wn_ev_push(wn_ev_new(WN_SRC_CHILD, ch->handle, 1, a, b, NULL, 0));
  ch->exit_queued = 1;
  for (int i = 0; i < 2; i++) {
    CPipe *p = &ch->pipes[i];
    if (!p->piped || p->flowing) continue;
    p->flowing = 1;
    p->held = 1;
    while (p->buf) {
      Chunk *c = p->buf;
      p->buf = c->next;
      wn_ev_push(wn_ev_new(WN_SRC_CHILD, ch->handle, 6, p->which, 0, c->b, c->n));
      free(c);
    }
    p->buf_tail = &p->buf;
    p->buffered = 0;
    if (!p->eof) wn_io_want(&p->io, EPOLLIN);
  }
  for (int i = 0; i < 2; i++) {
    CPipe *p = &ch->pipes[i];
    if (p->piped && p->held && p->eof) pipe_end(p, 0);
  }
  wn_ev_scope_end();
}

/* libuv's uv__wait_children: one child's exit wakes the loop, and EVERY
 * exited child is reaped then, in spawn order, before any exit callback
 * runs — so inside one child's 'exit' a sibling of the same batch is
 * already reaped (its kill finds no process) */
static void child_reaped(WnIo *io, uint32_t evs) {
  (void)io;
  (void)evs;
  /* the unreaped children only, in spawn order: reaped first, all of
   * them, then each exit queued */
  Child *batch = NULL, **bt = &batch;
  int sts[64];
  int nb = 0;
  Child *got[64];
  for (Child **pp = &live_head; *pp;) {
    Child *ch = *pp;
    int st;
    pid_t r;
    do r = waitpid(ch->pid, &st, WNOHANG);
    while (r < 0 && errno == EINTR);
    if (r != ch->pid) {
      pp = &ch->next_live;
      continue;
    }
    *pp = ch->next_live;
    if (!*pp) live_tail = pp;
    ch->next_live = NULL;
    ch->reaped = 1;
    wn_io_close(&ch->pio);
    if (nb < 64) {
      got[nb] = ch;
      sts[nb++] = st;
    } else {
      /* a batch past 64: the rest are queued in a second pass, still in order */
      *bt = ch;
      bt = &ch->next_live;
      ch->pid_status = st;
    }
  }
  for (int i = 0; i < nb; i++) exit_scope(got[i], sts[i]);
  for (Child *ch = batch; ch;) {
    Child *n = ch->next_live;
    ch->next_live = NULL;
    exit_scope(ch, ch->pid_status);
    ch = n;
  }
}

static Child *child_of(int32_t h) {
  if (h < 1 || (uint32_t)h > n_kids || !kids[h - 1] || kids[h - 1]->released) return NULL;
  return kids[h - 1];
}

static void cp_delivered(const WnEv *e) {
  Child *ch = child_of((int32_t)e->handle);
  if (!ch) return;
  uint32_t k = e->kind & 0xff;
  if (k == 1) ch->exit_read = 1;
  else if (k == 5 && (e->a == 1 || e->a == 2)) ch->pipes[e->a - 1].end_read = 1;
}

static int32_t cp_spawn(uint32_t ptr, uint32_t len) {
  uint32_t inMode = wn_rd32(ptr), m[2] = {wn_rd32(ptr + 4), wn_rd32(ptr + 8)};
  int32_t xfd[2] = {(int32_t)wn_rd32(ptr + 12), (int32_t)wn_rd32(ptr + 16)};
  uint32_t detached = wn_rd32(ptr + 20);
  uint32_t off = ptr + 32;
  CpCmd c;
  memset(&c, 0, sizeof c);
  cmd_decode(&c, &off);
  if (off != ptr + len) wn_host_fail("cpCall: the SPAWN request's parts do not add up to its length");
  if (inMode > 1 || m[0] > 3 || m[1] > 3) wn_host_fail("cpCall: a stdio mode outside the contract");
  int fd[3];
  int pp[2][2] = {{-1, -1}, {-1, -1}};
  int setup = 0;
  fd[0] = inMode == 1 ? 0 : -1;
  for (int i = 0; i < 2; i++) {
    if (m[i] == 0) fd[i + 1] = -1;
    else if (m[i] == 1) fd[i + 1] = i + 1;
    else if (m[i] == 2) fd[i + 1] = xfd[i];
    else {
      if (!setup && sock_pair(pp[i]) != 0) setup = errno;
      fd[i + 1] = pp[i][1];
    }
  }
  pid_t pid = 0;
  int se = setup ? -setup : spawn_child(&c, fd, (int)detached, &pid);
  cmd_free(&c);
  for (int i = 0; i < 2; i++)
    if (pp[i][1] >= 0) close(pp[i][1]);
  int disposition = 0;
  if (se != 0) disposition = (se == -EACCES || se == -EAGAIN || se == -EMFILE || se == -ENFILE || se == -ENOENT) ? 1 : 2;
  int anyPipe = m[0] == 3 || m[1] == 3;
  wn_wr32(ptr, (uint32_t)se);
  wn_wr32(ptr + 4, (uint32_t)disposition);
  wn_wr32(ptr + 8, (uint32_t)(se == 0 ? pid : 0));
  if (!(disposition == 0 || (disposition == 1 && anyPipe))) {
    for (int i = 0; i < 2; i++)
      if (pp[i][0] >= 0) close(pp[i][0]);
    return 0;
  }
  Child *ch = calloc(1, sizeof *ch);
  if (!ch) abort();
  kids = realloc(kids, sizeof *kids * (n_kids + 1));
  if (!kids) abort();
  kids[n_kids++] = ch;
  ch->used = 1;
  ch->handle = n_kids;
  ch->pid = pid;
  wn_cp_delivered = cp_delivered;
  for (int i = 0; i < 2; i++) {
    CPipe *p = &ch->pipes[i];
    p->ch = ch;
    p->which = i + 1;
    p->buf_tail = &p->buf;
    wn_io_init(&p->io, -1, pipe_ready, p);
    if (m[i] != 3) continue;
    p->piped = 1;
    if (disposition != 0) {
      /* a failed spawn's streams end, each in its own callback, at the
       * first poll phase (Node creates them, and they end) */
      close(pp[i][0]);
      p->eof = 1;
      p->end_sent = 1;
      wn_ev_stage_solo(wn_ev_new(WN_SRC_CHILD, ch->handle, 5, p->which, 0, NULL, 0));
      continue;
    }
    p->io.fd = pp[i][0];
    fcntl(p->io.fd, F_SETFL, O_NONBLOCK);
    wn_io_want(&p->io, EPOLLIN);
  }
  if (disposition == 0) {
    ch->exit_queued = 0;
    int pfd = pidfd_open_(pid);
    if (pfd < 0) wn_host_fail("cpCall: pidfd_open failed (Linux 5.3 or later is required)");
    wn_io_init(&ch->pio, pfd, child_reaped, ch);
    *live_tail = ch;
    live_tail = &ch->next_live;
    ch->pio.last = 1;
    wn_io_want(&ch->pio, EPOLLIN);
  } else {
    ch->reaped = 1;
    ch->exit_read = 1;
    wn_io_init(&ch->pio, -1, child_reaped, ch);
  }
  return (int32_t)ch->handle;
}

int32_t host_cpCall(int32_t op, int32_t ptr, int32_t len, int32_t h, int32_t which) {
  uint32_t P = (uint32_t)ptr;
  switch (op) {
    case 1:
      return cp_run(P, (uint32_t)len);
    case 2: {
      if (h < 0 || h >= n_sres || !sres[h].used) return -1;
      SyncRes *r = &sres[h];
      wn_wr32(P, (uint32_t)r->hasStatus);
      wn_wrf64(P + 4, r->status);
      wn_wr32(P + 12, (uint32_t)r->signal);
      wn_wr32(P + 16, (uint32_t)r->errCode);
      wn_wr32(P + 20, (uint32_t)r->out.n);
      wn_wr32(P + 24, (uint32_t)r->err.n);
      wn_wr32(P + 28, 0);
      return 32;
    }
    case 3: {
      if (h < 0 || h >= n_sres || !sres[h].used || (which != 1 && which != 2)) return -1;
      WnBuf *b = which == 1 ? &sres[h].out : &sres[h].err;
      if (b->n) memcpy(w_hostmem + P, b->p, b->n);
      return (int32_t)b->n;
    }
    case 4: {
      if (h < 0 || h >= n_sres || !sres[h].used) return -1;
      wn_buf_free(&sres[h].out);
      wn_buf_free(&sres[h].err);
      sres[h].used = 0;
      return 0;
    }
    case 5:
      return cp_spawn(P, (uint32_t)len);
    case 6: { /* KILL */
      Child *ch = child_of(h);
      if (!ch || ch->pid == 0) return -999999;
      if (ch->reaped) return -ESRCH; /* reaped: no process to signal (an unreaped zombie still takes one) */
      if (kill(ch->pid, which) == 0) return 0;
      return -errno;
    }
    case 7: /* UNREF: liveness is the module's */
      if (!child_of(h)) return -999999;
      return 0;
    case 8: { /* RELEASE */
      Child *ch = child_of(h);
      if (!ch) return -999999;
      ch->released = 1;
      if (ch->pio.fd >= 0) wn_io_close(&ch->pio);
      for (int i = 0; i < 2; i++) pipe_close(&ch->pipes[i]);
      kids[h - 1] = NULL;
      free(ch);
      return 0;
    }
    case 9: { /* FLOW */
      Child *ch = child_of(h);
      if (!ch || (which != 1 && which != 2)) return -999999;
      CPipe *p = &ch->pipes[which - 1];
      if (!p->piped) return -999999;
      if (p->held) return 0;
      if (p->flowing) return -999999;
      p->flowing = 1;
      pipe_flush_staged(p);
      if (!p->eof && p->io.fd >= 0) wn_io_want(&p->io, EPOLLIN);
      return 0;
    }
    default:
      wn_host_fail("cpCall: an op outside the contract");
  }
}
