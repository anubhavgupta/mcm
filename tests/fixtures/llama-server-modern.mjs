#!/usr/bin/env node
if (process.argv.includes('--version')) {
  console.log('version: 0.3.0-dev (build 10712, commit daef7b687)');
  console.log('built with MSVC 19.44.35223.0 for x64');
} else {
  await import('./llama-server.mjs');
}
