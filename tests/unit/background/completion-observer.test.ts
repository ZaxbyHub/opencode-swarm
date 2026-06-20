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
import { readTaskEvidence } from '../../../src/gate-evidence';
import { readAllReceipts } from '../../../src/hooks/review-receipt';
import {
	ensureAgentSession,
	getTaskState,
	resetSwarmState,
} from '../../../src/state';
import { checkReviewerGate } from '../../../src/tools/update-task-status';

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

const completedEnvelope = (id: string) =>
	`<task id="${id}" state="completed">\n<task_result>done</task_result>\n</task>`;

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

	it('applies trusted background Stage B reviewer completion to workflow state, evidence, and receipt', async () => {
		const session = ensureAgentSession('parent_session');
		session.taskWorkflowStates.set('1.1', 'coder_delegated');

		await recordPendingDelegation(dir, {
			correlationId: 'ses_reviewer',
			jobId: 'job_reviewer',
			subagentSessionId: 'ses_reviewer',
			parentSessionId: 'parent_session',
			callID: 'c-reviewer',
			normalizedAgent: 'reviewer',
			swarmPrefixedAgent: 'reviewer',
			planTaskId: '1.1',
			evidenceTaskId: '1.1',
			prompt: {
				text: 'TASK: 1.1\nCHECK: [security, correctness]',
				chars: 40,
				truncated: false,
				digest: 'prompt-digest',
			},
		});

		const obs = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory: dir,
		});
		await obs.event(
			syntheticPartEvent({
				text:
					'<task id="ses_reviewer" state="completed">\n' +
					'<task_result>VERDICT: APPROVED\nRISK: LOW\nISSUES: none\nFIXES: none</task_result>\n' +
					'</task>',
				synthetic: true,
			}),
		);

		expect(getTaskState(session, '1.1')).toBe('reviewer_run');
		const record = findByCorrelationId(dir, 'ses_reviewer');
		expect(record?.status).toBe('consumed');

		const evidence = await readTaskEvidence(dir, '1.1');
		expect(evidence?.gates.reviewer?.agent).toBe('reviewer');
		expect(evidence?.required_gates).toEqual(['reviewer', 'test_engineer']);
		expect(checkReviewerGate('1.1', dir, true, 'parent_session').blocked).toBe(
			true,
		);

		const receipts = await readAllReceipts(dir);
		expect(receipts).toHaveLength(1);
		expect(receipts[0].verdict).toBe('approved');
	});

	it('does not advance unrelated sessions that share the same task id', async () => {
		const parent = ensureAgentSession('parent_session');
		parent.taskWorkflowStates.set('1.2', 'coder_delegated');
		const unrelated = ensureAgentSession('other_parent_session');
		unrelated.taskWorkflowStates.set('1.2', 'coder_delegated');

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
		});

		const obs = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory: dir,
		});
		await obs.event(
			syntheticPartEvent({
				text: completedEnvelope('ses_scoped_reviewer'),
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
				text: completedEnvelope('ses_stale_reviewer'),
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
				text: completedEnvelope('ses_prhead_stale'),
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
		});

		const obs = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory: dir,
		});
		await obs.event(
			syntheticPartEvent({
				text: completedEnvelope('ses_retry_reviewer'),
				synthetic: true,
			}),
		);

		expect(findByCorrelationId(dir, 'ses_retry_reviewer')?.status).toBe(
			'ingestion_error',
		);
		expect(getTaskState(session, '2.2')).toBe('coder_delegated');

		fs.unlinkSync(path.join(evidenceDir, '2.2.json'));
		await obs.event(
			syntheticPartEvent({
				text: completedEnvelope('ses_retry_reviewer'),
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
				text: completedEnvelope('ses_retry_still_broken'),
				synthetic: true,
			}),
		);
		await obs.event(
			syntheticPartEvent({
				text: completedEnvelope('ses_retry_still_broken'),
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
		});

		const obs = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory: dir,
		});
		await obs.event(
			syntheticPartEvent({
				text: completedEnvelope('ses_test_engineer'),
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
		});

		const obs = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory: dir,
		});
		await obs.event(
			syntheticPartEvent({
				text: completedEnvelope('ses_test_first'),
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
				text: completedEnvelope('ses_reviewer_second'),
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

	it('ignores a correlated completion with the wrong parent session', async () => {
		await recordPendingDelegation(dir, {
			correlationId: 'ses_parent_mismatch',
			jobId: 'job_obs',
			subagentSessionId: 'ses_parent_mismatch',
			parentSessionId: 'parent_session',
			callID: 'c1',
			normalizedAgent: 'reviewer',
			swarmPrefixedAgent: 'reviewer',
			planTaskId: '1.1',
			evidenceTaskId: '1.1',
		});

		const obs = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory: dir,
		});
		await obs.event(
			syntheticPartEvent({
				text: completedEnvelope('ses_parent_mismatch'),
				synthetic: true,
				sessionID: 'other_parent',
			}),
		);

		expect(findByCorrelationId(dir, 'ses_parent_mismatch')?.status).toBe(
			'pending',
		);
	});

	it('ignores non-synthetic envelope-shaped text (trust gate)', async () => {
		const obs = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory: dir,
		});
		await expect(
			obs.event(
				syntheticPartEvent({
					text: completedEnvelope('ses_spoof'),
					synthetic: false,
				}),
			),
		).resolves.toBeUndefined();
	});

	it('ignores non-text / non-part / unrelated events without throwing', async () => {
		const obs = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory: dir,
		});
		await expect(
			obs.event({ event: { type: 'session.idle', properties: {} } }),
		).resolves.toBeUndefined();
		await expect(obs.event({ event: undefined })).resolves.toBeUndefined();
		await expect(
			obs.event({
				event: {
					type: 'message.part.updated',
					properties: { part: { type: 'file' } },
				},
			}),
		).resolves.toBeUndefined();
	});

	it('handles a synthetic completion with no matching pending record (no throw)', async () => {
		const obs = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory: dir,
		});
		await expect(
			obs.event(
				syntheticPartEvent({
					text: completedEnvelope('ses_unknown'),
					synthetic: true,
				}),
			),
		).resolves.toBeUndefined();
	});

	it('ignores a running (non-terminal) synthetic envelope', async () => {
		const obs = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory: dir,
		});
		await expect(
			obs.event(
				syntheticPartEvent({
					text: '<task id="ses_run" state="running"></task>',
					synthetic: true,
				}),
			),
		).resolves.toBeUndefined();
	});
});
