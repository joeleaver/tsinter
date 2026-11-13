/* The wasmtime column of the library-mode harness: a port of host.mjs (the
 * test host) and of driver.mjs's v8 half, over wasmtime's C API.
 *
 *   host <module.wasm> <drive.txt> <contract.txt>
 *
 * contract.txt is the harness's flattening of the compile result's library
 * contract, one import per line:  import <module> <name> <cls,...|-> <result|->
 *
 * Every line printed here must equal driver.mjs's for the same row; keep the
 * two files in step (render(), the host table, the drive syntax). */
#include <ctype.h>
#include <inttypes.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wasm.h>
#include <wasmtime.h>

/* ── output ─────────────────────────────────────────────────────────────── */

static void die(const char *what, wasmtime_error_t *err, wasm_trap_t *trap) {
  wasm_byte_vec_t msg = {0};
  if (err != NULL) wasmtime_error_message(err, &msg);
  else if (trap != NULL) wasm_trap_message(trap, &msg);
  fprintf(stderr, "host: %s: %.*s\n", what, (int)msg.size, msg.data);
  exit(70);
}

static void json_string(FILE *f, const char *s, size_t n) {
  fputc('"', f);
  for (size_t i = 0; i < n; i++) {
    unsigned char c = (unsigned char)s[i];
    switch (c) {
      case '"': fputs("\\\"", f); break;
      case '\\': fputs("\\\\", f); break;
      case '\b': fputs("\\b", f); break;
      case '\f': fputs("\\f", f); break;
      case '\n': fputs("\\n", f); break;
      case '\r': fputs("\\r", f); break;
      case '\t': fputs("\\t", f); break;
      default:
        if (c < 0x20) fprintf(f, "\\u%04x", c);
        else fputc(c, f);
    }
  }
  fputc('"', f);
}

/* render(cls, v) for the numeric classes: host.mjs's render(). */
static void render_f64(FILE *f, double v) {
  if (v == 0 && signbit(v)) { fputs("-0", f); return; }
  if (v == trunc(v) && fabs(v) <= 9007199254740992.0) { fprintf(f, "%.0f", v); return; }
  uint64_t b;
  memcpy(&b, &v, 8);
  fprintf(f, "0x%016" PRIx64, b);
}

/* A value in every view the classes need (host.mjs's natural values). */
typedef struct {
  double d;
  int64_t i;
  uint64_t u;
  const char *s; /* string and list classes: bytes in guest memory */
  size_t n;      /* byte length (string) or element count (list) */
} V;

typedef enum { C_F64, C_F32, C_S32, C_U32, C_S64, C_U64, C_BOOL, C_STRING, C_LU8, C_LS32, C_LU32, C_LF32, C_LF64, C_NONE } Cls;

static Cls parse_cls(const char *s) {
  static const char *names[] = {"f64", "f32", "s32", "u32", "s64", "u64", "bool", "string", "list<u8>", "list<s32>", "list<u32>", "list<f32>", "list<f64>"};
  for (int i = 0; i < 13; i++) if (strcmp(s, names[i]) == 0) return (Cls)i;
  if (strcmp(s, "-") == 0) return C_NONE;
  fprintf(stderr, "host: unknown class %s\n", s);
  exit(70);
}

static int is_ptr_cls(Cls c) { return c >= C_STRING && c <= C_LF64; }

static V vd(double d) { V v = {0}; v.d = d; v.i = (int64_t)d; v.u = (uint64_t)(int64_t)d; return v; }
static V vi(int64_t i) { V v = {0}; v.i = i; v.u = (uint64_t)i; v.d = (double)i; return v; }
static V vu(uint64_t u) { V v = {0}; v.u = u; v.i = (int64_t)u; v.d = (double)u; return v; }

static void render(FILE *f, Cls c, V v, const uint8_t *mem) {
  switch (c) {
    case C_BOOL: fputs(v.i ? "true" : "false", f); break;
    case C_S32: case C_S64: fprintf(f, "%" PRId64, v.i); break;
    case C_U32: case C_U64: fprintf(f, "%" PRIu64, v.u); break;
    case C_F32: case C_F64: render_f64(f, v.d); break;
    case C_STRING: json_string(f, v.s, v.n); break;
    default: {
      fputc('[', f);
      for (size_t k = 0; k < v.n; k++) {
        if (k > 0) fputc(',', f);
        const uint8_t *p = (const uint8_t *)v.s;
        if (c == C_LU8) fprintf(f, "%u", p[k]);
        else if (c == C_LU32) { uint32_t x; memcpy(&x, p + 4 * k, 4); fprintf(f, "%" PRIu32, x); }
        else if (c == C_LS32) { int32_t x; memcpy(&x, p + 4 * k, 4); fprintf(f, "%" PRId32, x); }
        else if (c == C_LF32) { float x; memcpy(&x, p + 4 * k, 4); render_f64(f, (double)x); }
        else { double x; memcpy(&x, p + 8 * k, 8); render_f64(f, x); }
      }
      fputc(']', f);
    }
  }
  (void)mem;
}

/* ── the host state (host.mjs's createHost) ─────────────────────────────── */

#define MAX_FIELDS 64
typedef struct { uint32_t key_c, key_f; float v; } FieldVal;
typedef struct { uint64_t id; uint32_t kind; int nf; FieldVal f[MAX_FIELDS]; int alive; } Ent;
static Ent *ents;
static int nents, capents;
static uint64_t next_id = 1;
typedef struct { uint64_t *list; int n, i; } Cursor;
static Cursor *cursors;
static int next_cursor;
static uint64_t rand_state = 0x2545f4914f6cdd1dULL;
static char *names[256];
static size_t name_len[256];
static int nnames;

static wasmtime_context_t *ctx;
static wasmtime_memory_t memory;
static int have_memory;
static uint8_t *memp(void) { return have_memory ? wasmtime_memory_data(ctx, &memory) : NULL; }

static Ent *find(uint64_t id) {
  for (int i = 0; i < nents; i++) if (ents[i].alive && ents[i].id == id) return &ents[i];
  return NULL;
}

static float *field_of(Ent *e, uint32_t c, uint32_t f, int make) {
  for (int k = 0; k < e->nf; k++) if (e->f[k].key_c == c && e->f[k].key_f == f) return &e->f[k].v;
  if (!make || e->nf == MAX_FIELDS) return NULL;
  e->f[e->nf] = (FieldVal){c, f, 0};
  return &e->f[e->nf++].v;
}

static const double GIVE_F64[] = {0, -0.0, 1.5, NAN, INFINITY, -INFINITY, 9007199254740994.0, 5e-324, -123.25};
static const int32_t GIVE_S32[] = {0, -1, 2147483647, -2147483647 - 1, 42};
static const uint32_t GIVE_U32[] = {0, 1, 4294967295u, 2147483648u, 42};
static const int64_t GIVE_S64[] = {0, -1, INT64_MAX, INT64_MIN, 9007199254740993LL};
static const uint64_t GIVE_U64[] = {0, 1, UINT64_MAX, 9223372036854775808ULL, 9007199254740993ULL};

/* ── imports ──────────────────────────────────────────────────────────────── */

typedef struct {
  char module[64], name[64];
  Cls params[16];
  int np;
  Cls result;
} Import;
static Import imports[256];
static int nimports;

static void dump(void) {
  int live = 0;
  for (int i = 0; i < nents; i++) live += ents[i].alive;
  printf("entities %d\n", live);
  for (int i = 0; i < nents; i++) {
    Ent *e = &ents[i];
    if (!e->alive) continue;
    printf("  %" PRIu64 " kind %u", e->id, e->kind);
    /* sorted by (comp, field) */
    int order[MAX_FIELDS];
    for (int k = 0; k < e->nf; k++) order[k] = k;
    for (int a = 1; a < e->nf; a++)
      for (int b = a; b > 0; b--) {
        FieldVal *x = &e->f[order[b - 1]], *y = &e->f[order[b]];
        if (x->key_c > y->key_c || (x->key_c == y->key_c && x->key_f > y->key_f)) { int t = order[b]; order[b] = order[b - 1]; order[b - 1] = t; }
        else break;
      }
    for (int k = 0; k < e->nf; k++) {
      FieldVal *fv = &e->f[order[k]];
      printf(" %u.%u=", fv->key_c, fv->key_f);
      render_f64(stdout, (double)fv->v);
    }
    putchar('\n');
  }
  printf("components ");
  for (int i = 0; i < nnames; i++) { if (i > 0) putchar(' '); json_string(stdout, names[i], name_len[i]); }
  putchar('\n');
}

/* One import call: `a` holds the arguments in their classes; the answer is
 * the natural value of the import's result (host.mjs's table). */
static V call_import(const Import *im, const V *a) {
  const char *n = im->name;
  V r = {0};
  if (strncmp(n, "note_", 5) == 0) {
    printf("%s ", n);
    render(stdout, im->params[0], a[0], memp());
    putchar('\n');
  } else if (strcmp(n, "spawn") == 0) {
    if (nents == capents) { capents = capents ? 2 * capents : 16; ents = realloc(ents, sizeof(Ent) * capents); }
    Ent *e = &ents[nents++];
    memset(e, 0, sizeof *e);
    e->id = next_id++;
    e->kind = (uint32_t)a[0].d;
    e->alive = 1;
    r = vu(e->id);
  } else if (strcmp(n, "despawn") == 0) {
    Ent *e = find(a[0].u);
    if (e != NULL) e->alive = 0;
    r = vi(e != NULL);
  } else if (strcmp(n, "query_begin") == 0) {
    /* a ring of 64 cursors (host.mjs) */
    uint32_t m = (uint32_t)(int64_t)a[0].d;
    if (cursors == NULL) cursors = calloc(64, sizeof(Cursor));
    int slot = next_cursor++ % 64;
    Cursor *c = &cursors[slot];
    c->list = realloc(c->list, sizeof(uint64_t) * (nents + 1));
    c->n = 0;
    c->i = 0;
    for (int i = 0; i < nents; i++)
      if (ents[i].alive && (ents[i].kind & m) == m) c->list[c->n++] = ents[i].id;
    r = vu((uint64_t)slot + 1);
  } else if (strcmp(n, "query_next") == 0) {
    int k = (int)a[0].d;
    if (k < 1 || k > 64 || cursors == NULL || cursors[k - 1].i >= cursors[k - 1].n) r = vu(0);
    else r = vu(cursors[k - 1].list[cursors[k - 1].i++]);
  } else if (strcmp(n, "get_f32") == 0) {
    Ent *e = find(a[0].u);
    float *p = e != NULL ? field_of(e, (uint32_t)a[1].d, (uint32_t)a[2].d, 0) : NULL;
    r = vd(p != NULL ? (double)*p : 0.0);
  } else if (strcmp(n, "set_f32") == 0) {
    Ent *e = find(a[0].u);
    if (e != NULL) {
      float *p = field_of(e, (uint32_t)a[1].d, (uint32_t)a[2].d, 1);
      if (p != NULL) *p = (float)a[3].d;
    }
  } else if (strcmp(n, "rand_u64") == 0) {
    rand_state += 0x9e3779b97f4a7c15ULL;
    uint64_t z = rand_state;
    z = (z ^ (z >> 30)) * 0xbf58476d1ce4e5b9ULL;
    z = (z ^ (z >> 27)) * 0x94d049bb133111ebULL;
    r = vu(z ^ (z >> 31));
  } else if (strncmp(n, "give_", 5) == 0) {
    uint32_t k = (uint32_t)a[0].d;
    const char *c = n + 5;
    if (strcmp(c, "f64") == 0) r = vd(GIVE_F64[k % 9]);
    else if (strcmp(c, "f32") == 0) {
      static float f32s[7];
      f32s[0] = 0; f32s[1] = -0.0f; f32s[2] = 1.1f; f32s[3] = NAN; f32s[4] = INFINITY; f32s[5] = 3.4e38f; f32s[6] = 1e-45f;
      r = vd((double)f32s[k % 7]);
    } else if (strcmp(c, "s32") == 0) r = vi(GIVE_S32[k % 5]);
    else if (strcmp(c, "u32") == 0) r = vu(GIVE_U32[k % 5]);
    else if (strcmp(c, "s64") == 0) r = vi(GIVE_S64[k % 5]);
    else if (strcmp(c, "u64") == 0) r = vu(GIVE_U64[k % 5]);
    else r = vi(k % 2);
  } else if (strcmp(n, "log") == 0) {
    printf("log ");
    json_string(stdout, a[0].s, a[0].n);
    putchar('\n');
  } else if (strcmp(n, "report") == 0) {
    printf("report %u ", (uint32_t)a[0].d);
    json_string(stdout, a[1].s, a[1].n);
    putchar('\n');
  } else if (strcmp(n, "emit_command") == 0) {
    printf("command ");
    json_string(stdout, a[0].s, a[0].n);
    putchar('\n');
  } else if (strcmp(n, "register_component") == 0) {
    int i;
    for (i = 0; i < nnames; i++) if (name_len[i] == a[0].n && memcmp(names[i], a[0].s, a[0].n) == 0) break;
    if (i == nnames) {
      names[i] = malloc(a[0].n + 1);
      memcpy(names[i], a[0].s, a[0].n);
      name_len[i] = a[0].n;
      nnames++;
    }
    r = vu((uint64_t)i + 1);
  } else if (strncmp(n, "put_", 4) == 0) {
    printf("%s ", n);
    render(stdout, im->params[0], a[0], memp());
    putchar('\n');
  } else if (strcmp(n, "read_text") == 0) {
    static const char text[] = "h\xc3\xa9llo w\xc3\xb6rld \xe2\x98\x83 \xf0\x9d\x84\x9e";
    size_t len = sizeof text - 1;
    if (len <= (uint32_t)a[1].d) memcpy(memp() + (uint32_t)a[0].d, text, len);
    r = vu(len);
  } else if (strcmp(n, "get_vec3") == 0) {
    Ent *e = find(a[0].u);
    for (int k = 0; k < 3; k++) {
      float *p = e != NULL ? field_of(e, (uint32_t)a[1].d, (uint32_t)a[2].d + k, 0) : NULL;
      float v = p != NULL ? *p : 0.0f;
      memcpy(memp() + (uint32_t)a[3].d + 4 * k, &v, 4);
    }
  } else {
    fprintf(stderr, "host: no import %s.%s\n", im->module, n);
    exit(70);
  }
  fflush(stdout);
  return r;
}

static size_t list_elem(Cls c) { return c == C_LU8 ? 1 : c == C_LF64 ? 8 : 4; }

/* The boundary, wasm side: wasm values in the import's classes in, the
 * natural result out as the import's wasm result. */
static wasm_trap_t *dispatch(void *env, wasmtime_caller_t *caller, const wasmtime_val_t *args, size_t nargs,
                             wasmtime_val_t *results, size_t nresults) {
  (void)caller;
  (void)nargs;
  const Import *im = env;
  V a[16];
  size_t k = 0;
  for (int i = 0; i < im->np; i++) {
    Cls c = im->params[i];
    V v = {0};
    if (is_ptr_cls(c)) {
      uint32_t p = (uint32_t)args[k++].of.i32;
      uint32_t n = (uint32_t)args[k++].of.i32;
      v.s = (const char *)memp() + p;
      v.n = n;
      (void)list_elem;
    } else {
      const wasmtime_val_t *w = &args[k++];
      switch (c) {
        case C_F64: v = vd(w->of.f64); break;
        case C_F32: v = vd((double)w->of.f32); break;
        case C_S32: v = vi(w->of.i32); break;
        case C_U32: v = vu((uint32_t)w->of.i32); v.d = (double)(uint32_t)w->of.i32; break;
        case C_BOOL: v = vi(w->of.i32 != 0); break;
        case C_S64: v = vi(w->of.i64); break;
        case C_U64: v = vu((uint64_t)w->of.i64); break;
        default: break;
      }
    }
    a[i] = v;
  }
  V r = call_import(im, a);
  if (nresults == 1) {
    switch (im->result) {
      case C_F64: results[0].kind = WASMTIME_F64; results[0].of.f64 = r.d; break;
      case C_F32: results[0].kind = WASMTIME_F32; results[0].of.f32 = (float)r.d; break;
      case C_S32: case C_BOOL: results[0].kind = WASMTIME_I32; results[0].of.i32 = (int32_t)r.i; break;
      case C_U32: results[0].kind = WASMTIME_I32; results[0].of.i32 = (int32_t)(uint32_t)r.u; break;
      case C_S64: results[0].kind = WASMTIME_I64; results[0].of.i64 = r.i; break;
      case C_U64: results[0].kind = WASMTIME_I64; results[0].of.i64 = (int64_t)r.u; break;
      default: break;
    }
  }
  return NULL;
}

/* ── the drive script ─────────────────────────────────────────────────────── */

static char *slurp(const char *path, size_t *len) {
  FILE *f = fopen(path, "rb");
  if (f == NULL) { perror(path); exit(70); }
  fseek(f, 0, SEEK_END);
  long n = ftell(f);
  fseek(f, 0, SEEK_SET);
  char *buf = malloc((size_t)n + 1);
  if (fread(buf, 1, (size_t)n, f) != (size_t)n) { perror(path); exit(70); }
  buf[n] = 0;
  fclose(f);
  if (len != NULL) *len = (size_t)n;
  return buf;
}

/* JSON string literal → UTF-8 (driver.mjs's JSON.parse for string args). */
static char *json_decode(const char *s, size_t *out_len) {
  char *o = malloc(strlen(s) * 4 + 1);
  size_t n = 0;
  s++; /* opening quote */
  while (*s && *s != '"') {
    if (*s != '\\') { o[n++] = *s++; continue; }
    s++;
    char e = *s++;
    if (e == 'n') o[n++] = '\n';
    else if (e == 't') o[n++] = '\t';
    else if (e == 'r') o[n++] = '\r';
    else if (e == 'b') o[n++] = '\b';
    else if (e == 'f') o[n++] = '\f';
    else if (e == 'u') {
      unsigned cp = (unsigned)strtoul((char[]){s[0], s[1], s[2], s[3], 0}, NULL, 16);
      s += 4;
      if (cp >= 0xd800 && cp < 0xdc00 && s[0] == '\\' && s[1] == 'u') {
        unsigned lo = (unsigned)strtoul((char[]){s[2], s[3], s[4], s[5], 0}, NULL, 16);
        if (lo >= 0xdc00 && lo < 0xe000) { cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00); s += 6; }
      }
      if (cp >= 0xd800 && cp < 0xe000) cp = 0xfffd;
      if (cp < 0x80) o[n++] = (char)cp;
      else if (cp < 0x800) { o[n++] = (char)(0xc0 | (cp >> 6)); o[n++] = (char)(0x80 | (cp & 63)); }
      else if (cp < 0x10000) { o[n++] = (char)(0xe0 | (cp >> 12)); o[n++] = (char)(0x80 | ((cp >> 6) & 63)); o[n++] = (char)(0x80 | (cp & 63)); }
      else { o[n++] = (char)(0xf0 | (cp >> 18)); o[n++] = (char)(0x80 | ((cp >> 12) & 63)); o[n++] = (char)(0x80 | ((cp >> 6) & 63)); o[n++] = (char)(0x80 | (cp & 63)); }
    } else o[n++] = e;
  }
  o[n] = 0;
  *out_len = n;
  return o;
}

static wasmtime_instance_t instance;

static int get_func(const char *name, wasmtime_func_t *out) {
  wasmtime_extern_t item;
  if (!wasmtime_instance_export_get(ctx, &instance, name, strlen(name), &item) || item.kind != WASMTIME_EXTERN_FUNC) return 0;
  *out = item.of.func;
  return 1;
}

static uint32_t call_u32(const char *name) {
  wasmtime_func_t f;
  if (!get_func(name, &f)) { fprintf(stderr, "host: no export %s\n", name); exit(70); }
  wasmtime_val_t r;
  wasm_trap_t *trap = NULL;
  wasmtime_error_t *err = wasmtime_func_call(ctx, &f, NULL, 0, &r, 1, &trap);
  if (err != NULL || trap != NULL) die(name, err, trap);
  return (uint32_t)r.of.i32;
}

/* The export-side marshalling of one argument (P2: strings and lists go
 * through the module's alloc export). */
static char alloc_name[64] = "";
static int marshal_text(Cls c, const char *buf, wasmtime_val_t *w);
static char result_ptr_suffix[] = "_result_ptr";

static int marshal(Cls c, const char *text, int round, wasmtime_val_t *w) {
  /* $i substitution, into a buffer sized for the line (no truncation) */
  size_t cap = strlen(text) * 6 + 32, bn = 0;
  char *buf = malloc(cap);
  for (const char *p = text; *p; p++) {
    if (p[0] == '$' && p[1] == 'i') { bn += (size_t)snprintf(buf + bn, cap - bn, "%d", round); p++; }
    else buf[bn++] = *p;
  }
  buf[bn] = 0;
  int r = marshal_text(c, buf, w);
  free(buf);
  return r;
}

static int marshal_text(Cls c, const char *buf, wasmtime_val_t *w) {
  switch (c) {
    case C_F64: w->kind = WASMTIME_F64; w->of.f64 = strtod(buf, NULL); return 1;
    case C_F32: w->kind = WASMTIME_F32; w->of.f32 = (float)strtod(buf, NULL); return 1;
    case C_S32: case C_U32: w->kind = WASMTIME_I32; w->of.i32 = (int32_t)strtoll(buf, NULL, 0); return 1;
    case C_BOOL: w->kind = WASMTIME_I32; w->of.i32 = strcmp(buf, "true") == 0; return 1;
    case C_S64: w->kind = WASMTIME_I64; w->of.i64 = strtoll(buf, NULL, 10); return 1;
    case C_U64: w->kind = WASMTIME_I64; w->of.i64 = (int64_t)strtoull(buf, NULL, 10); return 1;
    case C_STRING: {
      size_t n;
      char *s = json_decode(buf, &n);
      wasmtime_func_t f;
      if (alloc_name[0] == 0 || !get_func(alloc_name, &f)) { fprintf(stderr, "host: a string argument needs the alloc export\n"); exit(70); }
      wasmtime_val_t a = {.kind = WASMTIME_I32, .of.i32 = (int32_t)n}, r;
      wasm_trap_t *trap = NULL;
      wasmtime_error_t *err = wasmtime_func_call(ctx, &f, &a, 1, &r, 1, &trap);
      if (err != NULL || trap != NULL) die("alloc", err, trap);
      memcpy(memp() + (uint32_t)r.of.i32, s, n);
      free(s);
      w[0].kind = WASMTIME_I32;
      w[0].of.i32 = r.of.i32;
      w[1].kind = WASMTIME_I32;
      w[1].of.i32 = (int32_t)n;
      return 2;
    }
    case C_LU8: case C_LS32: case C_LU32: case C_LF32: {
      /* a JSON array of numbers */
      size_t es = c == C_LU8 ? 1 : 4, n = 0, capn = 16;
      uint8_t *bytes = malloc(capn * es);
      for (const char *p = buf + 1; *p && *p != ']';) {
        while (*p == ' ' || *p == ',') p++;
        if (*p == ']' || !*p) break;
        char *end;
        double d = strtod(p, &end);
        p = end;
        if (n == capn) { capn *= 2; bytes = realloc(bytes, capn * es); }
        if (c == C_LU8) bytes[n] = (uint8_t)d;
        else if (c == C_LF32) { float f = (float)d; memcpy(bytes + 4 * n, &f, 4); }
        else if (c == C_LU32) { uint32_t u = (uint32_t)d; memcpy(bytes + 4 * n, &u, 4); }
        else { int32_t i = (int32_t)d; memcpy(bytes + 4 * n, &i, 4); }
        n++;
      }
      wasmtime_func_t f;
      if (alloc_name[0] == 0 || !get_func(alloc_name, &f)) { fprintf(stderr, "host: a list argument needs the alloc export\n"); exit(70); }
      wasmtime_val_t a = {.kind = WASMTIME_I32, .of.i32 = (int32_t)(n * es)}, r;
      wasm_trap_t *trap = NULL;
      wasmtime_error_t *err = wasmtime_func_call(ctx, &f, &a, 1, &r, 1, &trap);
      if (err != NULL || trap != NULL) die("alloc", err, trap);
      memcpy(memp() + (uint32_t)r.of.i32, bytes, n * es);
      free(bytes);
      w[0].kind = WASMTIME_I32;
      w[0].of.i32 = r.of.i32;
      w[1].kind = WASMTIME_I32;
      w[1].of.i32 = (int32_t)n;
      return 2;
    }
    default:
      fprintf(stderr, "host: class has no literal form\n");
      exit(70);
  }
}

static void print_error_buffer(const char *name) {
  printf("%s trapped\nerror ", name);
  uint32_t p = call_u32("tsinter_error_ptr");
  uint32_t n = call_u32("tsinter_error_len");
  json_string(stdout, (const char *)memp() + p, n);
  putchar('\n');
}

static void run_call(char **toks, int ntok, int round) {
  const char *name = toks[0];
  Cls res = C_NONE;
  wasmtime_val_t args[32];
  size_t na = 0;
  for (int i = 1; i < ntok; i++) {
    if (strcmp(toks[i], "->") == 0) { res = parse_cls(toks[i + 1]); break; }
    char cls[32];
    const char *colon = strchr(toks[i], ':');
    snprintf(cls, sizeof cls, "%.*s", (int)(colon - toks[i]), toks[i]);
    na += (size_t)marshal(parse_cls(cls), colon + 1, round, &args[na]);
  }
  wasmtime_func_t f;
  if (!get_func(name, &f)) { fprintf(stderr, "host: the module exports no %s\n", name); exit(70); }
  wasmtime_val_t r[1];
  wasm_trap_t *trap = NULL;
  wasmtime_error_t *err = wasmtime_func_call(ctx, &f, args, na, r, res == C_NONE || is_ptr_cls(res) ? 0 : 1, &trap);
  if (err != NULL) die(name, err, NULL);
  if (trap != NULL) {
    wasm_trap_delete(trap);
    print_error_buffer(name);
    return;
  }
  if (res == C_NONE) return;
  printf("%s -> ", name);
  if (is_ptr_cls(res)) {
    char pn[160], ln[160];
    snprintf(pn, sizeof pn, "%s%s", name, result_ptr_suffix);
    snprintf(ln, sizeof ln, "%s_result_len", name);
    uint32_t p = call_u32(pn), n = call_u32(ln);
    if (res == C_STRING) json_string(stdout, (const char *)memp() + p, n);
    else {
      V v = {0};
      v.s = (const char *)memp() + p;
      v.n = n;
      render(stdout, res, v, memp());
    }
  } else {
    V v = {0};
    switch (res) {
      case C_F64: v = vd(r[0].of.f64); break;
      case C_F32: v = vd((double)r[0].of.f32); break;
      case C_S32: case C_BOOL: v = vi(r[0].of.i32); break;
      case C_U32: v = vu((uint32_t)r[0].of.i32); break;
      case C_S64: v = vi(r[0].of.i64); break;
      case C_U64: v = vu((uint64_t)r[0].of.i64); break;
      default: break;
    }
    if (res == C_BOOL) v.i = v.i != 0;
    render(stdout, res, v, memp());
  }
  putchar('\n');
}

int main(int argc, char **argv) {
  if (argc != 4) { fprintf(stderr, "usage: host <module.wasm> <drive.txt> <contract.txt>\n"); return 64; }
  setvbuf(stdout, NULL, _IOFBF, 1 << 16);

  /* the contract */
  char *ct = slurp(argv[3], NULL);
  for (char *line = strtok(ct, "\n"); line != NULL; line = strtok(NULL, "\n")) {
    char kind[16], a[64], b[64], c[512], d[32];
    if (sscanf(line, "%15s", kind) != 1) continue;
    if (strcmp(kind, "alloc") == 0) { sscanf(line, "%*s %63s", alloc_name); continue; }
    if (strcmp(kind, "import") != 0) continue;
    if (sscanf(line, "%*s %63s %63s %511s %31s", a, b, c, d) != 4) { fprintf(stderr, "host: bad contract line %s\n", line); return 70; }
    Import *im = &imports[nimports++];
    snprintf(im->module, sizeof im->module, "%s", a);
    snprintf(im->name, sizeof im->name, "%s", b);
    im->np = 0;
    if (strcmp(c, "-") != 0)
      for (char *s = c, *e; s != NULL; s = e) {
        e = strchr(s, ',');
        if (e != NULL) *e++ = 0;
        im->params[im->np++] = parse_cls(s);
      }
    im->result = parse_cls(d);
  }

  /* the engine: wasmtime 47 with the proposals the module uses */
  wasm_config_t *config = wasm_config_new();
  wasmtime_config_wasm_gc_set(config, true);
  wasmtime_config_wasm_function_references_set(config, true);
  wasmtime_config_wasm_reference_types_set(config, true);
  /* SEMANTICS.md S142: the library contract requires max_wasm_stack of at
   * least 1 MiB (wasmtime's default is 512 KiB) */
  const char *stack = getenv("LIBMODE_MAX_WASM_STACK");
  wasmtime_config_max_wasm_stack_set(config, stack != NULL ? (size_t)strtoull(stack, NULL, 10) : (size_t)1 << 20);
  wasm_engine_t *engine = wasm_engine_new_with_config(config);
  wasmtime_store_t *store = wasmtime_store_new(engine, NULL, NULL);
  ctx = wasmtime_store_context(store);

  size_t wlen;
  char *wbytes = slurp(argv[1], &wlen);
  wasmtime_module_t *module = NULL;
  wasmtime_error_t *err = wasmtime_module_new(engine, (uint8_t *)wbytes, wlen, &module);
  if (err != NULL) die("compile", err, NULL);

  wasmtime_linker_t *linker = wasmtime_linker_new(engine);
  wasm_importtype_vec_t its;
  wasmtime_module_imports(module, &its);
  for (size_t i = 0; i < its.size; i++) {
    const wasm_name_t *m = wasm_importtype_module(its.data[i]);
    const wasm_name_t *n = wasm_importtype_name(its.data[i]);
    Import *im = NULL;
    for (int k = 0; k < nimports; k++)
      if (strlen(imports[k].module) == m->size && memcmp(imports[k].module, m->data, m->size) == 0 &&
          strlen(imports[k].name) == n->size && memcmp(imports[k].name, n->data, n->size) == 0)
        im = &imports[k];
    if (im == NULL) { fprintf(stderr, "host: the module imports %.*s.%.*s, which the contract does not name\n", (int)m->size, m->data, (int)n->size, n->data); return 70; }
    const wasm_functype_t *ft = wasm_externtype_as_functype_const(wasm_importtype_type(its.data[i]));
    err = wasmtime_linker_define_func(linker, m->data, m->size, n->data, n->size, ft, dispatch, im, NULL);
    if (err != NULL) die("define", err, NULL);
  }
  wasm_trap_t *trap = NULL;
  err = wasmtime_linker_instantiate(linker, ctx, module, &instance, &trap);
  if (err != NULL || trap != NULL) die("instantiate", err, trap);
  wasmtime_extern_t mem;
  if (wasmtime_instance_export_get(ctx, &instance, "memory", 6, &mem) && mem.kind == WASMTIME_EXTERN_MEMORY) {
    memory = mem.of.memory;
    have_memory = 1;
  }

  /* the drive script */
  char *drive = slurp(argv[2], NULL);
  char *save = NULL;
  for (char *line = strtok_r(drive, "\n", &save); line != NULL; line = strtok_r(NULL, "\n", &save)) {
    /* strip a comment: '#' at the start or after whitespace */
    for (char *p = line; *p; p++)
      if (*p == '#' && (p == line || isspace((unsigned char)p[-1]))) { *p = 0; break; }
    char *toks[64];
    int nt = 0;
    for (char *p = line; *p;) {
      while (*p && isspace((unsigned char)*p)) p++;
      if (!*p) break;
      char *start = p;
      int inq = 0;
      while (*p && (inq || !isspace((unsigned char)*p))) {
        if (*p == '"' && (p == start || p[-1] != '\\')) inq = !inq;
        p++;
      }
      if (*p) *p++ = 0;
      toks[nt++] = start;
    }
    if (nt == 0) continue;
    if (strcmp(toks[0], "dump") == 0) dump();
    else if (strcmp(toks[0], "call") == 0) run_call(toks + 1, nt - 1, 0);
    else if (strcmp(toks[0], "repeat") == 0) {
      int times = atoi(toks[1]);
      for (int i = 0; i < times; i++) run_call(toks + 2, nt - 2, i);
    } else { fprintf(stderr, "host: unknown command %s\n", toks[0]); return 70; }
    fflush(stdout);
  }
  return 0;
}
