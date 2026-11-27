/* U8c: the ways of a polymorphic inline-cache site
 * (docs/design/u8-dynamic-speed.md §4), shared by the read cache
 * (ic-read.ts) and the store cache (ic-write.ts).
 *
 * A site holds IC_WAYS ways, each a pair of plain mutable globals:
 *
 *   s_k: ref null $shape   the way's shape (starts as the $noShape
 *                          sentinel, which no object carries)
 *   i_k: i32               what the site does under s_k (the entry index
 *                          of a read; for a store, the index of an
 *                          existing key, or -1 - k for an append way)
 *
 * and one state global `n`: the number of ways filled (0..IC_WAYS), or
 * IC_MEGA once a site full of ways has missed on a further shape a fill
 * was offered for (the megamorphic state). Ways fill in order and are
 * never replaced: a (shape, index) fact stays true for as long as any
 * object carries the shape (shapes.ts), so a filled way never goes stale,
 * and a site that sees more shapes than it holds pays no refill (a store
 * of a reference) per miss. A megamorphic site keeps hitting its ways and
 * reads every other shape through the uncached path directly, which is the
 * speed before U8b plus the compares.
 *
 * Plain globals rather than one `$ic` struct, because the hit path then
 * loads each straight from the instance (U8b's choice, kept). */
import { Code } from "./code.js";
import type { DynBuilder } from "./dyn.js";
import { countIcMega } from "./ic-stats.js";
import { I32 } from "./module.js";

/** Ways per site, and the state of a megamorphic one. */
export const IC_WAYS = 4;
export const IC_MEGA = IC_WAYS + 1;

export interface IcSite {
  /** The ways' shape globals. */
  s: number[];
  /** The ways' index globals. */
  i: number[];
  /** The fill state (ways filled, or IC_MEGA). */
  n: number;
}

/** A fresh site's globals: every way's shape the no-shape sentinel, its
 * index 0; no way filled. */
export function newIcSite(d: DynBuilder): IcSite {
  const mb = d.shapesKit().mb;
  const none = d.shapes.noShapeG();
  const i32 = (): number =>
    mb.addGlobal(I32, true, (w) => {
      w.u8(0x41); // i32.const 0
      w.sleb(0);
    });
  const s: number[] = [];
  const i: number[] = [];
  for (let k = 0; k < IC_WAYS; k++) {
    s.push(
      mb.addGlobal(d.shapes.shapeRef(), true, (w) => {
        w.u8(0x23); // global.get $noShape
        w.uleb(none);
      }),
    );
    i.push(i32());
  }
  return { s, i, n: i32() };
}

/** The way match: with the receiver's shape in local `sh`, leaves the
 * matching way's index global's value, or branches to the label `missDepth`
 * levels out of the code around this call when no way holds the shape.
 * One block of IC_WAYS compares, each ~10 bytes: the first way answers
 * with one compare, as U8b's single-way site did. */
export function emitWayMatch(c: Code, site: IcSite, sh: number, missDepth: number): void {
  c.blockResult(I32);
  for (let k = 0; k < IC_WAYS; k++) {
    if (k > 0) c.drop();
    c.globalGet(site.i[k]!);
    c.localGet(sh);
    c.globalGet(site.s[k]!);
    c.refEq();
    c.brIf(0);
  }
  c.drop();
  c.br(missDepth + 1);
  c.end();
}

/** May the site still fill (it is not megamorphic)? Leaves i32. */
export function emitMayFill(c: Code, site: IcSite): void {
  c.globalGet(site.n);
  c.i32Const(IC_MEGA);
  c.i32LtU();
}

/** The fill of an offered way: sets way `n` through `setWay(k)` (which
 * stores the offer into `site.s[k]`, `site.i[k]` and anything else the
 * site keeps per way), or, with every way taken, makes the site
 * megamorphic. Only for a site that may still fill (emitMayFill). */
export function emitFill(c: Code, site: IcSite, setWay: (c: Code, k: number) => void): void {
  c.block(); // $after
  c.block(); // $full
  for (let k = IC_WAYS - 1; k >= 0; k--) c.block(); // $w3 .. $w0
  c.globalGet(site.n);
  c.brTable(
    Array.from({ length: IC_WAYS }, (_, k) => k),
    IC_WAYS,
  );
  for (let k = 0; k < IC_WAYS; k++) {
    c.end(); // $w_k
    setWay(c, k);
    // the labels left: $w_{k+1} .. $w3, $full, $after
    c.br(IC_WAYS - k);
  }
  c.end(); // $full: the site goes megamorphic
  countIcMega(c);
  c.end(); // $after
  c.globalGet(site.n);
  c.i32Const(1);
  c.i32Add();
  c.globalSet(site.n);
}
