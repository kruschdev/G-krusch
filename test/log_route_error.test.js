import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { logRouteError } from '../src/routes/api.js';

describe('logRouteError test-only guard (BUG-01, SEC-01, TEST-01)', () => {
  it('suppresses console.error when cfg.nodeTestContext is true', () => {
    const calls = [];
    const origError = console.error;
    console.error = (...args) => calls.push(args);
    try {
      logRouteError(
        { method: 'GET', originalUrl: '/api/status' },
        new Error('simulated route error'),
        { nodeTestContext: true },
        []
      );
      assert.equal(calls.length, 0);
    } finally {
      console.error = origError;
    }
  });

  it('logs to console.error when cfg.nodeTestContext is false and --test is not in execArgv', () => {
    const calls = [];
    const origError = console.error;
    console.error = (...args) => calls.push(args);
    try {
      logRouteError(
        { method: 'POST', originalUrl: '/api/drive/sync' },
        new Error('production error'),
        { nodeTestContext: false },
        []
      );
      assert.equal(calls.length, 1);
      assert.match(String(calls[0][0]), /\[G-Krusch API Error\] POST \/api\/drive\/sync/);
    } finally {
      console.error = origError;
    }
  });
});
