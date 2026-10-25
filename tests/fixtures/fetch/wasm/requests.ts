// request-construction refusals and the failure causes
async function attempt(tag: string, p: Promise<Response>): Promise<void> {
  try {
    const r = await p;
    console.log(tag, "resolved", r.status);
  } catch (e) {
    if (e instanceof Error) console.log(tag, e.name, e.message);
  }
}
async function main(): Promise<void> {
  await attempt("rel:", fetch("/rel"));
  await attempt("method:", fetch("__BASE__/text", { method: "BAD METHOD" }));
  await attempt("getbody:", fetch("__BASE__/text", { body: "x" }));
  await attempt("cred:", fetch("http://u:p@127.0.0.1:1/"));
  await attempt("refused:", fetch("__REFUSED__"));
  const r = await fetch("__BASE__/post-echo", { method: "post", body: "hi" });
  const t2: string = await r.text();
  console.log("post:", t2);
  const b = await fetch("__BASE__/post-echo", { method: "PUT", body: new Uint8Array([104, 105]) });
  const t3: string = await b.text();
  console.log("bytes:", t3);
  const g = await fetch("__BASE__/gzip");
  const gt: string = await g.text();
  console.log("gzip:", gt.length, gt.slice(0, 20));
  const d = await fetch("__BASE__/deflate");
  const t4: string = await d.text();
  console.log("deflate:", t4);
  const m = await fetch("__BASE__/redirect", { redirect: "manual" });
  const loc = m.headers.get("location");
  console.log("manual:", `${m.status}`, `${m.redirected}`, loc);
}
main();
