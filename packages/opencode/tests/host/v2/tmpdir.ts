/**
 * Canonical-tmpdir test helper for the opencode package's v2 host tests
 * (8.x port of the 7.x tests/helpers/tmpdir.ts convention, issue #1737/FR-011).
 *
 * `os.tmpdir()` on macOS returns a path under `/var/...`, but `/var` is a
 * symlink to `/private/var`; production code that canonicalizes paths then
 * compares against the resolved form. `mkdtempSync` results are wrapped in
 * `realpathSync` so the symlink (and the Windows 8.3 short-name) gap cannot
 * diverge between fixture creation and assertion.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Creates a unique subdirectory under `os.tmpdir()` via `fs.mkdtempSync` and
 * returns its realpath-resolved form.
 */
export function canonicalMkdtemp(prefix: string): string {
	const rawDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	return fs.realpathSync(rawDir);
}
