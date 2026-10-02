/**
 * Async Keyed Mutex
 * Ensures operations on the same logical resource (e.g. workspace folder provisioning,
 * agent.md updates, RAG indexing) are executed sequentially rather than overlapping.
 */

class AsyncKeyedMutex {
  constructor() {
    /** @type {Map<string, Promise<void>>} */
    this.locks = new Map();
  }

  /**
   * Acquire a lock for a given key, execute the async function, and release.
   * @template T
   * @param {string} key
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  async runExclusive(key, fn) {
    while (this.locks.has(key)) {
      await this.locks.get(key);
    }

    let release;
    const lockPromise = new Promise(resolve => {
      release = resolve;
    });

    this.locks.set(key, lockPromise);

    try {
      return await fn();
    } finally {
      this.locks.delete(key);
      release();
    }
  }
}

export const mutex = new AsyncKeyedMutex();
