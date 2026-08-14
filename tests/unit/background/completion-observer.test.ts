/**
 * Background completion observer tests.
 *
 * Advisory completion ingestion mutates only the durable background ledger. It never
 * advances workflow gates.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createBackgroundCompletionObserver } from '../../../src/background/completion-observer';
import {
	type BackgroundWorkspaceSnapshot,
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
import { seedStageAPassed } from '../../helpers/task-workflow-evidence';

function makeTempProject(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-bgobs-'));
	const real = fs.realpathSync(dir);
	fs.mkdirSync(path.join(real, '.swarm'), { recursive: true });
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

describe('background completion observer', () => {
	let dir: string;
	const realSpawnSync = workspaceSnapshotInternals.spawnSync;
	beforeEach(() => {
		resetSwarmState();
		workspaceSnapshotInternals.spawnSync = realSpawnSync;
		dir = makeTempProject();
	});
	afterEach(() => {
		workspaceSnapshotInternals.spawnSync = realSpawnSync;
		resetSwarmState();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('is a no-op when disabled', async () => {
		const obs = createBackgroundCompletionObserver({
			config: { enabled: false },
			directory: dir,
		});
		await expect(
			obs.event(
				syntheticPartEvent({
					text: completedEnvelope('ses_1'),
					synthetic: true,
				}),
			),
		).resolves.toBeUndefined();
	});

	it('records a trusted correlated completion in the durable ledger', async () => {
		await recordPendingDelegation(dir, {
			correlationId: 'ses_obs',
			jobId: 'job_obs',
			subagentSessionId: 'ses_obs',
			parentSessionId: 'parent_session',
			callID: 'c1',
			normalizedAgent: 'explorer',
			swarmPrefixedAgent: 'explorer',
			planTaskId: null,
			evidenceTaskId: null,
			batchId: 'batch-1',
			laneId: 'lane-1',
		});

		const obs = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory: dir,
		});
		await obs.event(
			syntheticPartEvent({
				text: completedEnvelope('ses_obs'),
				synthetic: true,
			}),
		);

		const record = findByCorrelationId(dir, 'ses_obs');
		expect(record?.status).toBe('completed');
		expect(record?.result?.text).toBe('done');
	});

	it('leaves non-gate-bearing background completions as settled ledger rows only', async () => {
		await recordPendingDelegation(dir, {
			correlationId: 'ses_lane_only',
			jobId: 'job_lane_only',
			subagentSessionId: 'ses_lane_only',
			parentSessionId: 'parent_session',
			callID: 'batch-1',
			normalizedAgent: 'explorer',
			swarmPrefixedAgent: 'explorer',
			planTaskId: null,
			evidenceTaskId: null,
			batchId: 'batch-1',
			laneId: 'lane-1',
		});

		const obs = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory: dir,
		});
		await obs.event(
			syntheticPartEvent({
				text: completedEnvelope('ses_lane_only'),
				synthetic: true,
			}),
		);

		const record = findByCorrelationId(dir, 'ses_lane_only');
		expect(record?.status).toBe('completed');
		expect(await readTaskEvidence(dir, 'lane-1')).toBeNull();
	});

	it('does not advance unrelated sessions that share the same task id', async () => {
		const parent = ensureAgentSession('parent_session');
		parent.taskWorkflowStates.set('1.2', 'coder_delegated');
		const unrelated = ensureAgentSession('other_parent_session');
		unrelated.taskWorkflowStates.set('1.2', 'coder_delegated');
		const generation = await seedStageAPassed(dir, '1.2');

		await recordPendingDelegation(dir, {
			correlationId: 'ses_scoped_reviewer',
			jobId: 'job_scoped',
			subagentSessionId: 'ses_scoped_reviewer',
			parentSessionId: 'parent_session',
			callID: 'c-scoped',
			normalizedAgent: 'reviewer',
			swarmPrefixedAgent: 'reviewer',
			planTaskId: '1.2',
			evidenceTaskId: '1.2',
			workflowGeneration: generation,
		});

		const obs = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory: dir,
		});
		await obs.event(
			syntheticPartEvent({
				text: completedEnvelope('ses_scoped_reviewer', '1.2'),
				synthetic: true,
			}),
		);

		expect(getTaskState(parent, '1.2')).toBe('reviewer_run');
		expect(getTaskState(unrelated, '1.2')).toBe('coder_delegated');
	});

	it('marks background Stage B completion stale when workspace changed and does not advance gates', async () => {
		const session = ensureAgentSession('parent_session');
		session.taskWorkflowStates.set('2.1', 'coder_delegated');
		const staleWorkspace: BackgroundWorkspaceSnapshot = {
			directory: dir,
			gitHead: 'old-head',
			dirtyHash: 'old-dirty',
			prHeadSha: null,
			scope: '2.1',
		};
		workspaceSnapshotInternals.spawnSync = ((_command, args) => {
			const argv = Array.isArray(args) ? args.map(String) : [];
			if (argv.includes('rev-parse')) {
				return { status: 0, stdout: 'new-head\n', stderr: '' };
			}
			if (argv.includes('status')) {
				return { status: 0, stdout: '', stderr: '' };
			}
			return { status: 1, stdout: '', stderr: 'unexpected git command' };
		}) as typeof workspaceSnapshotInternals.spawnSync;

		await recordPendingDelegation(dir, {
			correlationId: 'ses_stale_reviewer',
			jobId: 'job_stale',
			subagentSessionId: 'ses_stale_reviewer',
			parentSessionId: 'parent_session',
			callID: 'c-stale',
			normalizedAgent: 'reviewer',
			swarmPrefixedAgent: 'reviewer',
			planTaskId: '2.1',
			evidenceTaskId: '2.1',
			workspace: staleWorkspace,
		});

		const obs = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory: dir,
		});
		await obs.event(
			syntheticPartEvent({
				text: completedEnvelope('ses_stale_reviewer', '2.1'),
				synthetic: true,
			}),
		);

		expect(getTaskState(session, '2.1')).toBe('coder_delegated');
		expect(findByCorrelationId(dir, 'ses_stale_reviewer')?.status).toBe(
			'stale',
		);
		expect(await readTaskEvidence(dir, '2.1')).toBeNull();
	});

	it('marks background Stage B completion stale when tracked prHeadSha changed', async () => {
		const session = ensureAgentSession('parent_session');
		session.taskWorkflowStates.set('2.1-pr', 'coder_delegated');
		const staleWorkspace: BackgroundWorkspaceSnapshot = {
			directory: dir,
			gitHead: 'same-head',
			dirtyHash: null,
			prHeadSha: 'origin/pr-head-old',
			scope: '2.1-pr',
		};
		workspaceSnapshotInternals.spawnSync = ((_command, args) => {
			const argv = Array.isArray(args) ? args.map(String) : [];
			if (argv.includes('HEAD')) {
				return { status: 0, stdout: 'same-head\n', stderr: '' };
			}
			if (argv.includes('--porcelain=v1')) {
				return { status: 0, stdout: '', stderr: '' };
			}
			if (argv.includes('@{upstream}')) {
				return { status: 0, stdout: 'origin/pr-head-new\n', stderr: '' };
			}
			return { status: 1, stdout: '', stderr: 'unexpected git command' };
		}) as typeof workspaceSnapshotInternals.spawnSync;

		await recordPendingDelegation(dir, {
			correlationId: 'ses_prhead_stale',
			jobId: 'job_prhead_stale',
			subagentSessionId: 'ses_prhead_stale',
			parentSessionId: 'parent_session',
			callID: 'c-pr-stale',
			normalizedAgent: 'reviewer',
			swarmPrefixedAgent: 'reviewer',
			planTaskId: '2.1-pr',
			evidenceTaskId: '2.1-pr',
			workspace: staleWorkspace,
		});

		const obs = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory: dir,
		});
		await obs.event(
			syntheticPartEvent({
				text: completedEnvelope('ses_prhead_stale', '2.1-pr'),
				synthetic: true,
			}),
		);

		expect(getTaskState(session, '2.1-pr')).toBe('coder_delegated');
		expect(findByCorrelationId(dir, 'ses_prhead_stale')?.status).toBe('stale');
		expect(await readTaskEvidence(dir, '2.1-pr')).toBeNull();
	});

	it('keeps failed Stage B ingestion retryable until evidence is applied', async () => {
		const session = ensureAgentSession('parent_session');
		session.taskWorkflowStates.set('2.2', 'coder_delegated');
		const evidenceDir = path.join(dir, '.swarm', 'evidence');
		fs.mkdirSync(evidenceDir, { recursive: true });
		fs.writeFileSync(path.join(evidenceDir, '2.2.json'), '{bad json');

		await recordPendingDelegation(dir, {
			correlationId: 'ses_retry_reviewer',
			jobId: 'job_retry',
			subagentSessionId: 'ses_retry_reviewer',
			parentSessionId: 'parent_session',
			callID: 'c-retry',
			normalizedAgent: 'reviewer',
			swarmPrefixedAgent: 'reviewer',
			planTaskId: '2.2',
			evidenceTaskId: '2.2',
			workflowGeneration: 1,
		});

		const obs = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory: dir,
		});
		await obs.event(
			syntheticPartEvent({
				text: completedEnvelope('ses_retry_reviewer', '2.2'),
				synthetic: true,
			}),
		);

		expect(findByCorrelationId(dir, 'ses_retry_reviewer')?.status).toBe(
			'ingestion_error',
		);
		expect(getTaskState(session, '2.2')).toBe('coder_delegated');

		fs.unlinkSync(path.join(evidenceDir, '2.2.json'));
		await seedStageAPassed(dir, '2.2');
		await obs.event(
			syntheticPartEvent({
				text: completedEnvelope('ses_retry_reviewer', '2.2'),
				synthetic: true,
			}),
		);

		expect(findByCorrelationId(dir, 'ses_retry_reviewer')?.status).toBe(
			'consumed',
		);
		expect(getTaskState(session, '2.2')).toBe('reviewer_run');
		const evidence = await readTaskEvidence(dir, '2.2');
		expect(evidence?.required_gates).toEqual(['reviewer', 'test_engineer']);
	});

	it('keeps unrecoverable Stage B ingestion failures at ingestion_error on replay', async () => {
		const session = ensureAgentSession('parent_session');
		session.taskWorkflowStates.set('2.3', 'coder_delegated');
		const evidenceDir = path.join(dir, '.swarm', 'evidence');
		fs.mkdirSync(evidenceDir, { recursive: true });
		fs.writeFileSync(path.join(evidenceDir, '2.3.json'), '{still bad json');

		await recordPendingDelegation(dir, {
			correlationId: 'ses_retry_still_broken',
			jobId: 'job_retry_still_broken',
			subagentSessionId: 'ses_retry_still_broken',
			parentSessionId: 'parent_session',
			callID: 'c-retry-still-broken',
			normalizedAgent: 'reviewer',
			swarmPrefixedAgent: 'reviewer',
			planTaskId: '2.3',
			evidenceTaskId: '2.3',
		});

		const obs = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory: dir,
		});
		await obs.event(
			syntheticPartEvent({
				text: completedEnvelope('ses_retry_still_broken', '2.3'),
				synthetic: true,
			}),
		);
		await obs.event(
			syntheticPartEvent({
				text: completedEnvelope('ses_retry_still_broken', '2.3'),
				synthetic: true,
			}),
		);

		expect(findByCorrelationId(dir, 'ses_retry_still_broken')?.status).toBe(
			'ingestion_error',
		);
		expect(getTaskState(session, '2.3')).toBe('coder_delegated');
		expect(await readTaskEvidence(dir, '2.3')).toBeNull();
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
