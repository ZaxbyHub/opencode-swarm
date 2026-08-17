import { describe, expect, test } from 'bun:test';
import {
	parseCoderSettlementWal,
	parseTaskRepairWal,
} from '../../../src/workflow/workflow-wal-schema';

const HEX40 = 'a'.repeat(40);
const HEX64 = 'b'.repeat(64);
const WAL_PATH = '/tmp/coder-settlements/1.1.json';

/**
 * Minimal coder-settlement WAL that parses cleanly, so each test below can vary
 * exactly one field and attribute the rejection to that field alone.
 */
function baseWal(
	overrides: {
		worktreePath?: string;
		sourceHead?: string;
		targetHeadBefore?: string;
	} = {},
): string {
	const {
		worktreePath = '/tmp/wt/lane-0',
		sourceHead = HEX40,
		targetHeadBefore = HEX40,
	} = overrides;
	return JSON.stringify({
		version: 1,
		state: 'PREPARED',
		taskId: '1.1',
		transitionId: 'tr-1',
		actor: 'coder',
		processId: 1234,
		runtimeId: 'runtime-1',
		expectedGeneration: 0,
		accepted: true,
		recordedAt: '2026-08-16T00:00:00.000Z',
		context: {
			declaredFiles: [],
			baseline: {
				directory: '/tmp/project',
				gitHead: null,
				dirtyHash: null,
				prHeadSha: null,
				scope: null,
				changedFiles: [],
			},
		},
		worktree: {
			callID: 'call-1',
			parentSessionId: 'session-1',
			taskId: '1.1',
			worktreePath,
			branchName: 'swarm/lane-0',
			worktreeId: 'wt-1',
			worktreeSessionId: 'wt-session-1',
			mergeStrategy: 'merge',
			laneIndex: 0,
		},
		mergeProvenance: {
			operationId: 'tr-1',
			sourceHead,
			targetHeadBefore,
			branchName: 'swarm/lane-0',
			strategy: 'merge',
		},
	});
}

describe('coder-settlement WAL worktree and provenance bounds', () => {
	test('baseline fixture parses, so single-field variations are attributable', () => {
		const wal = parseCoderSettlementWal(baseWal(), WAL_PATH, '1.1');
		expect(wal.taskId).toBe('1.1');
	});

	// F-010: worktreePath is bounded for parity with the other path fields.
	test('accepts a worktreePath at the 4096 bound', () => {
		const wal = parseCoderSettlementWal(
			baseWal({ worktreePath: `/${'w'.repeat(4095)}` }),
			WAL_PATH,
			'1.1',
		);
		expect(wal.worktree?.worktreePath).toHaveLength(4096);
	});

	test('rejects a worktreePath one byte over the bound', () => {
		expect(() =>
			parseCoderSettlementWal(
				baseWal({ worktreePath: `/${'w'.repeat(4096)}` }),
				WAL_PATH,
				'1.1',
			),
		).toThrow(/CODER_SETTLEMENT_WAL_UNREADABLE/);
	});

	// The task-id mismatch errors are raised by the parsers, which own them for all
	// three WAL kinds (the redundant caller-side checks were removed). They must name
	// the file and a remediation like every other message in this module, since an
	// operator hitting one has only the thrown string to work from.
	test('CODER_SETTLEMENT_WAL_TASK_MISMATCH names the file, both task ids and a remediation', () => {
		const error = (() => {
			try {
				parseCoderSettlementWal(baseWal(), WAL_PATH, '9.9');
				return null;
			} catch (caught) {
				return caught as Error;
			}
		})();

		expect(error?.message).toContain('CODER_SETTLEMENT_WAL_TASK_MISMATCH');
		expect(error?.message).toContain(WAL_PATH);
		expect(error?.message).toContain('records task 1.1');
		expect(error?.message).toContain('read for task 9.9');
		expect(error?.message).toContain('reconcile the task lane');
	});

	test('TASK_REPAIR_WAL_TASK_MISMATCH names the file, both task ids and a remediation', () => {
		const repairWal = JSON.stringify({
			version: 1,
			state: 'PREPARED',
			taskId: '1.1',
			transitionId: 'repair-1',
			reason: 'reopen for rework',
			actor: 'architect',
			oldPlanStatus: 'completed',
			newPlanStatus: 'in_progress',
			oldWorkflowState: 'complete',
			newWorkflowState: 'idle',
			oldGeneration: 0,
			generation: 1,
			recordedAt: '2026-08-16T00:00:00.000Z',
		});

		const error = (() => {
			try {
				parseTaskRepairWal(repairWal, '/tmp/task-repairs/1.1.json', '9.9');
				return null;
			} catch (caught) {
				return caught as Error;
			}
		})();

		expect(error?.message).toContain('TASK_REPAIR_WAL_TASK_MISMATCH');
		expect(error?.message).toContain('/tmp/task-repairs/1.1.json');
		expect(error?.message).toContain('records task 1.1');
		expect(error?.message).toContain('read for task 9.9');
		expect(error?.message).toContain('reconcile the repair transition');
	});

	// F-011: merge provenance must be a full git object id. A leading `-` is the
	// case that matters most — those values are passed to git as revisions.
	for (const field of ['sourceHead', 'targetHeadBefore'] as const) {
		test(`accepts a 40-hex ${field}`, () => {
			const wal = parseCoderSettlementWal(
				baseWal({ [field]: HEX40 }),
				WAL_PATH,
				'1.1',
			);
			expect(wal.mergeProvenance?.[field]).toBe(HEX40);
		});

		test(`accepts a 64-hex ${field}`, () => {
			const wal = parseCoderSettlementWal(
				baseWal({ [field]: HEX64 }),
				WAL_PATH,
				'1.1',
			);
			expect(wal.mergeProvenance?.[field]).toBe(HEX64);
		});

		for (const [label, value] of [
			['empty', ''],
			['leading dash', `-${'a'.repeat(39)}`],
			['abbreviated', 'a'.repeat(7)],
			['over-long', 'a'.repeat(41)],
			['uppercase', 'A'.repeat(40)],
			['non-hex', 'g'.repeat(40)],
			['leading space', ` ${'a'.repeat(40)}`],
			['trailing newline', `${'a'.repeat(40)}\n`],
		] as const) {
			test(`rejects a ${label} ${field}`, () => {
				expect(() =>
					parseCoderSettlementWal(baseWal({ [field]: value }), WAL_PATH, '1.1'),
				).toThrow(/CODER_SETTLEMENT_WAL_UNREADABLE/);
			});
		}
	}
});
