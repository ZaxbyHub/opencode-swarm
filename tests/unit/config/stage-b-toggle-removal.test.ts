/**
 * Unit tests for legacy Stage B toggle removal and standard barrier semantics.
 *
 * The old nested `parallelization.stageB.parallel.enabled` shape is not part of
 * the schema. Current runtime behavior is controlled by the top-level standard
 * `parallelization` block and by the explicit Stage B barrier flag passed to
 * checkReviewerGate.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { ParallelizationConfigSchema } from '../../../src/config/schema';
import {
	advanceTaskState,
	getTaskState,
	hasBothStageBCompletions,
	recordStageBCompletion,
	resetSwarmState,
	startAgentSession,
	swarmState,
} from '../../../src/state';
import {
	checkReviewerGate,
	checkReviewerGateWithScope,
} from '../../../src/tools/update-task-status';

function makeSession() {
	const id = `stage-b-removal-${Math.random().toString(36).slice(2)}`;
	startAgentSession(id, 'architect');
	return swarmState.agentSessions.get(id)!;
}

beforeEach(() => {
	resetSwarmState();
});

afterEach(() => {
	resetSwarmState();
});

describe('ParallelizationConfigSchema - legacy stageB field removal', () => {
	test('stageB is not a valid field - parse strips it silently', () => {
		const result = ParallelizationConfigSchema.parse({
			enabled: true,
			maxConcurrentTasks: 4,
			stageB: { parallel: { enabled: true } },
		});
		expect('stageB' in result).toBe(false);
	});

	test('stageB is not a valid field - safeParse also strips it', () => {
		const result = ParallelizationConfigSchema.safeParse({
			enabled: false,
			max_coders: 5,
			max_reviewers: 4,
			stageB: { parallel: { enabled: false } },
		});
		expect(result.success).toBe(true);
		if (result.success) expect('stageB' in result.data).toBe(false);
	});

	test('valid config without stageB parses correctly', () => {
		const result = ParallelizationConfigSchema.parse({
			enabled: true,
			maxConcurrentTasks: 4,
			max_coders: 5,
			max_reviewers: 4,
		});
		expect(result.enabled).toBe(true);
		expect(result.maxConcurrentTasks).toBe(4);
		expect(result.max_coders).toBe(5);
		expect(result.max_reviewers).toBe(4);
	});

	test('schema accepts empty object with defaults', () => {
		const result = ParallelizationConfigSchema.parse({});
		expect(result.enabled).toBe(false);
		expect(result.maxConcurrentTasks).toBe(1);
		expect(result.evidenceLockTimeoutMs).toBe(60000);
		expect(result.max_coders).toBe(3);
		expect(result.max_reviewers).toBe(2);
	});
});

describe('Stage B completion barrier - order-independent markers', () => {
	test('barrier is order-independent when the parallel barrier flag is enabled', () => {
		const session = makeSession();
		advanceTaskState(session, '1.1', 'coder_delegated');

		recordStageBCompletion(session, '1.1', 'test_engineer');
		expect(hasBothStageBCompletions(session, '1.1')).toBe(false);

		recordStageBCompletion(session, '1.1', 'reviewer');
		expect(hasBothStageBCompletions(session, '1.1')).toBe(true);
	});

	test('barrier blocks when only one Stage B agent has completed', () => {
		const session = makeSession();
		advanceTaskState(session, '1.1', 'coder_delegated');
		recordStageBCompletion(session, '1.1', 'reviewer');
		expect(hasBothStageBCompletions(session, '1.1')).toBe(false);

		const session2 = makeSession();
		advanceTaskState(session2, '1.2', 'coder_delegated');
		recordStageBCompletion(session2, '1.2', 'test_engineer');
		expect(hasBothStageBCompletions(session2, '1.2')).toBe(false);
	});

	test('recordStageBCompletion is idempotent', () => {
		const session = makeSession();
		advanceTaskState(session, '1.1', 'coder_delegated');

		recordStageBCompletion(session, '1.1', 'reviewer');
		recordStageBCompletion(session, '1.1', 'reviewer');
		recordStageBCompletion(session, '1.1', 'test_engineer');

		expect(hasBothStageBCompletions(session, '1.1')).toBe(true);
	});

	test('session taskWorkflowStates still tracks sequential state', () => {
		const session = makeSession();
		advanceTaskState(session, '1.1', 'coder_delegated');
		expect(getTaskState(session, '1.1')).toBe('coder_delegated');

		advanceTaskState(session, '1.1', 'reviewer_run');
		expect(getTaskState(session, '1.1')).toBe('reviewer_run');

		advanceTaskState(session, '1.1', 'tests_run');
		expect(getTaskState(session, '1.1')).toBe('tests_run');
	});
});

describe('update-task-status.ts - explicit Stage B barrier flag', () => {
	test('checkReviewerGate - flag ON: both completions are allowed', () => {
		const session = makeSession();
		advanceTaskState(session, '1.1', 'coder_delegated');
		recordStageBCompletion(session, '1.1', 'reviewer');
		recordStageBCompletion(session, '1.1', 'test_engineer');

		const result = checkReviewerGate('1.1', undefined, true);
		expect(result.blocked).toBe(false);
	});

	test('checkReviewerGate - flag OFF: tests_run state is allowed', () => {
		const session = makeSession();
		advanceTaskState(session, '1.1', 'coder_delegated');
		advanceTaskState(session, '1.1', 'pre_check_passed');
		advanceTaskState(session, '1.1', 'reviewer_run');
		advanceTaskState(session, '1.1', 'tests_run');

		const result = checkReviewerGate('1.1', undefined, false);
		expect(result.blocked).toBe(false);
	});

	test('checkReviewerGate - no sessions returns allowed for test context', () => {
		const result = checkReviewerGate('9.99', undefined, false);
		expect(result.blocked).toBe(false);
	});

	test('checkReviewerGateWithScope returns a gate result', async () => {
		const session = makeSession();
		advanceTaskState(session, '1.1', 'coder_delegated');
		recordStageBCompletion(session, '1.1', 'reviewer');
		recordStageBCompletion(session, '1.1', 'test_engineer');

		const result = await checkReviewerGateWithScope('1.1', undefined);
		expect(result).toBeDefined();
		expect(typeof result.blocked).toBe('boolean');
	});
});
