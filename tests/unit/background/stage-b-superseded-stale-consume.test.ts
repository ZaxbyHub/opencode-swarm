/**
 * Superseded reviewer-scope generations consume terminal completions as
 * stale — the re-dispatch cascade fix.
 *
 * Field incident (task 3.11, 2026-11-28): a background coder round whose
 * Stage-B ingestion failed once went retryable; the architect re-dispatched
 * the task (following the failure advisory), and startReviewerScopeGeneration
 * DELETED the older round's unclaimed generation. Every subsequent ingestion
 * retry of the older round then failed deterministically ("scope handoff
 * could not be reconstructed exactly") until the redrive budget burned down —
 * and the exhaustion advisory told the architect to re-dispatch again, arming
 * the same fate for the successor round. A completion whose generation was
 * superseded is stale by construction: the successor dispatch already owns
 * the task, so the ingestion must consume terminally instead of retrying.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { BackgroundDelegationRecord } from '../../../src/background/pending-delegations';
import { ingestBackgroundStageBCompletion } from '../../../src/background/stage-b-gates';
import { captureWorkspaceSnapshot } from '../../../src/background/workspace-snapshot';
import {
	ensureAgentSession,
	resetSwarmState,
	startReviewerScopeGeneration,
} from '../../../src/state';
import { safeRmRecursive } from '../../helpers/safe-test-dir.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const PARENT = 'ses-supersede-parent';
const TASK = '1.1';

function coderRecord(
	directory: string,
	callID: string,
	workspace = captureWorkspaceSnapshot(directory),
): BackgroundDelegationRecord {
	return {
		schemaVersion: 1,
		correlationId: `ses-child-${callID}`,
		jobId: null,
		subagentSessionId: `ses-child-${callID}`,
		parentSessionId: PARENT,
		callID,
		normalizedAgent: 'coder',
		swarmPrefixedAgent: 'coder',
		planTaskId: TASK,
		evidenceTaskId: TASK,
		status: 'completed',
		createdAt: 1,
		updatedAt: 2,
		workspace,
		coderSettlement: {
			state: 'settled',
			provenance: {
				correlationId: `ses-child-${callID}`,
				parentSessionId: PARENT,
				callID,
				planTaskId: TASK,
				baseline: workspace,
				worktree: null,
			},
			operationId: `op-${callID}`,
			observedFiles: [],
			outcome: { kind: 'shared-root', result: 'ready' },
			updatedAt: 2,
		},
		taskChangeContext: {
			declaredFiles: ['src/a.ts'],
			baseline: workspace,
			workflowGeneration: 0,
		},
	};
}

describe('superseded reviewer-scope generations — stale consumption', () => {
	let directory = '';

	beforeEach(() => {
		resetSwarmState();
		directory = canonicalMkdtemp('stage-b-superseded-');
	});

	afterEach(() => {
		resetSwarmState();
		safeRmRecursive(directory);
	});

	test('a re-dispatch supersedes the older call: its completion consumes as terminal-negative stale', async () => {
		ensureAgentSession(PARENT, 'architect', directory);
		const workspace = captureWorkspaceSnapshot(directory);
		const first = startReviewerScopeGeneration({
			parentSessionID: PARENT,
			taskId: TASK,
			coderCallID: 'call-first',
			background: true,
			declaredFiles: ['src/a.ts'],
			captureDirectory: directory,
			workspaceIdentity: directory,
		});
		expect(first?.status).toBe('collecting');
		// The re-dispatch of the SAME task supersedes (deletes) the older
		// unclaimed generation — this is the field-observed wedge trigger.
		const successor = startReviewerScopeGeneration({
			parentSessionID: PARENT,
			taskId: TASK,
			coderCallID: 'call-second',
			background: true,
			declaredFiles: ['src/a.ts'],
			captureDirectory: directory,
			workspaceIdentity: directory,
		});
		expect(successor?.status).toBe('collecting');

		const applied = await ingestBackgroundStageBCompletion({
			directory,
			record: coderRecord(directory, 'call-first', workspace),
			result: {
				text: 'coder finished',
				chars: 14,
				truncated: false,
				digest: 'deadbeef',
			},
			reviewerReceiptOptions: { config: { enabled: true } } as never,
		});

		expect(applied.ok).toBe(false);
		expect(applied.consumed).toBe(true);
		expect(applied.stale).toBe(true);
		expect(applied.reason ?? '').toContain('superseded');
	});

	test('fresh zero-change call still consumes through the no-change path (regression guard)', async () => {
		ensureAgentSession(PARENT, 'architect', directory);
		const workspace = captureWorkspaceSnapshot(directory);
		const fresh = startReviewerScopeGeneration({
			parentSessionID: PARENT,
			taskId: TASK,
			coderCallID: 'call-fresh',
			background: true,
			declaredFiles: ['src/a.ts'],
			captureDirectory: directory,
			workspaceIdentity: directory,
		});
		expect(fresh?.status).toBe('collecting');

		const applied = await ingestBackgroundStageBCompletion({
			directory,
			record: coderRecord(directory, 'call-fresh', workspace),
			result: {
				text: 'coder finished',
				chars: 14,
				truncated: false,
				digest: 'deadbeef',
			},
			reviewerReceiptOptions: { config: { enabled: true } } as never,
		});

		expect(applied.ok).toBe(true);
		expect(applied.consumed).toBe(true);
	});

	test('missing session state (restart wipe) stays retryable — not provable as superseded', async () => {
		// No agentSessions entry for PARENT: the supersession predicate
		// deliberately fails closed (a restart wiped the generations, which is
		// not the same as a re-dispatch superseding them). The pre-existing
		// reconstruction failure semantics must be preserved.
		const workspace = captureWorkspaceSnapshot(directory);
		const applied = await ingestBackgroundStageBCompletion({
			directory,
			record: coderRecord(directory, 'call-restarted', workspace),
			result: {
				text: 'coder finished',
				chars: 14,
				truncated: false,
				digest: 'deadbeef',
			},
			reviewerReceiptOptions: { config: { enabled: true } } as never,
		});

		expect(applied.ok).toBe(false);
		expect(applied.consumed).toBe(false);
	});
});
