/**
 * Issue #2236 RC3 item 2 — evictPluginCaches()/evictLockFiles() must verify
 * that a delete actually happened, not just trust that rmSync()/unlinkSync()
 * didn't throw. `rmSync(dir, { recursive: true, force: true })` (and
 * `unlinkSync`) can return without throwing while leaving the target behind —
 * e.g. `force: true` swallowing a locked-file error on Windows — so
 * "cleared" must mean "verified absent," not "the syscall didn't throw."
 *
 * This is a DEDICATED, single-purpose file rather than folded into
 * update-command.test.ts or update-versioned-cache.test.ts: it needs a
 * MODULE-SCOPE `mock.module('node:fs', ...)` override of rmSync/unlinkSync,
 * applied before the FIRST import of src/cli/index.ts in this process (via a
 * dynamic `await import()` after the mock is registered, since
 * OPENCODE_PLUGIN_CACHE_PATHS / OPENCODE_PLUGIN_LOCK_FILE_PATHS are captured
 * at src/cli/index.ts's own module-scope import time). Mixing that with the
 * many real-fs tests elsewhere would risk exactly the cross-file
 * mock.module pollution the writing-tests skill warns about (mock.restore()
 * is not reliably able to undo a mock.module override in this Bun version),
 * so this file is isolated on purpose and runs in its own per-file process
 * like every other test file in this suite.
 */
import { afterAll, expect, mock, test } from 'bun:test';
import * as realFs from 'node:fs';
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// --- Fixture setup (module scope, BEFORE the mock.module call below) ---
const tempDir = realpathSync(
	mkdtempSync(join(tmpdir(), 'opencode-swarm-verify-delete-')),
);
const xdgCacheHome = join(tempDir, 'cache');
const xdgConfigHome = join(tempDir, 'config');

const cachePath = join(
	xdgCacheHome,
	'opencode',
	'packages',
	'opencode-swarm@latest',
);
mkdirSync(cachePath, { recursive: true });
writeFileSync(
	join(cachePath, 'package.json'),
	JSON.stringify({ version: '7.143.1' }),
);

const lockDir = join(xdgCacheHome, 'opencode');
const lockPath = join(lockDir, 'bun.lock');
mkdirSync(lockDir, { recursive: true });
writeFileSync(lockPath, '{}');

process.env.XDG_CACHE_HOME = xdgCacheHome;
process.env.XDG_CONFIG_HOME = xdgConfigHome;

// --- Fake rmSync/unlinkSync: report success without touching the filesystem ---
const noopRmSync = mock(() => undefined);
const noopUnlinkSync = mock(() => undefined);
mock.module('node:fs', () => ({
	...realFs,
	rmSync: noopRmSync,
	unlinkSync: noopUnlinkSync,
}));

// Dynamic import AFTER both the env vars and the fs mock are in place —
// src/cli/index.ts computes OPENCODE_PLUGIN_CACHE_PATHS / OPENCODE_PLUGIN_LOCK_FILE_PATHS
// from getPluginCachePaths()/getPluginLockFilePaths() at its own module-scope
// import time, and resolves 'node:fs' as `import * as fs`, so both must
// already be settled before this specifier is first resolved in this process.
const { evictPluginCaches, evictLockFiles } = await import(
	'../../../src/cli/index.js'
);

afterAll(() => {
	delete process.env.XDG_CACHE_HOME;
	delete process.env.XDG_CONFIG_HOME;
	mock.restore();
	rmSync(tempDir, { recursive: true, force: true });
});

test('a cache dir whose rmSync "succeeds" without actually removing it is reported FAILED, not cleared', () => {
	// Previous code (src/cli/index.ts evictPluginCaches) pushed to `cleared`
	// immediately after rmSync returned without throwing — it never checked
	// the postcondition, so a delete that silently no-ops was reported as a
	// success ("✓ Cleared: <path>" when the path was, in fact, never cleared).
	const result = evictPluginCaches();

	expect(noopRmSync).toHaveBeenCalled();
	expect(result.cleared).not.toContain(cachePath);
	expect(
		result.failed.some(
			(f: string) => f.includes(cachePath) && f.includes('still exists'),
		),
	).toBe(true);
	// The real directory is untouched because rmSync itself was faked as a
	// no-op — this proves the check is against the real filesystem, not a
	// mocked existsSync.
	expect(realFs.existsSync(cachePath)).toBe(true);
});

test('a lock file whose unlinkSync "succeeds" without actually removing it is reported FAILED, not cleared', () => {
	const result = evictLockFiles();

	expect(noopUnlinkSync).toHaveBeenCalled();
	expect(result.cleared).not.toContain(lockPath);
	expect(
		result.failed.some(
			(f: string) => f.includes(lockPath) && f.includes('still exists'),
		),
	).toBe(true);
	expect(realFs.existsSync(lockPath)).toBe(true);
});
