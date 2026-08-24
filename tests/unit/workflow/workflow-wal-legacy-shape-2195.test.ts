import { describe, expect, test } from 'bun:test';
import {
	parseCoderSettlementWal,
	parseTaskRepairWal,
	parseTaskTerminalWal,
} from '../../../src/workflow/workflow-wal-schema';

/**
 * WAL files written by the pre-PR (#2195) writers, byte-shaped exactly as they
 * land on disk today. The stricter parsers introduced by that PR must keep
 * reading them, otherwise an upgrade strands in-flight transitions.
 */
const LEGACY_REPAIR_WAL = {
	version: 1,
	state: 'COMMITTED',
	taskId: '1.1',
	transitionId: 'repair-legacy',
	reason: 'stale completion',
	actor: 'architect',
	oldPlanStatus: 'completed',
	newPlanStatus: 'in_progress',
	oldWorkflowState: 'complete',
	newWorkflowState: 'idle',
	oldGeneration: 2,
	generation: 3,
	recordedAt: '2026-01-01T00:00:00.000Z',
};

const LEGACY_TERMINAL_WAL_V1 = {
	version: 1,
	state: 'COMMITTED',
	taskId: '1.1',
	transitionId: 'term-legacy',
	actor: 'architect',
	oldPlanStatus: 'in_progress',
	newPlanStatus: 'completed',
	oldWorkflowState: 'tests_run',
	newWorkflowState: 'complete',
	generation: 4,
	qaExempt: false,
	recordedAt: '2026-01-01T00:00:00.000Z',
};

const REPAIR_PATH = '/tmp/task-repairs/1.1.json';
const TERMINAL_PATH = '/tmp/task-terminals/1.1.json';
const SETTLEMENT_PATH = '/tmp/coder-settlements/1.1.json';

describe('WAL schema forward compatibility with pre-PR files', () => {
	test('a pre-PR repair WAL still round-trips through the stricter parser', () => {
		const wal = parseTaskRepairWal(
			JSON.stringify(LEGACY_REPAIR_WAL),
			REPAIR_PATH,
			'1.1',
		);

		expect(wal.version).toBe(1);
		expect(wal.state).toBe('COMMITTED');
		expect(wal.taskId).toBe('1.1');
		expect(wal.transitionId).toBe('repair-legacy');
		expect(wal.oldWorkflowState).toBe('complete');
		expect(wal.newWorkflowState).toBe('idle');
		expect(wal.oldGeneration).toBe(2);
		expect(wal.generation).toBe(3);
	});

	test('a pre-PR v1 terminal WAL still round-trips through the stricter parser', () => {
		const wal = parseTaskTerminalWal(
			JSON.stringify(LEGACY_TERMINAL_WAL_V1),
			TERMINAL_PATH,
			'1.1',
		);

		expect(wal.version).toBe(1);
		expect(wal.state).toBe('COMMITTED');
		expect(wal.taskId).toBe('1.1');
		expect(wal.transitionId).toBe('term-legacy');
		expect(wal.newPlanStatus).toBe('completed');
		expect(wal.newWorkflowState).toBe('complete');
		expect(wal.generation).toBe(4);
		expect(wal.qaExempt).toBe(false);
	});
});

// `JSON.parse("null")` succeeds, so before the shared object guard the first
// property access threw a raw TypeError instead of the intended diagnostic.
// The other literals already boxed into objects; they are pinned here so the
// whole non-object class stays covered.
describe('WAL schema rejects non-object JSON with a diagnostic error', () => {
	const parsers = [
		{
			name: 'parseCoderSettlementWal',
			parse: (raw: string) =>
				parseCoderSettlementWal(raw, SETTLEMENT_PATH, '1.1'),
			code: 'CODER_SETTLEMENT_WAL_UNREADABLE',
			filePath: SETTLEMENT_PATH,
		},
		{
			name: 'parseTaskRepairWal',
			parse: (raw: string) => parseTaskRepairWal(raw, REPAIR_PATH, '1.1'),
			code: 'TASK_REPAIR_WAL_UNREADABLE',
			filePath: REPAIR_PATH,
		},
		{
			name: 'parseTaskTerminalWal',
			parse: (raw: string) => parseTaskTerminalWal(raw, TERMINAL_PATH, '1.1'),
			code: 'TASK_TERMINAL_WAL_UNREADABLE',
			filePath: TERMINAL_PATH,
		},
	];

	for (const parser of parsers) {
		for (const raw of ['null', '[]', '42', '"str"', 'true']) {
			test(`${parser.name} rejects ${raw} with ${parser.code}`, () => {
				const error = (() => {
					try {
						parser.parse(raw);
						return null;
					} catch (caught) {
						return caught as Error;
					}
				})();

				expect(error).not.toBeNull();
				expect(error).toBeInstanceOf(Error);
				expect(error?.message).toContain(parser.code);
				expect(error?.message).toContain(parser.filePath);
			});
		}
	}
});
