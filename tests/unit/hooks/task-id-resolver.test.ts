import { describe, expect, test } from 'bun:test';
import {
	resolveTaskId,
	TASK_ID_RESOLUTION_LIMITS,
} from '../../../src/hooks/task-id-resolver.js';

const known = new Set(['1.1', '1.2', '2.1']);

describe('bounded shared task-ID resolver', () => {
	test('uses conflict-checked explicit plan IDs before prompt candidates', () => {
		expect(
			resolveTaskId(
				{ task_id: '1.1', prompt: 'TASK: 1.2' },
				{ policy: 'plan', knownPlanTaskIds: known },
			),
		).toEqual({ status: 'resolved', taskId: '1.1', source: 'explicit' });
		expect(
			resolveTaskId(
				{ task_id: '1.1', taskId: '1.2' },
				{ policy: 'plan', knownPlanTaskIds: known },
			),
		).toEqual({ status: 'ambiguous', candidates: ['1.1', '1.2'] });
		expect(
			resolveTaskId(
				{ task_id: '9.9' },
				{ policy: 'plan', knownPlanTaskIds: known },
			),
		).toEqual({ status: 'invalid', input: 'task_id' });
		expect(
			resolveTaskId(
				{ task_id: '9.9', prompt: 'TASK: 1.1' },
				{ policy: 'plan', knownPlanTaskIds: known },
			),
		).toEqual({ status: 'invalid', input: 'task_id' });
	});

	test('prefers a unique known TASK-line ID and rejects ambiguity', () => {
		expect(
			resolveTaskId(
				{ prompt: 'Version 2.1\nTASK: 1.2 — implement' },
				{ policy: 'plan', knownPlanTaskIds: known },
			),
		).toEqual({ status: 'resolved', taskId: '1.2', source: 'task_line' });
		expect(
			resolveTaskId(
				{ prompt: 'TASK: port 1.1 to 1.2' },
				{ policy: 'plan', knownPlanTaskIds: known },
			),
		).toEqual({ status: 'ambiguous', candidates: ['1.1', '1.2'] });
	});

	test('filters unknown numeric markers when plan context exists', () => {
		expect(
			resolveTaskId(
				{ prompt: 'TASK: 9.9' },
				{ policy: 'attribution', knownPlanTaskIds: known },
			),
		).toEqual({ status: 'invalid', input: 'marker' });
		expect(
			resolveTaskId({ prompt: 'TASK: 9.9' }, { policy: 'attribution' }),
		).toEqual({ status: 'resolved', taskId: '9.9', source: 'marker' });
		expect(
			resolveTaskId(
				{ task_id: '9.9', prompt: 'TASK: 1.1' },
				{ policy: 'attribution', knownPlanTaskIds: known },
			),
		).toEqual({ status: 'invalid', input: 'task_id' });
	});

	test('uses only caller-proven unique attribution fallbacks', () => {
		expect(
			resolveTaskId(
				{},
				{
					policy: 'attribution',
					fallback: 'task-a',
					fallbackProvenUnique: true,
				},
			),
		).toEqual({ status: 'resolved', taskId: 'task-a', source: 'fallback' });
		expect(
			resolveTaskId(
				{ prompt: 'TASK: 9.9' },
				{
					policy: 'attribution',
					knownPlanTaskIds: known,
					fallback: '1.1',
					fallbackProvenUnique: true,
				},
			),
		).toEqual({ status: 'invalid', input: 'marker' });
		expect(
			resolveTaskId(
				{ prompt: 'TASK: !!!' },
				{
					policy: 'attribution',
					fallback: 'task-a',
					fallbackProvenUnique: true,
				},
			),
		).toEqual({ status: 'invalid', input: 'marker' });
	});

	test('preserves legacy named IDs and rejects child-session handles', () => {
		expect(
			resolveTaskId({ prompt: 'task_id: t-7' }, { policy: 'attribution' }),
		).toEqual({ status: 'resolved', taskId: 't-7', source: 'marker' });
		expect(
			resolveTaskId(
				{ task_id: 'ses_child', prompt: 'unmarked 1.2 and port 3000' },
				{ policy: 'attribution' },
			),
		).toEqual({ status: 'missing' });
		expect(
			resolveTaskId(
				{ prompt: 'TASK_ID: task-42\nTASK: implement the hot loop' },
				{ policy: 'attribution' },
			),
		).toEqual({ status: 'resolved', taskId: 'task-42', source: 'marker' });
	});

	test('fails closed for marker conflicts and unsafe fallback', () => {
		expect(
			resolveTaskId(
				{ prompt: 'task_id: 1.1\ntaskId: 1.2' },
				{ policy: 'attribution', knownPlanTaskIds: known },
			),
		).toEqual({ status: 'ambiguous', candidates: ['1.1', '1.2'] });
		expect(
			resolveTaskId(
				{ prompt: 'task_id: 1.1\nTASK: 1.2' },
				{ policy: 'attribution', knownPlanTaskIds: known },
			),
		).toEqual({ status: 'ambiguous', candidates: ['1.1', '1.2'] });
		expect(
			resolveTaskId(
				{},
				{
					policy: 'plan',
					knownPlanTaskIds: known,
					fallback: '1.1',
					fallbackProvenUnique: false,
				},
			),
		).toEqual({ status: 'invalid', input: 'fallback' });
		expect(
			resolveTaskId(
				{},
				{
					policy: 'plan',
					knownPlanTaskIds: known,
					fallback: '1.1',
					fallbackProvenUnique: true,
				},
			),
		).toEqual({ status: 'resolved', taskId: '1.1', source: 'fallback' });
	});

	test('returns over_limit without using fallback', () => {
		const result = resolveTaskId(
			{
				prompt: `TASK: 1.1${'x'.repeat(TASK_ID_RESOLUTION_LIMITS.maxFieldChars)}`,
			},
			{
				policy: 'plan',
				knownPlanTaskIds: known,
				fallback: '1.2',
				fallbackProvenUnique: true,
			},
		);
		expect(result).toEqual({ status: 'over_limit', input: 'prompt' });
	});

	test('bounds known IDs and marker tokens', () => {
		const tooManyKnown = new Set(
			Array.from(
				{ length: TASK_ID_RESOLUTION_LIMITS.maxKnownIds + 1 },
				(_, index) => `1.${index + 1}`,
			),
		);
		expect(
			resolveTaskId({}, { policy: 'plan', knownPlanTaskIds: tooManyKnown }),
		).toEqual({ status: 'over_limit', input: 'knownPlanTaskIds' });
		expect(
			resolveTaskId(
				{ prompt: `task_id: ${'a'.repeat(81)}` },
				{ policy: 'attribution' },
			),
		).toEqual({ status: 'over_limit', input: 'markerToken' });
		expect(
			resolveTaskId(
				{ prompt: 'TASK: 1.1' },
				{ policy: 'attribution', planContextOverLimit: true },
			),
		).toEqual({ status: 'invalid', input: 'marker' });
		expect(
			resolveTaskId(
				{ prompt: 'TASK: legacy-task' },
				{ policy: 'attribution', planContextOverLimit: true },
			),
		).toEqual({ status: 'resolved', taskId: 'legacy-task', source: 'marker' });
	});
});
