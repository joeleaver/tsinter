/* node:zlib, the lowered slice: deflateSync/inflateSync over u8 bytes with
 * Node's DEFAULT options (zlib format, Z_DEFAULT_COMPRESSION, windowBits
 * 15), plus the island shim's mode variants. Compiled ONLY when the program
 * uses zlib (cc.ts gates it exactly like scr_regex.c/libregexp).
 *
 * The codec is the zlib Node v24.18.1 bundles — Chromium's fork,
 * process.versions.zlib "1.3.1-e00f703" — vendored under
 * packages/runtime/vendor/zlib-chromium and built scalar (CPU_NO_SIMD, the
 * configuration Node itself builds on targets without SIMD), on host AND
 * cross builds alike (ensureZlibObjects in cc.ts; no system libz anywhere).
 * Its chromeconf.h renames every symbol Cr_z_*, so it can never bind to a
 * system libz by accident (a build that found a system zlib.h instead
 * fails to find chromeconf.h, loudly).
 *
 * Both directions are DRIVEN exactly as Node drives them: lib/zlib.js's
 * processChunkSync calls the codec with flush Z_FINISH and a fresh 16 KiB
 * output chunk (Node's default chunkSize) for as long as a call fills its
 * chunk, and node_zlib.cc's CheckError judges every call. The chunking is
 * observable — deflate_stored sizes stored blocks from avail_out — so with
 * the same codec and the same driver the deflate BYTES are Node's at every
 * input and level, the same bytes the wasm lane's port computes
 * (backend/wasm/zlib.ts; SEMANTICS.md S101). Inflate fails where Node's
 * does with Node's message (zlib's msg, or Node's own "unexpected end of
 * file" / "Missing dictionary" / "Zlib error") and Node's `code`
 * (ZlibStrerror: "Z_DATA_ERROR", ...); Node's numeric `errno` has no slot
 * in the error model (SEMANTICS.md S101 (a)). Codec allocation failure
 * aborts. */
#include "scr_runtime.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
/* the vendored codec's header, under Chromium's Cr_z_ symbol prefix (the
 * objects compile with the same prefix — zlibDefines in cc.ts) */
#include "chromeconf.h"
#include "zlib.h"

/* Node's default chunkSize (zlib.constants.Z_DEFAULT_CHUNK). */
#define SCR_ZLIB_CHUNK 16384

static void scr_zlib_oom(void) {
  scr_trap("scriptc: out of memory\n");
}

/* One codec call takes at most a uInt of input (avail_in), as Node's
 * writeSync takes a uint32 length: a larger input traps by name rather
 * than being silently cut (SEMANTICS.md S101 (c)). */
static uInt scr_zlib_in_len(size_t len) {
  if (len > (size_t)(uInt)-1) scr_trap("scriptc: zlib input larger than 4 GiB is not supported\n");
  return (uInt)len;
}

/* node_zlib.cc's ZlibStrerror: the return code's name, Node's err.code. */
static const char *scr_zlib_code_name(int rc) {
  switch (rc) {
  case Z_OK: return "Z_OK";
  case Z_STREAM_END: return "Z_STREAM_END";
  case Z_NEED_DICT: return "Z_NEED_DICT";
  case Z_ERRNO: return "Z_ERRNO";
  case Z_STREAM_ERROR: return "Z_STREAM_ERROR";
  case Z_DATA_ERROR: return "Z_DATA_ERROR";
  case Z_MEM_ERROR: return "Z_MEM_ERROR";
  case Z_BUF_ERROR: return "Z_BUF_ERROR";
  case Z_VERSION_ERROR: return "Z_VERSION_ERROR";
  default: return "Z_UNKNOWN_ERROR";
  }
}

/* The accumulated output: the concatenation of every chunk's produced
 * bytes, as Buffer.concat of processChunkSync's buffers. */
typedef struct {
  uint8_t *data;
  size_t len, cap;
} ScrZOut;

static uint8_t *scr_zout_chunk(ScrZOut *o) {
  if (o->cap - o->len < SCR_ZLIB_CHUNK) {
    size_t cap = o->cap ? o->cap : SCR_ZLIB_CHUNK;
    while (cap - o->len < SCR_ZLIB_CHUNK) cap *= 2;
    uint8_t *grown = realloc(o->data, cap);
    if (!grown) scr_zlib_oom();
    o->data = grown;
    o->cap = cap;
  }
  return o->data + o->len;
}

static ScrBytes *scr_zout_finish(ScrZOut *o) {
  ScrBytes *out = scr_bytes_new(SCR_BYTES_U8, (double)o->len);
  if (o->len) memcpy(out->data, o->data, o->len);
  free(o->data);
  return out;
}

/* node_zlib.cc's ZlibContext::GetErrorInfo for one call made with flush
 * Z_FINISH and no dictionary: NULL when the status is acceptable, else
 * the message (zlib's msg wins over Node's fallback, ErrorForMessage). */
static const char *scr_zlib_error_message(const z_stream *zs, int rc) {
  const char *fallback;
  switch (rc) {
  case Z_OK:
  case Z_BUF_ERROR:
    if (zs->avail_out == 0) return NULL;
    fallback = "unexpected end of file";
    break;
  case Z_STREAM_END:
    return NULL;
  case Z_NEED_DICT:
    fallback = "Missing dictionary";
    break;
  default:
    fallback = "Zlib error";
    break;
  }
  return zs->msg ? zs->msg : fallback;
}

/* ── the island's mode variants (scr_zlib_island.c bridges these into
 * the embedded engine's node:zlib shim; deflateSync/inflateSync are mode
 * 0) ─────────────────────────────────────────────────────────────────
 * mode: 0 zlib (windowBits 15), 1 raw (-15), 2 gzip (15+16); inflate
 * additionally takes 3 = auto-detect zlib/gzip (15+32, Node's unzip). */

static int scr_zlib_window_bits(int mode, bool inflating) {
  switch (mode) {
  case 1: return -15;
  case 2: return 15 + 16;
  case 3: return inflating ? 15 + 32 : 15;
  default: return 15;
  }
}

ScrBytes *scr_zlib_deflate_mode(const ScrBytes *data, double mode, double level) {
  z_stream zs;
  memset(&zs, 0, sizeof zs);
  int lvl = (int)level;
  if (lvl < -1 || lvl > 9) lvl = Z_DEFAULT_COMPRESSION;
  /* node_zlib.cc's Init: memLevel 8 and the default strategy are
   * zlib.js's defaults */
  if (deflateInit2(&zs, lvl, Z_DEFLATED, scr_zlib_window_bits((int)mode, false), 8,
                   Z_DEFAULT_STRATEGY) != Z_OK) {
    scr_zlib_oom();
  }
  ScrZOut o = {0};
  zs.next_in = data->data;
  zs.avail_in = scr_zlib_in_len(data->len);
  for (;;) {
    zs.next_out = scr_zout_chunk(&o);
    zs.avail_out = SCR_ZLIB_CHUNK;
    int rc = deflate(&zs, Z_FINISH);
    o.len += SCR_ZLIB_CHUNK - zs.avail_out;
    /* deflate of valid input with Z_FINISH answers only Z_OK (chunk
     * full) or Z_STREAM_END; anything else is a codec bug */
    if (scr_zlib_error_message(&zs, rc) != NULL) scr_zlib_oom();
    if (zs.avail_out != 0) break; /* processChunkSync: chunk not filled */
  }
  deflateEnd(&zs);
  return scr_zout_finish(&o);
}

/* One writeSync of node_zlib.cc's DoThreadPoolWork for the inflate modes:
 * UNZIP's gzip-magic sniff (which settles the mode to GUNZIP or INFLATE
 * on the first bytes it sees), the inflate call, and GUNZIP's
 * next-member loop (bytes left after a member's end that are not zero
 * padding start another member, or fail as one). */
typedef struct {
  int mode;           /* 0 INFLATE, 1 INFLATERAW, 2 GUNZIP, 3 UNZIP */
  int gzip_id_bytes;  /* UNZIP's gzip_id_bytes_read_ */
} ScrZInflate;

static int scr_zlib_inflate_call(ScrZInflate *st, z_stream *zs) {
  if (st->mode == 3) {
    const Bytef *next = zs->avail_in > 0 ? zs->next_in : NULL;
    switch (st->gzip_id_bytes) {
    case 0:
      if (next == NULL) break;
      if (*next == 0x1f) {
        st->gzip_id_bytes = 1;
        next++;
        if (zs->avail_in == 1) break; /* the only byte was read */
      } else {
        st->mode = 0;
        break;
      }
      /* fallthrough */
    case 1:
      if (next == NULL) break;
      if (*next == 0x8b) {
        st->gzip_id_bytes = 2;
        st->mode = 2;
      } else {
        st->mode = 0;
      }
      break;
    default:
      break;
    }
  }
  int rc = inflate(zs, Z_FINISH);
  while (zs->avail_in > 0 && st->mode == 2 && rc == Z_STREAM_END && zs->next_in[0] != 0x00) {
    (void)inflateReset(zs); /* Node's Reset(); its status is overwritten */
    rc = inflate(zs, Z_FINISH);
  }
  return rc;
}

ScrBytes *scr_zlib_inflate_mode(const ScrBytes *data, double mode) {
  z_stream zs;
  memset(&zs, 0, sizeof zs);
  ScrZInflate st = {(int)mode, 0};
  if (st.mode < 0 || st.mode > 3) st.mode = 0;
  if (inflateInit2(&zs, scr_zlib_window_bits(st.mode, true)) != Z_OK) scr_zlib_oom();
  ScrZOut o = {0};
  zs.next_in = data->data;
  zs.avail_in = scr_zlib_in_len(data->len);
  for (;;) {
    zs.next_out = scr_zout_chunk(&o);
    zs.avail_out = SCR_ZLIB_CHUNK;
    int rc = scr_zlib_inflate_call(&st, &zs);
    o.len += SCR_ZLIB_CHUNK - zs.avail_out;
    const char *msg = scr_zlib_error_message(&zs, rc);
    if (msg != NULL) {
      /* zlib's msg values are string literals: they outlive inflateEnd */
      inflateEnd(&zs);
      free(o.data);
      scr_throw_error_msg_code(SCR_ERR_ERROR, msg, strlen(msg), scr_zlib_code_name(rc));
      return NULL;
    }
    if (zs.avail_out != 0) break; /* processChunkSync: chunk not filled */
  }
  inflateEnd(&zs);
  return scr_zout_finish(&o);
}

ScrBytes *scr_zlib_deflate(const ScrBytes *data) {
  return scr_zlib_deflate_mode(data, 0, Z_DEFAULT_COMPRESSION);
}

ScrBytes *scr_zlib_inflate(const ScrBytes *data) {
  return scr_zlib_inflate_mode(data, 0);
}

/* One-shot raw-DEFLATE inflate into a caller-sized buffer: the island's
 * compressed embedded module text (the emitter stores big npm sources
 * deflated and their exact inflated length in the table row — the emitted
 * main installs this through scr_island_set_inflate). True only when the
 * stream ends exactly at dst_len; any mismatch is a build/runtime bug the
 * caller surfaces, never a silent truncation. */
bool scr_zlib_inflate_exact(const unsigned char *src, size_t src_len,
                            unsigned char *dst, size_t dst_len) {
  z_stream zs;
  memset(&zs, 0, sizeof zs);
  if (inflateInit2(&zs, -15) != Z_OK) return false; /* raw DEFLATE */
  zs.next_in = (Bytef *)(uintptr_t)src;
  zs.avail_in = (uInt)src_len;
  zs.next_out = dst;
  zs.avail_out = (uInt)dst_len;
  int rc = inflate(&zs, Z_FINISH);
  bool ok = rc == Z_STREAM_END && zs.total_out == dst_len;
  inflateEnd(&zs);
  return ok;
}
