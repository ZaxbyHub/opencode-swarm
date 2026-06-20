/**
 * Concurrent-run protection tests for the curator post-mortem agent (FR-009).
 *
 * Uses the _internals DI seam — no mock.module.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
	_internals,
	runCuratorPostMortem,
} from '../../../src/hooks/curator-postmortem.js';

// ============================================================================
// Helpers
// ============================================================================

function makeTempDir(): string {
	return mkdtempSync(path.join(os.tmpdir(), 'postmortem-concurrency-test-'));
}

function ensureSwarmDir(dir: string): string {
	const swarmDir = path.join(dir, '.swarm');
	mkdirSync(swarmDir, { recursive: true });
	return swarmDir;
}

function writePlan(dir: string): void {
	const swarmDir = ensureSwarmDir(dir);
	writeFileSync(
		path.join(swarmDir, 'plan.json'),
		JSON.stringify({
			schema_version: '1.0.0',
			title: 'Concurrency Test Project',
			swarm: 'test',
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					status: 'complete',
					tasks: [],
				},
			],
		}),
	);
}

function getExpectedReportPath(dir: string): string {
	return path.join(
		dir,
		'.swarm',
		'post-mortem-test-Concurrency_Test_Project.md',
	);
}

// ============================================================================
// Tests
// ============================================================================

describe('FR-009 — concurrent-run protection', () => {
	let originalAcquireLock: typeof _internals.acquirePostMortemLock;

	beforeEach(() => {
		originalAcquireLock = _internals.acquirePostMortemLock;
	});

	afterEach(() => {
		_internals.acquirePostMortemLock = originalAcquireLock;
	});

	test('returns success:false with concurrent warning when lock is not acquired', async () => {
		const dir = makeTempDir();
		writePlan(dir);

		const reportPath = getExpectedReportPath(dir);
		const releaseSpy = mock(() => Promise.resolve());

		_internals.acquirePostMortemLock = mock(
			async () =>
				({ acquired: false, release: releaseSpy }) as {
					acquired: false;
					release?: () => Promise<void>;
				},
		);

		const result = await runCuratorPostMortem(dir);

		expect(result.success).toBe(false);
		expect(result.warnings).toContain(
			'Concurrent post-mortem run in progress for plan test-Concurrency_Test_Project; skipped.',
		);
		// The report should NOT have been written when lock contention is detected
		expect(existsSync(reportPath)).toBe(false);
		// release must not be called when lock was not acquired
		expect(releaseSpy).not.toHaveBeenCalled();

		rmSync(dir, { recursive: true, force: true });
	});

	test('proceeds normally and calls release exactly once when lock is acquired', async () => {
		const dir = makeTempDir();
		writePlan(dir);

		const reportPath = getExpectedReportPath(dir);
		const releaseSpy = mock(() => Promise.resolve());

		_internals.acquirePostMortemLock = mock(
			async () =>
				({ acquired: true, release: releaseSpy }) as {
					acquired: true;
					release: () => Promise<void>;
				},
		);

		const result = await runCuratorPostMortem(dir);

		expect(result.success).toBe(true);
		expect(result.reportPath).toBe(reportPath);
		expect(existsSync(reportPath)).toBe(true);
		const content = readFileSync(reportPath, 'utf-8');
		expect(content).toContain('Post-Mortem Report');
		expect(releaseSpy).toHaveBeenCalledTimes(1);

		rmSync(dir, { recursive: true, force: true });
	});

	test('release is called even when report generation throws', async () => {
		const dir = makeTempDir();
		writePlan(dir);

		const reportPath = getExpectedReportPath(dir);
		const releaseSpy = mock(() => Promise.resolve());

		_internals.acquirePostMortemLock = mock(
			async () =>
				({ acquired: true, release: releaseSpy }) as {
					acquired: true;
					release: () => Promise<void>;
				},
		);

		// Inject a failure in report generation by replacing the buildDataOnlyReport
		// seam. The no-delegate path calls _internals.buildDataOnlyReport directly,
		// so a throw here escapes the inner try/catch and propagates through the
		// outer finally, exercising lock release.
		const originalBuild = _internals.buildDataOnlyReport;
		_internals.buildDataOnlyReport = mock(() => {
			throw new Error('Simulated report generation failure');
		});

		try {
			// The function should propagate the throw (no llmDelegate to catch it).
			// The key assertion is that release was still called via finally.
			await expect(runCuratorPostMortem(dir)).rejects.toThrow(
				'Simulated report generation failure',
			);
			expect(releaseSpy).toHaveBeenCalledTimes(1);
		} finally {
			_internals.buildDataOnlyReport = originalBuild;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('normal run leaves no lock leak — release called once', async () => {
		const dir = makeTempDir();
		writePlan(dir);

		const releaseSpy = mock(() => Promise.resolve());

		_internals.acquirePostMortemLock = mock(
			async () =>
				({ acquired: true, release: releaseSpy }) as {
					acquired: true;
					release: () => Promise<void>;
				},
		);

		await runCuratorPostMortem(dir);

		expect(releaseSpy).toHaveBeenCalledTimes(1);

		rmSync(dir, { recursive: true, force: true });
	});
});
