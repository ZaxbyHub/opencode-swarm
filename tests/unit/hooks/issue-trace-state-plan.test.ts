import { afterEach, describe, expect, mock, test } from 'bun:test';
import type { Plan } from '../../../src/config/plan-schema';
import {
	_internals,
	loadPlanFromLedger,
	planExists,
	readPlanPhaseStatus,
	specExists,
} from '../../../src/hooks/issue-trace-state';

const realExistsSync = _internals.existsSync;
const realLoadPlanFromLedger = _internals.loadPlanFromLedger;

afterEach(() => {
	_internals.existsSync = realExistsSync;
	_internals.loadPlanFromLedger = realLoadPlanFromLedger;
});

describe('readPlanPhaseStatus', () => {
	test('returns allComplete false when plan is null (no plan file)', async () => {
		const result = await readPlanPhaseStatus('/nonexistent');
		expect(result).toEqual({ planExists: false, allComplete: false });
	});

	test('returns allComplete false for nonexistent directory', async () => {
		const result = await readPlanPhaseStatus('/nonexistent-dir');
		expect(result.allComplete).toBe(false);
	});

	test('returns allComplete false when plan has empty phases array', async () => {
		_internals.loadPlanFromLedger = mock(async () => ({ phases: [] }) as Plan);

		const result = await readPlanPhaseStatus('/project');
		expect(result).toEqual({ planExists: false, allComplete: false });
	});

	test('returns allComplete true when all phases are complete', async () => {
		_internals.loadPlanFromLedger = mock(
			async () =>
				({
					phases: [{ status: 'complete' }, { status: 'completed' }],
				}) as Plan,
		);

		const result = await readPlanPhaseStatus('/project');
		expect(result).toEqual({ planExists: true, allComplete: true });
	});

	test('returns allComplete false when some phases are incomplete', async () => {
		_internals.loadPlanFromLedger = mock(
			async () =>
				({
					phases: [{ status: 'complete' }, { status: 'in_progress' }],
				}) as Plan,
		);

		const result = await readPlanPhaseStatus('/project');
		expect(result).toEqual({ planExists: true, allComplete: false });
	});
});

describe('loadPlanFromLedger', () => {
	test('returns null for nonexistent directory (plan.json absent)', async () => {
		const result = await loadPlanFromLedger('/nonexistent-dir');
		expect(result).toBeNull();
	});
});

describe('specExists', () => {
	test('returns true when spec.md exists', () => {
		_internals.existsSync = mock((p: string) => p.endsWith('spec.md'));
		expect(specExists('/project')).toBe(true);
	});

	test('returns false when spec.md does not exist', () => {
		_internals.existsSync = mock(() => false);
		expect(specExists('/project')).toBe(false);
	});
});

describe('planExists', () => {
	test('returns true when the authoritative plan has phases', async () => {
		_internals.loadPlanFromLedger = mock(
			async () => ({ phases: [{ status: 'pending' }] }) as Plan,
		);
		expect(await planExists('/project')).toBe(true);
	});

	test('returns false when the authoritative plan is absent', async () => {
		_internals.loadPlanFromLedger = mock(async () => null);
		expect(await planExists('/project')).toBe(false);
	});
});
