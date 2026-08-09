import { describe, expect, test } from 'bun:test';
import type { BackgroundDelegationRecord } from '../../../src/background/pending-delegations.js';
import { _test_exports } from '../../../src/hooks/pr-workflow-gate.js';

const LANE = 'correctness-state';

function record(
	overrides: Partial<BackgroundDelegationRecord> = {},
): BackgroundDelegationRecord {
	return {
		schemaVersion: 3,
		correlationId: 'child-1',
		jobId: null,
		subagentSessionId: 'child-1',
		parentSessionId: 'parent-1',
		callID: 'call-1',
		normalizedAgent: 'explorer',
		swarmPrefixedAgent: 'explorer',
		planTaskId: null,
		evidenceTaskId: null,
		status: 'completed',
		createdAt: 2_000,
		updatedAt: 2_000,
		batchId: 'batch-1',
		laneId: 'lane-1',
		mode: 'swarm-pr-review:base',
		workflowLane: LANE,
		workspace: {
			directory: '/project',
			gitHead: 'head-1',
			dirtyHash: null,
			prHeadSha: 'head-1',
			scope: null,
		},
		result: {
			chars: 1,
			truncated: false,
			digest: 'a'.repeat(64),
			outputRef: `L1:${'b'.repeat(64)}:${'c'.repeat(64)}:${'d'.repeat(64)}`,
		},
		...overrides,
	};
}

function analyze(args: {
	expectedLanes?: Array<{ laneId: string; workflowLane: string }>;
	records?: BackgroundDelegationRecord[];
	validatedAt?: string;
	forbidden?: ReadonlySet<string>;
}) {
	return _test_exports.analyzePrReviewBatchRecordIntegrity({
		batchId: 'batch-1',
		expectedLanes: args.expectedLanes ?? [
			{ laneId: 'lane-1', workflowLane: LANE },
		],
		expectedMode: 'swarm-pr-review:base',
		validatedAt: args.validatedAt ?? new Date(1_000).toISOString(),
		checkWorkflowLane: true,
		forbiddenSubagentSessionIds: args.forbidden ?? new Set(),
		records: args.records ?? [record()],
	});
}

describe('PR review batch record validation predicates', () => {
	test('accepts one exact record for the expected lane', () => {
		expect(analyze({})).toMatchObject([{ ok: true }]);
	});

	test.each([
		['batch.validated_at', () => analyze({ validatedAt: 'not-a-date' })],
		[
			'batch.expected_lane_unique',
			() =>
				analyze({
					expectedLanes: [
						{ laneId: 'lane-1', workflowLane: LANE },
						{ laneId: 'lane-1', workflowLane: 'intent-architecture' },
					],
				}),
		],
		['record.missing', () => analyze({ records: [] })],
		[
			'record.duplicate_lane',
			() =>
				analyze({
					records: [
						record(),
						record({ correlationId: 'child-2', subagentSessionId: 'child-2' }),
					],
				}),
		],
		[
			'record.subagent_session_id',
			() => analyze({ records: [record({ subagentSessionId: ' ' })] }),
		],
		[
			'record.duplicate_subagent_session_id',
			() =>
				analyze({
					expectedLanes: [
						{ laneId: 'lane-1', workflowLane: LANE },
						{ laneId: 'lane-2', workflowLane: 'intent-architecture' },
					],
					records: [
						record(),
						record({
							correlationId: 'child-2',
							laneId: 'lane-2',
							workflowLane: 'intent-architecture',
						}),
					],
				}),
		],
		[
			'record.forbidden_subagent_session_id',
			() => analyze({ forbidden: new Set(['child-1']) }),
		],
		[
			'record.created_at',
			() => analyze({ records: [record({ createdAt: 999 })] }),
		],
		[
			'record.status',
			() => analyze({ records: [record({ status: 'running' })] }),
		],
	] as const)('reports first failure %s', (predicate, run) => {
		const results = run();
		expect(results[0]?.ok).toBe(false);
		if (!results[0]?.ok) expect(results[0]?.failure.predicate).toBe(predicate);
	});

	test('reports batch duplicate-lane failure before lane-local mode failure', () => {
		const results = analyze({
			records: [
				record({ mode: 'wrong' }),
				record({ correlationId: 'child-2', subagentSessionId: 'child-2' }),
			],
		});
		expect(results[0]?.ok).toBe(false);
		if (!results[0]?.ok) {
			expect(results[0]?.failure.predicate).toBe('record.duplicate_lane');
		}
	});
});
