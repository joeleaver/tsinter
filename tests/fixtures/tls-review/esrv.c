/* esrv: a TLS 1.2 server on vendored mbedTLS that serves any certificate
 * chain — including the malformed ones OpenSSL (Node's https server)
 * refuses to load — for board #332's rows in
 * tests/harness/wasmnative-host-rows.test.ts. mbedTLS is built with
 * TSINTER_X509_KEEP_CRITICAL (its x509_crt.c), so a chain whose CA carries a
 * critical extension mbedTLS does not parse still loads.
 *
 *   esrv NAME CHAIN.pem KEY.pem [NAME CHAIN.pem KEY.pem ...]
 *
 * Listens on an ephemeral 127.0.0.1 port per case and prints "NAME PORT"
 * per case (or "NAME FAIL <why>" for one it cannot load), then "ready";
 * serves connections one at a time, answering every request with
 * "hi NAME"; exits when stdin closes. */
#include <arpa/inet.h>
#include <netinet/in.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/random.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <unistd.h>

#include "mbedtls/net_sockets.h"
#include "mbedtls/pk.h"
#include "mbedtls/ssl.h"
#include "mbedtls/x509_crt.h"
#include "psa/crypto.h"

static int rng(void *c, unsigned char *o, size_t n) {
  (void)c;
  return getrandom(o, n, 0) == (ssize_t)n ? 0 : -1;
}
static int snd(void *c, const unsigned char *b, size_t n) {
  ssize_t k = write(*(int *)c, b, n);
  return k < 0 ? MBEDTLS_ERR_NET_SEND_FAILED : (int)k;
}
static int rcv(void *c, unsigned char *b, size_t n) {
  ssize_t k = read(*(int *)c, b, n);
  return k < 0 ? MBEDTLS_ERR_NET_RECV_FAILED : (int)k;
}

typedef struct {
  const char *name;
  int fd;
  mbedtls_x509_crt crt;
  mbedtls_pk_context pk;
  mbedtls_ssl_config conf;
} Case;

static void serve(Case *c, int fd) {
  struct timeval tv = {5, 0};
  setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof tv);
  setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof tv);
  mbedtls_ssl_context ssl;
  mbedtls_ssl_init(&ssl);
  mbedtls_ssl_setup(&ssl, &c->conf);
  mbedtls_ssl_set_bio(&ssl, &fd, snd, rcv, NULL);
  if (mbedtls_ssl_handshake(&ssl) == 0) {
    unsigned char buf[4096];
    (void)mbedtls_ssl_read(&ssl, buf, sizeof buf);
    char body[256], resp[512];
    snprintf(body, sizeof body, "hi %s", c->name);
    int n = snprintf(resp, sizeof resp, "HTTP/1.1 200 OK\r\ncontent-length: %zu\r\nconnection: close\r\n\r\n%s", strlen(body), body);
    mbedtls_ssl_write(&ssl, (unsigned char *)resp, (size_t)n);
    mbedtls_ssl_close_notify(&ssl);
  }
  mbedtls_ssl_free(&ssl);
  close(fd);
}

int main(int argc, char **argv) {
  signal(SIGPIPE, SIG_IGN);
  psa_crypto_init();
  int n = (argc - 1) / 3;
  Case *cs = calloc((size_t)n, sizeof *cs);
  struct pollfd *pf = calloc((size_t)n + 1, sizeof *pf);
  if (!cs || !pf) return 1;
  int live = 0;
  for (int i = 0; i < n; i++) {
    Case *c = &cs[live];
    c->name = argv[1 + 3 * i];
    mbedtls_x509_crt_init(&c->crt);
    mbedtls_pk_init(&c->pk);
    int r = mbedtls_x509_crt_parse_file(&c->crt, argv[2 + 3 * i]);
    if (r != 0) {
      printf("%s FAIL crt %d\n", c->name, r);
      continue;
    }
    r = mbedtls_pk_parse_keyfile(&c->pk, argv[3 + 3 * i], NULL, rng, NULL);
    if (r != 0) {
      printf("%s FAIL key %d\n", c->name, r);
      continue;
    }
    mbedtls_ssl_config_init(&c->conf);
    mbedtls_ssl_config_defaults(&c->conf, MBEDTLS_SSL_IS_SERVER, MBEDTLS_SSL_TRANSPORT_STREAM, MBEDTLS_SSL_PRESET_DEFAULT);
    mbedtls_ssl_conf_rng(&c->conf, rng, NULL);
    mbedtls_ssl_conf_own_cert(&c->conf, &c->crt, &c->pk);
    mbedtls_ssl_conf_max_tls_version(&c->conf, MBEDTLS_SSL_VERSION_TLS1_2);
    int ls = socket(AF_INET, SOCK_STREAM, 0);
    struct sockaddr_in a;
    memset(&a, 0, sizeof a);
    a.sin_family = AF_INET;
    a.sin_addr.s_addr = htonl(0x7f000001);
    socklen_t al = sizeof a;
    if (bind(ls, (struct sockaddr *)&a, sizeof a) != 0 || listen(ls, 16) != 0 || getsockname(ls, (struct sockaddr *)&a, &al) != 0) {
      printf("%s FAIL listen\n", c->name);
      continue;
    }
    c->fd = ls;
    pf[live].fd = ls;
    pf[live].events = POLLIN;
    printf("%s %d\n", c->name, ntohs(a.sin_port));
    live++;
  }
  pf[live].fd = 0;
  pf[live].events = POLLIN;
  printf("ready\n");
  fflush(stdout);
  for (;;) {
    if (poll(pf, (nfds_t)live + 1, -1) < 0) continue;
    if (pf[live].revents) {
      char b[64];
      if (read(0, b, sizeof b) <= 0) return 0;
    }
    for (int i = 0; i < live; i++)
      if (pf[i].revents & POLLIN) {
        int fd = accept(pf[i].fd, NULL, NULL);
        if (fd >= 0) serve(&cs[i], fd);
      }
  }
}
