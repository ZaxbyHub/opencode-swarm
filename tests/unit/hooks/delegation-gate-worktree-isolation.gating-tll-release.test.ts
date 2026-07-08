/**
 * Worktree isolation TTL release via gating path integration test
 *
 * Covers FR-104 SC-111/SC-112: the TTL/count release check must be reachable
 * through the public delegation-gate toolBefore path (not just via
 * precreateStandardWorktreeSession directly).
 *
 * Prior to the fix, the gating throw at delegation-gate.ts:1161 happened BEFORE
 * checkStandardWorktreeSerializationRelease was called, making SC-112 unreachable
 * through the public path.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
	PluginConfig,
	WorktreeIsolationConfig,
} from '../../../src/config';
import type { Plan } from '../../../src/config/plan-schema';
import { createDelegationGateHook } from '../../../src/hooks/delegation-gate';
import {
	_internals as isolationInternals,
	resetStandardWorktreeIsolationState,
	standardWorktreeSerializationSessions,
} from '../../../src/hooks/delegation-gate/worktree-isolation';
import { ensureAgentSession, resetSwarmState } from '../../../src/state';
import { recordPlanCriticApproval } from './_delegation-gate-helpers';

function makeConfig(
	overrides?: Partial<WorktreeIsolationConfig>,
): PluginConfig {
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
		worktree: {
			policy: 'auto',
			merge_strategy: 'merge',
			deps_strategy: 'skip',
			serialization_release_after_dispatches: 5,
			serialization_release_after_ms: 60_000,
			...overrides,
		},
	} as PluginConfig;
}

function makeTempProject(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	const real = fs.realpathSync(dir);
	fs.mkdirSync(path.join(real, '.swarm'), { recursive: true });
	return real;
}

async function writePlanJson(
	dir: string,
	options?: {
		tasks?: Array<{
			id: string;
			status?: string;
			depends?: string[];
			phase?: number;
		}>;
		currentPhase?: number;
	},
): Promise<void> {
	const phase = options?.currentPhase ?? 1;
	const tasks = options?.tasks ?? [
		{ id: '1.1', status: 'pending' },
		{ id: '1.2', status: 'pending' },
	];
	const plan: Plan = {
		schema_version: '1.0.0' as const,
		title: 'Test Plan',
		swarm: 'test-swarm',
		current_phase: phase,
		phases: [
			{
				id: phase,
				name: `Phase ${phase}`,
				status: 'in_progress',
				tasks: tasks.map((task) => ({
					id: task.id,
					phase: task.phase ?? phase,
					status: task.status ?? 'pending',
					size: 'small' as const,
					description: `Task ${task.id}`,
					depends: task.depends ?? [],
					files_touched: [],
				})),
			},
		],
	};
	fs.writeFileSync(
		path.join(dir, '.swarm', 'plan.json'),
		JSON.stringify(plan, null, 2),
	);
	// PR #1706: any coder-role Task dispatch made while .swarm/plan.json exists
	// now requires a plan-critic-approval ledger snapshot or the gate throws
	// PLAN_CRITIC_GATE_VIOLATION before the worktree-serialization gate this
	// file actually exercises ever runs.
	await recordPlanCriticApproval(dir, plan);
}

/**
 * Serialize a session for worktree isolation testing.
 * Directly manipulates internal state to simulate a serialized session.
 */
function serializeSessionDirectly(
	sessionID: string,
	opts?: { serializedAt?: number },
): void {
	standardWorktreeSerializationSessions.add(sessionID);
	isolationInternals.serializationStateBySessionID!.set(sessionID, {
		sessionID,
		serializedAt: opts?.serializedAt ?? Date.now(),
		successfulDispatchesSince: 0,
	});
	const session = ensureAgentSession(sessionID);
	session.maxConcurrencyOverride = 1;
}

/** Call toolBefore with coder subagent type */
async function callToolBeforeCoder(
	hook: ReturnType<typeof createDelegationGateHook>,
	sessionID: string,
	taskId: string,
): Promise<void> {
	await hook.toolBefore(
		{ tool: 'Task', sessionID, callID: `call-${Date.now()}` },
		{ args: { subagent_type: 'coder', task_id: taskId } },
	);
}

describe('FR-104 SC-112: TTL release reachable via public gating path', () => {
	let tempDir: string;

	beforeEach(async () => {
		resetSwarmState();
		resetStandardWorktreeIsolationState();
		tempDir = makeTempProject('fr104-sc112-gate-');
		await writePlanJson(tempDir);
		// Mock removeWorktree to be a no-op
		isolationInternals.removeWorktree = async () => {};
	});

	afterEach(() => {
		resetSwarmState();
		resetStandardWorktreeIsolationState();
		isolationInternals.removeWorktree = async () => {};
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// best-effort cleanup
		}
	});

	it('SC-112: expired TTL session is released and dispatch is admitted via toolBefore', async () => {
		// Serialize session at current time
		const now = Date.now();
		serializeSessionDirectly('sc112-gate-session', { serializedAt: now });

		// Verify session is in serialized state
		expect(
			standardWorktreeSerializationSessions.has('sc112-gate-session'),
		).toBe(true);

		// Create hook with very short TTL (50ms)
		const config = makeConfig({ serialization_release_after_ms: 50 });
		const hook = createDelegationGateHook(config, tempDir);

		// Mock Date.now to advance time well past TTL (TTL = 50ms, elapsed = 100ms)
		const originalNow = Date.now;
		Date.now = () => now + 100;

		try {
			// Dispatch a coder Task via the public toolBefore path
			// This should NOT throw — the TTL release check should fire before
			// the gating throw, releasing the session and allowing the dispatch.
			await expect(
				callToolBeforeCoder(hook, 'sc112-gate-session', '1.1'),
			).resolves.toBeUndefined();

			// After the dispatch through the gating path, the session should still
			// be released (not re-added), because the TTL had already expired.
			// The precreateStandardWorktreeSession would have returned early after
			// seeing the session was released.
			expect(
				standardWorktreeSerializationSessions.has('sc112-gate-session'),
			).toBe(false);
		} finally {
			Date.now = originalNow;
		}
	});

	it('SC-112: non-expired TTL session is still rejected via toolBefore', async () => {
		// Serialize session at current time
		const now = Date.now();
		serializeSessionDirectly('sc112-not-expired-session', {
			serializedAt: now,
		});

		expect(
			standardWorktreeSerializationSessions.has('sc112-not-expired-session'),
		).toBe(true);

		// Create hook with long TTL (60s) — session should NOT expire
		const config = makeConfig({ serialization_release_after_ms: 60_000 });
		const hook = createDelegationGateHook(config, tempDir);

		// Advance time by only 1 second (TTL = 60s, elapsed = 1s)
		const originalNow = Date.now;
		Date.now = () => now + 1000;

		try {
			// Dispatch should still be rejected because TTL has not expired
			await expect(
				callToolBeforeCoder(hook, 'sc112-not-expired-session', '1.1'),
			).rejects.toThrow(/STANDARD_WORKTREE_ISOLATION_SERIALIZED/);
		} finally {
			Date.now = originalNow;
		}
	});
});

describe('FR-104 SC-111: count release reachable via public gating path', () => {
	let tempDir: string;

	beforeEach(async () => {
		resetSwarmState();
		resetStandardWorktreeIsolationState();
		tempDir = makeTempProject('fr104-sc111-gate-');
		await writePlanJson(tempDir);
		isolationInternals.removeWorktree = async () => {};
	});

	afterEach(() => {
		resetSwarmState();
		resetStandardWorktreeIsolationState();
		isolationInternals.removeWorktree = async () => {};
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// best-effort cleanup
		}
	});

	it('SC-111: count-exceeded session is released and dispatch is admitted via toolBefore', async () => {
		// Serialize session with successfulDispatchesSince >= count
		serializeSessionDirectly('sc111-gate-session');
		// Override the count to exceed threshold
		isolationInternals.serializationStateBySessionID!.set(
			'sc111-gate-session',
			{
				sessionID: 'sc111-gate-session',
				serializedAt: Date.now(),
				successfulDispatchesSince: 10, // count threshold is 5
			},
		);

		expect(
			standardWorktreeSerializationSessions.has('sc111-gate-session'),
		).toBe(true);

		// Create hook with count threshold of 5
		const config = makeConfig({ serialization_release_after_dispatches: 5 });
		const hook = createDelegationGateHook(config, tempDir);

		// Dispatch via the public toolBefore path — should NOT throw
		await expect(
			callToolBeforeCoder(hook, 'sc111-gate-session', '1.1'),
		).resolves.toBeUndefined();

		// Session should be released
		expect(
			standardWorktreeSerializationSessions.has('sc111-gate-session'),
		).toBe(false);
	});
});
