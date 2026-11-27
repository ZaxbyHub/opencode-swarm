/**
 * PR 3919 (B-003): the production background caller must not treat a failed
 * compensation as a clean rollback. This drives the real
 * ingestBackgroundStageBCompletion path with the route-receipt append and the
 * compensating restore both forced to fail, then asserts the typed error and
 * the durable repair fence that refuses later evidence transactions.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BackgroundDelegationRecord } from '../../../src/background/pending-delegations';
import { ingestBackgroundStageBCompletion } from '../../../src/background/stage-b-gates';
import { captureWorkspaceSnapshot } from '../../../src/background/workspace-snapshot';
import {
	_internals as gateEvidenceInternals,
	TaskEvidenceRepairPendingError,
	transitionTaskWorkflowEvidence,
} from '../../../src/gate-evidence';
import {
	buildReviewRouteReceipt,
	persistReviewRouteReceipt,
} from '../../../src/review/routing-enforcement';
import { resetSwarmState } from '../../../src/state';
import { createIsolatedTestEnv } from '../../helpers/isolated-test-env.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';
import { ensureSessionDrained } from '../hooks/_session-rehydration-drain';

const TASK = '1.50';
const CHILD = 'child-caller-fence';
const originalAppend =
	gateEvidenceInternals.appendTaskGateRequirementsReceiptIfNeeded;
const originalRestore = gateEvidenceInternals.restoreEvidenceFile;

function git(directory: string, args: string[]): void {
	const result = spawnSync('git', ['-C', directory, ...args], {
		cwd: directory,
		stdin: 'ignore',
		stdio: 'pipe',
		encoding: 'utf8',
		timeout: 5_000,
		maxBuffer: 128 * 1024,
	});
	if (result.status !== 0) throw new Error(result.stderr || result.stdout);
}

function reviewerRecord(
	workspace: ReturnType<typeof captureWorkspaceSnapshot>,
): BackgroundDelegationRecord {
	return {
		schemaVersion: 1,
		correlationId: `reviewer-${TASK}-caller`,
		jobId: null,
		subagentSessionId: CHILD,
		parentSessionId: 'parent-session',
		callID: 'call-caller-fence',
		normalizedAgent: 'reviewer',
		swarmPrefixedAgent: 'reviewer',
		planTaskId: TASK,
		evidenceTaskId: TASK,
		status: 'completed',
		createdAt: 1,
		updatedAt: 2,
		workspace,
		workflowGeneration: 1,
	};
}

describe('background Stage-B caller does not roll back past a repair fence (PR 3919 B-003)', () => {
	let testDirectory = '';
	let isolatedEnv: ReturnType<typeof createIsolatedTestEnv> | undefined;

	beforeEach(async () => {
		isolatedEnv = createIsolatedTestEnv();
		resetSwarmState();
		testDirectory = canonicalMkdtemp('stage-b-caller-fence-');
		git(testDirectory, ['init']);
		git(testDirectory, ['config', 'user.email', 'tests@example.com']);
		git(testDirectory, ['config', 'user.name', 'Tests']);
		fs.writeFileSync(path.join(testDirectory, 'AGENTS.md'), '# docs rule\n');
		git(testDirectory, ['add', 'AGENTS.md']);
		git(testDirectory, ['commit', '-m', 'test: seed repository']);

		await ensureSessionDrained('parent-session', testDirectory);
		await transitionTaskWorkflowEvidence(testDirectory, TASK, {
			type: 'accepted_mutation',
			agentType: 'coder',
			context: { testEngineerExempt: true },
			expectedGeneration: 0,
			transitionId: 'caller-coder',
		});
		await transitionTaskWorkflowEvidence(testDirectory, TASK, {
			type: 'stage_a_passed',
			expectedGeneration: 1,
			transitionId: 'caller-stage-a',
		});
		await persistReviewRouteReceipt({
			projectRoot: testDirectory,
			receipt: buildReviewRouteReceipt({
				sessionId: 'parent-session',
				taskId: TASK,
				complexity: 'single',
				semanticRisk: 'Standard complexity: 1 files, 0 functions',
				requiredReviewers: [`${TASK}:reviewer:1`],
				requiredTestEngineers: [],
			}),
		});
	});

	afterEach(() => {
		gateEvidenceInternals.appendTaskGateRequirementsReceiptIfNeeded =
			originalAppend;
		gateEvidenceInternals.restoreEvidenceFile = originalRestore;
		resetSwarmState();
		fs.rmSync(testDirectory, { recursive: true, force: true });
		isolatedEnv?.cleanup();
		isolatedEnv = undefined;
	});

	test('a failed append and failed restore surface the typed error and fence later transactions', async () => {
		gateEvidenceInternals.appendTaskGateRequirementsReceiptIfNeeded =
			async () => {
				throw new Error('FORCED_RECEIPT_APPEND_FAILURE');
			};
		gateEvidenceInternals.restoreEvidenceFile = async () => {
			throw new Error('FORCED_RESTORE_FAILURE');
		};

		const outcome = await ingestBackgroundStageBCompletion({
			directory: testDirectory,
			record: reviewerRecord(captureWorkspaceSnapshot(testDirectory)),
			result: {
				text: `[REVIEWED] | task-${TASK} | APPROVED | docs are correct`,
				chars: 54,
				truncated: false,
				digest: 'reviewer',
			},
		});

		// The caller reports a failed, unconsumed ingestion that names the typed
		// code; it never reports a consumed success and never rolls back the live
		// reservation past the fence.
		expect(outcome.ok).toBe(false);
		expect(outcome.consumed).toBe(false);
		expect(outcome.reason).toContain('TASK_EVIDENCE_RECEIPT_ROLLBACK_FAILED');

		// Restore the seams; the durable fence must still refuse later evidence
		// transactions, with no in-memory state carried across the "restart".
		gateEvidenceInternals.appendTaskGateRequirementsReceiptIfNeeded =
			originalAppend;
		gateEvidenceInternals.restoreEvidenceFile = originalRestore;
		const refused = await transitionTaskWorkflowEvidence(testDirectory, TASK, {
			type: 'tests_run',
			expectedGeneration: 2,
			transitionId: 'after-caller-fence',
		}).catch((caught: unknown) => caught);
		expect(refused).toBeInstanceOf(TaskEvidenceRepairPendingError);
	});
});
