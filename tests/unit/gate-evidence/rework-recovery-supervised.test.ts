import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	readTaskEvidenceRaw,
	transitionTaskWorkflowEvidence,
} from '../../../src/gate-evidence';
import { canonicalTmpDir } from '../../helpers/tmpdir.js';

/**
 * Issue #2755: the `stage_a_passed` reducer case accepts `rework_required`
 * ONLY when the event carries `supervisedRecovery: true` (the
 * recover_rework_task escape hatch). The mechanical path — the guardrails
 * toolAfter recorder and the stage-a-repair wedge scan, neither of which sets
 * the flag — must still fail closed with
 * TASK_WORKFLOW_CODER_MUTATION_REQUIRED so a genuine code defect keeps
 * requiring an accepted coder mutation.
 */
describe('gate-evidence supervised stage_a_passed (issue #2755)', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(path.join(canonicalTmpDir(), 'rework-supervised-'));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	async function seedReworkRequired(taskId: string): Promise<void> {
		await transitionTaskWorkflowEvidence(tempDir, taskId, {
			type: 'accepted_mutation',
			agentType: 'coder',
			expectedGeneration: 0,
			transitionId: 'mut-1',
		});
		await transitionTaskWorkflowEvidence(tempDir, taskId, {
			type: 'stage_a_passed',
			expectedGeneration: 1,
			transitionId: 'stage-a-1',
		});
		await transitionTaskWorkflowEvidence(tempDir, taskId, {
			type: 'stage_b_failed',
			gate: 'test_engineer',
			expectedGeneration: 1,
			transitionId: 'stage-b-fail-1',
		});
	}

	it('admits a supervised stage_a_passed from rework_required without rotating the generation', async () => {
		await seedReworkRequired('1.1');
		await transitionTaskWorkflowEvidence(tempDir, '1.1', {
			type: 'stage_a_passed',
			supervisedRecovery: true,
			expectedGeneration: 1,
			transitionId: 'rework-recovery:1.1:gen1',
		});
		const evidence = readTaskEvidenceRaw(tempDir, '1.1');
		expect(evidence?.workflow).toMatchObject({
			state: 'pre_check_passed',
			generation: 1,
			lastOutcome: 'stage_a_passed',
			lastTransitionId: 'rework-recovery:1.1:gen1',
		});
	});

	it('preserves retry history across the supervised recovery', async () => {
		await seedReworkRequired('1.2');
		const before = readTaskEvidenceRaw(tempDir, '1.2')?.workflow;
		expect(before?.state).toBe('rework_required');
		expect(before?.retryCount).toBe(1);
		await transitionTaskWorkflowEvidence(tempDir, '1.2', {
			type: 'stage_a_passed',
			supervisedRecovery: true,
			expectedGeneration: before?.generation ?? 1,
			transitionId: 'rework-recovery:1.2:gen1',
		});
		const after = readTaskEvidenceRaw(tempDir, '1.2')?.workflow;
		// A spurious-verdict history must stay visible to the retry circuit
		// (plan-critic R1 semantics): no special clearing on the supervised path.
		expect(after?.retryCount).toBe(before?.retryCount);
		expect(after?.retryHistory).toEqual(before?.retryHistory);
		expect(after?.retryEpoch).toBe(before?.retryEpoch);
	});

	it('still rejects the mechanical stage_a_passed from rework_required (regression: issue #2755 dead end preserved by design)', async () => {
		await seedReworkRequired('1.3');
		await expect(
			transitionTaskWorkflowEvidence(tempDir, '1.3', {
				type: 'stage_a_passed',
				expectedGeneration: 1,
				transitionId: 'mechanical-retry',
			}),
		).rejects.toThrow(/TASK_WORKFLOW_CODER_MUTATION_REQUIRED/);
		expect(readTaskEvidenceRaw(tempDir, '1.3')?.workflow?.state).toBe(
			'rework_required',
		);
	});

	it('rejects a supervised stage_a_passed from every state that is not rework_required/coder_delegated/pre_check_passed', async () => {
		// idle: nothing has happened yet.
		await expect(
			transitionTaskWorkflowEvidence(tempDir, '1.4', {
				type: 'stage_a_passed',
				supervisedRecovery: true,
				expectedGeneration: 0,
				transitionId: 'supervised-from-idle',
			}),
		).rejects.toThrow(/TASK_WORKFLOW_CODER_MUTATION_REQUIRED/);

		// tests_run: Stage B already completed; recovery does not apply.
		await seedReworkRequired('1.5');
		await transitionTaskWorkflowEvidence(tempDir, '1.5', {
			type: 'stage_a_passed',
			supervisedRecovery: true,
			expectedGeneration: 1,
			transitionId: 'rr',
		});
		await transitionTaskWorkflowEvidence(tempDir, '1.5', {
			type: 'stage_b_completed',
			gate: 'reviewer',
			sessionId: 'rev-session',
			routeComplete: true,
			expectedGeneration: 1,
			transitionId: 'rev-done',
		});
		// 2026-11-25 (tests_run catch-22): a complete route on the reviewer
		// binding alone no longer reaches tests_run while test_engineer is
		// still required and unbound — bind the TE to earn the state the
		// old shortcut used to fabricate.
		await transitionTaskWorkflowEvidence(tempDir, '1.5', {
			type: 'stage_b_completed',
			gate: 'test_engineer',
			sessionId: 'te-session',
			routeComplete: true,
			expectedGeneration: 1,
			transitionId: 'te-done',
		});
		expect(readTaskEvidenceRaw(tempDir, '1.5')?.workflow?.state).toBe(
			'tests_run',
		);
		await expect(
			transitionTaskWorkflowEvidence(tempDir, '1.5', {
				type: 'stage_a_passed',
				supervisedRecovery: true,
				expectedGeneration: 1,
				transitionId: 'supervised-from-tests-run',
			}),
		).rejects.toThrow(/TASK_WORKFLOW_CODER_MUTATION_REQUIRED/);
	});

	it('rejects a supervised stage_a_passed from terminal states', async () => {
		await seedReworkRequired('1.6');
		await transitionTaskWorkflowEvidence(tempDir, '1.6', {
			type: 'task_blocked',
			expectedGeneration: 1,
			transitionId: 'blocked-1',
		});
		await expect(
			transitionTaskWorkflowEvidence(tempDir, '1.6', {
				type: 'stage_a_passed',
				supervisedRecovery: true,
				expectedGeneration: 1,
				transitionId: 'supervised-from-blocked',
			}),
		).rejects.toThrow(/TASK_WORKFLOW_TERMINAL/);
	});

	it('rejects a supervised stage_a_passed from reviewer_run (FB-003: mutation-probe gap)', async () => {
		// Seed to reviewer_run: supervised recovery, then the reviewer gate
		// completes without completing the route.
		await seedReworkRequired('1.8');
		await transitionTaskWorkflowEvidence(tempDir, '1.8', {
			type: 'stage_a_passed',
			supervisedRecovery: true,
			expectedGeneration: 1,
			transitionId: 'rr-1.8',
		});
		await transitionTaskWorkflowEvidence(tempDir, '1.8', {
			type: 'stage_b_completed',
			gate: 'reviewer',
			sessionId: 'rev-session',
			routeComplete: false,
			expectedGeneration: 1,
			transitionId: 'rev-partial',
		});
		expect(readTaskEvidenceRaw(tempDir, '1.8')?.workflow?.state).toBe(
			'reviewer_run',
		);
		// The supervised admission must NOT widen into reviewer_run.
		await expect(
			transitionTaskWorkflowEvidence(tempDir, '1.8', {
				type: 'stage_a_passed',
				supervisedRecovery: true,
				expectedGeneration: 1,
				transitionId: 'supervised-from-reviewer-run',
			}),
		).rejects.toThrow(/TASK_WORKFLOW_CODER_MUTATION_REQUIRED/);
	});

	it('persists supervisedRecovery on the supervised pass, only on the supervised pass, and clears it on generation rotation (FB-002)', async () => {
		// Mechanical pass from coder_delegated: no marker.
		await transitionTaskWorkflowEvidence(tempDir, '2.1', {
			type: 'accepted_mutation',
			agentType: 'coder',
			expectedGeneration: 0,
			transitionId: 'mut-2.1',
		});
		await transitionTaskWorkflowEvidence(tempDir, '2.1', {
			type: 'stage_a_passed',
			expectedGeneration: 1,
			transitionId: 'mech-2.1',
		});
		expect(
			readTaskEvidenceRaw(tempDir, '2.1')?.workflow?.supervisedRecovery,
		).toBeUndefined();

		// Supervised pass from rework_required: marker persisted and durable
		// across a subsequent same-generation transition.
		await seedReworkRequired('2.2');
		await transitionTaskWorkflowEvidence(tempDir, '2.2', {
			type: 'stage_a_passed',
			supervisedRecovery: true,
			expectedGeneration: 1,
			transitionId: 'rr-2.2',
		});
		expect(
			readTaskEvidenceRaw(tempDir, '2.2')?.workflow?.supervisedRecovery,
		).toBe(true);
		await transitionTaskWorkflowEvidence(tempDir, '2.2', {
			type: 'stage_b_completed',
			gate: 'reviewer',
			sessionId: 'rev',
			routeComplete: false,
			expectedGeneration: 1,
			transitionId: 'rev-2.2',
		});
		expect(
			readTaskEvidenceRaw(tempDir, '2.2')?.workflow?.supervisedRecovery,
		).toBe(true);

		// Generation rotation (accepted_mutation) clears the marker.
		await transitionTaskWorkflowEvidence(tempDir, '2.2', {
			type: 'accepted_mutation',
			agentType: 'coder',
			expectedGeneration: 1,
			transitionId: 'mut-2.2',
		});
		expect(
			readTaskEvidenceRaw(tempDir, '2.2')?.workflow?.supervisedRecovery,
		).toBeUndefined();

		// repair_idle also clears it (mirrors forcedCompletion semantics).
		await seedReworkRequired('2.3');
		await transitionTaskWorkflowEvidence(tempDir, '2.3', {
			type: 'stage_a_passed',
			supervisedRecovery: true,
			expectedGeneration: 1,
			transitionId: 'rr-2.3',
		});
		expect(
			readTaskEvidenceRaw(tempDir, '2.3')?.workflow?.supervisedRecovery,
		).toBe(true);
		await transitionTaskWorkflowEvidence(tempDir, '2.3', {
			type: 'repair_idle',
			expectedGeneration: 1,
			transitionId: 'repair-2.3',
		});
		expect(
			readTaskEvidenceRaw(tempDir, '2.3')?.workflow?.supervisedRecovery,
		).toBeUndefined();
	});

	it('still admits the plain stage_a_passed from coder_delegated and pre_check_passed', async () => {
		await transitionTaskWorkflowEvidence(tempDir, '1.7', {
			type: 'accepted_mutation',
			agentType: 'coder',
			expectedGeneration: 0,
			transitionId: 'mut-a',
		});
		await transitionTaskWorkflowEvidence(tempDir, '1.7', {
			type: 'stage_a_passed',
			expectedGeneration: 1,
			transitionId: 'stage-a-plain',
		});
		expect(readTaskEvidenceRaw(tempDir, '1.7')?.workflow?.state).toBe(
			'pre_check_passed',
		);
		// Idempotent re-fire from pre_check_passed stays legal (unchanged behavior).
		await transitionTaskWorkflowEvidence(tempDir, '1.7', {
			type: 'stage_a_passed',
			expectedGeneration: 1,
			transitionId: 'stage-a-plain-2',
		});
		expect(readTaskEvidenceRaw(tempDir, '1.7')?.workflow?.state).toBe(
			'pre_check_passed',
		);
	});
});
