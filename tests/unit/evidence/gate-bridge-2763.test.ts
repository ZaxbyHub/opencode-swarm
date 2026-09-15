import { describe, expect, test } from 'bun:test';
import {
	getDurableGateEvidenceStatus,
	hasCompleteDurableGateEvidence,
} from '../../../src/evidence/gate-bridge';
import type { TaskEvidence } from '../../../src/gate-evidence';

const trustedEmptySettlement = (): TaskEvidence => ({
	taskId: '1.1',
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

describe('durable gate bridge applicability (#2763)', () => {
	test('ordinary empty required gates retain the pre_check obligation', () => {
		const status = getDurableGateEvidenceStatus({
			taskId: '1.2',
			required_gates: [],
			gates: {},
		});

		expect(status).toEqual({
			isComplete: false,
			missingGates: ['pre_check'],
			evidenceExists: true,
			invalid: false,
		});
	});

	test('trusted empty-scope settlement has an empty complete gate set', () => {
		const evidence = trustedEmptySettlement();

		expect(getDurableGateEvidenceStatus(evidence)).toEqual({
			isComplete: true,
			missingGates: [],
			evidenceExists: true,
			invalid: false,
		});
		expect(hasCompleteDurableGateEvidence(evidence)).toBe(true);
	});

	test('nonempty gate evidence still requires pre_check and every declared gate', () => {
		const evidence: TaskEvidence = {
			taskId: '1.3',
			required_gates: ['reviewer'],
			gates: {
				reviewer: {
					sessionId: 'session-1',
					timestamp: '2026-09-14T00:00:00.000Z',
					agent: 'reviewer',
				},
			},
		};

		const status = getDurableGateEvidenceStatus(evidence);
		expect(status.isComplete).toBe(false);
		expect(status.missingGates).toEqual(['pre_check']);
	});

	test('invalid required_gates shape keeps the invalid-gate diagnostic', () => {
		const evidence = {
			taskId: '1.4',
			required_gates: 'reviewer',
			gates: {},
		} as unknown as TaskEvidence;

		expect(getDurableGateEvidenceStatus(evidence)).toEqual({
			isComplete: false,
			missingGates: ['required_gates'],
			evidenceExists: true,
			invalid: false,
		});
	});

	test('missing evidence remains distinct from malformed gate evidence', () => {
		expect(getDurableGateEvidenceStatus(null)).toEqual({
			isComplete: false,
			missingGates: [],
			evidenceExists: false,
			invalid: false,
		});
		expect(
			getDurableGateEvidenceStatus({
				taskId: '1.5',
				required_gates: [],
				gates: null,
			} as unknown as TaskEvidence),
		).toEqual({
			isComplete: false,
			missingGates: [],
			evidenceExists: true,
			invalid: false,
		});
	});
});
