import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	appendCoreEventSync,
	hasTaskRepairAuditEvent,
} from '../../../src/events/core-events';
import {
	getTaskWorkflowSnapshot,
	readTaskEvidence,
} from '../../../src/gate-evidence';
import { loadPlanJsonOnly } from '../../../src/plan/manager';
import { repairTaskWorkflowUnderPlanLock } from '../../../src/workflow/task-repair';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

const TASK_ID = '1.1';
const FIXED_TS = '2026-01-01T00:00:00.000Z';

interface WedgeFixture {
	generation?: number;
	retryEpoch?: number;
	retryCount?: number;
	escalationActions?: readonly string[];
	escalationEpoch?: number;
	settlementWal?: 'none' | 'prepared' | 'committed-not-accepted';
	corruptAuthorityIndex?: boolean;
}

function writeSettlementWal(
	directory: string,
	state: 'PREPARED' | 'COMMITTED',
): void {
	const walPath = path.join(
		directory,
		'.swarm',
		'coder-settlements',
		`${TASK_ID}.json`,
	);
	fs.mkdirSync(path.dirname(walPath), { recursive: true });
	fs.writeFileSync(
		walPath,
		JSON.stringify({
			version: 1,
			state,
			taskId: TASK_ID,
			transitionId: `coder:test-${TASK_ID}`,
			actor: 'test',
			processId: process.pid,
			runtimeId: '00000000-0000-4000-8000-000000000000',
			expectedGeneration: 2,
			context: {
				baseline: {
					directory,
					gitHead: null,
					dirtyHash: null,
					prHeadSha: null,
					scope: null,
					changedFiles: [],
				},
				declaredFiles: ['src/feature.ts'],
			},
			accepted: false,
			recordedAt: FIXED_TS,
		}),
	);
}

function seedWedge(directory: string, fixture: WedgeFixture = {}): void {
	const generation = fixture.generation ?? 2;
	const retryEpoch = fixture.retryEpoch ?? 1;
	const retryCount = fixture.retryCount ?? 3;
	const swarmDir = path.join(directory, '.swarm');
	fs.mkdirSync(path.join(swarmDir, 'evidence'), { recursive: true });
	fs.writeFileSync(
		path.join(swarmDir, 'plan.json'),
		JSON.stringify({
			schema_version: '1.0.0',
			title: 'Issue 3389 wedge fixture',
			swarm: 'test-swarm',
			current_phase: 1,
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					status: 'in_progress',
					tasks: [
						{
							id: TASK_ID,
							phase: 1,
							status: 'in_progress',
							size: 'small',
							description: 'Wedged exact task',
							depends: [],
							files_touched: ['src/feature.ts'],
						},
					],
				},
			],
		}),
	);
	fs.writeFileSync(
		path.join(swarmDir, 'evidence', `${TASK_ID}.json`),
		JSON.stringify({
			taskId: TASK_ID,
			required_gates: ['reviewer', 'test_engineer'],
			gates: {
				critic_sounding_board: {
					sessionId: 'parent',
					timestamp: FIXED_TS,
					agent: 'critic_sounding_board',
				},
			},
			workflow: {
				schema: 'exact-task-v1',
				state: retryCount >= 3 ? 'rework_required' : 'idle',
				generation,
				retryCount,
				retryHistory:
					retryCount >= 3
						? [
								'accepted_mutation_failed',
								'dispatch_no_mutation',
								'dispatch_no_mutation',
							]
						: [],
				// A live epoch (non-zero) whenever the circuit has counted at
				// least one rejection — mirrors the reducer (`retryEpoch:
				// current.retryEpoch || current.generation + 1`). Only a
				// retryCount-0 task (the plain fixture) sits at epoch 0, so the
				// below-threshold case keeps its escalation at the LIVE epoch
				// and its refusal can only be attributed to the retryCount
				// conjunct (final-critic round 1, finding 1).
				retryEpoch: retryCount === 0 ? 0 : retryEpoch,
				// Reducer-consistent pair: `dispatch_no_mutation` preserves the
				// state and appends its own outcome, so the wedge shape from the
				// issue (accepted_mutation_failed then two no-mutation
				// rejections) ends with lastOutcome 'dispatch_no_mutation'
				// (issue #3389's own durable record).
				lastOutcome:
					retryCount >= 3 ? 'dispatch_no_mutation' : 'dispatch_attempted',
				updatedAt: FIXED_TS,
			},
		}),
	);
	for (const action of fixture.escalationActions ?? [
		'sounding_board_consultation',
		'simplification',
		'user_escalation',
	]) {
		appendCoreEventSync(directory, {
			type: 'coder_retry_circuit_breaker',
			timestamp: FIXED_TS,
			taskId: TASK_ID,
			generation,
			retryEpoch: fixture.escalationEpoch ?? retryEpoch,
			// Track the fixture's counter so the seeded event stays internally
			// consistent with the snapshot the admission predicate reads.
			rejectionCount: fixture.retryCount ?? 3,
			rejectionHistory: [
				'accepted_mutation_failed',
				'dispatch_no_mutation',
				'dispatch_no_mutation',
			],
			phase: 1,
			action: action as 'user_escalation',
		});
	}
	if (fixture.settlementWal === 'prepared') {
		writeSettlementWal(directory, 'PREPARED');
	} else if (fixture.settlementWal === 'committed-not-accepted') {
		writeSettlementWal(directory, 'COMMITTED');
	}
	if (fixture.corruptAuthorityIndex) {
		fs.writeFileSync(
			path.join(swarmDir, 'events-authority-index.json'),
			'not-json{{',
		);
	}
}

async function runRepair(
	directory: string,
	expectedState: string,
	expectedGeneration: number,
	transitionId = `repair-${TASK_ID}-wedge`,
) {
	const currentPlan = await loadPlanJsonOnly(directory);
	if (!currentPlan) throw new Error('fixture plan failed to load');
	return repairTaskWorkflowUnderPlanLock({
		directory,
		taskId: TASK_ID,
		actor: 'architect',
		reason: 'user authorized reopening after the retry escalation',
		transitionId,
		expectedState,
		expectedGeneration,
		currentPlanStatus: 'in_progress',
		currentPlan,
		updatePlan: () => Promise.resolve(currentPlan),
	});
}

describe('issue #3389 retry-escalation wedge repair admission', () => {
	let directory = '';
	let cleanup = (): void => {};

	beforeEach(() => {
		({ dir: directory, cleanup } = createSafeTestDir('wedge-repair-3389-'));
	});

	afterEach(() => {
		cleanup();
	});

	test('admits the audited repair from the user_escalation wedge (generation differs from retryEpoch) and clears the retry circuit', async () => {
		seedWedge(directory, { generation: 2, retryEpoch: 1, retryCount: 3 });
		const result = await runRepair(directory, 'rework_required', 2);
		expect(result.alreadyApplied).toBe(false);
		expect(result.generation).toBe(3);
		const evidence = await readTaskEvidence(directory, TASK_ID);
		const workflow = getTaskWorkflowSnapshot(evidence);
		expect(workflow.state).toBe('idle');
		expect(workflow.generation).toBe(3);
		expect(workflow.retryCount).toBe(0);
		expect(workflow.retryEpoch).toBe(0);
		expect(workflow.retryHistory).toEqual([]);
		const wal = JSON.parse(
			fs.readFileSync(
				path.join(directory, '.swarm', 'task-repairs', `${TASK_ID}.json`),
				'utf-8',
			),
		) as { state: string };
		expect(wal.state).toBe('COMMITTED');
		expect(
			hasTaskRepairAuditEvent(directory, TASK_ID, `repair-${TASK_ID}-wedge`),
		).toBe(true);
	});

	test('refuses a non-wedge in_progress task (fail-closed)', async () => {
		seedWedge(directory, {
			generation: 0,
			retryEpoch: 0,
			retryCount: 0,
			escalationActions: [],
		});
		await expect(runRepair(directory, 'idle', 0)).rejects.toThrow(
			'TASK_REPAIR_NOT_BACKWARD',
		);
	});

	test('refuses a partial ladder: sounding_board_consultation only', async () => {
		seedWedge(directory, {
			generation: 2,
			retryEpoch: 1,
			retryCount: 3,
			escalationActions: ['sounding_board_consultation'],
		});
		await expect(runRepair(directory, 'rework_required', 2)).rejects.toThrow(
			'TASK_REPAIR_NOT_BACKWARD',
		);
	});

	test('refuses a partial ladder: through simplification without user_escalation', async () => {
		seedWedge(directory, {
			generation: 2,
			retryEpoch: 1,
			retryCount: 3,
			escalationActions: ['sounding_board_consultation', 'simplification'],
		});
		await expect(runRepair(directory, 'rework_required', 2)).rejects.toThrow(
			'TASK_REPAIR_NOT_BACKWARD',
		);
	});

	test('refuses when user_escalation sits at a different retryEpoch (a generation-keyed lookup would admit here)', async () => {
		// generation 2 / live epoch 1; the escalation is keyed at epoch 2 — the
		// generation value. Base reads the live epoch and refuses; a mutant
		// keying on generation would find the escalation and admit.
		seedWedge(directory, {
			generation: 2,
			retryEpoch: 1,
			retryCount: 3,
			escalationActions: ['user_escalation'],
			escalationEpoch: 2,
		});
		await expect(runRepair(directory, 'rework_required', 2)).rejects.toThrow(
			'TASK_REPAIR_NOT_BACKWARD',
		);
	});

	test('refuses when user_escalation sits at an OLDER epoch than the live epoch (an any-epoch-up-to-live lookup would admit here)', async () => {
		// The escalation ladder ran at epoch 1; the workflow has since advanced
		// to live epoch 3 (retryCount reset then re-climbed to 3 at the newer
		// epoch). A mutant admitting an escalation found at ANY epoch up to the
		// live one would find the epoch-1 record and admit; the real predicate
		// reads only the live epoch 3, finds nothing, and refuses.
		seedWedge(directory, {
			generation: 4,
			retryEpoch: 3,
			retryCount: 3,
			escalationActions: ['user_escalation'],
			escalationEpoch: 1,
		});
		await expect(runRepair(directory, 'rework_required', 4)).rejects.toThrow(
			'TASK_REPAIR_NOT_BACKWARD',
		);
	});

	test('refuses the wedge repair when the caller CAS fields are stale (admission succeeds only against the exact generation)', async () => {
		seedWedge(directory, { generation: 2, retryEpoch: 1, retryCount: 3 });
		await expect(runRepair(directory, 'rework_required', 1)).rejects.toThrow(
			'TASK_REPAIR_CAS_MISMATCH',
		);
	});

	test('replaying the same wedge transition id returns alreadyApplied and writes one audit event', async () => {
		seedWedge(directory, { generation: 2, retryEpoch: 1, retryCount: 3 });
		const first = await runRepair(directory, 'rework_required', 2);
		expect(first.alreadyApplied).toBe(false);
		const replay = await runRepair(directory, 'rework_required', 2);
		expect(replay.alreadyApplied).toBe(true);
		expect(replay.transitionId).toBe(first.transitionId);
		const evidence = await readTaskEvidence(directory, TASK_ID);
		const workflow = getTaskWorkflowSnapshot(evidence);
		expect(workflow.retryCount).toBe(0);
		expect(workflow.retryEpoch).toBe(0);
		// The audit event is idempotent per exact task and transition id: the
		// replay must not have added a second one.
		expect(
			hasTaskRepairAuditEvent(directory, TASK_ID, `repair-${TASK_ID}-wedge`),
		).toBe(true);
		const events = fs
			.readFileSync(path.join(directory, '.swarm', 'events.jsonl'), 'utf8')
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line) as { type?: string })
			.filter((event) => event.type === 'task_workflow_repaired');
		expect(events).toHaveLength(1);
	});

	test('refuses when the durable user_escalation exists but retryCount sits below the threshold (defense-in-depth conjunct)', async () => {
		seedWedge(directory, {
			generation: 1,
			retryEpoch: 1,
			retryCount: 2,
			escalationActions: ['user_escalation'],
		});
		await expect(runRepair(directory, 'idle', 1)).rejects.toThrow(
			'TASK_REPAIR_NOT_BACKWARD',
		);
	});

	test('still refuses an unsettled coder dispatch first (guard order unchanged)', async () => {
		seedWedge(directory, {
			generation: 2,
			retryEpoch: 1,
			retryCount: 3,
			settlementWal: 'prepared',
		});
		await expect(runRepair(directory, 'rework_required', 2)).rejects.toThrow(
			'CODER_SETTLEMENT_RECOVERY_REQUIRED',
		);
	});

	test('remaps an unreadable escalation index instead of guessing admission', async () => {
		seedWedge(directory, {
			generation: 2,
			retryEpoch: 1,
			retryCount: 3,
			settlementWal: 'committed-not-accepted',
			corruptAuthorityIndex: true,
		});
		await expect(runRepair(directory, 'rework_required', 2)).rejects.toThrow(
			'TASK_REPAIR_ESCALATION_INDEX_UNREADABLE',
		);
	});
});
