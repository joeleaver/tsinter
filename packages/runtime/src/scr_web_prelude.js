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
 *   host.now()                   performance.now (Event#timeStamp)
 *   host.isPromise(v), isProxy(v), proxyTarget(v)
 *                                internal-slot checks for structuredClone
 *
 * It answers its internals object (what other boot scripts reach without
 * a global: mkResponse, uspReset, receiveMessageOnPort). The classes are
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
  /* errors.js determineSpecificType; an object without a named constructor
   * would print through util.inspect, which the island does not carry —
   * its plain-object rendering stands in. */
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
      return Object.getPrototypeOf(value) === null ? '[Object: null prototype] {}' : '{}';
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
    /* util.inspect where a build carries it (npm builds); a plain build
     * has none and answers Object.prototype.toString (S108 (a)). */
    case 'object': if (V === null) return 'null'; return inspectHook !== null ? inspectHook(V) : Object.prototype.toString.call(V);
    case 'function': return inspectHook !== null ? inspectHook(V) : Object.prototype.toString.call(V);
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

  /* console: Node's formatWithOptions (lib/internal/util/inspect.js),
   * branch for branch, over the island's `inspect`: by default a stand-in
   * that renders a primitive exactly as util.inspect does and an object or
   * a function through String() — util.inspect itself is not carried
   * (the registered divergence, SEMANTICS.md S108 (a)); a build that embeds
   * npm packages installs the bootstrap's util.inspect port here
   * (internals.setInspect), so one console serves every build. Writes go
   * to the REAL fds (same stdio as static console output) with Node's
   * group indentation, lone surrogates as U+FFFD (Node writes UTF-8). The
   * methods that are nothing but inspection or wall-clock time (dir,
   * dirxml, table, time, timeEnd, timeLog, trace, Console, context,
   * createTask) and countReset of a label never counted (Node reports it
   * through a process warning) throw a named Error. */
  const fmtNumber = (n) => (Object.is(n, -0) ? '-0' : `${n}`);
  /* util.inspect's strEscape: single quotes unless the string holds one
   * (then double, then backtick), C0 controls, DEL, backslash and lone
   * surrogates escaped. */
  const ESC = { 8: '\\b', 9: '\\t', 10: '\\n', 12: '\\f', 13: '\\r', 92: '\\\\' };
  const quoteString = (s) => {
    let q = "'";
    if (s.includes("'")) {
      if (!s.includes('"')) q = '"';
      else if (!s.includes('`') && !s.includes('${')) q = '`';
    }
    let out = '';
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c === q.charCodeAt(0)) out += '\\' + q;
      else if (ESC[c] !== undefined) out += ESC[c];
      else if (c < 0x20 || c === 0x7f) out += '\\x' + HEX[c >> 4] + HEX[c & 15];
      else if (c >= 0xd800 && c <= 0xdfff) {
        const n = s.charCodeAt(i + 1);
        if (c <= 0xdbff && n >= 0xdc00 && n <= 0xdfff) { out += s[i] + s[i + 1]; i++; }
        else out += '\\u' + c.toString(16).toUpperCase();
      } else out += s[i];
    }
    return q + out + q;
  };
  let inspectHook = null;
  internals.setInspect = (fn) => { inspectHook = fn; };
  const inspect = (v, opts) => {
    if (inspectHook !== null) return inspectHook(v, opts);
    switch (typeof v) {
    case 'string': return quoteString(v);
    case 'number': return fmtNumber(v);
    case 'bigint': return `${v}n`;
    case 'symbol': return v.toString();
    case 'undefined': return 'undefined';
    case 'boolean': return `${v}`;
    }
    if (v === null) return 'null';
    try { return String(v); } catch (_e) { return '[value]'; }
  };
  let builtInObjects = null; // Node's: the capitalized global names, read once on first use
  const hasBuiltInToString = (value) => {
    let hasOwnToString = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
    let hasOwnToPrimitive = hasOwnToString;
    if (typeof value.toString !== 'function') {
      if (typeof value[Symbol.toPrimitive] !== 'function') return true;
      else if (Object.prototype.hasOwnProperty.call(value, Symbol.toPrimitive)) return false;
      hasOwnToString = () => false;
    } else if (Object.prototype.hasOwnProperty.call(value, 'toString')) {
      return false;
    } else if (typeof value[Symbol.toPrimitive] !== 'function') {
      hasOwnToPrimitive = () => false;
    } else if (Object.prototype.hasOwnProperty.call(value, Symbol.toPrimitive)) {
      return false;
    }
    let pointer = value;
    do {
      pointer = Object.getPrototypeOf(pointer);
    } while (!hasOwnToString(pointer, 'toString') && !hasOwnToPrimitive(pointer, Symbol.toPrimitive));
    const descriptor = Object.getOwnPropertyDescriptor(pointer, 'constructor');
    if (builtInObjects === null) builtInObjects = new Set(Object.getOwnPropertyNames(g).filter((e) => /^[A-Z][a-zA-Z0-9]+$/.test(e)));
    return descriptor !== undefined && typeof descriptor.value === 'function' && builtInObjects.has(descriptor.value.name);
  };
  let circularMessage;
  const firstLine = (e) => { const m = String(e.message); const i = m.indexOf('\n'); return i === -1 ? m : m.slice(0, i); };
  const tryStringify = (arg) => {
    try { return JSON.stringify(arg); } catch (err) {
      if (circularMessage === undefined) {
        try { const o = {}; o.a = o; JSON.stringify(o); } catch (c) { circularMessage = firstLine(c); }
      }
      if (err.name === 'TypeError' && firstLine(err) === circularMessage) return '[Circular]';
      throw err;
    }
  };
  const formatArgs = (args) => {
    const first = args[0];
    let a = 0, str = '', join = '';
    if (typeof first === 'string') {
      if (args.length === 1) return first;
      let tempStr, lastPos = 0;
      for (let i = 0; i < first.length - 1; i++) {
        if (first.charCodeAt(i) === 37) { // '%'
          const nextChar = first.charCodeAt(++i);
          if (a + 1 !== args.length) {
            switch (nextChar) {
            case 115: { // 's'
              const tempArg = args[++a];
              if (typeof tempArg === 'number') tempStr = fmtNumber(tempArg);
              else if (typeof tempArg === 'bigint') tempStr = `${tempArg}n`;
              else if (typeof tempArg !== 'object' || tempArg === null || !hasBuiltInToString(tempArg)) tempStr = String(tempArg);
              else tempStr = inspect(tempArg, { compact: 3, colors: false, depth: 0 });
              break;
            }
            case 106: tempStr = tryStringify(args[++a]); break; // 'j'
            case 100: { // 'd'
              const tempNum = args[++a];
              if (typeof tempNum === 'bigint') tempStr = `${tempNum}n`;
              else if (typeof tempNum === 'symbol') tempStr = 'NaN';
              else tempStr = fmtNumber(Number(tempNum));
              break;
            }
            case 79: tempStr = inspect(args[++a], {}); break; // 'O'
            case 111: tempStr = inspect(args[++a], { showHidden: true, showProxy: true, depth: 4 }); break; // 'o'
            case 105: { // 'i'
              const tempInteger = args[++a];
              if (typeof tempInteger === 'bigint') tempStr = `${tempInteger}n`;
              else if (typeof tempInteger === 'symbol') tempStr = 'NaN';
              else tempStr = fmtNumber(Number.parseInt(tempInteger));
              break;
            }
            case 102: { // 'f'
              const tempFloat = args[++a];
              if (typeof tempFloat === 'symbol') tempStr = 'NaN';
              else tempStr = fmtNumber(Number.parseFloat(tempFloat));
              break;
            }
            case 99: a += 1; tempStr = ''; break; // 'c'
            case 37: str += first.slice(lastPos, i); lastPos = i + 1; continue; // '%'
            default: continue;
            }
            if (lastPos !== i - 1) str += first.slice(lastPos, i - 1);
            str += tempStr;
            lastPos = i + 1;
          } else if (nextChar === 37) {
            str += first.slice(lastPos, i);
            lastPos = i + 1;
          }
        }
      }
      if (lastPos !== 0) {
        a++;
        join = ' ';
        if (lastPos < first.length) str += first.slice(lastPos);
      }
    }
    while (a < args.length) {
      const value = args[a];
      str += join;
      str += typeof value !== 'string' ? inspect(value, {}) : value;
      join = ' ';
      a++;
    }
    return str;
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
    throw new Error(`console.${name} inside the scriptc island is not supported yet (it needs util.inspect or the wall clock)`);
  };
  const counts = new Map();
  const consoleObj = {
    log(...args) { consoleWrite(1, formatArgs(args)); },
    info(...args) { consoleWrite(1, formatArgs(args)); },
    debug(...args) { consoleWrite(1, formatArgs(args)); },
    warn(...args) { consoleWrite(2, formatArgs(args)); },
    error(...args) { consoleWrite(2, formatArgs(args)); },
    dir: consoleFence('dir'),
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
    table: consoleFence('table'),
    dirxml: consoleFence('dirxml'),
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
   * (native: scr_zone_names.h, SEMANTICS.md S113; the wasm engine is UTC,
   * S103 (e)). */
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
      const isObj = (o) => (typeof o === 'object' && o !== null) || typeof o === 'function';
      const errorOnChain = (o) => {
        for (let p = o; p !== null; p = Object.getPrototypeOf(p)) if (Error.isError(p)) return true;
        return false;
      };
      Object.defineProperty(Error.prototype, 'stack', {
        get: { get stack() {
          for (let p = this; isObj(p); p = Object.getPrototypeOf(p)) {
            if (assigned.has(p)) return assigned.get(p);
            if (Error.isError(p)) return d.get.call(p);
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

  return internals;
}
