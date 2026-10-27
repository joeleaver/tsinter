// @dynamic
/// <reference path="./decl.d.ts" />
// Board #260: a promise `.catch((e) => ...)` handler's `any` reason, when
// the reason was made by package code (the engine), is THAT value — its
// kind, its identity with the package's own references, aliasing inside
// it, cycles, writes through it, and an Error's own extra properties — for
// rejections and async throws alike, behind the static Promise.all
// bridge.
import * as R from "rejecter";
const r: any = R;

async function main(): Promise<void> {
  await Promise.all([r.fail("obj")]).then((): void => {}).catch((e) => {
    console.log(`obj ${typeof e} ${e.a} ${e.list.length}`);
  });
  await Promise.all([r.failAsync("fn")]).then((): void => {}).catch((e) => {
    console.log(`fn ${typeof e} ${e()} ${e === r.fn}`);
  });
  await Promise.all([r.fail("cyc")]).then((): void => {}).catch((e) => {
    console.log(`cyc ${e.self === e} ${e === r.cyc} ${e.a}`);
  });
  await Promise.all([r.failAsync("err")]).then((): void => {}).catch((e) => {
    console.log(`err ${e.name} ${e.message} ${e.extra} ${e === r.err}`);
  });
  await Promise.all([r.fail("alias")]).then((): void => {}).catch((e) => {
    e.x.n = 5;
    console.log(`alias ${e.y.n} ${e.x === e.y} ${r.shared.inner.n}`);
  });
  await Promise.all([r.fail("shared")]).then((): void => {}).catch((e) => {
    e.added = "yes";
    console.log(`shared ${e === r.shared} ${r.shared.added}`);
  });
  await Promise.all([r.fail("num")]).then((): void => {}).catch((e) => {
    console.log(`num ${typeof e} ${e + 1}`);
  });
  await Promise.all([r.fail("nul")]).then((): void => {}).catch((e) => {
    console.log(`nul ${e === null}`);
  });
  await Promise.all([r.failAsync("arr")]).then((): void => {}).catch((e) => {
    console.log(`arr ${typeof e} ${e.length} ${e[2]}`);
  });
}
void main();
