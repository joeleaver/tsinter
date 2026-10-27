/* scr_web_prelude.js — the island's web-platform globals, ONE source for
 * both engines: the native island (scr_web.c) and the WasmGC tier's engine
 * (wasm/isl_core.c inside vendor/quickjs-ng-wasm/engine.wasm). After an
 * edit: node scripts/gen-web-prelude.mjs (the C literal both include,
 * scr_web_prelude.h), then node scripts/build-engine-wasm.mjs.
 *
 * One arrow function, evaluated at engine boot and called with a HOST
 * object — the only thing the two lanes implement separately:
 *
 *   host.write(fd, string)       console's fd write (the real stdio, in
 *                                order with static console output)
 *   host.fill(typedArray)        CSPRNG bytes into the view (validated here)
 *   host.uuid()                  a v4 UUID string
 *   host.tzname(ms)              the zone's name for Date#toString's suffix
 *   host.setTimer(fn, ms, rep)   setTimeout/setInterval on the static timer
 *   host.clearTimer(id)          heap; the island timer behind
 *   host.timer(fn, ms)           AbortSignal.timeout (unref'd)
 *   host.now()                   performance.now on the static side's
 *                                origin (Event#timeStamp, performance)
 *   host.isPromise(v), isProxy(v), proxyTarget(v), proxyHandler(v),
 *   host.promiseState(p)         internal-slot checks for structuredClone
 *                                and util.inspect ([state, result])
 *
 * It answers its internals object (what other boot scripts reach without
 * a global: mkResponse, uspReset, receiveMessageOnPort, inspect/format for
 * node:util, setURLClass for the URL boot, perf, and fenceGlobals /
 * isFenced, which each lane calls last at boot). The classes are
 * ports of Node v24.18.1's own (lib/internal/encoding.js, url.js,
 * per_context/domexception.js, errors.js; undici's Headers), messages and
 * codes byte for byte; SEMANTICS.md S108 states the subset and where it
 * parts from Node, and tests/harness/web-globals.test.ts holds every row
 * to Node live on both lanes. */
(host) => {
  'use strict';
  const g = globalThis;

  /* ── Node's error shapes and argument checks (lib/internal/errors.js,
   * lib/internal/validators.js — the messages and codes byte for byte).
   * A Node error is an instance of a per-code subclass of its base class
   * whose `constructor` answers the base, with an own enumerable `code`
   * and a prototype toString of `${name} [${code}]: ${message}`. */
  const nodeErrClasses = new Map();
  const nodeError = (Base, code, message) => {
    const key = Base.name + ' ' + code;
    let C = nodeErrClasses.get(key);
    if (C === undefined) {
      C = class NodeError extends Base {
        constructor(m) { super(m); this.code = code; }
        get ['constructor']() { return Base; }
        toString() { return `${this.name} [${code}]: ${this.message}`; }
      };
      nodeErrClasses.set(key, C);
    }
    return new C(message);
  };
  const formatList = (a, type = 'and') =>
    a.length < 3 ? a.join(` ${type} `) : `${a.slice(0, -1).join(', ')}, ${type} ${a[a.length - 1]}`;
  /* errors.js determineSpecificType. */
  const specificType = (value) => {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    switch (typeof value) {
    case 'bigint': return `type bigint (${value}n)`;
    case 'number':
      if (value === 0) return 1 / value === -Infinity ? 'type number (-0)' : 'type number (0)';
      return `type number (${value})`;
    case 'boolean': return value ? 'type boolean (true)' : 'type boolean (false)';
    case 'symbol': return `type symbol (${String(value)})`;
    case 'function': return `function ${value.name}`;
    case 'object':
      if (value.constructor && 'name' in value.constructor) return `an instance of ${value.constructor.name}`;
      return `${inspect(value, { depth: -1 })}`;
    case 'string':
      if (value.length > 28) value = `${value.slice(0, 25)}...`;
      if (value.indexOf("'") === -1) return `type string ('${value}')`;
      return `type string (${JSON.stringify(value)})`;
    }
    return String(value);
  };
  const kTypes = ['string', 'function', 'number', 'object', 'Function', 'Object', 'boolean', 'bigint', 'symbol'];
  const classRegExp = /^[A-Z][a-zA-Z0-9]*$/;
  const errInvalidArgType = (name, expected, actual) => {
    if (!Array.isArray(expected)) expected = [expected];
    let msg = 'The ';
    if (name.endsWith(' argument')) msg += `${name} `;
    else msg += `"${name}" ${name.includes('.') ? 'property' : 'argument'} `;
    msg += 'must be ';
    const types = [], instances = [], other = [];
    for (const value of expected) {
      if (kTypes.includes(value)) types.push(value.toLowerCase());
      else if (classRegExp.test(value)) instances.push(value);
      else other.push(value);
    }
    if (instances.length > 0) {
      const pos = types.indexOf('object');
      if (pos !== -1) { types.splice(pos, 1); instances.push('Object'); }
    }
    if (types.length > 0) {
      msg += `${types.length > 1 ? 'one of type' : 'of type'} ${formatList(types, 'or')}`;
      if (instances.length > 0 || other.length > 0) msg += ' or ';
    }
    if (instances.length > 0) {
      msg += `an instance of ${formatList(instances, 'or')}`;
      if (other.length > 0) msg += ' or ';
    }
    if (other.length > 0) {
      if (other.length > 1) msg += `one of ${formatList(other, 'or')}`;
      else { if (other[0].toLowerCase() !== other[0]) msg += 'an '; msg += `${other[0]}`; }
    }
    msg += `. Received ${specificType(actual)}`;
    return nodeError(TypeError, 'ERR_INVALID_ARG_TYPE', msg);
  };
  const errMissingArgs = (...args) =>
    nodeError(TypeError, 'ERR_MISSING_ARGS',
      `The ${formatList(args.map((a) => `"${a}"`))} argument${args.length > 1 ? 's' : ''} must be specified`);
  /* An error Node's C++ throws (THROW_ERR_*): a plain TypeError with an
   * own `code`. */
  const cppTypeError = (code, message) => { const e = new TypeError(message); e.code = code; return e; };
  const errInvalidThis = (type) => nodeError(TypeError, 'ERR_INVALID_THIS', `Value of "this" must be of type ${type}`);
  /* validators.js validateObject with kValidateObjectAllowObjectsAndNull. */
  const validateOptions = (v, name) => {
    if (v !== null && typeof v !== 'object' && typeof v !== 'function') throw errInvalidArgType(name, 'Object', v);
  };
  /* WebIDL USVString: lone surrogates become U+FFFD. */
  const toUSV = (v) => `${v}`.toWellFormed();
  /* Symbol.toStringTag on a prototype, as WebIDL classes carry it. */
  const tag = (C, name) => Object.defineProperty(C.prototype, Symbol.toStringTag, { value: name, writable: false, enumerable: false, configurable: true });
  /* A global as Node installs it: classes non-enumerable, functions
   * enumerable; both writable and configurable. */
  const defGlobal = (name, value, enumerable = false) =>
    Object.defineProperty(g, name, { value, writable: true, enumerable, configurable: true });
  /* What other boot scripts reach through the host instead of a global
   * (the prelude's return value; scr_web.c hands it on). */
  const internals = {};

  /* Timers: Node's setTimeout/clearTimeout/setInterval/clearInterval
   * for embedded code, bridged onto the SHARED static timer heap
   * (host.setTimer/host.clearTimer) — REF'd like Node's (an armed
   * timer keeps the process alive), FIFO-ordered against static
   * timers on one heap, Node's <1ms clamp. Returns a Timeout-shaped
   * object (ref/unref/refresh/close, numeric via toPrimitive) that
   * clearTimeout/clearInterval accept alongside plain ids; unref is
   * accepted but not honored (the entry stays ref'd — a documented
   * approximation). */
  class Timeout {
    constructor(fn, delay, repeat) {
      this._fn = fn;
      this._delay = delay;
      this._repeat = repeat;
      this._id = host.setTimer(fn, delay, repeat);
    }
    ref() { return this; }
    unref() { return this; }
    hasRef() { return true; }
    refresh() {
      host.clearTimer(this._id);
      this._id = host.setTimer(this._fn, this._delay, this._repeat);
      return this;
    }
    close() { host.clearTimer(this._id); return this; }
    [Symbol.toPrimitive]() { return this._id; }
  }
  const mkTimer = (fn, ms, args, repeat) => {
    if (typeof fn !== 'function') {
      throw new TypeError('The "callback" argument must be of type function. Received type ' + typeof fn);
    }
    const cb = args.length === 0 ? fn : () => fn(...args);
    return new Timeout(cb, Number(ms), repeat);
  };
  g.setTimeout = (fn, ms, ...args) => mkTimer(fn, ms, args, false);
  g.setInterval = (fn, ms, ...args) => mkTimer(fn, ms, args, true);
  g.clearTimeout = (t) => {
    if (t === undefined || t === null) return;
    const id = typeof t === 'number' ? t : Number(t);
    if (Number.isFinite(id)) host.clearTimer(id);
  };
  g.clearInterval = g.clearTimeout;

  /* ReadableStream / TransformStream: the WHATWG subset the embedded-npm
   * paths use, with every bit of state in a WeakMap-held record (nothing a
   * program can see or clobber) and Node's class shapes (methods and
   * getters enumerable on the prototype, ReadableStream.from). The
   * reader, writer and controllers are plain objects of the right members
   * rather than instances of Node's (unexposed) classes (S108 (c)). */
  const RS = new WeakMap();
  const rsOf = (o) => {
    const s = typeof o === 'object' && o !== null ? RS.get(o) : undefined;
    if (s === undefined) throw errInvalidThis('ReadableStream');
    return s;
  };
  const rsFinishClose = (s) => {
    if (s.state !== 'readable') return;
    s.state = 'closed';
    const reads = s.reads;
    s.reads = [];
    for (const r of reads) r.resolve({ value: undefined, done: true });
    if (s.closedResolve) s.closedResolve();
  };
  const rsError = (s, e) => {
    if (s.state !== 'readable') return;
    s.state = 'errored';
    s.storedError = e;
    s.queue.length = 0;
    const reads = s.reads;
    s.reads = [];
    for (const r of reads) r.reject(e);
    if (s.closedReject) s.closedReject(e);
  };
  /* Proactive pull, like the spec with the default HWM-1 strategy: pull
   * whenever there is space (queue empty), started, and no pull running. */
  const rsMaybePull = (s) => {
    const src = s.src;
    if (!src.pull || !s.started) return;
    if (s.state !== 'readable' || s.closeRequested) return;
    if (s.queue.length >= 1) return;
    if (s.pulling) { s.pullAgain = true; return; }
    s.pulling = true;
    Promise.resolve().then(() => {
      if (s.state !== 'readable' || s.closeRequested) { s.pulling = false; return; }
      let r;
      try { r = src.pull(s.controller); } catch (e) { s.pulling = false; rsError(s, e); return; }
      Promise.resolve(r).then(
        () => {
          s.pulling = false;
          if (s.pullAgain || s.queue.length === 0) { s.pullAgain = false; rsMaybePull(s); }
        },
        (e) => { s.pulling = false; rsError(s, e); },
      );
    });
  };
  const rsCancel = (s, reason) => {
    if (s.state === 'closed') return Promise.resolve();
    if (s.state === 'errored') return Promise.reject(s.storedError);
    s.queue.length = 0;
    s.closeRequested = true;
    rsFinishClose(s);
    const src = s.src;
    return Promise.resolve(src.cancel ? src.cancel(reason) : undefined).then(() => undefined);
  };
  const rsGetReader = (s) => {
    if (s.locked) throw new TypeError('ReadableStream is locked');
    s.locked = true;
    let res, rej;
    const closed = new Promise((a, b) => { res = a; rej = b; });
    closed.catch(() => {});
    s.closedResolve = res;
    s.closedReject = rej;
    if (s.state === 'closed') res();
    else if (s.state === 'errored') rej(s.storedError);
    let released = false;
    const reader = {
      get closed() { return closed; },
      read() {
        if (released) return Promise.reject(new TypeError('reader has been released'));
        if (s.queue.length > 0) {
          const chunk = s.queue.shift();
          if (s.closeRequested && s.queue.length === 0) rsFinishClose(s);
          else rsMaybePull(s);
          return Promise.resolve({ value: chunk, done: false });
        }
        if (s.state === 'closed') return Promise.resolve({ value: undefined, done: true });
        if (s.state === 'errored') return Promise.reject(s.storedError);
        return new Promise((resolve, reject) => {
          s.reads.push({ resolve, reject });
          rsMaybePull(s);
        });
      },
      releaseLock() {
        if (released) return;
        released = true;
        const reads = s.reads;
        s.reads = [];
        for (const r of reads) r.reject(new TypeError('reader was released'));
        s.locked = false;
        s.closedResolve = null;
        s.closedReject = null;
      },
      cancel(reason) {
        if (released) return Promise.reject(new TypeError('reader has been released'));
        return rsCancel(s, reason);
      },
    };
    Object.defineProperty(reader, Symbol.toStringTag, { value: 'ReadableStreamDefaultReader', configurable: true });
    return reader;
  };
  class ReadableStream {
    constructor(source = {}, strategy = {}) {
      if (source === null || typeof source !== 'object') {
        throw new TypeError('underlying source must be an object');
      }
      if (source.type !== undefined) {
        throw new RangeError("byte streams (type: 'bytes') are not supported in the scriptc island");
      }
      const s = {
        src: source, queue: [], state: 'readable', storedError: undefined, locked: false, reads: [],
        closeRequested: false, started: false, pulling: false, pullAgain: false,
        closedResolve: null, closedReject: null, controller: null,
      };
      RS.set(this, s);
      s.controller = {
        get desiredSize() {
          if (s.state === 'errored') return null;
          if (s.state === 'closed') return 0;
          return 1 - s.queue.length;
        },
        enqueue(chunk) {
          if (s.closeRequested || s.state !== 'readable') {
            throw new TypeError('cannot enqueue on a stream that is ' + (s.closeRequested ? 'closing' : s.state));
          }
          if (s.reads.length > 0) s.reads.shift().resolve({ value: chunk, done: false });
          else s.queue.push(chunk);
          rsMaybePull(s);
        },
        close() {
          if (s.closeRequested || s.state !== 'readable') {
            throw new TypeError('cannot close a stream that is ' + (s.closeRequested ? 'closing' : s.state));
          }
          s.closeRequested = true;
          if (s.queue.length === 0) rsFinishClose(s);
        },
        error(e) { rsError(s, e); },
      };
      Object.defineProperty(s.controller, Symbol.toStringTag, { value: 'ReadableStreamDefaultController', configurable: true });
      let startResult;
      if (source.start) startResult = source.start(s.controller); // a sync throw propagates, per spec
      Promise.resolve(startResult).then(
        () => { s.started = true; rsMaybePull(s); },
        (e) => rsError(s, e),
      );
    }
    get locked() { return rsOf(this).locked; }
    cancel(reason = undefined) {
      const s = rsOf(this);
      if (s.locked) return Promise.reject(new TypeError('cannot cancel a locked ReadableStream'));
      return rsCancel(s, reason);
    }
    getReader(options = {}) {
      const s = rsOf(this);
      if (options !== undefined && options !== null && options.mode !== undefined) {
        throw new TypeError('BYOB readers are not supported in the scriptc island');
      }
      return rsGetReader(s);
    }
    /* The iterator carries a `finished` latch because the ENGINE's
     * for-await closes more eagerly than V8: quickjs-ng calls return()
     * on NORMAL completion and after a next() rejection (V8 does
     * neither), and an unlatched return() would then cancel a released
     * reader — minting a rejected promise nobody awaits, which the
     * unhandled-rejection tracker reports at exit. Same story for the
     * no-op catch on return()'s result: the engine drops it on those
     * paths, so a real cancel rejection must be pre-observed (callers
     * who DO await it — the break path — still see the rejection). */
    values(options = {}) {
      const s = rsOf(this);
      const preventCancel = options !== undefined && options !== null && !!options.preventCancel;
      const reader = rsGetReader(s);
      let finished = false;
      const it = {
        next() {
          if (finished) return Promise.resolve({ value: undefined, done: true });
          return reader.read().then(
            (r) => {
              if (r.done) { finished = true; reader.releaseLock(); }
              return r;
            },
            (e) => { finished = true; reader.releaseLock(); throw e; },
          );
        },
        return(v) {
          if (finished) return Promise.resolve({ value: v, done: true });
          finished = true;
          const p = preventCancel ? Promise.resolve() : reader.cancel(v);
          reader.releaseLock();
          const res = p.then(() => ({ value: v, done: true }));
          res.catch(() => {});
          return res;
        },
        [Symbol.asyncIterator]() { return this; },
      };
      return it;
    }
    pipeThrough(transform, options = {}) {
      rsOf(this);
      if (transform === null || typeof transform !== 'object' || !transform.writable || !transform.readable) {
        throw new TypeError('pipeThrough requires a { writable, readable } pair');
      }
      if (options !== undefined && options !== null && options.signal !== undefined) {
        throw new Error('scriptc: AbortSignal is not supported by island streams yet');
      }
      pump(this, transform.writable);
      return transform.readable;
    }
    pipeTo() {
      throw new Error('ReadableStream.pipeTo is not supported in the scriptc island (use pipeThrough or a reader)');
    }
    tee() {
      throw new Error('ReadableStream.tee is not supported in the scriptc island');
    }
    /* Node's ReadableStream.from: an (async) iterable pulled one chunk per
     * pull; cancel calls the iterator's return. */
    static from(iterable) {
      /* webstreams/util.js getIterator(iterable, 'async'): a nullish
       * argument fails reading Symbol.asyncIterator (the engine's
       * message), a non-iterable is ERR_ARG_NOT_ITERABLE. */
      if (iterable === null || iterable === undefined) {
        throw new TypeError(`Cannot read properties of ${iterable} (reading 'Symbol(Symbol.asyncIterator)')`);
      }
      const notIterable = () => nodeError(TypeError, 'ERR_ARG_NOT_ITERABLE', formatArgs(['%s must be iterable', iterable]));
      const getIt = (method) => {
        if (typeof method !== 'function') throw notIterable();
        const iterator = method.call(iterable);
        if (typeof iterator !== 'object' || iterator === null) {
          throw nodeError(TypeError, 'ERR_INVALID_STATE', 'Invalid state: The iterator method must return an object');
        }
        return iterator;
      };
      let it;
      const am = iterable[Symbol.asyncIterator];
      if (am != null) it = getIt(am);
      else {
        const sm = iterable[Symbol.iterator];
        if (sm === undefined) throw notIterable();
        const sync = getIt(sm);
        const syncNext = sync.next;
        it = {
          next: () => Promise.resolve(syncNext.call(sync)).then((r) => Promise.resolve(r.value).then((value) => ({ value, done: r.done }))),
          return: (v) => Promise.resolve(typeof sync.return === 'function' ? sync.return(v) : { value: v, done: true }),
        };
      }
      return new ReadableStream({
        pull(c) {
          return Promise.resolve(it.next()).then((r) => {
            if (r === null || typeof r !== 'object') throw new TypeError('The promise returned by the iterator.next() method must fulfill with an object');
            if (r.done) c.close(); else c.enqueue(r.value);
          });
        },
        cancel(reason) {
          if (typeof it.return !== 'function') return undefined;
          return Promise.resolve(it.return(reason)).then((r) => {
            if (r === null || typeof r !== 'object') throw new TypeError('The promise returned by the iterator.return() method must fulfill with an object');
          });
        },
      });
    }
  }
  Object.defineProperty(ReadableStream.prototype, Symbol.asyncIterator, {
    value: ReadableStream.prototype.values, writable: true, enumerable: false, configurable: true,
  });

  /* The internal writable half of TransformStream. Deliberately NOT
   * installed as a global WritableStream: the island fences the class
   * (nothing in the supported graph constructs one). */
  const WS = new WeakMap();
  const wsOf = (o) => {
    const s = typeof o === 'object' && o !== null ? WS.get(o) : undefined;
    if (s === undefined) throw errInvalidThis('WritableStream');
    return s;
  };
  const wsError = (s, e) => {
    if (s.state === 'errored') return;
    s.state = 'errored';
    s.err = e;
    if (s.closedRej) s.closedRej(e);
  };
  const wsAbort = (s, e) => {
    if (s.state === 'errored') return Promise.resolve();
    wsError(s, e);
    return Promise.resolve(s.sink.abort ? s.sink.abort(e) : undefined).then(() => undefined);
  };
  class WritableStream {
    constructor(sink) {
      WS.set(this, { sink, state: 'writable', err: undefined, locked: false, closedRes: null, closedRej: null });
    }
    get locked() { return wsOf(this).locked; }
    abort(reason = undefined) { return wsAbort(wsOf(this), reason); }
    close() {
      const s = wsOf(this);
      if (s.locked) return Promise.reject(new TypeError('WritableStream is locked'));
      const w = this.getWriter();
      const p = w.close();
      w.releaseLock();
      return p;
    }
    getWriter() {
      const s = wsOf(this);
      if (s.locked) throw new TypeError('WritableStream is locked');
      s.locked = true;
      let res, rej;
      const closed = new Promise((a, b) => { res = a; rej = b; });
      closed.catch(() => {});
      s.closedRes = res;
      s.closedRej = rej;
      if (s.state === 'errored') rej(s.err);
      const writer = {
        get closed() { return closed; },
        get ready() { return s.state === 'errored' ? Promise.reject(s.err) : Promise.resolve(); },
        get desiredSize() {
          if (s.state === 'errored') return null;
          return s.state === 'writable' ? 1 : 0;
        },
        write(chunk) {
          if (s.state === 'errored') return Promise.reject(s.err);
          if (s.state !== 'writable') return Promise.reject(new TypeError('cannot write to a ' + s.state + ' stream'));
          let r;
          try { r = s.sink.write(chunk); } catch (e) { wsError(s, e); return Promise.reject(e); }
          return Promise.resolve(r).catch((e) => { wsError(s, e); throw e; });
        },
        close() {
          if (s.state === 'errored') return Promise.reject(s.err);
          if (s.state !== 'writable') return Promise.reject(new TypeError('cannot close a ' + s.state + ' stream'));
          s.state = 'closed';
          let r;
          try { r = s.sink.close ? s.sink.close() : undefined; } catch (e) { s.state = 'errored'; s.err = e; rej(e); return Promise.reject(e); }
          return Promise.resolve(r).then(
            () => { res(); },
            (e) => { s.state = 'errored'; s.err = e; rej(e); throw e; },
          );
        },
        abort(e) { return wsAbort(s, e); },
        releaseLock() { s.locked = false; },
      };
      Object.defineProperty(writer, Symbol.toStringTag, { value: 'WritableStreamDefaultWriter', configurable: true });
      return writer;
    }
  }
  tag(WritableStream, 'WritableStream');

  const pump = (rs, ws) => {
    const reader = rs.getReader();
    const writer = ws.getWriter();
    const step = () =>
      reader.read().then((r) => {
        if (r.done) return writer.close();
        return writer.write(r.value).then(step);
      });
    step().catch((e) => {
      writer.abort(e).catch(() => {});
      reader.cancel(e).catch(() => {});
    });
  };

  const TS = new WeakMap();
  const tsOf = (o) => {
    const s = typeof o === 'object' && o !== null ? TS.get(o) : undefined;
    if (s === undefined) throw errInvalidThis('TransformStream');
    return s;
  };
  class TransformStream {
    constructor(transformer = {}, writableStrategy = {}, readableStrategy = {}) {
      if (transformer === null) transformer = {};
      if (transformer.readableType !== undefined || transformer.writableType !== undefined) {
        throw new RangeError('readableType/writableType are not supported in the scriptc island');
      }
      const t = transformer;
      let rc = null;
      let readable, writable;
      readable = new ReadableStream({
        start(c) { rc = c; },
        cancel(reason) { wsError(WS.get(writable), reason); },
      });
      const rsS = RS.get(readable);
      const tc = {
        enqueue(chunk) { rc.enqueue(chunk); },
        error(e) {
          rsError(rsS, e);
          wsError(WS.get(writable), e);
        },
        terminate() {
          if (rsS.state === 'readable' && !rsS.closeRequested) rc.close();
          wsError(WS.get(writable), new TypeError('The transform stream has been terminated'));
        },
        get desiredSize() { return rc.desiredSize; },
      };
      Object.defineProperty(tc, Symbol.toStringTag, { value: 'TransformStreamDefaultController', configurable: true });
      writable = new WritableStream({
        /* Eager transform: writes run the transformer immediately (no
         * readable-side backpressure) — order-exact, documented. */
        write(chunk) {
          let r;
          try { r = t.transform ? t.transform(chunk, tc) : tc.enqueue(chunk); } catch (e) { tc.error(e); throw e; }
          return Promise.resolve(r).catch((e) => { tc.error(e); throw e; });
        },
        close() {
          let r;
          try { r = t.flush ? t.flush(tc) : undefined; } catch (e) { tc.error(e); throw e; }
          return Promise.resolve(r).then(
            () => {
              if (rsS.state === 'readable' && !rsS.closeRequested) rc.close();
            },
            (e) => { tc.error(e); throw e; },
          );
        },
        abort(e) { rsError(rsS, e); },
      });
      TS.set(this, { readable, writable });
      if (t.start) t.start(tc); // sync start, like eventsource-parser needs
    }
    get readable() { return tsOf(this).readable; }
    get writable() { return tsOf(this).writable; }
  }

  /* WebIDL shapes: methods and accessors enumerable on the prototype. */
  const webidlShape = (C, tagName) => {
    for (const k of Object.getOwnPropertyNames(C.prototype)) {
      if (k !== 'constructor') Object.defineProperty(C.prototype, k, { enumerable: true });
    }
    if (tagName !== undefined) tag(C, tagName);
  };
  webidlShape(ReadableStream, 'ReadableStream');
  webidlShape(TransformStream, 'TransformStream');
  webidlShape(WritableStream);
  defGlobal('ReadableStream', ReadableStream);
  defGlobal('TransformStream', TransformStream);


  /* ── TextEncoder / TextDecoder (lib/internal/encoding.js) ─────────── */
  const utf8Bytes = (s, out) => {
    for (let i = 0; i < s.length; i++) {
      let c = s.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff) {
        const n = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
        if (n >= 0xdc00 && n <= 0xdfff) { c = 0x10000 + ((c - 0xd800) << 10) + (n - 0xdc00); i++; }
        else c = 0xfffd;
      } else if (c >= 0xdc00 && c <= 0xdfff) c = 0xfffd;
      if (c <= 0x7f) out.push(c);
      else if (c <= 0x7ff) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c <= 0xffff) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return out;
  };
  class TextEncoder {
    #brand = true;
    static #check(o) { if (o === null || typeof o !== 'object' || !(#brand in o)) throw errInvalidThis('TextEncoder'); }
    get encoding() { TextEncoder.#check(this); return 'utf-8'; }
    encode(input = '') {
      TextEncoder.#check(this);
      return new Uint8Array(utf8Bytes(`${input}`, []));
    }
    /* Whole code points while they fit (a lone surrogate is U+FFFD's three
     * bytes); read counts UTF-16 units. */
    encodeInto(src, dest) {
      TextEncoder.#check(this);
      if (typeof src !== 'string') throw errInvalidArgType('src', 'string', src);
      if (!dest || !(dest instanceof Uint8Array)) throw errInvalidArgType('dest', 'Uint8Array', dest);
      let read = 0, written = 0;
      const cap = dest.length;
      const one = [];
      while (read < src.length) {
        const c = src.charCodeAt(read);
        const pair = c >= 0xd800 && c <= 0xdbff && read + 1 < src.length &&
          src.charCodeAt(read + 1) >= 0xdc00 && src.charCodeAt(read + 1) <= 0xdfff;
        one.length = 0;
        utf8Bytes(pair ? src.slice(read, read + 2) : src[read], one);
        if (written + one.length > cap) break;
        for (let k = 0; k < one.length; k++) dest[written++] = one[k];
        read += pair ? 2 : 1;
      }
      return { read, written };
    }
  }
  for (const k of ['encode', 'encodeInto', 'encoding']) {
    Object.defineProperty(TextEncoder.prototype, k, { enumerable: true });
  }
  tag(TextEncoder, 'TextEncoder');

  /* Node's label table (lib/internal/encoding.js): the utf-8 labels decode
   * here; every other WHATWG label Node knows is refused by name (the
   * island carries utf-8 only); anything else is Node's
   * ERR_ENCODING_NOT_SUPPORTED. */
  const UTF8_LABELS = ['unicode-1-1-utf-8', 'unicode11utf8', 'unicode20utf8', 'utf8', 'utf-8', 'x-unicode20utf8'];
  const OTHER_LABELS = new Map();
  for (const grp of 'ibm866=866,cp866,csibm866,ibm866;iso-8859-2=csisolatin2,iso-8859-2,iso-ir-101,iso8859-2,iso88592,iso_8859-2,iso_8859-2:1987,l2,latin2;iso-8859-3=csisolatin3,iso-8859-3,iso-ir-109,iso8859-3,iso88593,iso_8859-3,iso_8859-3:1988,l3,latin3;iso-8859-4=csisolatin4,iso-8859-4,iso-ir-110,iso8859-4,iso88594,iso_8859-4,iso_8859-4:1988,l4,latin4;iso-8859-5=csisolatincyrillic,cyrillic,iso-8859-5,iso-ir-144,iso8859-5,iso88595,iso_8859-5,iso_8859-5:1988;iso-8859-6=arabic,asmo-708,csiso88596e,csiso88596i,csisolatinarabic,ecma-114,iso-8859-6,iso-8859-6-e,iso-8859-6-i,iso-ir-127,iso8859-6,iso88596,iso_8859-6,iso_8859-6:1987;iso-8859-7=csisolatingreek,ecma-118,elot_928,greek,greek8,iso-8859-7,iso-ir-126,iso8859-7,iso88597,iso_8859-7,iso_8859-7:1987,sun_eu_greek;iso-8859-8=csiso88598e,csisolatinhebrew,hebrew,iso-8859-8,iso-8859-8-e,iso-ir-138,iso8859-8,iso88598,iso_8859-8,iso_8859-8:1988,visual;iso-8859-8-i=csiso88598i,iso-8859-8-i,logical;iso-8859-10=csisolatin6,iso-8859-10,iso-ir-157,iso8859-10,iso885910,l6,latin6;iso-8859-13=iso-8859-13,iso8859-13,iso885913;iso-8859-14=iso-8859-14,iso8859-14,iso885914;iso-8859-15=csisolatin9,iso-8859-15,iso8859-15,iso885915,iso_8859-15,l9;iso-8859-16=iso-8859-16;koi8-r=cskoi8r,koi,koi8,koi8-r,koi8_r;koi8-u=koi8-ru,koi8-u;macintosh=csmacintosh,mac,macintosh,x-mac-roman;windows-874=dos-874,iso-8859-11,iso8859-11,iso885911,tis-620,windows-874;windows-1250=cp1250,windows-1250,x-cp1250;windows-1251=cp1251,windows-1251,x-cp1251;windows-1252=ansi_x3.4-1968,ascii,cp1252,cp819,csisolatin1,ibm819,iso-8859-1,iso-ir-100,iso8859-1,iso88591,iso_8859-1,iso_8859-1:1987,l1,latin1,us-ascii,windows-1252,x-cp1252;windows-1253=cp1253,windows-1253,x-cp1253;windows-1254=cp1254,csisolatin5,iso-8859-9,iso-ir-148,iso8859-9,iso88599,iso_8859-9,iso_8859-9:1989,l5,latin5,windows-1254,x-cp1254;windows-1255=cp1255,windows-1255,x-cp1255;windows-1256=cp1256,windows-1256,x-cp1256;windows-1257=cp1257,windows-1257,x-cp1257;windows-1258=cp1258,windows-1258,x-cp1258;x-mac-cyrillic=x-mac-cyrillic,x-mac-ukrainian;gbk=chinese,csgb2312,csiso58gb231280,gb2312,gb_2312,gb_2312-80,gbk,iso-ir-58,x-gbk;gb18030=gb18030;big5=big5,big5-hkscs,cn-big5,csbig5,x-x-big5;euc-jp=cseucpkdfmtjapanese,euc-jp,x-euc-jp;iso-2022-jp=csiso2022jp,iso-2022-jp;shift_jis=csshiftjis,ms932,ms_kanji,shift-jis,shift_jis,sjis,windows-31j,x-sjis;euc-kr=cseuckr,csksc56011987,euc-kr,iso-ir-149,korean,ks_c_5601-1987,ks_c_5601-1989,ksc5601,ksc_5601,windows-949;replacement=csiso2022kr,hz-gb-2312,iso-2022-cn,iso-2022-cn-ext,iso-2022-kr,replacement;utf-16be=unicodefffe,utf-16be;utf-16le=csunicode,iso-10646-ucs-2,ucs-2,unicode,unicodefeff,utf-16le,utf-16;x-user-defined=x-user-defined'.split(';')) {
    const at = grp.indexOf('=');
    for (const l of grp.slice(at + 1).split(',')) OTHER_LABELS.set(l, grp.slice(0, at));
  }
  const trimAsciiWs = (s) => s.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, '');
  const errInvalidData = () => nodeError(TypeError, 'ERR_ENCODING_INVALID_ENCODED_DATA', 'The encoded data was not valid for encoding utf-8');
  const isAnyArrayBuffer = (v) =>
    v instanceof ArrayBuffer || (typeof SharedArrayBuffer === 'function' && v instanceof SharedArrayBuffer);

  /* The WHATWG utf-8 decoder state machine, exactly (maximal-subpart
   * replacement, streaming carry, BOM stripping, fatal mode). */
  class TextDecoder {
    #fatal; #ignoreBOM; #cp = 0; #needed = 0; #seen = 0; #lo = 0x80; #hi = 0xbf; #bomPending;
    static #check(o) { if (o === null || typeof o !== 'object' || !(#fatal in o)) throw errInvalidThis('TextDecoder'); }
    constructor(encoding = 'utf-8', options = {}) {
      encoding = `${encoding}`;
      validateOptions(options, 'options');
      const l = trimAsciiWs(encoding.toLowerCase());
      if (!UTF8_LABELS.includes(encoding) && !UTF8_LABELS.includes(l)) {
        const enc = OTHER_LABELS.get(encoding) ?? OTHER_LABELS.get(l);
        /* The "replacement" labels name no decoder Node can build. */
        if (enc === 'replacement') {
          throw nodeError(RangeError, 'ERR_ENCODING_NOT_SUPPORTED', 'The "replacement" encoding is not supported');
        }
        if (enc !== undefined) {
          throw new RangeError("the scriptc island's TextDecoder supports utf-8 only (got '" + l + "')");
        }
        throw nodeError(RangeError, 'ERR_ENCODING_NOT_SUPPORTED', `The "${encoding}" encoding is not supported`);
      }
      this.#fatal = Boolean(options?.fatal);
      this.#ignoreBOM = Boolean(options?.ignoreBOM);
      this.#bomPending = !this.#ignoreBOM;
    }
    get encoding() { TextDecoder.#check(this); return 'utf-8'; }
    get fatal() { TextDecoder.#check(this); return this.#fatal; }
    get ignoreBOM() { TextDecoder.#check(this); return this.#ignoreBOM; }
    #reset() {
      this.#cp = 0; this.#needed = 0; this.#seen = 0; this.#lo = 0x80; this.#hi = 0xbf;
      this.#bomPending = !this.#ignoreBOM;
    }
    decode(input = undefined, options = {}) {
      TextDecoder.#check(this);
      validateOptions(options, 'options');
      const stream = Boolean(options?.stream);
      let bytes;
      if (input === undefined) bytes = new Uint8Array(0);
      else if (isAnyArrayBuffer(input)) bytes = new Uint8Array(input);
      else if (ArrayBuffer.isView(input)) bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
      else if (!stream && this.#needed === 0) {
        /* Node's non-streaming fast path checks in C++, with its own text. */
        throw nodeError(TypeError, 'ERR_INVALID_ARG_TYPE', 'The "list" argument must be an instance of SharedArrayBuffer, ArrayBuffer or ArrayBufferView.');
      } else throw errInvalidArgType('input', ['ArrayBuffer', 'ArrayBufferView'], input);
      const units = [];
      const fail = () => {
        if (this.#fatal) { this.#reset(); throw errInvalidData(); }
        units.push(0xfffd);
      };
      const emit = (cp) => {
        if (cp <= 0xffff) units.push(cp);
        else { cp -= 0x10000; units.push(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff)); }
      };
      for (let i = 0; i < bytes.length; i++) {
        const b = bytes[i];
        if (this.#needed === 0) {
          if (b <= 0x7f) { emit(b); continue; }
          if (b >= 0xc2 && b <= 0xdf) { this.#needed = 1; this.#cp = b & 0x1f; }
          else if (b >= 0xe0 && b <= 0xef) {
            if (b === 0xe0) this.#lo = 0xa0;
            if (b === 0xed) this.#hi = 0x9f;
            this.#needed = 2; this.#cp = b & 0xf;
          } else if (b >= 0xf0 && b <= 0xf4) {
            if (b === 0xf0) this.#lo = 0x90;
            if (b === 0xf4) this.#hi = 0x8f;
            this.#needed = 3; this.#cp = b & 0x7;
          } else fail();
          continue;
        }
        if (b < this.#lo || b > this.#hi) {
          this.#cp = 0; this.#needed = 0; this.#seen = 0; this.#lo = 0x80; this.#hi = 0xbf;
          fail();
          i--; // reprocess as a sequence start
          continue;
        }
        this.#lo = 0x80; this.#hi = 0xbf;
        this.#cp = (this.#cp << 6) | (b & 0x3f);
        if (++this.#seen === this.#needed) {
          emit(this.#cp);
          this.#cp = 0; this.#needed = 0; this.#seen = 0;
        }
      }
      if (!stream && this.#needed !== 0) {
        this.#cp = 0; this.#needed = 0; this.#seen = 0; this.#lo = 0x80; this.#hi = 0xbf;
        fail();
      }
      let start = 0;
      if (this.#bomPending && units.length > 0) {
        this.#bomPending = false;
        if (units[0] === 0xfeff) start = 1;
      }
      let s = '';
      for (let i = start; i < units.length; i += 4096) {
        s += String.fromCharCode.apply(null, units.slice(i, i + 4096));
      }
      if (!stream) this.#reset();
      return s;
    }
  }
  for (const k of ['decode', 'encoding', 'fatal', 'ignoreBOM']) {
    Object.defineProperty(TextDecoder.prototype, k, { enumerable: true });
  }
  tag(TextDecoder, 'TextDecoder');

  /* TextDecoderStream: Node's shape (its own class over a private
   * TransformStream, not a subclass of it). */
  const TDS = new WeakMap();
  const tdsOf = (o) => {
    const s = typeof o === 'object' && o !== null ? TDS.get(o) : undefined;
    if (s === undefined) throw errInvalidThis('TextDecoderStream');
    return s;
  };
  class TextDecoderStream {
    constructor(encoding = 'utf-8', options = {}) {
      const dec = new TextDecoder(encoding, options);
      const ts = new TransformStream({
        transform(chunk, c) {
          const s = dec.decode(chunk, { stream: true });
          if (s !== '') c.enqueue(s);
        },
        flush(c) {
          const s = dec.decode();
          if (s !== '') c.enqueue(s);
        },
      });
      TDS.set(this, { dec, ts });
    }
    get encoding() { return tdsOf(this).dec.encoding; }
    get fatal() { return tdsOf(this).dec.fatal; }
    get ignoreBOM() { return tdsOf(this).dec.ignoreBOM; }
    get readable() { return tdsOf(this).ts.readable; }
    get writable() { return tdsOf(this).ts.writable; }
  }
  webidlShape(TextDecoderStream);

  /* ── URLSearchParams (lib/internal/url.js, querystring.js) ─────────── */
  const HEX = '0123456789ABCDEF';
  const isHex = (c) => (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);
  const hexVal = (c) => (c <= 57 ? c - 48 : (c | 0x20) - 87);
  /* querystring.unescapeBuffer, then Buffer's utf-8 decode (replacement). */
  const unescapeBuffer = (s) => {
    const out = [];
    const maxLength = s.length - 2;
    let index = 0;
    while (index < s.length) {
      let cur = s.charCodeAt(index);
      if (cur === 37 && index < maxLength) {
        cur = s.charCodeAt(++index);
        if (!isHex(cur)) { out.push(37); continue; }
        const next = s.charCodeAt(++index);
        if (!isHex(next)) { out.push(37); index--; }
        else cur = hexVal(cur) * 16 + hexVal(next);
      }
      out.push(cur & 0xff);
      index++;
    }
    return new TextDecoder().decode(new Uint8Array(out));
  };
  const qsUnescape = (s) => {
    try { return decodeURIComponent(s); } catch { return unescapeBuffer(s); }
  };
  /* url.js parseParams: the flat [name, value, ...] list. */
  const parseParams = (qs) => {
    const out = [];
    let seenSep = false, buf = '', encoded = false, encodeCheck = 0;
    let i = qs[0] === '?' ? 1 : 0;
    let pairStart = i, lastPos = i;
    for (; i < qs.length; ++i) {
      const code = qs.charCodeAt(i);
      if (code === 38) { // '&'
        if (pairStart === i) { lastPos = pairStart = i + 1; continue; }
        if (lastPos < i) buf += qs.slice(lastPos, i);
        if (encoded) buf = qsUnescape(buf);
        out.push(buf);
        if (!seenSep) out.push('');
        seenSep = false; buf = ''; encoded = false; encodeCheck = 0;
        lastPos = pairStart = i + 1;
        continue;
      }
      if (!seenSep && code === 61) { // '='
        if (lastPos < i) buf += qs.slice(lastPos, i);
        if (encoded) buf = qsUnescape(buf);
        out.push(buf);
        seenSep = true; buf = ''; encoded = false; encodeCheck = 0;
        lastPos = i + 1;
        continue;
      }
      if (code === 43) { // '+'
        if (lastPos < i) buf += qs.slice(lastPos, i);
        buf += ' ';
        lastPos = i + 1;
      } else if (!encoded) {
        if (code === 37) encodeCheck = 1;
        else if (encodeCheck > 0) {
          if (isHex(code)) { if (++encodeCheck === 3) encoded = true; }
          else encodeCheck = 0;
        }
      }
    }
    if (pairStart === i) return out;
    if (lastPos < i) buf += qs.slice(lastPos, i);
    if (encoded) buf = qsUnescape(buf);
    out.push(buf);
    if (!seenSep) out.push('');
    return out;
  };
  /* The application/x-www-form-urlencoded byte serializer (url.js
   * serializeParams over querystring's encodeStr; inputs are USVStrings). */
  const FORM_SAFE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789*-._';
  const formEncode = (s) => {
    let out = '';
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c < 0x80) {
        if (c === 0x20) out += '+';
        else if (FORM_SAFE.indexOf(s[i]) >= 0) out += s[i];
        else out += '%' + HEX[c >> 4] + HEX[c & 15];
        continue;
      }
      const bytes = utf8Bytes(c >= 0xd800 && c <= 0xdbff ? s.slice(i, ++i + 1) : s[i], []);
      for (const b of bytes) out += '%' + HEX[b >> 4] + HEX[b & 15];
    }
    return out;
  };
  const serializeParams = (a) => {
    let out = '';
    for (let i = 0; i < a.length; i += 2) out += (i === 0 ? '' : '&') + formEncode(a[i]) + '=' + formEncode(a[i + 1]);
    return out;
  };
  const mergeSort = (out, start, mid, end, lBuffer, rBuffer) => {
    const sizeLeft = mid - start, sizeRight = end - mid;
    let l, r, o;
    for (l = 0; l < sizeLeft; l++) lBuffer[l] = out[start + l];
    for (r = 0; r < sizeRight; r++) rBuffer[r] = out[mid + r];
    l = 0; r = 0; o = start;
    while (l < sizeLeft && r < sizeRight) {
      if (lBuffer[l] <= rBuffer[r]) { out[o++] = lBuffer[l++]; out[o++] = lBuffer[l++]; }
      else { out[o++] = rBuffer[r++]; out[o++] = rBuffer[r++]; }
    }
    while (l < sizeLeft) out[o++] = lBuffer[l++];
    while (r < sizeRight) out[o++] = rBuffer[r++];
  };
  const IteratorPrototype = Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]()));
  let uspList;
  class URLSearchParamsIterator {
    #target; #kind; #index;
    constructor(target, kind) { this.#target = target; this.#kind = kind; this.#index = 0; }
    next() {
      if (typeof this !== 'object' || this === null || !(#target in this)) throw errInvalidThis('URLSearchParamsIterator');
      const index = this.#index;
      const values = uspList(this.#target);
      if (index >= values.length) return { value: undefined, done: true };
      const name = values[index], value = values[index + 1];
      this.#index = index + 2;
      return { value: this.#kind === 'key' ? name : this.#kind === 'value' ? value : [name, value], done: false };
    }
  }
  delete URLSearchParamsIterator.prototype.constructor;
  Object.setPrototypeOf(URLSearchParamsIterator.prototype, IteratorPrototype);
  Object.defineProperty(URLSearchParamsIterator.prototype, 'next', { enumerable: true });
  tag(URLSearchParamsIterator, 'URLSearchParams Iterator');
  const errTuple = () => nodeError(TypeError, 'ERR_INVALID_TUPLE', 'Each query pair must be an iterable [name, value] tuple');

  class URLSearchParams {
    #searchParams = [];
    static {
      uspList = (o) => o.#searchParams;
      /* The island URL class's search setter re-parses into ITS params. */
      internals.uspReset = (o, query) => { o.#searchParams = parseParams(toUSV(query)); };
    }
    static #check(o) { if (typeof o !== 'object' || o === null || !(#searchParams in o)) throw errInvalidThis('URLSearchParams'); }
    constructor(init = undefined) {
      if (init == null) {
        // nothing
      } else if (typeof init === 'object' || typeof init === 'function') {
        const method = init[Symbol.iterator];
        if (method === this[Symbol.iterator] && #searchParams in init) {
          this.#searchParams = init.#searchParams.slice();
        } else if (method != null) {
          if (typeof method !== 'function') throw nodeError(TypeError, 'ERR_ARG_NOT_ITERABLE', 'Query pairs must be iterable');
          for (const pair of init) {
            if (pair == null) throw errTuple();
            else if (Array.isArray(pair)) {
              if (pair.length !== 2) throw errTuple();
              this.#searchParams.push(toUSV(pair[0]), toUSV(pair[1]));
            } else {
              if ((typeof pair !== 'object' && typeof pair !== 'function') || typeof pair[Symbol.iterator] !== 'function') throw errTuple();
              let length = 0;
              for (const element of pair) { length++; this.#searchParams.push(toUSV(element)); }
              if (length !== 2) throw errTuple();
            }
          }
        } else {
          const visited = new Map();
          for (const key of Reflect.ownKeys(init)) {
            const desc = Reflect.getOwnPropertyDescriptor(init, key);
            if (desc !== undefined && desc.enumerable) {
              const typedKey = String.prototype.toWellFormed.call(key);
              const typedValue = toUSV(init[key]);
              const keyIdx = visited.get(typedKey);
              if (keyIdx !== undefined) this.#searchParams[keyIdx] = typedValue;
              else visited.set(typedKey, this.#searchParams.push(typedKey, typedValue) - 1);
            }
          }
        }
      } else {
        init = toUSV(init);
        this.#searchParams = init ? parseParams(init) : [];
      }
    }
    get size() { URLSearchParams.#check(this); return this.#searchParams.length / 2; }
    append(name, value) {
      URLSearchParams.#check(this);
      if (arguments.length < 2) throw errMissingArgs('name', 'value');
      this.#searchParams.push(toUSV(name), toUSV(value));
    }
    delete(name, value = undefined) {
      URLSearchParams.#check(this);
      if (arguments.length < 1) throw errMissingArgs('name');
      const list = this.#searchParams;
      name = toUSV(name);
      const { length } = list;
      let write = 0;
      if (value !== undefined) value = toUSV(value);
      for (let i = 0; i < length; i += 2) {
        if (list[i] === name && (value === undefined || list[i + 1] === value)) continue;
        if (write !== i) { list[write] = list[i]; list[write + 1] = list[i + 1]; }
        write += 2;
      }
      if (write !== length) list.length = write;
    }
    get(name) {
      URLSearchParams.#check(this);
      if (arguments.length < 1) throw errMissingArgs('name');
      const list = this.#searchParams;
      name = toUSV(name);
      for (let i = 0; i < list.length; i += 2) if (list[i] === name) return list[i + 1];
      return null;
    }
    getAll(name) {
      URLSearchParams.#check(this);
      if (arguments.length < 1) throw errMissingArgs('name');
      const list = this.#searchParams;
      const values = [];
      name = toUSV(name);
      for (let i = 0; i < list.length; i += 2) if (list[i] === name) values.push(list[i + 1]);
      return values;
    }
    has(name, value = undefined) {
      URLSearchParams.#check(this);
      if (arguments.length < 1) throw errMissingArgs('name');
      const list = this.#searchParams;
      name = toUSV(name);
      if (value !== undefined) value = toUSV(value);
      for (let i = 0; i < list.length; i += 2) {
        if (list[i] === name && (value === undefined || list[i + 1] === value)) return true;
      }
      return false;
    }
    set(name, value) {
      URLSearchParams.#check(this);
      if (arguments.length < 2) throw errMissingArgs('name', 'value');
      const list = this.#searchParams;
      name = toUSV(name);
      value = toUSV(value);
      const { length } = list;
      let found = false, write = 0;
      for (let i = 0; i < length; i += 2) {
        const cur = list[i];
        let keep = true;
        if (cur === name) {
          if (!found) { list[write] = cur; list[write + 1] = value; found = true; } else keep = false;
        } else if (write !== i) { list[write] = cur; list[write + 1] = list[i + 1]; }
        if (keep) write += 2;
      }
      if (found && write !== length) list.length = write;
      if (!found) list.push(name, value);
    }
    sort() {
      URLSearchParams.#check(this);
      const a = this.#searchParams;
      const len = a.length;
      if (len <= 2) {
        // nothing to do
      } else if (len < 100) {
        for (let i = 2; i < len; i += 2) {
          const curKey = a[i], curVal = a[i + 1];
          let j;
          for (j = i - 2; j >= 0; j -= 2) {
            if (a[j] > curKey) { a[j + 2] = a[j]; a[j + 3] = a[j + 1]; } else break;
          }
          a[j + 2] = curKey; a[j + 3] = curVal;
        }
      } else {
        const lBuffer = new Array(len), rBuffer = new Array(len);
        for (let step = 2; step < len; step *= 2) {
          for (let start = 0; start < len - 2; start += 2 * step) {
            const mid = start + step;
            let end = mid + step;
            end = end < len ? end : len;
            if (mid > end) continue;
            mergeSort(a, start, mid, end, lBuffer, rBuffer);
          }
        }
      }
    }
    entries() { URLSearchParams.#check(this); return new URLSearchParamsIterator(this, 'key+value'); }
    forEach(callback, thisArg = undefined) {
      URLSearchParams.#check(this);
      if (typeof callback !== 'function') throw errInvalidArgType('callback', 'Function', callback);
      let list = this.#searchParams;
      let i = 0;
      while (i < list.length) {
        const key = list[i], value = list[i + 1];
        callback.call(thisArg, value, key, this);
        list = this.#searchParams;
        i += 2;
      }
    }
    keys() { URLSearchParams.#check(this); return new URLSearchParamsIterator(this, 'key'); }
    values() { URLSearchParams.#check(this); return new URLSearchParamsIterator(this, 'value'); }
    toString() { URLSearchParams.#check(this); return serializeParams(this.#searchParams); }
  }
  for (const k of ['append', 'delete', 'get', 'getAll', 'has', 'set', 'size', 'sort', 'entries', 'forEach', 'keys', 'values', 'toString']) {
    Object.defineProperty(URLSearchParams.prototype, k, { enumerable: true });
  }
  tag(URLSearchParams, 'URLSearchParams');
  Object.defineProperty(URLSearchParams.prototype, Symbol.iterator, {
    value: URLSearchParams.prototype.entries, writable: true, enumerable: false, configurable: true,
  });

  /* ── btoa / atob (lib/buffer.js over simdutf's forgiving base64) ─── */
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const btoa = function btoa(input) {
    if (arguments.length === 0) throw errMissingArgs('input');
    const s = `${input}`;
    let out = '';
    for (let i = 0; i < s.length; i += 3) {
      const c0 = s.charCodeAt(i), c1 = i + 1 < s.length ? s.charCodeAt(i + 1) : NaN, c2 = i + 2 < s.length ? s.charCodeAt(i + 2) : NaN;
      if (c0 > 0xff || c1 > 0xff || c2 > 0xff) throw new DOMException('Invalid character', 'InvalidCharacterError');
      const n = (c0 << 16) | ((c1 || 0) << 8) | (c2 || 0);
      out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] +
        (Number.isNaN(c1) ? '=' : B64[(n >> 6) & 63]) +
        (Number.isNaN(c2) ? '=' : B64[n & 63]);
    }
    return out;
  };
  /* The checks in simdutf's order, as Node's two messages tell them
   * apart: more than two trailing '=' or a character outside the
   * alphabet is "Invalid character"; one character left over is "not
   * correctly encoded"; padding that does not complete a quantum is
   * "Invalid character" again. ASCII whitespace is skipped anywhere. */
  const atob = function atob(input) {
    if (arguments.length === 0) throw errMissingArgs('input');
    const s = `${input}`.replace(/[\t\n\f\r ]+/g, '');
    let end = s.length, pad = 0;
    while (end > 0 && s[end - 1] === '=') { end--; pad++; }
    const bad = () => new DOMException('Invalid character', 'InvalidCharacterError');
    if (pad > 2) throw bad();
    for (let i = 0; i < end; i++) if (B64.indexOf(s[i]) < 0) throw bad();
    if (end % 4 === 1) throw new DOMException('The string to be decoded is not correctly encoded.', 'InvalidCharacterError');
    if (pad > 0 && (end + pad) % 4 !== 0) throw bad();
    let out = '';
    let buf = 0, bits = 0;
    for (let i = 0; i < end; i++) {
      buf = ((buf << 6) | B64.indexOf(s[i])) & 0xffffff;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        out += String.fromCharCode((buf >> bits) & 0xff);
      }
    }
    return out;
  };

  /* ── Headers (undici's fetch/headers.js, as Node bundles it) ─────── */
  const tokenRegExp = /^[\^_`a-zA-Z\-0-9!#$%&'*+.|~]+$/;
  const isValidHeaderName = (s) => tokenRegExp.test(s);
  const isValidHeaderValue = (v) =>
    (v[0] === '\t' || v[0] === ' ' || v[v.length - 1] === '\t' || v[v.length - 1] === ' ' ||
      v.includes('\n') || v.includes('\r') || v.includes('\0')) === false;
  const headerValueNormalize = (v) => v.replace(/^[\t\n\r ]+|[\t\n\r ]+$/g, '');
  const idlError = (header, message) => new TypeError(`${header}: ${message}`);
  const idlStringify = (V) => {
    switch (typeof V) {
    case 'symbol': return `Symbol(${V.description})`;
    case 'string': return `"${V}"`;
    case 'bigint': return `${V}n`;
    /* webidl's inspect(V) for an object. */
    case 'object': if (V === null) return 'null'; return inspect(V);
    case 'function': return inspect(V);
    default: return `${V}`;
    }
  };
  const byteString = (V, prefix, argument) => {
    if (typeof V === 'symbol') throw idlError(prefix, `${argument} is a symbol, which cannot be converted to a ByteString.`);
    const x = String(V);
    for (let i = 0; i < x.length; i++) {
      if (x.charCodeAt(i) > 255) {
        throw new TypeError(`Cannot convert argument to a ByteString because the character at index ${i} has a value of ${x.charCodeAt(i)} which is greater than 255.`);
      }
    }
    return x;
  };
  const argCheck = (length, min, ctx) => {
    if (length < min) throw idlError(ctx, `${min} argument${min !== 1 ? 's' : ''} required, but${length ? ' only' : ''} ${length} found.`);
  };
  const illegal = () => { const e = new TypeError('Illegal invocation'); e.code = 'ERR_INVALID_THIS'; return e; };
  let headersSorted;
  class Headers {
    #map = new Map(); // lowercased name -> { name, value }
    #cookies = null;
    static {
      headersSorted = (h) => {
        const names = [...h.#map].map(([k, v]) => [k, v.value]).sort((a, b) => (a[0] < b[0] ? -1 : 1));
        if (h.#cookies === null || h.#cookies.length === 1) return names;
        const out = [];
        for (const [name, value] of names) {
          if (name === 'set-cookie') for (const c of h.#cookies) out.push([name, c]);
          else out.push([name, value]);
        }
        return out;
      };
    }
    static #check(o) { if (typeof o !== 'object' || o === null || !(#map in o)) throw illegal(); }
    constructor(init = undefined) {
      if (init === undefined) return;
      const prefix = 'Headers constructor';
      if (typeof init !== 'object' && typeof init !== 'function' || init === null) {
        throw idlError(prefix, 'Argument 1 could not be converted to one of: sequence<sequence<ByteString>>, record<ByteString, ByteString>.');
      }
      const iterator = init[Symbol.iterator];
      if (#map in init && iterator === Headers.prototype.entries) {
        for (const [k, v] of init.#map) {
          if (k === 'set-cookie') for (const c of init.#cookies) this.#append(v.name, c);
          else this.#append(v.name, v.value);
        }
        return;
      }
      if (typeof iterator === 'function') {
        let index = 0;
        for (const header of init) {
          const arg = `init[${index++}]`;
          if (typeof header !== 'object' && typeof header !== 'function' || header === null) {
            throw idlError(prefix, `${arg} (${idlStringify(header)}) is not iterable.`);
          }
          const pair = [];
          let j = 0;
          for (const x of header) pair.push(byteString(x, prefix, `${arg}[${j++}]`));
          if (pair.length !== 2) throw idlError(prefix, `expected name/value pair to be length 2, found ${pair.length}.`);
          this.#appendChecked(pair[0], pair[1]);
        }
        return;
      }
      for (const key of [...Object.getOwnPropertyNames(init), ...Object.getOwnPropertySymbols(init)]) {
        const keyName = idlStringify(key);
        const k = byteString(key, prefix, `Key ${keyName} in init`);
        const v = byteString(init[key], prefix, `init[${keyName}]`);
        this.#appendChecked(k, v);
      }
    }
    #appendChecked(name, value) {
      value = headerValueNormalize(value);
      if (!isValidHeaderName(name)) throw idlError('Headers.append', `"${name}" is an invalid header name.`);
      if (!isValidHeaderValue(value)) throw idlError('Headers.append', `"${value}" is an invalid header value.`);
      this.#append(name, value);
    }
    #append(name, value) {
      const lower = name.toLowerCase();
      const exists = this.#map.get(lower);
      if (exists) this.#map.set(lower, { name: exists.name, value: `${exists.value}${lower === 'cookie' ? '; ' : ', '}${value}` });
      else this.#map.set(lower, { name, value });
      if (lower === 'set-cookie') (this.#cookies === null ? (this.#cookies = []) : this.#cookies).push(value);
    }
    append(name, value) {
      Headers.#check(this);
      argCheck(arguments.length, 2, 'Headers.append');
      this.#appendChecked(byteString(name, 'Headers.append', 'name'), byteString(value, 'Headers.append', 'value'));
    }
    delete(name) {
      Headers.#check(this);
      argCheck(arguments.length, 1, 'Headers.delete');
      name = byteString(name, 'Headers.delete', 'name');
      if (!isValidHeaderName(name)) throw idlError('Headers.delete', `"${name}" is an invalid header name.`);
      const lower = name.toLowerCase();
      if (lower === 'set-cookie') this.#cookies = null;
      this.#map.delete(lower);
    }
    get(name) {
      Headers.#check(this);
      argCheck(arguments.length, 1, 'Headers.get');
      name = byteString(name, 'Headers.get', 'name');
      if (!isValidHeaderName(name)) throw idlError('Headers.get', `"${name}" is an invalid header name.`);
      return this.#map.get(name.toLowerCase())?.value ?? null;
    }
    has(name) {
      Headers.#check(this);
      argCheck(arguments.length, 1, 'Headers.has');
      name = byteString(name, 'Headers.has', 'name');
      if (!isValidHeaderName(name)) throw idlError('Headers.has', `"${name}" is an invalid header name.`);
      return this.#map.has(name.toLowerCase());
    }
    set(name, value) {
      Headers.#check(this);
      argCheck(arguments.length, 2, 'Headers.set');
      name = byteString(name, 'Headers.set', 'name');
      value = headerValueNormalize(byteString(value, 'Headers.set', 'value'));
      if (!isValidHeaderName(name)) throw idlError('Headers.set', `"${name}" is an invalid header name.`);
      if (!isValidHeaderValue(value)) throw idlError('Headers.set', `"${value}" is an invalid header value.`);
      const lower = name.toLowerCase();
      if (lower === 'set-cookie') this.#cookies = [value];
      this.#map.set(lower, { name, value });
    }
    getSetCookie() {
      Headers.#check(this);
      return this.#cookies === null ? [] : [...this.#cookies];
    }
  }
  class HeadersIterator {
    #target; #kind; #index = 0;
    constructor(target, kind) { this.#target = target; this.#kind = kind; }
    next() {
      if (typeof this !== 'object' || this === null || !(#target in this)) {
        throw new TypeError("'next' called on an object that does not implement interface Headers Iterator.");
      }
      const values = headersSorted(this.#target);
      if (this.#index >= values.length) return { value: undefined, done: true };
      const [key, value] = values[this.#index++];
      return { value: this.#kind === 'key' ? key : this.#kind === 'value' ? value : [key, value], done: false };
    }
  }
  delete HeadersIterator.prototype.constructor;
  Object.setPrototypeOf(HeadersIterator.prototype, IteratorPrototype);
  Object.defineProperty(HeadersIterator.prototype, 'next', { enumerable: true });
  tag(HeadersIterator, 'Headers Iterator');
  {
    const brand = (o) => { if (!(o instanceof Headers)) throw illegal(); };
    const methods = {
      keys() { brand(this); return new HeadersIterator(this, 'key'); },
      values() { brand(this); return new HeadersIterator(this, 'value'); },
      entries() { brand(this); return new HeadersIterator(this, 'key+value'); },
      forEach(callbackfn, thisArg = globalThis) {
        brand(this);
        argCheck(arguments.length, 1, 'Headers.forEach');
        if (typeof callbackfn !== 'function') {
          throw new TypeError("Failed to execute 'forEach' on 'Headers': parameter 1 is not of type 'Function'.");
        }
        for (const [key, value] of new HeadersIterator(this, 'key+value')) callbackfn.call(thisArg, value, key, this);
      },
    };
    for (const k of ['keys', 'values', 'entries', 'forEach']) {
      Object.defineProperty(Headers.prototype, k, { value: methods[k], writable: true, enumerable: true, configurable: true });
    }
    Object.defineProperty(Headers.prototype, Symbol.iterator, { value: methods.entries, writable: true, enumerable: false, configurable: true });
    for (const k of ['append', 'delete', 'get', 'has', 'set', 'getSetCookie']) {
      Object.defineProperty(Headers.prototype, k, { enumerable: true });
    }
    tag(Headers, 'Headers');
  }

  /* Event, CustomEvent, EventTarget — a port of Node's lib/internal/
   * event_target.js: private state (nothing a program can clobber),
   * prototype accessors, initEvent/cancelBubble/returnValue, the static
   * phase constants, and dispatch as Node runs it — listeners in order,
   * once/capture/passive/signal options, handleEvent objects, a throwing
   * listener reported as an uncaught exception after the dispatch (Node:
   * process.nextTick; here an engine job, S108 (l)), ERR_EVENT_RECURSION.
   * The `on<event>` attributes are Node's defineEventHandler. */
  const EV = new WeakMap(); // event -> { type, target, dispatching, stop, passive, trusted }
  const evOf = (o, name = 'Event') => {
    const s = typeof o === 'object' && o !== null ? EV.get(o) : undefined;
    if (s === undefined) throw errInvalidThis(name);
    return s;
  };
  const kTrust = Symbol('kTrust');
  /* Event#timeStamp: Node's performance.now(), through the host's monotonic
   * clock (ms since the process started). */
  const perfNow = () => host.now();
  class Event {
    #cancelable = false;
    #bubbles = false;
    #composed = false;
    #defaultPrevented = false;
    #timestamp = perfNow();
    #propagationStopped = false;
    constructor(type, options = undefined) {
      if (arguments.length === 0) throw errMissingArgs('type');
      if (options != null && (typeof options !== 'object' && typeof options !== 'function')) {
        throw errInvalidArgType('options', 'Object', options);
      }
      this.#bubbles = !!options?.bubbles;
      this.#cancelable = !!options?.cancelable;
      this.#composed = !!options?.composed;
      EV.set(this, { type: domString(type), target: null, dispatching: false, stop: false, passive: false, trusted: !!options?.[kTrust] });
    }
    static #check(o) { if (typeof o !== 'object' || o === null || !(#cancelable in o)) throw errInvalidThis('Event'); }
    static #prevent(o) { if (o.#cancelable && !EV.get(o).passive) o.#defaultPrevented = true; }
    initEvent(type, bubbles = false, cancelable = false) {
      Event.#check(this);
      if (arguments.length === 0) throw errMissingArgs('type');
      const s = EV.get(this);
      if (s.dispatching) return;
      s.type = domString(type);
      this.#bubbles = !!bubbles;
      this.#cancelable = !!cancelable;
    }
    stopImmediatePropagation() {
      Event.#check(this);
      this.#propagationStopped = true;
      EV.get(this).stop = true;
    }
    preventDefault() { Event.#check(this); Event.#prevent(this); }
    get target() { Event.#check(this); return EV.get(this).target; }
    get currentTarget() { Event.#check(this); const s = EV.get(this); return s.dispatching ? s.target : null; }
    get srcElement() { Event.#check(this); return EV.get(this).target; }
    get type() { Event.#check(this); return EV.get(this).type; }
    get cancelable() { Event.#check(this); return this.#cancelable; }
    get defaultPrevented() { Event.#check(this); return this.#cancelable && this.#defaultPrevented; }
    get timeStamp() { Event.#check(this); return this.#timestamp; }
    composedPath() { Event.#check(this); const s = EV.get(this); return s.dispatching ? [s.target] : []; }
    get returnValue() { Event.#check(this); return !this.#cancelable || !this.#defaultPrevented; }
    set returnValue(value) { Event.#check(this); if (!value) Event.#prevent(this); }
    get bubbles() { Event.#check(this); return this.#bubbles; }
    get composed() { Event.#check(this); return this.#composed; }
    get eventPhase() { Event.#check(this); return EV.get(this).dispatching ? 2 : 0; }
    get cancelBubble() { Event.#check(this); return this.#propagationStopped; }
    set cancelBubble(value) { Event.#check(this); if (value) this.#propagationStopped = true; }
    stopPropagation() { Event.#check(this); this.#propagationStopped = true; }
    get isTrusted() { const s = typeof this === 'object' && this !== null ? EV.get(this) : undefined; return s !== undefined && s.trusted; }
  }
  webidlShape(Event, 'Event');
  ['NONE', 'CAPTURING_PHASE', 'AT_TARGET', 'BUBBLING_PHASE'].forEach((k, i) => {
    Object.defineProperty(Event, k, { value: i, writable: false, enumerable: true, configurable: false });
  });
  const DETAIL = new WeakMap();
  class CustomEvent extends Event {
    constructor(type, options = {}) {
      if (arguments.length === 0) throw errMissingArgs('type');
      super(type, options);
      DETAIL.set(this, options?.detail ?? null);
    }
    get detail() {
      if (!DETAIL.has(this)) throw errInvalidThis('CustomEvent');
      return DETAIL.get(this);
    }
  }
  webidlShape(CustomEvent, 'CustomEvent');

  /* EventTarget — Node's lib/internal/event_target.js, ported: a linked
   * list of Listener records per type (listeners appended during a
   * dispatch run in it; a removed one is skipped), options validated as
   * Node's validateEventListenerOptions (a boolean is `capture`;
   * removeEventListener reads only `options.capture`, so a boolean there
   * matches capture-false listeners — Node's own behaviour), the
   * listener validated as validateEventListener (a primitive throws
   * ERR_INVALID_ARG_TYPE, null/undefined is ignored — Node also prints an
   * AddEventListenerArgumentTypeWarning, which the island does not:
   * S108 (l)), `signal` removing the listener on abort, and
   * kHybridDispatch's quirk: the event stops counting as dispatched as
   * soon as the first listener returns. A listener's throw — and a
   * handleEvent object's, which Node calls through an async wrapper — is
   * reported as an uncaught exception after the dispatch (S108 (l)). */
  const ET = new WeakMap(); // target -> { events: Map<type, root>, handlers: Map, onNewListener }
  const etOf = (o) => {
    const s = typeof o === 'object' && o !== null ? ET.get(o) : undefined;
    if (s === undefined) throw errInvalidThis('EventTarget');
    return s;
  };
  const reportListenerError = (err) => { queueMicrotask(() => { throw err; }); };
  const kResist = Symbol('kResistStopPropagation');
  class Listener {
    constructor(previous, listener, once, capture, passive, resist) {
      this.next = undefined;
      if (previous !== undefined) previous.next = this;
      this.previous = previous;
      this.listener = listener;
      this.once = once;
      this.capture = capture;
      this.passive = passive;
      this.resistStopPropagation = resist;
      this.removed = false;
      if (typeof listener === 'function') this.callback = listener;
      else {
        this.callback = async (...args) => {
          if (listener.handleEvent) await Reflect.apply(listener.handleEvent, listener, args);
        };
      }
    }
    same(listener, capture) { return this.listener === listener && this.capture === capture; }
    remove() {
      if (this.previous !== undefined) this.previous.next = this.next;
      if (this.next !== undefined) this.next.previous = this.previous;
      this.removed = true;
    }
  }
  const validateEventListener = (listener) => {
    if (typeof listener === 'function' || typeof listener?.handleEvent === 'function') return true;
    if (listener == null) return false;
    if (typeof listener === 'object') return true;
    throw errInvalidArgType('listener', 'EventListener', listener);
  };
  const validateListenerOptions = (options) => {
    if (typeof options === 'boolean') return { capture: options };
    if (options === null) return {};
    if (typeof options !== 'object' && typeof options !== 'function') throw errInvalidArgType('options', 'Object', options);
    return {
      once: Boolean(options.once), capture: Boolean(options.capture), passive: Boolean(options.passive),
      signal: options.signal, resistStopPropagation: options[kResist] ?? false,
    };
  };
  const domString = (v) => {
    if (typeof v === 'symbol') throw new TypeError('Cannot convert a Symbol value to a string');
    return `${v}`;
  };
  class EventTarget {
    constructor() { ET.set(this, { events: new Map(), handlers: new Map(), onNewListener: null }); }
    addEventListener(type, listener, options = undefined) {
      const st = etOf(this);
      if (arguments.length < 2) throw errMissingArgs('type', 'listener');
      let once = false, capture = false, passive = false, resist = false;
      if (options !== undefined) {
        const o = validateListenerOptions(options);
        once = !!o.once; capture = !!o.capture; passive = !!o.passive; resist = !!o.resistStopPropagation;
        const signal = o.signal;
        if (signal !== undefined && (signal === null || typeof signal !== 'object' || !('aborted' in signal))) {
          throw errInvalidArgType('options.signal', 'AbortSignal', signal);
        }
        if (signal) {
          if (signal.aborted) return;
          if (typeof signal.addEventListener !== 'function') throw new TypeError('signal.addEventListener is not a function');
          signal.addEventListener('abort', () => { this.removeEventListener(type, listener, options); }, { once: true, [kResist]: true });
        }
      }
      if (!validateEventListener(listener)) return;
      type = domString(type);
      let root = st.events.get(type);
      if (root === undefined) {
        root = { size: 1, next: undefined, resistStopPropagation: resist };
        new Listener(root, listener, once, capture, passive, resist);
        st.events.set(type, root);
        if (st.onNewListener) st.onNewListener(root.size, type);
        return;
      }
      let handler = root.next;
      let previous = root;
      while (handler !== undefined && !handler.same(listener, capture)) {
        previous = handler;
        handler = handler.next;
      }
      if (handler !== undefined) return; // a duplicate
      new Listener(previous, listener, once, capture, passive, resist);
      root.size++;
      root.resistStopPropagation ||= resist;
      if (st.onNewListener) st.onNewListener(root.size, type);
    }
    removeEventListener(type, listener, options = undefined) {
      const st = etOf(this);
      if (arguments.length < 2) throw errMissingArgs('type', 'listener');
      if (!validateEventListener(listener)) return;
      type = domString(type);
      const capture = options?.capture === true;
      const root = st.events.get(type);
      if (root === undefined || root.next === undefined) return;
      let handler = root.next;
      while (handler !== undefined) {
        if (handler.same(listener, capture)) {
          handler.remove();
          root.size--;
          if (root.size === 0) st.events.delete(type);
          break;
        }
        handler = handler.next;
      }
    }
    dispatchEvent(event) {
      etOf(this);
      if (arguments.length < 1) throw errMissingArgs('event');
      if (!(event instanceof Event)) throw errInvalidArgType('event', 'Event', event);
      const s = EV.get(event);
      if (s.dispatching) throw nodeError(Error, 'ERR_EVENT_RECURSION', `The event "${s.type}" is already being dispatched`);
      evDispatch(this, event);
      return event.defaultPrevented !== true;
    }
  }
  /* kHybridDispatch, for an Event argument. */
  const evDispatch = (target, event) => {
    const st = ET.get(target);
    const s = EV.get(event);
    s.target = target;
    s.dispatching = true;
    const type = s.type;
    const root = st.events.get(type);
    if (root === undefined || root.next === undefined) {
      s.dispatching = false;
      return;
    }
    let handler = root.next;
    let next;
    const go = () => handler !== undefined && (root.resistStopPropagation || handler.passive || s.stop !== true);
    while (go()) {
      next = handler.next;
      if (handler.removed || (s.stop === true && !handler.resistStopPropagation)) {
        handler = next;
        continue;
      }
      if (handler.once) {
        handler.remove();
        root.size--;
      }
      try {
        if (handler.passive) s.passive = true;
        const result = handler.callback.call(target, event);
        s.dispatching = false;
        if (result !== undefined && result !== null) {
          const then = result.then;
          if (typeof then === 'function') then.call(result, undefined, reportListenerError);
        }
      } catch (err) {
        reportListenerError(err);
      } finally {
        if (s.passive) s.passive = false;
      }
      handler = next;
    }
    s.dispatching = false;
  };
  webidlShape(EventTarget, 'EventTarget');
  /* Node's defineEventHandler: the `on<name>` attribute is one listener,
   * registered when first set, whose handler the setter swaps. */
  const defineEventHandler = (proto, name) => {
    const prop = `on${name}`;
    const get = { [`get ${prop}`]() { return etOf(this).handlers.get(name)?.handler ?? null; } }[`get ${prop}`];
    const set = { [`set ${prop}`](value) {
      const st = etOf(this);
      let wrapped = st.handlers.get(name);
      if (wrapped) wrapped.handler = value;
      else {
        wrapped = function eventHandler(...args) {
          if (typeof wrapped.handler !== 'function') return undefined;
          return Reflect.apply(wrapped.handler, this, args);
        };
        wrapped.handler = value;
        this.addEventListener(name, wrapped);
      }
      st.handlers.set(name, wrapped);
    } }[`set ${prop}`];
    Object.defineProperty(proto, prop, { get, set, configurable: true, enumerable: true });
  };

  /* Blob + File — the WHATWG classes Node exposes as globals (and
   * re-exports from node:buffer) since v18. Bytes concatenate at
   * construction (strings through TextEncoder, views copied, nested
   * Blobs flattened); type normalizes per spec (printable-ASCII-only,
   * lowercased, else ""); slice carries WHATWG's negative-index
   * clamping; stream() rides the prelude's own ReadableStream. undici
   * (in embedded graphs) extends buffer.Blob at load. State is private. */
  const BLOB = new WeakMap(); // blob -> { bytes, type }
  const blobOf = (o) => {
    const s = typeof o === 'object' && o !== null ? BLOB.get(o) : undefined;
    if (s === undefined) throw errInvalidThis('Blob');
    return s;
  };
  const blobBytesOf = (parts) => {
    const chunks = [];
    let total = 0;
    for (const p of parts) {
      let u8;
      if (typeof p === 'string') u8 = new TextEncoder().encode(p);
      else if (BLOB.has(p)) u8 = BLOB.get(p).bytes;
      else if (p instanceof ArrayBuffer) u8 = new Uint8Array(p.slice(0));
      else if (ArrayBuffer.isView(p)) u8 = new Uint8Array(p.buffer.slice(p.byteOffset, p.byteOffset + p.byteLength));
      else u8 = new TextEncoder().encode(String(p));
      chunks.push(u8);
      total += u8.length;
    }
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.length; }
    return out;
  };
  const blobTypeOf = (t) => {
    const s = String(t);
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c < 0x20 || c > 0x7e) return '';
    }
    return s.toLowerCase();
  };
  class Blob {
    constructor(sources = [], options = {}) {
      if (typeof sources !== 'object' || sources === null || typeof sources[Symbol.iterator] !== 'function') {
        throw new TypeError('The "sources" argument must be an instance of Iterable. Received ' + (sources === null ? 'null' : typeof sources));
      }
      BLOB.set(this, {
        bytes: blobBytesOf([...sources]),
        type: options !== null && options !== undefined && options.type !== undefined ? blobTypeOf(options.type) : '',
      });
    }
    get size() { return blobOf(this).bytes.length; }
    get type() { return blobOf(this).type; }
    async arrayBuffer() {
      const b = blobOf(this).bytes;
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    }
    async bytes() { return new Uint8Array(blobOf(this).bytes); }
    async text() { return new TextDecoder().decode(blobOf(this).bytes); }
    slice(start = 0, end = undefined, contentType = undefined) {
      const bytes = blobOf(this).bytes;
      const size = bytes.length;
      let s = start === undefined ? 0 : Math.trunc(Number(start) || 0);
      s = s < 0 ? Math.max(size + s, 0) : Math.min(s, size);
      let e = end === undefined ? size : Math.trunc(Number(end) || 0);
      e = e < 0 ? Math.max(size + e, 0) : Math.min(e, size);
      const b = new Blob([], contentType === undefined ? {} : { type: contentType });
      BLOB.get(b).bytes = bytes.slice(s, Math.max(e, s));
      return b;
    }
    stream() {
      const bytes = blobOf(this).bytes;
      return new ReadableStream({
        start(c) {
          if (bytes.length > 0) c.enqueue(new Uint8Array(bytes));
          c.close();
        },
      });
    }
  }
  webidlShape(Blob, 'Blob');
  const FILE = new WeakMap();
  class File extends Blob {
    constructor(fileBits, fileName, options = {}) {
      if (arguments.length < 2) throw errMissingArgs('fileBits', 'fileName');
      super(fileBits, options);
      FILE.set(this, {
        name: String(fileName),
        lastModified: options !== null && options !== undefined && options.lastModified !== undefined ? Number(options.lastModified) : Date.now(),
      });
    }
    get name() { if (!FILE.has(this)) throw errInvalidThis('File'); return FILE.get(this).name; }
    get lastModified() { if (!FILE.has(this)) throw errInvalidThis('File'); return FILE.get(this).lastModified; }
  }
  webidlShape(File, 'File');

  /* DOMException — lib/internal/per_context/domexception.js: an object
   * with [[ErrorData]] (made by Error, re-prototyped), name/message/code
   * as prototype getters over an internal record, the legacy code
   * constants on the class and the prototype. Then AbortController/
   * AbortSignal: pure JS state, with the ONE host hook AbortSignal.timeout
   * needs (host.timer arms a one-shot island timer — unref'd like Node's,
   * so an armed timeout never keeps the process alive). Default abort
   * reasons match Node exactly: DOMException AbortError 'This operation
   * was aborted' and TimeoutError 'The operation was aborted due to
   * timeout'. */
  const domInternals = new WeakMap();
  const DOM_CODES = [
    ['IndexSizeError', 'INDEX_SIZE_ERR', 1], ['DOMStringSizeError', 'DOMSTRING_SIZE_ERR', 2],
    ['HierarchyRequestError', 'HIERARCHY_REQUEST_ERR', 3], ['WrongDocumentError', 'WRONG_DOCUMENT_ERR', 4],
    ['InvalidCharacterError', 'INVALID_CHARACTER_ERR', 5], ['NoDataAllowedError', 'NO_DATA_ALLOWED_ERR', 6],
    ['NoModificationAllowedError', 'NO_MODIFICATION_ALLOWED_ERR', 7], ['NotFoundError', 'NOT_FOUND_ERR', 8],
    ['NotSupportedError', 'NOT_SUPPORTED_ERR', 9], ['InUseAttributeError', 'INUSE_ATTRIBUTE_ERR', 10],
    ['InvalidStateError', 'INVALID_STATE_ERR', 11], ['SyntaxError', 'SYNTAX_ERR', 12],
    ['InvalidModificationError', 'INVALID_MODIFICATION_ERR', 13], ['NamespaceError', 'NAMESPACE_ERR', 14],
    ['InvalidAccessError', 'INVALID_ACCESS_ERR', 15], ['ValidationError', 'VALIDATION_ERR', 16],
    ['TypeMismatchError', 'TYPE_MISMATCH_ERR', 17], ['SecurityError', 'SECURITY_ERR', 18],
    ['NetworkError', 'NETWORK_ERR', 19], ['AbortError', 'ABORT_ERR', 20],
    ['URLMismatchError', 'URL_MISMATCH_ERR', 21], ['QuotaExceededError', 'QUOTA_EXCEEDED_ERR', 22],
    ['TimeoutError', 'TIMEOUT_ERR', 23], ['InvalidNodeTypeError', 'INVALID_NODE_TYPE_ERR', 24],
    ['DataCloneError', 'DATA_CLONE_ERR', 25],
  ];
  const domCodeOf = new Map();
  const domDisused = new Set(['DOMStringSizeError', 'NoDataAllowedError', 'ValidationError']);
  const domThis = (o) => {
    const i = domInternals.get(o);
    if (i === undefined) {
      const err = new TypeError('Value of "this" must be of DOMException');
      Object.defineProperty(err, 'toString', {
        value() { return `${this.name} [ERR_INVALID_THIS]: ${this.message}`; },
        enumerable: false, writable: true, configurable: true,
      });
      err.code = 'ERR_INVALID_THIS';
      throw err;
    }
    return i;
  };
  class DOMException {
    constructor(message = '', options = 'Error') {
      const self = new Error();
      Object.setPrototypeOf(self, new.target.prototype);
      if (options && typeof options === 'object') {
        const { name } = options;
        domInternals.set(self, { message: `${message}`, name: `${name}` });
        if ('cause' in options) {
          Object.defineProperty(self, 'cause', { value: options.cause, configurable: true, writable: true, enumerable: false });
        }
      } else {
        domInternals.set(self, { message: `${message}`, name: `${options}` });
      }
      return self;
    }
    get name() { return domThis(this).name; }
    get message() { return domThis(this).message; }
    get code() {
      const { name } = domThis(this);
      if (domDisused.has(name)) return 0;
      const code = domCodeOf.get(name);
      return code === undefined ? 0 : code;
    }
  }
  Object.setPrototypeOf(DOMException.prototype, Error.prototype);
  Object.defineProperties(DOMException.prototype, {
    [Symbol.toStringTag]: { configurable: true, value: 'DOMException' },
    name: { enumerable: true, configurable: true },
    message: { enumerable: true, configurable: true },
    code: { enumerable: true, configurable: true },
  });
  for (const [name, codeName, value] of DOM_CODES) {
    const desc = { enumerable: true, value };
    Object.defineProperty(DOMException, codeName, desc);
    Object.defineProperty(DOMException.prototype, codeName, desc);
    domCodeOf.set(name, value);
  }

  /* AbortSignal / AbortController — Node's lib/internal/abort_controller.js,
   * ported: an AbortSignal is an EventTarget (illegal to construct) whose
   * 'abort' is a trusted Event dispatched to its listeners, onabort
   * included (the event handler attribute). AbortSignal.any builds a
   * COMPOSITE signal over the flattened set of non-composite sources; it
   * follows them (registers as their dependant) once it has an 'abort'
   * listener, and otherwise refreshes from them whenever `aborted`,
   * `reason` or `throwIfAborted` is read — Node's exact laziness (strong
   * references here where Node holds weak ones; only the GC can tell).
   * AbortSignal.timeout arms the ONE host hook (host.timer, an unref'd
   * island timer). State is private. */
  const AS = new WeakMap(); // signal -> { aborted, reason, composite, sources: Set|null, dependants: Set|null, following }
  const asOf = (o) => {
    const s = typeof o === 'object' && o !== null ? AS.get(o) : undefined;
    if (s === undefined) throw errInvalidThis('AbortSignal');
    return s;
  };
  let mintingSignal = false;
  const mkSignal = (init = {}) => {
    mintingSignal = true;
    try { return new AbortSignal(init); } finally { mintingSignal = false; }
  };
  const mkAbortError = () => new DOMException('This operation was aborted', 'AbortError');
  const runAbort = (signal) => { signal.dispatchEvent(new Event('abort', { [kTrust]: true })); };
  const signalAbort = (signal, reason) => {
    const s = AS.get(signal);
    if (s.aborted) return;
    s.aborted = true;
    s.reason = reason;
    const deps = [];
    if (s.dependants !== null) {
      for (const d of s.dependants) {
        const ds = AS.get(d);
        if (!ds.aborted) { ds.reason = reason; ds.aborted = true; deps.push(d); }
      }
    }
    runAbort(signal);
    for (const d of deps) runAbort(d);
  };
  const refreshComposite = (signal) => {
    const s = AS.get(signal);
    if (!s.composite || s.aborted || !s.sources?.size) return;
    for (const src of s.sources) {
      const ss = AS.get(src);
      if (ss.aborted) { signalAbort(signal, ss.reason); return; }
    }
  };
  const followComposite = (signal) => {
    const s = AS.get(signal);
    if (s.following || s.aborted || !s.sources?.size) return;
    for (const src of s.sources) {
      const ss = AS.get(src);
      if (ss.aborted) { signalAbort(signal, ss.reason); return; }
      if (ss.dependants === null) ss.dependants = new Set();
      ss.dependants.add(signal);
    }
    s.following = true;
  };
  const seqError = (context, message) => { const e = new TypeError(`${context} ${message}`); e.code = 'ERR_INVALID_ARG_TYPE'; return e; };
  /* webidl createSequenceConverter(createInterfaceConverter('AbortSignal')). */
  const abortSignalSequence = (V) => {
    if (V === null || (typeof V !== 'object' && typeof V !== 'function')) throw seqError('signals', 'cannot be converted to sequence.');
    const method = V[Symbol.iterator];
    if (typeof method !== 'function') throw seqError('signals', 'cannot be converted to sequence.');
    const iterator = method.call(V);
    const nextMethod = iterator?.next;
    if (typeof nextMethod !== 'function') throw seqError('signals', 'cannot be converted to sequence.');
    const out = [];
    for (;;) {
      const next = nextMethod.call(iterator);
      if (next === null || (typeof next !== 'object' && typeof next !== 'function')) throw seqError('signals', 'cannot be converted to sequence.');
      if (next.done) break;
      if (!AbortSignal.prototype.isPrototypeOf(next.value)) throw seqError(`signals[${out.length}]`, 'is not of type AbortSignal.');
      out.push(next.value);
    }
    return out;
  };
  class AbortSignal extends EventTarget {
    constructor(init = undefined) {
      if (!mintingSignal) throw nodeError(TypeError, 'ERR_ILLEGAL_CONSTRUCTOR', 'Illegal constructor');
      super();
      const { aborted = false, reason = undefined, composite = false } = init;
      AS.set(this, { aborted, reason, composite, sources: null, dependants: null, following: false });
      const self = this;
      ET.get(this).onNewListener = (size, type) => {
        if (AS.get(self).composite && type === 'abort' && !AS.get(self).aborted && size === 1) followComposite(self);
      };
    }
    get aborted() { asOf(this); refreshComposite(this); return !!AS.get(this).aborted; }
    get reason() { asOf(this); refreshComposite(this); return AS.get(this).reason; }
    throwIfAborted() {
      asOf(this);
      refreshComposite(this);
      const s = AS.get(this);
      if (s.aborted) throw s.reason;
    }
    static abort(reason = mkAbortError()) { return mkSignal({ aborted: true, reason }); }
    static timeout(delay) {
      if (typeof delay !== 'number') throw errInvalidArgType('delay', 'number', delay);
      if (!Number.isInteger(delay)) {
        throw nodeError(RangeError, 'ERR_OUT_OF_RANGE', `The value of "delay" is out of range. It must be an integer. Received ${delay}`);
      }
      if (delay < 0 || delay > 4294967295) {
        throw nodeError(RangeError, 'ERR_OUT_OF_RANGE', `The value of "delay" is out of range. It must be >= 0 && <= 4294967295. Received ${delay}`);
      }
      const s = mkSignal();
      host.timer(() => {
        signalAbort(s, new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
      }, delay);
      return s;
    }
    static any(signals) {
      const list = abortSignalSequence(signals);
      const result = mkSignal({ composite: true });
      if (!list.length) return result;
      const rs = AS.get(result);
      rs.sources = new Set();
      for (const signal of list) {
        const ss = AS.get(signal);
        if (signal.aborted) { signalAbort(result, signal.reason); return result; }
        if (!ss.composite) rs.sources.add(signal);
        else if (!ss.sources) continue;
        else {
          refreshComposite(signal);
          if (ss.aborted) { signalAbort(result, ss.reason); return result; }
          for (const src of ss.sources) {
            if (AS.get(src).aborted) { signalAbort(result, AS.get(src).reason); return result; }
            rs.sources.add(src);
          }
        }
      }
      return result;
    }
  }
  for (const k of ['aborted']) Object.defineProperty(AbortSignal.prototype, k, { enumerable: true });
  tag(AbortSignal, 'AbortSignal');
  defineEventHandler(AbortSignal.prototype, 'abort');

  const AC = new WeakMap();
  class AbortController {
    constructor() { AC.set(this, null); }
    get signal() {
      if (!AC.has(this)) throw new TypeError('Cannot read private member #signal from an object whose class did not declare it');
      let s = AC.get(this);
      if (s === null) { s = mkSignal(); AC.set(this, s); }
      return s;
    }
    abort(reason = mkAbortError()) {
      if (!AC.has(this)) throw new TypeError('Cannot read private member #signal from an object whose class did not declare it');
      let s = AC.get(this);
      if (s === null) { s = mkSignal(); AC.set(this, s); }
      signalAbort(s, reason);
    }
  }
  webidlShape(AbortController, 'AbortController');

  /* structuredClone — V8's ValueSerializer as Node drives it, over the
   * island's values: one identity memo for every object (shared and cyclic
   * references, two views of one buffer), primitives, the Number/String/
   * Boolean/BigInt wrappers, Date, RegExp (source and flags), Map, Set,
   * ArrayBuffer (a resizable one keeps maxByteLength), typed arrays and
   * DataView as views onto the cloned buffer, arrays (length, holes and
   * extra own properties), Errors as V8 writes them (the prototype by name
   * among the six native kinds, else Error; an own data `message`; a
   * string `stack`; an own data `cause`), and every other object as a
   * plain object of its own enumerable string-keyed properties (class
   * instances, null-prototype objects and subclasses of Map/Set/Array/
   * Date/typed arrays lose their prototype, as in Node). Kinds are told
   * apart by their internal slots (brand checks), not by prototype. Node's
   * own host objects answer as Node's do: Blob/File/DOMException clone;
   * Headers, URLSearchParams, Request and Response are "unsupported";
   * MessagePort, ReadableStream and TransformStream need a transfer list.
   * DataCloneError for what V8 refuses — functions, symbols, the Symbol
   * wrapper, WeakMap/WeakSet/WeakRef/FinalizationRegistry, promises,
   * generators and built-in iterators, arguments objects, the global
   * object, a Proxy — with V8's "<value> could not be cloned." text. Not carried
   * (S108 (j)): a SharedArrayBuffer throws a named Error (Node shares it), and
   * a transfer list carries ArrayBuffers only (a port or a stream in it is a
   * named Error; Node transfers them). Option validation is Node's. */
  const scErr = (m) => { const e = new TypeError(m); e.code = 'ERR_INVALID_ARG_TYPE'; return e; };
  const ERROR_KINDS = { EvalError, RangeError, ReferenceError, SyntaxError, TypeError, URIError };
  const brand = (fn) => (v) => { try { fn(v); return true; } catch (_e) { return false; } };
  const getter = (proto, k) => Object.getOwnPropertyDescriptor(proto, k).get;
  const TypedArrayProto = Object.getPrototypeOf(Uint8Array.prototype);
  const isDate = brand((v) => Date.prototype.getTime.call(v));
  const isRegExp = brand((v) => { if (v === RegExp.prototype) throw 0; getter(RegExp.prototype, 'source').call(v); });
  const isMap = brand((v) => getter(Map.prototype, 'size').call(v));
  const isSet = brand((v) => getter(Set.prototype, 'size').call(v));
  const isWeakMap = brand((v) => WeakMap.prototype.has.call(v, {}));
  const isWeakSet = brand((v) => WeakSet.prototype.has.call(v, {}));
  const isWeakRef = brand((v) => WeakRef.prototype.deref.call(v));
  const isFinReg = brand((v) => FinalizationRegistry.prototype.unregister.call(v, {}));
  const isArrayBuffer = brand((v) => getter(ArrayBuffer.prototype, 'byteLength').call(v));
  const isSAB = typeof SharedArrayBuffer === 'function'
    ? brand((v) => getter(SharedArrayBuffer.prototype, 'byteLength').call(v)) : () => false;
  const isDataView = brand((v) => getter(DataView.prototype, 'buffer').call(v)); // byteLength throws when out of bounds
  const taTagOf = (v) => getter(TypedArrayProto, Symbol.toStringTag).call(v);
  const WRAPPERS = [
    [brand((v) => Number.prototype.valueOf.call(v)), (v) => new Number(Number.prototype.valueOf.call(v))],
    [brand((v) => String.prototype.valueOf.call(v)), (v) => new String(String.prototype.valueOf.call(v))],
    [brand((v) => Boolean.prototype.valueOf.call(v)), (v) => new Boolean(Boolean.prototype.valueOf.call(v))],
    [brand((v) => BigInt.prototype.valueOf.call(v)), (v) => Object(BigInt.prototype.valueOf.call(v))],
  ];
  const isSymbolWrapper = brand((v) => Symbol.prototype.valueOf.call(v));
  const GeneratorProto = Object.getPrototypeOf(function* () {}).prototype;
  const AsyncGeneratorProto = Object.getPrototypeOf(async function* () {}).prototype;
  const BUILTIN_ITER_PROTOS = new Set([
    Object.getPrototypeOf([][Symbol.iterator]()), Object.getPrototypeOf(new Map()[Symbol.iterator]()),
    Object.getPrototypeOf(new Set()[Symbol.iterator]()), Object.getPrototypeOf(''[Symbol.iterator]()),
    Object.getPrototypeOf(/a/[Symbol.matchAll]('a')),
    Object.getPrototypeOf([].values().map((x) => x)),
  ]);
  /* V8's Object::NoSideEffectsToString for a receiver: "#<Ctor>" when its
   * toString is Object.prototype.toString and its constructor a named
   * function (data properties only, getters never run), else
   * "[object Tag]". */
  const dataProp = (o, k) => {
    for (let p = o; p !== null; p = Object.getPrototypeOf(p)) {
      const d = Object.getOwnPropertyDescriptor(p, k);
      if (d !== undefined) return 'value' in d ? d.value : undefined;
    }
    return undefined;
  };
  const describeForClone = (v) => {
    if (typeof v === 'function' || typeof v === 'symbol') return String(v);
    if (dataProp(v, 'toString') === Object.prototype.toString) {
      const c = dataProp(v, 'constructor');
      if (typeof c === 'function' && typeof c.name === 'string' && c.name !== '') return `#<${c.name}>`;
    }
    const t = dataProp(v, Symbol.toStringTag);
    return `[object ${typeof t === 'string' ? t : Object.prototype.toString.call(v).slice(8, -1)}]`;
  };
  const cloneFail = (v) => new DOMException(`${describeForClone(v)} could not be cloned.`, 'DataCloneError');
  const isUncloneable = (v) =>
    isWeakMap(v) || isWeakSet(v) || isWeakRef(v) || isFinReg(v) || isSymbolWrapper(v) ||
    promiseBrand(v) ||
    GeneratorProto.isPrototypeOf(v) || AsyncGeneratorProto.isPrototypeOf(v) ||
    BUILTIN_ITER_PROTOS.has(Object.getPrototypeOf(v)) ||
    v === g || Object.prototype.toString.call(v) === '[object Arguments]';
  /* A promise has [[PromiseState]] — asked of the engine (host.isPromise):
   * no JS check is free of side effects. */
  const promiseBrand = (v) => host.isPromise(v);
  const hostClone = (v, memo) => {
    if (v instanceof Headers || v instanceof URLSearchParams || v instanceof Request || v instanceof Response || ME.has(v)) {
      throw new DOMException('Cannot clone object of unsupported type.', 'DataCloneError');
    }
    if (v instanceof MessagePort || v instanceof ReadableStream || v instanceof TransformStream) {
      throw new DOMException('Object that needs transfer was found in message but not listed in transferList', 'DataCloneError');
    }
    if (v instanceof File) {
      const f = new File([v], v.name, { type: v.type, lastModified: v.lastModified });
      memo.set(v, f);
      return f;
    }
    if (v instanceof Blob) {
      const b = new Blob([v], { type: v.type });
      memo.set(v, b);
      return b;
    }
    if (domInternals.has(v)) {
      const i = domInternals.get(v);
      const d = new DOMException(i.message, i.name);
      Object.defineProperty(d, 'stack', { value: v.stack, writable: true, enumerable: false, configurable: true });
      memo.set(v, d);
      return d;
    }
    return undefined;
  };
  /* The deserializer creates each property (CreateDataProperty): no
   * setter runs, `__proto__` is an own key. */
  const defineData = (o, k, value) => {
    Object.defineProperty(o, k, { value, writable: true, enumerable: true, configurable: true });
  };
  const isArrayIndex = (k) => {
    const n = Number(k);
    return String(n >>> 0) === k && n !== 4294967295;
  };
  /* V8's WriteJSObjectPropertiesSlow: keys snapshotted by the caller, one
   * no longer own skipped (a getter deleted it), the value read through
   * any getter. */
  const cloneProps = (v, o, keys, memo) => {
    for (const k of keys) {
      if (Object.getOwnPropertyDescriptor(v, k) === undefined) continue;
      defineData(o, k, scClone(v[k], memo));
    }
  };
  const scClone = (v, memo) => {
    switch (typeof v) {
    case 'undefined': case 'boolean': case 'number': case 'string': case 'bigint':
      return v;
    case 'symbol':
    case 'function':
      throw cloneFail(v);
    }
    if (v === null) return null;
    const seen = memo.get(v);
    if (seen !== undefined) return seen;
    if (host.isProxy(v)) {
      const target = host.proxyTarget(v);
      throw new DOMException(`${target === null ? '#<Object>' : describeForClone(target)} could not be cloned.`, 'DataCloneError');
    }
    const hosted = hostClone(v, memo);
    if (hosted !== undefined) return hosted;
    if (isUncloneable(v)) throw cloneFail(v);
    for (const [is, make] of WRAPPERS) {
      if (is(v)) { const w = make(v); memo.set(v, w); return w; }
    }
    if (isDate(v)) { const d = new Date(Date.prototype.getTime.call(v)); memo.set(v, d); return d; }
    if (isRegExp(v)) {
      const r = new RegExp(getter(RegExp.prototype, 'source').call(v), getter(RegExp.prototype, 'flags').call(v));
      memo.set(v, r);
      return r;
    }
    if (isSAB(v)) throw new Error('structuredClone of a SharedArrayBuffer inside the scriptc island is not supported yet');
    if (isArrayBuffer(v)) {
      if (getter(ArrayBuffer.prototype, 'detached').call(v)) {
        throw new DOMException('An ArrayBuffer is detached and could not be cloned.', 'DataCloneError');
      }
      const len = getter(ArrayBuffer.prototype, 'byteLength').call(v);
      const resizable = getter(ArrayBuffer.prototype, 'resizable').call(v);
      const b = resizable
        ? new ArrayBuffer(len, { maxByteLength: getter(ArrayBuffer.prototype, 'maxByteLength').call(v) })
        : new ArrayBuffer(len);
      new Uint8Array(b).set(new Uint8Array(v));
      memo.set(v, b);
      return b;
    }
    /* A view: V8 writes its buffer first (a detached one fails there),
     * then refuses a view that is out of bounds of a shrunk resizable
     * buffer — a typed array as "[object Object]", a DataView by its
     * usual description. */
    const taTag = taTagOf(v);
    if (taTag !== undefined) {
      const buf = scClone(getter(TypedArrayProto, 'buffer').call(v), memo);
      try { TypedArrayProto.at.call(v, 0); } catch {
        throw new DOMException('[object Object] could not be cloned.', 'DataCloneError');
      }
      const t = new g[taTag](buf, getter(TypedArrayProto, 'byteOffset').call(v), getter(TypedArrayProto, 'length').call(v));
      memo.set(v, t);
      return t;
    }
    if (isDataView(v)) {
      const buf = scClone(getter(DataView.prototype, 'buffer').call(v), memo);
      let off, len;
      try {
        off = getter(DataView.prototype, 'byteOffset').call(v);
        len = getter(DataView.prototype, 'byteLength').call(v);
      } catch { throw cloneFail(v); }
      const d = new DataView(buf, off, len);
      memo.set(v, d);
      return d;
    }
    /* Map and Set entries are snapshotted before any is cloned (V8 copies
     * the table first): an entry a getter adds is not in the clone, one it
     * deletes still is. */
    if (isMap(v)) {
      const m = new Map();
      memo.set(v, m);
      const entries = [];
      Map.prototype.forEach.call(v, (val, k) => { entries.push(k, val); });
      for (let i = 0; i < entries.length; i += 2) m.set(scClone(entries[i], memo), scClone(entries[i + 1], memo));
      return m;
    }
    if (isSet(v)) {
      const s = new Set();
      memo.set(v, s);
      const entries = [];
      Set.prototype.forEach.call(v, (val) => { entries.push(val); });
      for (const val of entries) s.add(scClone(val, memo));
      return s;
    }
    if (Array.isArray(v)) {
      const len = v.length;
      const a = new Array(len);
      memo.set(v, a);
      /* V8's two array forms. Dense (every index an own plain data
       * property — V8's fast packed elements):
       * the elements by index — one a getter deleted is a hole — then the
       * named properties as they are AFTER the elements. Otherwise sparse:
       * the own enumerable keys snapshotted up front, each skipped if a
       * getter deleted it meanwhile. */
      let dense = true;
      for (let i = 0; i < len; i++) {
        const d = Object.getOwnPropertyDescriptor(v, i);
        if (d === undefined || !('value' in d) || !d.enumerable || !d.writable || !d.configurable) { dense = false; break; }
      }
      if (dense) {
        for (let i = 0; i < len; i++) {
          if (Object.getOwnPropertyDescriptor(v, i) === undefined) continue;
          defineData(a, i, scClone(v[i], memo));
        }
        cloneProps(v, a, Object.keys(v).filter((k) => !isArrayIndex(k)), memo);
      } else {
        cloneProps(v, a, Object.keys(v), memo);
      }
      return a;
    }
    if (Error.isError(v)) {
      const name = v.name;
      const Ctor = Object.hasOwn(ERROR_KINDS, name) ? ERROR_KINDS[name] : Error;
      const e = new Ctor();
      memo.set(v, e);
      const md = Object.getOwnPropertyDescriptor(v, 'message');
      if (md !== undefined && 'value' in md) {
        Object.defineProperty(e, 'message', { value: String(md.value), writable: true, enumerable: false, configurable: true });
      }
      const stack = v.stack;
      Object.defineProperty(e, 'stack', { value: typeof stack === 'string' ? stack : undefined, writable: true, enumerable: false, configurable: true });
      const cd = Object.getOwnPropertyDescriptor(v, 'cause');
      if (cd !== undefined && 'value' in cd) {
        Object.defineProperty(e, 'cause', { value: scClone(cd.value, memo), writable: true, enumerable: false, configurable: true });
      }
      return e;
    }
    const o = {};
    memo.set(v, o);
    cloneProps(v, o, Object.keys(v), memo);
    return o;
  };
  const structuredClone = function structuredClone(value, options) {
    if (arguments.length === 0) {
      const e = new TypeError('The "The value argument must be specified" argument must be specified');
      e.code = 'ERR_MISSING_ARGS';
      throw e;
    }
    if (options !== undefined && options !== null) {
      if (typeof options !== 'object' && typeof options !== 'function') {
        throw scErr("Failed to execute 'structuredClone': Options cannot be converted to a dictionary");
      }
      const tr = options.transfer;
      if (tr !== undefined) {
        let list;
        /* WebIDL sequence conversion rejects strings (iterable or
         * not) — Node's transfer:'' error is the member error. */
        try {
          if (typeof tr === 'string') throw 0;
          list = [...tr];
        } catch (e) {
          throw scErr("Failed to execute 'structuredClone': transfer in Options cannot be converted to sequence.");
        }
        for (let i = 0; i < list.length; i++) {
          const item = list[i];
          if (item === null || (typeof item !== 'object' && typeof item !== 'function')) {
            throw scErr(`Failed to execute 'structuredClone': transfer in Options[${i}] is not an object.`);
          }
        }
        return cloneTransferring(value, list, null, 'structuredClone');
      }
    }
    return scClone(value, new WeakMap());
  };
  /* Node's Message::Serialize over a transfer list: ArrayBuffers transfer
   * (the clone owns the bytes, the sources are detached once the clone
   * succeeded); Node's other transferables (ports, streams) are not
   * carried — a named Error. */
  const cloneTransferring = (value, list, sourcePort, who) => {
    const buffers = [];
    for (const item of list) {
      if (item !== null && (typeof item === 'object' || typeof item === 'function') && isArrayBuffer(item)) {
        if (buffers.includes(item)) throw new DOMException('Transfer list contains duplicate ArrayBuffer', 'DataCloneError');
        if (getter(ArrayBuffer.prototype, 'detached').call(item)) {
          throw new DOMException('Cannot transfer object of unsupported type.', 'DataCloneError');
        }
        buffers.push(item);
      } else if (sourcePort !== null && item === sourcePort) {
        throw new DOMException('Transfer list contains source port', 'DataCloneError');
      } else if (item instanceof MessagePort || item instanceof ReadableStream || item instanceof TransformStream) {
        throw new Error(`${who} transfer of a ${Object.prototype.toString.call(item).slice(8, -1)} inside the scriptc island is not supported yet`);
      } else {
        throw new DOMException('Found invalid value in transferList.', 'DataCloneError');
      }
    }
    const out = scClone(value, new WeakMap());
    for (const b of buffers) b.transfer();
    return out;
  };

  /* MessageEvent + MessagePort/MessageChannel — Node globals (v15+). The
   * same-thread subset: postMessage queues a structuredClone COPY on the
   * peer, which worker_threads' receiveMessageOnPort drains synchronously
   * (internals.receiveMessageOnPort; undici's structuredClone fallback is
   * its consumer). Node delivers queued messages as 'message' events on a
   * later macrotask once the port starts; the island has no such task
   * source, so every way to start delivery — start(), the onmessage and
   * onmessageerror setters, a 'message', 'messageerror' or 'close'
   * listener (on/once/addListener/addEventListener) — throws a named Error
   * instead of delivering at the wrong time (SEMANTICS.md S108 (h)). */
  const mpFence = (what) => new Error(`MessagePort ${what} is not supported in the scriptc island (no task source delivers port messages)`);
  const ME = new WeakMap();
  const meOf = (o) => {
    const s = typeof o === 'object' && o !== null ? ME.get(o) : undefined;
    if (s === undefined) throw errInvalidThis('MessageEvent');
    return s;
  };
  /* undici's MessageEvent (lib/web/websocket/events.js): the init dict
   * converted by webidl's dictionaryConverter — members in key order
   * (bubbles, cancelable, composed, data, lastEventId, origin, ports,
   * source), each defaulted when undefined — then the ports frozen; and
   * initMessageEvent answering a NEW event, leaving this one untouched. */
  const mePort = (V, prefix, argument) => {
    if (!(V instanceof MessagePort)) throw idlError(prefix, `Expected ${argument} ("${idlStringify(V)}") to be an instance of MessagePort.`);
    return V;
  };
  const meInit = (d, prefix) => {
    if (d != null && typeof d !== 'object' && typeof d !== 'function') {
      throw idlError(prefix, `Expected ${d} to be one of: Null, Undefined, Object.`);
    }
    const r = {};
    for (const k of ['bubbles', 'cancelable', 'composed']) r[k] = !!d?.[k];
    const data = d?.data;
    r.data = data === undefined ? null : data;
    const lastEventId = d?.lastEventId;
    r.lastEventId = lastEventId === undefined ? '' : `${lastEventId}`;
    const origin = d?.origin;
    r.origin = origin === undefined ? '' : toUSV(origin);
    const ports = d?.ports;
    if (ports === undefined) r.ports = [];
    else {
      /* webidl.sequenceConverter */
      const argument = 'eventInitDict.ports';
      if (ports === null || (typeof ports !== 'object' && typeof ports !== 'function')) {
        throw idlError(prefix, `${argument} (${idlStringify(ports)}) is not iterable.`);
      }
      const method = ports?.[Symbol.iterator]?.();
      if (method === undefined || typeof method.next !== 'function') throw idlError(prefix, `${argument} is not iterable.`);
      r.ports = [];
      for (;;) {
        const { done, value } = method.next();
        if (done) break;
        r.ports.push(mePort(value, prefix, `${argument}[${r.ports.length}]`));
      }
    }
    const source = d?.source;
    r.source = source === undefined || source === null ? null : mePort(source, prefix, 'eventInitDict.source');
    Object.freeze(r.ports);
    return r;
  };
  class MessageEvent extends Event {
    constructor(type, eventInitDict = {}) {
      const prefix = 'MessageEvent constructor';
      if (arguments.length === 0) throw idlError(prefix, '1 argument required, but 0 found.');
      type = domString(type);
      const init = meInit(eventInitDict, prefix);
      super(type, { bubbles: init.bubbles, cancelable: init.cancelable, composed: init.composed });
      ME.set(this, init);
    }
    get data() { return meOf(this).data; }
    get origin() { return meOf(this).origin; }
    get lastEventId() { return meOf(this).lastEventId; }
    get source() { return meOf(this).source; }
    get ports() { return meOf(this).ports; }
    initMessageEvent(type, bubbles = false, cancelable = false, data = null, origin = '', lastEventId = '', source = null, ports = []) {
      meOf(this);
      if (arguments.length === 0) throw idlError('MessageEvent.initMessageEvent', '1 argument required, but 0 found.');
      return new MessageEvent(type, { bubbles, cancelable, data, origin, lastEventId, source, ports });
    }
  }
  webidlShape(MessageEvent, 'MessageEvent');
  const MP = new WeakMap(); // port -> { queue, peer }
  const mpOf = (o) => {
    const s = typeof o === 'object' && o !== null ? MP.get(o) : undefined;
    if (s === undefined) throw errInvalidThis('MessagePort');
    return s;
  };
  let mintingPort = false;
  class MessagePort extends EventTarget {
    constructor() {
      if (!mintingPort) throw nodeError(TypeError, 'ERR_CONSTRUCT_CALL_INVALID', 'Constructor cannot be called');
      super();
      MP.set(this, { queue: [], peer: null });
    }
    /* Node's MessagePort::PostMessage (src/node_messaging.cc): the second
     * argument is a transfer list (an iterable object) or an options bag
     * whose `transfer` is one; the clone and the detaching happen even on
     * a closed port, which then drops the message. */
    postMessage(value, transferList = undefined) {
      const s = MP.get(this);
      if (typeof this !== 'object' || this === null || s === undefined) throw new TypeError('Illegal invocation');
      if (arguments.length === 0) throw cppTypeError('ERR_MISSING_ARGS', 'Not enough arguments to MessagePort.postMessage');
      let list = [];
      if (transferList !== undefined && transferList !== null) {
        if (typeof transferList !== 'object' && typeof transferList !== 'function') {
          throw cppTypeError('ERR_INVALID_ARG_TYPE', 'Optional transferList argument must be an iterable');
        }
        if (typeof transferList[Symbol.iterator] === 'function') list = [...transferList];
        else {
          const tr = transferList.transfer;
          if (tr !== undefined) {
            if (tr === null || (typeof tr !== 'object' && typeof tr !== 'function') || typeof tr[Symbol.iterator] !== 'function') {
              throw cppTypeError('ERR_INVALID_ARG_TYPE', 'Optional options.transfer argument must be an iterable');
            }
            list = [...tr];
          }
        }
      }
      const message = cloneTransferring(value, list, this, 'MessagePort.postMessage');
      if (s.peer === null) return;
      MP.get(s.peer).queue.push({ message });
    }
    start() { mpOf(this); throw mpFence('message delivery (start)'); }
    close() {
      const s = mpOf(this);
      const peer = s.peer;
      s.peer = null;
      if (peer) MP.get(peer).peer = null;
    }
    get onmessage() { mpOf(this); return null; }
    set onmessage(fn) { mpOf(this); throw mpFence('message delivery (onmessage)'); }
    get onmessageerror() { mpOf(this); return null; }
    set onmessageerror(fn) { mpOf(this); throw mpFence('message delivery (onmessageerror)'); }
    ref() { return this; }
    unref() { return this; }
    hasRef() { return false; }
  }
  webidlShape(MessagePort, 'EventTarget');
  delete MessagePort.prototype[Symbol.toStringTag];
  {
    const fence = (type) => String(type) === 'message' || String(type) === 'close' || String(type) === 'messageerror';
    const add = function addEventListener(type, listener, options) {
      if (fence(type)) throw mpFence(`'${String(type)}' events`);
      return EventTarget.prototype.addEventListener.apply(this, arguments);
    };
    const on = function on(name) { throw mpFence(`'${String(name)}' events`); };
    Object.defineProperty(MessagePort.prototype, 'addEventListener', { value: add, writable: true, enumerable: false, configurable: true });
    for (const k of ['on', 'once', 'addListener']) Object.defineProperty(MessagePort.prototype, k, { value: on, writable: true, enumerable: false, configurable: true });
    const off = function off() { return this; };
    for (const k of ['off', 'removeListener']) Object.defineProperty(MessagePort.prototype, k, { value: off, writable: true, enumerable: false, configurable: true });
  }
  internals.receiveMessageOnPort = (port) => {
    const s = MP.get(port);
    return s !== undefined && s.queue.length > 0 ? s.queue.shift() : undefined;
  };
  class MessageChannel {
    constructor() {
      mintingPort = true;
      try {
        this.port1 = new MessagePort();
        this.port2 = new MessagePort();
      } finally { mintingPort = false; }
      MP.get(this.port1).peer = this.port2;
      MP.get(this.port2).peer = this.port1;
    }
  }

  const te = () => new TextEncoder();

  const coerceBodyBytes = (body) => {
    // → [bytes|stream, implicit content-type or null]
    if (typeof body === 'string') return [te().encode(body), 'text/plain;charset=UTF-8'];
    if (body instanceof URLSearchParams) {
      return [te().encode(String(body)), 'application/x-www-form-urlencoded;charset=UTF-8'];
    }
    if (BLOB.has(body)) {
      const b = BLOB.get(body);
      return [new Uint8Array(b.bytes), b.type === '' ? null : b.type];
    }
    if (body instanceof Uint8Array) return [new Uint8Array(body), null];
    if (body instanceof ArrayBuffer) return [new Uint8Array(body.slice(0)), null];
    if (ArrayBuffer.isView(body)) {
      return [new Uint8Array(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)), null];
    }
    if (body instanceof ReadableStream) return [body, null];
    throw new TypeError('unsupported body type in the scriptc island (string, Uint8Array, ArrayBuffer, Blob, URLSearchParams, or ReadableStream)');
  };

  /* Request/Response state, private: { url, method, headers, body (bytes,
   * a ReadableStream or null), bodyUsed, signal, status, statusText,
   * redirected, type }. */
  const FV = new WeakMap();
  const fvOf = (o, name) => {
    const s = typeof o === 'object' && o !== null ? FV.get(o) : undefined;
    if (s === undefined || s.kind !== name) throw illegal();
    return s;
  };
  const consume = (s) => {
    if (s.bodyUsed) return Promise.reject(new TypeError('Body is unusable: Body has already been read'));
    s.bodyUsed = true;
    const body = s.body;
    if (body === null) return Promise.resolve(new Uint8Array(0));
    if (body instanceof Uint8Array) return Promise.resolve(body);
    // a ReadableStream of Uint8Array (or string) chunks
    const chunks = [];
    let total = 0;
    const reader = body.getReader();
    const step = () =>
      reader.read().then((r) => {
        if (r.done) {
          const out = new Uint8Array(total);
          let off = 0;
          for (const c of chunks) { out.set(c, off); off += c.length; }
          return out;
        }
        const c = typeof r.value === 'string' ? te().encode(r.value) : r.value;
        if (!(c instanceof Uint8Array)) throw new TypeError('body stream produced a non-byte chunk');
        chunks.push(c);
        total += c.length;
        return step();
      });
    return step();
  };
  const bodyMixin = (C, name) => {
    const methods = {
      get body() {
        const s = fvOf(this, name);
        if (s.body === null) return null;
        if (s.body instanceof Uint8Array) {
          // lazily wrap fixed bytes in a stream, once
          const bytes = s.body;
          s.body = new ReadableStream({
            start(c) { c.enqueue(bytes); c.close(); },
            cancel() { s.bodyUsed = true; },
          });
        }
        return s.body;
      },
      get bodyUsed() { return fvOf(this, name).bodyUsed; },
      arrayBuffer() { return consume(fvOf(this, name)).then((b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); },
      blob() {
        const s = fvOf(this, name);
        return consume(s).then((b) => new Blob([b], { type: s.headers.get('content-type') ?? '' }));
      },
      bytes() { return consume(fvOf(this, name)); },
      formData() { fvOf(this, name); throw new Error(`${name}.formData inside the scriptc island is not supported yet`); },
      json() { return this.text().then((t) => JSON.parse(t)); },
      text() { return consume(fvOf(this, name)).then((b) => new TextDecoder().decode(b)); },
      clone() { fvOf(this, name); throw new Error(name + '.clone is not supported in the scriptc island'); },
    };
    for (const k of Object.getOwnPropertyNames(methods)) {
      const d = Object.getOwnPropertyDescriptor(methods, k);
      d.enumerable = true;
      d.configurable = true;
      Object.defineProperty(C.prototype, k, d);
    }
  };

  const normalizeMethod = (m) => {
    const s = String(m);
    const u = s.toUpperCase();
    if (u === 'DELETE' || u === 'GET' || u === 'HEAD' || u === 'OPTIONS' || u === 'POST' || u === 'PUT') return u;
    if (u === 'CONNECT' || u === 'TRACE' || u === 'TRACK') throw new TypeError(`'${s}' HTTP method is unsupported.`);
    return s;
  };
  const REQUEST_DEFAULTS = {
    cache: 'default', credentials: 'same-origin', destination: '', duplex: 'half', integrity: '',
    isHistoryNavigation: false, isReloadNavigation: false, keepalive: false, mode: 'cors',
    redirect: 'follow', referrer: 'about:client', referrerPolicy: '',
  };

  /* undici parses a request's (and a redirect's) URL with the WHATWG
   * parser, which the island's web text does not carry: a string with no
   * scheme fails as Node's does ("Failed to parse URL from …", its cause
   * ERR_INVALID_URL), one with a scheme is kept as written — not
   * validated further, not normalised (S108 (k)). */
  const parseFetchUrl = (u) => {
    const str = toUSV(u);
    if (!/^[\t\n\f\r ]*[A-Za-z][A-Za-z0-9+.-]*:/.test(str)) {
      const cause = nodeError(TypeError, 'ERR_INVALID_URL', 'Invalid URL');
      cause.input = str;
      throw new TypeError(`Failed to parse URL from ${str}`, { cause });
    }
    return str;
  };
  class Request {
    constructor(input, init = {}) {
      if (arguments.length === 0) throw idlError('Request constructor', '1 argument required, but only 0 found.');
      init = init === undefined || init === null ? {} : init;
      const s = { kind: 'Request', url: '', method: 'GET', headers: null, body: null, bodyUsed: false, signal: null };
      const src = typeof input === 'object' && input !== null ? FV.get(input) : undefined;
      if (src !== undefined && src.kind === 'Request') {
        s.url = src.url;
        s.method = src.method;
        s.headers = new Headers(src.headers);
        s.body = src.body; // shared bytes; fetch copies
        s.signal = src.signal;
      } else {
        s.url = parseFetchUrl(input);
        if (/^[\t\n\f\r ]*[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#@]*[^/?#@:][^/?#@]*@/.test(s.url)) {
          throw new TypeError(`Request cannot be constructed from a URL that includes credentials: ${s.url}`);
        }
        s.headers = new Headers();
      }
      if (init.method !== undefined) s.method = normalizeMethod(init.method);
      if (init.headers !== undefined) s.headers = new Headers(init.headers);
      if (init.signal !== undefined) {
        if (init.signal !== null && !AS.has(init.signal)) {
          throw new TypeError('Request init.signal must be an AbortSignal or null');
        }
        s.signal = init.signal;
      }
      if (init.body !== undefined && init.body !== null) {
        if (s.method === 'GET' || s.method === 'HEAD') {
          throw new TypeError('Request with GET/HEAD method cannot have body.');
        }
        const [bytes, ct] = coerceBodyBytes(init.body);
        s.body = bytes;
        if (ct !== null && !s.headers.has('content-type')) s.headers.set('content-type', ct);
      }
      FV.set(this, s);
    }
    get url() { return fvOf(this, 'Request').url; }
    get method() { return fvOf(this, 'Request').method; }
    get headers() { return fvOf(this, 'Request').headers; }
    /* Node's Request.signal is never null — a request built without one
     * carries an inert signal; mint it lazily on first access. */
    get signal() {
      const s = fvOf(this, 'Request');
      if (s.signal === null) s.signal = mkSignal();
      return s.signal;
    }
  }
  for (const [k, v] of Object.entries(REQUEST_DEFAULTS)) {
    Object.defineProperty(Request.prototype, k, {
      get: { [`get ${k}`]() { fvOf(this, 'Request'); return v; } }[`get ${k}`], enumerable: true, configurable: true,
    });
  }
  bodyMixin(Request, 'Request');
  webidlShape(Request, 'Request');

  const REDIRECT_STATUS = [301, 302, 303, 307, 308];
  const mintResponse = (status, statusText, headers, url, redirected, body, type) => {
    const r = Object.create(Response.prototype);
    FV.set(r, { kind: 'Response', status, statusText, headers, url, redirected, body, bodyUsed: false, type });
    return r;
  };
  class Response {
    constructor(body = null, init = {}) {
      init = init === undefined || init === null ? {} : init;
      const status = init.status === undefined ? 200 : Number(init.status);
      if (!Number.isInteger(status) || status < 200 || status > 599) {
        throw new RangeError(`init["status"] must be in the range of 200 to 599, inclusive.`);
      }
      const s = {
        kind: 'Response', status, statusText: init.statusText === undefined ? '' : String(init.statusText),
        headers: new Headers(init.headers), url: '', redirected: false, bodyUsed: false, body: null, type: 'default',
      };
      if (body !== undefined && body !== null) {
        if (status === 101 || status === 103 || status === 204 || status === 205 || status === 304) {
          throw new TypeError(`Response constructor: Invalid response status code ${status}`);
        }
        const [bytes, ct] = coerceBodyBytes(body);
        s.body = bytes;
        if (ct !== null && !s.headers.has('content-type')) s.headers.set('content-type', ct);
      }
      FV.set(this, s);
    }
    get type() { return fvOf(this, 'Response').type; }
    get url() { return fvOf(this, 'Response').url; }
    get redirected() { return fvOf(this, 'Response').redirected; }
    get status() { return fvOf(this, 'Response').status; }
    get ok() { const s = fvOf(this, 'Response').status; return s >= 200 && s <= 299; }
    get statusText() { return fvOf(this, 'Response').statusText; }
    get headers() { return fvOf(this, 'Response').headers; }
    static json(data, init = {}) {
      const r = new Response(JSON.stringify(data), init);
      FV.get(r).headers.set('content-type', 'application/json');
      return r;
    }
    static error() { return mintResponse(0, '', new Headers(), '', false, null, 'error'); }
    static redirect(url, status = 302) {
      const href = parseFetchUrl(url);
      if (!REDIRECT_STATUS.includes(status)) throw new RangeError(`Invalid status code ${status}`);
      const h = new Headers();
      h.set('location', href);
      return mintResponse(status, '', h, '', false, null, 'default');
    }
  }
  bodyMixin(Response, 'Response');
  webidlShape(Response, 'Response');

  /* Internal: fetch builds Responses outside the constructor's 200–599
   * validation surface (statusText from the wire, url/redirected set), and
   * reads a Request's body and signal. */
  internals.mkResponse = (status, statusText, headers, url, redirected, bodyStream) =>
    mintResponse(status, String(statusText), headers, url, redirected, bodyStream, 'default');
  internals.requestBody = (r) => { const s = FV.get(r); return s !== undefined && s.body instanceof Uint8Array ? s.body : null; };
  internals.requestSignal = (r) => { const s = FV.get(r); return s !== undefined ? s.signal : null; };
  /* crypto: a Crypto instance (the class illegal to construct, like
   * Node's); randomness bridges to the HOST functions — native: the same
   * arc4random_buf CSPRNG behind the static crypto lowerings; wasm: the
   * module's `random` import. Errors are Node's (lib/internal/crypto/
   * random.js, webidl): DOMExceptions for the type and the quota. crypto.
   * subtle is an object of Node's method names whose methods throw. */
  const intTA = ['Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array', 'BigInt64Array', 'BigUint64Array'];
  const taTag = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), Symbol.toStringTag).get;
  let cryptoBrand = false;
  /* SubtleCrypto, Node's shape (a class illegal to construct, the
   * methods on its prototype, crypto.subtle its one instance) — but
   * WebCrypto is not carried: every method throws a named Error
   * synchronously where Node returns a promise (S108 (g)). */
  let subtleBrand = false;
  class SubtleCrypto {
    constructor() {
      if (!subtleBrand) throw nodeError(TypeError, 'ERR_ILLEGAL_CONSTRUCTOR', 'Illegal constructor');
    }
    static supports() { throw new Error('SubtleCrypto.supports inside the scriptc island is not supported yet'); }
  }
  for (const k of ['encrypt', 'decrypt', 'sign', 'verify', 'digest', 'generateKey', 'deriveKey', 'deriveBits',
    'importKey', 'exportKey', 'wrapKey', 'unwrapKey', 'getPublicKey', 'encapsulateBits', 'encapsulateKey',
    'decapsulateBits', 'decapsulateKey']) {
    const fn = { [k]() { throw new Error(`crypto.subtle.${k} inside the scriptc island is not supported yet`); } }[k];
    Object.defineProperty(SubtleCrypto.prototype, k, { value: fn, writable: true, enumerable: true, configurable: true });
  }
  tag(SubtleCrypto, 'SubtleCrypto');
  subtleBrand = true;
  const subtleObj = new SubtleCrypto();
  subtleBrand = false;
  class Crypto {
    constructor() {
      if (!cryptoBrand) throw nodeError(TypeError, 'ERR_ILLEGAL_CONSTRUCTOR', 'Illegal constructor');
    }
    get subtle() {
      if (this !== cryptoObj) throw errInvalidThis('Crypto');
      return subtleObj;
    }
    getRandomValues(data) {
      if (this !== cryptoObj) throw errInvalidThis('Crypto');
      if (arguments.length < 1) {
        throw nodeError(TypeError, 'ERR_MISSING_ARGS', "Failed to execute 'getRandomValues' on 'Crypto': 1 argument required, but only 0 present.");
      }
      const t = ArrayBuffer.isView(data) ? taTag.call(data) : undefined;
      if (intTA.indexOf(t) < 0) throw new DOMException('The data argument must be an integer-type TypedArray', 'TypeMismatchError');
      if (data.byteLength > 65536) throw new DOMException('The requested length exceeds 65,536 bytes', 'QuotaExceededError');
      host.fill(data);
      return data;
    }
    randomUUID() {
      if (this !== cryptoObj) throw errInvalidThis('Crypto');
      return host.uuid();
    }
  }
  for (const k of ['subtle', 'getRandomValues', 'randomUUID']) {
    Object.defineProperty(Crypto.prototype, k, { enumerable: true });
  }
  tag(Crypto, 'Crypto');
  cryptoBrand = true;
  const cryptoObj = new Crypto();
  cryptoBrand = false;

  /* ── util.inspect / util.format: Node v24.18.1's lib/internal/util/
   * inspect.js, ported function for function (the same names, the same
   * branches, the same order of checks) over the primordials below, which
   * capture the intrinsics at boot exactly as Node's do — a program that
   * later replaces Array.prototype.push or Map.prototype.get does not
   * reach the inspector. ONE inspector for every build and lane: console.*
   * below, the error messages that quote a value, and node:util in npm
   * builds (the npm bootstrap takes internals.inspect & co.). What the
   * engine cannot answer from JavaScript comes from the host (a promise's
   * state, a proxy's target and handler) or is emulated from the
   * intrinsics' own brand checks (the internalBinding('types') answers);
   * where neither reaches V8's answer it is registered (SEMANTICS.md
   * S114): an iterator of a Map or a Set, and showHidden over a WeakMap or
   * WeakSet (V8's previewEntries), throw a named Error instead. */
  const uncurryThis = (fn) => Function.prototype.call.bind(fn);
  const getterOf = (o, k) => uncurryThis(Object.getOwnPropertyDescriptor(o, k).get);
  const TypedArray = Object.getPrototypeOf(Uint8Array);
  const ArrayIsArray = Array.isArray;
  const ArrayPrototypeFilter = uncurryThis(Array.prototype.filter);
  const ArrayPrototypeForEach = uncurryThis(Array.prototype.forEach);
  const ArrayPrototypeIncludes = uncurryThis(Array.prototype.includes);
  const ArrayPrototypeIndexOf = uncurryThis(Array.prototype.indexOf);
  const ArrayPrototypeJoin = uncurryThis(Array.prototype.join);
  const ArrayPrototypeMap = uncurryThis(Array.prototype.map);
  const ArrayPrototypePop = uncurryThis(Array.prototype.pop);
  const ArrayPrototypePush = uncurryThis(Array.prototype.push);
  const ArrayPrototypePushApply = (a, items) => Reflect.apply(Array.prototype.push, a, items);
  const ArrayPrototypeSlice = uncurryThis(Array.prototype.slice);
  const ArrayPrototypeSort = uncurryThis(Array.prototype.sort);
  const ArrayPrototypeSplice = uncurryThis(Array.prototype.splice);
  const ArrayPrototypeUnshift = uncurryThis(Array.prototype.unshift);
  const ArrayFrom = Array.from;
  const BigIntPrototypeValueOf = uncurryThis(BigInt.prototype.valueOf);
  const BooleanPrototypeValueOf = uncurryThis(Boolean.prototype.valueOf);
  const DatePrototypeGetTime = uncurryThis(Date.prototype.getTime);
  const DatePrototypeToISOString = uncurryThis(Date.prototype.toISOString);
  const DatePrototypeToString = uncurryThis(Date.prototype.toString);
  const ErrorPrototypeToString = uncurryThis(Error.prototype.toString);
  const FunctionPrototypeBind = uncurryThis(Function.prototype.bind);
  const FunctionPrototypeCall = uncurryThis(Function.prototype.call);
  const FunctionPrototypeSymbolHasInstance = uncurryThis(Function.prototype[Symbol.hasInstance]);
  const FunctionPrototypeToString = uncurryThis(Function.prototype.toString);
  const JSONStringify = JSON.stringify;
  const MapPrototypeEntries = uncurryThis(Map.prototype.entries);
  const MapPrototypeGetSize = getterOf(Map.prototype, 'size');
  const MathCeil = Math.ceil;
  const MathFloor = Math.floor;
  const MathMax = Math.max;
  const MathMaxApply = (a) => Reflect.apply(Math.max, undefined, a);
  const MathMin = Math.min;
  const MathRound = Math.round;
  const MathSqrt = Math.sqrt;
  const MathTrunc = Math.trunc;
  const NumberIsFinite = Number.isFinite;
  const NumberIsNaN = Number.isNaN;
  const NumberParseFloat = Number.parseFloat;
  const NumberParseInt = Number.parseInt;
  const NumberPrototypeToString = uncurryThis(Number.prototype.toString);
  const NumberPrototypeValueOf = uncurryThis(Number.prototype.valueOf);
  const ObjectAssign = Object.assign;
  const ObjectDefineProperty = Object.defineProperty;
  const ObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
  const ObjectGetOwnPropertyNames = Object.getOwnPropertyNames;
  const ObjectGetOwnPropertySymbols = Object.getOwnPropertySymbols;
  const ObjectGetPrototypeOf = Object.getPrototypeOf;
  const ObjectIs = Object.is;
  const ObjectIsExtensible = Object.isExtensible;
  const ObjectKeys = Object.keys;
  const ObjectValues = Object.values;
  const ObjectPrototypeHasOwnProperty = uncurryThis(Object.prototype.hasOwnProperty);
  const ObjectPrototypePropertyIsEnumerable = uncurryThis(Object.prototype.propertyIsEnumerable);
  const ObjectPrototypeToString = uncurryThis(Object.prototype.toString);
  const ObjectSeal = Object.seal;
  const ObjectSetPrototypeOf = Object.setPrototypeOf;
  const ReflectApply = Reflect.apply;
  const ReflectOwnKeys = Reflect.ownKeys;
  const RegExpPrototypeExec = uncurryThis(RegExp.prototype.exec);
  const RegExpPrototypeSymbolReplace = uncurryThis(RegExp.prototype[Symbol.replace]);
  const RegExpPrototypeSymbolSplit = uncurryThis(RegExp.prototype[Symbol.split]);
  const RegExpPrototypeToString = uncurryThis(RegExp.prototype.toString);
  const RegExpPrototypeGetSource = getterOf(RegExp.prototype, 'source');
  const SetPrototypeGetSize = getterOf(Set.prototype, 'size');
  const SetPrototypeValues = uncurryThis(Set.prototype.values);
  const StringPrototypeCharCodeAt = uncurryThis(String.prototype.charCodeAt);
  const StringPrototypeCodePointAt = uncurryThis(String.prototype.codePointAt);
  const StringPrototypeEndsWith = uncurryThis(String.prototype.endsWith);
  const StringPrototypeIncludes = uncurryThis(String.prototype.includes);
  const StringPrototypeIndexOf = uncurryThis(String.prototype.indexOf);
  const StringPrototypeLastIndexOf = uncurryThis(String.prototype.lastIndexOf);
  const StringPrototypeNormalize = uncurryThis(String.prototype.normalize);
  const StringPrototypePadEnd = uncurryThis(String.prototype.padEnd);
  const StringPrototypePadStart = uncurryThis(String.prototype.padStart);
  const StringPrototypeRepeat = uncurryThis(String.prototype.repeat);
  const StringPrototypeReplace = uncurryThis(String.prototype.replace);
  const StringPrototypeReplaceAll = uncurryThis(String.prototype.replaceAll);
  const StringPrototypeSlice = uncurryThis(String.prototype.slice);
  const StringPrototypeSplit = uncurryThis(String.prototype.split);
  const StringPrototypeStartsWith = uncurryThis(String.prototype.startsWith);
  const StringPrototypeToLowerCase = uncurryThis(String.prototype.toLowerCase);
  const StringPrototypeValueOf = uncurryThis(String.prototype.valueOf);
  const SymbolIterator = Symbol.iterator;
  const SymbolPrototypeToString = uncurryThis(Symbol.prototype.toString);
  const SymbolPrototypeValueOf = uncurryThis(Symbol.prototype.valueOf);
  const SymbolToPrimitive = Symbol.toPrimitive;
  const SymbolToStringTag = Symbol.toStringTag;
  const TypedArrayPrototypeGetLength = getterOf(TypedArray.prototype, 'length');
  const TypedArrayPrototypeGetSymbolToStringTag = getterOf(TypedArray.prototype, Symbol.toStringTag);
  /* Node's SafeMap/SafeSet: the methods the inspector calls, captured. */
  const makeSafe = (Base, keys) => {
    class Safe extends Base { constructor(i) { super(i); } }
    for (const k of keys) {
      const d = Object.getOwnPropertyDescriptor(Base.prototype, k);
      Object.defineProperty(Safe.prototype, k, d);
    }
    Object.freeze(Safe.prototype);
    return Safe;
  };
  const SafeMap = makeSafe(Map, ['get', 'set', 'has', 'delete', 'size']);
  const SafeSet = makeSafe(Set, ['add', 'has', 'delete', 'size', 'values', Symbol.iterator]);
  /* primordials[name] for the typed array constructors (formatRaw). */
  const typedArrayCtors = {
    Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array,
    Float16Array: g.Float16Array, Float32Array, Float64Array, BigInt64Array, BigUint64Array,
  };

  /* ── internalBinding('types') and ('util'), from the intrinsics' own
   * internal-slot checks (each throws on anything else, never runs user
   * code) and the host's (a promise's state, a proxy's parts). */
  /* isDate, isRegExp, isMap, isSet, isWeakMap, isWeakSet, isArrayBuffer,
   * isDataView are structuredClone's (above). */
  const isSharedArrayBuffer = isSAB;
  const isAnyArrayBufferSlot = (v) => isArrayBuffer(v) || isSharedArrayBuffer(v);
  const isTypedArray = (v) => TypedArrayPrototypeGetSymbolToStringTag(v) !== undefined;
  const isNumberObject = brand(NumberPrototypeValueOf);
  const isStringObject = brand(StringPrototypeValueOf);
  const isBooleanObject = brand(BooleanPrototypeValueOf);
  const isBigIntObject = brand(BigIntPrototypeValueOf);
  const isSymbolObject = brand(SymbolPrototypeValueOf);
  const isBoxedPrimitive = (v) =>
    isNumberObject(v) || isStringObject(v) || isBooleanObject(v) || isBigIntObject(v) || isSymbolObject(v);
  const isNativeError = Error.isError;
  const isPromise = (v) => host.isPromise(v);
  /* The function kinds (V8 reads the function's kind; the engine's
   * functions of a kind share its intrinsic prototype). */
  const AsyncFunctionPrototype = Object.getPrototypeOf(async function () {});
  const GeneratorFunctionPrototype = Object.getPrototypeOf(function* () {});
  const AsyncGeneratorFunctionPrototype = Object.getPrototypeOf(async function* () {});
  const isAsyncFunction = (v) => {
    const p = ObjectGetPrototypeOf(v);
    return p === AsyncFunctionPrototype || p === AsyncGeneratorFunctionPrototype;
  };
  const isGeneratorFunction = (v) => {
    const p = ObjectGetPrototypeOf(v);
    return p === GeneratorFunctionPrototype || p === AsyncGeneratorFunctionPrototype;
  };
  /* Map/Set iterators, arguments objects and module namespaces by the
   * engine's own class of the object (host.classId — what V8's
   * IsJSMapIterator & co. read; nothing a program can fake or that runs
   * its code), against the class ids of real ones made here at boot
   * (a module namespace's, which JavaScript cannot make without a
   * loader, the host answers). */
  const classId = (v) => host.classId(v);
  const MAP_ITERATOR_CLASS = classId(new Map().entries());
  const SET_ITERATOR_CLASS = classId(new Set().values());
  const ARGUMENTS_CLASS = classId((function () { return arguments; })());
  const MAPPED_ARGUMENTS_CLASS = classId(Function('a', 'return arguments')(0));
  const MODULE_NS_CLASS = host.moduleNamespaceClassId();
  const isMapIterator = (v) => classId(v) === MAP_ITERATOR_CLASS;
  const isSetIterator = (v) => classId(v) === SET_ITERATOR_CLASS;
  const isArgumentsObject = (v) => { const c = classId(v); return c === ARGUMENTS_CLASS || c === MAPPED_ARGUMENTS_CLASS; };
  const isModuleNamespaceObject = (v) => classId(v) === MODULE_NS_CLASS;
  const isExternal = () => false;
  const ALL_PROPERTIES = 0;
  const ONLY_ENUMERABLE = 2;
  const kPending = 0;
  const kRejected = 2;
  /* An array index: a canonical numeric string below 2^32 - 1. */
  const isIndexKey = (k) => {
    if (typeof k !== 'string' || k.length === 0 || k.length > 10) return false;
    if (k !== '0' && (k.charCodeAt(0) < 49 || k.charCodeAt(0) > 57)) return false;
    for (let i = 1; i < k.length; i++) { const c = k.charCodeAt(i); if (c < 48 || c > 57) return false; }
    return +k < 4294967295;
  };
  const getOwnNonIndexProperties = (value, filter) => {
    const out = [];
    for (const k of ReflectOwnKeys(value)) {
      if (isIndexKey(k)) continue;
      if (filter === ONLY_ENUMERABLE && !ObjectPrototypePropertyIsEnumerable(value, k)) continue;
      ArrayPrototypePush(out, k);
    }
    return out;
  };
  /* [state, result]: 0 pending, 1 fulfilled, 2 rejected. */
  const getPromiseDetails = (p) => host.promiseState(p);
  /* undefined for a non-proxy; the target (showProxy: [target, handler]);
   * null once revoked. */
  const getProxyDetails = (value, showProxy) => {
    if (!host.isProxy(value)) return undefined;
    let target, handler;
    try { target = host.proxyTarget(value); handler = host.proxyHandler(value); } catch { return null; }
    return showProxy ? [target, handler] : target;
  };
  const previewEntries = (value) => {
    let what = 'a WeakMap';
    if (isWeakSet(value)) what = 'a WeakSet';
    else if (isMapIterator(value)) what = 'a Map iterator';
    else if (isSetIterator(value)) what = 'a Set iterator';
    throw new Error(`util.inspect of ${what}'s entries inside the scriptc island is not supported yet (SEMANTICS.md S114)`);
  };
  /* V8's JSReceiver::GetConstructorName where JavaScript can follow it: a
   * string Symbol.toStringTag data property on the chain, else a named
   * `constructor` data property above the receiver, else the class name.
   * (V8 first asks the object's map for the function that constructed it,
   * which JavaScript cannot see — S114.) */
  const internalGetConstructorName = (obj) => {
    for (let p = obj; p !== null; p = ObjectGetPrototypeOf(p)) {
      const t = ObjectGetOwnPropertyDescriptor(p, SymbolToStringTag);
      if (t !== undefined && typeof t.value === 'string') return t.value;
      if (p !== obj) {
        const c = ObjectGetOwnPropertyDescriptor(p, 'constructor');
        if (c !== undefined && typeof c.value === 'function') {
          const n = c.value.name;
          if (typeof n === 'string' && n !== '' && n !== 'Object') return n;
        }
      }
    }
    if (typeof obj === 'function') return 'Function';
    if (ArrayIsArray(obj)) return 'Array';
    if (isNativeError(obj)) return 'Error';
    if (isDate(obj)) return 'Date';
    if (isRegExp(obj)) return 'RegExp';
    if (isMap(obj)) return 'Map';
    if (isSet(obj)) return 'Set';
    if (isWeakMap(obj)) return 'WeakMap';
    if (isWeakSet(obj)) return 'WeakSet';
    if (isPromise(obj)) return 'Promise';
    if (isArrayBuffer(obj)) return 'ArrayBuffer';
    if (isSharedArrayBuffer(obj)) return 'SharedArrayBuffer';
    if (isDataView(obj)) return 'DataView';
    if (isTypedArray(obj)) return TypedArrayPrototypeGetSymbolToStringTag(obj);
    if (isNumberObject(obj)) return 'Number';
    if (isStringObject(obj)) return 'String';
    if (isBooleanObject(obj)) return 'Boolean';
    if (isBigIntObject(obj)) return 'BigInt';
    if (isSymbolObject(obj)) return 'Symbol';
    return 'Object';
  };

  /* ── internal/util, internal/errors, internal/validators: what the
   * inspector borrows. */
  const customInspectSymbol = Symbol.for('nodejs.util.inspect.custom');
  const isError = (e) => isNativeError(e) || FunctionPrototypeSymbolHasInstance(Error, e);
  const join = (output, separator) => {
    let str = '';
    if (output.length !== 0) {
      const lastIndex = output.length - 1;
      for (let i = 0; i < lastIndex; i++) {
        str += output[i];
        str += separator;
      }
      str += output[lastIndex];
    }
    return str;
  };
  const colorRegExp = /\u001b\[\d\d?m/g;
  const removeColors = (str) => StringPrototypeReplace(str, colorRegExp, '');
  /* The engine's own overflow error (S103 (a)). */
  const isStackOverflowError = (err) =>
    err && err.name === 'RangeError' && err.message === 'Maximum call stack size exceeded';
  const assert = (ok) => { if (!ok) throw nodeError(Error, 'ERR_INTERNAL_ASSERTION', 'This is caused by either a bug in Node.js or incorrect usage of Node.js internals.\nPlease open an issue with this stack trace at https://github.com/nodejs/node/issues\n'); };
  const validateObject = (value, name, allowArray) => {
    if (value === null || (!allowArray && ArrayIsArray(value)) || typeof value !== 'object') {
      throw errInvalidArgType(name, 'Object', value);
    }
  };
  const validateString = (value, name) => {
    if (typeof value !== 'string') throw errInvalidArgType(name, 'string', value);
  };

  /* ── getStringWidth: Node's ICU arm (node_i18n.cc GetStringWidth over
   * code points, ambiguous as narrow, emoji sequences expanded), from a
   * table GENERATED out of Node v24.18.1's own ICU by
   * scripts/gen-string-width.mjs: [start, width] runs over the code
   * points, base-36, width 1 where no run says otherwise. */
  /* BEGIN GENERATED string-width table */
  /* Node v24.18.1, ICU 78.3, Unicode 17.0. */
  const WIDTH_RUNS =
    '00,w1,2n0,x1,gw0,341,7n0,71,7b0,191,10,11,10,21,10,21,10,11,1k0,61,a0,b1,10,11,1a0,l1,g0,11,2t0,' +
    '81,10,61,20,21,10,41,x0,11,10,11,u0,r1,2j0,b1,1m0,91,90,11,o0,41,10,91,10,31,10,51,170,31,1g0,21,' +
    '50,91,160,1l1,1j0,11,10,11,40,81,40,11,30,71,a0,21,t0,11,1m0,11,40,41,80,11,k0,21,q0,11,20,21,' +
    '1l0,11,40,21,40,21,20,31,30,11,u0,21,30,11,b0,21,1l0,11,40,51,10,21,40,11,k0,21,m0,61,10,11,1m0,' +
    '11,20,11,10,41,80,11,70,21,b0,21,u0,11,1p0,11,c0,11,1e0,11,30,11,1j0,11,10,31,50,31,10,41,70,21,' +
    'b0,21,t0,11,1m0,11,20,11,60,11,50,21,k0,21,s0,21,1l0,21,40,41,80,11,k0,21,t0,11,200,11,70,31,10,' +
    '11,2i0,11,20,71,c0,81,2q0,11,20,91,b0,71,210,21,r0,11,10,11,10,11,1j0,e1,10,51,10,21,50,b1,10,' +
    '101,90,11,2u0,41,10,61,10,21,20,21,p0,21,40,31,g0,41,d0,11,20,21,60,11,f0,11,2q2,2o1,e50,31,qa0,' +
    '31,t0,21,u0,21,u0,21,1s0,21,10,71,80,11,20,b1,90,11,190,51,390,21,y0,11,3a0,31,40,21,90,11,60,31,' +
    '630,21,20,11,1m0,11,10,71,10,11,10,11,20,81,60,a1,20,11,1c0,1a1,20,c1,k0,41,1c0,11,10,51,10,11,' +
    '50,11,140,91,c0,21,w0,41,20,21,10,31,1k0,11,10,21,30,11,10,31,1m0,81,20,21,480,31,10,d1,10,71,40,' +
    '11,60,11,30,21,5i0,1s1,ej0,51,q0,51,1d0,51,10,a1,2o0,x1,fd2,21,d2,21,5a2,41,32,11,22,11,eh2,21,' +
    'l2,21,q2,81,g2,c1,172,11,a2,61,32,11,d2,11,82,21,h2,21,52,21,82,11,52,11,l2,11,72,21,12,11,42,11,' +
    '22,11,72,11,42,21,s2,11,z2,11,12,11,42,31,12,11,1p2,31,o2,11,e2,11,nv2,21,1f2,11,42,11,bd0,31,' +
    '3x0,11,2o0,w1,3k2,q1,12,2h1,c2,5y1,q2,271,22,2e1,22,2v1,52,171,12,2m1,12,2e1,92,1c1,12,141,82,' +
    'mkd1,32,1j1,bs0,41,10,a1,w0,21,280,21,7k0,11,30,11,40,11,p0,21,50,11,470,21,q0,i1,d0,11,120,81,' +
    'p0,b1,e2,t1,30,31,1c0,11,20,41,20,21,130,11,1v0,61,20,21,20,21,c0,11,80,11,1b0,11,1f0,11,10,31,' +
    '20,21,50,21,10,11,160,21,80,11,6m0,11,20,11,40,11,i2,8mc1,6l82,e81,u0,11,kh0,g2,a1,60,g2,z1,12,' +
    'j1,12,41,430,11,12,2o1,3j2,71,i0,31,e90,11,6a0,11,450,51,1ae0,31,10,21,50,41,140,31,40,11,4l0,21,' +
    'fx0,41,1t0,51,8t0,21,250,61,1y0,b1,1d0,41,3f0,11,1i0,f1,150,11,20,21,a0,31,1d0,41,20,21,20,11,40,' +
    '11,a0,11,1e0,31,100,51,10,81,1q0,11,c0,21,1g0,91,a0,41,20,11,2n0,31,20,11,10,21,60,11,20,11,4d0,' +
    '11,30,81,l0,21,1l0,21,30,11,110,71,30,51,1y0,61,d0,11,10,11,10,11,e0,21,2d0,81,20,31,10,11,n0,11,' +
    '2c0,61,10,11,40,21,10,21,6m0,41,60,21,10,21,r0,21,2d0,81,20,11,10,21,2y0,11,10,11,20,61,10,11,' +
    '2t0,11,10,11,20,41,10,51,770,91,10,21,740,21,10,11,40,11,400,41,20,21,40,11,w0,a1,140,61,20,41,' +
    '80,11,90,61,20,31,1a0,d1,10,21,5i0,11,10,31,10,11,5l0,71,10,61,10,11,2a0,m1,20,71,10,21,10,21,' +
    '3e0,61,30,11,10,21,10,71,10,11,200,21,30,11,10,11,9n0,21,b0,21,1g0,51,50,11,10,11,n0,11,4450,h1,' +
    '60,f1,8ug0,c1,30,31,1xc0,51,1n0,71,t40,11,1r0,41,252,51,b2,71,92,5p21,152,w1,2p2,371,6pp2,41,12,' +
    '71,12,21,12,831,f2,11,t2,31,22,11,e2,41,82,b01,1wh0,21,10,41,3mk0,1a1,20,n1,f40,31,90,g1,20,71,' +
    'u0,41,440,31,572,2f1,92,n1,1ah0,1j1,40,1e1,80,11,e0,11,m0,51,10,f1,11s0,71,10,h1,20,71,10,21,10,' +
    '51,2s0,11,4g0,71,af0,11,1p0,41,e40,41,720,21,6r0,11,20,11,70,21,50,11,d60,71,310,71,1bt2,11,5m2,' +
    '11,5a2,11,22,a1,232,t1,d2,181,42,91,72,21,e2,61,4a2,x1,c2,91,12,1y1,12,m1,c2,171,42,51,c2,h1,32,' +
    '11,32,1z1,12,11,12,571,22,1r1,d2,41,12,o1,i2,11,q2,21,d2,11,2e2,2d1,1c2,1y1,62,11,32,31,22,41,32,' +
    '41,b2,21,72,91,6b2,c1,42,11,7v2,1b1,12,a1,12,551,342,d1,32,b1,32,1l1,12,11,42,g1,22,c1,42,a1,zr2,' +
    '1eke1,22,1eke1,e1oj0,11,u0,2o1,3k0,6o1';
  /* END GENERATED string-width table */
  let widthStarts = null, widthValues = null;
  const loadWidths = () => {
    widthStarts = [];
    widthValues = [];
    let cp = 0;
    for (const run of StringPrototypeSplit(WIDTH_RUNS, ',')) {
      cp += NumberParseInt(StringPrototypeSlice(run, 0, -1), 36);
      ArrayPrototypePush(widthStarts, cp);
      ArrayPrototypePush(widthValues, StringPrototypeCharCodeAt(run, run.length - 1) - 48);
    }
  };
  const columnWidth = (cp) => {
    if (widthStarts === null) loadWidths();
    let lo = 0, hi = widthStarts.length - 1, w = 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (widthStarts[mid] <= cp) { w = widthValues[mid]; lo = mid + 1; } else hi = mid - 1;
    }
    return w;
  };
  const icuStringWidth = (str) => {
    let width = 0;
    for (let i = 0; i < str.length; i++) {
      const cp = StringPrototypeCodePointAt(str, i);
      if (cp > 0xffff) i++;
      width += columnWidth(cp);
    }
    return width;
  };
  function getStringWidth(str, removeControlChars = true) {
    let width = 0;
    if (removeControlChars) {
      str = stripVTControlCharacters(str);
    }
    for (let i = 0; i < str.length; i++) {
      const code = StringPrototypeCharCodeAt(str, i);
      if (code >= 127) {
        width += icuStringWidth(StringPrototypeNormalize(StringPrototypeSlice(str, i), 'NFC'));
        break;
      }
      width += code >= 32 ? 1 : 0;
    }
    return width;
  }

  /* ── lib/internal/util/inspect.js ── */
  let builtInObjects = null; // Node's: the capitalized global names, read once on first use
  const getBuiltInObjects = () => {
    if (builtInObjects === null) {
      builtInObjects = new SafeSet(
        ArrayPrototypeFilter(
          ObjectGetOwnPropertyNames(g),
          (e) => RegExpPrototypeExec(/^[A-Z][a-zA-Z0-9]+$/, e) !== null,
        ),
      );
    }
    return builtInObjects;
  };
  const isUndetectableObject = (v) => typeof v === 'undefined' && v !== undefined;
  const inspectDefaultOptions = ObjectSeal({
    showHidden: false,
    depth: 2,
    colors: false,
    customInspect: true,
    showProxy: false,
    maxArrayLength: 100,
    maxStringLength: 10000,
    breakLength: 80,
    compact: 3,
    sorted: false,
    getters: false,
    numericSeparator: false,
  });
  const kObjectType = 0;
  const kArrayType = 1;
  const kArrayExtrasType = 2;
  const strEscapeSequencesRegExp = /[\x00-\x1f\x27\x5c\x7f-\x9f]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
  const strEscapeSequencesReplacer = /[\x00-\x1f\x27\x5c\x7f-\x9f]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
  const strEscapeSequencesRegExpSingle = /[\x00-\x1f\x5c\x7f-\x9f]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
  const strEscapeSequencesReplacerSingle = /[\x00-\x1f\x5c\x7f-\x9f]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
  const keyStrRegExp = /^[a-zA-Z_][a-zA-Z_0-9]*$/;
  const numberRegExp = /^(0|[1-9][0-9]*)$/;
  const classBodyRegExp = /^(\s+[^(]*?)\s*{/;
  const stripCommentsRegExp = /(\/\/.*?\n)|(\/\*(.|\n)*?\*\/)/g;
  const kMinLineLength = 16;
  const kMaxInspectNesting = 100;
  const kWeak = 0;
  const kIterator = 1;
  const kMapEntries = 2;
  const meta = [
    '\\x00', '\\x01', '\\x02', '\\x03', '\\x04', '\\x05', '\\x06', '\\x07', // x07
    '\\b', '\\t', '\\n', '\\x0B', '\\f', '\\r', '\\x0E', '\\x0F',           // x0F
    '\\x10', '\\x11', '\\x12', '\\x13', '\\x14', '\\x15', '\\x16', '\\x17', // x17
    '\\x18', '\\x19', '\\x1A', '\\x1B', '\\x1C', '\\x1D', '\\x1E', '\\x1F', // x1F
    '', '', '', '', '', '', '', "\\'", '', '', '', '', '', '', '', '',      // x2F
    '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '',         // x3F
    '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '',         // x4F
    '', '', '', '', '', '', '', '', '', '', '', '', '\\\\', '', '', '',     // x5F
    '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '',         // x6F
    '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '\\x7F',    // x7F
    '\\x80', '\\x81', '\\x82', '\\x83', '\\x84', '\\x85', '\\x86', '\\x87', // x87
    '\\x88', '\\x89', '\\x8A', '\\x8B', '\\x8C', '\\x8D', '\\x8E', '\\x8F', // x8F
    '\\x90', '\\x91', '\\x92', '\\x93', '\\x94', '\\x95', '\\x96', '\\x97', // x97
    '\\x98', '\\x99', '\\x9A', '\\x9B', '\\x9C', '\\x9D', '\\x9E', '\\x9F', // x9F
  ];
  const ansi = new RegExp(
    '[\\u001B\\u009B][[\\]()#;?]*' +
    '(?:(?:(?:(?:;[-a-zA-Z\\d\\/\\#&.:=?%@~_]+)*' +
    '|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d\\/\\#&.:=?%@~_]*)*)?' +
    '(?:\\u0007|\\u001B\\u005C|\\u009C))' +
    '|(?:(?:\\d{1,4}(?:;\\d{0,4})*)?' +
    '[\\dA-PR-TZcf-nq-uy=><~]))', 'g',
  );

  function getUserOptions(ctx, isCrossContext) {
    const ret = {
      stylize: ctx.stylize,
      showHidden: ctx.showHidden,
      depth: ctx.depth,
      colors: ctx.colors,
      customInspect: ctx.customInspect,
      showProxy: ctx.showProxy,
      maxArrayLength: ctx.maxArrayLength,
      maxStringLength: ctx.maxStringLength,
      breakLength: ctx.breakLength,
      compact: ctx.compact,
      sorted: ctx.sorted,
      getters: ctx.getters,
      numericSeparator: ctx.numericSeparator,
      ...ctx.userOptions,
    };
    if (isCrossContext) {
      ObjectSetPrototypeOf(ret, null);
      for (const key of ObjectKeys(ret)) {
        if ((typeof ret[key] === 'object' || typeof ret[key] === 'function') &&
            ret[key] !== null) {
          delete ret[key];
        }
      }
      ret.stylize = ObjectSetPrototypeOf((value, flavour) => {
        let stylized;
        try {
          stylized = `${ctx.stylize(value, flavour)}`;
        } catch {
          // Continue regardless of error.
        }
        if (typeof stylized !== 'string') return value;
        return stylized;
      }, null);
    }
    return ret;
  }

  function inspect(value, opts) {
    const ctx = {
      budget: {},
      indentationLvl: 0,
      seen: [],
      currentDepth: 0,
      stylize: stylizeNoColor,
      showHidden: inspectDefaultOptions.showHidden,
      depth: inspectDefaultOptions.depth,
      colors: inspectDefaultOptions.colors,
      customInspect: inspectDefaultOptions.customInspect,
      showProxy: inspectDefaultOptions.showProxy,
      maxArrayLength: inspectDefaultOptions.maxArrayLength,
      maxStringLength: inspectDefaultOptions.maxStringLength,
      breakLength: inspectDefaultOptions.breakLength,
      compact: inspectDefaultOptions.compact,
      sorted: inspectDefaultOptions.sorted,
      getters: inspectDefaultOptions.getters,
      numericSeparator: inspectDefaultOptions.numericSeparator,
    };
    if (arguments.length > 1) {
      if (arguments.length > 2) {
        if (arguments[2] !== undefined) {
          ctx.depth = arguments[2];
        }
        if (arguments.length > 3 && arguments[3] !== undefined) {
          ctx.colors = arguments[3];
        }
      }
      if (typeof opts === 'boolean') {
        ctx.showHidden = opts;
      } else if (opts) {
        const optKeys = ObjectKeys(opts);
        for (let i = 0; i < optKeys.length; ++i) {
          const key = optKeys[i];
          if (
            ObjectPrototypeHasOwnProperty(inspectDefaultOptions, key) ||
            key === 'stylize') {
            ctx[key] = opts[key];
          } else if (ctx.userOptions === undefined) {
            ctx.userOptions = opts;
          }
        }
      }
    }
    if (ctx.colors) ctx.stylize = stylizeWithColor;
    if (ctx.maxArrayLength === null) ctx.maxArrayLength = Infinity;
    if (ctx.maxStringLength === null) ctx.maxStringLength = Infinity;
    return formatValue(ctx, value, 0);
  }
  inspect.custom = customInspectSymbol;
  ObjectDefineProperty(inspect, 'defaultOptions', {
    __proto__: null,
    get() {
      return inspectDefaultOptions;
    },
    set(options) {
      validateObject(options, 'options');
      return ObjectAssign(inspectDefaultOptions, options);
    },
  });
  const defaultFG = 39;
  const defaultBG = 49;
  inspect.colors = {
    __proto__: null,
    reset: [0, 0],
    bold: [1, 22],
    dim: [2, 22],
    italic: [3, 23],
    underline: [4, 24],
    blink: [5, 25],
    inverse: [7, 27],
    hidden: [8, 28],
    strikethrough: [9, 29],
    doubleunderline: [21, 24],
    black: [30, defaultFG],
    red: [31, defaultFG],
    green: [32, defaultFG],
    yellow: [33, defaultFG],
    blue: [34, defaultFG],
    magenta: [35, defaultFG],
    cyan: [36, defaultFG],
    white: [37, defaultFG],
    bgBlack: [40, defaultBG],
    bgRed: [41, defaultBG],
    bgGreen: [42, defaultBG],
    bgYellow: [43, defaultBG],
    bgBlue: [44, defaultBG],
    bgMagenta: [45, defaultBG],
    bgCyan: [46, defaultBG],
    bgWhite: [47, defaultBG],
    framed: [51, 54],
    overlined: [53, 55],
    gray: [90, defaultFG],
    redBright: [91, defaultFG],
    greenBright: [92, defaultFG],
    yellowBright: [93, defaultFG],
    blueBright: [94, defaultFG],
    magentaBright: [95, defaultFG],
    cyanBright: [96, defaultFG],
    whiteBright: [97, defaultFG],
    bgGray: [100, defaultBG],
    bgRedBright: [101, defaultBG],
    bgGreenBright: [102, defaultBG],
    bgYellowBright: [103, defaultBG],
    bgBlueBright: [104, defaultBG],
    bgMagentaBright: [105, defaultBG],
    bgCyanBright: [106, defaultBG],
    bgWhiteBright: [107, defaultBG],
  };
  function defineColorAlias(target, alias) {
    ObjectDefineProperty(inspect.colors, alias, {
      __proto__: null,
      get() {
        return this[target];
      },
      set(value) {
        this[target] = value;
      },
      configurable: true,
      enumerable: false,
    });
  }
  defineColorAlias('gray', 'grey');
  defineColorAlias('gray', 'blackBright');
  defineColorAlias('bgGray', 'bgGrey');
  defineColorAlias('bgGray', 'bgBlackBright');
  defineColorAlias('dim', 'faint');
  defineColorAlias('strikethrough', 'crossedout');
  defineColorAlias('strikethrough', 'strikeThrough');
  defineColorAlias('strikethrough', 'crossedOut');
  defineColorAlias('hidden', 'conceal');
  defineColorAlias('inverse', 'swapColors');
  defineColorAlias('inverse', 'swapcolors');
  defineColorAlias('doubleunderline', 'doubleUnderline');
  inspect.styles = ObjectAssign({ __proto__: null }, {
    special: 'cyan',
    number: 'yellow',
    bigint: 'yellow',
    boolean: 'yellow',
    undefined: 'grey',
    null: 'bold',
    string: 'green',
    symbol: 'green',
    date: 'magenta',
    regexp: 'red',
    module: 'underline',
  });

  function addQuotes(str, quotes) {
    if (quotes === -1) {
      return `"${str}"`;
    }
    if (quotes === -2) {
      return `\`${str}\``;
    }
    return `'${str}'`;
  }
  function escapeFn(str) {
    const charCode = StringPrototypeCharCodeAt(str);
    return meta.length > charCode ? meta[charCode] : `\\u${NumberPrototypeToString(charCode, 16)}`;
  }
  function strEscape(str) {
    let escapeTest = strEscapeSequencesRegExp;
    let escapeReplace = strEscapeSequencesReplacer;
    let singleQuote = 39;
    if (StringPrototypeIncludes(str, "'")) {
      if (!StringPrototypeIncludes(str, '"')) {
        singleQuote = -1;
      } else if (!StringPrototypeIncludes(str, '`') &&
                 !StringPrototypeIncludes(str, '${')) {
        singleQuote = -2;
      }
      if (singleQuote !== 39) {
        escapeTest = strEscapeSequencesRegExpSingle;
        escapeReplace = strEscapeSequencesReplacerSingle;
      }
    }
    if (str.length < 5000 && RegExpPrototypeExec(escapeTest, str) === null)
      return addQuotes(str, singleQuote);
    if (str.length > 100) {
      str = RegExpPrototypeSymbolReplace(escapeReplace, str, escapeFn);
      return addQuotes(str, singleQuote);
    }
    let result = '';
    let last = 0;
    for (let i = 0; i < str.length; i++) {
      const point = StringPrototypeCharCodeAt(str, i);
      if (point === singleQuote ||
          point === 92 ||
          point < 32 ||
          (point > 126 && point < 160)) {
        if (last === i) {
          result += meta[point];
        } else {
          result += `${StringPrototypeSlice(str, last, i)}${meta[point]}`;
        }
        last = i + 1;
      } else if (point >= 0xd800 && point <= 0xdfff) {
        if (point <= 0xdbff && i + 1 < str.length) {
          const point = StringPrototypeCharCodeAt(str, i + 1);
          if (point >= 0xdc00 && point <= 0xdfff) {
            i++;
            continue;
          }
        }
        result += `${StringPrototypeSlice(str, last, i)}\\u${NumberPrototypeToString(point, 16)}`;
        last = i + 1;
      }
    }
    if (last !== str.length) {
      result += StringPrototypeSlice(str, last);
    }
    return addQuotes(result, singleQuote);
  }
  function stylizeWithColor(str, styleType) {
    const style = inspect.styles[styleType];
    if (style !== undefined) {
      const color = inspect.colors[style];
      if (color !== undefined)
        return `\u001b[${color[0]}m${str}\u001b[${color[1]}m`;
    }
    return str;
  }
  function stylizeNoColor(str) {
    return str;
  }
  function getEmptyFormatArray() {
    return [];
  }
  function isInstanceof(object, proto) {
    try {
      return object instanceof proto;
    } catch {
      return false;
    }
  }
  const AggregateErrorPrototype = AggregateError.prototype;
  const wellKnownPrototypes = new SafeMap()
    .set(Array.prototype, { name: 'Array', constructor: Array })
    .set(ArrayBuffer.prototype, { name: 'ArrayBuffer', constructor: ArrayBuffer })
    .set(Function.prototype, { name: 'Function', constructor: Function })
    .set(Map.prototype, { name: 'Map', constructor: Map })
    .set(Set.prototype, { name: 'Set', constructor: Set })
    .set(Object.prototype, { name: 'Object', constructor: Object })
    .set(TypedArray.prototype, { name: 'TypedArray', constructor: TypedArray })
    .set(RegExp.prototype, { name: 'RegExp', constructor: RegExp })
    .set(Date.prototype, { name: 'Date', constructor: Date })
    .set(DataView.prototype, { name: 'DataView', constructor: DataView })
    .set(Error.prototype, { name: 'Error', constructor: Error })
    .set(AggregateErrorPrototype, { name: 'AggregateError', constructor: AggregateError })
    .set(RangeError.prototype, { name: 'RangeError', constructor: RangeError })
    .set(TypeError.prototype, { name: 'TypeError', constructor: TypeError })
    .set(Boolean.prototype, { name: 'Boolean', constructor: Boolean })
    .set(Number.prototype, { name: 'Number', constructor: Number })
    .set(String.prototype, { name: 'String', constructor: String })
    .set(Promise.prototype, { name: 'Promise', constructor: Promise })
    .set(WeakMap.prototype, { name: 'WeakMap', constructor: WeakMap })
    .set(WeakSet.prototype, { name: 'WeakSet', constructor: WeakSet });

  function getConstructorName(obj, ctx, recurseTimes, protoProps) {
    let firstProto;
    const tmp = obj;
    while (obj || isUndetectableObject(obj)) {
      const wellKnownPrototypeNameAndConstructor = wellKnownPrototypes.get(obj);
      if (wellKnownPrototypeNameAndConstructor !== undefined) {
        const { name, constructor } = wellKnownPrototypeNameAndConstructor;
        if (FunctionPrototypeSymbolHasInstance(constructor, tmp)) {
          if (protoProps !== undefined && firstProto !== obj) {
            addPrototypeProperties(
              ctx, tmp, firstProto || tmp, recurseTimes, protoProps);
          }
          return name;
        }
      }
      const descriptor = ObjectGetOwnPropertyDescriptor(obj, 'constructor');
      if (descriptor !== undefined &&
          typeof descriptor.value === 'function' &&
          descriptor.value.name !== '' &&
          isInstanceof(tmp, descriptor.value)) {
        if (protoProps !== undefined &&
           (firstProto !== obj ||
           !getBuiltInObjects().has(descriptor.value.name))) {
          addPrototypeProperties(
            ctx, tmp, firstProto || tmp, recurseTimes, protoProps);
        }
        return String(descriptor.value.name);
      }
      obj = ObjectGetPrototypeOf(obj);
      if (firstProto === undefined) {
        firstProto = obj;
      }
    }
    if (firstProto === null) {
      return null;
    }
    const res = internalGetConstructorName(tmp);
    if (recurseTimes > ctx.depth && ctx.depth !== null) {
      return `${res} <Complex prototype>`;
    }
    const protoConstr = getConstructorName(
      firstProto, ctx, recurseTimes + 1, protoProps);
    if (protoConstr === null) {
      return `${res} <${inspect(firstProto, {
        ...ctx,
        customInspect: false,
        depth: -1,
      })}>`;
    }
    return `${res} <${protoConstr}>`;
  }

  function addPrototypeProperties(ctx, main, obj, recurseTimes, output) {
    let depth = 0;
    let keys;
    let keySet;
    do {
      if (depth !== 0 || main === obj) {
        obj = ObjectGetPrototypeOf(obj);
        if (obj === null) {
          return;
        }
        const descriptor = ObjectGetOwnPropertyDescriptor(obj, 'constructor');
        if (descriptor !== undefined &&
            typeof descriptor.value === 'function' &&
            getBuiltInObjects().has(descriptor.value.name)) {
          return;
        }
      }
      if (depth === 0) {
        keySet = new SafeSet();
      } else {
        ArrayPrototypeForEach(keys, (key) => keySet.add(key));
      }
      keys = ReflectOwnKeys(obj);
      ArrayPrototypePush(ctx.seen, main);
      for (const key of keys) {
        if (key === 'constructor' ||
            ObjectPrototypeHasOwnProperty(main, key) ||
            (depth !== 0 && keySet.has(key))) {
          continue;
        }
        const desc = ObjectGetOwnPropertyDescriptor(obj, key);
        if (typeof desc.value === 'function') {
          continue;
        }
        const value = formatProperty(
          ctx, obj, recurseTimes, key, kObjectType, desc, main);
        if (ctx.colors) {
          ArrayPrototypePush(output, `\u001b[2m${value}\u001b[22m`);
        } else {
          ArrayPrototypePush(output, value);
        }
      }
      ArrayPrototypePop(ctx.seen);
    } while (++depth !== 3);
  }

  function getPrefix(constructor, tag, fallback, size = '') {
    if (constructor === null) {
      if (tag !== '' && fallback !== tag) {
        return `[${fallback}${size}: null prototype] [${tag}] `;
      }
      return `[${fallback}${size}: null prototype] `;
    }
    let result = `${constructor}${size} `;
    if (tag !== '') {
      const position = constructor.indexOf(tag);
      if (position === -1) {
        result += `[${tag}] `;
      } else {
        const endPos = position + tag.length;
        if (endPos !== constructor.length &&
          constructor[endPos] === constructor[endPos].toLowerCase()) {
          result += `[${tag}] `;
        }
      }
    }
    return result;
  }

  function getKeys(value, showHidden) {
    let keys;
    const symbols = ObjectGetOwnPropertySymbols(value);
    if (showHidden) {
      keys = ObjectGetOwnPropertyNames(value);
      if (symbols.length !== 0)
        ArrayPrototypePushApply(keys, symbols);
    } else {
      try {
        keys = ObjectKeys(value);
      } catch (err) {
        assert(isNativeError(err) && err.name === 'ReferenceError' &&
               isModuleNamespaceObject(value));
        keys = ObjectGetOwnPropertyNames(value);
      }
      if (symbols.length !== 0) {
        const filter = (key) => ObjectPrototypePropertyIsEnumerable(value, key);
        ArrayPrototypePushApply(keys, ArrayPrototypeFilter(symbols, filter));
      }
    }
    return keys;
  }

  function getCtxStyle(value, constructor, tag) {
    let fallback = '';
    if (constructor === null) {
      fallback = internalGetConstructorName(value);
      if (fallback === tag) {
        fallback = 'Object';
      }
    }
    return getPrefix(constructor, tag, fallback);
  }

  function formatProxy(ctx, proxy, recurseTimes) {
    if (recurseTimes > ctx.depth && ctx.depth !== null) {
      return ctx.stylize('Proxy [Array]', 'special');
    }
    recurseTimes += 1;
    ctx.indentationLvl += 2;
    const res = [
      formatValue(ctx, proxy[0], recurseTimes),
      formatValue(ctx, proxy[1], recurseTimes),
    ];
    ctx.indentationLvl -= 2;
    return reduceToSingleString(
      ctx, res, '', ['Proxy [', ']'], kArrayExtrasType, recurseTimes);
  }

  function formatValue(ctx, value, recurseTimes, typedArray) {
    if (typeof value !== 'object' &&
        typeof value !== 'function' &&
        !isUndetectableObject(value)) {
      return formatPrimitive(ctx.stylize, value, ctx);
    }
    if (value === null) {
      return ctx.stylize('null', 'null');
    }
    const context = value;
    const proxy = getProxyDetails(value, !!ctx.showProxy);
    if (proxy !== undefined) {
      if (proxy === null || proxy[0] === null) {
        return ctx.stylize('<Revoked Proxy>', 'special');
      }
      if (ctx.showProxy) {
        return formatProxy(ctx, proxy, recurseTimes);
      }
      value = proxy;
    }
    if (ctx.customInspect) {
      const maybeCustom = value[customInspectSymbol];
      if (typeof maybeCustom === 'function' &&
          maybeCustom !== inspect &&
          ObjectGetOwnPropertyDescriptor(value, 'constructor')?.value?.prototype !== value) {
        const depth = ctx.depth === null ? null : ctx.depth - recurseTimes;
        const isCrossContext =
          proxy !== undefined || !FunctionPrototypeSymbolHasInstance(Object, context);
        const ret = FunctionPrototypeCall(
          maybeCustom,
          context,
          depth,
          getUserOptions(ctx, isCrossContext),
          inspect,
        );
        if (ret !== context) {
          if (typeof ret !== 'string') {
            return formatValue(ctx, ret, recurseTimes);
          }
          return StringPrototypeReplaceAll(ret, '\n', `\n${StringPrototypeRepeat(' ', ctx.indentationLvl)}`);
        }
      }
    }
    if (ctx.seen.includes(value)) {
      let index = 1;
      if (ctx.circular === undefined) {
        ctx.circular = new SafeMap();
        ctx.circular.set(value, index);
      } else {
        index = ctx.circular.get(value);
        if (index === undefined) {
          index = ctx.circular.size + 1;
          ctx.circular.set(value, index);
        }
      }
      return ctx.stylize(`[Circular *${index}]`, 'special');
    }
    return formatRaw(ctx, value, recurseTimes, typedArray);
  }

  function formatRaw(ctx, value, recurseTimes, typedArray) {
    let keys;
    let protoProps;
    if (ctx.showHidden && (recurseTimes <= ctx.depth || ctx.depth === null)) {
      protoProps = [];
    }
    const constructor = getConstructorName(value, ctx, recurseTimes, protoProps);
    if (protoProps !== undefined && protoProps.length === 0) {
      protoProps = undefined;
    }
    let tag = '';
    try {
      tag = value[SymbolToStringTag];
    } catch {
      // Ignore error.
    }
    if (typeof tag !== 'string' ||
        (tag !== '' &&
        (ctx.showHidden ?
          ObjectPrototypeHasOwnProperty :
          ObjectPrototypePropertyIsEnumerable)(
          value, SymbolToStringTag,
        ))) {
      tag = '';
    }
    let base = '';
    let formatter = getEmptyFormatArray;
    let braces;
    let noIterator = true;
    let i = 0;
    const filter = ctx.showHidden ? ALL_PROPERTIES : ONLY_ENUMERABLE;
    let extrasType = kObjectType;
    let extraKeys;
    if (SymbolIterator in value || constructor === null) {
      noIterator = false;
      if (ArrayIsArray(value)) {
        const prefix = (constructor !== 'Array' || tag !== '') ?
          getPrefix(constructor, tag, 'Array', `(${value.length})`) :
          '';
        keys = getOwnNonIndexProperties(value, filter);
        braces = [`${prefix}[`, ']'];
        if (value.length === 0 && keys.length === 0 && protoProps === undefined)
          return `${braces[0]}]`;
        extrasType = kArrayExtrasType;
        formatter = formatArray;
      } else if (isSet(value)) {
        const size = SetPrototypeGetSize(value);
        const prefix = getPrefix(constructor, tag, 'Set', `(${size})`);
        keys = getKeys(value, ctx.showHidden);
        formatter = constructor !== null ?
          FunctionPrototypeBind(formatSet, null, value) :
          FunctionPrototypeBind(formatSet, null, SetPrototypeValues(value));
        if (size === 0 && keys.length === 0 && protoProps === undefined)
          return `${prefix}{}`;
        braces = [`${prefix}{`, '}'];
      } else if (isMap(value)) {
        const size = MapPrototypeGetSize(value);
        const prefix = getPrefix(constructor, tag, 'Map', `(${size})`);
        keys = getKeys(value, ctx.showHidden);
        formatter = constructor !== null ?
          FunctionPrototypeBind(formatMap, null, value) :
          FunctionPrototypeBind(formatMap, null, MapPrototypeEntries(value));
        if (size === 0 && keys.length === 0 && protoProps === undefined)
          return `${prefix}{}`;
        braces = [`${prefix}{`, '}'];
      } else if (isTypedArray(value)) {
        keys = getOwnNonIndexProperties(value, filter);
        let bound = value;
        let fallback = '';
        if (constructor === null) {
          fallback = TypedArrayPrototypeGetSymbolToStringTag(value);
          bound = new typedArrayCtors[fallback](value);
        }
        const size = TypedArrayPrototypeGetLength(value);
        const prefix = getPrefix(constructor, tag, fallback, `(${size})`);
        braces = [`${prefix}[`, ']'];
        if (value.length === 0 && keys.length === 0 && !ctx.showHidden)
          return `${braces[0]}]`;
        formatter = FunctionPrototypeBind(formatTypedArray, null, bound, size);
        extrasType = kArrayExtrasType;
        if (ctx.showHidden) {
          extraKeys = ['BYTES_PER_ELEMENT', 'length', 'byteLength', 'byteOffset', 'buffer'];
          typedArray = true;
        }
      } else if (isMapIterator(value)) {
        keys = getKeys(value, ctx.showHidden);
        braces = getIteratorBraces('Map', tag);
        formatter = FunctionPrototypeBind(formatIterator, null, braces);
      } else if (isSetIterator(value)) {
        keys = getKeys(value, ctx.showHidden);
        braces = getIteratorBraces('Set', tag);
        formatter = FunctionPrototypeBind(formatIterator, null, braces);
      } else {
        noIterator = true;
      }
    }
    if (noIterator) {
      keys = getKeys(value, ctx.showHidden);
      braces = ['{', '}'];
      if (typeof value === 'function') {
        base = getFunctionBase(ctx, value, constructor, tag);
        if (keys.length === 0 && protoProps === undefined)
          return ctx.stylize(base, 'special');
      } else if (constructor === 'Object') {
        if (isArgumentsObject(value)) {
          braces[0] = '[Arguments] {';
        } else if (tag !== '') {
          braces[0] = `${getPrefix(constructor, tag, 'Object')}{`;
        }
        if (keys.length === 0 && protoProps === undefined) {
          return `${braces[0]}}`;
        }
      } else if (isRegExp(value)) {
        base = RegExpPrototypeToString(
          constructor !== null ? value : new RegExp(value),
        );
        const prefix = getPrefix(constructor, tag, 'RegExp');
        if (prefix !== 'RegExp ')
          base = `${prefix}${base}`;
        if ((keys.length === 0 && protoProps === undefined) ||
            (recurseTimes > ctx.depth && ctx.depth !== null)) {
          return ctx.stylize(base, 'regexp');
        }
      } else if (isDate(value)) {
        base = NumberIsNaN(DatePrototypeGetTime(value)) ?
          DatePrototypeToString(value) :
          DatePrototypeToISOString(value);
        const prefix = getPrefix(constructor, tag, 'Date');
        if (prefix !== 'Date ')
          base = `${prefix}${base}`;
        if (keys.length === 0 && protoProps === undefined) {
          return ctx.stylize(base, 'date');
        }
      } else if (isError(value)) {
        base = formatError(value, constructor, tag, ctx, keys);
        if (keys.length === 0 && protoProps === undefined)
          return base;
      } else if (isAnyArrayBufferSlot(value)) {
        const arrayType = isArrayBuffer(value) ? 'ArrayBuffer' :
          'SharedArrayBuffer';
        const prefix = getPrefix(constructor, tag, arrayType);
        if (typedArray === undefined) {
          formatter = formatArrayBuffer;
        } else if (keys.length === 0 && protoProps === undefined) {
          return prefix +
                `{ [byteLength]: ${formatNumber(ctx.stylize, value.byteLength, false)} }`;
        }
        braces[0] = `${prefix}{`;
        extraKeys = ['byteLength'];
      } else if (isDataView(value)) {
        braces[0] = `${getPrefix(constructor, tag, 'DataView')}{`;
        extraKeys = ['byteLength', 'byteOffset', 'buffer'];
      } else if (isPromise(value)) {
        braces[0] = `${getPrefix(constructor, tag, 'Promise')}{`;
        formatter = formatPromise;
      } else if (isWeakSet(value)) {
        braces[0] = `${getPrefix(constructor, tag, 'WeakSet')}{`;
        formatter = ctx.showHidden ? formatWeakSet : formatWeakCollection;
      } else if (isWeakMap(value)) {
        braces[0] = `${getPrefix(constructor, tag, 'WeakMap')}{`;
        formatter = ctx.showHidden ? formatWeakMap : formatWeakCollection;
      } else if (isModuleNamespaceObject(value)) {
        braces[0] = `${getPrefix(constructor, tag, 'Module')}{`;
        formatter = FunctionPrototypeBind(formatNamespaceObject, null, keys);
      } else if (isBoxedPrimitive(value)) {
        base = getBoxedBase(value, ctx, keys, constructor, tag);
        if (keys.length === 0 && protoProps === undefined) {
          return base;
        }
      } else if (isURL(value) && !(recurseTimes > ctx.depth && ctx.depth !== null)) {
        base = value.href;
        if (keys.length === 0 && protoProps === undefined) {
          return base;
        }
      } else {
        if (keys.length === 0 && protoProps === undefined) {
          if (isExternal(value)) {
            return ctx.stylize('[External: 0]', 'special');
          }
          return `${getCtxStyle(value, constructor, tag)}{}`;
        }
        braces[0] = `${getCtxStyle(value, constructor, tag)}{`;
      }
    }
    if (recurseTimes > ctx.depth && ctx.depth !== null) {
      let constructorName = StringPrototypeSlice(getCtxStyle(value, constructor, tag), 0, -1);
      if (constructor !== null)
        constructorName = `[${constructorName}]`;
      return ctx.stylize(constructorName, 'special');
    }
    recurseTimes += 1;
    ctx.seen.push(value);
    ctx.currentDepth = recurseTimes;
    let output;
    const indentationLvl = ctx.indentationLvl;
    try {
      /* ONE nesting cap on every lane (S114 (f)): Node gives up where V8's
       * stack runs out; the engine's stacks differ per lane, so the island
       * gives up at the same depth everywhere, with Node's message. */
      if (recurseTimes > kMaxInspectNesting) throw new RangeError('Maximum call stack size exceeded');
      output = formatter(ctx, value, recurseTimes);
      if (extraKeys !== undefined) {
        for (i = 0; i < extraKeys.length; i++) {
          let formatted;
          try {
            formatted = formatExtraProperties(ctx, value, recurseTimes, extraKeys[i], typedArray);
          } catch {
            const tempValue = { [extraKeys[i]]: value.buffer[extraKeys[i]] };
            formatted = formatExtraProperties(ctx, tempValue, recurseTimes, extraKeys[i], typedArray);
          }
          ArrayPrototypePush(output, formatted);
        }
      }
      for (i = 0; i < keys.length; i++) {
        ArrayPrototypePush(
          output,
          formatProperty(ctx, value, recurseTimes, keys[i], extrasType),
        );
      }
      if (protoProps !== undefined) {
        ArrayPrototypePushApply(output, protoProps);
      }
    } catch (err) {
      if (!isStackOverflowError(err)) throw err;
      const constructorName = StringPrototypeSlice(getCtxStyle(value, constructor, tag), 0, -1);
      return handleMaxCallStackSize(ctx, err, constructorName, indentationLvl);
    }
    if (ctx.circular !== undefined) {
      const index = ctx.circular.get(value);
      if (index !== undefined) {
        const reference = ctx.stylize(`<ref *${index}>`, 'special');
        if (ctx.compact !== true) {
          base = base === '' ? reference : `${reference} ${base}`;
        } else {
          braces[0] = `${reference} ${braces[0]}`;
        }
      }
    }
    ctx.seen.pop();
    if (ctx.sorted) {
      const comparator = ctx.sorted === true ? undefined : ctx.sorted;
      if (extrasType === kObjectType) {
        ArrayPrototypeSort(output, comparator);
      } else if (keys.length > 1) {
        const sorted = ArrayPrototypeSort(ArrayPrototypeSlice(output, output.length - keys.length), comparator);
        ArrayPrototypeUnshift(sorted, output, output.length - keys.length, keys.length);
        ReflectApply(ArrayPrototypeSplice, null, sorted);
      }
    }
    const res = reduceToSingleString(
      ctx, output, base, braces, extrasType, recurseTimes, value);
    const budget = ctx.budget[ctx.indentationLvl] || 0;
    const newLength = budget + res.length;
    ctx.budget[ctx.indentationLvl] = newLength;
    if (newLength > 2 ** 27) {
      ctx.depth = -1;
    }
    return res;
  }

  function getIteratorBraces(type, tag) {
    if (tag !== `${type} Iterator`) {
      if (tag !== '')
        tag += '] [';
      tag += `${type} Iterator`;
    }
    return [`[${tag}] {`, '}'];
  }

  function getBoxedBase(value, ctx, keys, constructor, tag) {
    let fn;
    let type;
    if (isNumberObject(value)) {
      fn = NumberPrototypeValueOf;
      type = 'Number';
    } else if (isStringObject(value)) {
      fn = StringPrototypeValueOf;
      type = 'String';
      keys.splice(0, value.length);
    } else if (isBooleanObject(value)) {
      fn = BooleanPrototypeValueOf;
      type = 'Boolean';
    } else if (isBigIntObject(value)) {
      fn = BigIntPrototypeValueOf;
      type = 'BigInt';
    } else {
      fn = SymbolPrototypeValueOf;
      type = 'Symbol';
    }
    let base = `[${type}`;
    if (type !== constructor) {
      if (constructor === null) {
        base += ' (null prototype)';
      } else {
        base += ` (${constructor})`;
      }
    }
    base += `: ${formatPrimitive(stylizeNoColor, fn(value), ctx)}]`;
    if (tag !== '' && tag !== constructor) {
      base += ` [${tag}]`;
    }
    if (keys.length !== 0 || ctx.stylize === stylizeNoColor)
      return base;
    return ctx.stylize(base, StringPrototypeToLowerCase(type));
  }

  function getClassBase(value, constructor, tag) {
    const hasName = ObjectPrototypeHasOwnProperty(value, 'name');
    const name = (hasName && value.name) || '(anonymous)';
    let base = `class ${name}`;
    if (constructor !== 'Function' && constructor !== null) {
      base += ` [${constructor}]`;
    }
    if (tag !== '' && constructor !== tag) {
      base += ` [${tag}]`;
    }
    if (constructor !== null) {
      const superName = ObjectGetPrototypeOf(value).name;
      if (superName) {
        base += ` extends ${superName}`;
      }
    } else {
      base += ' extends [null prototype]';
    }
    return `[${base}]`;
  }

  function getFunctionBase(ctx, value, constructor, tag) {
    const stringified = FunctionPrototypeToString(value);
    if (StringPrototypeStartsWith(stringified, 'class') && stringified[stringified.length - 1] === '}') {
      const slice = StringPrototypeSlice(stringified, 5, -1);
      const bracketIndex = StringPrototypeIndexOf(slice, '{');
      if (bracketIndex !== -1 &&
          (!StringPrototypeIncludes(StringPrototypeSlice(slice, 0, bracketIndex), '(') ||
          RegExpPrototypeExec(classBodyRegExp, RegExpPrototypeSymbolReplace(stripCommentsRegExp, slice)) !== null)
      ) {
        return getClassBase(value, constructor, tag);
      }
    }
    let type = 'Function';
    if (isGeneratorFunction(value)) {
      type = `Generator${type}`;
    }
    if (isAsyncFunction(value)) {
      type = `Async${type}`;
    }
    let base = `[${type}`;
    if (constructor === null) {
      base += ' (null prototype)';
    }
    if (value.name === '') {
      base += ' (anonymous)';
    } else {
      base += `: ${typeof value.name === 'string' ? value.name : formatValue(ctx, value.name)}`;
    }
    base += ']';
    if (constructor !== type && constructor !== null) {
      base += ` ${constructor}`;
    }
    if (tag !== '' && constructor !== tag) {
      base += ` [${tag}]`;
    }
    return base;
  }

  function identicalSequenceRange(a, b) {
    for (let i = 0; i < a.length - 3; i++) {
      const pos = ArrayPrototypeIndexOf(b, a[i]);
      if (pos !== -1) {
        const rest = b.length - pos;
        if (rest > 3) {
          let len = 1;
          const maxLen = MathMin(a.length - i, rest);
          while (maxLen > len && a[i + len] === b[pos + len]) {
            len++;
          }
          if (len > 3) {
            return [len, i];
          }
        }
      }
    }
    return [0, 0];
  }

  function getDuplicateErrorFrameRanges(frames) {
    const result = [];
    const lineToPositions = new SafeMap();
    for (let i = 0; i < frames.length; i++) {
      const positions = lineToPositions.get(frames[i]);
      if (positions === undefined) {
        lineToPositions.set(frames[i], [i]);
      } else {
        positions[positions.length] = i;
      }
    }
    const minimumDuplicateRange = 3;
    if (frames.length - lineToPositions.size <= minimumDuplicateRange) {
      return result;
    }
    for (let i = 0; i < frames.length - minimumDuplicateRange; i++) {
      const positions = lineToPositions.get(frames[i]);
      if (positions.length === 1 || positions[positions.length - 1] === i) {
        continue;
      }
      const current = positions.indexOf(i) + 1;
      if (current === positions.length) {
        continue;
      }
      let range = positions[positions.length - 1] - i;
      if (range < minimumDuplicateRange) {
        continue;
      }
      let extraSteps;
      if (current + 1 < positions.length) {
        let gcdRange = 0;
        for (let j = current; j < positions.length; j++) {
          let distance = positions[j] - i;
          while (distance !== 0) {
            const remainder = gcdRange % distance;
            if (gcdRange !== 0) {
              if (extraSteps === undefined) extraSteps = new SafeSet();
              extraSteps.add(gcdRange);
            }
            gcdRange = distance;
            distance = remainder;
          }
          if (gcdRange === 1) break;
        }
        range = gcdRange;
        if (extraSteps) {
          extraSteps.delete(range);
          extraSteps = [...extraSteps];
        }
      }
      let maxRange = range;
      let maxDuplicates = 0;
      let duplicateRanges = 0;
      for (let nextStart = i + range; /* ignored */ ; nextStart += range) {
        let equalFrames = 0;
        for (let j = 0; j < range; j++) {
          if (frames[i + j] !== frames[nextStart + j]) {
            break;
          }
          equalFrames++;
        }
        if (equalFrames !== range) {
          if (!extraSteps?.length) {
            break;
          }
          if (duplicateRanges !== 0 && maxRange * maxDuplicates < range * duplicateRanges) {
            maxRange = range;
            maxDuplicates = duplicateRanges;
          }
          range = extraSteps.pop();
          nextStart = i;
          duplicateRanges = 0;
          continue;
        }
        duplicateRanges++;
      }
      if (maxDuplicates !== 0 && maxRange * maxDuplicates >= range * duplicateRanges) {
        range = maxRange;
        duplicateRanges = maxDuplicates;
      }
      if (duplicateRanges * range >= 3) {
        result.push(i + range, range, duplicateRanges);
        i += range * (duplicateRanges + 1) - 1;
      }
    }
    return result;
  }

  /* The engine's stack is its frames alone (S108 (i)); V8's opens with
   * the error's own `name: message` line, which Node prints, formatted
   * when the stack is FIRST read (a throwing `name` or `message` getter
   * makes that read throw). An error whose stack is still the engine's
   * own reads here as V8 would have written it: the header recorded at
   * the first read of its `stack` (the stack patch below; this read, if
   * none came before), the engine's frames below (S114). A stack a
   * program assigned is used as it is, as in Node. */
  let engineStackOf = null; // set by the stack patch below
  let engineHeaderOf = null; // likewise
  function getStackString(ctx, error) {
    let stack;
    try {
      stack = error.stack;
    } catch {
      // If stack is getter that throws, we ignore the error.
    }
    const engineStack = engineStackOf !== null ? engineStackOf(error) : undefined;
    /* (V8's stack is an own property, so an error whose prototype was
     * replaced keeps it; the engine's accessor sits on Error.prototype.) */
    if (typeof engineStack === 'string' &&
        (stack === engineStack || (stack === undefined && !ObjectPrototypeHasOwnProperty(error, 'stack')))) {
      let frames = engineStack;
      if (StringPrototypeEndsWith(frames, '\n')) frames = StringPrototypeSlice(frames, 0, -1);
      const head = engineHeaderOf(error); // throws where V8's first read throws
      stack = frames === '' ? head : `${head}\n${frames}`;
    }
    if (stack) {
      if (typeof stack === 'string') {
        return stack;
      }
      ctx.seen.push(error);
      ctx.indentationLvl += 4;
      const result = formatValue(ctx, stack);
      ctx.indentationLvl -= 4;
      ctx.seen.pop();
      return `${ErrorPrototypeToString(error)}\n    ${result}`;
    }
    return ErrorPrototypeToString(error);
  }

  function getStackFrames(ctx, err, stack) {
    const frames = StringPrototypeSplit(stack, '\n');
    let cause;
    try {
      ({ cause } = err);
    } catch {
      // If 'cause' is a getter that throws, ignore it.
    }
    if (cause != null && isError(cause)) {
      const causeStack = getStackString(ctx, cause);
      const causeStackStart = StringPrototypeIndexOf(causeStack, '\n    at');
      if (causeStackStart !== -1) {
        const causeFrames = StringPrototypeSplit(StringPrototypeSlice(causeStack, causeStackStart + 1), '\n');
        const { 0: len, 1: offset } = identicalSequenceRange(frames, causeFrames);
        if (len > 0) {
          const skipped = len - 2;
          const msg = `    ... ${skipped} lines matching cause stack trace ...`;
          frames.splice(offset + 1, skipped, ctx.stylize(msg, 'undefined'));
        }
      }
    }
    if (frames.length > 10) {
      const ranges = getDuplicateErrorFrameRanges(frames);
      for (let i = ranges.length - 3; i >= 0; i -= 3) {
        const offset = ranges[i];
        const length = ranges[i + 1];
        const duplicateRanges = ranges[i + 2];
        const msg = `    ... collapsed ${length * duplicateRanges} duplicate lines ` +
          'matching above ' +
          (duplicateRanges > 1 ?
            `${length} lines ${duplicateRanges} times...` :
            'lines ...');
        frames.splice(offset, length * duplicateRanges, ctx.stylize(msg, 'undefined'));
      }
    }
    return frames;
  }

  function improveStack(stack, constructor, name, tag) {
    let len = name.length;
    if (typeof name !== 'string') {
      stack = StringPrototypeReplace(
        stack,
        `${name}`,
        `${name} [${StringPrototypeSlice(getPrefix(constructor, tag, 'Error'), 0, -1)}]`,
      );
    }
    if (constructor === null ||
        (StringPrototypeEndsWith(name, 'Error') &&
        StringPrototypeStartsWith(stack, name) &&
        (stack.length === len || stack[len] === ':' || stack[len] === '\n'))) {
      let fallback = 'Error';
      if (constructor === null) {
        const start = RegExpPrototypeExec(/^([A-Z][a-z_ A-Z0-9[\]()-]+)(?::|\n {4}at)/, stack) ||
        RegExpPrototypeExec(/^([a-z_A-Z0-9-]*Error)$/, stack);
        fallback = (start?.[1]) || '';
        len = fallback.length;
        fallback ||= 'Error';
      }
      const prefix = StringPrototypeSlice(getPrefix(constructor, tag, fallback), 0, -1);
      if (name !== prefix) {
        if (StringPrototypeIncludes(prefix, name)) {
          if (len === 0) {
            stack = `${prefix}: ${stack}`;
          } else {
            stack = `${prefix}${StringPrototypeSlice(stack, len)}`;
          }
        } else {
          stack = `${prefix} [${name}]${StringPrototypeSlice(stack, len)}`;
        }
      }
    }
    return stack;
  }

  function markNodeModules(ctx, line) {
    let tempLine = '';
    let lastPos = 0;
    let searchFrom = 0;
    while (true) {
      const nodeModulePosition = StringPrototypeIndexOf(line, 'node_modules', searchFrom);
      if (nodeModulePosition === -1) {
        break;
      }
      const separator = line[nodeModulePosition - 1];
      const after = line[nodeModulePosition + 12];
      if ((after !== '/' && after !== '\\') || (separator !== '/' && separator !== '\\')) {
        searchFrom = nodeModulePosition + 1;
        continue;
      }
      const moduleStart = nodeModulePosition + 13;
      tempLine += StringPrototypeSlice(line, lastPos, moduleStart);
      let moduleEnd = StringPrototypeIndexOf(line, separator, moduleStart);
      if (line[moduleStart] === '@') {
        moduleEnd = StringPrototypeIndexOf(line, separator, moduleEnd + 1);
      }
      const nodeModule = StringPrototypeSlice(line, moduleStart, moduleEnd);
      tempLine += ctx.stylize(nodeModule, 'module');
      lastPos = moduleEnd;
      searchFrom = moduleEnd;
    }
    if (lastPos !== 0) {
      line = tempLine + StringPrototypeSlice(line, lastPos);
    }
    return line;
  }

  function formatError(err, constructor, tag, ctx, keys) {
    let message, name, stack;
    try {
      stack = getStackString(ctx, err);
    } catch {
      return ObjectPrototypeToString(err);
    }
    let messageIsGetterThatThrows = false;
    try {
      message = err.message;
    } catch {
      messageIsGetterThatThrows = true;
    }
    let nameIsGetterThatThrows = false;
    try {
      name = err.name;
    } catch {
      nameIsGetterThatThrows = true;
    }
    if (!ctx.showHidden && keys.length !== 0) {
      const index = ArrayPrototypeIndexOf(keys, 'stack');
      if (index !== -1) {
        ArrayPrototypeSplice(keys, index, 1);
      }
      if (!messageIsGetterThatThrows) {
        const index = ArrayPrototypeIndexOf(keys, 'message');
        if (index !== -1 && (typeof message !== 'string' || StringPrototypeIncludes(stack, message))) {
          ArrayPrototypeSplice(keys, index, 1);
        }
      }
      if (!nameIsGetterThatThrows) {
        const index = ArrayPrototypeIndexOf(keys, 'name');
        if (index !== -1 && (typeof name !== 'string' || StringPrototypeIncludes(stack, name))) {
          ArrayPrototypeSplice(keys, index, 1);
        }
      }
    }
    if (name === undefined || name === null) name = 'Error';
    if (ObjectPrototypeHasOwnProperty(err, 'cause') &&
        (keys.length === 0 || !ArrayPrototypeIncludes(keys, 'cause'))) {
      ArrayPrototypePush(keys, 'cause');
    }
    try {
      const errors = err.errors;
      if (ArrayIsArray(errors) && ObjectPrototypeHasOwnProperty(err, 'errors') &&
        (keys.length === 0 || !ArrayPrototypeIncludes(keys, 'errors'))) {
        ArrayPrototypePush(keys, 'errors');
      }
    } catch {
      // If errors is a getter that throws, we ignore the error.
    }
    stack = improveStack(stack, constructor, name, tag);
    let pos = (message && StringPrototypeIndexOf(stack, message)) || -1;
    if (pos !== -1)
      pos += message.length;
    const stackStart = StringPrototypeIndexOf(stack, '\n    at', pos);
    if (stackStart === -1) {
      stack = `[${stack}]`;
    } else {
      let newStack = StringPrototypeSlice(stack, 0, stackStart);
      const stackFramePart = StringPrototypeSlice(stack, stackStart + 1);
      const lines = getStackFrames(ctx, err, stackFramePart);
      if (ctx.colors) {
        /* Node also greys its own core frames and dims the working
         * directory; the engine's frames name neither. */
        for (let line of lines) {
          newStack += '\n';
          line = markNodeModules(ctx, line);
          newStack += line;
        }
      } else {
        newStack += `\n${ArrayPrototypeJoin(lines, '\n')}`;
      }
      stack = newStack;
    }
    if (ctx.indentationLvl !== 0) {
      const indentation = StringPrototypeRepeat(' ', ctx.indentationLvl);
      stack = StringPrototypeReplaceAll(stack, '\n', `\n${indentation}`);
    }
    return stack;
  }

  function groupArrayElements(ctx, output, value) {
    let totalLength = 0;
    let maxLength = 0;
    let i = 0;
    let outputLength = output.length;
    if (ctx.maxArrayLength < output.length) {
      outputLength--;
    }
    const separatorSpace = 2;
    const dataLen = new Array(outputLength);
    for (; i < outputLength; i++) {
      const len = getStringWidth(output[i], ctx.colors);
      dataLen[i] = len;
      totalLength += len + separatorSpace;
      if (maxLength < len)
        maxLength = len;
    }
    const actualMax = maxLength + separatorSpace;
    if (actualMax * 3 + ctx.indentationLvl < ctx.breakLength &&
        (totalLength / actualMax > 5 || maxLength <= 6)) {
      const approxCharHeights = 2.5;
      const averageBias = MathSqrt(actualMax - totalLength / output.length);
      const biasedMax = MathMax(actualMax - 3 - averageBias, 1);
      const columns = MathMin(
        MathRound(
          MathSqrt(
            approxCharHeights * biasedMax * outputLength,
          ) / biasedMax,
        ),
        MathFloor((ctx.breakLength - ctx.indentationLvl) / actualMax),
        ctx.compact * 4,
        15,
      );
      if (columns <= 1) {
        return output;
      }
      const tmp = [];
      const maxLineLength = [];
      for (let i = 0; i < columns; i++) {
        let lineMaxLength = 0;
        for (let j = i; j < output.length; j += columns) {
          if (dataLen[j] > lineMaxLength)
            lineMaxLength = dataLen[j];
        }
        lineMaxLength += separatorSpace;
        maxLineLength[i] = lineMaxLength;
      }
      let order = StringPrototypePadStart;
      if (value !== undefined) {
        for (let i = 0; i < output.length; i++) {
          if (typeof value[i] !== 'number' && typeof value[i] !== 'bigint') {
            order = StringPrototypePadEnd;
            break;
          }
        }
      }
      for (let i = 0; i < outputLength; i += columns) {
        const max = MathMin(i + columns, outputLength);
        let str = '';
        let j = i;
        for (; j < max - 1; j++) {
          const padding = maxLineLength[j - i] + output[j].length - dataLen[j];
          str += order(`${output[j]}, `, padding, ' ');
        }
        if (order === StringPrototypePadStart) {
          const padding = maxLineLength[j - i] +
                          output[j].length -
                          dataLen[j] -
                          separatorSpace;
          str += StringPrototypePadStart(output[j], padding, ' ');
        } else {
          str += output[j];
        }
        ArrayPrototypePush(tmp, str);
      }
      if (ctx.maxArrayLength < output.length) {
        ArrayPrototypePush(tmp, output[outputLength]);
      }
      output = tmp;
    }
    return output;
  }

  function handleMaxCallStackSize(ctx, err, constructorName, indentationLvl) {
    ctx.seen.pop();
    ctx.indentationLvl = indentationLvl;
    return ctx.stylize(
      `[${constructorName}: Inspection interrupted ` +
        'prematurely. Maximum call stack size exceeded.]',
      'special',
    );
  }

  function addNumericSeparator(integerString) {
    let result = '';
    let i = integerString.length;
    assert(i !== 0);
    const start = integerString[0] === '-' ? 1 : 0;
    for (; i >= start + 4; i -= 3) {
      result = `_${StringPrototypeSlice(integerString, i - 3, i)}${result}`;
    }
    return i === integerString.length ?
      integerString :
      `${StringPrototypeSlice(integerString, 0, i)}${result}`;
  }

  function addNumericSeparatorEnd(integerString) {
    let result = '';
    let i = 0;
    for (; i < integerString.length - 3; i += 3) {
      result += `${StringPrototypeSlice(integerString, i, i + 3)}_`;
    }
    return i === 0 ?
      integerString :
      `${result}${StringPrototypeSlice(integerString, i)}`;
  }

  const remainingText = (remaining) => `... ${remaining} more item${remaining > 1 ? 's' : ''}`;

  function formatNumber(fn, number, numericSeparator) {
    if (!numericSeparator) {
      if (ObjectIs(number, -0)) {
        return fn('-0', 'number');
      }
      return fn(`${number}`, 'number');
    }
    const numberString = String(number);
    const integer = MathTrunc(number);
    if (integer === number) {
      if (!NumberIsFinite(number) || StringPrototypeIncludes(numberString, 'e')) {
        return fn(numberString, 'number');
      }
      return fn(addNumericSeparator(numberString), 'number');
    }
    if (NumberIsNaN(number)) {
      return fn(numberString, 'number');
    }
    const decimalIndex = StringPrototypeIndexOf(numberString, '.');
    const integerPart = StringPrototypeSlice(numberString, 0, decimalIndex);
    const fractionalPart = StringPrototypeSlice(numberString, decimalIndex + 1);
    return fn(`${
      addNumericSeparator(integerPart)
    }.${
      addNumericSeparatorEnd(fractionalPart)
    }`, 'number');
  }

  function formatBigInt(fn, bigint, numericSeparator) {
    const string = String(bigint);
    if (!numericSeparator) {
      return fn(`${string}n`, 'bigint');
    }
    return fn(`${addNumericSeparator(string)}n`, 'bigint');
  }

  function formatPrimitive(fn, value, ctx) {
    if (typeof value === 'string') {
      let trailer = '';
      if (value.length > ctx.maxStringLength) {
        const remaining = value.length - ctx.maxStringLength;
        value = StringPrototypeSlice(value, 0, ctx.maxStringLength);
        trailer = `... ${remaining} more character${remaining > 1 ? 's' : ''}`;
      }
      if (ctx.compact !== true &&
          value.length > kMinLineLength &&
          value.length > ctx.breakLength - ctx.indentationLvl - 4) {
        return ArrayPrototypeJoin(
          ArrayPrototypeMap(
            RegExpPrototypeSymbolSplit(/(?<=\n)/, value),
            (line) => fn(strEscape(line), 'string'),
          ),
          ` +\n${StringPrototypeRepeat(' ', ctx.indentationLvl + 2)}`,
        ) + trailer;
      }
      return fn(strEscape(value), 'string') + trailer;
    }
    if (typeof value === 'number')
      return formatNumber(fn, value, ctx.numericSeparator);
    if (typeof value === 'bigint')
      return formatBigInt(fn, value, ctx.numericSeparator);
    if (typeof value === 'boolean')
      return fn(`${value}`, 'boolean');
    if (typeof value === 'undefined')
      return fn('undefined', 'undefined');
    return fn(SymbolPrototypeToString(value), 'symbol');
  }

  function formatNamespaceObject(keys, ctx, value, recurseTimes) {
    const output = new Array(keys.length);
    for (let i = 0; i < keys.length; i++) {
      try {
        output[i] = formatProperty(ctx, value, recurseTimes, keys[i],
                                   kObjectType);
      } catch (err) {
        assert(isNativeError(err) && err.name === 'ReferenceError');
        const tmp = { [keys[i]]: '' };
        output[i] = formatProperty(ctx, tmp, recurseTimes, keys[i], kObjectType);
        const pos = StringPrototypeLastIndexOf(output[i], ' ');
        output[i] = StringPrototypeSlice(output[i], 0, pos + 1) +
                    ctx.stylize('<uninitialized>', 'special');
      }
    }
    keys.length = 0;
    return output;
  }

  function formatSpecialArray(ctx, value, recurseTimes, maxLength, output, i) {
    const keys = ObjectKeys(value);
    let index = i;
    for (; i < keys.length && output.length < maxLength; i++) {
      const key = keys[i];
      const tmp = +key;
      if (tmp > 2 ** 32 - 2) {
        break;
      }
      if (`${index}` !== key) {
        if (RegExpPrototypeExec(numberRegExp, key) === null) {
          break;
        }
        const emptyItems = tmp - index;
        const ending = emptyItems > 1 ? 's' : '';
        const message = `<${emptyItems} empty item${ending}>`;
        ArrayPrototypePush(output, ctx.stylize(message, 'undefined'));
        index = tmp;
        if (output.length === maxLength) {
          break;
        }
      }
      ArrayPrototypePush(output, formatProperty(ctx, value, recurseTimes, key, kArrayType));
      index++;
    }
    const remaining = value.length - index;
    if (output.length !== maxLength) {
      if (remaining > 0) {
        const ending = remaining > 1 ? 's' : '';
        const message = `<${remaining} empty item${ending}>`;
        ArrayPrototypePush(output, ctx.stylize(message, 'undefined'));
      }
    } else if (remaining > 0) {
      ArrayPrototypePush(output, remainingText(remaining));
    }
    return output;
  }

  /* buffer.js hexSlice: two lowercase hex digits a byte. */
  const hexSlice = (u8, start, end) => {
    let s = '';
    for (let i = start; i < end; i++) {
      const b = u8[i];
      s += HEX_LOWER[b >> 4] + HEX_LOWER[b & 15];
    }
    return s;
  };
  const HEX_LOWER = '0123456789abcdef';
  function formatArrayBuffer(ctx, value) {
    let buffer;
    try {
      buffer = new Uint8Array(value);
    } catch {
      return [ctx.stylize('(detached)', 'special')];
    }
    const rawString = hexSlice(buffer, 0, MathMin(ctx.maxArrayLength, buffer.length));
    let str = '';
    let i = 0;
    for (; i < rawString.length - 2; i += 2) {
      str += `${rawString[i]}${rawString[i + 1]} `;
    }
    if (rawString.length > 0) {
      str += `${rawString[i]}${rawString[i + 1]}`;
    }
    const remaining = buffer.length - ctx.maxArrayLength;
    if (remaining > 0)
      str += ` ... ${remaining} more byte${remaining > 1 ? 's' : ''}`;
    return [`${ctx.stylize('[Uint8Contents]', 'special')}: <${str}>`];
  }

  function formatArray(ctx, value, recurseTimes) {
    const valLen = value.length;
    const len = MathMin(MathMax(0, ctx.maxArrayLength), valLen);
    const remaining = valLen - len;
    const output = [];
    for (let i = 0; i < len; i++) {
      const desc = ObjectGetOwnPropertyDescriptor(value, i);
      if (desc === undefined) {
        return formatSpecialArray(ctx, value, recurseTimes, len, output, i);
      }
      ArrayPrototypePush(output, formatProperty(ctx, value, recurseTimes, i, kArrayType, desc));
    }
    if (remaining > 0) {
      ArrayPrototypePush(output, remainingText(remaining));
    }
    return output;
  }

  function formatTypedArray(value, length, ctx) {
    const maxLength = MathMin(MathMax(0, ctx.maxArrayLength), length);
    const remaining = value.length - maxLength;
    const output = new Array(maxLength);
    const elementFormatter = value.length > 0 && typeof value[0] === 'number' ?
      formatNumber :
      formatBigInt;
    for (let i = 0; i < maxLength; ++i) {
      output[i] = elementFormatter(ctx.stylize, value[i], ctx.numericSeparator);
    }
    if (remaining > 0) {
      output[maxLength] = remainingText(remaining);
    }
    return output;
  }

  function formatSet(value, ctx, ignored, recurseTimes) {
    const length = value.size;
    const maxLength = MathMin(MathMax(0, ctx.maxArrayLength), length);
    const remaining = length - maxLength;
    const output = [];
    ctx.indentationLvl += 2;
    let i = 0;
    for (const v of value) {
      if (i >= maxLength) break;
      ArrayPrototypePush(output, formatValue(ctx, v, recurseTimes));
      i++;
    }
    if (remaining > 0) {
      ArrayPrototypePush(output, remainingText(remaining));
    }
    ctx.indentationLvl -= 2;
    return output;
  }

  function formatMap(value, ctx, ignored, recurseTimes) {
    const length = value.size;
    const maxLength = MathMin(MathMax(0, ctx.maxArrayLength), length);
    const remaining = length - maxLength;
    const output = [];
    ctx.indentationLvl += 2;
    let i = 0;
    for (const { 0: k, 1: v } of value) {
      if (i >= maxLength) break;
      ArrayPrototypePush(
        output,
        `${formatValue(ctx, k, recurseTimes)} => ${formatValue(ctx, v, recurseTimes)}`,
      );
      i++;
    }
    if (remaining > 0) {
      ArrayPrototypePush(output, remainingText(remaining));
    }
    ctx.indentationLvl -= 2;
    return output;
  }

  function formatSetIterInner(ctx, recurseTimes, entries, state) {
    const maxArrayLength = MathMax(ctx.maxArrayLength, 0);
    const maxLength = MathMin(maxArrayLength, entries.length);
    const output = new Array(maxLength);
    ctx.indentationLvl += 2;
    for (let i = 0; i < maxLength; i++) {
      output[i] = formatValue(ctx, entries[i], recurseTimes);
    }
    ctx.indentationLvl -= 2;
    if (state === kWeak && !ctx.sorted) {
      ArrayPrototypeSort(output);
    }
    const remaining = entries.length - maxLength;
    if (remaining > 0) {
      ArrayPrototypePush(output, remainingText(remaining));
    }
    return output;
  }

  function formatMapIterInner(ctx, recurseTimes, entries, state) {
    const maxArrayLength = MathMax(ctx.maxArrayLength, 0);
    const len = entries.length / 2;
    const remaining = len - maxArrayLength;
    const maxLength = MathMin(maxArrayLength, len);
    const output = new Array(maxLength);
    let i = 0;
    ctx.indentationLvl += 2;
    if (state === kWeak) {
      for (; i < maxLength; i++) {
        const pos = i * 2;
        output[i] =
          `${formatValue(ctx, entries[pos], recurseTimes)} => ${formatValue(ctx, entries[pos + 1], recurseTimes)}`;
      }
      if (!ctx.sorted)
        ArrayPrototypeSort(output);
    } else {
      for (; i < maxLength; i++) {
        const pos = i * 2;
        const res = [
          formatValue(ctx, entries[pos], recurseTimes),
          formatValue(ctx, entries[pos + 1], recurseTimes),
        ];
        output[i] = reduceToSingleString(
          ctx, res, '', ['[', ']'], kArrayExtrasType, recurseTimes);
      }
    }
    ctx.indentationLvl -= 2;
    if (remaining > 0) {
      ArrayPrototypePush(output, remainingText(remaining));
    }
    return output;
  }

  function formatWeakCollection(ctx) {
    return [ctx.stylize('<items unknown>', 'special')];
  }

  function formatWeakSet(ctx, value, recurseTimes) {
    const entries = previewEntries(value);
    return formatSetIterInner(ctx, recurseTimes, entries, kWeak);
  }

  function formatWeakMap(ctx, value, recurseTimes) {
    const entries = previewEntries(value);
    return formatMapIterInner(ctx, recurseTimes, entries, kWeak);
  }

  function formatIterator(braces, ctx, value, recurseTimes) {
    const { 0: entries, 1: isKeyValue } = previewEntries(value, true);
    if (isKeyValue) {
      braces[0] = RegExpPrototypeSymbolReplace(/ Iterator] {$/, braces[0], ' Entries] {');
      return formatMapIterInner(ctx, recurseTimes, entries, kMapEntries);
    }
    return formatSetIterInner(ctx, recurseTimes, entries, kIterator);
  }

  function formatPromise(ctx, value, recurseTimes) {
    let output;
    const { 0: state, 1: result } = getPromiseDetails(value);
    if (state === kPending) {
      output = [ctx.stylize('<pending>', 'special')];
    } else {
      ctx.indentationLvl += 2;
      const str = formatValue(ctx, result, recurseTimes);
      ctx.indentationLvl -= 2;
      output = [
        state === kRejected ?
          `${ctx.stylize('<rejected>', 'special')} ${str}` :
          str,
      ];
    }
    return output;
  }

  function formatExtraProperties(ctx, value, recurseTimes, key, typedArray) {
    ctx.indentationLvl += 2;
    const str = formatValue(ctx, value[key], recurseTimes, typedArray);
    ctx.indentationLvl -= 2;
    const name = ctx.stylize(`[${key}]`, 'string');
    return `${name}: ${str}`;
  }

  function formatProperty(ctx, value, recurseTimes, key, type, desc,
                          original = value) {
    let name, str;
    let extra = ' ';
    if (desc === undefined || desc === null) desc = ObjectGetOwnPropertyDescriptor(value, key);
    if (desc.value !== undefined) {
      const diff = (ctx.compact !== true || type !== kObjectType) ? 2 : 3;
      ctx.indentationLvl += diff;
      str = formatValue(ctx, desc.value, recurseTimes);
      if (diff === 3 && ctx.breakLength < getStringWidth(str, ctx.colors)) {
        extra = `\n${StringPrototypeRepeat(' ', ctx.indentationLvl)}`;
      }
      ctx.indentationLvl -= diff;
    } else if (desc.get !== undefined) {
      const label = desc.set !== undefined ? 'Getter/Setter' : 'Getter';
      const s = ctx.stylize;
      const sp = 'special';
      if (ctx.getters && (ctx.getters === true ||
            (ctx.getters === 'get' && desc.set === undefined) ||
            (ctx.getters === 'set' && desc.set !== undefined))) {
        ctx.indentationLvl += 2;
        try {
          const tmp = FunctionPrototypeCall(desc.get, original);
          if (tmp === null) {
            str = `${s(`[${label}:`, sp)} ${s('null', 'null')}${s(']', sp)}`;
          } else if (typeof tmp === 'object') {
            str = `${s(`[${label}]`, sp)} ${formatValue(ctx, tmp, recurseTimes)}`;
          } else {
            const primitive = formatPrimitive(s, tmp, ctx);
            str = `${s(`[${label}:`, sp)} ${primitive}${s(']', sp)}`;
          }
        } catch (err) {
          const message = `<Inspection threw (${formatValue(ctx, err, recurseTimes)})>`;
          str = `${s(`[${label}:`, sp)} ${message}${s(']', sp)}`;
        }
        ctx.indentationLvl -= 2;
      } else {
        str = ctx.stylize(`[${label}]`, sp);
      }
    } else if (desc.set !== undefined) {
      str = ctx.stylize('[Setter]', 'special');
    } else {
      str = ctx.stylize('undefined', 'undefined');
    }
    if (type === kArrayType) {
      return str;
    }
    if (typeof key === 'symbol') {
      const tmp = RegExpPrototypeSymbolReplace(
        strEscapeSequencesReplacer,
        SymbolPrototypeToString(key),
        escapeFn,
      );
      name = ctx.stylize(tmp, 'symbol');
    } else if (RegExpPrototypeExec(keyStrRegExp, key) !== null) {
      name = key === '__proto__' ? "['__proto__']" : ctx.stylize(key, 'name');
    } else {
      name = ctx.stylize(strEscape(key), 'string');
    }
    if (desc.enumerable === false) {
      name = `[${name}]`;
    }
    return `${name}:${extra}${str}`;
  }

  function isBelowBreakLength(ctx, output, start, base) {
    let totalLength = output.length + start;
    if (totalLength + output.length > ctx.breakLength)
      return false;
    for (let i = 0; i < output.length; i++) {
      if (ctx.colors) {
        totalLength += removeColors(output[i]).length;
      } else {
        totalLength += output[i].length;
      }
      if (totalLength > ctx.breakLength) {
        return false;
      }
    }
    return base === '' || !StringPrototypeIncludes(base, '\n');
  }

  function reduceToSingleString(
    ctx, output, base, braces, extrasType, recurseTimes, value) {
    if (ctx.compact !== true) {
      if (typeof ctx.compact === 'number' && ctx.compact >= 1) {
        const entries = output.length;
        if (extrasType === kArrayExtrasType && entries > 6) {
          output = groupArrayElements(ctx, output, value);
        }
        if (ctx.currentDepth - recurseTimes < ctx.compact &&
            entries === output.length) {
          const start = output.length + ctx.indentationLvl +
                        braces[0].length + base.length + 10;
          if (isBelowBreakLength(ctx, output, start, base)) {
            const joinedOutput = join(output, ', ');
            if (!StringPrototypeIncludes(joinedOutput, '\n')) {
              return `${base ? `${base} ` : ''}${braces[0]} ${joinedOutput}` +
                ` ${braces[1]}`;
            }
          }
        }
      }
      const indentation = `\n${StringPrototypeRepeat(' ', ctx.indentationLvl)}`;
      return `${base ? `${base} ` : ''}${braces[0]}${indentation}  ` +
        `${join(output, `,${indentation}  `)}${indentation}${braces[1]}`;
    }
    if (isBelowBreakLength(ctx, output, 0, base)) {
      return `${braces[0]}${base ? ` ${base}` : ''} ${join(output, ', ')} ` +
        braces[1];
    }
    const indentation = StringPrototypeRepeat(' ', ctx.indentationLvl);
    const ln = base === '' && braces[0].length === 1 ?
      ' ' : `${base ? ` ${base}` : ''}\n${indentation}  `;
    return `${braces[0]}${ln}${join(output, `,\n${indentation}  `)} ${braces[1]}`;
  }

  function hasBuiltInToString(value) {
    const getFullProxy = false;
    const proxyTarget = getProxyDetails(value, getFullProxy);
    if (proxyTarget !== undefined) {
      if (proxyTarget === null) {
        return true;
      }
      value = proxyTarget;
    }
    let hasOwnToString = ObjectPrototypeHasOwnProperty;
    let hasOwnToPrimitive = ObjectPrototypeHasOwnProperty;
    if (typeof value.toString !== 'function') {
      if (typeof value[SymbolToPrimitive] !== 'function') {
        return true;
      } else if (ObjectPrototypeHasOwnProperty(value, SymbolToPrimitive)) {
        return false;
      }
      hasOwnToString = returnFalse;
    } else if (ObjectPrototypeHasOwnProperty(value, 'toString')) {
      return false;
    } else if (typeof value[SymbolToPrimitive] !== 'function') {
      hasOwnToPrimitive = returnFalse;
    } else if (ObjectPrototypeHasOwnProperty(value, SymbolToPrimitive)) {
      return false;
    }
    let pointer = value;
    do {
      pointer = ObjectGetPrototypeOf(pointer);
    } while (!hasOwnToString(pointer, 'toString') &&
      !hasOwnToPrimitive(pointer, SymbolToPrimitive));
    const descriptor = ObjectGetOwnPropertyDescriptor(pointer, 'constructor');
    return descriptor !== undefined &&
      typeof descriptor.value === 'function' &&
      getBuiltInObjects().has(descriptor.value.name);
  }

  function returnFalse() {
    return false;
  }

  const firstErrorLine = (error) => StringPrototypeSplit(error.message, '\n', 1)[0];
  let CIRCULAR_ERROR_MESSAGE;
  function tryStringify(arg) {
    try {
      return JSONStringify(arg);
    } catch (err) {
      if (!CIRCULAR_ERROR_MESSAGE) {
        try {
          const a = {};
          a.a = a;
          JSONStringify(a);
        } catch (circularError) {
          CIRCULAR_ERROR_MESSAGE = firstErrorLine(circularError);
        }
      }
      if (err.name === 'TypeError' &&
          firstErrorLine(err) === CIRCULAR_ERROR_MESSAGE) {
        return '[Circular]';
      }
      throw err;
    }
  }

  function format(...args) {
    return formatWithOptionsInternal(undefined, args);
  }

  function formatWithOptions(inspectOptions, ...args) {
    validateObject(inspectOptions, 'inspectOptions', true);
    return formatWithOptionsInternal(inspectOptions, args);
  }

  function formatNumberNoColor(number, options) {
    return formatNumber(
      stylizeNoColor,
      number,
      options?.numericSeparator ?? inspectDefaultOptions.numericSeparator,
    );
  }

  function formatBigIntNoColor(bigint, options) {
    return formatBigInt(
      stylizeNoColor,
      bigint,
      options?.numericSeparator ?? inspectDefaultOptions.numericSeparator,
    );
  }

  function formatWithOptionsInternal(inspectOptions, args) {
    const first = args[0];
    let a = 0;
    let str = '';
    let join = '';
    if (typeof first === 'string') {
      if (args.length === 1) {
        return first;
      }
      let tempStr;
      let lastPos = 0;
      for (let i = 0; i < first.length - 1; i++) {
        if (StringPrototypeCharCodeAt(first, i) === 37) { // '%'
          const nextChar = StringPrototypeCharCodeAt(first, ++i);
          if (a + 1 !== args.length) {
            switch (nextChar) {
              case 115: { // 's'
                const tempArg = args[++a];
                if (typeof tempArg === 'number') {
                  tempStr = formatNumberNoColor(tempArg, inspectOptions);
                } else if (typeof tempArg === 'bigint') {
                  tempStr = formatBigIntNoColor(tempArg, inspectOptions);
                } else if (typeof tempArg !== 'object' ||
                           tempArg === null ||
                           !hasBuiltInToString(tempArg)) {
                  tempStr = String(tempArg);
                } else {
                  tempStr = inspect(tempArg, {
                    ...inspectOptions,
                    compact: 3,
                    colors: false,
                    depth: 0,
                  });
                }
                break;
              }
              case 106: // 'j'
                tempStr = tryStringify(args[++a]);
                break;
              case 100: { // 'd'
                const tempNum = args[++a];
                if (typeof tempNum === 'bigint') {
                  tempStr = formatBigIntNoColor(tempNum, inspectOptions);
                } else if (typeof tempNum === 'symbol') {
                  tempStr = 'NaN';
                } else {
                  tempStr = formatNumberNoColor(Number(tempNum), inspectOptions);
                }
                break;
              }
              case 79: // 'O'
                tempStr = inspect(args[++a], inspectOptions);
                break;
              case 111: // 'o'
                tempStr = inspect(args[++a], {
                  ...inspectOptions,
                  showHidden: true,
                  showProxy: true,
                  depth: 4,
                });
                break;
              case 105: { // 'i'
                const tempInteger = args[++a];
                if (typeof tempInteger === 'bigint') {
                  tempStr = formatBigIntNoColor(tempInteger, inspectOptions);
                } else if (typeof tempInteger === 'symbol') {
                  tempStr = 'NaN';
                } else {
                  tempStr = formatNumberNoColor(
                    NumberParseInt(tempInteger), inspectOptions);
                }
                break;
              }
              case 102: { // 'f'
                const tempFloat = args[++a];
                if (typeof tempFloat === 'symbol') {
                  tempStr = 'NaN';
                } else {
                  tempStr = formatNumberNoColor(
                    NumberParseFloat(tempFloat), inspectOptions);
                }
                break;
              }
              case 99: // 'c'
                a += 1;
                tempStr = '';
                break;
              case 37: // '%'
                str += StringPrototypeSlice(first, lastPos, i);
                lastPos = i + 1;
                continue;
              default: // Any other character is not a correct placeholder
                continue;
            }
            if (lastPos !== i - 1) {
              str += StringPrototypeSlice(first, lastPos, i - 1);
            }
            str += tempStr;
            lastPos = i + 1;
          } else if (nextChar === 37) {
            str += StringPrototypeSlice(first, lastPos, i);
            lastPos = i + 1;
          }
        }
      }
      if (lastPos !== 0) {
        a++;
        join = ' ';
        if (lastPos < first.length) {
          str += StringPrototypeSlice(first, lastPos);
        }
      }
    }
    while (a < args.length) {
      const value = args[a];
      str += join;
      str += typeof value !== 'string' ? inspect(value, inspectOptions) : value;
      join = ' ';
      a++;
    }
    return str;
  }

  function stripVTControlCharacters(str) {
    validateString(str, 'str');
    if (StringPrototypeIndexOf(str, '\u001B') === -1 &&
        StringPrototypeIndexOf(str, '\u009B') === -1)
      return str;
    return RegExpPrototypeSymbolReplace(ansi, str, '');
  }

  /* isURL: the island's URL class (installed by the native lanes' URL
   * boot, which registers it here). */
  let URLClass = null;
  internals.setURLClass = (C) => { URLClass = C; };
  const isURL = (value) => URLClass !== null && typeof value.href === 'string' && isInstanceof(value, URLClass);
  /* What the npm bootstrap's node:util serves. */
  internals.inspect = inspect;
  internals.format = format;
  internals.formatWithOptions = formatWithOptions;
  internals.stripVTControlCharacters = stripVTControlCharacters;
  internals.getStringWidth = getStringWidth;
  const formatArgs = (args) => formatWithOptionsInternal(undefined, args);

  /* console: Node's Console (lib/internal/console/constructor.js) over
   * the inspector above — log/info/debug/dirxml (stdout) and warn/error
   * (stderr) are formatWithOptions with no color options (Node's choice
   * for a stream that is not a TTY; S114), dir is inspect with
   * customInspect off, table is Node's table over cli_table.js. Writes go
   * to the REAL fds (same stdio as static console output) with Node's
   * group indentation, lone surrogates as U+FFFD (Node writes UTF-8). The
   * methods that are nothing but wall-clock time or V8's stack (time,
   * timeEnd, timeLog, trace), the ones that need Node's classes
   * (Console, context, createTask), and countReset of a label never
   * counted (Node reports it through a process warning) throw a named
   * Error. */
  /* lib/internal/cli_table.js. */
  const tableChars = {
    middleMiddle: '\u2500',
    rowMiddle: '\u253c',
    topRight: '\u2510',
    topLeft: '\u250c',
    leftMiddle: '\u251c',
    topMiddle: '\u252c',
    bottomRight: '\u2518',
    bottomLeft: '\u2514',
    bottomMiddle: '\u2534',
    rightMiddle: '\u2524',
    left: '\u2502 ',
    right: ' \u2502',
    middle: ' \u2502 ',
  };
  const renderRow = (row, columnWidths) => {
    let out = tableChars.left;
    for (let i = 0; i < row.length; i++) {
      const cell = row[i];
      const len = getStringWidth(cell);
      const needed = (columnWidths[i] - len);
      out += cell + StringPrototypeRepeat(' ', MathCeil(needed));
      if (i !== row.length - 1)
        out += tableChars.middle;
    }
    out += tableChars.right;
    return out;
  };
  const cliTable = (head, columns) => {
    const rows = [];
    const columnWidths = ArrayPrototypeMap(head, (h) => getStringWidth(h));
    const longestColumn = MathMaxApply(ArrayPrototypeMap(columns, (a) =>
      a.length));
    for (let i = 0; i < head.length; i++) {
      const column = columns[i];
      for (let j = 0; j < longestColumn; j++) {
        if (rows[j] === undefined)
          rows[j] = [];
        const value = rows[j][i] =
          ObjectPrototypeHasOwnProperty(column, j) ? column[j] : '';
        const width = columnWidths[i] || 0;
        const counted = getStringWidth(value);
        columnWidths[i] = MathMax(width, counted);
      }
    }
    const divider = ArrayPrototypeMap(columnWidths, (i) =>
      StringPrototypeRepeat(tableChars.middleMiddle, i + 2));
    let result = tableChars.topLeft +
                 ArrayPrototypeJoin(divider, tableChars.topMiddle) +
                 tableChars.topRight + '\n' +
                 renderRow(head, columnWidths) + '\n' +
                 tableChars.leftMiddle +
                 ArrayPrototypeJoin(divider, tableChars.rowMiddle) +
                 tableChars.rightMiddle + '\n';
    for (const row of rows)
      result += `${renderRow(row, columnWidths)}\n`;
    result += tableChars.bottomLeft +
              ArrayPrototypeJoin(divider, tableChars.bottomMiddle) +
              tableChars.bottomRight;
    return result;
  };
  let groupIndent = '';
  const consoleWrite = (fd, s) => {
    if (groupIndent.length !== 0) {
      if (s.includes('\n')) s = s.replace(/\n/g, `\n${groupIndent}`);
      s = groupIndent + s;
    }
    host.write(fd, (s + '\n').toWellFormed());
  };
  const consoleFence = (name) => function () {
    throw new Error(`console.${name} inside the scriptc island is not supported yet (SEMANTICS.md S108)`);
  };
  const counts = new Map();
  const consoleObj = {
    log(...args) { consoleWrite(1, formatArgs(args)); },
    info(...args) { consoleWrite(1, formatArgs(args)); },
    debug(...args) { consoleWrite(1, formatArgs(args)); },
    warn(...args) { consoleWrite(2, formatArgs(args)); },
    error(...args) { consoleWrite(2, formatArgs(args)); },
    dir(object, options) {
      consoleWrite(1, inspect(object, { customInspect: false, ...options }));
    },
    time: consoleFence('time'),
    timeEnd: consoleFence('timeEnd'),
    timeLog: consoleFence('timeLog'),
    /* Node prints "Trace: <message>" and the V8 stack; the engine's stack
     * is QuickJS's, so trace is fenced rather than printed differently. */
    trace: consoleFence('trace'),
    assert(expression, ...args) {
      if (!expression) {
        if (args.length && typeof args[0] === 'string') args[0] = `Assertion failed: ${args[0]}`;
        else args.unshift('Assertion failed');
        consoleWrite(2, formatArgs(args));
      }
    },
    clear() {},
    count(label = 'default') {
      label = `${label}`;
      let n = counts.get(label);
      n = n === undefined ? 1 : n + 1;
      counts.set(label, n);
      consoleWrite(1, `${label}: ${n}`);
    },
    countReset(label = 'default') {
      label = `${label}`;
      if (!counts.has(label)) throw consoleFence('countReset (of a label never counted)')();
      counts.set(label, 0);
    },
    group(...data) {
      if (data.length > 0) consoleWrite(1, formatArgs(data));
      groupIndent += '  ';
    },
    groupEnd() { groupIndent = groupIndent.slice(0, groupIndent.length - 2); },
    table(tabularData, properties) {
      if (properties !== undefined && !ArrayIsArray(properties)) throw errInvalidArgType('properties', 'Array', properties);
      if (tabularData === null || typeof tabularData !== 'object') return consoleObj.log(tabularData);
      const final = (k, v) => consoleObj.log(cliTable(k, v));
      const _inspect = (v) => {
        const depth = v !== null &&
                      typeof v === 'object' &&
                      !(ArrayIsArray(v) || isTypedArray(v)) &&
                      ObjectKeys(v).length > 2 ? -1 : 0;
        return inspect(v, { depth, maxArrayLength: 3, breakLength: Infinity });
      };
      const getIndexArray = (length) => ArrayFrom({ length }, (_, i) => _inspect(i));
      const mapIter = isMapIterator(tabularData);
      let isKeyValue = false;
      let i = 0;
      if (mapIter) {
        const res = previewEntries(tabularData, true);
        tabularData = res[0];
        isKeyValue = res[1];
      }
      if (isKeyValue || isMap(tabularData)) {
        const keys = [];
        const values = [];
        let length = 0;
        if (mapIter) {
          for (; i < tabularData.length / 2; ++i) {
            ArrayPrototypePush(keys, _inspect(tabularData[i * 2]));
            ArrayPrototypePush(values, _inspect(tabularData[i * 2 + 1]));
            length++;
          }
        } else {
          for (const { 0: k, 1: v } of tabularData) {
            ArrayPrototypePush(keys, _inspect(k));
            ArrayPrototypePush(values, _inspect(v));
            length++;
          }
        }
        return final(['(iteration index)', 'Key', 'Values'], [getIndexArray(length), keys, values]);
      }
      const setIter = isSetIterator(tabularData);
      if (setIter) tabularData = previewEntries(tabularData);
      const setlike = setIter || mapIter || isSet(tabularData);
      if (setlike) {
        const values = [];
        let length = 0;
        for (const v of tabularData) {
          ArrayPrototypePush(values, _inspect(v));
          length++;
        }
        return final(['(iteration index)', 'Values'], [getIndexArray(length), values]);
      }
      const map = { __proto__: null };
      let hasPrimitives = false;
      const valuesKeyArray = [];
      const indexKeyArray = ObjectKeys(tabularData);
      for (; i < indexKeyArray.length; i++) {
        const item = tabularData[indexKeyArray[i]];
        const primitive = item === null ||
            (typeof item !== 'function' && typeof item !== 'object');
        if (properties === undefined && primitive) {
          hasPrimitives = true;
          valuesKeyArray[i] = _inspect(item);
        } else {
          const keys = properties || ObjectKeys(item);
          for (const key of keys) {
            if (map[key] === undefined || map[key] === null) map[key] = [];
            if ((primitive && properties) ||
                 !ObjectPrototypeHasOwnProperty(item, key))
              map[key][i] = '';
            else
              map[key][i] = _inspect(item[key]);
          }
        }
      }
      const keys = ObjectKeys(map);
      const values = ObjectValues(map);
      if (hasPrimitives) {
        ArrayPrototypePush(keys, 'Values');
        ArrayPrototypePush(values, valuesKeyArray);
      }
      ArrayPrototypeUnshift(keys, '(index)');
      ArrayPrototypeUnshift(values, indexKeyArray);
      return final(keys, values);
    },
    dirxml(...args) { consoleWrite(1, formatArgs(args)); },
    groupCollapsed(...data) {
      if (data.length > 0) consoleWrite(1, formatArgs(data));
      groupIndent += '  ';
    },
    Console: consoleFence('Console'),
    profile() {},
    profileEnd() {},
    timeStamp() {},
    context: consoleFence('context'),
    createTask: consoleFence('createTask'),
  };
  Object.defineProperty(consoleObj, Symbol.toStringTag, { value: 'console', writable: false, enumerable: false, configurable: true });

  /* Date#toString/#toTimeString: the engine stops at the GMT offset
   * ("Tue Jan 02 2024 00:00:00 GMT+0000"); Node/V8 appends the zone's
   * long name ("(Coordinated Universal Time)"). The suffix rides
   * host.tzname(ms) — Node's name for the zone at that instant
   * (native: scr_zone_names.h; the wasm engine asks the host through
   * tzCall — SEMANTICS.md S113). */
  {
    const dToString = Date.prototype.toString;
    const dToTimeString = Date.prototype.toTimeString;
    const dGetTime = Date.prototype.getTime;
    const withZone = (self, base) => {
      if (base === 'Invalid Date') return base;
      const name = host.tzname(dGetTime.call(self));
      return name === '' ? base : base + ' (' + name + ')';
    };
    Date.prototype.toString = function toString() { return withZone(this, dToString.call(this)); };
    Date.prototype.toTimeString = function toTimeString() { return withZone(this, dToTimeString.call(this)); };
  }

  /* performance: the engine's own object counts from the engine context's
   * creation (and its timeOrigin is the engine's monotonic clock, not an
   * epoch); Node's counts from process start. The island's reads the
   * host's clock — the static side's performance.now() origin on both
   * lanes (native scr_perf_now; the wasm module's perf_now import) — so
   * island and static readings at the same instant agree, and its
   * timeOrigin is that origin as an epoch (Date.now() - now()). Only
   * these two members (Node's Performance carries more — S108 (m)); not
   * own enumerable keys, as Node's live on its prototype. */
  {
    const perf = {};
    const now = { now() { return host.now(); } }.now;
    Object.defineProperty(perf, 'now', { value: now, writable: true, enumerable: false, configurable: true });
    Object.defineProperty(perf, 'timeOrigin', { value: Date.now() - host.now(), writable: false, enumerable: false, configurable: true });
    Object.defineProperty(g, 'performance', { value: perf, writable: true, enumerable: true, configurable: true });
    internals.perf = perf;
  }

  /* The globals, installed as Node installs them (classes non-enumerable,
   * functions enumerable, crypto an enumerable accessor). */
  defGlobal('TextEncoder', TextEncoder);
  defGlobal('TextDecoder', TextDecoder);
  defGlobal('TextDecoderStream', TextDecoderStream);
  defGlobal('URLSearchParams', URLSearchParams);
  defGlobal('btoa', btoa, true);
  defGlobal('atob', atob, true);
  defGlobal('Headers', Headers);
  defGlobal('Blob', Blob);
  defGlobal('File', File);
  defGlobal('Event', Event);
  defGlobal('CustomEvent', CustomEvent);
  defGlobal('EventTarget', EventTarget);
  defGlobal('DOMException', DOMException);
  defGlobal('AbortSignal', AbortSignal);
  defGlobal('AbortController', AbortController);
  defGlobal('structuredClone', structuredClone, true);
  defGlobal('MessageEvent', MessageEvent);
  defGlobal('MessagePort', MessagePort);
  defGlobal('MessageChannel', MessageChannel);
  defGlobal('Request', Request);
  defGlobal('Response', Response);
  defGlobal('Crypto', Crypto);
  defGlobal('SubtleCrypto', SubtleCrypto);
  defGlobal('console', consoleObj);
  {
    let cur = cryptoObj;
    Object.defineProperty(g, 'crypto', {
      get() { return cur; },
      set(v) { cur = v; },
      enumerable: true, configurable: true,
    });
  }

  /* What the engine has that Node 24 does not: removed, so a program
   * cannot observe (or come to depend on) them — QuickJS's InternalError
   * global and Function.prototype's fileName/lineNumber/columnNumber, and
   * the stage-3/4 proposals V8 13.6 does not ship. (Error.prototype.stack
   * is QuickJS's stack accessor itself and stays: S108 (i).) */
  delete g.InternalError;
  for (const k of ['fileName', 'lineNumber', 'columnNumber']) delete Function.prototype[k];
  delete Math.sumPrecise;
  for (const k of ['getOrInsert', 'getOrInsertComputed']) { delete Map.prototype[k]; delete WeakMap.prototype[k]; }
  for (const k of ['immutable', 'sliceToImmutable', 'transferToImmutable']) delete ArrayBuffer.prototype[k];
  for (const k of ['fromBase64', 'fromHex']) delete Uint8Array[k];
  for (const k of ['setFromBase64', 'setFromHex', 'toBase64', 'toHex']) delete Uint8Array.prototype[k];
  for (const k of ['concat', 'zip', 'zipKeyed']) delete Iterator[k];
  /* The engine's Error.prototype.stack setter takes strings only. V8's
   * stack is an accessor on each error whose setter stores any value —
   * on a frozen error too, and for an object deriving from an error. The
   * island keeps the engine's one accessor on the prototype (S108 (i))
   * with V8's storing setter: a value assigned to an error, or to an
   * object with an error on its prototype chain, is held aside (never an
   * own property) and read back first; on an object that only inherits
   * Error.prototype, assignment makes an own property as V8's ordinary
   * [[Set]] does. */
  {
    const d = Object.getOwnPropertyDescriptor(Error.prototype, 'stack');
    if (d !== undefined && typeof d.get === 'function') {
      const assigned = new WeakMap();
      /* V8's header, fixed at the first read of an error's stack. */
      const headers = new WeakMap();
      const errorToString = Error.prototype.toString;
      const headerOf = (e) => {
        let h = headers.get(e);
        if (h === undefined) { h = errorToString.call(e); headers.set(e, h); }
        return h;
      };
      const isObj = (o) => (typeof o === 'object' && o !== null) || typeof o === 'function';
      const errorOnChain = (o) => {
        for (let p = o; p !== null; p = Object.getPrototypeOf(p)) if (Error.isError(p)) return true;
        return false;
      };
      Object.defineProperty(Error.prototype, 'stack', {
        get: { get stack() {
          for (let p = this; isObj(p); p = Object.getPrototypeOf(p)) {
            if (assigned.has(p)) return assigned.get(p);
            if (Error.isError(p)) { headerOf(p); return d.get.call(p); }
          }
          return undefined;
        } }.__lookupGetter__('stack'),
        set: { set stack(v) {
          if (!isObj(this)) throw new TypeError('not an object');
          if (errorOnChain(this)) assigned.set(this, v);
          else Object.defineProperty(this, 'stack', { value: v, writable: true, enumerable: true, configurable: true });
        } }.__lookupSetter__('stack'),
        enumerable: d.enumerable, configurable: true,
      });
      /* The inspector's question: is this error's stack the engine's own? */
      engineStackOf = (e) => (Error.isError(e) && !assigned.has(e) ? d.get.call(e) : undefined);
      engineHeaderOf = headerOf;
    }
  }
  /* What Node 24 has that the engine does not: a named Error on read and
   * write instead of a silent undefined — RegExp's legacy static match
   * properties and Atomics.waitAsync (S108 (i)). */
  const fenceProp = (o, owner, k) => {
    const fail = () => { throw new Error(`${owner}.${k} inside the scriptc island is not supported yet`); };
    Object.defineProperty(o, k, { get: fail, set: fail, enumerable: false, configurable: true });
  };
  for (const k of ['$1', '$2', '$3', '$4', '$5', '$6', '$7', '$8', '$9', '$_', '$&', '$+', '$`', "$'",
    'input', 'lastMatch', 'lastParen', 'leftContext', 'rightContext']) {
    if (!(k in RegExp)) fenceProp(RegExp, 'RegExp', k);
  }
  if (typeof Atomics === 'object' && !('waitAsync' in Atomics)) fenceProp(Atomics, 'Atomics', 'waitAsync');

  /* The fence of the Node globals the island lacks (SEMANTICS.md S103 (b)),
   * ONE mechanism for both lanes: each lane calls it LAST at boot (native:
   * scr_island.c isl_init, after the npm/fetch boot scripts; wasm:
   * isl_core.c isl_init) with the generated list of every own property
   * name of Node's global object (wasm/node_globals.h). Each name the
   * island still lacks becomes an accessor that throws a named Error —
   * `typeof` included — where Node answers its object; assigning one
   * replaces the fence with an ordinary global (a program's own
   * `console`, the native lanes' lazily installed URL). The
   * locale-sensitive methods answer differently without Intl, so they
   * throw the same named error (Array and TypedArray toLocaleString reach
   * them through their elements). A replacement takes Node's
   * enumerability for that global (`enumerable`: the generated list of
   * Node's enumerable global names). Answers the fenced names,
   * comma-joined (the wasm build records them for the compiler's
   * build-time fence). */
  const fenceMsg = (n) => `${n} inside the scriptc island is not supported yet (SEMANTICS.md S103)`;
  const fenceGetters = new WeakSet();
  internals.fenceGlobals = (names, enumerable) => {
    const fenced = [];
    for (const n of names) {
      if (n in g) continue;
      fenced.push(n);
      const get = { get [n]() { throw new Error(fenceMsg(n)); } }.__lookupGetter__(n);
      fenceGetters.add(get);
      Object.defineProperty(g, n, {
        configurable: true,
        enumerable: false,
        get,
        set(v) { Object.defineProperty(g, n, { value: v, writable: true, configurable: true, enumerable: enumerable.includes(n) }); },
      });
    }
    const lf = (o, cls, k) => {
      const f = { [k]() { throw new Error(fenceMsg(cls + '.prototype.' + k)); } }[k];
      Object.defineProperty(f, 'length', { value: k === 'localeCompare' ? 1 : 0 }); // Node's lengths
      Object.defineProperty(o, k, { value: f, writable: true, configurable: true, enumerable: false });
    };
    lf(Number.prototype, 'Number', 'toLocaleString');
    lf(BigInt.prototype, 'BigInt', 'toLocaleString');
    for (const k of ['toLocaleString', 'toLocaleDateString', 'toLocaleTimeString']) lf(Date.prototype, 'Date', k);
    for (const k of ['localeCompare', 'toLocaleLowerCase', 'toLocaleUpperCase']) lf(String.prototype, 'String', k);
    return fenced.join(',');
  };
  internals.isFenced = (n) => {
    const d = Object.getOwnPropertyDescriptor(g, n);
    return d !== undefined && fenceGetters.has(d.get);
  };

  return internals;
}
