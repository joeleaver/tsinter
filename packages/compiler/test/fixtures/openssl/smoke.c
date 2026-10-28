/* The vendored OpenSSL's smoke test (packages/compiler/test/openssl-vendor.test.ts):
 * linked statically against the archive backend/openssl-build.ts builds,
 * compiled with opensslIncludeArgs() (the scr_ossl_ prefix header
 * force-included), so every call below binds to scr_ossl_* symbols.
 *
 *   smoke version                        OpenSSL_version + the header's version
 *   smoke kat                            SHA-256 and AES-256-GCM known answers
 *   smoke pemerr                         Node's material errors: a garbage cert, a garbage key
 *   smoke verify <ca> <leaf> <host>...   X509_verify_cert (purpose sslserver) + X509_check_host
 *   smoke tls <ca> <port> <servername>   a TLS client handshake over memory BIOs, the way
 *                                        Node's TLSWrap drives one (VERIFY_NONE, the
 *                                        verdict read after: SSL_get_verify_result), then
 *                                        one HTTP/1.1 GET
 *   smoke bench <MiB>                    no-asm SHA-256 / AES-128-GCM throughput (CPU time) */
#include <arpa/inet.h>
#include <netinet/in.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <time.h>
#include <unistd.h>

#include <openssl/bio.h>
#include <openssl/crypto.h>
#include <openssl/err.h>
#include <openssl/evp.h>
#include <openssl/opensslv.h>
#include <openssl/pem.h>
#include <openssl/ssl.h>
#include <openssl/x509.h>
#include <openssl/x509_vfy.h>
#include <openssl/x509v3.h>

static void hex(const unsigned char *p, size_t n) {
  for (size_t i = 0; i < n; i++) printf("%02x", p[i]);
  printf("\n");
}

static void die(const char *what) {
  char buf[256];
  unsigned long e = ERR_get_error();
  ERR_error_string_n(e, buf, sizeof buf);
  fprintf(stderr, "%s failed: %s\n", what, buf);
  exit(2);
}

static X509 *read_cert(const char *path) {
  FILE *f = fopen(path, "r");
  if (f == NULL) die(path);
  X509 *x = PEM_read_X509(f, NULL, NULL, NULL);
  fclose(f);
  if (x == NULL) die("PEM_read_X509");
  return x;
}

static int kat(void) {
  unsigned char md[32];
  unsigned int mdlen = 0;
  if (!EVP_Digest("abc", 3, md, &mdlen, EVP_sha256(), NULL)) die("EVP_Digest");
  printf("sha256(abc) ");
  hex(md, mdlen);
  /* the GCM spec's test case 13: zero key (256-bit), zero 96-bit IV, one zero block */
  unsigned char key[32] = {0}, iv[12] = {0}, pt[16] = {0}, ct[16], tag[16];
  int n = 0, m = 0;
  EVP_CIPHER_CTX *c = EVP_CIPHER_CTX_new();
  if (!EVP_EncryptInit_ex(c, EVP_aes_256_gcm(), NULL, key, iv)) die("EncryptInit");
  if (!EVP_EncryptUpdate(c, ct, &n, pt, sizeof pt)) die("EncryptUpdate");
  if (!EVP_EncryptFinal_ex(c, ct + n, &m)) die("EncryptFinal");
  if (!EVP_CIPHER_CTX_ctrl(c, EVP_CTRL_GCM_GET_TAG, 16, tag)) die("GET_TAG");
  EVP_CIPHER_CTX_free(c);
  printf("aes256gcm ct ");
  hex(ct, n + m);
  printf("aes256gcm tag ");
  hex(tag, 16);
  return 0;
}

static void print_err(const char *label) {
  char buf[256];
  ERR_error_string_n(ERR_get_error(), buf, sizeof buf);
  printf("%s %s\n", label, buf);
  ERR_clear_error();
}

static int pemerr(void) {
  /* what Node's SecureContext does with `cert: "garbage"` / `key: "garbage"` */
  BIO *b = BIO_new_mem_buf("garbage", -1);
  X509 *x = PEM_read_bio_X509_AUX(b, NULL, NULL, NULL);
  if (x == NULL) print_err("cert");
  BIO_free(b);
  b = BIO_new_mem_buf("garbage", -1);
  EVP_PKEY *k = PEM_read_bio_PrivateKey(b, NULL, NULL, NULL);
  if (k == NULL) print_err("key");
  BIO_free(b);
  return 0;
}

static int verify(int argc, char **argv) {
  X509_STORE *store = X509_STORE_new();
  X509_STORE_add_cert(store, read_cert(argv[0]));
  X509 *leaf = read_cert(argv[1]);
  X509_STORE_CTX *ctx = X509_STORE_CTX_new();
  if (!X509_STORE_CTX_init(ctx, store, leaf, NULL)) die("X509_STORE_CTX_init");
  X509_STORE_CTX_set_purpose(ctx, X509_PURPOSE_SSL_SERVER);
  int ok = X509_verify_cert(ctx);
  int code = X509_STORE_CTX_get_error(ctx);
  printf("verify %d %d %s\n", ok, code, X509_verify_cert_error_string(code));
  for (int i = 2; i < argc; i++) printf("host %s %d\n", argv[i], X509_check_host(leaf, argv[i], 0, 0, NULL));
  X509_STORE_CTX_free(ctx);
  X509_STORE_free(store);
  X509_free(leaf);
  return 0;
}

/* the encrypted bytes OpenSSL produced: out to the socket */
static void flush_out(BIO *wbio, int fd) {
  char buf[16384];
  int n;
  while ((n = BIO_read(wbio, buf, sizeof buf)) > 0) {
    for (int off = 0; off < n;) {
      ssize_t w = write(fd, buf + off, (size_t)(n - off));
      if (w <= 0) die("write");
      off += (int)w;
    }
  }
}

/* the socket's bytes: in to OpenSSL; 0 at EOF */
static int fill_in(BIO *rbio, int fd) {
  char buf[16384];
  ssize_t n = read(fd, buf, sizeof buf);
  if (n <= 0) return 0;
  BIO_write(rbio, buf, (int)n);
  return 1;
}

static int verify_continue(int preverify_ok, X509_STORE_CTX *ctx) {
  (void)preverify_ok;
  (void)ctx;
  return 1;
}

static int tls(char **argv) {
  const char *servername = argv[2];
  int fd = socket(AF_INET, SOCK_STREAM, 0);
  struct sockaddr_in sa;
  memset(&sa, 0, sizeof sa);
  sa.sin_family = AF_INET;
  sa.sin_port = htons((unsigned short)atoi(argv[1]));
  sa.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  if (connect(fd, (struct sockaddr *)&sa, sizeof sa) != 0) die("connect");

  /* SecureContext::Init + TLSWrap::InitSSL, in outline */
  SSL_CTX *ctx = SSL_CTX_new(TLS_client_method());
  if (ctx == NULL) die("SSL_CTX_new");
  SSL_CTX_set_options(ctx, SSL_OP_NO_SSLv2 | SSL_OP_NO_SSLv3 | SSL_OP_ALLOW_CLIENT_RENEGOTIATION);
  SSL_CTX_clear_mode(ctx, SSL_MODE_NO_AUTO_CHAIN);
  SSL_CTX_set_min_proto_version(ctx, TLS1_2_VERSION);
  SSL_CTX_set_max_proto_version(ctx, TLS1_3_VERSION);
  X509_STORE_add_cert(SSL_CTX_get_cert_store(ctx), read_cert(argv[0]));
  SSL *ssl = SSL_new(ctx);
  /* crypto_tls.cc's VerifyCallback returns 1: verification runs to the end
   * and the last error is the verdict (an untrusted leaf issuer ends as
   * X509_V_ERR_UNABLE_TO_VERIFY_LEAF_SIGNATURE, not 20) */
  SSL_set_verify(ssl, SSL_VERIFY_NONE, verify_continue);
  SSL_set_mode(ssl, SSL_MODE_RELEASE_BUFFERS | SSL_MODE_AUTO_RETRY);
  SSL_set_tlsext_host_name(ssl, servername);
  BIO *rbio = BIO_new(BIO_s_mem()), *wbio = BIO_new(BIO_s_mem());
  BIO_set_mem_eof_return(rbio, -1); /* NodeBIO: an empty read is "retry" */
  SSL_set_bio(ssl, rbio, wbio);
  SSL_set_connect_state(ssl);

  for (;;) {
    int r = SSL_do_handshake(ssl);
    flush_out(wbio, fd);
    if (r == 1) break;
    int e = SSL_get_error(ssl, r);
    if (e != SSL_ERROR_WANT_READ || !fill_in(rbio, fd)) die("SSL_do_handshake");
  }
  long vr = SSL_get_verify_result(ssl);
  X509 *peer = SSL_get1_peer_certificate(ssl);
  printf("protocol %s\n", SSL_get_version(ssl));
  printf("cipher %s\n", SSL_CIPHER_get_name(SSL_get_current_cipher(ssl)));
  printf("group %s\n", SSL_get0_group_name(ssl));
  printf("verify %ld %s\n", vr, X509_verify_cert_error_string(vr));
  printf("host %s %d\n", servername, peer != NULL ? X509_check_host(peer, servername, 0, 0, NULL) : -1);

  char req[256];
  snprintf(req, sizeof req, "GET / HTTP/1.1\r\nHost: %s\r\nConnection: close\r\n\r\n", servername);
  if (SSL_write(ssl, req, (int)strlen(req)) <= 0) die("SSL_write");
  flush_out(wbio, fd);
  char resp[65536];
  size_t got = 0;
  for (;;) {
    int n = SSL_read(ssl, resp + got, (int)(sizeof resp - 1 - got));
    if (n > 0) {
      got += (size_t)n;
      continue;
    }
    int e = SSL_get_error(ssl, n);
    if (e == SSL_ERROR_ZERO_RETURN) break;
    if (e != SSL_ERROR_WANT_READ || !fill_in(rbio, fd)) break;
  }
  resp[got] = 0;
  char *body = strstr(resp, "\r\n\r\n");
  printf("status %.12s\n", resp);
  printf("body %s", body != NULL ? body + 4 : "(none)\n");
  X509_free(peer);
  SSL_free(ssl);
  SSL_CTX_free(ctx);
  close(fd);
  return 0;
}

static double cpu_seconds(void) {
  struct timespec ts;
  clock_gettime(CLOCK_PROCESS_CPUTIME_ID, &ts);
  return (double)ts.tv_sec + (double)ts.tv_nsec / 1e9;
}

static int bench(int mib) {
  size_t len = (size_t)1 << 20;
  unsigned char *buf = calloc(len, 1), *out = malloc(len + 32);
  unsigned char md[32], key[16] = {1}, iv[12] = {2}, tag[16];
  unsigned int mdlen;
  double t0 = cpu_seconds();
  EVP_MD_CTX *mctx = EVP_MD_CTX_new();
  EVP_DigestInit_ex(mctx, EVP_sha256(), NULL);
  for (int i = 0; i < mib; i++) EVP_DigestUpdate(mctx, buf, len);
  EVP_DigestFinal_ex(mctx, md, &mdlen);
  double t1 = cpu_seconds();
  EVP_CIPHER_CTX *c = EVP_CIPHER_CTX_new();
  int n;
  EVP_EncryptInit_ex(c, EVP_aes_128_gcm(), NULL, key, iv);
  for (int i = 0; i < mib; i++) EVP_EncryptUpdate(c, out, &n, buf, (int)len);
  EVP_EncryptFinal_ex(c, out, &n);
  EVP_CIPHER_CTX_ctrl(c, EVP_CTRL_GCM_GET_TAG, 16, tag);
  double t2 = cpu_seconds();
  printf("sha256 %.0f MiB/s\naes128gcm %.0f MiB/s\n", mib / (t1 - t0), mib / (t2 - t1));
  return 0;
}

int main(int argc, char **argv) {
  if (argc < 2) return 64;
  const char *cmd = argv[1];
  if (strcmp(cmd, "version") == 0) {
    printf("%s %s\n", OpenSSL_version(OPENSSL_VERSION_STRING), OPENSSL_VERSION_STR);
    return 0;
  }
  if (strcmp(cmd, "kat") == 0) return kat();
  if (strcmp(cmd, "pemerr") == 0) return pemerr();
  if (strcmp(cmd, "verify") == 0 && argc >= 4) return verify(argc - 2, argv + 2);
  if (strcmp(cmd, "tls") == 0 && argc == 5) return tls(argv + 2);
  if (strcmp(cmd, "bench") == 0 && argc == 3) return bench(atoi(argv[2]));
  return 64;
}
