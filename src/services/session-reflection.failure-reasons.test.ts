/**
 * Issue #2349 sweep — tool-failure REASONS end to end.
 *
 * `agent-activity` used to collapse a tool's `output.error` into a boolean that
 * only incremented `failureCount`, so nothing anywhere recorded WHY a tool
 * failed. Recovering the value is only half a fix: it has to reach a surface a
 * human or agent actually reads. The first attempt at this wiring rendered it in
 * ONE of three surfaces and silently dropped it in the other two — a
 * boundary-only test cannot catch that, which is why the render pins below
 * assert the emitted text on each surface.
 *
 * Split from `session-reflection.test.ts` to keep that file under the FR-006
 * 500-line cap.
 */
import { describe, expect, test } from 'bun:test';
import { _internals } from './session-reflection';

describe('session-reflection — tool failure reasons (issue #2349)', () => {
	// Issue #2349 sweep: agent-activity.ts used to collapse `output.error` into a
	// pure boolean, so nothing anywhere recorded WHY a tool failed. Recovering the
	// value is only half a fix — it has to reach a surface someone reads. This
	// pins that the reason actually crosses the aggregate -> ToolProblem boundary,
	// which is what makes the recovered value non-dead.
	test('forwards failureReasons from the aggregate onto the problem', () => {
		const aggs = new Map([
			[
				'bash',
				{
					tool: 'bash',
					count: 10,
					successCount: 7,
					failureCount: 3,
					totalDuration: 5000,
					failureReasons: ['permission denied', 'command not found'],
				},
			],
		]);
		const result = _internals.gatherToolProblems(aggs);
		expect(result.problems[0].failureReasons).toEqual([
			'permission denied',
			'command not found',
		]);
	});

	// Issue #2349 sweep, RENDER-LEVEL pins. The hop tests above proved the reason
	// crosses aggregate -> ToolProblem, but the first attempt at this wiring
	// rendered it in ONE of three surfaces and dropped it in the other two — a
	// boundary test cannot catch that. These assert the rendered text.
	test('renders reasons on every tool-problem surface, not just the LLM prompt', () => {
		const data = {
			timestamp: '2026-08-26T00:00:00.000Z',
			totalToolCalls: 10,
			totalToolFailures: 3,
			toolProblems: [
				{
					tool: 'bash',
					failureCount: 3,
					totalCalls: 10,
					failureRate: 0.3,
					avgDurationMs: 500,
					failureReasons: ['permission denied'],
				},
			],
			agentDispatches: [],
			gateFailures: [],
			lessonsFromRetros: [],
			errorTaxonomy: {},
			skillViolations: [],
			contradictionCandidates: [],
		} as never;
		// 1. The LLM delegate prompt.
		expect(_internals.buildReflectionDataSummary(data)).toContain(
			'permission denied',
		);
		// 2. The DETERMINISTIC report — taken when no delegate is configured, the
		//    signal aborts, or the delegate throws. Dropping it here loses the
		//    reason on exactly the paths with no model to infer it.
		expect(_internals.buildDeterministicReport(data)).toContain(
			'permission denied',
		);
		// 3. The signals block — rendered UNCONDITIONALLY by `/swarm close`, so it
		//    is the one surface a human always sees.
		expect(_internals.buildSignalsBlock(data)).toContain('permission denied');
	});

	test('omits failureReasons entirely when none were recorded', () => {
		const aggs = new Map([
			[
				'bash',
				{
					tool: 'bash',
					count: 10,
					successCount: 7,
					failureCount: 3,
					totalDuration: 5000,
				},
			],
		]);
		const result = _internals.gatherToolProblems(aggs);
		expect(result.problems[0].failureReasons).toBeUndefined();
	});
});
