// node:http options through checked-dynamic values: an Agent reads back
// Node's values (negatives kept, scheduling '' as 'lifo'); a request
// that throws in createSocket (a negative agent timeout) still leaves
// its empty agent.sockets entry, as does one that queues forever under
// maxSockets: -1; a non-number request timeout is validateNumber's
// TypeError; setHeader keeps a number; agent: false with a
// Connection: keep-alive header dials a fresh connection per request.
// Causally ordered.
'use strict';
const http = require('http');

function pass(x) { return x; }
function attempt(label, fn) {
  try {
    fn();
    console.log(label + ': ok');
  } catch (e) {
    console.log(label + ': ' + e.name + ' ' + e.code + ' ' + e.message);
  }
}

const neg = pass(new http.Agent({ keepAliveMsecs: -5, maxSockets: -1, maxFreeSockets: -2 }));
console.log('negatives:', neg.keepAliveMsecs, neg.maxSockets, neg.maxFreeSockets);
console.log('scheduling:', pass(new http.Agent({ scheduling: 'fifo' })).scheduling, pass(new http.Agent({ scheduling: '' })).scheduling, pass(new http.Agent()).scheduling);
attempt('scheduling with a quote', function () { new http.Agent({ scheduling: "it's" }); });
attempt('scheduling with every quote', function () { new http.Agent({ scheduling: 'a\'b"c`d' }); });
attempt('a long scheduling', function () { new http.Agent({ scheduling: 'x'.repeat(200) }); });

const server = http.createServer(function (rq, rs) {
  const req = pass(rq);
  const res = pass(rs);
  console.log('srv ' + req.url + ' connection=' + req.headers.connection);
  res.setHeader('X-Num', 7);
  console.log('getHeader number:', typeof res.getHeader('X-Num'), res.getHeader('X-Num'));
  console.log('getHeaders:', JSON.stringify(res.getHeaders()));
  res.end('ok');
});

let connections = 0;
server.on('connection', function () { connections++; });
server.listen(0, '127.0.0.1', function () {
  const port = server.address().port;
  const throwing = pass(new http.Agent({ timeout: -3 }));
  attempt('agent timeout -3', function () {
    http.request({ hostname: '127.0.0.1', port: port, agent: throwing });
  });
  const name = '127.0.0.1:' + port + ':';
  const keys = function (o) { return JSON.stringify(Object.keys(o).map(function (k) { return k === name ? 'NAME' : k; })); };
  console.log('sockets after the throw:', keys(throwing.sockets), JSON.stringify(throwing.sockets[name]));
  attempt('timeout a string', function () {
    http.request({ hostname: '127.0.0.1', port: port, timeout: pass('5') });
  });
  const stuck = pass(new http.Agent({ maxSockets: -1 }));
  const q = http.request({ hostname: '127.0.0.1', port: port, path: '/never', agent: stuck });
  q.on('error', function (e) { console.log('stuck error', e.message); });
  q.end();
  console.log('maxSockets -1 queues:', keys(stuck.sockets), keys(stuck.requests), stuck.sockets[name].length, stuck.requests[name].length);
  const r1 = http.request({ hostname: '127.0.0.1', port: port, path: '/one', agent: false, headers: { Connection: 'keep-alive' } }, function (res) {
    res.resume();
    res.on('end', function () {
      const r2 = http.request({ hostname: '127.0.0.1', port: port, path: '/two', agent: false, headers: { Connection: 'keep-alive' } }, function (res2) {
        res2.resume();
        res2.on('end', function () {
          console.log('connections:', connections);
          server.close();
          process.exit(0);
        });
      });
      r2.end();
    });
  });
  r1.end();
});
