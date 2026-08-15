// Install the repo's git hooks (core.hooksPath = .githooks) so that future
// commits run the build-sync check automatically. One-time setup per clone;
// CI provides an independent guard in case a contributor skips this step.
//
// Usage: node install-hooks.mjs
import { execFileSync } from 'node:child_process'

execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { stdio: 'inherit' })
console.log('✓ installed git hooks (core.hooksPath = .githooks)')
