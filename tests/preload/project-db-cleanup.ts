/**
 * Keep SQLite project handles from blocking Bun test cleanup on Windows.
 *
 * The production database cache is intentionally process-scoped, but a test
 * case may remove its temporary project directory during teardown. Closing the
 * cache at the removal boundary releases WAL/SHM handles before recursive
 * cleanup while preserving handle identity for tests that remove aliases.
 */
import { mock } from 'bun:test';
import { createRequire } from 'node:module';
import { closeAllProjectDbs } from '../../src/db/project-db.js';

// Bun runs suite-local `afterEach` hooks before preload hooks. Most historical
// suites remove their temp project directly with `fs.rmSync`, so a teardown hook
// cannot release a just-used SQLite handle in time on Windows. Wrap the native
// filesystem removal boundary in the test process; production code is untouched.
const require = createRequire(import.meta.url);
const nativeFs = require('node:fs') as typeof import('node:fs');
function releaseHandlesBeforeRemoval(
	target: Parameters<typeof nativeFs.rmSync>[0],
): void {
	try {
		if (nativeFs.lstatSync(target).isSymbolicLink()) return;
	} catch {
		// Missing targets are still safe to release; the removal will be a no-op.
	}
	closeAllProjectDbs();
}

const nativeRmSync = nativeFs.rmSync;
const wrappedRmSync = ((
	target: Parameters<typeof nativeRmSync>[0],
	options?: Parameters<typeof nativeRmSync>[1],
) => {
	releaseHandlesBeforeRemoval(target);
	return nativeRmSync(target, options);
}) as typeof nativeRmSync;
mock.module('node:fs', () => ({
	...nativeFs,
	rmSync: wrappedRmSync,
	default: { ...nativeFs, rmSync: wrappedRmSync },
}));

const nativePromises =
	require('node:fs/promises') as typeof import('node:fs/promises');
const nativeRm = nativePromises.rm;
const wrappedRm = (async (...args: Parameters<typeof nativeRm>) => {
	releaseHandlesBeforeRemoval(args[0]);
	return nativeRm(...args);
}) as typeof nativeRm;
try {
	(nativePromises as { rm: typeof wrappedRm }).rm = wrappedRm;
} catch {
	// Built-in module namespaces may be read-only; mock.module below covers the
	// mutable test-runtime facade when direct assignment is unavailable.
}
mock.module('node:fs/promises', () => ({
	...nativePromises,
	rm: wrappedRm,
	default: { ...nativePromises, rm: wrappedRm },
}));
