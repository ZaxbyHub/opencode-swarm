/**
 * No-op work detector: delegation counts as progress.
 *
 * Field evidence (the originally reported bug): a healthy read-only
 * `/swarm pr-review` was told it might be stuck. The detector warns after N
 * tool calls with no file modifications, but:
 *
 *   - the counter is keyed by `input.sessionID`, and a subagent's writes land
 *     under a DIFFERENT sessionID, so lane writes could never reset the
 *     architect's count;
 *   - `Task` is not in WRITE_TOOL_NAMES, so delegating did not reset it either.
 *
 * An architect that orchestrates and reads therefore climbed toward the warning
 * forever — in every mode, not just PR review.
 *
 * Critically, PR_REVIEW dispatches its lanes through `dispatch_lanes_async`, and
 * the `task` tool is BLOCKED outright while a PR_REVIEW gate is active. So a fix
 * keyed only on `Task` would have left the reported case unfixed; both dispatch
 * mechanisms must count as progress.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { GuardrailsConfig } from '../../../src/config/schema';
import {
	createGuardrailsHooks,
	_internals as internals,
	MAX_TRACKED_NO_OP_SESSIONS,
} from '../../../src/hooks/guardrails';
import {
	ensureAgentSession,
	resetSwarmState,
	swarmState,
} from '../../../src/state';

const TEST_DIR = '/test/project';
const THRESHOLD = 15;

const config: GuardrailsConfig = {
	enabled: true,
	max_tool_calls: 2000,
	max_duration_minutes: 300,
	max_repetitions: 10_000,
	max_consecutive_errors: 5000,
	warning_threshold: 0.99,
	idle_timeout_minutes: 600,
	no_op_warning_threshold: THRESHOLD,
} as unknown as GuardrailsConfig;

function makeHooks() {
	return createGuardrailsHooks(TEST_DIR, config);
}

/** Drive one non-write tool call (the shape of a read/grep/gh call). */
async function readCall(
	hooks: ReturnType<typeof createGuardrailsHooks>,
	sessionId: string,
	n: number,
): Promise<void> {
	await hooks.toolAfter(
		{
			tool: 'read',
			sessionID: sessionId,
			callID: `read-${n}`,
			args: { filePath: `/test/project/file-${n}.ts` },
		} as never,
		{ title: 'read', output: 'file contents', metadata: {} } as never,
	);
}

function advisoriesFor(sessionId: string): string[] {
	return swarmState.agentSessions.get(sessionId)?.pendingAdvisoryMessages ?? [];
}

function noOpWarnings(sessionId: string): string[] {
	return advisoriesFor(sessionId).filter((m) =>
		m.includes('tool calls with no file modifications'),
	);
}

describe('no-op work detector: subagent dispatch counts as progress', () => {
	beforeEach(() => resetSwarmState());
	afterEach(() => resetSwarmState());

	test('reads alone still trip the warning (the detector is not disabled)', async () => {
		// Guard against the fix over-reaching into a silence. A session that only
		// reads and never delegates IS the stuck case the detector exists for.
		const hooks = makeHooks();
		const sessionId = 'noop-reads-only';
		ensureAgentSession(sessionId, 'architect');
		swarmState.activeAgent.set(sessionId, 'architect');

		for (let i = 0; i < THRESHOLD; i++) await readCall(hooks, sessionId, i);

		expect(noOpWarnings(sessionId)).toHaveLength(1);
	});

	test('dispatch_lanes_async resets the counter — the reported PR_REVIEW case', async () => {
		// PR_REVIEW dispatches six mandatory base lanes this way while the `task`
		// tool is blocked, so this is the exact path that produced the field report.
		const hooks = makeHooks();
		const sessionId = 'noop-lane-dispatch';
		ensureAgentSession(sessionId, 'architect');
		swarmState.activeAgent.set(sessionId, 'architect');

		// Climb to one call below the threshold.
		for (let i = 0; i < THRESHOLD - 1; i++) await readCall(hooks, sessionId, i);
		expect(noOpWarnings(sessionId)).toHaveLength(0);

		// Dispatch lanes: real progress.
		await hooks.toolAfter(
			{
				tool: 'dispatch_lanes_async',
				sessionID: sessionId,
				callID: 'lanes-1',
				args: { lanes: [{ id: 'l1', agent: 'explorer', prompt: 'review' }] },
			} as never,
			{
				title: 'dispatch_lanes_async',
				output: '{"pending":1}',
				metadata: {},
			} as never,
		);

		// The counter restarted, so another near-full run of reads stays silent.
		for (let i = 0; i < THRESHOLD - 1; i++)
			await readCall(hooks, sessionId, 100 + i);
		expect(noOpWarnings(sessionId)).toHaveLength(0);
	});

	test('a Task delegation also resets the counter', async () => {
		const hooks = makeHooks();
		const sessionId = 'noop-task-delegation';
		ensureAgentSession(sessionId, 'architect');
		swarmState.activeAgent.set(sessionId, 'architect');

		for (let i = 0; i < THRESHOLD - 1; i++) await readCall(hooks, sessionId, i);
		expect(noOpWarnings(sessionId)).toHaveLength(0);

		await hooks.toolAfter(
			{
				tool: 'Task',
				sessionID: sessionId,
				callID: 'task-1',
				args: { subagent_type: 'explorer', prompt: 'investigate' },
			} as never,
			{ title: 'Task', output: 'done', metadata: {} } as never,
		);

		for (let i = 0; i < THRESHOLD - 1; i++)
			await readCall(hooks, sessionId, 200 + i);
		expect(noOpWarnings(sessionId)).toHaveLength(0);
	});

	test('a bare Task with no subagent_type is NOT treated as a delegation', async () => {
		// isAgentDelegation requires subagent_type; a Task without it delegates
		// nothing, so it must not launder a stuck session into looking productive.
		const hooks = makeHooks();
		const sessionId = 'noop-bare-task';
		ensureAgentSession(sessionId, 'architect');
		swarmState.activeAgent.set(sessionId, 'architect');

		for (let i = 0; i < THRESHOLD - 1; i++) await readCall(hooks, sessionId, i);
		await hooks.toolAfter(
			{
				tool: 'Task',
				sessionID: sessionId,
				callID: 'bare-task',
				args: { prompt: 'no subagent_type here' },
			} as never,
			{ title: 'Task', output: 'done', metadata: {} } as never,
		);

		// That call was itself a non-write, so it is the Nth and trips the warning.
		expect(noOpWarnings(sessionId)).toHaveLength(1);
	});

	test('the session maps are FIFO-bounded (invariant 8)', async () => {
		// These maps are module-level and session-keyed. They were unbounded and
		// grew for the lifetime of the plugin process, since nothing removed a key
		// when a session ended. The fix-plan declared a bound owed with any change
		// to this block.
		const hooks = makeHooks();
		const overBound = MAX_TRACKED_NO_OP_SESSIONS + 50;
		for (let s = 0; s < overBound; s++) {
			const sid = `noop-bound-${s}`;
			ensureAgentSession(sid, 'architect');
			swarmState.activeAgent.set(sid, 'architect');
			await readCall(hooks, sid, 0);
		}
		// The oldest sessions were evicted; the map cannot exceed the bound.
		expect(internals.noOpStateSize()).toBeLessThanOrEqual(
			MAX_TRACKED_NO_OP_SESSIONS,
		);
		// The most recent session survived eviction.
		expect(internals.hasNoOpState(`noop-bound-${overBound - 1}`)).toBe(true);
		// The oldest was evicted.
		expect(internals.hasNoOpState('noop-bound-0')).toBe(false);
	});

	test('an actively-climbing session is NOT evicted by churn from other sessions', async () => {
		// Regression for a bound that silenced the detector it protects.
		// `Map.set()` on an existing key does not move it, so plain
		// insertion-order eviction always drops the FIRST-created session — which
		// in a real plugin process is the architect, the very session being
		// watched. Measured with FIFO eviction: the architect's counter was reset
		// mid-climb and its 15th consecutive no-write call produced ZERO warnings.
		const hooks = makeHooks();
		const architect = 'noop-lru-architect';
		ensureAgentSession(architect, 'architect');
		swarmState.activeAgent.set(architect, 'architect');

		// The architect is created FIRST — the worst case for FIFO eviction.
		// A stale session is created immediately AFTER it and then never touched
		// again: under FIFO the architect dies and this one survives, which is
		// exactly backwards.
		const stale = 'noop-lru-stale';
		ensureAgentSession(stale, 'architect');
		swarmState.activeAgent.set(stale, 'architect');
		await readCall(hooks, architect, 0);
		await readCall(hooks, stale, 0);

		// The architect keeps working — interleaved with heavy churn from other
		// sessions — so it is continuously the most-recently-touched entry.
		for (let i = 1; i < THRESHOLD - 1; i++) {
			await readCall(hooks, architect, i);
			for (let s = 0; s < 25; s++) {
				const sid = `noop-lru-churn-${i}-${s}`;
				ensureAgentSession(sid, 'architect');
				swarmState.activeAgent.set(sid, 'architect');
				await readCall(hooks, sid, 0);
			}
		}
		// Churn total (13 × 25 = 325) far exceeds the bound, so eviction ran.
		expect(internals.noOpStateSize()).toBeLessThanOrEqual(
			MAX_TRACKED_NO_OP_SESSIONS,
		);
		// The stale session — inserted BEFORE all that churn and never touched
		// again — is gone, which is the correct victim.
		expect(internals.hasNoOpState(stale)).toBe(false);
		// The actively-working architect survived, counter intact.
		expect(internals.hasNoOpState(architect)).toBe(true);

		// And it still warns on its Nth consecutive no-write call. Under FIFO its
		// counter was reset mid-climb and this produced ZERO warnings.
		expect(noOpWarnings(architect)).toHaveLength(0);
		await readCall(hooks, architect, 999);
		expect(noOpWarnings(architect)).toHaveLength(1);
	});

	test('the warning no longer advises /swarm handoff', async () => {
		// The old text told a possibly-stuck agent to reset the session, which
		// discards exactly the context an orchestrating architect is assembling.
		const hooks = makeHooks();
		const sessionId = 'noop-advice';
		ensureAgentSession(sessionId, 'architect');
		swarmState.activeAgent.set(sessionId, 'architect');

		for (let i = 0; i < THRESHOLD; i++) await readCall(hooks, sessionId, i);

		const warnings = noOpWarnings(sessionId);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).not.toContain('/swarm handoff');
		expect(warnings[0]).toContain('report BLOCKED');
	});
});
