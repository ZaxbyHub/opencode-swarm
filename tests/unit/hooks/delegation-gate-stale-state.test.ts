/**
 * Tests for stale coder_delegated state detection in delegation-gate.ts
 *
 * Bug B: When sessions resume from disk (state rehydration), stale coder_delegated
 * entries from dead sessions would permanently block the gate. The fix detects
 * stale state by checking whether the current session's delegation chains contain
 * evidence of a coder delegation, and resets stale entries to 'idle'.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PluginConfig } from '../../../src/config';
import { createDelegationGateHook } from '../../../src/hooks/delegation-gate';
import {
	ensureAgentSession,
	resetSwarmState,
	swarmState,
} from '../../../src/state';
import { withFrozenClock } from '../../helpers/test-clock.js';

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
				// ACCEPTANCE line keeps the #1687 coder/reviewer pre-dispatch gate
				// inert here so these stale-state tests exercise their original
				// assertions unchanged (issue #1687, FR-003).
				prompt: 'do work\nACCEPTANCE: task complete and covered by tests',
			},
		},
	];
}

function makeTempProject(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	return fs.realpathSync(dir);
}

describe('delegation-gate: stale coder_delegated detection (Bug B)', () => {
	const SESSION_ID = 'test-session';
	let tempDir: string;

	beforeEach(() => {
		resetSwarmState();
		tempDir = makeTempProject('stale-state-gate-');
	});

	afterEach(() => {
		resetSwarmState();
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// best-effort cleanup
		}
	});

	it('resets stale coder_delegated state when no delegation chains exist for session', async () => {
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

		// Verify the stale state was reset to idle
		expect(session.taskWorkflowStates.get('1.5')).toBe('idle');
	});

	it('resets stale coder_delegated when delegation chains exist but have no coder entries', async () => {
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

		expect(session.taskWorkflowStates.get('2.1')).toBe('idle');
	});

	it('resets stale coder_delegated when coder delegation is older than lastPhaseCompleteTimestamp', async () => {
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

		expect(session.taskWorkflowStates.get('1.3')).toBe('idle');
	});

	it('blocks when coder_delegated state is current (delegation chain has fresh coder entry)', async () => {
		const config = makeConfig();
		const hook = createDelegationGateHook(config, tempDir);

		const session = ensureAgentSession(SESSION_ID);
		session.taskWorkflowStates.set('3.1', 'coder_delegated');
		session.lastPhaseCompleteTimestamp = 1000;

		// Fresh coder delegation exists — this is legitimate, should block
		swarmState.delegationChains.set(SESSION_ID, [
			{ from: 'architect', to: 'coder', timestamp: 2000 },
		]);

		// Tier 3 task (3.x) — even turbo can't bypass
		await expect(
			hook.toolBefore(...makeToolBeforeArgs(SESSION_ID, 'coder', 'call-4')),
		).rejects.toThrow('REVIEWER_GATE_VIOLATION');

		// State should NOT have been reset
		expect(session.taskWorkflowStates.get('3.1')).toBe('coder_delegated');
	});

	it('error message includes recovery instruction for stale state', async () => {
		const config = makeConfig();
		const hook = createDelegationGateHook(config, tempDir);

		const session = ensureAgentSession(SESSION_ID);
		session.taskWorkflowStates.set('3.2', 'coder_delegated');
		session.lastPhaseCompleteTimestamp = 1000;

		swarmState.delegationChains.set(SESSION_ID, [
			{ from: 'architect', to: 'coder', timestamp: 2000 },
		]);

		try {
			await hook.toolBefore(
				...makeToolBeforeArgs(SESSION_ID, 'coder', 'call-5'),
			);
			// Should not reach here
			expect(true).toBe(false);
		} catch (err: unknown) {
			const msg = (err as Error).message;
			expect(msg).toContain('/swarm reset-session');
			expect(msg).toContain('stale state from a prior session');
		}
	});

	it('resets multiple stale tasks and allows delegation', async () => {
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

		expect(session.taskWorkflowStates.get('1.1')).toBe('idle');
		expect(session.taskWorkflowStates.get('1.2')).toBe('idle');
		expect(session.taskWorkflowStates.get('1.3')).toBe('idle');
	});

	it('does not affect non-coder delegations', async () => {
		const config = makeConfig();
		const hook = createDelegationGateHook(config, tempDir);

		const session = ensureAgentSession(SESSION_ID);
		session.taskWorkflowStates.set('1.5', 'coder_delegated');

		// Delegating to reviewer should not trigger the stale check at all
		await expect(
			hook.toolBefore(...makeToolBeforeArgs(SESSION_ID, 'reviewer', 'call-7')),
		).resolves.toBeUndefined();

		// State should be unchanged (not reset, since we're not going through the coder path)
		expect(session.taskWorkflowStates.get('1.5')).toBe('coder_delegated');
	});

	it('handles prefixed agent names via stripKnownSwarmPrefix', async () => {
		const config = makeConfig();
		const hook = createDelegationGateHook(config, tempDir);

		const session = ensureAgentSession(SESSION_ID);
		session.taskWorkflowStates.set('2.1', 'coder_delegated');
		session.lastPhaseCompleteTimestamp = 1000;

		// Delegation chain uses prefixed agent name — should still be recognized
		swarmState.delegationChains.set(SESSION_ID, [
			{ from: 'architect', to: 'paid_coder', timestamp: 2000 },
		]);

		// This is a legitimate current delegation (prefixed name resolves to 'coder')
		// For a non-Tier-3 task without turbo, it should block
		await expect(
			hook.toolBefore(...makeToolBeforeArgs(SESSION_ID, 'coder', 'call-8')),
		).rejects.toThrow('REVIEWER_GATE_VIOLATION');
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

		// State should be reset to idle
		expect(session.taskWorkflowStates.get('1.5')).toBe('idle');
	});

	it('blocks after rehydration when a NEW coder delegation is made post-rehydration', async () => {
		const config = makeConfig();
		const hook = createDelegationGateHook(config, tempDir);

		const session = ensureAgentSession(SESSION_ID);
		session.taskWorkflowStates.set('3.1', 'coder_delegated');
		session.sessionRehydratedAt = 10000;

		// New delegation made AFTER rehydration (timestamp > sessionRehydratedAt)
		swarmState.delegationChains.set(SESSION_ID, [
			{ from: 'architect', to: 'coder', timestamp: 15000 },
		]);

		// Tier 3 task — should block (legitimate current delegation)
		await expect(
			hook.toolBefore(...makeToolBeforeArgs(SESSION_ID, 'coder', 'call-10')),
		).rejects.toThrow('REVIEWER_GATE_VIOLATION');

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

		expect(session.taskWorkflowStates.get('2.1')).toBe('idle');
	});
});
