// A plain (non-async) module: its %init runs synchronously and throws
// before returning any exports.
export {};
console.log("boom:before");
throw new Error("boom");
