/* util.inspect over island `any` values — the one translation unit that
 * references BOTH the inspect engine (scr_inspect.c) and the island
 * (scr_island.c), so cc.ts links it exactly when a --dynamic build's IR
 * carries insp.* libCalls (each half alone stays independent: static
 * inspect builds never pull engine symbols, inspect-free dynamic builds
 * never pull the renderer).
 *
 * The runtime tag is all the static world has for `any`: the scalar
 * kinds render byte-exactly (numbers through the -0-aware formatter,
 * strings through the quoting ladder, boolean/null/undefined as their
 * literals); plain-data composites (dense Arrays, plain objects of
 * enumerable data members) render through a read-only dyn snapshot of the
 * engine value (unit H); every other composite — functions, class
 * instances, accessors, holes, cycles — THROWS a catchable TypeError
 * instead of approximating (SEMANTICS.md S110 (e)). Callers are
 * compiler-emitted pending checks. */
#include "scr_runtime.h"

#include <stdio.h>
#include <string.h>

ScrStr *scr_insp_jsval(ScrJsval *v, double recurse, double depth) {
  if (scr_jsval_is_undefined(v)) return scr_str_new("undefined", 9);
  if (scr_jsval_is_nullish(v)) return scr_str_new("null", 4);
  ScrStr *ty = scr_jsval_typeof(v);
  if (ty && strcmp(ty->data, "number") == 0) {
    scr_str_release(ty);
    double x = 0;
    if (!scr_jsval_exit_f64(v, &x)) return NULL; /* typeof proved number */
    return scr_insp_f64(x);
  }
  if (ty && strcmp(ty->data, "string") == 0) {
    scr_str_release(ty);
    ScrStr *s = scr_jsval_exit_str(v);
    if (!s) return NULL;
    ScrStr *out = scr_insp_str(s);
    scr_str_release(s);
    return out;
  }
  if (ty && strcmp(ty->data, "boolean") == 0) {
    scr_str_release(ty);
    return scr_jsval_truthy(v) ? scr_str_new("true", 4) : scr_str_new("false", 5);
  }
  /* Plain data composites (dense Arrays, plain objects of enumerable data
   * members) render through the read-only dyn snapshot — unit H: the
   * engine walk the dyn tree's own renderer prints (scr_inspect.c's
   * SCR_DYN_JSVAL arm). Other engine shapes keep the fence below. */
  if (ty && (strcmp(ty->data, "object") == 0)) {
    ScrDyn *w = scr_dyn_from_jsval(v);
    if (!w) {
      scr_str_release(ty);
      return NULL;
    }
    double levels = (depth - recurse) + 2;
    if (levels > 1e9) levels = 1e9;
    ScrDyn *snap = w->kind == SCR_DYN_JSVAL ? scr_dyn_jsval_ops()->inspect_snapshot(w->v.jsval.cell, levels) : NULL;
    scr_dyn_release(w);
    if (snap) {
      scr_str_release(ty);
      ScrStr *out = scr_insp_dyn(snap, recurse, depth);
      scr_dyn_release(snap);
      return out;
    }
  }
  char buf[192];
  int n = snprintf(buf, sizeof buf,
                   "util.inspect of a composite 'any' value (typeof '%s') is not supported "
                   "yet — validate with 'as <type>' first",
                   ty ? ty->data : "unknown");
  if (ty) scr_str_release(ty);
  scr_throw_error_msg(SCR_ERR_TYPE, buf, (size_t)n);
  return NULL;
}
