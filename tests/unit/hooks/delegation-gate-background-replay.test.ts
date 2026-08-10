import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
	BACKGROUND_DELEGATIONS_FILE,
	findByCorrelationId,
	recordPendingDelegation,
	scanBackgroundCoderReservationsForAdmission,
} from '../../../src/background/pending-delegations';
import type { PluginConfig } from '../../../src/config';
import { createDelegationGateHook } from '../../../src/hooks/delegation-gate';
import { resetStandardWorktreeIsolationState } from '../../../src/hooks/delegation-gate/worktree-isolation';
import { ensureAgentSession, resetSwarmState } from '../../../src/state';
import { writeApprovedPlan } from '../../helpers/approved-plan';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

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

function initProject(directory: string): void {
	const result = spawnSync('git', ['init'], {
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

function ledgerLineCount(directory: string): number {
	const ledgerPath = path.join(
		directory,
		'.swarm',
		BACKGROUND_DELEGATIONS_FILE,
	);
	return fs.readFileSync(ledgerPath, 'utf8').split(/\r?\n/).filter(Boolean)
		.length;
}

describe('background coder toolAfter replay ownership', () => {
	let directory = '';
	let cleanup = (): void => {};

	beforeEach(async () => {
		resetSwarmState();
		resetStandardWorktreeIsolationState();
		const safe = createSafeTestDir('swarm-bg-replay-');
		directory = safe.dir;
		cleanup = safe.cleanup;
		initProject(directory);
		await writeApprovedPlan(directory, [
			{ id: '1.1', files: ['src/example.ts'] },
		]);
	});

	afterEach(() => {
		resetStandardWorktreeIsolationState();
		resetSwarmState();
		cleanup();
	});

	test('treats a byte-identical second real toolAfter as the same durable launch', async () => {
		const session = ensureAgentSession('parent', 'architect', directory);
		session.currentTaskId = '1.1';
		const hook = createDelegationGateHook(config, directory);
		const args = {
			subagent_type: 'coder',
			background: true,
			task_id: '1.1',
			prompt:
				'TASK: 1.1\nFILE: src/example.ts\nACCEPTANCE: persist one replay-stable owner',
		};
		const input = {
			tool: 'Task',
			sessionID: 'parent',
			callID: 'coder-call',
			args,
		};
		const output = {
			state: 'running',
			output:
				'<task id="coder-session" state="running">Background task started</task>',
			metadata: { background: true, jobId: 'coder-job' },
		};

		await hook.toolBefore(
			{ tool: 'Task', sessionID: 'parent', callID: 'coder-call' },
			{ args },
		);
		await hook.toolAfter(input, output);
		const first = findByCorrelationId(directory, 'coder-session');
		expect(first?.workspace?.directory).toBe(directory);
		expect(first?.taskChangeContext?.declaredFiles).toEqual(['src/example.ts']);
		expect(first?.coderReservationId).toBeTruthy();
		expect(ledgerLineCount(directory)).toBe(1);

		await hook.toolAfter(input, output);

		expect(findByCorrelationId(directory, 'coder-session')).toEqual(first);
		expect(ledgerLineCount(directory)).toBe(1);
		expect(session.pendingAdvisoryMessages ?? []).not.toContainEqual(
			expect.stringContaining('CORRELATION CONFLICT'),
		);
	});

	test('keeps the durable owner and reservation on a true replay conflict', async () => {
		const session = ensureAgentSession('parent', 'architect', directory);
		session.currentTaskId = '1.1';
		const hook = createDelegationGateHook(config, directory);
		const originalArgs = {
			subagent_type: 'coder',
			background: true,
			task_id: '1.1',
			prompt:
				'TASK: 1.1\nFILE: src/example.ts\nACCEPTANCE: preserve the original owner',
		};
		const output = {
			state: 'running',
			output:
				'<task id="coder-session" state="running">Background task started</task>',
			metadata: { background: true, jobId: 'coder-job' },
		};

		await hook.toolBefore(
			{ tool: 'Task', sessionID: 'parent', callID: 'coder-call' },
			{ args: originalArgs },
		);
		await hook.toolAfter(
			{
				tool: 'Task',
				sessionID: 'parent',
				callID: 'coder-call',
				args: originalArgs,
			},
			output,
		);
		const first = findByCorrelationId(directory, 'coder-session');
		const reservationId = first?.coderReservationId;
		expect(reservationId).toBeTruthy();

		const conflictingArgs = {
			...originalArgs,
			prompt:
				'TASK: 1.1\nFILE: src/example.ts\nACCEPTANCE: replace the original owner',
		};
		await hook.toolAfter(
			{
				tool: 'Task',
				sessionID: 'parent',
				callID: 'coder-call',
				args: conflictingArgs,
			},
			output,
		);

		expect(findByCorrelationId(directory, 'coder-session')).toEqual(first);
		expect(ledgerLineCount(directory)).toBe(1);
		expect(
			scanBackgroundCoderReservationsForAdmission(directory),
		).toMatchObject({
			status: 'ok',
			reservations: [{ reservationId, correlationId: 'coder-session' }],
		});
		const advisory = session.pendingAdvisoryMessages?.at(-1) ?? '';
		expect(advisory).toContain('BACKGROUND DELEGATION CORRELATION CONFLICT');
		expect(advisory).toContain(
			'parent=parent, call=coder-call, agent=coder, task=1.1',
		);
		expect(advisory).toContain('Inspect that existing owner and reconcile it');
		expect(advisory).toContain(
			'No isolated worktree was attached to this conflicting call.',
		);
		expect(advisory).toContain(
			`No new reservation was present for this replay; the durable owner's reservation ${reservationId} remains unchanged.`,
		);
		expect(advisory).not.toContain(
			'The current worktree and reservation were preserved.',
		);
		expect(advisory).toContain(
			'Do not abort, delete, or re-dispatch this correlation',
		);
		expect(session.pendingAdvisoryMessages ?? []).not.toContainEqual(
			expect.stringContaining('BACKGROUND DELEGATION UNTRACKED'),
		);
		await expect(
			hook.toolBefore(
				{ tool: 'Task', sessionID: 'parent', callID: 'second-call' },
				{ args: originalArgs },
			),
		).rejects.toThrow(
			/BACKGROUND_CODER_TASK_RESERVED|PARALLEL_SLOTS_EXHAUSTED/,
		);
	});

	test('reports a current reservation as retained without claiming a disabled worktree', async () => {
		await recordPendingDelegation(directory, {
			correlationId: 'colliding-session',
			jobId: 'owner-job',
			subagentSessionId: 'colliding-session',
			parentSessionId: 'owner-parent',
			callID: 'owner-call',
			normalizedAgent: 'coder',
			swarmPrefixedAgent: 'coder',
			planTaskId: '1.1',
			evidenceTaskId: '1.1',
			generation: 1,
		});
		const session = ensureAgentSession('parent', 'architect', directory);
		session.currentTaskId = '1.1';
		const hook = createDelegationGateHook(config, directory);
		const args = {
			subagent_type: 'coder',
			background: true,
			task_id: '1.1',
			prompt:
				'TASK: 1.1\nFILE: src/example.ts\nACCEPTANCE: retain the current reservation on conflict',
		};

		await hook.toolBefore(
			{ tool: 'Task', sessionID: 'parent', callID: 'current-call' },
			{ args },
		);
		const admission = scanBackgroundCoderReservationsForAdmission(directory);
		const reservation = admission.reservations[0];
		expect(reservation?.correlationId).toBeNull();
		await hook.toolAfter(
			{
				tool: 'Task',
				sessionID: 'parent',
				callID: 'current-call',
				args,
			},
			{
				state: 'running',
				output:
					'<task id="colliding-session" state="running">Background task started</task>',
				metadata: { background: true, jobId: 'new-job' },
			},
		);

		const advisory = session.pendingAdvisoryMessages?.at(-1) ?? '';
		expect(advisory).toContain(
			'No isolated worktree was attached to this conflicting call.',
		);
		expect(advisory).toContain(
			`The current reservation ${reservation?.reservationId} was retained and was not bound to the conflicting correlation.`,
		);
		expect(
			scanBackgroundCoderReservationsForAdmission(directory).reservations,
		).toContainEqual(reservation);
		expect(findByCorrelationId(directory, 'colliding-session')).toMatchObject({
			parentSessionId: 'owner-parent',
			callID: 'owner-call',
		});
	});
});
