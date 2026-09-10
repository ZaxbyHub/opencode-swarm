/**
 * Background completion observer workflow-gate tests.
 *
 * These cases cover ordered reviewer/test-engineer gate settlement after
 * background completion ingestion.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createBackgroundCompletionObserver } from '../../../src/background/completion-observer';
import {
	findByCorrelationId,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations';
import { _internals as workspaceSnapshotInternals } from '../../../src/background/workspace-snapshot';
import {
	readTaskEvidence,
	recordGateEvidence,
} from '../../../src/gate-evidence';
import {
	ensureAgentSession,
	getTaskState,
	resetSwarmState,
} from '../../../src/state';
import { checkReviewerGate } from '../../../src/tools/update-task-status';
import { createIsolatedTestEnv } from '../../helpers/isolated-test-env.js';
import { seedStageAPassed } from '../../helpers/task-workflow-evidence';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

function makeTempProject(): string {
	const real = canonicalMkdtemp('swarm-bgobs-gates-');
	fs.mkdirSync(path.join(real, '.swarm'), { recursive: true });
	fs.mkdirSync(path.join(real, '.opencode'), { recursive: true });
	fs.writeFileSync(
		path.join(real, '.opencode', 'opencode-swarm.json'),
		JSON.stringify({ review_routing: { enforce_receipts: false } }),
	);
	return real;
}

function syntheticPartEvent(opts: {
	text: string;
	synthetic?: boolean;
	sessionID?: string;
}) {
	return {
		event: {
			type: 'message.part.updated',
			properties: {
				part: {
					type: 'text',
					text: opts.text,
					synthetic: opts.synthetic,
					sessionID: opts.sessionID ?? 'parent_session',
				},
			},
		},
	};
}

const completedEnvelope = (id: string, taskId?: string) =>
	`<task id="${id}" state="completed">\n<task_result>${
		taskId
			? `[REVIEWED] | ${taskId} | APPROVED | no issues\n[TESTED] | ${taskId} | PASS | focused tests passed`
			: 'done'
	}</task_result>\n</task>`;

describe('background completion observer workflow gates', () => {
	let dir: string;
	let isolatedEnv: ReturnType<typeof createIsolatedTestEnv> | undefined;
	const realSpawnSync = workspaceSnapshotInternals.spawnSync;
	beforeEach(() => {
		isolatedEnv = createIsolatedTestEnv();
		resetSwarmState();
		workspaceSnapshotInternals.spawnSync = realSpawnSync;
		dir = makeTempProject();
	});
	afterEach(() => {
		workspaceSnapshotInternals.spawnSync = realSpawnSync;
		resetSwarmState();
		fs.rmSync(dir, { recursive: true, force: true });
		isolatedEnv?.cleanup();
		isolatedEnv = undefined;
	});

	it('applies trusted background test_engineer completion only after reviewer completion is present', async () => {
		const session = ensureAgentSession('parent_session');
		session.taskWorkflowStates.set('3.1', 'reviewer_run');
		const generation = await seedStageAPassed(dir, '3.1');
		await recordGateEvidence(
			dir,
			'3.1',
			'reviewer',
			'reviewer-session',
			false,
			{
				expectedGeneration: generation,
			},
		);

		await recordPendingDelegation(dir, {
			correlationId: 'ses_test_engineer',
			jobId: 'job_test',
			subagentSessionId: 'ses_test_engineer',
			parentSessionId: 'parent_session',
			callID: 'c-test',
			normalizedAgent: 'test_engineer',
			swarmPrefixedAgent: 'test_engineer',
			planTaskId: '3.1',
			evidenceTaskId: '3.1',
			workflowGeneration: generation,
		});

		const obs = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory: dir,
		});
		await obs.event(
			syntheticPartEvent({
				text: completedEnvelope('ses_test_engineer', '3.1'),
				synthetic: true,
			}),
		);

		expect(getTaskState(session, '3.1')).toBe('tests_run');
		expect(findByCorrelationId(dir, 'ses_test_engineer')?.status).toBe(
			'consumed',
		);
		const evidence = await readTaskEvidence(dir, '3.1');
		expect(evidence?.gates.test_engineer?.agent).toBe('test_engineer');
		expect(evidence?.required_gates).toEqual(['reviewer', 'test_engineer']);
	});

	it('keeps test_engineer-first completion blocked until reviewer also completes', async () => {
		const session = ensureAgentSession('parent_session');
		session.taskWorkflowStates.set('3.2', 'coder_delegated');
		const generation = await seedStageAPassed(dir, '3.2');

		await recordPendingDelegation(dir, {
			correlationId: 'ses_test_first',
			jobId: 'job_test_first',
			subagentSessionId: 'ses_test_first',
			parentSessionId: 'parent_session',
			callID: 'c-test-first',
			normalizedAgent: 'test_engineer',
			swarmPrefixedAgent: 'test_engineer',
			planTaskId: '3.2',
			evidenceTaskId: '3.2',
			workflowGeneration: generation,
		});
		await recordPendingDelegation(dir, {
			correlationId: 'ses_reviewer_second',
			jobId: 'job_reviewer_second',
			subagentSessionId: 'ses_reviewer_second',
			parentSessionId: 'parent_session',
			callID: 'c-reviewer-second',
			normalizedAgent: 'reviewer',
			swarmPrefixedAgent: 'reviewer',
			planTaskId: '3.2',
			evidenceTaskId: '3.2',
			workflowGeneration: generation,
		});

		const obs = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory: dir,
		});
		await obs.event(
			syntheticPartEvent({
				text: completedEnvelope('ses_test_first', '3.2'),
				synthetic: true,
			}),
		);

		expect(getTaskState(session, '3.2')).toBe('coder_delegated');
		let evidence = await readTaskEvidence(dir, '3.2');
		expect(evidence?.required_gates).toEqual(['reviewer', 'test_engineer']);
		expect(evidence?.gates.test_engineer?.agent).toBe('test_engineer');
		expect(checkReviewerGate('3.2', dir, true, 'parent_session').blocked).toBe(
			true,
		);

		await obs.event(
			syntheticPartEvent({
				text: completedEnvelope('ses_reviewer_second', '3.2'),
				synthetic: true,
			}),
		);

		expect(getTaskState(session, '3.2')).toBe('tests_run');
		expect(findByCorrelationId(dir, 'ses_test_first')?.status).toBe('consumed');
		expect(findByCorrelationId(dir, 'ses_reviewer_second')?.status).toBe(
			'consumed',
		);
		evidence = await readTaskEvidence(dir, '3.2');
		expect(evidence?.gates.reviewer?.agent).toBe('reviewer');
		expect(checkReviewerGate('3.2', dir, true, 'parent_session').blocked).toBe(
			false,
		);
	});
});
