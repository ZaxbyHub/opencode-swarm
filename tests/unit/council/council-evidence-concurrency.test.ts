/**
 * Regression: writeCouncilEvidence must serialize with the delegation-gate
 * hook's gate-evidence writes on the same .swarm/evidence/{taskId}.json (#978).
 *
 * Before the fix, writeCouncilEvidence did an unlocked, non-atomic
 * read-modify-write while gate-evidence.ts guarded the same file with
 * withEvidenceLock + atomic temp+rename. Concurrent writers could lose updates
 * (a council write clobbering a freshly-recorded gate entry) or read a torn
 * file. The fix routes the council write through the same shared lock + atomic
 * write.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	_internals,
	writeCouncilEvidence,
} from '../../../src/council/council-evidence-writer';
import type { CouncilSynthesis } from '../../../src/council/types';
import { EvidenceLockTimeoutError } from '../../../src/evidence/lock';
import {
	taskEvidencePath,
	withTaskEvidenceLock,
} from '../../../src/evidence/task-file';
import { recordGateEvidence } from '../../../src/gate-evidence';

let tempDir: string;

const makeSynthesis = (
	overrides: Partial<CouncilSynthesis> = {},
): CouncilSynthesis => ({
	taskId: '1.1',
	swarmId: 'swarm-1',
	timestamp: '2026-04-13T00:00:00.000Z',
	overallVerdict: 'APPROVE',
	vetoedBy: null,
	memberVerdicts: [],
	unresolvedConflicts: [],
	requiredFixes: [],
	advisoryFindings: [],
	unifiedFeedbackMd: '',
	roundNumber: 1,
	allCriteriaMet: true,
	quorumSize: 3,
	blockingConcernsCount: 0,
	...overrides,
});

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), 'council-concurrency-'));
});

afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

describe('council evidence writer — regression: serializes via shared evidence lock (#978)', () => {
	test('council write blocks until the shared lock is released', async () => {
		// Previously the council write ignored the lock and ran immediately,
		// so it could land between another writer's read and write. With the fix
		// it must wait for the held lock before writing.
		const order: string[] = [];
		let councilPromise: Promise<void> | undefined;

		await withTaskEvidenceLock(tempDir, '1.1', 'holder', async () => {
			// Start the council write while we still hold the lock. Do NOT await it
			// here — capture the promise so we can await it after releasing.
			councilPromise = writeCouncilEvidence(tempDir, makeSynthesis()).then(
				() => {
					order.push('council-wrote');
				},
			);
			// Give the council write a window to run if it (incorrectly) bypassed
			// the lock. A broken writer would push 'council-wrote' before this line.
			await Bun.sleep(50);
			order.push('holder-releasing');
		});

		await councilPromise;

		// The held lock must have forced the council write to wait.
		expect(order).toEqual(['holder-releasing', 'council-wrote']);
	});

	test('council write preserves gate entries recorded by the hook path', async () => {
		// Seed the shared {taskId}.json with gate evidence via the locked+atomic
		// gate path, then write council evidence. All entries must coexist — the
		// council write must not clobber the reviewer/test_engineer gates.
		await recordGateEvidence(tempDir, '1.1', 'reviewer', 'sess-1');
		await recordGateEvidence(tempDir, '1.1', 'test_engineer', 'sess-1');

		await writeCouncilEvidence(tempDir, makeSynthesis());

		const evidence = JSON.parse(
			readFileSync(taskEvidencePath(tempDir, '1.1'), 'utf-8'),
		);
		expect(evidence.gates.reviewer).toBeDefined();
		expect(evidence.gates.test_engineer).toBeDefined();
		expect(evidence.gates.council).toBeDefined();
		expect(evidence.gates.council.verdict).toBe('APPROVE');
		// required_gates set by the gate path must survive the council write.
		expect(evidence.required_gates).toEqual(
			expect.arrayContaining(['reviewer', 'test_engineer']),
		);
	});

	test('gate write after council preserves the council entry', async () => {
		// Reverse order: council first, then a gate write. The gate path's
		// read-modify-write must preserve the council entry.
		await writeCouncilEvidence(tempDir, makeSynthesis());
		await recordGateEvidence(tempDir, '1.1', 'reviewer', 'sess-1');

		const evidence = JSON.parse(
			readFileSync(taskEvidencePath(tempDir, '1.1'), 'utf-8'),
		);
		expect(evidence.gates.council).toBeDefined();
		expect(evidence.gates.reviewer).toBeDefined();
	});

	test('concurrent gate write and council write both land (Promise.all interleave)', async () => {
		// F-010: both writers start simultaneously via Promise.all. With the shared
		// lock they must serialize — neither read-modify-write can clobber the other.
		// All entries must survive in the final file regardless of which writer wins
		// the lock race.
		await Promise.all([
			recordGateEvidence(tempDir, '1.1', 'reviewer', 'sess-concurrent'),
			writeCouncilEvidence(tempDir, makeSynthesis()),
		]);

		const evidence = JSON.parse(
			readFileSync(taskEvidencePath(tempDir, '1.1'), 'utf-8'),
		);
		expect(evidence.gates.reviewer).toBeDefined();
		expect(evidence.gates.council).toBeDefined();
		expect(evidence.gates.council.verdict).toBe('APPROVE');
	});
});

describe('council evidence writer — EvidenceLockTimeoutError propagation (#978 F-002)', () => {
	// Save the real withTaskEvidenceLock so we can restore it after each test.
	const realWithTaskEvidenceLock = _internals.withTaskEvidenceLock;

	afterEach(() => {
		_internals.withTaskEvidenceLock = realWithTaskEvidenceLock;
	});

	test('EvidenceLockTimeoutError from the lock propagates out of writeCouncilEvidence', async () => {
		// Arrange: inject a lock that immediately throws EvidenceLockTimeoutError,
		// simulating a deadlocked writer that holds the lock past the timeout.
		const timeout = new EvidenceLockTimeoutError(
			tempDir,
			'evidence/1.1.json',
			'architect',
			'1.1',
			60000,
		);
		_internals.withTaskEvidenceLock = () => Promise.reject(timeout);

		// Act + Assert: the async signature means the error surfaces as a rejection.
		await expect(
			writeCouncilEvidence(tempDir, makeSynthesis()),
		).rejects.toBeInstanceOf(EvidenceLockTimeoutError);

		await expect(
			writeCouncilEvidence(tempDir, makeSynthesis()),
		).rejects.toThrow('Evidence lock timeout after 60000ms');
	});

	test('EvidenceLockTimeoutError carries the correct metadata fields', () => {
		const err = new EvidenceLockTimeoutError(
			'/swarm',
			'evidence/2.3.json',
			'architect',
			'2.3',
			30000,
		);
		expect(err.name).toBe('EvidenceLockTimeoutError');
		expect(err.directory).toBe('/swarm');
		expect(err.evidencePath).toBe('evidence/2.3.json');
		expect(err.agent).toBe('architect');
		expect(err.taskId).toBe('2.3');
		expect(err.message).toContain('30000ms');
	});
});
