import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createBackgroundCompletionObserver } from '../../../src/background/completion-observer';
import {
	buildBackgroundCompletionEventId,
	claimCoderSettlement,
	claimDelegationIngestion,
	claimTerminalResult,
	findByCorrelationId,
	recordPendingDelegation,
	updateCoderSettlement,
} from '../../../src/background/pending-delegations';
import { captureWorkspaceSnapshot } from '../../../src/background/workspace-snapshot';
import { readTaskEvidence } from '../../../src/gate-evidence';
import {
	ensureAgentSession,
	getModifiedFilesForTask,
	getTaskState,
	resetSwarmState,
} from '../../../src/state';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

function git(directory: string, args: string[]): void {
	const result = spawnSync('git', ['-C', directory, ...args], {
		cwd: directory,
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
		encoding: 'utf8',
		timeout: 5_000,
		maxBuffer: 128 * 1024,
	});
	if (result.status !== 0) {
		throw new Error(
			result.stderr || result.stdout || `git exited ${result.status}`,
		);
	}
}

function completedEvent(correlationId: string, parentSessionId = 'parent') {
	return {
		event: {
			type: 'message.part.updated',
			properties: {
				part: {
					type: 'text',
					synthetic: true,
					sessionID: parentSessionId,
					text:
						`<task id="${correlationId}" state="completed">\n` +
						'<task_result>coder finished</task_result>\n</task>',
				},
			},
		},
	};
}

describe('background coder completion integration', () => {
	let directory = '';
	let cleanup = (): void => {};

	beforeEach(() => {
		resetSwarmState();
		const safe = createSafeTestDir('swarm-bg-coder-');
		directory = safe.dir;
		cleanup = safe.cleanup;
		fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });
		git(directory, ['init']);
		git(directory, ['config', 'user.email', 'tests@example.com']);
		git(directory, ['config', 'user.name', 'Tests']);
		fs.writeFileSync(path.join(directory, 'base.txt'), 'base\n');
		git(directory, ['add', 'base.txt']);
		git(directory, ['commit', '-m', 'test: seed repository']);
		fs.appendFileSync(
			path.join(directory, '.git', 'info', 'exclude'),
			'\n.swarm/\n',
		);
	});

	afterEach(() => {
		resetSwarmState();
		cleanup();
	});

	test('trusted fresh completion wires exact parent state, files, evidence, and advisory', async () => {
		const session = ensureAgentSession('parent', 'architect');
		session.currentTaskId = '1.1';
		session.lastCoderDelegationTaskId = '1.1';
		const baseline = captureWorkspaceSnapshot(directory);
		await recordPendingDelegation(directory, {
			correlationId: 'coder-session',
			jobId: 'job-coder',
			subagentSessionId: 'coder-session',
			parentSessionId: 'parent',
			callID: 'coder-call',
			normalizedAgent: 'coder',
			swarmPrefixedAgent: 'coder',
			planTaskId: '1.1',
			evidenceTaskId: '1.1',
			workspace: baseline,
			taskChangeContext: {
				declaredFiles: ['src/feature.ts'],
				baseline,
			},
		});
		fs.mkdirSync(path.join(directory, 'src'));
		fs.writeFileSync(
			path.join(directory, 'src', 'feature.ts'),
			'export const feature = true;\n',
		);

		const observer = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
		});
		await observer.event(completedEvent('coder-session'));

		expect(findByCorrelationId(directory, 'coder-session')?.status).toBe(
			'consumed',
		);
		expect(getTaskState(session, '1.1')).toBe('coder_delegated');
		expect(session.modifiedFilesThisCoderTask).toEqual(['src/feature.ts']);
		expect((await readTaskEvidence(directory, '1.1'))?.required_gates).toEqual([
			'reviewer',
			'test_engineer',
		]);
		expect(session.pendingAdvisoryMessages).toHaveLength(1);
		expect(session.pendingAdvisoryMessages?.[0]).toContain('coder');
		expect(session.pendingAdvisoryMessages?.[0]).toContain('1.1');
	});

	test('HEAD drift is stale and cannot publish coder state or evidence', async () => {
		const session = ensureAgentSession('parent', 'architect');
		session.currentTaskId = '2.1';
		session.lastCoderDelegationTaskId = '2.1';
		const baseline = captureWorkspaceSnapshot(directory);
		await recordPendingDelegation(directory, {
			correlationId: 'stale-coder',
			jobId: null,
			subagentSessionId: 'stale-coder',
			parentSessionId: 'parent',
			callID: 'stale-call',
			normalizedAgent: 'coder',
			swarmPrefixedAgent: 'coder',
			planTaskId: '2.1',
			evidenceTaskId: '2.1',
			workspace: baseline,
			taskChangeContext: {
				declaredFiles: ['src/feature.ts'],
				baseline,
			},
		});
		fs.writeFileSync(path.join(directory, 'external.txt'), 'external\n');
		git(directory, ['add', 'external.txt']);
		git(directory, ['commit', '-m', 'test: move target head']);

		const observer = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
		});
		await observer.event(completedEvent('stale-coder'));

		expect(findByCorrelationId(directory, 'stale-coder')?.status).toBe('stale');
		expect(getTaskState(session, '2.1')).toBe('idle');
		expect(session.modifiedFilesThisCoderTask).toEqual([]);
		expect(await readTaskEvidence(directory, '2.1')).toBeNull();
		expect(session.pendingAdvisoryMessages).toHaveLength(1);
		expect(session.pendingAdvisoryMessages?.[0]).toContain('stale');
	});

	test('duplicate trusted terminal delivery queues one advisory', async () => {
		const session = ensureAgentSession('parent', 'architect');
		session.currentTaskId = '3.1';
		session.lastCoderDelegationTaskId = '3.1';
		const baseline = captureWorkspaceSnapshot(directory);
		await recordPendingDelegation(directory, {
			correlationId: 'duplicate-coder',
			jobId: null,
			subagentSessionId: 'duplicate-coder',
			parentSessionId: 'parent',
			callID: 'duplicate-call',
			normalizedAgent: 'coder',
			swarmPrefixedAgent: 'coder',
			planTaskId: '3.1',
			evidenceTaskId: '3.1',
			workspace: baseline,
			taskChangeContext: { declaredFiles: ['README.md'], baseline },
		});
		fs.writeFileSync(path.join(directory, 'README.md'), '# done\n');
		const observer = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
		});

		await observer.event(completedEvent('duplicate-coder'));
		await observer.event(completedEvent('duplicate-coder'));

		expect(session.pendingAdvisoryMessages).toHaveLength(1);
	});

	test('late coder completion cannot overwrite a task already in reviewer state', async () => {
		const session = ensureAgentSession('parent', 'architect');
		session.currentTaskId = '4.1';
		session.lastCoderDelegationTaskId = '4.1';
		session.taskWorkflowStates.set('4.1', 'reviewer_run');
		const baseline = captureWorkspaceSnapshot(directory);
		await recordPendingDelegation(directory, {
			correlationId: 'late-coder',
			jobId: null,
			subagentSessionId: 'late-coder',
			parentSessionId: 'parent',
			callID: 'late-call',
			normalizedAgent: 'coder',
			swarmPrefixedAgent: 'coder',
			planTaskId: '4.1',
			evidenceTaskId: '4.1',
			workspace: baseline,
			taskChangeContext: { declaredFiles: ['late.ts'], baseline },
		});
		fs.writeFileSync(
			path.join(directory, 'late.ts'),
			'export const late = true;\n',
		);

		const observer = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
		});
		await observer.event(completedEvent('late-coder'));

		expect(findByCorrelationId(directory, 'late-coder')?.status).toBe(
			'ingestion_error',
		);
		expect(getTaskState(session, '4.1')).toBe('reviewer_run');
		expect(session.modifiedFilesThisCoderTask).toEqual([]);
		expect(await readTaskEvidence(directory, '4.1')).toBeNull();
	});

	test('reverse-order shared-root coders attribute only their declared task files', async () => {
		const session = ensureAgentSession('parent', 'architect');
		session.currentTaskId = '5.1';
		session.lastCoderDelegationTaskId = '5.1';
		const baseline = captureWorkspaceSnapshot(directory);
		for (const [correlationId, taskId, declaredFile] of [
			['coder-first', '5.1', 'src/first.ts'],
			['coder-second', '5.2', 'src/second.ts'],
		] as const) {
			await recordPendingDelegation(directory, {
				correlationId,
				jobId: null,
				subagentSessionId: correlationId,
				parentSessionId: 'parent',
				callID: `${correlationId}-call`,
				normalizedAgent: 'coder',
				swarmPrefixedAgent: 'coder',
				planTaskId: taskId,
				evidenceTaskId: taskId,
				workspace: baseline,
				taskChangeContext: { declaredFiles: [declaredFile], baseline },
			});
		}
		fs.mkdirSync(path.join(directory, 'src'));
		fs.writeFileSync(path.join(directory, 'src', 'first.ts'), 'first\n');
		fs.writeFileSync(path.join(directory, 'src', 'second.ts'), 'second\n');
		const observer = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
		});

		await observer.event(completedEvent('coder-second'));
		await observer.event(completedEvent('coder-first'));

		expect(getModifiedFilesForTask(session, '5.1')).toEqual(['src/first.ts']);
		expect(getModifiedFilesForTask(session, '5.2')).toEqual(['src/second.ts']);
	});

	test('busy ingestion replay cannot publish a false success advisory', async () => {
		const session = ensureAgentSession('parent', 'architect');
		session.currentTaskId = '6.1';
		const baseline = captureWorkspaceSnapshot(directory);
		await recordPendingDelegation(directory, {
			correlationId: 'busy-coder',
			jobId: null,
			subagentSessionId: 'busy-coder',
			parentSessionId: 'parent',
			callID: 'busy-call',
			normalizedAgent: 'coder',
			swarmPrefixedAgent: 'coder',
			planTaskId: '6.1',
			evidenceTaskId: '6.1',
			workspace: baseline,
			taskChangeContext: { declaredFiles: ['busy.ts'], baseline },
		});
		fs.writeFileSync(path.join(directory, 'busy.ts'), 'busy\n');
		const resultDigest = createHash('sha256')
			.update('coder finished')
			.digest('hex');
		const terminal = {
			eventId: buildBackgroundCompletionEventId({
				correlationId: 'busy-coder',
				jobId: null,
				status: 'completed',
				resultDigest,
			}),
			status: 'completed' as const,
			recordedAt: Date.now(),
			result: {
				text: 'coder finished',
				chars: 14,
				truncated: false,
				digest: resultDigest,
			},
		};
		await claimTerminalResult(directory, 'busy-coder', terminal);
		await claimCoderSettlement(directory, 'busy-coder', terminal.eventId);
		await updateCoderSettlement(directory, 'busy-coder', {
			operationId: terminal.eventId,
			state: 'settled',
			observedFiles: ['busy.ts'],
			outcome: { kind: 'shared-root', result: 'ready' },
		});
		await claimDelegationIngestion(directory, 'busy-coder', {
			claimantId: 'other-observer',
		});
		const observer = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
		});

		await observer.event(completedEvent('busy-coder'));

		expect(session.pendingAdvisoryMessages).toEqual([]);
		expect(findByCorrelationId(directory, 'busy-coder')?.status).toBe(
			'completed',
		);
	});

	test('observer retry uses a new fencing token after an interrupted lease', async () => {
		const session = ensureAgentSession('parent', 'architect');
		session.currentTaskId = '6.2';
		const baseline = captureWorkspaceSnapshot(directory);
		await recordPendingDelegation(directory, {
			correlationId: 'recovered-coder',
			jobId: null,
			subagentSessionId: 'recovered-coder',
			parentSessionId: 'parent',
			callID: 'recovered-call',
			normalizedAgent: 'coder',
			swarmPrefixedAgent: 'coder',
			planTaskId: '6.2',
			evidenceTaskId: '6.2',
			workspace: baseline,
			taskChangeContext: { declaredFiles: ['recovered.ts'], baseline },
		});
		fs.writeFileSync(path.join(directory, 'recovered.ts'), 'recovered\n');
		const resultDigest = createHash('sha256')
			.update('coder finished')
			.digest('hex');
		const eventId = buildBackgroundCompletionEventId({
			correlationId: 'recovered-coder',
			jobId: null,
			status: 'completed',
			resultDigest,
		});
		await claimTerminalResult(directory, 'recovered-coder', {
			eventId,
			status: 'completed',
			recordedAt: 1,
			result: {
				text: 'coder finished',
				chars: 14,
				truncated: false,
				digest: resultDigest,
			},
		});
		await claimCoderSettlement(directory, 'recovered-coder', eventId);
		await updateCoderSettlement(directory, 'recovered-coder', {
			operationId: eventId,
			state: 'settled',
			observedFiles: ['recovered.ts'],
			outcome: { kind: 'shared-root', result: 'ready' },
		});
		const crashed = await claimDelegationIngestion(
			directory,
			'recovered-coder',
			{ claimantId: eventId, now: 1, leaseMs: 1_000 },
		);

		const observer = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
		});
		await observer.event(completedEvent('recovered-coder'));

		const recovered = findByCorrelationId(directory, 'recovered-coder');
		expect(recovered?.status).toBe('consumed');
		expect(recovered?.ingestion?.attempt).toBe(2);
		expect(recovered?.ingestion?.claimToken).not.toBe(
			crashed?.record.ingestion?.claimToken,
		);
	});

	test('fenced commit failure cannot publish completed-and-settled success', async () => {
		const session = ensureAgentSession('parent', 'architect');
		session.currentTaskId = '6.3';
		const baseline = captureWorkspaceSnapshot(directory);
		await recordPendingDelegation(directory, {
			correlationId: 'commit-failure-coder',
			jobId: null,
			subagentSessionId: 'commit-failure-coder',
			parentSessionId: 'parent',
			callID: 'commit-failure-call',
			normalizedAgent: 'coder',
			swarmPrefixedAgent: 'coder',
			planTaskId: '6.3',
			evidenceTaskId: '6.3',
			workspace: baseline,
			taskChangeContext: { declaredFiles: ['commit-failure.ts'], baseline },
		});
		fs.writeFileSync(
			path.join(directory, 'commit-failure.ts'),
			'commit failure\n',
		);
		const observer = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
			recordIngestionResult: async () => null,
		});

		await observer.event(completedEvent('commit-failure-coder'));

		const record = findByCorrelationId(directory, 'commit-failure-coder');
		expect(record?.status).toBe('completed');
		expect(record?.ingestion?.state).toBe('claimed');
		expect(session.pendingAdvisoryMessages).toEqual([]);
	});

	test('taskless completion is durably consumed once without Stage B mutation', async () => {
		const session = ensureAgentSession('parent', 'architect');
		const baseline = captureWorkspaceSnapshot(directory);
		await recordPendingDelegation(directory, {
			correlationId: 'taskless-coder',
			jobId: null,
			subagentSessionId: 'taskless-coder',
			parentSessionId: 'parent',
			callID: 'taskless-call',
			normalizedAgent: 'coder',
			swarmPrefixedAgent: 'coder',
			planTaskId: null,
			evidenceTaskId: null,
			workspace: baseline,
			taskChangeContext: { declaredFiles: ['taskless.ts'], baseline },
		});
		fs.writeFileSync(path.join(directory, 'taskless.ts'), 'taskless\n');
		const observer = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
		});

		await observer.event(completedEvent('taskless-coder'));
		await observer.event(completedEvent('taskless-coder'));

		const record = findByCorrelationId(directory, 'taskless-coder');
		expect(record?.status).toBe('consumed');
		expect(record?.ingestion?.state).toBe('consumed');
		expect(record?.ingestion?.attempt).toBe(1);
		expect(getTaskState(session, 'unrelated')).toBe('idle');
		expect(getModifiedFilesForTask(session, 'unrelated')).toEqual([]);
		expect(await readTaskEvidence(directory, 'unrelated')).toBeNull();
		expect(session.pendingAdvisoryMessages).toHaveLength(1);
		expect(session.pendingAdvisoryMessages?.[0]).toContain(
			'completed and settled',
		);
	});
});
