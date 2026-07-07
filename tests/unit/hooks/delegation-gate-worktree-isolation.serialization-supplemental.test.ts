/**
 * Worktree isolation FR-104 serialization release — supplemental verification tests
 *
 * These tests complement the core SC-111/SC-112/SC-113 tests in:
 *   - delegation-gate-worktree-isolation.serialization.test.ts
 *   - delegation-gate-worktree-isolation.gating-tll-release.test.ts
 *
 * Covers additional verification targets:
 * - Advisory message content on release (WORKTREE_SERIALIZATION_RELEASED)
 * - Intermediate counter tracking at each successful merge-back step
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
import {
	_internals as isolationInternals,
	resetStandardWorktreeIsolationState,
	standardWorktreeSerializationSessions,
} from '../../../src/hooks/delegation-gate/worktree-isolation';
import { ensureAgentSession, resetSwarmState } from '../../../src/state';
import {
	attemptMergeBackFromDirty,
	postMergeCleanup,
	provisionWorktree,
	removeWorktree,
} from '../../../src/worktree';

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

function writePlanJson(
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
): void {
	const phase = options?.currentPhase ?? 1;
	const tasks = options?.tasks ?? [
		{ id: '1.1', status: 'pending' },
		{ id: '1.2', status: 'pending' },
		{ id: '1.3', status: 'pending' },
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
}

function makeFakeDispatch(
	callID: string,
	parentSessionID: string,
	taskId: string,
) {
	return {
		callID,
		parentSessionID,
		taskId,
		handle: {
			worktreePath: path.join(os.tmpdir(), `wt-${parentSessionID}-${taskId}`),
			branchName: `swarm/lane/${parentSessionID}/${taskId}`,
		},
	};
}

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
	session.pendingAdvisoryMessages = [];
}

// ─── Advisory message on release ────────────────────────────────────────────

describe('FR-104: advisory message on serialization release', () => {
	let tempDir: string;

	beforeEach(() => {
		resetSwarmState();
		resetStandardWorktreeIsolationState();
		tempDir = makeTempProject('fr104-advisory-');
		writePlanJson(tempDir);

		isolationInternals.removeWorktree = async () => {};
		isolationInternals.postMergeCleanup = async () => {};
		isolationInternals.attemptMergeBackFromDirty = async () => ({
			merged: true as const,
			strategy: 'merge',
			autoCommitted: true,
			cleaned: true,
		});
	});

	afterEach(() => {
		resetSwarmState();
		resetStandardWorktreeIsolationState();
		isolationInternals.provisionWorktree = provisionWorktree;
		isolationInternals.removeWorktree = removeWorktree;
		isolationInternals.attemptMergeBackFromDirty = attemptMergeBackFromDirty;
		isolationInternals.postMergeCleanup = postMergeCleanup;
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// best-effort cleanup
		}
	});

	it('SC-111: release emits WORKTREE_SERIALIZATION_RELEASED advisory', async () => {
		const config = makeConfig({ serialization_release_after_dispatches: 1 });

		// Serialize session and capture the session reference BEFORE dispatch
		serializeSessionDirectly('advisory-count-session');
		const session = ensureAgentSession('advisory-count-session');
		session.pendingAdvisoryMessages = [];
		expect(session.pendingAdvisoryMessages).toEqual([]);

		const { finishStandardWorktreeDispatch } = await import(
			'../../../src/hooks/delegation-gate/worktree-isolation'
		);

		await finishStandardWorktreeDispatch(
			tempDir,
			makeFakeDispatch('call-advisory', 'advisory-count-session', '1.1') as any,
			config as any,
		);

		// Session should be released
		expect(
			standardWorktreeSerializationSessions.has('advisory-count-session'),
		).toBe(false);

		// Advisory message should be present with WORKTREE_SERIALIZATION_RELEASED content
		expect(session.pendingAdvisoryMessages).toBeDefined();
		expect(session.pendingAdvisoryMessages!.length).toBeGreaterThan(0);
		const releaseAdvisory = session.pendingAdvisoryMessages!.find((m) =>
			m.includes('WORKTREE_SERIALIZATION_RELEASED'),
		);
		expect(releaseAdvisory).toBeDefined();
		expect(releaseAdvisory).toContain('advisory-count-session');
	});

	it('SC-112: TTL expiry emits WORKTREE_SERIALIZATION_RELEASED advisory', async () => {
		// Serialize session at a time far in the past (TTL already expired)
		const now = Date.now();
		serializeSessionDirectly('advisory-ttl-session', {
			serializedAt: now - 100_000,
		});
		const session = ensureAgentSession('advisory-ttl-session');
		session.pendingAdvisoryMessages = [];

		// Mock Date.now to simulate time passage past TTL
		const originalNow = Date.now;
		Date.now = () => now + 100_000; // past 50ms TTL
		try {
			const { precreateStandardWorktreeSession } = await import(
				'../../../src/hooks/delegation-gate/worktree-isolation'
			);

			await precreateStandardWorktreeSession({
				config: makeConfig({ serialization_release_after_ms: 50 }) as any,
				directory: tempDir,
				parentSessionID: 'advisory-ttl-session',
				callID: 'call-advisory-ttl',
				taskId: '1.1',
				outputArgs: {},
			});

			// Session should be released
			expect(
				standardWorktreeSerializationSessions.has('advisory-ttl-session'),
			).toBe(false);

			// Advisory message should be present
			expect(session.pendingAdvisoryMessages).toBeDefined();
			expect(session.pendingAdvisoryMessages!.length).toBeGreaterThan(0);
			const releaseAdvisory = session.pendingAdvisoryMessages!.find((m) =>
				m.includes('WORKTREE_SERIALIZATION_RELEASED'),
			);
			expect(releaseAdvisory).toBeDefined();
			expect(releaseAdvisory).toContain('advisory-ttl-session');
		} finally {
			Date.now = originalNow;
		}
	});
});

// ─── Intermediate counter tracking ─────────────────────────────────────────────

describe('FR-104 SC-111: intermediate successfulDispatchesSince counter tracking', () => {
	let tempDir: string;

	beforeEach(() => {
		resetSwarmState();
		resetStandardWorktreeIsolationState();
		tempDir = makeTempProject('fr104-counter-');
		writePlanJson(tempDir);

		isolationInternals.removeWorktree = async () => {};
		isolationInternals.postMergeCleanup = async () => {};
		isolationInternals.attemptMergeBackFromDirty = async () => ({
			merged: true as const,
			strategy: 'merge',
			autoCommitted: true,
			cleaned: true,
		});
	});

	afterEach(() => {
		resetSwarmState();
		resetStandardWorktreeIsolationState();
		isolationInternals.provisionWorktree = provisionWorktree;
		isolationInternals.removeWorktree = removeWorktree;
		isolationInternals.attemptMergeBackFromDirty = attemptMergeBackFromDirty;
		isolationInternals.postMergeCleanup = postMergeCleanup;
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// best-effort cleanup
		}
	});

	it('SC-111: successfulDispatchesSince increments by exactly 1 per merge-back', async () => {
		const config = makeConfig({ serialization_release_after_dispatches: 3 });

		serializeSessionDirectly('counter-track-session');

		const { finishStandardWorktreeDispatch } = await import(
			'../../../src/hooks/delegation-gate/worktree-isolation'
		);

		// After 0 dispatches — state should exist with count = 0
		let state = isolationInternals.serializationStateBySessionID!.get(
			'counter-track-session',
		);
		expect(state).toBeDefined();
		expect(state!.successfulDispatchesSince).toBe(0);

		// After dispatch 1
		await finishStandardWorktreeDispatch(
			tempDir,
			makeFakeDispatch('call-c1', 'counter-track-session', '1.1') as any,
			config as any,
		);
		state = isolationInternals.serializationStateBySessionID!.get(
			'counter-track-session',
		);
		expect(state!.successfulDispatchesSince).toBe(1);
		expect(
			standardWorktreeSerializationSessions.has('counter-track-session'),
		).toBe(true); // still serialized (threshold=3)

		// After dispatch 2
		await finishStandardWorktreeDispatch(
			tempDir,
			makeFakeDispatch('call-c2', 'counter-track-session', '1.2') as any,
			config as any,
		);
		state = isolationInternals.serializationStateBySessionID!.get(
			'counter-track-session',
		);
		expect(state!.successfulDispatchesSince).toBe(2);
		expect(
			standardWorktreeSerializationSessions.has('counter-track-session'),
		).toBe(true); // still serialized (threshold=3)

		// After dispatch 3 — meets threshold, session is released
		await finishStandardWorktreeDispatch(
			tempDir,
			makeFakeDispatch('call-c3', 'counter-track-session', '1.3') as any,
			config as any,
		);
		expect(
			standardWorktreeSerializationSessions.has('counter-track-session'),
		).toBe(false);
		// State should be removed
		expect(
			isolationInternals.serializationStateBySessionID!.has(
				'counter-track-session',
			),
		).toBe(false);
	});

	it('SC-111: non-merged dispatches do NOT increment the counter', async () => {
		const config = makeConfig({ serialization_release_after_dispatches: 3 });

		serializeSessionDirectly('counter-fail-session');

		// Override attemptMergeBackFromDirty to return a failed merge
		isolationInternals.attemptMergeBackFromDirty = async () => ({
			failed: 'conflict' as const,
			stage: 'merge' as const,
			message: 'unresolved conflict',
		});

		const { finishStandardWorktreeDispatch } = await import(
			'../../../src/hooks/delegation-gate/worktree-isolation'
		);

		// After a FAILED dispatch — count should still be 0
		await finishStandardWorktreeDispatch(
			tempDir,
			makeFakeDispatch('call-fail1', 'counter-fail-session', '1.1') as any,
			config as any,
		);
		let state = isolationInternals.serializationStateBySessionID!.get(
			'counter-fail-session',
		);
		expect(state!.successfulDispatchesSince).toBe(0);
		expect(
			standardWorktreeSerializationSessions.has('counter-fail-session'),
		).toBe(true); // still serialized

		// After a PARTIAL dispatch — count should still be 0
		isolationInternals.attemptMergeBackFromDirty = async () => ({
			partial: 'conflicts' as const,
			stage: 'merge' as const,
			message: 'partial resolution',
		});
		await finishStandardWorktreeDispatch(
			tempDir,
			makeFakeDispatch('call-fail2', 'counter-fail-session', '1.2') as any,
			config as any,
		);
		state = isolationInternals.serializationStateBySessionID!.get(
			'counter-fail-session',
		);
		expect(state!.successfulDispatchesSince).toBe(0);
	});
});

// ─── Release clears maxConcurrencyOverride (explicit) ───────────────────────────

describe('FR-104: maxConcurrencyOverride cleared on release', () => {
	let tempDir: string;

	beforeEach(() => {
		resetSwarmState();
		resetStandardWorktreeIsolationState();
		tempDir = makeTempProject('fr104-override-');
		writePlanJson(tempDir);

		isolationInternals.removeWorktree = async () => {};
		isolationInternals.postMergeCleanup = async () => {};
		isolationInternals.attemptMergeBackFromDirty = async () => ({
			merged: true as const,
			strategy: 'merge',
			autoCommitted: true,
			cleaned: true,
		});
	});

	afterEach(() => {
		resetSwarmState();
		resetStandardWorktreeIsolationState();
		isolationInternals.provisionWorktree = provisionWorktree;
		isolationInternals.removeWorktree = removeWorktree;
		isolationInternals.attemptMergeBackFromDirty = attemptMergeBackFromDirty;
		isolationInternals.postMergeCleanup = postMergeCleanup;
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// best-effort cleanup
		}
	});

	it('SC-111: maxConcurrencyOverride set to 1 when serialized, cleared after count release', async () => {
		const config = makeConfig({ serialization_release_after_dispatches: 2 });

		serializeSessionDirectly('override-count-session');
		const session = ensureAgentSession('override-count-session');

		// Before any dispatches — override is set
		expect(session.maxConcurrencyOverride).toBe(1);

		const { finishStandardWorktreeDispatch } = await import(
			'../../../src/hooks/delegation-gate/worktree-isolation'
		);

		// After first dispatch (below threshold)
		await finishStandardWorktreeDispatch(
			tempDir,
			makeFakeDispatch('call-ov1', 'override-count-session', '1.1') as any,
			config as any,
		);
		expect(session.maxConcurrencyOverride).toBe(1); // still set

		// After second dispatch (meets threshold) — override is cleared
		await finishStandardWorktreeDispatch(
			tempDir,
			makeFakeDispatch('call-ov2', 'override-count-session', '1.2') as any,
			config as any,
		);
		expect(session.maxConcurrencyOverride).toBeUndefined();
	});

	it('SC-112: maxConcurrencyOverride cleared after TTL expiry via precreate', async () => {
		const now = Date.now();
		serializeSessionDirectly('override-ttl-session', { serializedAt: now });
		const session = ensureAgentSession('override-ttl-session');

		expect(session.maxConcurrencyOverride).toBe(1);

		const originalNow = Date.now;
		Date.now = () => now + 100_000; // past 50ms TTL
		try {
			const { precreateStandardWorktreeSession } = await import(
				'../../../src/hooks/delegation-gate/worktree-isolation'
			);

			await precreateStandardWorktreeSession({
				config: makeConfig({ serialization_release_after_ms: 50 }) as any,
				directory: tempDir,
				parentSessionID: 'override-ttl-session',
				callID: 'call-override-ttl',
				taskId: '1.1',
				outputArgs: {},
			});

			expect(session.maxConcurrencyOverride).toBeUndefined();
		} finally {
			Date.now = originalNow;
		}
	});
});
