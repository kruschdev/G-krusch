/**
 * Strict FIFO Async Keyed Mutex with Timeout Guard
 * Ensures sequential execution on keyed resources without race conditions or deadlocks.
 */

export class AsyncKeyedMutex {
  constructor(defaultTimeoutMs = 60000) {
    /** @type {Map<string, Promise<void>>} */
    this.chains = new Map();
    this.defaultTimeoutMs = defaultTimeoutMs;
  }

  /**
   * Acquire a lock for a given key, execute the async function in strict FIFO order, and release.
   * @template T
   * @param {string} key
   * @param {() => Promise<T>} fn
   * @param {{ timeoutMs?: number }} [options]
   * @returns {Promise<T>}
   */
  async runExclusive(key, fn, options = {}) {
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    const prev = this.chains.get(key) || Promise.resolve();

    let release;
    const next = new Promise(resolve => {
      release = resolve;
    });

    // Update chain synchronously to attach current task to the tail
    const nextChain = prev.then(() => next, () => next);
    this.chains.set(key, nextChain);

    await prev;

    let timeoutTimer = null;
    const timeoutPromise = new Promise((_, reject) => {
      if (timeoutMs > 0 && timeoutMs < Infinity) {
        timeoutTimer = setTimeout(() => {
          reject(new Error(`Mutex timeout after ${timeoutMs}ms for key "${key}"`));
        }, timeoutMs);
      }
    });

    try {
      return await Promise.race([fn(), timeoutPromise]);
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      release();
      // Clean up map entry if this was the last item in the chain
      if (this.chains.get(key) === nextChain) {
        this.chains.delete(key);
      }
    }
  }
}

export const mutex = new AsyncKeyedMutex();

