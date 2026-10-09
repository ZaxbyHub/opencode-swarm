/**
 * isPhaseInWrapWindow: phase N's work is done, the cursor is later in plan
 * order, and every phase in between was closed without work. Shared by the
 * docs-receipt wrap acceptance (phase-participation.ts) and
 * record_directive_override; pinned directly here.
 */
import { describe, expect, test } from 'bun:test';
import {
	getCurrentPhase,
	isPhaseInWrapWindow,
	type Plan,
} from '../../../src/config/plan-schema';

type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'closed';

function phase(
	id: number,
	taskStatuses: TaskStatus[],
	status = 'in_progress',
): Plan['phases'][number] {
	return {
		id,
		name: `Phase ${id}`,
		status,
		tasks: taskStatuses.map((taskStatus, index) => ({
			id: `${id}.${index + 1}`,
			phase: id,
			status: taskStatus,
			size: 'small',
			description: `Task ${id}.${index + 1}`,
			depends: [],
			files_touched: [],
		})),
	} as unknown as Plan['phases'][number];
}

function plan(currentPhase: number, phases: Plan['phases']): Plan {
	return {
		schema_version: '1.0.0',
		title: 'Wrap window',
		swarm: 'test',
		current_phase: currentPhase,
		phases,
	} as Plan;
}

describe('isPhaseInWrapWindow', () => {
	test('a finished phase with the cursor on the next phase is in its window', () => {
		const p = plan(2, [
			phase(1, ['completed', 'closed']),
			phase(2, ['pending']),
		]);
		expect(getCurrentPhase(p)).toBe(2);
		expect(isPhaseInWrapWindow(p, 1)).toBe(true);
	});

	test('a phase with an open task is not', () => {
		const p = plan(2, [
			phase(1, ['completed', 'in_progress']),
			phase(2, ['pending']),
		]);
		expect(isPhaseInWrapWindow(p, 1)).toBe(false);
	});

	test('the cursor phase itself, a later phase, and an unknown phase are not', () => {
		const p = plan(2, [
			phase(1, ['completed']),
			phase(2, ['pending']),
			phase(3, ['pending']),
		]);
		expect(isPhaseInWrapWindow(p, 2)).toBe(false);
		expect(isPhaseInWrapWindow(p, 3)).toBe(false);
		expect(isPhaseInWrapWindow(p, 99)).toBe(false);
	});

	test('phase ids need not be contiguous', () => {
		const p = plan(5, [phase(1, ['completed']), phase(5, ['pending'])]);
		expect(isPhaseInWrapWindow(p, 1)).toBe(true);
	});

	test('the window spans phases closed without work', () => {
		const p = plan(3, [
			phase(1, ['completed']),
			phase(2, ['closed', 'closed']),
			phase(3, ['pending']),
		]);
		expect(getCurrentPhase(p)).toBe(3);
		expect(isPhaseInWrapWindow(p, 1)).toBe(true);
	});

	test('a phase in between with completed work ends the window', () => {
		const p = plan(3, [
			phase(1, ['completed']),
			phase(2, ['completed', 'closed']),
			phase(3, ['pending']),
		]);
		expect(isPhaseInWrapWindow(p, 1)).toBe(false);
		expect(isPhaseInWrapWindow(p, 2)).toBe(true);
	});

	test('a task-less phase in between counts as skipped only with a terminal status', () => {
		const terminal = plan(3, [
			phase(1, ['completed']),
			phase(2, [], 'closed'),
			phase(3, ['pending']),
		]);
		expect(isPhaseInWrapWindow(terminal, 1)).toBe(true);
		const open = plan(3, [
			phase(1, ['completed']),
			phase(2, [], 'pending'),
			phase(3, ['pending']),
		]);
		expect(getCurrentPhase(open)).toBe(3);
		expect(isPhaseInWrapWindow(open, 1)).toBe(false);
	});
});
