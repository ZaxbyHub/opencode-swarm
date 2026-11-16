/**
 * save_plan external-evidence declaration surface (issue #3422): declaration
 * round-trip, revision preservation, explicit clear, anchor validation,
 * declaration-change evidence revocation (nonterminal cleared / terminal
 * preserved), plan lint, and the removal/re-add revocation cycle
 * (.agents/issue-traces/issue-3422/05-fix-plan.md sections 1/10, R3F2/R4F1).
 *
 * Hermetic per the frozen probe (.agents/issue-traces/issue-3422/repro/
 * probe-C3.ts): canonicalMkdtemp fixture with a `.git` marker dir, every
 * save pins execution_profile.planning_profile 'balanced' (host user config
 * cannot flip the profile to strict), static ISO timestamps only (no
 * real-clock usage), and no mock.module/seam overrides — afterEach only
 * cleans fixtures.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { transitionTaskWorkflowEvidence } from '../../../src/gate-evidence';
import type { SavePlanArgs } from '../../../src/tools/save-plan';
import { executeSavePlan } from '../../../src/tools/save-plan';
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

function readPlanTask(dir: string, taskId: string): Record<string, unknown> {
	const plan = JSON.parse(
		fs.readFileSync(path.join(dir, '.swarm', 'plan.json'), 'utf-8'),
	) as { phases: Array<{ tasks: Array<Record<string, unknown>> }> };
	const task = plan.phases
		.flatMap((phase) => phase.tasks)
		.find((candidate) => candidate.id === taskId);
	if (!task) throw new Error(`task ${taskId} missing from plan.json`);
	return task;
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

describe('save_plan external-evidence declaration surface (issue #3422)', () => {
	afterEach(() => {
		for (const dir of fixtures.splice(0)) {
			safeRmRecursive(dir);
		}
	});

	it('persists an external_git declaration verbatim into plan.json', async () => {
		const dir = newFixture('sp3422-roundtrip-');
		const saved = await executeSavePlan(
			saveArgs(dir, 'Round trip plan', [
				{
					id: '1.1',
					description: 'Commit and push the release artifact',
					files_touched: [],
					evidence_class: 'external_git',
					evidence_anchors: ANCHORS_A,
				},
			]),
			dir,
		);
		expect(saved.success).toBe(true);
		const task = readPlanTask(dir, '1.1');
		expect(task.evidence_class).toBe('external_git');
		expect(task.evidence_anchors).toEqual(ANCHORS_A);
	});

	it('preserves the prior declaration when a revision omits the fields', async () => {
		const dir = newFixture('sp3422-preserve-');
		const first = await executeSavePlan(
			saveArgs(dir, 'Preserve declaration plan', [
				{
					id: '1.1',
					description: 'Commit and push the release artifact',
					files_touched: [],
					evidence_class: 'external_git',
					evidence_anchors: ANCHORS_A,
				},
			]),
			dir,
		);
		expect(first.success).toBe(true);
		// Ordinary revision: same task id, other fields changed, declaration
		// fields omitted — the declaration must survive (an omitted field
		// means "preserve", never "clear").
		const second = await executeSavePlan(
			saveArgs(dir, 'Preserve declaration plan', [
				{
					id: '1.1',
					description: 'Broaden the release artifact checklist before pushing',
					files_touched: [],
				},
			]),
			dir,
		);
		expect(second.success).toBe(true);
		const task = readPlanTask(dir, '1.1');
		expect(task.evidence_class).toBe('external_git');
		expect(task.evidence_anchors).toEqual(ANCHORS_A);
	});

	it('clears the declaration on explicit coder_mutation and rejects anchors on non-external tasks', async () => {
		const clearDir = newFixture('sp3422-clear-');
		const first = await executeSavePlan(
			saveArgs(clearDir, 'Explicit clear plan', [
				{
					id: '1.1',
					description: 'Commit and push the release artifact',
					files_touched: [],
					evidence_class: 'external_git',
					evidence_anchors: ANCHORS_A,
				},
			]),
			clearDir,
		);
		expect(first.success).toBe(true);
		const second = await executeSavePlan(
			saveArgs(clearDir, 'Explicit clear plan', [
				{
					id: '1.1',
					description: 'Rework the artifact delivery as an in-repo change',
					files_touched: [],
					evidence_class: 'coder_mutation',
				},
			]),
			clearDir,
		);
		expect(second.success).toBe(true);
		const task = readPlanTask(clearDir, '1.1');
		expect(task.evidence_class).toBe('coder_mutation');
		expect(task.evidence_anchors).toBeUndefined();

		const anchorDir = newFixture('sp3422-anchorclass-');
		const rejected = await executeSavePlan(
			saveArgs(anchorDir, 'Anchor class mismatch plan', [
				{
					id: '2.1',
					description: 'Commit the migration result',
					files_touched: [],
					evidence_anchors: ANCHORS_A,
				},
			]),
			anchorDir,
		);
		expect(rejected.success).toBe(false);
		expect(
			(rejected.errors ?? []).some((error) =>
				error.includes('evidence_anchors require evidence_class external_git'),
			),
		).toBe(true);
	});

	it('rejects anchor lists over 16 and anchors with vacuous expectations', async () => {
		const dir = newFixture('sp3422-anchorbounds-');
		const seventeen = Array.from({ length: 17 }, (_, index) => ({
			command: `git rev-list --count HEAD~${index + 1}`,
			expect: '1\n',
		}));
		const tooMany = await executeSavePlan(
			saveArgs(dir, 'Anchor bounds plan', [
				{
					id: '4.1',
					description: 'Commit the batched migration result',
					files_touched: [],
					evidence_class: 'external_git',
					evidence_anchors: seventeen,
				},
			]),
			dir,
		);
		expect(tooMany.success).toBe(false);
		expect(
			(tooMany.errors ?? []).some((error) =>
				error.includes('1..16 evidence_anchors'),
			),
		).toBe(true);

		const noExpectation = await executeSavePlan(
			saveArgs(dir, 'Anchor bounds plan', [
				{
					id: '4.2',
					description: 'Commit the migration result',
					files_touched: [],
					evidence_class: 'external_git',
					evidence_anchors: [{ command: 'git rev-parse HEAD' }],
				},
			]),
			dir,
		);
		expect(noExpectation.success).toBe(false);
		expect(
			(noExpectation.errors ?? []).some((error) => error.includes('expect')),
		).toBe(true);

		const emptyPrefix = await executeSavePlan(
			saveArgs(dir, 'Anchor bounds plan', [
				{
					id: '4.3',
					description: 'Commit the migration result',
					files_touched: [],
					evidence_class: 'external_git',
					evidence_anchors: [
						{ command: 'git rev-parse HEAD', expect_prefix: '' },
					],
				},
			]),
			dir,
		);
		expect(emptyPrefix.success).toBe(false);
		expect(
			(emptyPrefix.errors ?? []).some((error) => error.includes('expect')),
		).toBe(true);
	});

	it('plan-lints git-ops tasks with empty scope and stays silent for controls', async () => {
		const dir = newFixture('sp3422-lint-');
		const saved = await executeSavePlan(
			saveArgs(dir, 'Plan lint probe', [
				{
					// Positive: undeclared, empty files, commit/push description.
					id: '3.2',
					description: 'Commit and push the README fix',
					files_touched: [],
				},
				{
					// Negative: declared external_git with empty files — silent.
					id: '3.3',
					description: 'Commit and push the changelog update',
					files_touched: [],
					evidence_class: 'external_git',
					evidence_anchors: [
						{ command: 'git rev-list --count HEAD', expect_prefix: '1' },
					],
				},
				{
					// Positive: omitted files_touched resolves to empty scope.
					id: '3.4',
					description: 'Publish the gh release for v1.0.0',
				},
				{
					// Negative: non-git-ops description with empty files.
					id: '2.1',
					description: 'Write the design doc outline',
					files_touched: [],
				},
				{
					// Negative control that still warns: explicit coder_mutation
					// with a commit description cannot complete either.
					id: '2.2',
					description: 'Commit the hotfix to the deploy script',
					files_touched: [],
					evidence_class: 'coder_mutation',
				},
			]),
			dir,
		);
		expect(saved.success).toBe(true);
		const warnings = saved.warnings ?? [];
		const dualToken = (id: string) =>
			warnings.some(
				(warning) =>
					warning.includes(id) &&
					warning.includes('external_git') &&
					warning.includes('coder dispatch'),
			);
		expect(dualToken('3.2')).toBe(true);
		expect(dualToken('3.4')).toBe(true);
		expect(warnings.some((warning) => warning.includes('3.3'))).toBe(false);
		expect(warnings.some((warning) => warning.includes('2.1'))).toBe(false);
		expect(warnings.some((warning) => warning.includes('2.2'))).toBe(true);
	});
});
