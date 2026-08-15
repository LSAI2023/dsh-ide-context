// Build-sync check: rebuild the published artifacts from src/ and fail if the
// committed index.js/invariant.js drift. The plugin is consumed directly from
// GitHub as compiled JS (package.json `main`/`files` point at index.js), so a
// stale artifact silently ships the previous implementation. Run this before
// committing (manually or via the pre-commit hook) and in CI.
//
// Usage: node check-build.mjs
import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

// Rebuild first: esbuild is deterministic, so a synced artifact reproduces
// byte-for-byte and the subsequent `git diff` stays empty.
execFileSync(process.execPath, [resolve(here, 'build.mjs')], { stdio: 'inherit' })

try {
  execFileSync('git', ['diff', '--exit-code', '--', 'index.js', 'invariant.js'], { stdio: 'ignore' })
  console.log('✓ build-sync: index.js and invariant.js match src/')
} catch {
  const stat = execFileSync('git', ['diff', '--stat', '--', 'index.js', 'invariant.js'], { encoding: 'utf8' })
  console.error('✗ build artifacts are stale: src/ changed but index.js/invariant.js were not rebuilt.')
  console.error('  Run: node build.mjs   (then stage the regenerated artifacts and commit)')
  console.error(stat)
  process.exit(1)
}
