/**
 * Tests for recordTaskAttempt — the production producer for
 * `.swarm/run-memory.jsonl`.
 *
 * Before this producer existed, `recordOutcome` / `getTaskHistory` had zero
 * production callers, nothing ever wrote the file, and `getRunMemorySummary`
 * (knowledge-injector.ts) could only ever yield nothing. These tests pin the
 * producer AND the producer→consumer round trip, so a regression that silently
 * stops writing is caught by the summary assertion rather than passing because
 * "no entries" still looks like a valid state.
 *
 * Uses real filesystem temp dirs and the `_internals` DI seam (AGENTS.md
 * invariant 7) rather than `mock.module`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import {
	_internals,
	generateTaskFingerprint,
	getRunMemorySummary,
	getTaskHistory,
	type RunMemoryEntry,
	recordOutcome,
	recordTaskAttempt,
} from '../../../src/services/run-memory';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

let tmpDir: string;
const realInternals = { ..._internals };

async function readEntries(directory: string): Promise<RunMemoryEntry[]> {
	const raw = await readFile(
		path.join(directory, '.swarm', 'run-memory.jsonl'),
		'utf-8',
	);
	return raw
		.split('\n')
		.filter((line) => line.trim())
		.map((line) => JSON.parse(line) as RunMemoryEntry);
}

beforeEach(async () => {
	tmpDir = canonicalMkdtemp('run-memory-recorder-');
	await fs.mkdir(path.join(tmpDir, '.swarm'), { recursive: true });
});

afterEach(async () => {
	Object.assign(_internals, realInternals);
	try {
		await fs.rm(tmpDir, { recursive: true, force: true });
	} catch {
		// Ignore cleanup errors
	}
});

describe('recordTaskAttempt — writes with an absolute workspace root', () => {
	it('writes an entry when given an absolute project root', async () => {
		// Regression guard: the absolute root is the ONLY shape production ever
		// passes (ctx.directory). A relative-path-only validator here is what
		// made the whole feature dead code.
		expect(path.isAbsolute(tmpDir)).toBe(true);

		await recordTaskAttempt(tmpDir, {
			taskId: '1.1',
			agent: 'coder',
			outcome: 'fail',
			failureReason: 'QA gate: reviewer gate required',
		});

		const entries = await readEntries(tmpDir);
		expect(entries).toHaveLength(1);
		expect(entries[0].taskId).toBe('1.1');
		expect(entries[0].agent).toBe('coder');
		expect(entries[0].outcome).toBe('fail');
		expect(entries[0].failureReason).toBe('QA gate: reviewer gate required');
		expect(entries[0].attemptNumber).toBe(1);
		expect(entries[0].timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
	});

	it('derives an increasing attemptNumber per task', async () => {
		await recordTaskAttempt(tmpDir, {
			taskId: '1.1',
			agent: 'coder',
			outcome: 'fail',
			failureReason: 'first',
		});
		await recordTaskAttempt(tmpDir, {
			taskId: '1.1',
			agent: 'coder',
			outcome: 'fail',
			failureReason: 'second',
		});
		await recordTaskAttempt(tmpDir, {
			taskId: '1.1',
			agent: 'coder',
			outcome: 'pass',
		});

		const entries = await readEntries(tmpDir);
		expect(entries.map((e) => e.attemptNumber)).toEqual([1, 2, 3]);
	});

	it('counts attempts per task, not globally', async () => {
		await recordTaskAttempt(tmpDir, {
			taskId: '1.1',
			agent: 'coder',
			outcome: 'fail',
			failureReason: 'x',
		});
		await recordTaskAttempt(tmpDir, {
			taskId: '2.4',
			agent: 'coder',
			outcome: 'fail',
			failureReason: 'y',
		});
		await recordTaskAttempt(tmpDir, {
			taskId: '1.1',
			agent: 'coder',
			outcome: 'pass',
		});

		expect(
			(await getTaskHistory(tmpDir, '1.1')).map((e) => e.attemptNumber),
		).toEqual([1, 2]);
		expect(
			(await getTaskHistory(tmpDir, '2.4')).map((e) => e.attemptNumber),
		).toEqual([1]);
	});

	it('derives the fingerprint from taskId + fileTargets', async () => {
		await recordTaskAttempt(tmpDir, {
			taskId: '3.2',
			agent: 'coder',
			outcome: 'pass',
			fileTargets: ['src/b.ts', 'src/a.ts'],
		});

		const entries = await readEntries(tmpDir);
		// Same value the store's own fingerprint helper produces, and stable
		// under file-order changes.
		expect(entries[0].taskFingerprint).toBe(
			generateTaskFingerprint('3.2', ['src/a.ts', 'src/b.ts']),
		);
		expect(entries[0].filesModified).toEqual(['src/b.ts', 'src/a.ts']);
	});

	it('omits optional fields that were not supplied', async () => {
		await recordTaskAttempt(tmpDir, {
			taskId: '1.1',
			agent: 'coder',
			outcome: 'pass',
		});

		const entries = await readEntries(tmpDir);
		expect(entries[0]).not.toHaveProperty('failureReason');
		expect(entries[0]).not.toHaveProperty('filesModified');
		expect(entries[0]).not.toHaveProperty('durationMs');
	});

	it('records durationMs when supplied, including 0', async () => {
		await recordTaskAttempt(tmpDir, {
			taskId: '1.1',
			agent: 'coder',
			outcome: 'pass',
			durationMs: 0,
		});

		const entries = await readEntries(tmpDir);
		expect(entries[0].durationMs).toBe(0);
	});
});

describe('recordTaskAttempt — producer feeds the injector consumer', () => {
	it('a fail then a pass renders as "Passed on attempt N" in the summary', async () => {
		// The end-to-end contract: what the producer writes must be what
		// getRunMemorySummary (knowledge-injector.ts) can render back.
		await recordTaskAttempt(tmpDir, {
			taskId: '1.1',
			agent: 'coder',
			outcome: 'fail',
			failureReason: 'QA gate: reviewer gate required',
		});
		await recordTaskAttempt(tmpDir, {
			taskId: '1.1',
			agent: 'coder',
			outcome: 'pass',
		});

		const summary = await getRunMemorySummary(tmpDir);
		expect(summary).not.toBeNull();
		expect(summary).toContain('RUN MEMORY');
		expect(summary).toContain('Task 1.1: FAILED attempt 1');
		expect(summary).toContain('reviewer gate required');
		expect(summary).toContain('Passed on attempt 2');
	});

	it('a still-failing task renders as "Still failing"', async () => {
		await recordTaskAttempt(tmpDir, {
			taskId: '2.1',
			agent: 'coder',
			outcome: 'fail',
			failureReason: 'council gate: insufficient quorum',
		});

		const summary = await getRunMemorySummary(tmpDir);
		expect(summary).toContain('Task 2.1: FAILED 1 times');
		expect(summary).toContain('insufficient quorum');
		expect(summary).toContain('Still failing');
	});

	it('a pass that PREDATES the failure does not mark the task resolved', async () => {
		// completed -> blocked is a permitted transition (settled guards protect
		// only `in_progress`), so a task can pass and later regress. Reporting
		// "Passed on attempt 1" for a currently-blocked task inverts the truth.
		await recordTaskAttempt(tmpDir, {
			taskId: '1.1',
			agent: 'coder',
			outcome: 'pass',
		});
		await recordTaskAttempt(tmpDir, {
			taskId: '1.1',
			agent: 'coder',
			outcome: 'fail',
			failureReason: 'regressed: blocked after completion',
		});

		const summary = await getRunMemorySummary(tmpDir);
		expect(summary).toContain('Still failing');
		expect(summary).not.toContain('Passed on attempt');
	});

	it('orders by log position, not timestamp, when timestamps tie', async () => {
		// Regression: ISO timestamps have millisecond resolution, and two entries
		// recorded back-to-back routinely share a millisecond on a fast host. When
		// summarizeTask compared timestamps, an equal pair made a regression look
		// resolved — this failed the ubuntu CI shard while passing on Windows.
		// Written through recordOutcome so both entries carry the SAME timestamp
		// deterministically, instead of racing the clock.
		const SAME = '2026-01-01T00:00:00.000Z';
		await recordOutcome(tmpDir, {
			timestamp: SAME,
			taskId: '1.1',
			taskFingerprint: 'aaaa1111',
			agent: 'coder',
			outcome: 'pass',
			attemptNumber: 1,
		});
		await recordOutcome(tmpDir, {
			timestamp: SAME,
			taskId: '1.1',
			taskFingerprint: 'aaaa1111',
			agent: 'coder',
			outcome: 'fail',
			attemptNumber: 2,
			failureReason: 'regressed after completion',
		});

		// The fail is LATER in the append-only log, so the task is still failing.
		const summary = await getRunMemorySummary(tmpDir);
		expect(summary).toContain('Still failing');
		expect(summary).not.toContain('Passed on attempt');
	});

	it('a tied-timestamp pass AFTER the failure still resolves it', async () => {
		// The mirror case: position order must also let a genuine fix register.
		const SAME = '2026-01-01T00:00:00.000Z';
		await recordOutcome(tmpDir, {
			timestamp: SAME,
			taskId: '2.1',
			taskFingerprint: 'bbbb2222',
			agent: 'coder',
			outcome: 'fail',
			attemptNumber: 1,
			failureReason: 'QA gate: reviewer missing',
		});
		await recordOutcome(tmpDir, {
			timestamp: SAME,
			taskId: '2.1',
			taskFingerprint: 'bbbb2222',
			agent: 'coder',
			outcome: 'pass',
			attemptNumber: 2,
		});

		const summary = await getRunMemorySummary(tmpDir);
		expect(summary).toContain('Passed on attempt 2');
		expect(summary).not.toContain('Still failing');
	});

	it('a pass-only task produces no summary (no noise for healthy tasks)', async () => {
		await recordTaskAttempt(tmpDir, {
			taskId: '1.1',
			agent: 'coder',
			outcome: 'pass',
		});

		expect(await getRunMemorySummary(tmpDir)).toBeNull();
	});
});

describe('recordTaskAttempt — advisory-only, fail-open', () => {
	it('does not throw when the workspace root is invalid', async () => {
		// The caller (update_task_status) must never fail a real status update
		// because run-memory bookkeeping could not be written.
		await expect(
			recordTaskAttempt('../escape', {
				taskId: '1.1',
				agent: 'coder',
				outcome: 'pass',
			}),
		).resolves.toBeUndefined();
	});

	it('does not throw when the underlying append fails', async () => {
		_internals.recordOutcome = async () => {
			throw new Error('disk full');
		};

		await expect(
			recordTaskAttempt(tmpDir, {
				taskId: '1.1',
				agent: 'coder',
				outcome: 'pass',
			}),
		).resolves.toBeUndefined();
	});

	it('still records when history cannot be read (attempt falls back to 1)', async () => {
		_internals.getTaskHistory = async () => {
			throw new Error('unreadable');
		};

		await recordTaskAttempt(tmpDir, {
			taskId: '1.1',
			agent: 'coder',
			outcome: 'fail',
			failureReason: 'QA gate: reviewer missing',
		});

		// The entry must SURVIVE a history-read failure. Dropping it would lose a
		// real gate failure — fail-open on the caller must not mean fail-closed on
		// the data. Restore the seam before reading back.
		Object.assign(_internals, realInternals);
		const history = await getTaskHistory(tmpDir, '1.1');
		expect(history).toHaveLength(1);
		expect(history[0].outcome).toBe('fail');
		expect(history[0].failureReason).toBe('QA gate: reviewer missing');
		expect(history[0].attemptNumber).toBe(1);
	});
});
