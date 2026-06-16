/**
 * Unit tests for micro-reflector outcome classification + candidate parsing
 * (Swarm Learning System, Change 6 / Task 5.1).
 */

import { describe, expect, it } from 'bun:test';
import {
	classifyOutcome,
	type MicroOutcome,
	parseMicroCandidates,
} from '../../../src/hooks/micro-reflector.js';
import type { TrajectoryEntry } from '../../../src/hooks/trajectory-logger.js';

function step(partial: Partial<TrajectoryEntry>): TrajectoryEntry {
	return {
		step: 1,
		agent: 'coder',
		action: 'run',
		target: '',
		intent: '',
		timestamp: '2026-01-01T00:00:00.000Z',
		result: 'success',
		tool: 'bash',
		args_summary: '',
		verdict: '',
		elapsed_ms: 10,
		...partial,
	};
}

describe('classifyOutcome', () => {
	it('returns success for a clean transcript and trajectory', () => {
		expect(classifyOutcome('All tests passed. Done.', [step({})])).toBe(
			'success',
		);
	});

	it('classifies a failed test tool in the trajectory as failure_test', () => {
		const traj = [step({ tool: 'test_runner', result: 'failure' })];
		expect(classifyOutcome('finished', traj)).toBe('failure_test');
	});

	it('classifies a failed lint/typecheck tool as failure_lint', () => {
		const traj = [step({ tool: 'lint', result: 'failure' })];
		expect(classifyOutcome('finished', traj)).toBe('failure_lint');
	});

	it('detects test failures from the transcript', () => {
		expect(classifyOutcome('Result: 3 failed, 10 passed', [])).toBe(
			'failure_test',
		);
	});

	it('detects lint/type errors from the transcript', () => {
		expect(classifyOutcome('error TS2345: type mismatch', [])).toBe(
			'failure_lint',
		);
	});

	it('detects a revert from the transcript', () => {
		expect(
			classifyOutcome('I reverted the change after it broke the build', []),
		).toBe('failure_revert');
	});

	it('detects partial completion from the transcript', () => {
		expect(
			classifyOutcome(
				'Completed task 1 but remaining work is blocked on X',
				[],
			),
		).toBe('partial');
	});

	it('treats a trajectory ending in failure with no clear kind as partial', () => {
		const traj = [step({ tool: 'edit', result: 'failure', verdict: 'denied' })];
		expect(classifyOutcome('hmm', traj)).toBe('partial');
	});

	it('trajectory failure kind takes precedence over transcript', () => {
		// transcript says "partial" but trajectory shows a test failure → test wins
		const traj = [step({ tool: 'test_runner', result: 'failure' })];
		expect(classifyOutcome('partial progress', traj)).toBe('failure_test');
	});

	it('does NOT treat a benign "TODO" comment as partial (regression: Phase 5 review)', () => {
		// A successful run that merely mentions leaving a TODO must NOT trigger
		// reflection (which would waste an LLM call). Bare "TODO" is excluded.
		expect(
			classifyOutcome(
				'Done. I left a TODO comment for a future optimization.',
				[step({ result: 'success' })],
			),
		).toBe('success');
		expect(
			classifyOutcome(
				'Added a // TODO: revisit caching later. All tests pass.',
				[],
			),
		).toBe('success');
	});
});

describe('parseMicroCandidates', () => {
	const meta = {
		agent: 'coder',
		outcome: 'failure_test' as MicroOutcome,
		taskId: 't-1',
		steps: 3,
	};

	it('parses a valid v3 candidate array', () => {
		const resp = JSON.stringify([
			{
				lesson: 'Run the focused test file before declaring a fix complete',
				applies_to_agents: ['coder'],
				required_actions: ['run the specific failing test before finishing'],
				directive_priority: 'high',
			},
		]);
		const out = parseMicroCandidates(resp, meta);
		expect(out).toHaveLength(1);
		expect(out[0].lesson).toContain('focused test');
		expect(out[0].applies_to_agents).toEqual(['coder']);
		expect(out[0].directive_priority).toBe('high');
		expect(out[0].source.kind).toBe('micro_reflection');
		expect(out[0].source.task_id).toBe('t-1');
		expect(out[0].source.outcome).toBe('failure_test');
	});

	it('drops candidates that fail the actionability gate (no predicate)', () => {
		const resp = JSON.stringify([
			{
				lesson: 'A vague lesson with scope but no predicate field here',
				applies_to_agents: ['coder'],
			},
		]);
		expect(parseMicroCandidates(resp, meta)).toHaveLength(0);
	});

	it('drops candidates with no scope tag', () => {
		const resp = JSON.stringify([
			{
				lesson: 'A lesson with a predicate but no scope tag at all here',
				required_actions: ['do x'],
			},
		]);
		expect(parseMicroCandidates(resp, meta)).toHaveLength(0);
	});

	it('caps at 2 candidates even if more are returned', () => {
		const one = {
			applies_to_agents: ['coder'],
			required_actions: ['x'],
		};
		const resp = JSON.stringify([
			{
				lesson: 'First generalizable lesson about testing approach here',
				...one,
			},
			{
				lesson: 'Second generalizable lesson about linting approach now',
				...one,
			},
			{
				lesson: 'Third generalizable lesson that must be dropped by cap',
				...one,
			},
		]);
		expect(parseMicroCandidates(resp, meta)).toHaveLength(2);
	});

	it('tolerates prose around the JSON array', () => {
		const resp =
			'Here are the lessons:\n[{"lesson":"Always rerun the full suite after a hot-path edit here","applies_to_tools":["bash"],"forbidden_actions":["skip the test run"]}]\nThanks.';
		const out = parseMicroCandidates(resp, meta);
		expect(out).toHaveLength(1);
		expect(out[0].applies_to_tools).toEqual(['bash']);
	});

	it('returns [] for an empty array or non-array', () => {
		expect(parseMicroCandidates('[]', meta)).toEqual([]);
		expect(parseMicroCandidates('{"not":"an array"}', meta)).toEqual([]);
		expect(parseMicroCandidates('garbage', meta)).toEqual([]);
	});

	it('rejects lessons outside the 15-280 char range', () => {
		const tooShort = JSON.stringify([
			{
				lesson: 'too short',
				applies_to_agents: ['coder'],
				required_actions: ['x'],
			},
		]);
		expect(parseMicroCandidates(tooShort, meta)).toHaveLength(0);
	});

	it('ignores non-allowlisted fields smuggled by the model (e.g. verification_predicate)', () => {
		// verification_predicate executes subprocesses; it must NOT be accepted
		// from auto-reflection. Without an allowed predicate field the candidate
		// fails actionability and is dropped.
		const resp = JSON.stringify([
			{
				lesson: 'A lesson trying to smuggle a predicate runner directive in',
				applies_to_agents: ['coder'],
				verification_predicate: 'tool:rm -rf /',
			},
		]);
		const out = parseMicroCandidates(resp, meta);
		expect(out).toHaveLength(0);
	});
});
