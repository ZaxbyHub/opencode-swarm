import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ToolContext } from '@opencode-ai/plugin/tool';
import {
	evidenceStampedForDifferentPlan,
	recordTodoScanEvidence,
	resolveCurrentPlanIdentitySync,
	transitionTaskWorkflowEvidence,
	withTaskEvidenceTransaction,
} from '../../../src/gate-evidence.js';
import { derivePlanIdentityHash } from '../../../src/plan/utils.js';
import { resetSwarmState } from '../../../src/state.js';
import { executeRepairGateEvidence } from '../../../src/tools/repair-gate-evidence.js';
import { createSafeTestDir } from '../../helpers/safe-test-dir.js';

const TASK_ID = '1.1';
const PLAN_A = { swarm: 'test-swarm', title: 'Campaign A' };
const PLAN_B = { swarm: 'test-swarm', title: 'Campaign B' };

function writePlan(directory: string, plan: { swarm: string; title: string }) {
	fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });
	fs.writeFileSync(
		path.join(directory, 'package.json'),
		JSON.stringify({ name: 'plan-identity-stamp-3468' }),
	);
	fs.writeFileSync(
		path.join(directory, '.swarm', 'plan.json'),
		JSON.stringify({
			schema_version: '1.0.0',
			...plan,
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
							description: 'Stamped task',
							depends: [],
							files_touched: ['src/example.ts'],
						},
					],
				},
			],
		}),
	);
}

function evidencePath(directory: string): string {
	return path.join(directory, '.swarm', 'evidence', `${TASK_ID}.json`);
}

function readEvidenceFile(directory: string): Record<string, unknown> {
	return JSON.parse(fs.readFileSync(evidencePath(directory), 'utf8'));
}

/** Rewrite the on-disk evidence, setting or removing the plan-identity stamp. */
function restamp(
	directory: string,
	stamp: { planId: string; planIdentityHash: string } | null,
): void {
	const evidence = readEvidenceFile(directory);
	delete evidence.planId;
	delete evidence.planIdentityHash;
	fs.writeFileSync(
		evidencePath(directory),
		JSON.stringify({ ...evidence, ...(stamp ?? {}) }, null, 2),
	);
}

const TODO_SCAN = { priority: 'low', count: 0 };

const hashOf = (plan: { swarm: string; title: string }) =>
	derivePlanIdentityHash(plan);

describe('plan-identity stamp (#3468)', () => {
	let directory: string;
	let cleanup: () => void;

	beforeEach(() => {
		resetSwarmState();
		({ dir: directory, cleanup } = createSafeTestDir('plan-identity-3468-'));
		writePlan(directory, PLAN_A);
	});

	afterEach(() => {
		resetSwarmState();
		cleanup();
	});

	describe('evidenceStampedForDifferentPlan', () => {
		const evidence = (hash?: string) =>
			({
				taskId: TASK_ID,
				required_gates: [],
				gates: {},
				...(hash ? { planIdentityHash: hash } : {}),
			}) as Parameters<typeof evidenceStampedForDifferentPlan>[0];

		test('is true only for a positive stamp mismatch', () => {
			expect(
				evidenceStampedForDifferentPlan(
					evidence(hashOf(PLAN_B)),
					hashOf(PLAN_A),
				),
			).toBe(true);
		});

		test('treats a matching stamp as current', () => {
			expect(
				evidenceStampedForDifferentPlan(
					evidence(hashOf(PLAN_A)),
					hashOf(PLAN_A),
				),
			).toBe(false);
		});

		test('treats an absent stamp as unknown, not prior-campaign', () => {
			expect(evidenceStampedForDifferentPlan(evidence(), hashOf(PLAN_A))).toBe(
				false,
			);
		});

		test('is false when the evidence or the current identity is unavailable', () => {
			expect(evidenceStampedForDifferentPlan(null, hashOf(PLAN_A))).toBe(false);
			expect(
				evidenceStampedForDifferentPlan(evidence(hashOf(PLAN_B)), null),
			).toBe(false);
		});
	});

	describe('resolveCurrentPlanIdentitySync', () => {
		test('derives the identity from .swarm/plan.json', () => {
			expect(resolveCurrentPlanIdentitySync(directory)?.planIdentityHash).toBe(
				hashOf(PLAN_A),
			);
		});

		test('returns null for a missing or malformed plan and a missing directory', () => {
			expect(resolveCurrentPlanIdentitySync(undefined)).toBeNull();
			fs.writeFileSync(path.join(directory, '.swarm', 'plan.json'), '{nope');
			expect(resolveCurrentPlanIdentitySync(directory)).toBeNull();
			fs.rmSync(path.join(directory, '.swarm', 'plan.json'));
			expect(resolveCurrentPlanIdentitySync(directory)).toBeNull();
		});
	});

	describe('persist-time stamping', () => {
		async function seedWithRecordedGate(): Promise<void> {
			await transitionTaskWorkflowEvidence(directory, TASK_ID, {
				type: 'accepted_mutation',
				agentType: 'coder',
				expectedGeneration: 0,
				transitionId: 'coder-gen-1',
			});
			await withTaskEvidenceTransaction(
				directory,
				TASK_ID,
				'seed_gate',
				async (transaction) => {
					const current = transaction.read();
					if (!current || !transaction.save) throw new Error('seed failed');
					await transaction.save({
						...current,
						gates: {
							reviewer: {
								sessionId: 's',
								timestamp: '2026-01-01T00:00:00.000Z',
								agent: 'reviewer',
							},
						},
					});
				},
			);
		}

		test('stamps newly created evidence with the current plan identity', async () => {
			await transitionTaskWorkflowEvidence(directory, TASK_ID, {
				type: 'accepted_mutation',
				agentType: 'coder',
				expectedGeneration: 0,
				transitionId: 'coder-gen-1',
			});
			expect(readEvidenceFile(directory).planIdentityHash).toBe(hashOf(PLAN_A));
		});

		test('does not stamp when plan.json is unreadable at write time', async () => {
			fs.rmSync(path.join(directory, '.swarm', 'plan.json'));
			await transitionTaskWorkflowEvidence(directory, TASK_ID, {
				type: 'accepted_mutation',
				agentType: 'coder',
				expectedGeneration: 0,
				transitionId: 'coder-gen-1',
			});
			expect(readEvidenceFile(directory).planIdentityHash).toBeUndefined();
		});

		test('keeps legacy unstamped evidence unstamped when a supplementary write carries recorded gates', async () => {
			await seedWithRecordedGate();
			restamp(directory, null);

			await recordTodoScanEvidence(directory, TASK_ID, TODO_SCAN);

			const after = readEvidenceFile(directory);
			expect(after.planIdentityHash).toBeUndefined();
			expect(Object.keys(after.gates as object)).toEqual(['reviewer']);
		});

		test('keeps a prior-campaign stamp on carried gates instead of relaunding them into the current plan', async () => {
			await seedWithRecordedGate();
			restamp(directory, {
				planId: 'old-plan',
				planIdentityHash: hashOf(PLAN_B),
			});

			// A write that rebuilds the record without the stamp (as a transition's
			// fresh literal does) must not drop the prior-campaign identity.
			await withTaskEvidenceTransaction(
				directory,
				TASK_ID,
				'drop_stamp',
				async (transaction) => {
					const current = transaction.read();
					if (!current || !transaction.save) throw new Error('seed failed');
					await transaction.save({
						...current,
						planId: undefined,
						planIdentityHash: undefined,
					});
				},
			);

			const after = readEvidenceFile(directory);
			expect(after.planIdentityHash).toBe(hashOf(PLAN_B));
			expect(after.planId).toBe('old-plan');
		});

		test('preserves an explicit stamp carried by the incoming record', async () => {
			await transitionTaskWorkflowEvidence(directory, TASK_ID, {
				type: 'accepted_mutation',
				agentType: 'coder',
				expectedGeneration: 0,
				transitionId: 'coder-gen-1',
			});
			await withTaskEvidenceTransaction(
				directory,
				TASK_ID,
				'explicit_stamp',
				async (transaction) => {
					const current = transaction.read();
					if (!current || !transaction.save) throw new Error('seed failed');
					await transaction.save({
						...current,
						planId: 'other',
						planIdentityHash: hashOf(PLAN_B),
					});
				},
			);

			const after = readEvidenceFile(directory);
			expect(after.planIdentityHash).toBe(hashOf(PLAN_B));
			expect(after.planId).toBe('other');
		});

		const generationOf = () =>
			(readEvidenceFile(directory).workflow as { generation: number })
				.generation;

		test('a coder accepted_mutation under a new plan restamps even when non-workflow gates are retained', async () => {
			await transitionTaskWorkflowEvidence(directory, TASK_ID, {
				type: 'accepted_mutation',
				agentType: 'coder',
				expectedGeneration: 0,
				transitionId: 'coder-gen-1',
			});
			await withTaskEvidenceTransaction(
				directory,
				TASK_ID,
				'seed_designer',
				async (transaction) => {
					const current = transaction.read();
					if (!current || !transaction.save) throw new Error('seed failed');
					await transaction.save({
						...current,
						gates: {
							designer: {
								sessionId: 's',
								timestamp: '2026-01-01T00:00:00.000Z',
								agent: 'designer',
							},
						},
					});
				},
			);
			expect(readEvidenceFile(directory).planIdentityHash).toBe(hashOf(PLAN_A));

			writePlan(directory, PLAN_B);
			await transitionTaskWorkflowEvidence(directory, TASK_ID, {
				type: 'accepted_mutation',
				agentType: 'coder',
				expectedGeneration: generationOf(),
				transitionId: 'coder-gen-2',
			});

			const after = readEvidenceFile(directory);
			expect(after.planIdentityHash).toBe(hashOf(PLAN_B));
			expect(Object.keys(after.gates as object)).toEqual(['designer']);
		});

		const coderMutation = (transitionId: string, expectedGeneration: number) =>
			transitionTaskWorkflowEvidence(directory, TASK_ID, {
				type: 'accepted_mutation',
				agentType: 'coder',
				expectedGeneration,
				transitionId,
			});

		async function addGate(gate: string): Promise<void> {
			await withTaskEvidenceTransaction(
				directory,
				TASK_ID,
				'seed_gate',
				async (transaction) => {
					const current = transaction.read();
					if (!current || !transaction.save) throw new Error('seed failed');
					await transaction.save({
						...current,
						gates: {
							...current.gates,
							[gate]: {
								sessionId: 's',
								timestamp: '2026-01-01T00:00:00.000Z',
								agent: gate,
							},
						},
					});
				},
			);
		}

		test('a non-coder or agent-less accepted_mutation is not a campaign restart', async () => {
			await coderMutation('coder-gen-1', 0);
			await addGate('designer');
			writePlan(directory, PLAN_B);

			await transitionTaskWorkflowEvidence(directory, TASK_ID, {
				type: 'accepted_mutation',
				agentType: 'architect',
				expectedGeneration: generationOf(),
				transitionId: 'architect-1',
			});
			expect(readEvidenceFile(directory).planIdentityHash).toBe(hashOf(PLAN_A));

			await transitionTaskWorkflowEvidence(directory, TASK_ID, {
				type: 'accepted_mutation',
				expectedGeneration: generationOf(),
				transitionId: 'anonymous-1',
			});
			expect(readEvidenceFile(directory).planIdentityHash).toBe(hashOf(PLAN_A));
		});

		test('a coder dispatch_attempted is not a campaign restart', async () => {
			await coderMutation('coder-gen-1', 0);
			await addGate('designer');
			writePlan(directory, PLAN_B);

			await transitionTaskWorkflowEvidence(directory, TASK_ID, {
				type: 'dispatch_attempted',
				agentType: 'coder',
				expectedGeneration: generationOf(),
				transitionId: 'dispatch-1',
			});

			const after = readEvidenceFile(directory);
			expect(after.planIdentityHash).toBe(hashOf(PLAN_A));
			expect(Object.keys(after.gates as object)).toEqual(['designer']);
		});

		test('a duplicate coder replay does not launder unstamped legacy evidence under a new plan', async () => {
			await coderMutation('coder-gen-1', 0);
			await addGate('designer');
			restamp(directory, null);
			writePlan(directory, PLAN_B);

			await coderMutation('coder-gen-1', generationOf());

			const after = readEvidenceFile(directory);
			expect(after.planIdentityHash).toBeUndefined();
			expect(Object.keys(after.gates as object)).toEqual(['designer']);
		});

		test('stamps the first-ever write of a fresh task even when it carries a gate', async () => {
			await transitionTaskWorkflowEvidence(directory, TASK_ID, {
				type: 'gate_recorded',
				gate: 'designer',
				sessionId: 's',
				transitionId: 'gate-1',
			});

			const after = readEvidenceFile(directory);
			expect(Object.keys(after.gates as object)).toEqual(['designer']);
			expect(after.planIdentityHash).toBe(hashOf(PLAN_A));
		});

		test('re-mints the stamp when the previous record is stamped for another plan and the write carries no gates', async () => {
			await transitionTaskWorkflowEvidence(directory, TASK_ID, {
				type: 'accepted_mutation',
				agentType: 'coder',
				expectedGeneration: 0,
				transitionId: 'coder-gen-1',
			});
			writePlan(directory, PLAN_B);
			await withTaskEvidenceTransaction(
				directory,
				TASK_ID,
				'drop_stamp',
				async (transaction) => {
					const current = transaction.read();
					if (!current || !transaction.save) throw new Error('seed failed');
					await transaction.save({
						...current,
						planId: undefined,
						planIdentityHash: undefined,
					});
				},
			);

			expect(readEvidenceFile(directory).planIdentityHash).toBe(hashOf(PLAN_B));
		});

		test('restamps with the current identity when the write carries no recorded gates', async () => {
			await transitionTaskWorkflowEvidence(directory, TASK_ID, {
				type: 'accepted_mutation',
				agentType: 'coder',
				expectedGeneration: 0,
				transitionId: 'coder-gen-1',
			});
			restamp(directory, null);

			await recordTodoScanEvidence(directory, TASK_ID, TODO_SCAN);

			expect(readEvidenceFile(directory).planIdentityHash).toBe(hashOf(PLAN_A));
		});
	});
});
