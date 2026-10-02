/**
 * Exponential backoff with jitter for network resilience and Google API rate limit handling.
 */

export async function withRetry(fn, options = {}) {
  const maxRetries = options.maxRetries ?? 3;
  const initialDelayMs = options.initialDelayMs ?? 300;
  const maxDelayMs = options.maxDelayMs ?? 4000;
  const factor = options.factor ?? 2;

  let attempt = 0;
  let delay = initialDelayMs;

  while (true) {
    try {
      return await fn();
    } catch (err) {
      attempt++;
      if (attempt > maxRetries || !isRetryableError(err)) {
        throw err;
      }

      // Add 10-30% random jitter
      const jitter = delay * (0.1 + Math.random() * 0.2);
      const actualDelay = Math.min(delay + jitter, maxDelayMs);

      console.warn(`[Retry] Attempt ${attempt}/${maxRetries} failed with "${err.message}". Retrying in ${Math.round(actualDelay)}ms...`);
      await new Promise(resolve => setTimeout(resolve, actualDelay));

      delay = Math.min(delay * factor, maxDelayMs);
    }
  }
}

function isRetryableError(err) {
  if (!err) return false;

  // Network codes
  const code = err.code || err.cause?.code;
  if (['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED'].includes(code)) {
    return true;
  }

  // HTTP status codes
  const status = err.status || err.response?.status || err.statusCode;
  if (status === 429 || (status >= 500 && status <= 504)) {
    return true;
  }

  // Google specific error messages
  const msg = (err.message || '').toLowerCase();
  if (msg.includes('rate limit') || msg.includes('user rate limit') || msg.includes('quota exceeded') || msg.includes('backend error')) {
    return true;
  }

  return false;
}
