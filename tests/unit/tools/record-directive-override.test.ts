import { afterEach, describe, expect, mock, test } from 'bun:test';
import {
	executeRecordDirectiveOverride,
	recordDirectiveOverrideInternals,
} from '../../../src/tools/record-directive-override';

const originalLoadPlan = recordDirectiveOverrideInternals.loadPlan;
const originalRecord =
	recordDirectiveOverrideInternals.recordDirectiveOverrides;

afterEach(() => {
	recordDirectiveOverrideInternals.loadPlan = originalLoadPlan;
	recordDirectiveOverrideInternals.recordDirectiveOverrides = originalRecord;
});

describe('record_directive_override', () => {
	test('fails closed without exact architect session identity', async () => {
		const result = await executeRecordDirectiveOverride(
			{
				directive_ids: ['directive-1'],
				justification: 'supported exception',
				phase: 2,
			},
			'C:\\project',
			{ sessionID: '', agent: 'architect' },
		);
		expect(result.code).toBe('DIRECTIVE_OVERRIDE_SESSION_REQUIRED');
	});

	test('records through the authoritative writer for the current phase', async () => {
		const record = mock(async () => undefined);
		recordDirectiveOverrideInternals.loadPlan = mock(async () => ({
			title: 'Plan',
			current_phase: 2,
			phases: [{ id: 2, name: 'Hardening', status: 'in_progress', tasks: [] }],
		})) as typeof originalLoadPlan;
		recordDirectiveOverrideInternals.recordDirectiveOverrides =
			record as typeof originalRecord;

		const result = await executeRecordDirectiveOverride(
			{
				directive_ids: ['trace-1/directive-1', 'trace-1/directive-1'],
				justification:
					'The identified exception is supported by review evidence.',
				phase: 2,
			},
			'C:\\project',
			{ sessionID: 'session-1', agent: 'mega_architect' },
		);

		expect(result.code).toBe('DIRECTIVE_OVERRIDE_RECORDED');
		expect(record).toHaveBeenCalledTimes(1);
		expect(record.mock.calls[0]?.[1]).toEqual(['trace-1/directive-1']);
		expect(record.mock.calls[0]?.[3]).toBe('session-1');
		expect(record.mock.calls[0]?.[4]).toContain('Phase 2');
	});
});
