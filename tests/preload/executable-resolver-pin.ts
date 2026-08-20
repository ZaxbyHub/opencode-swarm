/**
 * Bun test preload (issue #2236 FR-006 ratchet fix): pre-seed the
 * `resolveGitExecutable()` / `resolveGitExecutableAsync()` resolver cache
 * (`src/utils/git-executable.ts`) and the `resolveGhBinary()` pin
 * (`src/tools/gh-evidence.ts`) with their pre-#2236-hardening literal values
 * — `'git'` and `'gh'` — before ANY test file loads.
 *
 * Registered in bunfig.toml under [test] preload. Runs for every `bun test`
 * invocation, mirroring `tests/preload/prod-store-tripwire.ts`.
 *
 * Why this exists: issue #2236 hardening converted bare `spawnSync('git', ...)`
 * / `spawnSync('gh', ...)` call sites to route through these two resolvers,
 * which do real filesystem probing (`git-executable.ts`: stat + `git
 * --version`) or a real PATH scan (`gh-evidence.ts`'s `resolveGhBinary()`,
 * via `resolveExecutableFromPath`). Tests that mock `node:child_process`
 * wholesale to assert exact spawnSync call counts/args, or assert
 * `cmd[0] === 'git'` / `toHaveBeenCalledWith('gh', ...)`, broke because (a)
 * the real probe consumes mocked spawn-queue entries meant for the git/gh
 * calls under test, and (b) the resolved value is host-dependent (an
 * absolute path when `git`/`gh` happens to be installed, unprobed `'git'`
 * bare fallback otherwise). Eleven already-over-the-FR-006-cap test files
 * worked around this with a per-file `_internals` stub in `beforeEach`/
 * `afterEach`, which the FR-006 line-count ratchet then flagged (an
 * over-cap file may only shrink, never grow). Seeding both resolvers here
 * makes every one of those per-file stubs unnecessary: the resolvers return
 * the literal `'git'`/`'gh'` on first call, with zero probe spawns, so the
 * pre-existing assertions are valid again with no per-file change.
 *
 * Overridable by design: `resetGitExecutableCache()` clears the exact same
 * `cache` variable this seeds, and `resolveGhBinary()` checks its pin before
 * anything else — so `tests/unit/utils/git-executable*.test.ts`, which call
 * `resetGitExecutableCache()` themselves to exercise the REAL probing
 * behavior, are unaffected by this preload.
 */

import { __seedGhBinaryForTests } from '../../src/tools/gh-evidence.js';
import { __seedGitExecutableForTests } from '../../src/utils/git-executable.js';

__seedGitExecutableForTests('git');
__seedGhBinaryForTests('gh');
