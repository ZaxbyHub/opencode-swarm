/**
 * Shared fixtures for the advisory-CI tests (issue #2497).
 *
 * Builds minimal `.swarm` fixture repos in temp dirs. Satisfying fixtures
 * are constructed with the repo's own writers (initLedger,
 * forceRecordPlanCriticApproval) and pre-validated with the repo's own
 * readers, mirroring the frozen acceptance-check builders so the shapes can
 * never drift from the real schemas.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { readTaskEvidenceState } from '../../../src/gate-evidence.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';
import { forceRecordPlanCriticApprovedForTests } from './_plan-critic-approval.js';

export const TS = '2026-01-01T00:00:00.000Z';

export interface FixtureTask {
	id: string;
	status: string;
}

function writeJson(file: string, data: unknown) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

export function writePlan(dir: string, tasks: FixtureTask[]) {
	writeJson(path.join(dir, '.swarm', 'plan.json'), {
		schema_version: '1.0.0',
		title: 'CI Advisory Fixture',
		swarm: 'local',
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'Implementation',
				status: 'pending',
				tasks: tasks.map((t) => ({
					id: t.id,
					phase: 1,
					status: t.status,
					size: 'small',
					description: `Fixture task ${t.id}`,
					depends: [],
					files_touched: ['src/thing.ts'],
				})),
			},
		],
	});
}

const gateEv = (agent: string) => ({
	sessionId: 'sess-ci-2497-tests',
	timestamp: TS,
	agent,
});

export interface TaskEvidenceSpec {
	taskId: string;
	/** Required gate keys; defaults to deriveRequiredGates('coder'). */
	requiredGates?: string[];
	/** Satisfied gate keys. */
	satisfied: string[];
	/** Workflow state; defaults to 'complete' when all gates satisfied. */
	workflowState: string;
}

export function writeTaskEvidence(dir: string, spec: TaskEvidenceSpec) {
	const required = spec.requiredGates ?? ['reviewer', 'test_engineer'];
	const gates: Record<string, unknown> = {};
	for (const gate of spec.satisfied) gates[gate] = gateEv(gate);
	writeJson(path.join(dir, '.swarm', 'evidence', `${spec.taskId}.json`), {
		taskId: spec.taskId,
		required_gates: required,
		gates,
		requirements_state: 'known',
		workflow: {
			schema: 'exact-task-v1',
			generation: 1,
			state: spec.workflowState,
			retryCount: 0,
			retryHistory: [],
			retryEpoch: 0,
			lastOutcome: 'task_completed',
			lastTransitionId: null,
			updatedAt: TS,
		},
	});
}

export function writeCorruptTaskEvidence(dir: string, taskId: string) {
	const file = path.join(dir, '.swarm', 'evidence', `${taskId}.json`);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, '{ this is not valid json !!!');
}

export interface BundleSpec {
	taskId: string;
	review?: 'approved' | 'rejected';
	tests?: { passed: number; failed: number };
	qualityBudget?: {
		complexityDelta: number;
		publicApiDelta: number;
		duplicationRatio: number;
		testToCodeRatio: number;
	};
}

export function writeEvidenceBundle(dir: string, spec: BundleSpec) {
	const entries: Array<Record<string, unknown>> = [];
	if (spec.review) {
		entries.push({
			type: 'review',
			task_id: spec.taskId,
			timestamp: TS,
			agent: 'reviewer',
			verdict: spec.review,
			summary: 'Fixture review',
			risk: 'low',
			issues: [],
		});
	}
	if (spec.tests) {
		entries.push({
			type: 'test',
			task_id: spec.taskId,
			timestamp: TS,
			agent: 'test_engineer',
			verdict: 'pass',
			summary: 'Fixture tests',
			tests_passed: spec.tests.passed,
			tests_failed: spec.tests.failed,
			failures: [],
		});
	}
	if (spec.qualityBudget) {
		entries.push({
			type: 'quality_budget',
			task_id: spec.taskId,
			timestamp: TS,
			agent: 'quality_budget',
			verdict: 'pass',
			summary: 'Fixture quality budget',
			metrics: {
				complexity_delta: spec.qualityBudget.complexityDelta,
				public_api_delta: spec.qualityBudget.publicApiDelta,
				duplication_ratio: spec.qualityBudget.duplicationRatio,
				test_to_code_ratio: spec.qualityBudget.testToCodeRatio,
				base_resolved: false,
			},
			thresholds: {
				max_complexity_delta: 5,
				max_public_api_delta: 10,
				max_duplication_ratio: 0.05,
				min_test_to_code_ratio: 0.3,
			},
			violations: [],
			files_analyzed: ['src/thing.ts'],
		});
	}
	writeJson(
		path.join(dir, '.swarm', 'evidence', spec.taskId, 'evidence.json'),
		{
			schema_version: '1.0.0',
			task_id: spec.taskId,
			entries,
			created_at: TS,
			updated_at: TS,
		},
	);
}

export function writeCorruptEvidenceBundle(dir: string, taskId: string) {
	const file = path.join(dir, '.swarm', 'evidence', taskId, 'evidence.json');
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, '{ also not valid json');
}

/**
 * Build the fully-satisfying fixture: one completed task with complete gate
 * evidence, a full evidence bundle, and a recorded plan-critic approval
 * (written through the repo's own writers so the ledger/DB state is real).
 */
export async function buildSatisfiedFixture(): Promise<string> {
	const dir = canonicalMkdtemp('swarm-ci-tests-satisfied-');
	writePlan(dir, [{ id: '1.1', status: 'completed' }]);
	writeTaskEvidence(dir, {
		taskId: '1.1',
		satisfied: ['reviewer', 'test_engineer'],
		workflowState: 'complete',
	});
	writeEvidenceBundle(dir, {
		taskId: '1.1',
		review: 'approved',
		tests: { passed: 10, failed: 0 },
		qualityBudget: {
			complexityDelta: 1,
			publicApiDelta: 1,
			duplicationRatio: 0.01,
			testToCodeRatio: 0.9,
		},
	});
	const state = await readTaskEvidenceState(dir, '1.1');
	if (state.kind !== 'ok') {
		throw new Error(`fixture regression: 1.1 evidence kind=${state.kind}`);
	}
	await forceRecordPlanCriticApprovedForTests(dir);
	return dir;
}

export function makeFixtureDir(prefix: string): string {
	return canonicalMkdtemp(prefix);
}
