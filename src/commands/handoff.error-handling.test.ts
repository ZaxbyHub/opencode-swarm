/**
 * Error-handling tests for /swarm handoff command.
 * Verifies graceful degradation when file writes fail.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

// ---------------------------------------------------------------------------
// Conditional mock control
// ---------------------------------------------------------------------------
// bunWrite throws by default (true), can be set to false in beforeEach
let bunWriteShouldThrow = true;
let bunWriteCallCount = 0;

// ---------------------------------------------------------------------------
// File-level mocks (applied once at module parse time)
// ---------------------------------------------------------------------------

// Mock bunWrite to throw or succeed based on bunWriteShouldThrow flag
mock.module('../utils/bun-compat', () => ({
	bunWrite: mock(async () => {
		bunWriteCallCount++;
		if (bunWriteShouldThrow) {
			throw new Error('ENOSPC: no space left on device');
		}
		// succeed - no return value needed (bun writes to file)
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

// Mock snapshot-writer to be no-ops
mock.module('../session/snapshot-writer', () => ({
	writeSnapshot: mock(() => Promise.resolve()),
	flushPendingSnapshot: mock(() => Promise.resolve()),
}));

// ---------------------------------------------------------------------------
// Import after mocking
// ---------------------------------------------------------------------------
import { handleHandoffCommand } from './handoff';

describe('handleHandoffCommand', () => {
	const testDirectory = '/test/workspace';

	beforeEach(() => {
		bunWriteShouldThrow = true;
		bunWriteCallCount = 0;
	});

	afterEach(() => {
		mock.restore();
	});

	// ---------------------------------------------------------------------------
	// bunWrite failure tests (existing)
	// ---------------------------------------------------------------------------

	test('returns error message with inline content when bunWrite throws', async () => {
		// Act
		const result = await handleHandoffCommand(testDirectory, []);

		// Assert: result contains "file write failed"
		expect(result).toContain('file write failed');

		// Assert: result includes the handoff content (markdown header)
		expect(result).toContain('## Swarm Handoff');

		// Assert: error details are included
		expect(result).toContain('ENOSPC');
		expect(result).toContain('no space left on device');

		// Assert: indicates content is provided inline for manual copy
		expect(result).toContain(
			'The handoff content is included below for manual copy',
		);
	});

	test('includes handoff markdown content in the fallback response', async () => {
		// Act
		const result = await handleHandoffCommand(testDirectory, []);

		// Assert: the markdown is included after the error header
		// The formatHandoffMarkdown produces "## Swarm Handoff" header
		expect(result).toContain('**Generated**:');

		// Assert: still shows "Handoff Generated" rather than "Brief Written"
		expect(result).toContain('## Handoff Generated (file write failed)');
	});

	test('bunWrite is called but throws, triggering error path', async () => {
		// Act
		await handleHandoffCommand(testDirectory, []);

		// Assert: bunWrite was called at least once (attempted the file write)
		expect(bunWriteCallCount).toBeGreaterThan(0);
	});

	// ---------------------------------------------------------------------------
	// renameSync failure tests — verify unlinkSync cleanup is called
	// ---------------------------------------------------------------------------

	describe('when renameSync throws', () => {
		let unlinkSyncCalls: string[];
		let renameSyncMock: ReturnType<typeof mock>;
		let unlinkSyncMock: ReturnType<typeof mock>;

		beforeEach(() => {
			// bunWrite should succeed to reach renameSync
			bunWriteShouldThrow = false;
			unlinkSyncCalls = [];

			renameSyncMock = mock((_tempPath: string, _resolvedPath: string) => {
				throw Object.assign(new Error('EBUSY: resource busy'), {
					code: 'EBUSY',
				});
			});
			unlinkSyncMock = mock((path: string) => {
				unlinkSyncCalls.push(path);
			});
		});

		test('returns fallback content when renameSync throws on handoff.md', async () => {
			// Arrange: mock node:fs
			await mock.module('node:fs', () => ({
				renameSync: renameSyncMock,
				unlinkSync: unlinkSyncMock,
			}));

			// Re-import to get fresh module with mock applied
			const { handleHandoffCommand: cmd } = await import('./handoff');

			// Act
			const result = await cmd(testDirectory, []);

			// Assert: returns fallback (not "Brief Written")
			expect(result).toContain('## Handoff Generated (file write failed)');
			expect(result).toContain('EBUSY');
		});

		test('calls unlinkSync when renameSync throws on handoff.md', async () => {
			// Arrange
			await mock.module('node:fs', () => ({
				renameSync: renameSyncMock,
				unlinkSync: unlinkSyncMock,
			}));

			const { handleHandoffCommand: cmd } = await import('./handoff');

			// Act
			await cmd(testDirectory, []);

			// Assert: unlinkSync was called exactly once (handoff.md temp file)
			expect(unlinkSyncCalls.length).toBe(1);
			// The unlinked path should be the handoff.md temp path (ends with .tmp.<uuid>)
			expect(unlinkSyncCalls[0]).toMatch(/\.tmp\.[a-f0-9-]+$/);
			expect(unlinkSyncCalls[0]).toContain('handoff.md');
		});

		test('calls unlinkSync when renameSync throws on handoff-prompt.md', async () => {
			// Arrange: first rename succeeds, second throws
			let renameCount = 0;
			renameSyncMock = mock((_tempPath: string, _resolvedPath: string) => {
				renameCount++;
				if (renameCount === 1) return; // first rename succeeds
				throw Object.assign(new Error('EIO: I/O error'), { code: 'EIO' });
			});

			await mock.module('node:fs', () => ({
				renameSync: renameSyncMock,
				unlinkSync: unlinkSyncMock,
			}));

			const { handleHandoffCommand: cmd } = await import('./handoff');

			// Act
			const result = await cmd(testDirectory, []);

			// Assert: returns fallback due to prompt rename failure
			expect(result).toContain('## Handoff Generated (file write failed)');
			// Assert: unlinkSync was called exactly once (prompt temp file cleanup)
			expect(unlinkSyncCalls.length).toBe(1);
			expect(unlinkSyncCalls[0]).toContain('handoff-prompt.md');
		});
	});

	// ---------------------------------------------------------------------------
	// bunWrite failure — no unlinkSync (no temp file exists)
	// ---------------------------------------------------------------------------

	test('unlinkSync is NOT called when bunWrite throws (no temp file exists)', async () => {
		// Arrange: bunWrite throws (via flag), no unlinkSync should be called
		const unlinkSyncCalls: string[] = [];
		const unlinkSyncMock = mock((path: string) => {
			unlinkSyncCalls.push(path);
		});

		await mock.module('node:fs', () => ({
			renameSync: mock(() => {}),
			unlinkSync: unlinkSyncMock,
		}));

		const { handleHandoffCommand: cmd } = await import('./handoff');

		// Act
		await cmd(testDirectory, []);

		// Assert: unlinkSync was never called because no temp file was created
		expect(unlinkSyncCalls.length).toBe(0);
	});

	// ---------------------------------------------------------------------------
	// Happy path tests
	// ---------------------------------------------------------------------------

	test('happy path: all operations succeed, unlinkSync never called', async () => {
		// Arrange: bunWrite and renameSync succeed (need to set flag)
		bunWriteShouldThrow = false;
		const unlinkSyncCalls: string[] = [];
		let renameCount = 0;

		const renameSyncMock = mock((_tempPath: string, _resolvedPath: string) => {
			renameCount++;
		});
		const unlinkSyncMock = mock((path: string) => {
			unlinkSyncCalls.push(path);
		});

		await mock.module('node:fs', () => ({
			renameSync: renameSyncMock,
			unlinkSync: unlinkSyncMock,
		}));

		const { handleHandoffCommand: cmd } = await import('./handoff');

		// Act
		const result = await cmd(testDirectory, []);

		// Assert: success message, no fallback
		expect(result).toContain('## Handoff Brief Written');
		expect(result).not.toContain('file write failed');

		// Assert: unlinkSync was never called (no errors occurred)
		expect(unlinkSyncCalls.length).toBe(0);

		// Assert: renameSync was called twice (handoff.md and handoff-prompt.md)
		expect(renameCount).toBe(2);
	});
});
