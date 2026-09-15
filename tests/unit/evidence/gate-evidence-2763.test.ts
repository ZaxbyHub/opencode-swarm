import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { hasPassedAllGates } from '../../../src/gate-evidence';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

let directory: string;

beforeEach(() => {
	directory = canonicalMkdtemp('gate-evidence-2763-');
	mkdirSync(path.join(directory, '.swarm', 'evidence'), { recursive: true });
});

afterEach(() => {
	rmSync(directory, { recursive: true, force: true });
});

function writeEvidence(
	taskId: string,
	evidence: Record<string, unknown>,
): void {
	writeFileSync(
		path.join(directory, '.swarm', 'evidence', `${taskId}.json`),
		JSON.stringify({ taskId, ...evidence }),
	);
}

describe('hasPassedAllGates applicability (#2763)', () => {
	test('accepts trusted empty-scope no-mutation evidence', async () => {
		writeEvidence('1.1', {
			required_gates: [],
			gates: {},
			workflow: {
				schema: 'exact-task-v1',
				generation: 0,
				state: 'idle',
				retryCount: 1,
				retryHistory: ['dispatch_no_mutation'],
				retryEpoch: 1,
				lastOutcome: 'dispatch_no_mutation',
				lastTransitionId: 'settlement-1.1',
				updatedAt: '2026-09-14T00:00:00.000Z',
				noMutationSettlement: {
					generation: 0,
					transitionId: 'settlement-1.1',
					declaredFiles: [],
				},
			},
		});

		let filesTouched: string[] = [];
		expect(await hasPassedAllGates(directory, '1.1', filesTouched)).toBe(true);

		// The plan task's current scope is supplied from loadPlan's ledger-replayed
		// task object by phase_complete. Expanding it after the old settlement must
		// revoke the read-only exception even though generation-0 evidence remains.
		filesTouched = ['src/expanded.ts'];
		expect(await hasPassedAllGates(directory, '1.1', filesTouched)).toBe(false);
		expect(await hasPassedAllGates(directory, '1.1')).toBe(false);
	});

	test('rejects ordinary and legacy empty required-gate evidence', async () => {
		writeEvidence('1.2', { required_gates: [], gates: {} });
		writeEvidence('1.3', {
			required_gates: [],
			gates: {},
			workflow: { state: 'idle', generation: 0 },
		});

		expect(await hasPassedAllGates(directory, '1.2')).toBe(false);
		expect(await hasPassedAllGates(directory, '1.3')).toBe(false);
	});

	test('preserves nonempty all-gates behavior while requiring pre_check', async () => {
		writeEvidence('1.4', {
			required_gates: ['reviewer'],
			gates: {
				pre_check: {
					sessionId: 'session-1',
					timestamp: '2026-09-14T00:00:00.000Z',
					agent: 'pre_check',
				},
				reviewer: {
					sessionId: 'session-1',
					timestamp: '2026-09-14T00:00:00.000Z',
					agent: 'reviewer',
				},
			},
		});

		expect(await hasPassedAllGates(directory, '1.4')).toBe(true);
	});
});
