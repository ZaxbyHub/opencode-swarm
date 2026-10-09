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

	describe('at PHASE-WRAP, after the last task advanced the cursor (#2532)', () => {
		function plan(phase2: 'completed' | 'pending', phase3Tasks: string[]) {
			const task = (id: string, status: string) => ({
				id,
				phase: Number(id.split('.')[0]),
				status,
				size: 'small',
				description: id,
				depends: [],
				files_touched: [],
			});
			return {
				title: 'Plan',
				current_phase: 4,
				phases: [
					{
						id: 1,
						name: 'Build',
						status: 'in_progress',
						tasks: [task('1.1', 'completed')],
					},
					{
						id: 2,
						name: 'Hardening',
						status: 'pending',
						tasks: [task('2.1', phase2)],
					},
					{
						id: 4,
						name: 'Release',
						status: 'pending',
						tasks: phase3Tasks.map((id) => task(id, 'pending')),
					},
				],
			};
		}
		async function override(phase: number, loaded: unknown) {
			const record = mock(async () => undefined);
			recordDirectiveOverrideInternals.loadPlan = mock(
				async () => loaded,
			) as unknown as typeof originalLoadPlan;
			recordDirectiveOverrideInternals.recordDirectiveOverrides =
				record as typeof originalRecord;
			const result = await executeRecordDirectiveOverride(
				{
					directive_ids: ['d-1'],
					justification: 'supported by review evidence',
					phase,
				},
				'/project',
				{ sessionID: 'session-1', agent: 'architect' },
			);
			return { result, record };
		}

		test('the phase being wrapped is accepted and recorded under its own label', async () => {
			const { result, record } = await override(2, plan('completed', ['4.1']));
			expect(result.code).toBe('DIRECTIVE_OVERRIDE_RECORDED');
			expect(record.mock.calls[0]?.[4]).toContain('Phase 2: Hardening');
			expect(record.mock.calls[0]?.[5]).toBe(2);
		});

		test('an earlier phase is accepted only when the phases between were skipped', async () => {
			// Phase 2's work merely finished: it has its own wrap, so phase 1's
			// window is over.
			const finished = await override(1, plan('completed', ['4.1']));
			expect(finished.result.code).toBe('DIRECTIVE_OVERRIDE_PHASE_MISMATCH');
			const skipped = plan('completed', ['4.1']);
			skipped.phases[1].tasks[0].status = 'closed';
			const { result } = await override(1, skipped);
			expect(result.code).toBe('DIRECTIVE_OVERRIDE_RECORDED');
		});

		test('a phase is refused when unfinished work sits between it and the cursor', async () => {
			// Phase 2 is unfinished while the stored cursor is phase 4: phase 1 is
			// not in a wrap window, but the cursor phase itself is accepted.
			const { result, record } = await override(1, plan('pending', ['4.1']));
			expect(result.code).toBe('DIRECTIVE_OVERRIDE_PHASE_MISMATCH');
			expect(record).not.toHaveBeenCalled();
			const cursor = await override(4, plan('pending', ['4.1']));
			expect(cursor.result.code).toBe('DIRECTIVE_OVERRIDE_RECORDED');
		});
	});
});
