#!/usr/bin/env node

/**
 * G-Krusch CLI & MCP Stdio Entrypoint
 * Defaults to MCP Stdio transport when invoked via `g-krusch` or `npx g-krusch`
 * unless `--http` or `--server` is explicitly passed.
 */

if (!process.argv.includes('--http') && !process.argv.includes('--server') && !process.argv.includes('--stdio')) {
  process.argv.push('--stdio');
}

await import('../src/index.js');
