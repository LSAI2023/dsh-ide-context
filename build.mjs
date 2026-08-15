// Build step: bundle src/index.ts into the published index.js entry.
// Runtime deps (@deepseek-ai/*) and node:* builtins stay external, matching
// how the DeepSeek Harness installation resolves them at runtime.
//
// Usage: node build.mjs
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

await build({
  entryPoints: [resolve(here, 'src/index.ts')],
  outfile: resolve(here, 'index.js'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'es2024',
  external: ['@deepseek-ai/*', 'node:*'],
  sourcemap: false,
})

// Rebuild the invariant companion too (published as ./invariant).
await build({
  entryPoints: [resolve(here, 'src/invariant.ts')],
  outfile: resolve(here, 'invariant.js'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'es2024',
  external: ['@deepseek-ai/*', 'node:*'],
  sourcemap: false,
})

console.log('built index.js and invariant.js')
