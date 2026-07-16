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
// Per-test rename tracking for failure injection
// Plain-object approach avoids bun:test mock call-count issues with
// reassigned _internals functions.
// =============================================================================
type RenameTracker = {
	issueRefRenameCount: number;
	issueRefFailAfter: number;
	errorMsg: string;
	orig: typeof fsSync.renameSync;
};
let renameTracker: RenameTracker;

/**
 * Inject renameSync failure that persists: throw on rename calls for
 * 'issue-reference.json' after call N. Other files (trace-state, rollback)
 * always succeed. This bypasses atomicWriteFileSync's internal retry loop
 * (which catches the first throw and retries), so we fail on all subsequent
 * calls to ensure the error propagates.
 *
 * To trigger rollback, we fail only on issue-reference renames after the first
 * attempt, leaving trace-state and rollback unaffected.
 */
function makeIssueReferenceRenameFailAfter(n: number, errorMsg: string) {
	renameTracker.issueRefRenameCount = 0;
	renameTracker.issueRefFailAfter = n;
	renameTracker.errorMsg = errorMsg;
	_internals.renameSync = (tmpPath: string, finalPath: string) => {
		const isIssueRef = finalPath.endsWith('issue-reference.json');
		if (isIssueRef) {
			renameTracker.issueRefRenameCount++;
			if (renameTracker.issueRefRenameCount > renameTracker.issueRefFailAfter) {
				throw Object.assign(new Error(renameTracker.errorMsg), {
					code: 'TEST',
				});
			}
		}
		return renameTracker.orig(tmpPath, finalPath);
	};
}

describe('handleIssueCommand — durable persistence (issue.ts)', () => {
	beforeEach(() => {
		// Fresh temp dir per test
		tempDir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'issue-persist-'));
		swarmDir = path.join(tempDir, '.swarm');

		// Reset spawnSync mock
		spawnSyncMock.mockClear();
		urlSecurityInternals.spawnSync =
			spawnSyncMock as typeof urlSecurityInternals.spawnSync;

		// Set up renameTracker with the REAL renameSync (not a mock)
		renameTracker = {
			issueRefRenameCount: 0,
			issueRefFailAfter: Infinity, // don't fail by default
			errorMsg: '',
			orig: _internals.renameSync,
		};
		// Restore to real (idempotent)
		_internals.renameSync = renameTracker.orig;
	});

	afterEach(() => {
		// Restore spawnSync (explicit, no mock.restore() to avoid global reset)
		urlSecurityInternals.spawnSync = realSpawnSync;

		// Restore renameSync to real
		_internals.renameSync = renameTracker.orig;

		// Clean up temp dir — best effort
		try {
			fsSync.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// ignore cleanup errors
		}
	});

	// =============================================================================
	// Test 1: Happy path — both artifacts written with correct fields
	// =============================================================================
	test('SUCCESS: writes issue-reference.json and issue-trace-state.json', () => {
		const result = handleIssueCommand(tempDir, [
			'https://github.com/owner/repo/issues/42',
		]);

		// Signal returned
		expect(result).toBe(
			'[MODE: ISSUE_INGEST issue="https://github.com/owner/repo/issues/42"]',
		);

		// Both artifacts exist
		const refPath = path.join(swarmDir, 'issue-reference.json');
		const tracePath = path.join(swarmDir, 'issue-trace-state.json');
		expect(fsSync.existsSync(refPath)).toBe(true);
		expect(fsSync.existsSync(tracePath)).toBe(true);

		// issue-reference.json fields
		const ref = JSON.parse(fsSync.readFileSync(refPath, 'utf-8'));
		expect(ref.url).toBe('https://github.com/owner/repo/issues/42');
		expect(ref.owner).toBe('owner');
		expect(ref.repo).toBe('repo');
		expect(ref.number).toBe(42);
		expect(typeof ref.timestamp).toBe('string');
		expect(ref.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO-8601
		expect(ref.flags).toEqual({});

		// issue-trace-state.json fields
		const trace = JSON.parse(fsSync.readFileSync(tracePath, 'utf-8'));
		expect(trace.issueNumber).toBe(42);
		expect(trace.lastTransition).toBe(null);
		expect(trace.completed).toBe(false);
	});

	// =============================================================================
	// Test 2: --plan flag sets flags.plan === true
	// =============================================================================
	test('--plan flag: flags.plan === true in issue-reference.json', () => {
		const result = handleIssueCommand(tempDir, [
			'https://github.com/owner/repo/issues/42',
			'--plan',
		]);

		expect(result).toContain('plan=true');
		expect(result).not.toContain('trace=');

		const refPath = path.join(swarmDir, 'issue-reference.json');
		const ref = JSON.parse(fsSync.readFileSync(refPath, 'utf-8'));
		expect(ref.flags).toEqual({ plan: true });
	});

	// =============================================================================
	// Test 3: --trace flag sets flags.trace === true (implies --plan)
	// =============================================================================
	test('--trace flag: flags.trace === true and flags.plan === true', () => {
		const result = handleIssueCommand(tempDir, [
			'https://github.com/owner/repo/issues/42',
			'--trace',
		]);

		expect(result).toContain('trace=true');
		expect(result).toContain('plan=true');

		const refPath = path.join(swarmDir, 'issue-reference.json');
		const ref = JSON.parse(fsSync.readFileSync(refPath, 'utf-8'));
		expect(ref.flags).toEqual({ plan: true, trace: true });
	});

	// =============================================================================
	// Test 4: --no-repro flag includes noReproWaiver in issue-reference.json
	// =============================================================================
	test('--no-repro flag: adds noReproWaiver {waived:true, reason, timestamp}', () => {
		const result = handleIssueCommand(tempDir, [
			'https://github.com/owner/repo/issues/42',
			'--no-repro',
		]);

		expect(result).toContain('noRepro=true');

		const refPath = path.join(swarmDir, 'issue-reference.json');
		const ref = JSON.parse(fsSync.readFileSync(refPath, 'utf-8'));

		// noReproWaiver present
		expect(ref.noReproWaiver).toBeDefined();
		expect(ref.noReproWaiver.waived).toBe(true);
		expect(ref.noReproWaiver.reason).toBe('--no-repro flag');
		expect(typeof ref.noReproWaiver.timestamp).toBe('string');
		expect(ref.noReproWaiver.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);

		// flags.noRepro present
		expect(ref.flags).toEqual({ noRepro: true });
	});

	// =============================================================================
	// Test 5: First-run (no prior trace-state) — oldTraceState is null, no rollback
	// =============================================================================
	test('first run: old trace-state absent, no rollback attempted', () => {
		// Ensure no trace-state file exists — tempDir is fresh
		const tracePath = path.join(swarmDir, 'issue-trace-state.json');
		expect(fsSync.existsSync(tracePath)).toBe(false);

		const result = handleIssueCommand(tempDir, [
			'https://github.com/owner/repo/issues/99',
		]);

		expect(result).toContain('issue="https://github.com/owner/repo/issues/99"');
		expect(fsSync.existsSync(tracePath)).toBe(true);
	});

	// =============================================================================
	// Test 6: Rollback — second artifact (issue-reference) write fails, trace-state
	//          is rolled back to prior content.
	// =============================================================================
	test('second-write failure: returns error string (not signal), trace-state rolled back', () => {
		// Set up: write existing trace-state so oldTraceState is non-null
		const tracePath = path.join(swarmDir, 'issue-trace-state.json');
		const oldContent = JSON.stringify({
			issueNumber: 7,
			lastTransition: 'spec',
			completed: true,
		});
		fsSync.mkdirSync(swarmDir, { recursive: true });
		fsSync.writeFileSync(tracePath, oldContent, 'utf-8');

		// Fail issue-reference renames after the first (retry also fails → error propagates;
		// trace-state renames always succeed, rollback succeeds)
		makeIssueReferenceRenameFailAfter(0, 'ENOSPC: no space left on device');

		const result = handleIssueCommand(tempDir, [
			'https://github.com/owner/repo/issues/42',
		]);

		// Error string returned (NOT a mode signal)
		expect(result.startsWith('[MODE: ISSUE_INGEST')).toBe(false);
		expect(result).toContain(
			'Error: Failed to persist issue reference durably',
		);
		expect(result).toContain('ENOSPC');

		// Trace-state was rolled back to old content
		const rolledBack = JSON.parse(fsSync.readFileSync(tracePath, 'utf-8'));
		expect(rolledBack.issueNumber).toBe(7);
		expect(rolledBack.lastTransition).toBe('spec');
		expect(rolledBack.completed).toBe(true);

		// issue-reference.json was NOT written (second artifact failed)
		const refPath = path.join(swarmDir, 'issue-reference.json');
		expect(fsSync.existsSync(refPath)).toBe(false);
	});

	// =============================================================================
	// Test 7: Rollback — second write fails AND no prior trace-state, file deleted
	// =============================================================================
	test('second-write failure with no prior state: trace-state file unlinked', () => {
		const tracePath = path.join(swarmDir, 'issue-trace-state.json');
		expect(fsSync.existsSync(tracePath)).toBe(false); // confirm no prior state

		// Fail issue-reference renames after the first (retry fails, error propagates;
		// trace-state write succeeds, then rollback unlinks since no prior state)
		makeIssueReferenceRenameFailAfter(0, 'EIO');

		const result = handleIssueCommand(tempDir, [
			'https://github.com/owner/repo/issues/42',
		]);

		// Error returned
		expect(result).toContain(
			'Error: Failed to persist issue reference durably',
		);

		// Trace-state should NOT exist (was written, then rollback unlinked)
		expect(fsSync.existsSync(tracePath)).toBe(false);
	});

	// =============================================================================
	// Test 8: Persistence failure inside transaction — error string returned, not thrown
	// (mkdirSync throwing is NOT catchable here since it lives outside the try block;
	// we test the inner transaction failure path instead via first-rename failure.)
	// =============================================================================
	test('transaction inner failure: returns error string, never throws', () => {
		// Fail issue-reference renames after the first (retry fails, error propagates)
		makeIssueReferenceRenameFailAfter(0, 'EROFS: read-only file system');

		const result = handleIssueCommand(tempDir, [
			'https://github.com/owner/repo/issues/42',
		]);

		// Returns error string, not a throw
		expect(typeof result).toBe('string');
		expect(result.startsWith('[MODE: ISSUE_INGEST')).toBe(false);
		expect(result).toContain(
			'Error: Failed to persist issue reference durably',
		);
		expect(result).toContain('EROFS');

		// issue-reference.json was NOT written
		const refPath = path.join(swarmDir, 'issue-reference.json');
		expect(fsSync.existsSync(refPath)).toBe(false);
	});
});
