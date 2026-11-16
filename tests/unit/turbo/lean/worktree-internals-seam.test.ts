/**
 * Tests for the _internals.bunSpawn DI seam of src/turbo/lean/worktree.ts
 *
 * Moved verbatim out of worktree.test.ts (an over-cap legacy file under the
 * FR-006 ratchet) so that file does not grow. The mockProc helper and the
 * bunSpawn restore are copied from worktree.test.ts unchanged.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { _internals } from '../../../../src/turbo/lean/worktree';
import type { BunCompatSubprocess } from '../../../../src/utils/bun-compat';

/** Saves the real bunSpawn so the test can restore it in afterEach. */
const realBunSpawn = _internals.bunSpawn;

/**
 * Constructs a minimal BunCompatSubprocess mock.
 * exitCode, stdout, and stderr are configurable per test.
 */
function mockProc(
	exitCode: number,
	stdout = '',
	stderr = '',
): BunCompatSubprocess {
	return {
		exited: Promise.resolve(exitCode),
		exitCode,
		stdout: {
			text: () => Promise.resolve(stdout),
		} as unknown as BunCompatSubprocess['stdout'],
		stderr: {
			text: () => Promise.resolve(stderr),
		} as unknown as BunCompatSubprocess['stderr'],
		kill: () => {},
	} as BunCompatSubprocess;
}

/** Restores the real bunSpawn after every test. */
afterEach(() => {
	_internals.bunSpawn = realBunSpawn;
});

// ---------------------------------------------------------------------------
// _internals DI seam
// ---------------------------------------------------------------------------

describe('_internals.bunSpawn', () => {
	test('_internals.bunSpawn can be replaced for testing', () => {
		// Confirm the seam exists and is initially the real function
		expect(typeof _internals.bunSpawn).toBe('function');

		// Replace with a no-op mock
		_internals.bunSpawn = () => mockProc(0, 'replaced', '');
		const result = _internals.bunSpawn();
		expect(result.exitCode).toBe(0);
		expect(result).toHaveProperty('exited');
		expect(result).toHaveProperty('kill');
	});
});
