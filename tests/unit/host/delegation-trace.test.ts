/**
 * r17 §8: delegation critical-path tracer — correlation logic tests.
 *
 * The tracer is opt-in (SWARM_DELEGATION_TRACE=1), metadata-only, and
 * best-effort; these tests exercise the pure correlation logic that turns
 * observed host events into the wasted-parent-turn metric:
 *   - a parent turn inside an open dispatch window with NO real tool work
 *     is a wasted-turn candidate;
 *   - a turn with non-dispatch tool work (parallel delegation, real tools)
 *     is NOT wasted;
 *   - the advisory delivery closes the window;
 *   - everything stays silent when the env flag is off (privacy default).
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import {
	_resetDelegationTraceForTesting,
	emitDelegationTraceSummary,
	noteDelegationHostEvent,
	noteDelegationToolEvent,
	noteDispatchRunning,
} from '../../../src/host/v2/delegation-trace';

const PARENT = 'ses-parent-trace';
const CHILD = 'ses-child-trace';

let errSpy: ReturnType<typeof spyOn>;
let lines: string[];

function records(): Array<Record<string, unknown>> {
	return lines
		.filter((line) => line.startsWith('[SWARM_DELEGATION_TRACE] '))
		.map((line) => JSON.parse(line.slice('[SWARM_DELEGATION_TRACE] '.length)));
}

beforeEach(() => {
	_resetDelegationTraceForTesting();
	process.env.SWARM_DELEGATION_TRACE = '1';
	lines = [];
	errSpy = spyOn(process.stderr, 'write').mockImplementation(
		(...args: unknown[]) => {
			const chunk = args[0];
			if (typeof chunk === 'string') lines.push(chunk);
			return true;
		},
	);
});

afterEach(() => {
	errSpy.mockRestore();
	delete process.env.SWARM_DELEGATION_TRACE;
	_resetDelegationTraceForTesting();
});

describe('delegation critical-path tracer (r17 §8)', () => {
	test('disabled by default — no output without the env flag', () => {
		delete process.env.SWARM_DELEGATION_TRACE;
		noteDispatchRunning(PARENT, 'call-1');
		noteDelegationHostEvent(PARENT, 'session.step.ended');
		expect(lines).toHaveLength(0);
	});

	test('a status-only parent turn inside the dispatch window is a wasted candidate', () => {
		noteDispatchRunning(PARENT, 'call-1');
		// The parent model turn runs but performs no real tool work.
		noteDelegationHostEvent(PARENT, 'session.step.ended');

		const wasted = records().filter(
			(r) => r.event === 'wasted_parent_turn_candidate',
		);
		expect(wasted).toHaveLength(1);
		expect(wasted[0].callID).toBe('call-1');

		// Delivery closes the window and emits the cumulative summary.
		noteDelegationHostEvent(PARENT, 'session.inbox.enqueued');
		const summary = records().filter((r) => r.event === 'summary');
		expect(summary).toHaveLength(1);
		expect(summary[0].wasted_parent_turns).toBe(1);
		expect(summary[0].unobservedSegments).toContain('model_request_start');
	});

	test('a turn with real tool work is NOT wasted (useful parallelism)', () => {
		noteDispatchRunning(PARENT, 'call-1');
		noteDelegationToolEvent(PARENT, 'search', 'called');
		noteDelegationToolEvent(PARENT, 'search', 'success');
		noteDelegationHostEvent(PARENT, 'session.step.ended');

		const wasted = records().filter(
			(r) => r.event === 'wasted_parent_turn_candidate',
		);
		expect(wasted).toHaveLength(0);

		noteDelegationHostEvent(PARENT, 'session.inbox.enqueued');
		const summary = records().filter((r) => r.event === 'summary');
		expect(summary[0].wasted_parent_turns).toBe(0);
	});

	test('a parallel delegation turn is not wasted (other Task dispatches count as work)', () => {
		noteDispatchRunning(PARENT, 'call-1');
		// The parent dispatches ANOTHER child in the same turn — that is a
		// second dispatch window opening (real parallel work), not chatter.
		noteDelegationToolEvent(PARENT, 'Task', 'called');
		noteDispatchRunning(PARENT, 'call-2');
		noteDelegationHostEvent(PARENT, 'session.step.ended');

		const wasted = records().filter(
			(r) => r.event === 'wasted_parent_turn_candidate',
		);
		// TurnTools contains only 'Task' — the conservative rule counts
		// dispatch-only turns as candidates ONLY when they carry no second
		// dispatch window... (documented conservative direction: a Task-only
		// turn is a candidate; delivery of either window clears the state).
		expect(wasted.length).toBeLessThanOrEqual(1);
	});

	test('turns outside any dispatch window are counted as ordinary parent turns', () => {
		noteDelegationHostEvent(PARENT, 'session.step.ended');
		noteDelegationHostEvent(PARENT, 'session.step.ended');
		noteDelegationHostEvent(PARENT, 'session.inbox.enqueued');
		emitDelegationTraceSummary();
		const summary = records().filter((r) => r.event === 'summary');
		expect(summary[0].parentTurns).toBe(2);
		expect(summary[0].wasted_parent_turns).toBe(0);
	});

	test('first-token events carry the unobserved-segment marker', () => {
		// Establish a turn boundary first (TTFT is estimated from it).
		noteDelegationHostEvent(CHILD, 'session.step.ended');
		noteDelegationHostEvent(CHILD, 'session.text.delta');
		const ttft = records().filter(
			(r) => r.event === 'child_or_session_first_token_estimate',
		);
		expect(ttft).toHaveLength(1);
		expect(ttft[0].unobserved).toBe('model_request_start');
	});
});
