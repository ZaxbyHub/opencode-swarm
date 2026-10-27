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

describe('repair_gate_evidence plan-identity guard (#3468)', () => {
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

	describe('repair_gate_evidence plan-identity guard', () => {
		const asArchitect = (reason: string) =>
			executeRepairGateEvidence({ task_id: TASK_ID, reason }, directory, {
				agent: 'architect',
			} as ToolContext);

		async function seedHealthyEvidence(): Promise<void> {
			await transitionTaskWorkflowEvidence(directory, TASK_ID, {
				type: 'accepted_mutation',
				agentType: 'coder',
				expectedGeneration: 0,
				transitionId: 'coder-gen-1',
			});
		}

		test('refuses healthy evidence stamped for the current plan', async () => {
			await seedHealthyEvidence();
			const before = fs.readFileSync(evidencePath(directory));

			const result = await asArchitect('repair current evidence');

			expect(result.success).toBe(false);
			expect(result.message).toBe('TASK_GATE_EVIDENCE_REPAIR_NOT_REQUIRED');
			expect(fs.readFileSync(evidencePath(directory))).toEqual(before);
		});

		test('still refuses healthy legacy evidence that carries no stamp', async () => {
			await seedHealthyEvidence();
			restamp(directory, null);
			const before = fs.readFileSync(evidencePath(directory));

			const result = await asArchitect('repair unstamped evidence');

			expect(result.success).toBe(false);
			expect(result.message).toBe('TASK_GATE_EVIDENCE_REPAIR_NOT_REQUIRED');
			expect(fs.readFileSync(evidencePath(directory))).toEqual(before);
		});

		test('rebuilds evidence stamped for a different plan and stamps the rebuild with the current identity', async () => {
			await seedHealthyEvidence();
			restamp(directory, {
				planId: 'old-plan',
				planIdentityHash: hashOf(PLAN_B),
			});

			const result = await asArchitect('repair prior-campaign evidence');

			expect(result.success).toBe(true);
			expect(result.repaired).toBe(true);
			const rebuilt = readEvidenceFile(directory);
			expect(rebuilt.planIdentityHash).toBe(hashOf(PLAN_A));
			expect(rebuilt.gates).toEqual({});

			// The rebuilt record no longer classifies as prior-campaign, so a second
			// repair is the idempotent already-repaired success, not another rewrite.
			const second = await asArchitect('repair prior-campaign evidence');
			expect(second.success).toBe(true);
			expect(second.repaired).toBe(false);
		});
	});
});
