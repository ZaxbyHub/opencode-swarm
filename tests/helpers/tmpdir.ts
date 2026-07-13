/**
 * Canonical-tmpdir test helper for opencode-swarm (issue #1737, FR-011).
 *
 * Why this exists: `os.tmpdir()` on macOS returns a path under `/var/...`,
 * but `/var` is itself a symlink to `/private/var`. Production code that
 * canonicalizes paths (via `path.resolve`/`fs.realpathSync`, e.g. containment
 * guards and boundary checks) compares against the resolved `/private/var/...`
 * form. A test that creates a fixture via the raw `os.tmpdir()` path and later
 * checks it via a canonicalized path silently diverges on macOS CI (the two
 * strings differ even though they name the same directory) — the class of bug
 * that was individually patched with ad hoc `fs.realpathSync(os.tmpdir())`
 * calls across 20+ test files before this helper existed.
 *
 * Use these helpers instead of calling `os.tmpdir()` / `fs.mkdtempSync()`
 * directly in new tests so the symlink gap can't be reintroduced.
 * `scripts/check-test-tmpdir.sh` lints new/changed test lines for raw usage.
 *
 * Usage:
 *   const base = canonicalTmpDir();
 *   const dir = canonicalMkdtemp('my-test-');
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Returns the realpath-resolved system temp directory, closing the macOS
 * `/var` -> `/private/var` symlink gap (and the Windows 8.3 short-name
 * mismatch, e.g. `C:\Users\RUNNER~1` vs `C:\Users\runneradmin`).
 */
export function canonicalTmpDir(): string {
	return fs.realpathSync(os.tmpdir());
}

/**
 * Creates a unique subdirectory under `os.tmpdir()` via `fs.mkdtempSync` and
 * returns its realpath-resolved form, so the caller gets a directory that is
 * already symlink-safe with no separate `realpathSync` call needed downstream.
 */
export function canonicalMkdtemp(prefix: string): string {
	const rawDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	return fs.realpathSync(rawDir);
}
