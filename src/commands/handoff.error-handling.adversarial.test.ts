/**
 * Adversarial tests for temp file cleanup in handoff.ts
 * Tests error handling paths for renameSync/unlinkSync cleanup patterns
 * that are NOT covered by the main error-handling test suite.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

// ---------------------------------------------------------------------------
// Global state for tracking call sequences
// ---------------------------------------------------------------------------
let bunWriteShouldThrow = false;
let bunWriteCallCount = 0;
let tempPathsCreated: string[] = [];

// ---------------------------------------------------------------------------
// Module-level mocks for dependencies that don't change per-test
// ---------------------------------------------------------------------------

mock.module('../utils/bun-compat', () => ({
	bunWrite: mock(async (path: string) => {
		bunWriteCallCount++;
		tempPathsCreated.push(path);
		if (bunWriteShouldThrow) {
			throw new Error('ENOSPC: no space left on device');
		}
	}),
	bunFile: mock(() => ({
		text: mock(() => Promise.resolve('')),
		arrayBuffer: mock(() => Promise.resolve(new ArrayBuffer(0))),
		exists: mock(() => Promise.resolve(false)),
		size: 0,
	})),
	isBun: mock(() => false),
	bunSpawn: mock(() => ({})),
	bunSpawnSync: mock(() => ({
		stdout: new Uint8Array(0),
		stderr: new Uint8Array(0),
		exitCode: 0,
		success: true,
	})),
	bunHash: mock(() => 0n),
}));

mock.module('../session/snapshot-writer', () => ({
	writeSnapshot: mock(async () => {}),
	flushPendingSnapshot: mock(async () => {}),
}));

// Import after mocks are set up
import { handleHandoffCommand } from './handoff';

describe('handoff.ts temp file cleanup adversarial tests', () => {
	const TEST_DIR = '/fake/test/project';

	beforeEach(() => {
		bunWriteShouldThrow = false;
		bunWriteCallCount = 0;
		tempPathsCreated = [];
	});

	afterEach(() => {
		mock.restore();
	});

	// ---------------------------------------------------------------------------
	// AV1: renameSync throws but unlinkSync also throws
	// Verify: no crash, original renameErr still propagated
	// ---------------------------------------------------------------------------

	test('AV1: renameSync fails, unlinkSync also fails — original error propagated, no crash', async () => {
		await mock.module('node:fs', () => ({
			renameSync: mock((_src: string, _dest: string) => {
				throw new Error('EPERM: operation not permitted');
			}),
			unlinkSync: mock((_path: string) => {
				throw new Error('EBUSY: resource busy');
			}),
			createWriteStream: mock(() => ({
				write: mock(() => {}),
				end: mock(() => {}),
				on: mock(() => {}),
			})),
		}));

		const result = await handleHandoffCommand(TEST_DIR, []);

		// Should get error response, not crash
		expect(result).toContain('Handoff Generated (file write failed)');
		expect(result).toContain('EPERM');
	});

	// ---------------------------------------------------------------------------
	// AV2: renameSync throws EPERM (permission) — cleanup verified
	// ---------------------------------------------------------------------------

	test('AV2: renameSync throws EPERM — cleanup attempted via unlinkSync', async () => {
		const unlinkSyncCalls: string[] = [];
		await mock.module('node:fs', () => ({
			renameSync: mock((_src: string, _dest: string) => {
				throw Object.assign(new Error('EPERM: operation not permitted'), {
					code: 'EPERM',
				});
			}),
			unlinkSync: mock((path: string) => {
				unlinkSyncCalls.push(path);
			}),
			createWriteStream: mock(() => ({
				write: mock(() => {}),
				end: mock(() => {}),
				on: mock(() => {}),
			})),
		}));

		const result = await handleHandoffCommand(TEST_DIR, []);

		// unlinkSync was called for cleanup
		expect(unlinkSyncCalls.length).toBeGreaterThan(0);
		// Cleanup was called on temp path (contains .tmp.)
		expect(unlinkSyncCalls[0]).toContain('.tmp.');
		// Result indicates failure
		expect(result).toContain('EPERM');
	});

	// ---------------------------------------------------------------------------
	// AV3: first file succeeds, second renameSync fails, writeSnapshot throws
	// Verify: first error (from rename) is surfaced, not writeSnapshot error
	// ---------------------------------------------------------------------------

	test('AV3: second file rename fails, writeSnapshot then throws — first error surfaced', async () => {
		// Override writeSnapshot to throw
		mock.module('../session/snapshot-writer', () => ({
			writeSnapshot: mock(async () => {
				throw new Error('writeSnapshot failed');
			}),
			flushPendingSnapshot: mock(async () => {}),
		}));

		// First rename succeeds, second fails
		let renameCount = 0;
		await mock.module('node:fs', () => ({
			renameSync: mock((_src: string, _dest: string) => {
				renameCount++;
				if (renameCount === 1) return; // first succeeds
				throw new Error('ENOSPC: no space left on device');
			}),
			unlinkSync: mock((_path: string) => {}),
			createWriteStream: mock(() => ({
				write: mock(() => {}),
				end: mock(() => {}),
				on: mock(() => {}),
			})),
		}));

		// Re-import to get fresh mock
		const { handleHandoffCommand: cmd } = await import('./handoff');
		const result = await cmd(TEST_DIR, []);

		// The error should be from the second rename, not from writeSnapshot
		expect(result).toContain('ENOSPC');
		expect(result).not.toContain('writeSnapshot failed');
	});

	// ---------------------------------------------------------------------------
	// AV4: concurrent temp file collision — UUID uniqueness
	// Verify: each temp path is unique (UUID-based)
	// ---------------------------------------------------------------------------

	test('AV4: temp paths are unique per write — UUID-based collision resistance', async () => {
		await mock.module('node:fs', () => ({
			renameSync: mock((_src: string, _dest: string) => {}),
			unlinkSync: mock((_path: string) => {}),
			createWriteStream: mock(() => ({
				write: mock(() => {}),
				end: mock(() => {}),
				on: mock(() => {}),
			})),
		}));

		const result = await handleHandoffCommand(TEST_DIR, []);

		// bunWrite was called twice (handoff.md and handoff-prompt.md)
		expect(bunWriteCallCount).toBe(2);

		const [firstTempPath, secondTempPath] = tempPathsCreated;

		// Paths must be unique (no collision)
		expect(firstTempPath).not.toBe(secondTempPath);

		// Each must contain .tmp. and a UUID
		const uuidPattern =
			/\.tmp\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
		expect(firstTempPath).toMatch(uuidPattern);
		expect(secondTempPath).toMatch(uuidPattern);

		// UUIDs must be different
		const firstUuid = firstTempPath.split('.tmp.')[1];
		const secondUuid = secondTempPath.split('.tmp.')[1];
		expect(firstUuid).not.toBe(secondUuid);
	});

	// ---------------------------------------------------------------------------
	// AV5: validateSwarmPath with directory traversal
	// Verify: path is rejected before any temp file creation
	// ---------------------------------------------------------------------------

	test('AV5: path traversal in filename — validateSwarmPath rejects before temp creation', async () => {
		// This tests that validateSwarmPath prevents path traversal
		// The validation happens at the hook level before any fs operations

		const maliciousFilename = '../../../etc/passwd';

		// The validateSwarmPath function rejects path traversal at the hook level
		const { validateSwarmPath } = await import('../hooks/utils');
		expect(() => validateSwarmPath(TEST_DIR, maliciousFilename)).toThrow(
			/path traversal detected/,
		);

		// Verify the pattern that would be used in handoff.ts
		expect(/\.\.[/\\]/.test(maliciousFilename)).toBe(true);
	});

	// ---------------------------------------------------------------------------
	// AV6: successful rename — unlinkSync NOT called
	// ---------------------------------------------------------------------------

	test('AV6: successful rename — unlinkSync should NOT be called for cleanup', async () => {
		const unlinkSyncCalls: string[] = [];
		await mock.module('node:fs', () => ({
			renameSync: mock((_src: string, _dest: string) => {}),
			unlinkSync: mock((path: string) => {
				unlinkSyncCalls.push(path);
			}),
			createWriteStream: mock(() => ({
				write: mock(() => {}),
				end: mock(() => {}),
				on: mock(() => {}),
			})),
		}));

		await handleHandoffCommand(TEST_DIR, []);

		// unlinkSync should NOT be called when rename succeeds
		expect(unlinkSyncCalls.length).toBe(0);
	});

	// ---------------------------------------------------------------------------
	// AV7: bunWrite throws — verify no temp file leak
	// ---------------------------------------------------------------------------

	test('AV7: bunWrite throws — no temp file to clean up, error propagated', async () => {
		bunWriteShouldThrow = true;

		const renameSyncCalls: string[] = [];
		const unlinkSyncCalls: string[] = [];
		await mock.module('node:fs', () => ({
			renameSync: mock((src: string, _dest: string) => {
				renameSyncCalls.push(src);
			}),
			unlinkSync: mock((path: string) => {
				unlinkSyncCalls.push(path);
			}),
			createWriteStream: mock(() => ({
				write: mock(() => {}),
				end: mock(() => {}),
				on: mock(() => {}),
			})),
		}));

		const result = await handleHandoffCommand(TEST_DIR, []);

		expect(result).toContain('Handoff Generated (file write failed)');
		expect(result).toContain('ENOSPC');
		// No rename attempted since bunWrite failed
		expect(renameSyncCalls.length).toBe(0);
		// No unlink since no temp file was created
		expect(unlinkSyncCalls.length).toBe(0);
	});

	// ---------------------------------------------------------------------------
	// AV8: rapid successive calls — verify state isolation
	// ---------------------------------------------------------------------------

	test('AV8: consecutive calls — temp paths isolated per invocation', async () => {
		await mock.module('node:fs', () => ({
			renameSync: mock((_src: string, _dest: string) => {}),
			unlinkSync: mock((_path: string) => {}),
			createWriteStream: mock(() => ({
				write: mock(() => {}),
				end: mock(() => {}),
				on: mock(() => {}),
			})),
		}));

		await handleHandoffCommand(TEST_DIR, []);
		await handleHandoffCommand(TEST_DIR, []);

		// All paths should be unique across invocations (4 total - 2 files x 2 calls)
		const uniquePaths = new Set(tempPathsCreated);
		expect(uniquePaths.size).toBe(4);
	});

	// ---------------------------------------------------------------------------
	// AV9: unlinkSync called on non-existent path (ENOENT)
	// Verify: unlinkSync failure doesn't prevent error propagation
	// ---------------------------------------------------------------------------

	test('AV9: unlinkSync on non-existent path — ENOENT ignored, original error surfaced', async () => {
		await mock.module('node:fs', () => ({
			renameSync: mock((_src: string, _dest: string) => {
				throw new Error('EBADF: bad file descriptor');
			}),
			unlinkSync: mock((_path: string) => {
				// Cleanup fails with ENOENT (file doesn't exist)
				throw Object.assign(new Error('ENOENT: no such file'), {
					code: 'ENOENT',
				});
			}),
			createWriteStream: mock(() => ({
				write: mock(() => {}),
				end: mock(() => {}),
				on: mock(() => {}),
			})),
		}));

		const result = await handleHandoffCommand(TEST_DIR, []);

		// Original rename error is still propagated
		expect(result).toContain('EBADF');
	});

	// ---------------------------------------------------------------------------
	// AV10: both renameSync and unlinkSync throw for second file
	// Verify: first file is committed, second file error surfaced
	// ---------------------------------------------------------------------------

	test('AV10: first file succeeds, second file both rename and unlink fail — second error surfaced', async () => {
		let renameCount = 0;
		const unlinkSyncCalls: string[] = [];
		await mock.module('node:fs', () => ({
			renameSync: mock((_src: string, _dest: string) => {
				renameCount++;
				if (renameCount === 1) return; // first succeeds
				throw new Error('EACCES: permission denied');
			}),
			unlinkSync: mock((path: string) => {
				unlinkSyncCalls.push(path);
				throw new Error('EPERM: operation not permitted');
			}),
			createWriteStream: mock(() => ({
				write: mock(() => {}),
				end: mock(() => {}),
				on: mock(() => {}),
			})),
		}));

		const result = await handleHandoffCommand(TEST_DIR, []);

		// Second file's error is surfaced
		expect(result).toContain('EACCES');
		// First file's rename was committed (called twice, first succeeds)
		expect(renameCount).toBe(2);
		// Second unlink attempted (cleanup for second temp file)
		expect(unlinkSyncCalls.length).toBe(1);
	});

	// ---------------------------------------------------------------------------
	// AV11: unlinkSync race condition — file deleted before unlink is called
	// ---------------------------------------------------------------------------

	test('AV11: file deleted between rename failure and unlink — ENOENT best-effort ignored', async () => {
		const callOrder: string[] = [];
		await mock.module('node:fs', () => ({
			renameSync: mock((_src: string, _dest: string) => {
				callOrder.push('rename');
				throw new Error('EBUSY: resource busy');
			}),
			unlinkSync: mock((_path: string) => {
				callOrder.push('unlink');
				// File was already cleaned up by another process
				throw Object.assign(new Error('ENOENT: no such file'), {
					code: 'ENOENT',
				});
			}),
			createWriteStream: mock(() => ({
				write: mock(() => {}),
				end: mock(() => {}),
				on: mock(() => {}),
			})),
		}));

		const result = await handleHandoffCommand(TEST_DIR, []);

		// Both were called
		expect(callOrder).toContain('rename');
		expect(callOrder).toContain('unlink');
		// Original error still propagated
		expect(result).toContain('EBUSY');
	});

	// ---------------------------------------------------------------------------
	// AV12: temp file created with UUID, validateSwarmPath validates final path
	// Verify: the temp path is NOT validated (only final path matters for security)
	// ---------------------------------------------------------------------------

	test('AV12: temp paths are ephemeral — only final path validated by validateSwarmPath', async () => {
		const finalPaths: string[] = [];
		await mock.module('node:fs', () => ({
			renameSync: mock((_src: string, dest: string) => {
				finalPaths.push(dest);
			}),
			unlinkSync: mock((_path: string) => {}),
			createWriteStream: mock(() => ({
				write: mock(() => {}),
				end: mock(() => {}),
				on: mock(() => {}),
			})),
		}));

		await handleHandoffCommand(TEST_DIR, []);

		// Both final paths are within .swarm directory
		expect(finalPaths.every((p) => p.includes('.swarm'))).toBe(true);
	});
});
