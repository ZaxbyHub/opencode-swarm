/**
 * Worktree isolation serialization release tests (delegation-gate-worktree-isolation.serialization.test.ts)
 *
 * Covers FR-104:
 * - SC-111: Release a serialized session after N successful dispatches
 * - SC-112: Release a serialized session after a configurable TTL
 * - SC-113: FIFO eviction MUST NOT remove a session with an in-flight dispatch
 *
 * SPLIT: This file contains SC-112 (TTL expiry) and SC-113 (FIFO eviction) tests.
 * SC-111 tests have been moved to
 * delegation-gate-worktree-isolation.serialization.supplemental.test.ts
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
	standardWorktreeByCallID,
	standardWorktreeSerializationSessions,
} from '../../../src/hooks/delegation-gate/worktree-isolation';
import {
	ensureAgentSession,
	resetSwarmState,
	swarmState,
} from '../../../src/state';
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
): {
	callID: string;
	parentSessionID: string;
	taskId: string;
	handle: { worktreePath: string; branchName: string };
} {
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

/**
 * Directly serialize a session by populating the internal state directly.
 * This mimics what happens when handleStandardWorktreeFailure calls
 * serializeStandardWorktreeDispatches.
 * Pass originalTime=true when you will mock Date.now() for TTL tests,
 * to ensure serializedAt is set before the mock takes effect.
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

describe('FR-104 SC-112: release after TTL expiry', () => {
	let tempDir: string;

	beforeEach(() => {
		resetSwarmState();
		resetStandardWorktreeIsolationState();
		tempDir = makeTempProject('fr104-sc112-');
		writePlanJson(tempDir);

		isolationInternals.removeWorktree = async () => {};
		isolationInternals.postMergeCleanup = async () => {};
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

	it('SC-112: session is NOT released before TTL expires', async () => {
		// Serialize session at current time (before mocking)
		const now = Date.now();
		serializeSessionDirectly('sc112-noexpire-session', { serializedAt: now });

		// Verify it's in serialized state
		expect(
			standardWorktreeSerializationSessions.has('sc112-noexpire-session'),
		).toBe(true);

		// Mock Date.now to advance time slightly (but not past TTL of 60s)
		const originalNow = Date.now;
		const fakeTime = originalNow() + 1000; // 1 second later
		Date.now = () => fakeTime;

		try {
			// Check TTL via precreateStandardWorktreeSession TTL check path
			const { precreateStandardWorktreeSession } = await import(
				'../../../src/hooks/delegation-gate/worktree-isolation'
			);

			// Call precreate to trigger TTL check (config TTL = 60s, elapsed = 1s)
			await precreateStandardWorktreeSession({
				config: makeConfig({ serialization_release_after_ms: 60_000 }) as any,
				directory: tempDir,
				parentSessionID: 'sc112-noexpire-session',
				callID: 'call-noexpire',
				taskId: '1.1',
				outputArgs: {},
			});

			// Still serialized (1s << 60s TTL)
			expect(
				standardWorktreeSerializationSessions.has('sc112-noexpire-session'),
			).toBe(true);
		} finally {
			Date.now = originalNow;
		}
	});

	it('SC-112: session IS released after TTL expires', async () => {
		// Serialize session at current time (before mocking)
		const now = Date.now();
		serializeSessionDirectly('sc112-expired-session', { serializedAt: now });

		expect(
			standardWorktreeSerializationSessions.has('sc112-expired-session'),
		).toBe(true);

		// Mock Date.now to advance time past TTL
		const originalNow = Date.now;
		const fakeTime = originalNow() + 100; // Well past TTL (TTL = 50ms)
		Date.now = () => fakeTime;

		try {
			const { precreateStandardWorktreeSession } = await import(
				'../../../src/hooks/delegation-gate/worktree-isolation'
			);

			// TTL = 50ms, elapsed = 100ms → should release
			await precreateStandardWorktreeSession({
				config: makeConfig({ serialization_release_after_ms: 50 }) as any,
				directory: tempDir,
				parentSessionID: 'sc112-expired-session',
				callID: 'call-expired',
				taskId: '1.1',
				outputArgs: {},
			});

			// SC-112: after TTL expiry, session should be released
			expect(
				standardWorktreeSerializationSessions.has('sc112-expired-session'),
			).toBe(false);
		} finally {
			Date.now = originalNow;
		}
	});

	it('SC-112: TTL check fires on precreate even with zero successful dispatches', async () => {
		const now = Date.now();
		serializeSessionDirectly('sc112-ttl-only', { serializedAt: now });

		expect(standardWorktreeSerializationSessions.has('sc112-ttl-only')).toBe(
			true,
		);

		const originalNow = Date.now;
		const fakeTime = originalNow() + 20; // Past TTL (TTL = 10ms)
		Date.now = () => fakeTime;

		try {
			const { precreateStandardWorktreeSession } = await import(
				'../../../src/hooks/delegation-gate/worktree-isolation'
			);

			// TTL = 10ms, elapsed = 20ms → should release
			await precreateStandardWorktreeSession({
				config: makeConfig({ serialization_release_after_ms: 10 }) as any,
				directory: tempDir,
				parentSessionID: 'sc112-ttl-only',
				callID: 'call-ttl',
				taskId: '1.1',
				outputArgs: {},
			});

			expect(standardWorktreeSerializationSessions.has('sc112-ttl-only')).toBe(
				false,
			);
		} finally {
			Date.now = originalNow;
		}
	});
});

describe('FR-104 SC-113: FIFO eviction must not remove active sessions', () => {
	let tempDir: string;

	beforeEach(() => {
		resetSwarmState();
		resetStandardWorktreeIsolationState();
		tempDir = makeTempProject('fr104-sc113-');
		writePlanJson(tempDir);

		isolationInternals.removeWorktree = async () => {};
		isolationInternals.postMergeCleanup = async () => {};
	});

	afterEach(() => {
		resetSwarmState();
		resetStandardWorktreeIsolationState();
		isolationInternals.provisionWorktree = provisionWorktree;
		isolationInternals.removeWorktree = removeWorktree;
		isolationInternals.attemptMergeBackFromDirty = attemptMergeBackFromDirty;
		isolationInternals.postMergeCleanup = postMergeCleanup;
		swarmState.opencodeClient = undefined;
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// best-effort cleanup
		}
	});

	it('SC-113: all-256-active — warning is logged and NO session is evicted', async () => {
		// SC-113: When all 256 entries in standardWorktreeSerializationSessions have
		// active in-flight dispatches, the FIFO eviction must NOT remove any of them.
		// The 257th serialization attempt should refuse to evict and log a warning.
		//
		// Approach: Call rememberStandardWorktreeSerializationSession via _internals
		// directly. This bypasses the handleStandardWorktreeFailure collision issue
		// and directly exercises the FIFO cap check.
		const consoleWarnings: string[] = [];
		const originalWarn = console.warn;
		console.warn = (msg: string) => {
			consoleWarnings.push(msg);
		};

		try {
			// Add 256 sessions with active dispatches to standardWorktreeSerializationSessions
			// Each session has an in-flight dispatch in standardWorktreeByCallID
			for (let i = 0; i < 256; i++) {
				const sessionID = `sc113-active-${String(i).padStart(3, '0')}`;
				serializeSessionDirectly(sessionID);

				// Mark as active (has in-flight dispatch)
				standardWorktreeByCallID.set(`call-${sessionID}`, {
					callID: `call-${sessionID}`,
					parentSessionID: sessionID,
					taskId: `task-${i}`,
					planTaskId: `task-${i}`,
					handle: {
						worktreePath: path.join(tempDir, '.swarm-worktrees', sessionID),
						branchName: `swarm/lane/${sessionID}`,
					},
					mergeStrategy: 'merge',
				});
			}

			// Call rememberStandardWorktreeSerializationSession for the 257th session
			// via _internals — this directly exercises the FIFO cap check
			isolationInternals.rememberStandardWorktreeSerializationSession(
				'sc113-257th-session',
			);

			// SC-113: no active session should be evicted
			for (let i = 0; i < 256; i++) {
				const sessionID = `sc113-active-${String(i).padStart(3, '0')}`;
				expect(standardWorktreeSerializationSessions.has(sessionID)).toBe(true);
			}

			// The 257th session should NOT have been added (eviction was refused)
			expect(
				standardWorktreeSerializationSessions.has('sc113-257th-session'),
			).toBe(false);

			// Warning should have been logged about refusing eviction
			expect(
				consoleWarnings.some((w) =>
					w.includes('at cap with all sessions active'),
				),
			).toBe(true);
		} finally {
			console.warn = originalWarn;
		}
	});

	it('SC-113: when capacity is full but one inactive — the inactive one is evicted', async () => {
		// Build up to EXACTLY 256 entries (the cap) BEFORE attempting eviction.
		// We need: 254 active + 1 inactive + 1 more active = 256 total.
		// Then the 257th attempt triggers eviction of the inactive session.
		for (let i = 0; i < 254; i++) {
			const sessionID = `sc113-inactive-test-${i}`;
			serializeSessionDirectly(sessionID);

			// Mark as active (has in-flight dispatch in standardWorktreeByCallID)
			standardWorktreeByCallID.set(`call-${sessionID}`, {
				callID: `call-${sessionID}`,
				parentSessionID: sessionID,
				taskId: `task-${i}`,
				handle: {
					worktreePath: path.join(tempDir, '.swarm-worktrees', sessionID),
					branchName: `swarm/lane/${sessionID}`,
				},
				mergeStrategy: 'merge',
			});
		}

		// The 255th entry is INACTIVE (no in-flight dispatch)
		const inactiveSession = 'sc113-inactive-session';
		serializeSessionDirectly(inactiveSession);
		// Do NOT add to standardWorktreeByCallID — this is what makes it inactive

		// Add one more active session to reach the 256 cap
		const lastActiveSession = 'sc113-last-active';
		serializeSessionDirectly(lastActiveSession);
		standardWorktreeByCallID.set(`call-${lastActiveSession}`, {
			callID: `call-${lastActiveSession}`,
			parentSessionID: lastActiveSession,
			taskId: 'task-last',
			handle: {
				worktreePath: path.join(tempDir, '.swarm-worktrees', lastActiveSession),
				branchName: `swarm/lane/${lastActiveSession}`,
			},
			mergeStrategy: 'merge',
		});

		// At capacity: 254 + 1 inactive + 1 active = 256
		expect(standardWorktreeSerializationSessions.size).toBe(256);

		// The 257th session addition should evict the inactive one (only inactive entry)
		isolationInternals.rememberStandardWorktreeSerializationSession(
			'sc113-new-session',
		);

		// The new session should be in the set
		expect(standardWorktreeSerializationSessions.has('sc113-new-session')).toBe(
			true,
		);
		// The inactive session should have been evicted
		expect(standardWorktreeSerializationSessions.has(inactiveSession)).toBe(
			false,
		);
		// The last active session should still be there
		expect(standardWorktreeSerializationSessions.has(lastActiveSession)).toBe(
			true,
		);
		// All 254 original active sessions should still be there
		for (let i = 0; i < 254; i++) {
			const sessionID = `sc113-inactive-test-${i}`;
			expect(standardWorktreeSerializationSessions.has(sessionID)).toBe(true);
		}
	});
});

// ─── End of file ─────────────────────────────────────────────────────────────
