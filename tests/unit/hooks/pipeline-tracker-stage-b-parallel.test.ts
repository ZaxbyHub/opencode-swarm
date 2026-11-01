/**
 * Regression: the architect swarm_reminder must match the Stage B rule.
 * Dispatch reviewer and test_engineer together for one completed coder task,
 * then wait for both verdicts. Serial "wait, then test_engineer" is the bug.
 */

import { describe, expect, test } from 'bun:test';
import { buildPhaseReminder } from '../../../src/hooks/pipeline-tracker';

describe('swarm_reminder Stage B parallel dispatch', () => {
	test('dispatches reviewer and test_engineer together, then waits for both verdicts', () => {
		const reminder = buildPhaseReminder(2);

		expect(reminder).toContain(
			'For each completed coder task, dispatch @reviewer and @test_engineer together',
		);
		expect(reminder).toContain('Many subagents may run in one wave');
		expect(reminder).toContain('dispatch those coders together');
		expect(reminder).toContain('dispatch_lanes_async');
		expect(reminder).toContain(
			"Wait for that task's reviewer and test_engineer verdicts",
		);
		expect(reminder).not.toContain(
			'Wait for both verdicts before the next coder task',
		);
		expect(reminder).toContain(
			'dispatch @reviewer and @test_engineer together for the same completed coder task, then wait for both verdicts',
		);
		expect(reminder).not.toContain('If approved, delegate to @test_engineer');
		expect(reminder).not.toContain(
			'Always wait for response before next delegation',
		);
	});
});
