import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { checkReviewerGate } from '../../../src/tools/update-task-status';
import { canonicalTmpDir } from '../../helpers/tmpdir.js';

describe('issue #2098 reviewer decision contradictions', () => {
	let directory: string | undefined;

	afterEach(() => {
		if (directory) fs.rmSync(directory, { recursive: true, force: true });
		directory = undefined;
	});

	test('fails closed when workflow claims tests_run but Stage A proof is absent', () => {
		directory = fs.realpathSync(
			fs.mkdtempSync(
				path.join(canonicalTmpDir(), 'reviewer-contradiction-2098-'),
			),
		);
		const evidenceDirectory = path.join(directory, '.swarm', 'evidence');
		fs.mkdirSync(evidenceDirectory, { recursive: true });
		fs.writeFileSync(
			path.join(evidenceDirectory, '1.1.json'),
			JSON.stringify({
				taskId: '1.1',
				required_gates: ['reviewer', 'test_engineer'],
				gates: {
					reviewer: {
						sessionId: 'review',
						timestamp: '2026-08-14T00:00:00.000Z',
						agent: 'reviewer',
					},
					test_engineer: {
						sessionId: 'test',
						timestamp: '2026-08-14T00:00:01.000Z',
						agent: 'test_engineer',
					},
				},
				workflow: {
					schema: 'exact-task-v1',
					generation: 2,
					state: 'tests_run',
					retryCount: 0,
					lastOutcome: 'stage_b_completed',
					lastTransitionId: 'forged-stage-b',
					updatedAt: '2026-08-14T00:00:01.000Z',
				},
			}),
		);

		const decision = checkReviewerGate(
			'1.1',
			directory,
			false,
			'session',
			directory,
		);

		expect(decision.blocked).toBe(true);
		expect(decision.missingGates).toContain('pre_check');
		expect(decision.contradictorySignals).toEqual([
			'workflow state tests_run claims completion readiness while required proof is missing',
		]);
	});

	test('fails closed when evidence filename and payload task identities differ', () => {
		directory = fs.realpathSync(
			fs.mkdtempSync(path.join(canonicalTmpDir(), 'reviewer-identity-2098-')),
		);
		const evidenceDirectory = path.join(directory, '.swarm', 'evidence');
		fs.mkdirSync(evidenceDirectory, { recursive: true });
		fs.writeFileSync(
			path.join(evidenceDirectory, '1.1.json'),
			JSON.stringify({
				taskId: '2.1',
				required_gates: [],
				gates: {},
				workflow: {
					schema: 'exact-task-v1',
					generation: 0,
					state: 'idle',
					retryCount: 0,
					lastOutcome: 'none',
					lastTransitionId: null,
					updatedAt: '2026-08-14T00:00:00.000Z',
				},
			}),
		);

		const decision = checkReviewerGate(
			'1.1',
			directory,
			false,
			'session',
			directory,
		);

		expect(decision.blocked).toBe(true);
		expect(decision.corrupt).toBe(true);
		expect(decision.reason).toContain('TASK_EVIDENCE_IDENTITY_MISMATCH');
	});
});
