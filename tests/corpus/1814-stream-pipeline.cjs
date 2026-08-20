// stream.pipeline — the callback form over stream stages: pipes chain
// (end: true), the callback fires once after the LAST 'close' (undefined
// on success — live-measured, Node calls the callback with 2 args on
// success, `(undefined, undefined)`), and a mid-stream error destroys
// every other stage with the SAME error in pipeline order — each emits
// 'error' then 'close', with no unhandled-'error' crash (pipeline owns
// the error). The teardown order asserted here is Node v24's probed
// order.
'use strict';
const { Readable, Writable, Transform, PassThrough, pipeline } = require('stream');

function wrap(fn) {
  return function (e) {
    return fn(e);
  };
}

let n = 0;
const src = new Readable({
  read() {
    n++;
    this.push(n <= 2 ? 'p' + n : null);
  },
});
const mid = new PassThrough();
const dst = new Writable({
  write(chunk, enc, cb) {
    console.log('dst:', chunk.toString());
    cb();
  },
});
pipeline(src, mid, dst, (err) => {
  console.log('ok-pipe cb:', err === undefined ? 'undefined' : 'unexpected');
  runErr();
});

function runErr() {
  const s = new Readable({ read() { this.push('x'); } });
  const t = new Transform({
    transform(chunk, enc, cb) {
      cb(new Error('boom'));
    },
  });
  const w = new Writable({ write(c, e, cb) { cb(); } });
  const order = [];
  s.on('close', () => order.push('s-close'));
  t.on('close', () => order.push('t-close'));
  w.on('close', () => order.push('w-close'));
  s.on('error', (e) => order.push('s-err:' + e.message));
  w.on('error', (e) => order.push('w-err:' + e.message));
  pipeline(s, t, w, wrap((err) => {
    console.log('err-pipe cb:', err.message);
    console.log('order:', order.join(','));
  }));
}
console.log('sync');
