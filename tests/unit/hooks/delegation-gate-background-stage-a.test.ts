/**
 * Issue #1151 PR 2 (Stage A) — delegation-gate background flag behavior.
 *
 * Flag OFF (default): PR 1 behavior preserved (toolBefore blocks; toolAfter bails, no record).
 * Flag ON: background swarm dispatch is allowed; toolAfter records a durable pending
 * delegation but NEVER advances workflow gates.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	findByCorrelationId,
	readDelegations,
} from '../../../src/background/pending-delegations';
import type { PluginConfig } from '../../../src/config';
import { createDelegationGateHook } from '../../../src/hooks/delegation-gate';
import {
	ensureAgentSession,
	getTaskState,
	resetSwarmState,
} from '../../../src/state';

function makeConfig(backgroundEnabled: boolean): PluginConfig {
	return {
		max_iterations: 5,
		qa_retry_limit: 3,
		inject_phase_reminders: true,
		hooks: {
			system_enhancer: true,
			compaction: true,
			agent_activity: true,
			delegation_tracker: false,
			agent_awareness_max_chars: 300,
			delegation_gate: true,
			delegation_max_chars: 4000,
			background_subagents: backgroundEnabled,
			background_pending_timeout_minutes: 30,
		},
	} as PluginConfig;
}

function makeTempProject(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-bgsa-'));
	const real = fs.realpathSync(dir);
	fs.mkdirSync(path.join(real, '.swarm'), { recursive: true });
	return real;
}

const runningDispatch = (id: string) => ({
	title: 'review',
	output: `<task id="${id}" state="running">\n<summary>Background task started</summary>\n</task>`,
	metadata: { background: true, jobId: `job_${id}` },
});

describe('delegation-gate background flag (Stage A)', () => {
	let dir: string;
	beforeEach(() => {
		resetSwarmState();
		dir = makeTempProject();
	});
	afterEach(() => {
		resetSwarmState();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	// ── toolBefore: flag gates the PR 1 block ────────────────────────────────
	it('flag OFF: toolBefore blocks background reviewer (PR 1 preserved)', async () => {
		const hook = createDelegationGateHook(makeConfig(false), dir);
		let threw = false;
		try {
			await hook.toolBefore(
				{ tool: 'Task', sessionID: 's1', callID: 'c1' },
				{ args: { subagent_type: 'reviewer', background: true } },
			);
		} catch {
			threw = true;
		}
		expect(threw).toBe(true);
	});

	it('flag ON: toolBefore allows background reviewer dispatch', async () => {
		const hook = createDelegationGateHook(makeConfig(true), dir);
		let threw = false;
		try {
			await hook.toolBefore(
				{ tool: 'Task', sessionID: 's1', callID: 'c1' },
				{ args: { subagent_type: 'reviewer', background: true } },
			);
		} catch {
			threw = true;
		}
		expect(threw).toBe(false);
	});

	// ── toolAfter: flag ON records pending, never advances gates ──────────────
	it('flag ON: toolAfter records a pending delegation and does NOT advance Stage B', async () => {
		const hook = createDelegationGateHook(makeConfig(true), dir);
		const session = ensureAgentSession('s2');
		session.taskWorkflowStates.set('1.1', 'coder_delegated');
		session.currentTaskId = '1.1';

		await hook.toolAfter(
			{
				tool: 'Task',
				sessionID: 's2',
				callID: 'c2',
				args: { subagent_type: 'reviewer', background: true },
			},
			runningDispatch('ses_corr'),
		);

		// No gate advancement.
		expect(getTaskState(session, '1.1')).toBe('coder_delegated');
		// Durable pending record written.
		const rec = findByCorrelationId(dir, 'ses_corr');
		expect(rec?.status).toBe('pending');
		expect(rec?.normalizedAgent).toBe('reviewer');
		expect(rec?.parentSessionId).toBe('s2');
		expect(rec?.jobId).toBe('job_ses_corr');
	});

	it('flag ON: prefixed swarm agent records normalized role', async () => {
		const hook = createDelegationGateHook(makeConfig(true), dir);
		const session = ensureAgentSession('s3');
		session.taskWorkflowStates.set('2.1', 'coder_delegated');

		await hook.toolAfter(
			{
				tool: 'Task',
				sessionID: 's3',
				callID: 'c3',
				args: { subagent_type: 'mega_reviewer', background: true },
			},
			runningDispatch('ses_pref'),
		);

		const rec = findByCorrelationId(dir, 'ses_pref');
		expect(rec?.normalizedAgent).toBe('reviewer');
		expect(rec?.swarmPrefixedAgent).toBe('mega_reviewer');
	});

	it('flag ON: no correlation id → no orphan record, no throw, no advancement', async () => {
		const hook = createDelegationGateHook(makeConfig(true), dir);
		const session = ensureAgentSession('s4');
		session.taskWorkflowStates.set('3.1', 'coder_delegated');

		await hook.toolAfter(
			{
				tool: 'Task',
				sessionID: 's4',
				callID: 'c4',
				args: { subagent_type: 'reviewer', background: true },
			},
			// background detectable via args, but no envelope and no jobId → unkeyable
			{ title: 't', output: 'no envelope', metadata: { background: true } },
		);

		expect(getTaskState(session, '3.1')).toBe('coder_delegated');
		expect(readDelegations(dir)).toHaveLength(0);
	});

	// ── toolAfter: flag OFF preserves PR 1 (defensive bail, no record) ────────
	it('flag OFF: toolAfter background bails with no record (PR 1 behavior)', async () => {
		const hook = createDelegationGateHook(makeConfig(false), dir);
		const session = ensureAgentSession('s5');
		session.taskWorkflowStates.set('4.1', 'coder_delegated');

		await hook.toolAfter(
			{
				tool: 'Task',
				sessionID: 's5',
				callID: 'c5',
				args: { subagent_type: 'reviewer', background: true },
			},
			runningDispatch('ses_off'),
		);

		expect(getTaskState(session, '4.1')).toBe('coder_delegated');
		expect(readDelegations(dir)).toHaveLength(0);
	});

	// ── Regression: foreground still advances under both flag states ─────────
	it('flag ON: foreground reviewer still advances coder_delegated -> reviewer_run', async () => {
		const hook = createDelegationGateHook(makeConfig(true), dir);
		const session = ensureAgentSession('s6');
		session.taskWorkflowStates.set('5.1', 'coder_delegated');

		await hook.toolAfter(
			{
				tool: 'Task',
				sessionID: 's6',
				callID: 'c6',
				args: { subagent_type: 'reviewer' },
			},
			{ state: 'completed', text: 'done' },
		);

		expect(getTaskState(session, '5.1')).toBe('reviewer_run');
		expect(readDelegations(dir)).toHaveLength(0);
	});
});
