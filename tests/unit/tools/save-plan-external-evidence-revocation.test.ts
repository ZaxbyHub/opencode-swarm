/**
 * save_plan external-evidence REVOCATION tests, split out of
 * save-plan-external-evidence.test.ts for the FR-006 500-line cap (issue
 * #3432 review fix batch): declaration-change, plan-identity (title) change,
 * terminal preservation, and removal/re-add revocation semantics. The
 * declaration persistence surface stays in save-plan-external-evidence.test.ts.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { transitionTaskWorkflowEvidence } from '../../../src/gate-evidence';
import type { SavePlanArgs } from '../../../src/tools/save-plan';
import { executeSavePlan } from '../../../src/tools/save-plan';
import { executeUpdateTaskStatus } from '../../../src/tools/update-task-status';
import { safeRmRecursive } from '../../helpers/safe-test-dir';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

type SaveTaskInput = SavePlanArgs['phases'][number]['tasks'][number];

/** Static attestation timestamp — never derived from the real clock. */
const ATTESTED_AT = '2026-01-15T00:00:00.000Z';

const ANCHORS_A = [
	{ command: 'git rev-list --count HEAD~1..HEAD', expect: '1\n' },
];
const ANCHORS_B = [
	{ command: 'git rev-list --count HEAD~2..HEAD', expect: '2\n' },
];

const fixtures: string[] = [];

function newFixture(prefix: string): string {
	const dir = canonicalMkdtemp(prefix);
	// .git marker dir so save_plan's project-root boundary accepts the fixture.
	fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
	fixtures.push(dir);
	return dir;
}

function saveArgs(
	dir: string,
	title: string,
	tasks: SaveTaskInput[],
	extra?: Partial<SavePlanArgs>,
): SavePlanArgs {
	return {
		title,
		swarm_id: 'ext-evidence-test',
		phases: [{ id: 1, name: 'delivery', tasks }],
		working_directory: dir,
		// Pin the planning profile: the fixture has no project config, so an
		// unpinned save would resolve through the host user's global config
		// (probe-C3.ts) and could hit the strict spec gate first.
		execution_profile: { planning_profile: 'balanced' },
		...extra,
	};
}

function readEvidenceWorkflow(
	dir: string,
	taskId: string,
): Record<string, unknown> {
	return JSON.parse(
		fs.readFileSync(
			path.join(dir, '.swarm', 'evidence', `${taskId}.json`),
			'utf-8',
		),
	).workflow;
}

/** Seed an attested bundle for a task with no evidence file yet (the store
 * creates it idle at generation 0, from which the attest is admitted). */
async function seedExternalAttestation(
	dir: string,
	taskId: string,
	anchors: Array<{ command: string; expect?: string; expect_prefix?: string }>,
): Promise<void> {
	await transitionTaskWorkflowEvidence(dir, taskId, {
		type: 'external_evidence_attested',
		expectedGeneration: 0,
		transitionId: `attest:${taskId}`,
		bundle: {
			class: 'external_git',
			transitionId: `attest:${taskId}`,
			declarationDigest: 'a'.repeat(64),
			anchors: anchors.map((anchor) => ({
				command: anchor.command,
				...(anchor.expect !== undefined ? { expect: anchor.expect } : {}),
				...(anchor.expect_prefix !== undefined
					? { expect_prefix: anchor.expect_prefix }
					: {}),
				matched: true,
				exit_code: 0,
				stdout: '1\n',
			})),
			attestedAt: ATTESTED_AT,
		},
	});
}

afterEach(() => {
	while (fixtures.length > 0) {
		const dir = fixtures.pop();
		if (dir) safeRmRecursive(dir);
	}
});

describe('save_plan external-evidence revocation (issue #3422 + #3432 review)', () => {
	it('revokes attested external evidence when the declaration changes on a nonterminal task', async () => {
		const dir = newFixture('sp3422-revoke-');
		const first = await executeSavePlan(
			saveArgs(dir, 'Revocation plan', [
				{
					id: '5.1',
					description: 'Commit and push the release artifact',
					files_touched: [],
					evidence_class: 'external_git',
					evidence_anchors: ANCHORS_A,
				},
			]),
			dir,
		);
		expect(first.success).toBe(true);
		await seedExternalAttestation(dir, '5.1', ANCHORS_A);
		expect(readEvidenceWorkflow(dir, '5.1').externalEvidence).toBeDefined();

		const second = await executeSavePlan(
			saveArgs(dir, 'Revocation plan', [
				{
					id: '5.1',
					description: 'Commit and push the release artifact',
					files_touched: [],
					evidence_class: 'external_git',
					evidence_anchors: ANCHORS_B,
				},
			]),
			dir,
		);
		expect(second.success).toBe(true);
		const workflow = readEvidenceWorkflow(dir, '5.1');
		expect(workflow.externalEvidence).toBeUndefined();
		// The revoke is state-preserving: the task stays idle for a fresh attest.
		expect(workflow.state).toBe('idle');
	});

	it('revokes when the plan title changes even though the declaration is unchanged (issue #3432 review PRR-010: the digest names plan identity)', async () => {
		const dir = newFixture('sp3422-rename-');
		const first = await executeSavePlan(
			saveArgs(dir, 'Identity plan', [
				{
					id: '5.4',
					description: 'Commit and push the release artifact',
					files_touched: [],
					evidence_class: 'external_git',
					evidence_anchors: ANCHORS_A,
				},
			]),
			dir,
		);
		expect(first.success).toBe(true);
		await seedExternalAttestation(dir, '5.4', ANCHORS_A);
		expect(readEvidenceWorkflow(dir, '5.4').externalEvidence).toBeDefined();

		// Same task, same anchors — only the plan title changes (which needs
		// the explicit identity-change confirmation). The attested digest
		// names the OLD title, so the stale proof must be revoked.
		const renamed = await executeSavePlan(
			saveArgs(
				dir,
				'Identity plan v2',
				[
					{
						id: '5.4',
						description: 'Commit and push the release artifact',
						files_touched: [],
						evidence_class: 'external_git',
						evidence_anchors: ANCHORS_A,
					},
				],
				{ confirm_identity_change: true },
			),
			dir,
		);
		expect(renamed.success).toBe(true);
		const workflow = readEvidenceWorkflow(dir, '5.4');
		expect(workflow.externalEvidence).toBeUndefined();
		expect(workflow.state).toBe('idle');
	});

	it('preserves terminal attested evidence when the declaration changes (R4F1)', async () => {
		const dir = newFixture('sp3422-terminal-');
		const first = await executeSavePlan(
			saveArgs(dir, 'Terminal preservation plan', [
				{
					id: '5.2',
					description: 'Commit and push the release artifact',
					files_touched: [],
					evidence_class: 'external_git',
					evidence_anchors: ANCHORS_A,
				},
			]),
			dir,
		);
		expect(first.success).toBe(true);
		await seedExternalAttestation(dir, '5.2', ANCHORS_A);
		await transitionTaskWorkflowEvidence(dir, '5.2', {
			type: 'task_completed',
			expectedGeneration: 0,
			transitionId: 'complete:5.2',
			externalEvidence: true,
		});
		expect(readEvidenceWorkflow(dir, '5.2').state).toBe('complete');

		const second = await executeSavePlan(
			saveArgs(dir, 'Terminal preservation plan', [
				{
					id: '5.2',
					description: 'Commit and push the release artifact',
					files_touched: [],
					evidence_class: 'external_git',
					evidence_anchors: ANCHORS_B,
				},
			]),
			dir,
		);
		expect(second.success).toBe(true);
		const workflow = readEvidenceWorkflow(dir, '5.2') as {
			state: string;
			externalEvidence?: { declarationDigest?: string };
		};
		expect(workflow.state).toBe('complete');
		expect(workflow.externalEvidence?.declarationDigest).toBe('a'.repeat(64));
	});

	it('revokes on removal and refuses completion after an identical re-add without fresh attest', async () => {
		const dir = newFixture('sp3422-remove-');
		const declared = (description: string): SaveTaskInput => ({
			id: '9.1',
			description,
			files_touched: [],
			evidence_class: 'external_git',
			evidence_anchors: ANCHORS_A,
		});
		const sibling: SaveTaskInput = {
			id: '9.2',
			description: 'Update the changelog section',
			files_touched: ['docs/change.md'],
		};
		const first = await executeSavePlan(
			saveArgs(dir, 'Removal re-add plan', [
				declared('Commit and push the artifact'),
				sibling,
			]),
			dir,
		);
		expect(first.success).toBe(true);
		await seedExternalAttestation(dir, '9.1', ANCHORS_A);
		expect(readEvidenceWorkflow(dir, '9.1').externalEvidence).toBeDefined();

		const removal = await executeSavePlan(
			saveArgs(dir, 'Removal re-add plan', [sibling], {
				removed_task_ids: ['9.1'],
				removal_reason: 'Declaration moved to a follow-up plan',
			}),
			dir,
		);
		expect(removal.success).toBe(true);
		expect(readEvidenceWorkflow(dir, '9.1').externalEvidence).toBeUndefined();

		const readd = await executeSavePlan(
			saveArgs(dir, 'Removal re-add plan', [
				declared('Commit and push the artifact'),
				sibling,
			]),
			dir,
		);
		expect(readd.success).toBe(true);

		const completion = await executeUpdateTaskStatus(
			{ task_id: '9.1', status: 'completed', working_directory: dir },
			dir,
		);
		expect(completion.success).toBe(false);
		const text = [completion.message, ...(completion.errors ?? [])].join('\n');
		// The refusal surfaces through the reviewer-gate pre-check's external
		// arm (update-task-status.ts `checkReviewerGate`), which fires before
		// the plan-lock TASK_COMPLETION_CAS_MISMATCH validation for a
		// reviewer-requiring phase: the attestation is gone, so completion
		// fails closed naming the missing proof and the /swarm attest remedy.
		// (The pre-lock reviewer precheck is bypassed for declared external
		// tasks, so the under-lock refusal is the one that surfaces.)
		expect(text).toContain(
			'declares external_git evidence but has no current matched attestation',
		);
		expect(text).toContain('/swarm attest 9.1');
	});
});
