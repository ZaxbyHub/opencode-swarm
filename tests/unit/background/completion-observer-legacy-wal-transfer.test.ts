/**
 * Issue #2402 — a foreground coder launch can be reclassified as background
 * by the host's returned running envelope. The trusted background terminal must
 * retire the legacy foreground WAL before workflow ingestion.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createBackgroundCompletionObserver } from '../../../src/background/completion-observer';
import {
	buildBackgroundCompletionEventId,
	claimTerminalResult,
	findDelegationForCompletion,
} from '../../../src/background/pending-delegations';
import type { PluginConfig } from '../../../src/config';
import { readTaskEvidence } from '../../../src/gate-evidence';
import { createDelegationGateHook } from '../../../src/hooks/delegation-gate';
import { resetStandardWorktreeIsolationState } from '../../../src/hooks/delegation-gate/worktree-isolation';
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

function readLegacyWal(directory: string): Record<string, unknown> {
	return JSON.parse(
		fs.readFileSync(
			path.join(directory, '.swarm', 'coder-settlements', '1.1.json'),
			'utf8',
		),
	) as Record<string, unknown>;
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

async function deliverTerminal(
	directory: string,
	state: 'completed' | 'cancelled' | 'error',
): Promise<void> {
	const result =
		state === 'completed'
			? '<task_result>done</task_result>'
			: '<task_error>cancelled</task_error>';
	const observer = createBackgroundCompletionObserver({
		config: { enabled: true },
		directory,
	});
	await observer.event({
		event: {
			type: 'message.part.updated',
			properties: {
				part: {
					type: 'text',
					synthetic: true,
					sessionID: 'parent',
					text: `<task id="coder-session" state="${state}">${result}</task>`,
				},
			},
		},
	});
}

async function claimFailedTerminalWithoutProcessing(
	directory: string,
	state: 'cancelled' | 'error',
): Promise<void> {
	const lookup = await findDelegationForCompletion(directory, 'coder-session');
	if (!lookup) throw new Error('expected durable background delegation');
	const text = 'cancelled';
	const resultDigest = createHash('sha256').update(text).digest('hex');
	const eventId = buildBackgroundCompletionEventId({
		correlationId: lookup.record.correlationId,
		jobId: lookup.record.jobId,
		status: state,
		resultDigest,
	});
	await claimTerminalResult(directory, lookup.record.correlationId, {
		eventId,
		status: state,
		recordedAt: 1_726_012_345_678,
		result: {
			...(state === 'error' ? { error: text } : { text }),
			chars: text.length,
			truncated: false,
			digest: resultDigest,
		},
	});
}

describe('issue #2402 legacy coder WAL ownership transfer', () => {
	let directory = '';
	let cleanup = (): void => {};

	beforeEach(() => {
		resetSwarmState();
		const safe = createSafeTestDir('legacy-bg-wal-transfer-');
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
		releaseCoderDispatchOwnership(directory, '1.1', 'coder:coder-call');
		resetStandardWorktreeIsolationState();
		resetSwarmState();
		cleanup();
	});

	test('mixed foreground launch and background success retires the legacy WAL before ingestion', async () => {
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
		expect(readLegacyWal(directory).state).toBe('DISPATCHED');
		await hook.toolAfter(
			{ tool: 'Task', sessionID: 'parent', callID: 'coder-call', args },
			{
				state: 'running',
				output:
					'<task id="coder-session" state="running">Background task started</task>',
				metadata: { background: true, jobId: 'coder-job' },
			},
		);

		fs.mkdirSync(path.join(directory, 'src'), { recursive: true });
		fs.writeFileSync(path.join(directory, 'src', 'feature.ts'), 'feature\n');
		const observer = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
		});
		await observer.event({
			event: {
				type: 'message.part.updated',
				properties: {
					part: {
						type: 'text',
						synthetic: true,
						sessionID: 'parent',
						text: '<task id="coder-session" state="completed"><task_result>done</task_result></task>',
					},
				},
			},
		});

		expect(readLegacyWal(directory)).toMatchObject({
			state: 'ABORTED',
			cleanupComplete: true,
		});
		expect(String(readLegacyWal(directory).abortReason)).toContain(
			'background',
		);
		expect((await readTaskEvidence(directory, '1.1'))?.workflow?.state).toBe(
			'coder_delegated',
		);
	});

	test.each([
		'cancelled',
		'error',
	] as const)('trusted %s terminal retires the mixed-path legacy WAL', async (terminalState) => {
		await launchMixedBackground(directory);

		await deliverTerminal(directory, terminalState);

		expect(readLegacyWal(directory)).toMatchObject({
			state: 'ABORTED',
			cleanupComplete: true,
		});
	});

	test.each([
		'cancelled',
		'error',
	] as const)('replayed %s terminal resumes transfer after a post-claim crash', async (terminalState) => {
		await launchMixedBackground(directory);
		await claimFailedTerminalWithoutProcessing(directory, terminalState);
		resetStandardWorktreeIsolationState();
		resetSwarmState();

		await deliverTerminal(directory, terminalState);

		expect(readLegacyWal(directory)).toMatchObject({
			state: 'ABORTED',
			cleanupComplete: true,
		});
	});

	test('zero-change completion still retires the contradictory legacy owner', async () => {
		await launchMixedBackground(directory);

		await deliverTerminal(directory, 'completed');

		expect(readLegacyWal(directory)).toMatchObject({
			state: 'ABORTED',
			cleanupComplete: true,
		});
		expect((await readTaskEvidence(directory, '1.1'))?.workflow).toMatchObject({
			state: 'idle',
			lastOutcome: 'dispatch_no_mutation',
			retryCount: 1,
		});
	});

	test('preserved background attribution leaves the legacy WAL fail-closed', async () => {
		await launchMixedBackground(directory);
		fs.writeFileSync(path.join(directory, 'head-drift.txt'), 'drift\n');
		git(directory, ['add', 'head-drift.txt']);
		git(directory, ['commit', '-m', 'test: move head before terminal']);

		await deliverTerminal(directory, 'completed');

		expect(readLegacyWal(directory).state).toBe('DISPATCHED');
		expect((await readTaskEvidence(directory, '1.1'))?.workflow).toMatchObject({
			state: 'idle',
			lastOutcome: 'dispatch_attempted',
		});
	});

	test('durable terminal replay transfers without call-scoped in-memory state', async () => {
		await launchMixedBackground(directory);
		resetStandardWorktreeIsolationState();
		resetSwarmState();
		fs.mkdirSync(path.join(directory, 'src'), { recursive: true });
		fs.writeFileSync(path.join(directory, 'src', 'feature.ts'), 'feature\n');

		await deliverTerminal(directory, 'completed');

		expect(readLegacyWal(directory)).toMatchObject({
			state: 'ABORTED',
			cleanupComplete: true,
		});
		expect((await readTaskEvidence(directory, '1.1'))?.workflow?.state).toBe(
			'coder_delegated',
		);
	});
});
