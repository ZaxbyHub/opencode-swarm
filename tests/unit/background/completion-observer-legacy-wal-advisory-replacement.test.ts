/**
 * Issue #2402 — maintenance must reconcile durable and in-memory advisories
 * when a previously retryable legacy coder settlement becomes permanent.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	createBackgroundCompletionObserver,
	_internals as observerInternals,
} from '../../../src/background/completion-observer';
import {
	findDelegationForCompletion,
	maintainBackgroundDelegations,
} from '../../../src/background/pending-delegations';
import type { PluginConfig } from '../../../src/config';
import { createDelegationGateHook } from '../../../src/hooks/delegation-gate';
import { ensureAgentSession, resetSwarmState } from '../../../src/state';
import { releaseCoderDispatchOwnership } from '../../../src/workflow/coder-settlement';
import { writeApprovedPlan } from '../../helpers/approved-plan';
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
	if (result.status !== 0) throw new Error(result.stderr || result.stdout);
}

const config = {
	max_iterations: 5,
	qa_retry_limit: 3,
	inject_phase_reminders: true,
	hooks: {
		delegation_gate: true,
		background_subagents: true,
		background_pending_timeout_minutes: 30,
	},
	worktree: { policy: 'disabled' },
} as PluginConfig;

async function launchMixedBackground(directory: string): Promise<void> {
	await writeApprovedPlan(directory, [
		{ id: '1.1', files: ['src/feature.ts'] },
	]);
	const session = ensureAgentSession('parent', 'architect', directory);
	session.currentTaskId = '1.1';
	session.lastCoderDelegationTaskId = '1.1';
	const hook = createDelegationGateHook(config, directory);
	const args = {
		subagent_type: 'coder',
		task_id: '1.1',
		prompt: 'TASK: 1.1\nFILE: src/feature.ts\nACCEPTANCE: implemented',
	};
	await hook.toolBefore(
		{ tool: 'Task', sessionID: 'parent', callID: 'coder-call' },
		{ args },
	);
	await hook.toolAfter(
		{ tool: 'Task', sessionID: 'parent', callID: 'coder-call', args },
		{
			state: 'running',
			output:
				'<task id="coder-session" state="running">Background task started</task>',
			metadata: { background: true, jobId: 'coder-job' },
		},
	);
}

describe('issue #2402 legacy coder advisory replacement', () => {
	let directory = '';
	let cleanup = (): void => {};
	const realTransfer = observerInternals.transferCoderSettlementToBackground;
	const realMarkPending =
		observerInternals.markLegacyCoderSettlementTransferPending;
	const realSleep = observerInternals.sleep;

	beforeEach(() => {
		resetSwarmState();
		const safe = createSafeTestDir('legacy-bg-wal-advisory-');
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
		observerInternals.transferCoderSettlementToBackground = realTransfer;
		observerInternals.markLegacyCoderSettlementTransferPending =
			realMarkPending;
		observerInternals.sleep = realSleep;
		releaseCoderDispatchOwnership(directory, '1.1', 'coder:coder-call');
		resetSwarmState();
		cleanup();
	});

	test('manual advisory replacement — regression: stale queue entry is replaced exactly once (FB-014)', async () => {
		// Before FB-014, maintenance replaced the durable advisory but left the stale transfer warning in the live session queue.
		await launchMixedBackground(directory);
		const observer = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
		});
		observerInternals.transferCoderSettlementToBackground = async () => {
			throw new Error('CODER_SETTLEMENT_LOCKED: task 1.1');
		};
		observerInternals.sleep = async () => {};
		await observer.event({
			event: {
				type: 'message.part.updated',
				properties: {
					part: {
						type: 'text',
						synthetic: true,
						sessionID: 'parent',
						text: '<task id="coder-session" state="cancelled"><task_error>cancelled</task_error></task>',
					},
				},
			},
		});
		const session = ensureAgentSession('parent', 'architect', directory);
		session.pendingAdvisoryMessages.unshift('[OTHER] keep me');
		observerInternals.transferCoderSettlementToBackground = async () => {
			throw new Error('CODER_SETTLEMENT_WAL_REPLACED');
		};
		await maintainBackgroundDelegations(directory, {
			lockTimeoutMs: 1_000,
			onLegacyCoderSettlementReconciled: observer.reconcilePending,
			onLegacyCoderSettlementAdvisoryReplaced:
				observer.notifyLegacyCoderSettlementAdvisoryReplaced,
		});
		const messages = session.pendingAdvisoryMessages;
		expect(
			messages.filter((message) =>
				message.includes('legacy coder settlement requires manual recovery'),
			),
		).toHaveLength(1);
		expect(messages).toContain('[OTHER] keep me');
		expect(
			messages.some((message) => message.includes('transfer is pending')),
		).toBe(false);
		const recovered = await findDelegationForCompletion(
			directory,
			'coder-session',
		);
		expect(recovered?.record.advisoryInbox?.message).toContain(
			'legacy coder settlement requires manual recovery',
		);
		expect(recovered?.record.legacyCoderSettlementTransfer).toBeUndefined();
	});
});
