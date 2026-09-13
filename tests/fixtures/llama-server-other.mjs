#!/usr/bin/env node
if (process.argv.includes('--version')) {
  console.log('version: b9001 (fedcba98)');
} else {
  await import('./llama-server.mjs');
}
