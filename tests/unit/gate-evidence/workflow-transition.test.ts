import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	readTaskEvidenceRaw,
	transitionTaskWorkflowEvidence,
	withTaskEvidenceTransaction,
} from '../../../src/gate-evidence';
import { canonicalTmpDir } from '../../helpers/tmpdir.js';

describe('gate-evidence workflow transitions', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(path.join(canonicalTmpDir(), 'workflow-evidence-'));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it('increments generation and clears stale stage proof on accepted mutation', async () => {
		await transitionTaskWorkflowEvidence(tempDir, '1.1', {
			type: 'accepted_mutation',
			agentType: 'coder',
			expectedGeneration: 0,
			transitionId: 'mut-1',
		});
		await transitionTaskWorkflowEvidence(tempDir, '1.1', {
			type: 'stage_a_passed',
			expectedGeneration: 1,
			transitionId: 'stage-a-1',
		});
		await transitionTaskWorkflowEvidence(tempDir, '1.1', {
			type: 'stage_b_completed',
			gate: 'reviewer',
			sessionId: 'reviewer-session',
			expectedGeneration: 1,
			transitionId: 'reviewer-1',
		});
		await transitionTaskWorkflowEvidence(tempDir, '1.1', {
			type: 'stage_b_completed',
			gate: 'test_engineer',
			sessionId: 'test-session',
			expectedGeneration: 1,
			transitionId: 'test-1',
		});

		let evidence = readTaskEvidenceRaw(tempDir, '1.1');
		expect(evidence?.workflow).toMatchObject({
			generation: 1,
			state: 'tests_run',
			retryCount: 0,
			lastOutcome: 'stage_b_completed',
		});
		expect(evidence?.gates.reviewer?.sessionId).toBe('reviewer-session');
		expect(evidence?.gates.test_engineer?.sessionId).toBe('test-session');

		await transitionTaskWorkflowEvidence(tempDir, '1.1', {
			type: 'accepted_mutation',
			agentType: 'coder',
			expectedGeneration: 1,
			transitionId: 'mut-2',
		});

		evidence = readTaskEvidenceRaw(tempDir, '1.1');
		expect(evidence?.workflow).toMatchObject({
			generation: 2,
			state: 'coder_delegated',
			retryCount: 0,
			lastOutcome: 'accepted_mutation',
			lastTransitionId: 'mut-2',
		});
		expect(evidence?.gates.reviewer).toBeUndefined();
		expect(evidence?.gates.test_engineer).toBeUndefined();
	});

	it('counts no-mutation attempts without creating review debt', async () => {
		await transitionTaskWorkflowEvidence(tempDir, '1.2', {
			type: 'dispatch_attempted',
			agentType: 'coder',
			expectedGeneration: 0,
			transitionId: 'attempt-1',
		});
		await transitionTaskWorkflowEvidence(tempDir, '1.2', {
			type: 'dispatch_no_mutation',
			agentType: 'coder',
			expectedGeneration: 0,
			transitionId: 'failed-1',
		});

		const evidence = readTaskEvidenceRaw(tempDir, '1.2');
		expect(evidence?.workflow).toMatchObject({
			generation: 0,
			state: 'idle',
			retryCount: 1,
			lastOutcome: 'dispatch_no_mutation',
			lastTransitionId: 'failed-1',
		});
		expect(evidence?.gates).toEqual({});
		expect(evidence?.required_gates).toEqual([]);
	});

	it('preserves rejection history across accepted repair generations', async () => {
		for (let generation = 0; generation < 3; generation++) {
			await transitionTaskWorkflowEvidence(tempDir, '1.9', {
				type: 'accepted_mutation',
				agentType: 'coder',
				expectedGeneration: generation,
				transitionId: `mutation-${generation + 1}`,
			});
			await transitionTaskWorkflowEvidence(tempDir, '1.9', {
				type: 'stage_a_failed',
				expectedGeneration: generation + 1,
				transitionId: `stage-a-failed-${generation + 1}`,
			});
		}

		expect(readTaskEvidenceRaw(tempDir, '1.9')?.workflow).toMatchObject({
			generation: 3,
			state: 'rework_required',
			retryCount: 3,
			retryEpoch: 2,
			retryHistory: ['stage_a_failed', 'stage_a_failed', 'stage_a_failed'],
		});
	});

	it('moves Stage A failures into rework_required and repair_idle clears stale proof', async () => {
		await transitionTaskWorkflowEvidence(tempDir, '1.3', {
			type: 'accepted_mutation',
			agentType: 'coder',
			expectedGeneration: 0,
			transitionId: 'mut-1',
		});
		await transitionTaskWorkflowEvidence(tempDir, '1.3', {
			type: 'stage_a_passed',
			expectedGeneration: 1,
			transitionId: 'stage-a-pass',
		});
		await transitionTaskWorkflowEvidence(tempDir, '1.3', {
			type: 'stage_a_failed',
			expectedGeneration: 1,
			transitionId: 'stage-a-fail',
		});

		let evidence = readTaskEvidenceRaw(tempDir, '1.3');
		expect(evidence?.workflow).toMatchObject({
			generation: 1,
			state: 'rework_required',
			retryCount: 1,
			lastOutcome: 'stage_a_failed',
		});

		await transitionTaskWorkflowEvidence(tempDir, '1.3', {
			type: 'repair_idle',
			expectedGeneration: 1,
			transitionId: 'repair-idle',
		});

		evidence = readTaskEvidenceRaw(tempDir, '1.3');
		expect(evidence?.workflow).toMatchObject({
			generation: 2,
			state: 'idle',
			retryCount: 0,
			lastOutcome: 'repair_idle',
			lastTransitionId: 'repair-idle',
		});
		expect(evidence?.gates.pre_check).toBeUndefined();
		expect(evidence?.gates.reviewer).toBeUndefined();
	});

	it('rejects stale expected generations without mutating evidence', async () => {
		await transitionTaskWorkflowEvidence(tempDir, '1.4', {
			type: 'accepted_mutation',
			agentType: 'coder',
			expectedGeneration: 0,
			transitionId: 'mut-1',
		});

		const before = readTaskEvidenceRaw(tempDir, '1.4');
		await expect(
			transitionTaskWorkflowEvidence(tempDir, '1.4', {
				type: 'stage_a_passed',
				expectedGeneration: 0,
				transitionId: 'stale-pass',
			}),
		).rejects.toThrow(/TASK_WORKFLOW_GENERATION_MISMATCH/);

		const after = readTaskEvidenceRaw(tempDir, '1.4');
		expect(after).toEqual(before);
	});

	it('rejects Stage B before Stage A without creating evidence', async () => {
		await transitionTaskWorkflowEvidence(tempDir, '1.6', {
			type: 'accepted_mutation',
			agentType: 'coder',
			expectedGeneration: 0,
			transitionId: 'mut-1',
		});
		const before = readTaskEvidenceRaw(tempDir, '1.6');
		await expect(
			transitionTaskWorkflowEvidence(tempDir, '1.6', {
				type: 'stage_b_completed',
				gate: 'reviewer',
				sessionId: 'reviewer',
				expectedGeneration: 1,
				transitionId: 'premature-review',
			}),
		).rejects.toThrow(/TASK_WORKFLOW_STAGE_A_REQUIRED/);
		expect(readTaskEvidenceRaw(tempDir, '1.6')).toEqual(before);
	});

	it('treats a negative Stage B verdict as rework and clears mixed gate proof', async () => {
		await transitionTaskWorkflowEvidence(tempDir, '1.7', {
			type: 'accepted_mutation',
			agentType: 'coder',
			expectedGeneration: 0,
			transitionId: 'mut-1',
		});
		await transitionTaskWorkflowEvidence(tempDir, '1.7', {
			type: 'stage_a_passed',
			expectedGeneration: 1,
			transitionId: 'stage-a',
		});
		await transitionTaskWorkflowEvidence(tempDir, '1.7', {
			type: 'stage_b_completed',
			gate: 'reviewer',
			sessionId: 'reviewer',
			expectedGeneration: 1,
			transitionId: 'review-pass',
		});
		await transitionTaskWorkflowEvidence(tempDir, '1.7', {
			type: 'stage_b_failed',
			gate: 'test_engineer',
			expectedGeneration: 1,
			transitionId: 'test-fail',
		});

		const evidence = readTaskEvidenceRaw(tempDir, '1.7');
		expect(evidence?.workflow).toMatchObject({
			generation: 1,
			state: 'rework_required',
			retryCount: 1,
			lastOutcome: 'stage_b_failed',
		});
		expect(evidence?.gates.reviewer).toBeUndefined();
		expect(evidence?.gates.test_engineer).toBeUndefined();
	});

	it('rejects late coder and gate settlements after a terminal transition', async () => {
		await transitionTaskWorkflowEvidence(tempDir, '1.8', {
			type: 'task_blocked',
			expectedGeneration: 0,
			transitionId: 'blocked',
		});
		const before = readTaskEvidenceRaw(tempDir, '1.8');
		await expect(
			transitionTaskWorkflowEvidence(tempDir, '1.8', {
				type: 'accepted_mutation',
				agentType: 'coder',
				expectedGeneration: 0,
				transitionId: 'late-coder',
			}),
		).rejects.toThrow(/TASK_WORKFLOW_TERMINAL/);
		await expect(
			transitionTaskWorkflowEvidence(tempDir, '1.8', {
				type: 'stage_b_completed',
				gate: 'reviewer',
				sessionId: 'reviewer',
				expectedGeneration: 0,
				transitionId: 'late-review',
			}),
		).rejects.toThrow(/TASK_WORKFLOW_TERMINAL/);
		expect(readTaskEvidenceRaw(tempDir, '1.8')).toEqual(before);
	});

	it('rejects a foreign task_closed against an already-closed task', async () => {
		// Locks in fail-closed behavior. The terminal guard deliberately has no
		// `(closed && task_closed)` idempotency branch, unlike the complete/blocked
		// branches: `task_closed` rewrites lastTransitionId, so allowing a re-entry
		// would let a foreign transition silently overwrite terminal provenance. An
		// exact replay of the SAME transitionId is already short-circuited earlier by
		// isDuplicateTransition, so no legitimate caller needs such a branch.
		await transitionTaskWorkflowEvidence(tempDir, '1.9', {
			type: 'task_closed',
			expectedGeneration: 0,
			transitionId: 'close-original',
		});
		const before = readTaskEvidenceRaw(tempDir, '1.9');
		expect(before?.workflow).toMatchObject({
			state: 'closed',
			lastTransitionId: 'close-original',
		});

		await expect(
			transitionTaskWorkflowEvidence(tempDir, '1.9', {
				type: 'task_closed',
				expectedGeneration: 0,
				transitionId: 'close-foreign',
			}),
		).rejects.toThrow(/TASK_WORKFLOW_TERMINAL/);
		expect(readTaskEvidenceRaw(tempDir, '1.9')).toEqual(before);
	});

	it('records forcedCompletion in durable evidence for a QA-exempt completion', async () => {
		await transitionTaskWorkflowEvidence(tempDir, '1.10', {
			type: 'task_completed',
			qaExempt: true,
			expectedGeneration: 0,
			transitionId: 'forced-complete',
		});
		const forced = readTaskEvidenceRaw(tempDir, '1.10');
		expect(forced?.workflow).toMatchObject({
			state: 'complete',
			forcedCompletion: true,
		});

		// A repair reopens the task, so the forced-completion fact must not survive
		// into the new generation.
		await transitionTaskWorkflowEvidence(tempDir, '1.10', {
			type: 'repair_idle',
			expectedGeneration: 0,
			transitionId: 'repair-after-forced',
		});
		const repaired = readTaskEvidenceRaw(tempDir, '1.10');
		expect(repaired?.workflow.state).toBe('idle');
		expect(repaired?.workflow.forcedCompletion).toBeUndefined();
	});

	it('keeps forcedCompletion across a later non-exempt task_completed', async () => {
		// The terminal guard permits task_completed from `complete`. Without the
		// carry-forward in `base`, a second, non-exempt task_completed would drop the
		// flag and launder a forced completion into one that looks gate-passed.
		await transitionTaskWorkflowEvidence(tempDir, '1.11', {
			type: 'task_completed',
			qaExempt: true,
			expectedGeneration: 0,
			transitionId: 'forced-first',
		});
		expect(
			readTaskEvidenceRaw(tempDir, '1.11')?.workflow.forcedCompletion,
		).toBe(true);

		await transitionTaskWorkflowEvidence(tempDir, '1.11', {
			type: 'task_completed',
			expectedGeneration: 0,
			transitionId: 'relaunder-attempt',
		});

		const after = readTaskEvidenceRaw(tempDir, '1.11')?.workflow;
		expect(after?.state).toBe('complete');
		expect(after?.forcedCompletion).toBe(true);
	});

	it('keeps a single evidence lock across a caller-managed transaction callback', async () => {
		const seenStates: string[] = [];

		await withTaskEvidenceTransaction(
			tempDir,
			'1.5',
			'architect',
			async (transaction) => {
				seenStates.push(transaction.read()?.workflow?.state ?? 'missing');
				await transaction.transition({
					type: 'accepted_mutation',
					agentType: 'coder',
					expectedGeneration: 0,
					transitionId: 'mut-1',
				});
				seenStates.push(transaction.read()?.workflow?.state ?? 'missing');
				await transaction.transition({
					type: 'task_blocked',
					expectedGeneration: 1,
					transitionId: 'blocked-1',
				});
				seenStates.push(transaction.read()?.workflow?.state ?? 'missing');
			},
		);

		expect(seenStates).toEqual(['missing', 'coder_delegated', 'blocked']);
		expect(readTaskEvidenceRaw(tempDir, '1.5')?.workflow).toMatchObject({
			generation: 1,
			state: 'blocked',
			lastTransitionId: 'blocked-1',
		});
	});
});
