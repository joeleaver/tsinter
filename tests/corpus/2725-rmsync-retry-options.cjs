// fs.rmSync's maxRetries/retryDelay options-record form (fs.rmRetrySync →
// scr_fs_rm_opts_retry): Node retries EBUSY/EMFILE/ENFILE/ENOTEMPTY/EPERM
// with linear backoff; everything else behaves exactly like the plain
// { recursive, force } form — force swallows ENOENT, recursive removes
// trees post-order, and a missing target without force throws Node's
// ENOENT with `.code` stamped. The tmpdir-harness shape:
// rmSync(p, { maxRetries: 3, recursive: true, force: true }).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scr-rm-retry-'));
fs.mkdirSync(path.join(dir, 'a', 'b'), { recursive: true });
fs.writeFileSync(path.join(dir, 'a', 'f.txt'), 'payload');
fs.writeFileSync(path.join(dir, 'top.txt'), 'payload');

fs.rmSync(dir, { maxRetries: 3, recursive: true, force: true });
console.log('RM1', fs.existsSync(dir));

// force swallows the now-missing target, retries and all.
fs.rmSync(dir, { maxRetries: 3, recursive: true, force: true });
console.log('RM2', 'force-ok');

// retryDelay spelled explicitly (0 — no waiting on a clean run).
const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'scr-rm-retry-'));
fs.writeFileSync(path.join(dir2, 'one.txt'), 'x');
fs.rmSync(dir2, { maxRetries: 2, retryDelay: 0, recursive: true, force: false });
console.log('RM3', fs.existsSync(dir2));

// A missing target WITHOUT force still throws Node's ENOENT (not
// retryable — no backoff applies).
try {
  fs.rmSync(dir2, { maxRetries: 3, recursive: true, force: false });
  console.log('RM4', 'unreachable');
} catch (e) {
  if (e instanceof Error) {
    console.log('RM4', e.message.startsWith('ENOENT'));
  }
}
