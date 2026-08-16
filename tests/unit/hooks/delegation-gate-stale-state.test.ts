/**
 * Tests for stale coder_delegated state detection in delegation-gate.ts
 *
 * Issue #2098 makes exact-task evidence authoritative. Legacy in-memory entries
 * outside the active plan are inert projections: delegation-chain timestamps do
 * not promote them into workflow authority or let them block new work.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PluginConfig } from '../../../src/config';
import type { Plan } from '../../../src/config/plan-schema';
import { createDelegationGateHook } from '../../../src/hooks/delegation-gate';
import {
	ensureAgentSession,
	resetSwarmState,
	swarmState,
} from '../../../src/state';
import { withFrozenClock } from '../../helpers/test-clock.js';
import { recordPlanCriticApproval } from './_delegation-gate-helpers';

function makeConfig(): PluginConfig {
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
		},
	} as PluginConfig;
}

/** Build the (input, output) pair expected by toolBefore */
function makeToolBeforeArgs(
	sessionID: string,
	agentName: string,
	callID = 'call-1',
): [
	{ tool: string; sessionID: string; callID: string },
	{ args: Record<string, unknown> },
] {
	return [
		{ tool: 'Task', sessionID, callID },
		{
			args: {
				subagent_type: agentName,
				task_id: '9.1',
				// ACCEPTANCE line keeps the #1687 coder/reviewer pre-dispatch gate
				// inert here so these stale-state tests exercise their original
				// assertions unchanged (issue #1687, FR-003).
				prompt:
					'TASK: 9.1 do work\nACCEPTANCE: task complete and covered by tests',
			},
		},
	];
}

function makeTempProject(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	const real = fs.realpathSync(dir);
	fs.mkdirSync(path.join(real, '.swarm'), { recursive: true });
	return real;
}

async function writeScopedPlan(dir: string): Promise<void> {
	const plan: Plan = {
		schema_version: '1.0.0',
		title: 'Stale State Test Plan',
		swarm: 'test-swarm',
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'Phase 1',
				status: 'in_progress',
				tasks: [
					{
						id: '9.1',
						phase: 1,
						status: 'pending',
						size: 'small',
						description: 'Exercise stale-state transitions',
						depends: [],
						files_touched: ['src/stale-state.ts'],
					},
				],
			},
		],
	};
	fs.writeFileSync(
		path.join(dir, '.swarm', 'plan.json'),
		JSON.stringify(plan, null, 2),
	);
	await recordPlanCriticApproval(dir, plan);
}

describe('delegation-gate: stale coder_delegated detection (Bug B)', () => {
	const SESSION_ID = 'test-session';
	let tempDir: string;

	beforeEach(async () => {
		resetSwarmState();
		tempDir = makeTempProject('stale-state-gate-');
		await writeScopedPlan(tempDir);
	});

	afterEach(() => {
		resetSwarmState();
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// best-effort cleanup
		}
	});

	it('ignores an out-of-plan projection when no delegation chains exist', async () => {
		const config = makeConfig();
		const hook = createDelegationGateHook(config, tempDir);

		// Simulate rehydrated session with stale coder_delegated state
		const session = ensureAgentSession(SESSION_ID);
		session.taskWorkflowStates.set('1.5', 'coder_delegated');

		// No delegation chains for this session (simulates fresh session after rehydration)

		// toolBefore should NOT throw — it should reset the stale state
		await expect(
			hook.toolBefore(...makeToolBeforeArgs(SESSION_ID, 'coder')),
		).resolves.toBeUndefined();

		expect(session.taskWorkflowStates.get('1.5')).toBe('coder_delegated');
	});

	it('does not rewrite an out-of-plan projection from unrelated chain entries', async () => {
		const config = makeConfig();
		const hook = createDelegationGateHook(config, tempDir);

		const session = ensureAgentSession(SESSION_ID);
		session.taskWorkflowStates.set('2.1', 'coder_delegated');

		// Delegation chains exist but only for reviewer (no coder delegation)
		swarmState.delegationChains.set(SESSION_ID, [
			{
				from: 'architect',
				to: 'reviewer',
				timestamp: withFrozenClock(() => Date.now()),
			},
		]);

		await expect(
			hook.toolBefore(...makeToolBeforeArgs(SESSION_ID, 'coder', 'call-2')),
		).resolves.toBeUndefined();

		expect(session.taskWorkflowStates.get('2.1')).toBe('coder_delegated');
	});

	it('does not use an old chain entry as durable workflow authority', async () => {
		const config = makeConfig();
		const hook = createDelegationGateHook(config, tempDir);

		const session = ensureAgentSession(SESSION_ID);
		session.taskWorkflowStates.set('1.3', 'coder_delegated');
		session.lastPhaseCompleteTimestamp = 2000;

		// Coder delegation exists but is from before the phase completed (stale)
		swarmState.delegationChains.set(SESSION_ID, [
			{ from: 'architect', to: 'coder', timestamp: 1000 },
		]);

		await expect(
			hook.toolBefore(...makeToolBeforeArgs(SESSION_ID, 'coder', 'call-3')),
		).resolves.toBeUndefined();

		expect(session.taskWorkflowStates.get('1.3')).toBe('coder_delegated');
	});

	it('a fresh chain entry cannot make an out-of-plan projection blocking', async () => {
		const config = makeConfig();
		const hook = createDelegationGateHook(config, tempDir);

		const session = ensureAgentSession(SESSION_ID);
		session.taskWorkflowStates.set('3.1', 'coder_delegated');
		session.lastPhaseCompleteTimestamp = 1000;

		// Fresh coder delegation exists — this is legitimate, should block
		swarmState.delegationChains.set(SESSION_ID, [
			{ from: 'architect', to: 'coder', timestamp: 2000 },
		]);

		await expect(
			hook.toolBefore(...makeToolBeforeArgs(SESSION_ID, 'coder', 'call-4')),
		).resolves.toBeUndefined();

		// State should NOT have been reset
		expect(session.taskWorkflowStates.get('3.1')).toBe('coder_delegated');
	});

	it('does not emit stale-state recovery for an untrusted projection', async () => {
		const config = makeConfig();
		const hook = createDelegationGateHook(config, tempDir);

		const session = ensureAgentSession(SESSION_ID);
		session.taskWorkflowStates.set('3.2', 'coder_delegated');
		session.lastPhaseCompleteTimestamp = 1000;

		swarmState.delegationChains.set(SESSION_ID, [
			{ from: 'architect', to: 'coder', timestamp: 2000 },
		]);

		await expect(
			hook.toolBefore(...makeToolBeforeArgs(SESSION_ID, 'coder', 'call-5')),
		).resolves.toBeUndefined();
	});

	it('leaves multiple out-of-plan projections inert while allowing delegation', async () => {
		const config = makeConfig();
		const hook = createDelegationGateHook(config, tempDir);

		const session = ensureAgentSession(SESSION_ID);
		session.taskWorkflowStates.set('1.1', 'coder_delegated');
		session.taskWorkflowStates.set('1.2', 'coder_delegated');
		session.taskWorkflowStates.set('1.3', 'idle');

		// No delegation chains — both coder_delegated are stale

		await expect(
			hook.toolBefore(...makeToolBeforeArgs(SESSION_ID, 'coder', 'call-6')),
		).resolves.toBeUndefined();

		expect(session.taskWorkflowStates.get('1.1')).toBe('coder_delegated');
		expect(session.taskWorkflowStates.get('1.2')).toBe('coder_delegated');
		expect(session.taskWorkflowStates.get('1.3')).toBe('idle');
	});

	it('does not affect non-coder delegations', async () => {
		const config = makeConfig();
		const hook = createDelegationGateHook(config, tempDir);

		const session = ensureAgentSession(SESSION_ID);
		session.taskWorkflowStates.set('1.5', 'coder_delegated');

		// A non-Stage-B agent isolates the stale-projection behavior.
		await expect(
			hook.toolBefore(...makeToolBeforeArgs(SESSION_ID, 'explorer', 'call-7')),
		).resolves.toBeUndefined();

		// State should be unchanged (not reset, since we're not going through the coder path)
		expect(session.taskWorkflowStates.get('1.5')).toBe('coder_delegated');
	});

	it('prefixed chain names still cannot manufacture workflow authority', async () => {
		const config = makeConfig();
		const hook = createDelegationGateHook(config, tempDir);

		const session = ensureAgentSession(SESSION_ID);
		session.taskWorkflowStates.set('2.1', 'coder_delegated');
		session.lastPhaseCompleteTimestamp = 1000;

		// Delegation chain uses prefixed agent name — should still be recognized
		swarmState.delegationChains.set(SESSION_ID, [
			{ from: 'architect', to: 'paid_coder', timestamp: 2000 },
		]);

		await expect(
			hook.toolBefore(...makeToolBeforeArgs(SESSION_ID, 'coder', 'call-8')),
		).resolves.toBeUndefined();
	});

	it('detects stale state after rehydration even when delegation chains are restored', async () => {
		const config = makeConfig();
		const hook = createDelegationGateHook(config, tempDir);

		// Simulate a rehydrated session: session was restored from snapshot
		// with both stale coder_delegated state AND old delegation chains
		const session = ensureAgentSession(SESSION_ID);
		session.taskWorkflowStates.set('1.5', 'coder_delegated');
		session.lastPhaseCompleteTimestamp = 3000;
		// sessionRehydratedAt is set to "now" by snapshot-reader on rehydration
		session.sessionRehydratedAt = 10000;

		// Old delegation chain from prior session (timestamp < sessionRehydratedAt)
		// This would have fooled the old check (5000 > lastPhaseCompleteTimestamp 3000)
		// but should now be detected as stale (5000 < sessionRehydratedAt 10000)
		swarmState.delegationChains.set(SESSION_ID, [
			{ from: 'architect', to: 'coder', timestamp: 5000 },
		]);

		await expect(
			hook.toolBefore(...makeToolBeforeArgs(SESSION_ID, 'coder', 'call-9')),
		).resolves.toBeUndefined();

		expect(session.taskWorkflowStates.get('1.5')).toBe('coder_delegated');
	});

	it('a post-rehydration chain entry still cannot authorize an out-of-plan projection', async () => {
		const config = makeConfig();
		const hook = createDelegationGateHook(config, tempDir);

		const session = ensureAgentSession(SESSION_ID);
		session.taskWorkflowStates.set('3.1', 'coder_delegated');
		session.sessionRehydratedAt = 10000;

		// New delegation made AFTER rehydration (timestamp > sessionRehydratedAt)
		swarmState.delegationChains.set(SESSION_ID, [
			{ from: 'architect', to: 'coder', timestamp: 15000 },
		]);

		await expect(
			hook.toolBefore(...makeToolBeforeArgs(SESSION_ID, 'coder', 'call-10')),
		).resolves.toBeUndefined();

		expect(session.taskWorkflowStates.get('3.1')).toBe('coder_delegated');
	});

	it('uses lastPhaseCompleteTimestamp for non-rehydrated sessions (sessionRehydratedAt=0)', async () => {
		const config = makeConfig();
		const hook = createDelegationGateHook(config, tempDir);

		const session = ensureAgentSession(SESSION_ID);
		session.taskWorkflowStates.set('2.1', 'coder_delegated');
		session.sessionRehydratedAt = 0; // Not rehydrated
		session.lastPhaseCompleteTimestamp = 3000;

		// Delegation older than lastPhaseCompleteTimestamp — stale
		swarmState.delegationChains.set(SESSION_ID, [
			{ from: 'architect', to: 'coder', timestamp: 2000 },
		]);

		await expect(
			hook.toolBefore(...makeToolBeforeArgs(SESSION_ID, 'coder', 'call-11')),
		).resolves.toBeUndefined();

		expect(session.taskWorkflowStates.get('2.1')).toBe('coder_delegated');
	});
});
