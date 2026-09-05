/**
 * Execution-stall detector — EPISODE predicate (issue #2063 B5).
 *
 * The episode is what makes a hard lever safe. It arms only when the session
 * actually attempts execution work in THIS session, and it lapses on IDLENESS
 * rather than on elapsed time since arming.
 *
 * The idleness definition is critic round-3 fix 1 and has its own regression
 * case below: an armed episode that keeps making non-progress calls for 40
 * minutes must STILL reach the hard rung. An arming-time window would have
 * expired first and silently reset the counter, which is the exact failure the
 * lever exists to prevent.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isExecutionEpisodeArmed } from '../../../src/hooks/guardrails/execution-episode';
import {
	_internals,
	_test_exports,
	canonicalDispatchRole,
	DEFAULT_EXECUTION_STALL_EPISODE_MINUTES,
	DEFAULT_EXECUTION_STALL_STOP_CALLS,
	enforceExecutionStallDenial,
	isArchitectStallSession,
	MAX_TRACKED_STALL_SESSIONS,
	MUTATING_DELEGATION_ROLES,
	observeExecutionStallToolCall,
	recordExecutionStallToolAfter,
} from '../../../src/hooks/guardrails/execution-stall';
import {
	ensureAgentSession,
	resetSwarmState,
	swarmState,
} from '../../../src/state';

const TEST_DIR = path.join(os.tmpdir(), 'stall-episode-fixture');

const realNow = _internals.now;
const realCapture = _internals.captureWorkspaceSnapshotAsync;
const realChanged = _internals.changedFilesSinceSnapshotAsync;

let clock = 1_700_000_000_000;

/** Fake, always-clean workspace so no test in this file spawns git. */
const cleanSnapshot = () =>
	({ gitHead: 'HEAD0', changedFiles: [] }) as unknown as ReturnType<
		typeof realCapture
	>;

beforeEach(() => {
	resetSwarmState();
	_test_exports.reset();
	clock = 1_700_000_000_000;
	_internals.now = () => clock;
	_internals.captureWorkspaceSnapshotAsync = mock(cleanSnapshot) as never;
	_internals.changedFilesSinceSnapshotAsync = mock(async () => []) as never;
});

afterEach(() => {
	_internals.now = realNow;
	_internals.captureWorkspaceSnapshotAsync = realCapture;
	_internals.changedFilesSinceSnapshotAsync = realChanged;
	_test_exports.reset();
	resetSwarmState();
});

function setupArchitect(sessionID: string, agent = 'architect'): void {
	swarmState.activeAgent.set(sessionID, agent);
}

function nonProgressCall(sessionID: string, n: number): void {
	observeExecutionStallToolCall({
		sessionID,
		tool: 'read',
		args: { filePath: `/p/file-${n}.ts` },
		callID: `read-${n}`,
	});
}

function dispatch(sessionID: string, role: string, n: number): void {
	observeExecutionStallToolCall({
		sessionID,
		tool: 'Task',
		args: { subagent_type: role, prompt: 'do it' },
		callID: `task-${n}`,
	});
}

function denyRead(sessionID: string): () => void {
	return () => enforceExecutionStallDenial({ sessionID, tool: 'read' });
}

describe('#2063 B5 — episode arming', () => {
	test('a fresh session with a stale in_progress task in plan.json stays UNARMED', () => {
		// The episode predicate is deliberately in-session-event-based, not
		// workspace-state-based. A previous run that left `1.1` in_progress in
		// plan.json must not arm a hard lever for a session that has attempted
		// no execution work at all.
		fs.mkdirSync(path.join(TEST_DIR, '.swarm'), { recursive: true });
		fs.writeFileSync(
			path.join(TEST_DIR, '.swarm', 'plan.json'),
			JSON.stringify({
				phases: [{ id: 1, tasks: [{ id: '1.1', status: 'in_progress' }] }],
			}),
		);
		try {
			const sessionID = 'stale-plan';
			setupArchitect(sessionID);

			for (let i = 0; i < DEFAULT_EXECUTION_STALL_STOP_CALLS + 5; i++) {
				nonProgressCall(sessionID, i);
			}

			expect(_test_exports.peekState(sessionID)?.armed).toBe(false);
			expect(_test_exports.peekState(sessionID)?.nonProgressCalls).toBe(0);
			expect(denyRead(sessionID)).not.toThrow();
		} finally {
			fs.rmSync(TEST_DIR, { recursive: true, force: true });
		}
	});

	test('arms on a mutating-role Task ATTEMPT and publishes the shared episode field', () => {
		const sessionID = 'arm-on-attempt';
		setupArchitect(sessionID);

		dispatch(sessionID, 'coder', 1);

		expect(_test_exports.peekState(sessionID)?.armed).toBe(true);
		// The producer must materialize the architect's session entry — without
		// it `setExecutionEpisodeArmed` no-ops and B3's consumer never fires.
		expect(swarmState.agentSessions.has(sessionID)).toBe(true);
		expect(isExecutionEpisodeArmed(sessionID)).toBe(true);
	});

	test('arms even when a LATER gate denies the same dispatch', () => {
		// The motivating loop: the architect dispatches, `delegation-gate` throws
		// ACCEPTANCE_FIELD_REQUIRED, and the dispatch never runs. Guardrails
		// toolBefore observes the ATTEMPT first (src/index.ts:2710 vs :2719), so
		// the episode arms regardless of the later denial.
		const sessionID = 'arm-despite-denial';
		setupArchitect(sessionID);

		const simulateDeniedDispatch = () => {
			dispatch(sessionID, 'reviewer', 1);
			throw new Error('ACCEPTANCE_FIELD_REQUIRED: task 1.1 needs ACCEPTANCE');
		};
		expect(simulateDeniedDispatch).toThrow('ACCEPTANCE_FIELD_REQUIRED');

		expect(_test_exports.peekState(sessionID)?.armed).toBe(true);
		expect(isExecutionEpisodeArmed(sessionID)).toBe(true);
	});

	test('arms on every mutating/verifying role, including swarm-prefixed names', () => {
		// The canonical set is the production one; the prefixed/hyphenated names
		// additionally prove the resolver, not a literal-string match.
		expect([...MUTATING_DELEGATION_ROLES].sort()).toEqual([
			'coder',
			'reviewer',
			'security_reviewer',
			'test_engineer',
		]);
		for (const role of [
			...MUTATING_DELEGATION_ROLES,
			'mega_coder',
			'acme-reviewer',
		]) {
			resetSwarmState();
			_test_exports.reset();
			const sessionID = `arm-${role}`;
			setupArchitect(sessionID);
			dispatch(sessionID, role, 1);
			expect(_test_exports.peekState(sessionID)?.armed).toBe(true);
		}
	});

	test('canonicalDispatchRole resolves prefixed and hyphenated dispatch names', () => {
		// The role filter is expressed through the canonical resolver rather than
		// string literals, so a prefixed agent name must not silently drop out of
		// the mutating set — the failure mode would be a lever that never arms in
		// a multi-swarm config.
		expect(canonicalDispatchRole('Task', { subagent_type: 'coder' })).toBe(
			'coder',
		);
		expect(canonicalDispatchRole('Task', { subagent_type: 'mega_coder' })).toBe(
			'coder',
		);
		expect(
			canonicalDispatchRole('task', { subagent_type: 'acme-test_engineer' }),
		).toBe('test_engineer');
		// `security_reviewer` is not itself in ALL_AGENT_NAMES; the longest-suffix
		// scan resolves it to `reviewer`, which is already mutating.
		expect(
			canonicalDispatchRole('Task', { subagent_type: 'security-reviewer' }),
		).toBe('reviewer');
		// Non-delegations and malformed args yield no role.
		expect(canonicalDispatchRole('read', { filePath: '/p/a.ts' })).toBeNull();
		expect(canonicalDispatchRole('Task', {})).toBeNull();
		expect(canonicalDispatchRole('Task', undefined)).toBeNull();
	});

	test('isArchitectStallSession uses activeAgent, then agentName, then fails open', () => {
		swarmState.activeAgent.set('a', 'architect');
		expect(isArchitectStallSession('a')).toBe(true);
		swarmState.activeAgent.set('b', 'mega_architect');
		expect(isArchitectStallSession('b')).toBe(true);
		swarmState.activeAgent.set('c', 'coder');
		expect(isArchitectStallSession('c')).toBe(false);
		ensureAgentSession('d', 'architect');
		expect(isArchitectStallSession('d')).toBe(true);
		// Unknown session: the lever must stay silent rather than guess.
		expect(isArchitectStallSession('unknown-session')).toBe(false);
	});

	test('does NOT arm on read-only-role dispatches (explorer, sme)', () => {
		for (const role of ['explorer', 'sme', 'mega_explorer']) {
			resetSwarmState();
			_test_exports.reset();
			const sessionID = `noarm-${role}`;
			setupArchitect(sessionID);
			dispatch(sessionID, role, 1);
			expect(_test_exports.peekState(sessionID)?.armed).toBe(false);
			expect(isExecutionEpisodeArmed(sessionID)).toBe(false);
		}
	});

	test('arms on a successful update_task_status(in_progress)', async () => {
		const sessionID = 'arm-on-status';
		setupArchitect(sessionID);

		await recordExecutionStallToolAfter({
			sessionID,
			tool: 'update_task_status',
			callID: 'uts-1',
			args: { task_id: '1.1', status: 'in_progress' },
			output: {
				title: 'update_task_status',
				output: JSON.stringify({ success: true, new_status: 'in_progress' }),
				metadata: {},
			},
			directory: TEST_DIR,
		});

		expect(_test_exports.peekState(sessionID)?.armed).toBe(true);
		expect(isExecutionEpisodeArmed(sessionID)).toBe(true);
	});

	test('does NOT arm when update_task_status(in_progress) FAILED', async () => {
		const sessionID = 'noarm-failed-status';
		setupArchitect(sessionID);

		await recordExecutionStallToolAfter({
			sessionID,
			tool: 'update_task_status',
			callID: 'uts-fail',
			args: { task_id: '1.1', status: 'in_progress' },
			output: {
				title: 'update_task_status',
				output: JSON.stringify({
					success: false,
					message: 'Gate check failed',
				}),
				metadata: {},
			},
			directory: TEST_DIR,
		});

		expect(_test_exports.peekState(sessionID)?.armed).toBeUndefined();
		expect(isExecutionEpisodeArmed(sessionID)).toBe(false);
	});

	test('is inert for a SUBAGENT session (architect-scoped)', () => {
		const sessionID = 'subagent';
		ensureAgentSession(sessionID, 'coder');
		swarmState.activeAgent.set(sessionID, 'coder');

		dispatch(sessionID, 'coder', 1);
		for (let i = 0; i < DEFAULT_EXECUTION_STALL_STOP_CALLS + 5; i++) {
			nonProgressCall(sessionID, i);
		}

		expect(_test_exports.peekState(sessionID)).toBeUndefined();
		expect(denyRead(sessionID)).not.toThrow();
	});

	test('is fully inert when guardrails are disabled', () => {
		// The module owns its own inert path rather than relying on
		// createGuardrailsHooks' no-op short-circuit, so this is not vacuous.
		const sessionID = 'disabled';
		setupArchitect(sessionID);
		const options = { enabled: false };

		observeExecutionStallToolCall({
			sessionID,
			tool: 'Task',
			args: { subagent_type: 'coder' },
			callID: 'task-1',
			options,
		});
		for (let i = 0; i < DEFAULT_EXECUTION_STALL_STOP_CALLS + 5; i++) {
			observeExecutionStallToolCall({
				sessionID,
				tool: 'read',
				args: { filePath: `/p/${i}.ts` },
				callID: `r-${i}`,
				options,
			});
		}

		expect(_test_exports.peekState(sessionID)).toBeUndefined();
		expect(isExecutionEpisodeArmed(sessionID)).toBe(false);
		expect(() =>
			enforceExecutionStallDenial({ sessionID, tool: 'read', options }),
		).not.toThrow();
	});
});

describe('#2063 B5 — episode lapse is IDLENESS, not elapsed-since-arming', () => {
	test('REGRESSION (critic r3): 40 minutes of CONTINUOUS non-progress calls still reaches the hard rung', () => {
		// Previous design lapsed the episode `execution_stall_episode_minutes`
		// after ARMING. A slow stall — one call every ~40 s for 40 minutes —
		// therefore disarmed and reset at minute 30 and NEVER escalated, which is
		// precisely the shape of the reported hour-long loop.
		const sessionID = 'slow-stall';
		setupArchitect(sessionID);
		dispatch(sessionID, 'coder', 1);

		const totalCalls = DEFAULT_EXECUTION_STALL_STOP_CALLS + 10;
		// 40 minutes spread over the run: every gap is well under the 30-minute
		// idleness window, so the episode must stay armed the whole way.
		const gapMs = Math.floor((40 * 60_000) / totalCalls);
		for (let i = 0; i < totalCalls; i++) {
			clock += gapMs;
			nonProgressCall(sessionID, i);
		}

		expect(_test_exports.peekState(sessionID)?.armed).toBe(true);
		expect(denyRead(sessionID)).toThrow(/^EXECUTION_STALL:/);
	});

	test('31 minutes with ZERO tool calls disarms and fully resets on the next call', () => {
		const sessionID = 'idle-lapse';
		setupArchitect(sessionID);
		dispatch(sessionID, 'coder', 1);
		for (let i = 0; i < DEFAULT_EXECUTION_STALL_STOP_CALLS; i++) {
			nonProgressCall(sessionID, i);
		}
		expect(denyRead(sessionID)).toThrow(/^EXECUTION_STALL:/);

		// Lapse is evaluated lazily on the NEXT tool call — there are no timers
		// (invariant 1), so one more call is what surfaces the disarm.
		clock += (DEFAULT_EXECUTION_STALL_EPISODE_MINUTES + 1) * 60_000;
		nonProgressCall(sessionID, 999);

		const state = _test_exports.peekState(sessionID);
		expect(state?.armed).toBe(false);
		expect(state?.nonProgressCalls).toBe(0);
		expect(state?.warnIssued).toBe(false);
		expect(isExecutionEpisodeArmed(sessionID)).toBe(false);
		expect(denyRead(sessionID)).not.toThrow();
	});

	test('a gap just UNDER the window does not disarm', () => {
		const sessionID = 'near-miss';
		setupArchitect(sessionID);
		dispatch(sessionID, 'coder', 1);
		const before = _test_exports.peekState(sessionID)?.nonProgressCalls ?? 0;

		clock += (DEFAULT_EXECUTION_STALL_EPISODE_MINUTES - 1) * 60_000;
		nonProgressCall(sessionID, 1);

		expect(_test_exports.peekState(sessionID)?.armed).toBe(true);
		expect(_test_exports.peekState(sessionID)?.nonProgressCalls).toBe(
			before + 1,
		);
	});

	test('the lapse window honours a configured execution_stall_episode_minutes', () => {
		const sessionID = 'configured-window';
		setupArchitect(sessionID);
		const options = { episodeMinutes: 5 };

		observeExecutionStallToolCall({
			sessionID,
			tool: 'Task',
			args: { subagent_type: 'coder' },
			callID: 'task-1',
			options,
		});
		clock += 6 * 60_000;
		observeExecutionStallToolCall({
			sessionID,
			tool: 'read',
			args: { filePath: '/p/a.ts' },
			callID: 'r-1',
			options,
		});

		expect(_test_exports.peekState(sessionID)?.armed).toBe(false);
	});
});

describe('#2063 B5 — bounded session state (invariant 8)', () => {
	test('tracked sessions stay bounded and the ACTIVE session is not the eviction victim', () => {
		const active = 'architect-active';
		setupArchitect(active);
		dispatch(active, 'coder', 1);

		for (let i = 0; i < MAX_TRACKED_STALL_SESSIONS + 60; i++) {
			const other = `other-${i}`;
			setupArchitect(other);
			nonProgressCall(other, i);
			// Keep the real architect the most-recently-touched entry.
			nonProgressCall(active, i);
		}

		expect(_test_exports.stateCount()).toBeLessThanOrEqual(
			MAX_TRACKED_STALL_SESSIONS,
		);
		expect(_test_exports.peekState(active)?.armed).toBe(true);
	});

	test('the callID→role note is released even for a non-architect toolAfter', async () => {
		const sessionID = 'role-note-release';
		setupArchitect(sessionID);
		dispatch(sessionID, 'coder', 7);
		expect(_test_exports.pendingDispatchRoleCount()).toBe(1);

		await recordExecutionStallToolAfter({
			sessionID,
			tool: 'Task',
			callID: 'task-7',
			output: { title: 'Task', output: 'done', metadata: {} },
			directory: TEST_DIR,
			options: { enabled: false },
		});

		expect(_test_exports.pendingDispatchRoleCount()).toBe(0);
	});
});
