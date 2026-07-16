/**
 * Contract tests for durable issue reference persistence in src/commands/issue.ts
 *
 * Focuses on ROLLBACK edge cases and atomic-write guarantees NOT covered by
 * issue-persistence.verification.test.ts (which covers happy-path and basic rollback).
 *
 * Test cases:
 *  1. Rollback (a): Pre-existing trace-state restored on second-write failure
 *  2. Rollback (b): No prior trace-state → unlinkSync on failure
 *  3. Rollback (c): Rollback itself fails → error still returned
 *  4. Rollback (d): Temp file cleaned up after rename failure
 *  5. Atomic write verification: temp file created during write
 *  6. Three input formats: full URL, shorthand, bare number
 *  7. Stale-state isolation: two consecutive calls reset trace-state
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fsSync from 'node:fs';
import os from 'node:os';
import * as path from 'node:path';
import { _internals as urlSecurityInternals } from '../../../src/commands/_shared/url-security';
import { _internals, handleIssueCommand } from '../../../src/commands/issue';

// =============================================================================
// Mock: bare-number resolution requires git remote detection via spawnSync
// =============================================================================
const realSpawnSync = urlSecurityInternals.spawnSync;
const spawnSyncMock = mock(
	(_bin: string, _args: string[], opts: Record<string, unknown>) => {
		if (opts.cwd !== undefined) {
			return {
				status: 0,
				stdout: 'https://github.com/test-owner/test-repo.git',
				error: undefined,
			} as ReturnType<typeof urlSecurityInternals.spawnSync>;
		}
		throw new Error('No remote');
	},
);

// =============================================================================
// Test fixtures
// =============================================================================
let tempDir: string;
let swarmDir: string;

// =============================================================================
// DI seam tracking for renameSync failure injection
// =============================================================================
type RenameTracker = {
	callCount: number;
	failOnTarget: string; // suffix match — e.g., 'issue-reference.json'
	failAfterCount: number;
	errorMsg: string;
	orig: typeof fsSync.renameSync;
};
let renameTracker: RenameTracker;

/**
 * Inject renameSync failure for specific target files after N calls.
 * Non-matching paths always delegate to real renameSync.
 */
function installRenameFailAfter(
	targetSuffix: string,
	afterCount: number,
	errorMsg: string,
): void {
	renameTracker.callCount = 0;
	renameTracker.failOnTarget = targetSuffix;
	renameTracker.failAfterCount = afterCount;
	renameTracker.errorMsg = errorMsg;

	_internals.renameSync = (src: string, dest: string) => {
		if (dest.endsWith(renameTracker.failOnTarget)) {
			renameTracker.callCount++;
			if (renameTracker.callCount > renameTracker.failAfterCount) {
				throw Object.assign(new Error(renameTracker.errorMsg), {
					code: 'TEST_INJECT',
				});
			}
		}
		return renameTracker.orig(src, dest);
	};
}

/**
 * Inject writeFileSync tracking — records all writes to a list.
 */
type WriteTracker = {
	writes: Array<{ path: string; content: string }>;
	orig: typeof fsSync.writeFileSync;
};
let writeTracker: WriteTracker;

function installWriteTracker(): void {
	writeTracker.writes = [];
	_internals.writeFileSync = (
		filePath: string,
		content: string,
		...rest: unknown[]
	) => {
		writeTracker.writes.push({ path: filePath, content });
		return writeTracker.orig(filePath, content, ...rest);
	};
}

// =============================================================================
// DI seam tracking for unlinkSync failure injection
// =============================================================================
type UnlinkTracker = {
	failOnTarget: string;
	errorMsg: string;
	orig: typeof fsSync.unlinkSync;
};
let unlinkTracker: UnlinkTracker;

function installUnlinkFail(targetSuffix: string, errorMsg: string): void {
	unlinkTracker.failOnTarget = targetSuffix;
	unlinkTracker.errorMsg = errorMsg;
	_internals.unlinkSync = (filePath: string) => {
		if (filePath.endsWith(unlinkTracker.failOnTarget)) {
			throw Object.assign(new Error(unlinkTracker.errorMsg), {
				code: 'TEST_UNLINK_FAIL',
			});
		}
		return unlinkTracker.orig(filePath);
	};
}

describe('issue persistence — rollback and atomic-write contracts', () => {
	beforeEach(() => {
		tempDir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'issue-contract-'));
		swarmDir = path.join(tempDir, '.swarm');

		spawnSyncMock.mockClear();
		urlSecurityInternals.spawnSync =
			spawnSyncMock as typeof urlSecurityInternals.spawnSync;

		renameTracker = {
			callCount: 0,
			failOnTarget: '',
			failAfterCount: Infinity,
			errorMsg: '',
			orig: _internals.renameSync,
		};
		_internals.renameSync = renameTracker.orig;

		writeTracker = {
			writes: [],
			orig: _internals.writeFileSync,
		};
		_internals.writeFileSync = writeTracker.orig;

		unlinkTracker = {
			failOnTarget: '',
			errorMsg: '',
			orig: _internals.unlinkSync,
		};
		_internals.unlinkSync = unlinkTracker.orig;
	});

	afterEach(() => {
		urlSecurityInternals.spawnSync = realSpawnSync;
		_internals.renameSync = renameTracker.orig;
		_internals.writeFileSync = writeTracker.orig;
		_internals.unlinkSync = unlinkTracker.orig;

		try {
			fsSync.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			/* best-effort cleanup */
		}
	});

	// =========================================================================
	// ROLLBACK (a): Pre-existing trace-state restored on second-write failure
	// =========================================================================
	test('ROLLBACK (a): pre-existing trace-state content preserved after second-write failure', () => {
		const tracePath = path.join(swarmDir, 'issue-trace-state.json');
		const priorState = JSON.stringify({
			issueNumber: 7,
			lastTransition: 'execute',
			completed: false,
		});
		fsSync.mkdirSync(swarmDir, { recursive: true });
		fsSync.writeFileSync(tracePath, priorState, 'utf-8');

		// Fail issue-reference renames after first attempt (retry also fails)
		installRenameFailAfter('issue-reference.json', 0, 'ENOSPC');

		const result = handleIssueCommand(tempDir, [
			'https://github.com/owner/repo/issues/99',
		]);

		expect(result).toContain('Failed to persist issue reference durably');
		expect(result).toContain('ENOSPC');

		// Trace-state must be restored to the exact prior content
		const restored = fsSync.readFileSync(tracePath, 'utf-8');
		expect(JSON.parse(restored)).toEqual({
			issueNumber: 7,
			lastTransition: 'execute',
			completed: false,
		});

		// issue-reference.json must NOT exist (second write never succeeded)
		const refPath = path.join(swarmDir, 'issue-reference.json');
		expect(fsSync.existsSync(refPath)).toBe(false);
	});

	// =========================================================================
	// ROLLBACK (b): No prior trace-state → unlinkSync called on failure
	// =========================================================================
	test('ROLLBACK (b): no prior trace-state — file unlinked after failure', () => {
		const tracePath = path.join(swarmDir, 'issue-trace-state.json');
		expect(fsSync.existsSync(tracePath)).toBe(false);

		// Fail issue-reference renames — trace-state was freshly written,
		// rollback must unlink it since oldTraceState is null
		installRenameFailAfter('issue-reference.json', 0, 'EIO');

		const result = handleIssueCommand(tempDir, [
			'https://github.com/owner/repo/issues/55',
		]);

		expect(result).toContain('Failed to persist issue reference durably');

		// Trace-state was written during the attempt, then unlinked by rollback
		expect(fsSync.existsSync(tracePath)).toBe(false);
	});

	// =========================================================================
	// ROLLBACK (c): Rollback itself fails → error still returned
	// =========================================================================
	test('ROLLBACK (c): rollback failure — error string still returned', () => {
		const tracePath = path.join(swarmDir, 'issue-trace-state.json');
		const priorState = JSON.stringify({
			issueNumber: 1,
			lastTransition: 'spec',
			completed: true,
		});
		fsSync.mkdirSync(swarmDir, { recursive: true });
		fsSync.writeFileSync(tracePath, priorState, 'utf-8');

		// 1) Fail issue-reference rename
		installRenameFailAfter('issue-reference.json', 0, 'ENOENT');

		// 2) Also fail the rollback rename (trace-state restore)
		//    After the issue-reference fails, atomicWriteFileSync for rollback
		//    will attempt rename of trace-state. We make ALL renames fail.
		const realRename = renameTracker.orig;
		_internals.renameSync = (_src: string, _dest: string) => {
			throw Object.assign(new Error('EPERM: rollback denied'), {
				code: 'TEST_ROLLBACK_FAIL',
			});
		};

		const result = handleIssueCommand(tempDir, [
			'https://github.com/owner/repo/issues/42',
		]);

		// Error string returned despite rollback failure
		expect(result).toContain('Failed to persist issue reference durably');
		expect(result).not.toContain('[MODE: ISSUE_INGEST');

		// Restore for cleanup
		_internals.renameSync = realRename;
	});

	// =========================================================================
	// ROLLBACK (c) variant: unlink fails on no-prior-state rollback
	// =========================================================================
	test('ROLLBACK (c): unlink failure on no-prior rollback — error still returned', () => {
		// No prior trace-state exists, and we'll make the unlink during rollback fail
		installRenameFailAfter('issue-reference.json', 0, 'EIO');
		installUnlinkFail('issue-trace-state.json', 'EPERM: cannot delete');

		const result = handleIssueCommand(tempDir, [
			'https://github.com/owner/repo/issues/42',
		]);

		expect(result).toContain('Failed to persist issue reference durably');
	});

	// =========================================================================
	// ROLLBACK (d): Temp file cleaned up after rename failure
	//
	// When the SECOND artifact rename fails, atomicWriteFileSync's retry path
	// unlinks the target and retries. If we fail that too, the temp file from
	// the *second* write may remain. The important contract is that no temp
	// files for *succeeded* writes remain and the error propagates correctly.
	// =========================================================================
	test('ROLLBACK (d): no temp files for successful artifacts after failure', () => {
		// Write a pre-existing trace-state so rollback path runs
		const tracePath = path.join(swarmDir, 'issue-trace-state.json');
		fsSync.mkdirSync(swarmDir, { recursive: true });
		fsSync.writeFileSync(
			tracePath,
			JSON.stringify({
				issueNumber: 1,
				lastTransition: null,
				completed: false,
			}),
			'utf-8',
		);

		// Fail ONLY issue-reference renames (trace-state succeeds, rollback succeeds)
		installRenameFailAfter('issue-reference.json', 0, 'EBUSY');

		const result = handleIssueCommand(tempDir, [
			'https://github.com/owner/repo/issues/42',
		]);

		expect(result).toContain('Failed to persist issue reference durably');

		// After rollback, trace-state is restored. No issue-reference temp files
		// should exist (the temp file was from the failed issue-reference write;
		// atomicWriteFileSync's catch block tries unlink+retry and the temp may
		// persist, but the final file must not exist).
		const refPath = path.join(swarmDir, 'issue-reference.json');
		expect(fsSync.existsSync(refPath)).toBe(false);

		// Trace-state must be restored (no temp file for it)
		const restored = JSON.parse(fsSync.readFileSync(tracePath, 'utf-8'));
		expect(restored.issueNumber).toBe(1);

		// No leftover .tmp-* files must remain after rollback
		const leftoverTmp = fsSync
			.readdirSync(swarmDir)
			.filter((f) => f.startsWith('.tmp-'));
		expect(leftoverTmp).toEqual([]);
	});

	// =========================================================================
	// Atomic write verification: temp file path used during write
	// =========================================================================
	test('atomic write: writeFileSync called with .tmp- prefixed path', () => {
		installWriteTracker();

		handleIssueCommand(tempDir, ['https://github.com/owner/repo/issues/42']);

		// At least one write should use a .tmp- prefixed temp path
		const tmpWrites = writeTracker.writes.filter((w) =>
			path.basename(w.path).startsWith('.tmp-'),
		);
		expect(tmpWrites.length).toBeGreaterThanOrEqual(2);

		// Temp paths should be under swarmDir
		for (const w of tmpWrites) {
			expect(path.dirname(w.path)).toBe(swarmDir);
		}

		// Final files should exist
		const refPath = path.join(swarmDir, 'issue-reference.json');
		const tracePath = path.join(swarmDir, 'issue-trace-state.json');
		expect(fsSync.existsSync(refPath)).toBe(true);
		expect(fsSync.existsSync(tracePath)).toBe(true);
	});

	// =========================================================================
	// Atomic write: renameSync called (not just writeFileSync)
	// =========================================================================
	test('atomic write: renameSync invoked after writeFileSync', () => {
		const renameSpy = mock((_src: string, _dest: string) => {
			return renameTracker.orig(_src, _dest);
		});
		_internals.renameSync = renameSpy;

		handleIssueCommand(tempDir, ['https://github.com/owner/repo/issues/42']);

		// renameSync should have been called at least twice (one per artifact)
		expect(renameSpy).toHaveBeenCalledTimes(2);
	});

	// =========================================================================
	// Three input formats: full URL, shorthand, bare number
	// =========================================================================
	test('input format: full URL persists correct owner/repo/number', () => {
		const result = handleIssueCommand(tempDir, [
			'https://github.com/myorg/myrepo/issues/123',
		]);

		expect(result).toContain(
			'issue="https://github.com/myorg/myrepo/issues/123"',
		);

		const refPath = path.join(swarmDir, 'issue-reference.json');
		const ref = JSON.parse(fsSync.readFileSync(refPath, 'utf-8'));
		expect(ref.owner).toBe('myorg');
		expect(ref.repo).toBe('myrepo');
		expect(ref.number).toBe(123);
	});

	test('input format: shorthand owner/repo#N persists correctly', () => {
		const result = handleIssueCommand(tempDir, ['myorg/myrepo#456']);

		expect(result).toContain(
			'issue="https://github.com/myorg/myrepo/issues/456"',
		);

		const refPath = path.join(swarmDir, 'issue-reference.json');
		const ref = JSON.parse(fsSync.readFileSync(refPath, 'utf-8'));
		expect(ref.owner).toBe('myorg');
		expect(ref.repo).toBe('myrepo');
		expect(ref.number).toBe(456);
	});

	test('input format: bare number with mock git remote', () => {
		const result = handleIssueCommand(tempDir, ['789']);

		expect(result).toContain(
			'issue="https://github.com/test-owner/test-repo/issues/789"',
		);

		const refPath = path.join(swarmDir, 'issue-reference.json');
		const ref = JSON.parse(fsSync.readFileSync(refPath, 'utf-8'));
		expect(ref.owner).toBe('test-owner');
		expect(ref.repo).toBe('test-repo');
		expect(ref.number).toBe(789);
	});

	// =========================================================================
	// Stale-state isolation: two consecutive calls reset trace-state
	// =========================================================================
	test('stale-state isolation: second call overwrites trace-state to new issueNumber', () => {
		// First call — issue 42
		handleIssueCommand(tempDir, ['https://github.com/owner/repo/issues/42']);

		const tracePath = path.join(swarmDir, 'issue-trace-state.json');
		const firstTrace = JSON.parse(fsSync.readFileSync(tracePath, 'utf-8'));
		expect(firstTrace.issueNumber).toBe(42);
		expect(firstTrace.completed).toBe(false);

		const firstRefPath = path.join(swarmDir, 'issue-reference.json');
		const firstRef = JSON.parse(fsSync.readFileSync(firstRefPath, 'utf-8'));
		expect(firstRef.number).toBe(42);

		// Second call — issue 99 (different number)
		const secondResult = handleIssueCommand(tempDir, [
			'https://github.com/owner/repo/issues/99',
		]);
		expect(secondResult).toContain(
			'issue="https://github.com/owner/repo/issues/99"',
		);

		// Trace-state is now reset to new issueNumber
		const secondTrace = JSON.parse(fsSync.readFileSync(tracePath, 'utf-8'));
		expect(secondTrace.issueNumber).toBe(99);
		expect(secondTrace.lastTransition).toBe(null);
		expect(secondTrace.completed).toBe(false);

		// issue-reference.json also updated
		const secondRef = JSON.parse(fsSync.readFileSync(firstRefPath, 'utf-8'));
		expect(secondRef.number).toBe(99);
	});
});
