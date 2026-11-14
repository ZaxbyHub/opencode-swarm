/**
 * Issue #2898 workflow-shape guard: every `run:` step that invokes
 * scripts/release-notes-fragments.mjs with a mode whose execution path reaches
 * the `gh` binary (the set exported as MODES_REQUIRING_GH by the script
 * itself — not hardcoded here) must carry GH_TOKEN (and GITHUB_REPOSITORY,
 * which requireRepoSlug throws without on the cleanup modes) in its effective
 * (job ∪ step) env. The cleanup job's apply step shipped without them on
 * 2026-09-06 and failed on every release since, silently, because publish-npm
 * does not depend on the cleanup job.
 *
 * The scan discovers every workflow under .github/workflows dynamically (no
 * hardcoded allowlist), and the violation collector is exercised against
 * in-memory mutated workflows (env stripped, YAML line-continuation forms) to
 * prove it discriminates without on-disk mutation.
 */

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { load as parse } from 'js-yaml';
import { MODES_REQUIRING_GH } from '../../../../scripts/release-notes-fragments.mjs';

const root = path.resolve(import.meta.dir, '../../../..');
const WORKFLOW_DIR = '.github/workflows';
const ALL_WORKFLOWS = readdirSync(path.join(root, WORKFLOW_DIR))
	.filter((name) => name.endsWith('.yml'))
	.sort()
	.map((name) => `${WORKFLOW_DIR}/${name}`);
const REQUIRED_KEYS = ['GH_TOKEN', 'GITHUB_REPOSITORY'] as const;

interface WorkflowStep {
	name?: string;
	run?: string;
	env?: Record<string, string>;
}

interface WorkflowJob {
	env?: Record<string, string>;
	steps?: WorkflowStep[];
}

type WorkflowDoc = { jobs?: Record<string, WorkflowJob> };

interface Violation {
	jobId: string;
	stepName: string;
	modes: string[];
	missingKeys: string[];
}

function modesInvokedByStep(
	run: string,
	modesRequiringGh: readonly string[],
): string[] {
	const invoked: string[] = [];
	for (const mode of modesRequiringGh) {
		// The separator between the script name and the mode may include a YAML
		// block-scalar backslash-newline continuation, so tolerate whitespace
		// AND backslashes (a fail-noisy direction: mention-shaped matches also
		// require the env keys, so over-matching cannot hide a real gap).
		const pattern = new RegExp(
			`release-notes-fragments\\.mjs[\\s\\\\]+${mode}(?![\\w-])`,
		);
		if (pattern.test(run)) invoked.push(mode);
	}
	return invoked.sort();
}

function findEnvViolations(
	doc: WorkflowDoc,
	modesRequiringGh: readonly string[],
): Violation[] {
	const violations: Violation[] = [];
	for (const [jobId, job] of Object.entries(doc.jobs ?? {})) {
		const jobEnv = job?.env && typeof job.env === 'object' ? job.env : {};
		for (const step of job?.steps ?? []) {
			const run = typeof step?.run === 'string' ? step.run : '';
			if (!run.includes('release-notes-fragments.mjs')) continue;
			const modes = modesInvokedByStep(run, modesRequiringGh);
			if (modes.length === 0) continue;
			const stepEnv = step?.env && typeof step.env === 'object' ? step.env : {};
			const effectiveEnv = { ...jobEnv, ...stepEnv };
			const missingKeys = REQUIRED_KEYS.filter((key) => !(key in effectiveEnv));
			if (missingKeys.length > 0) {
				violations.push({
					jobId,
					stepName: step.name ?? '<unnamed>',
					modes,
					missingKeys,
				});
			}
		}
	}
	return violations;
}

function guardedStepCount(
	doc: WorkflowDoc,
	modesRequiringGh: readonly string[],
): number {
	let count = 0;
	for (const job of Object.values(doc.jobs ?? {})) {
		for (const step of job?.steps ?? []) {
			const run = typeof step?.run === 'string' ? step.run : '';
			if (modesInvokedByStep(run, modesRequiringGh).length > 0) count += 1;
		}
	}
	return count;
}

function loadWorkflow(relativePath: string): WorkflowDoc {
	return parse(
		readFileSync(path.join(root, relativePath), 'utf8'),
	) as WorkflowDoc;
}

describe('release-fragments gh-auth workflow shape (issue 2898)', () => {
	test('MODES_REQUIRING_GH is exactly the four gh-dependent modes', () => {
		expect([...MODES_REQUIRING_GH].sort()).toEqual([
			'apply-cleanup',
			'prepare-cleanup',
			'update-pr',
			'update-release',
		]);
		expect(MODES_REQUIRING_GH).not.toContain('verify-retention');
		expect(MODES_REQUIRING_GH).not.toContain('prepare-historical-batch');
	});

	test('the scan discovers the workflow directory dynamically (no hardcoded allowlist)', () => {
		expect(ALL_WORKFLOWS).toContain(
			'.github/workflows/release-and-publish.yml',
		);
		expect(ALL_WORKFLOWS).toContain('.github/workflows/drift-check.yml');
		expect(ALL_WORKFLOWS.length).toBeGreaterThanOrEqual(5);
	});

	for (const workflowPath of ALL_WORKFLOWS) {
		test(`${workflowPath}: every gh-dependent fragment-script step carries GH_TOKEN and GITHUB_REPOSITORY`, () => {
			const violations = findEnvViolations(
				loadWorkflow(workflowPath),
				MODES_REQUIRING_GH,
			);
			expect(violations).toEqual([]);
		});
	}

	test('the release workflow scan is non-vacuous (guarded steps exist)', () => {
		const doc = loadWorkflow('.github/workflows/release-and-publish.yml');
		// update-release, prepare-cleanup, apply-cleanup (dry-run + apply in one
		// step), and update-pr: four guarded steps today. Use >= so adding a
		// compliant step stays green while proving the scan actually matches.
		expect(guardedStepCount(doc, MODES_REQUIRING_GH)).toBeGreaterThanOrEqual(4);
	});

	test('drift-check only invokes the non-gh verify-retention mode (no over-trigger)', () => {
		const doc = loadWorkflow('.github/workflows/drift-check.yml');
		expect(guardedStepCount(doc, MODES_REQUIRING_GH)).toBe(0);
		expect(findEnvViolations(doc, MODES_REQUIRING_GH)).toEqual([]);
	});

	test('mutation RED: stripping GH_TOKEN from the apply step is flagged', () => {
		const doc = loadWorkflow('.github/workflows/release-and-publish.yml');
		const applySteps = Object.entries(doc.jobs ?? {})
			.flatMap(([jobId, job]) =>
				(job?.steps ?? []).map((step) => ({ jobId, step })),
			)
			.filter(
				({ step }) => step.name === 'Validate and apply fragment cleanup',
			);
		expect(applySteps.length).toBe(1);
		const target = applySteps[0];
		expect(target.step.env && 'GH_TOKEN' in target.step.env).toBe(true);
		const mutated: WorkflowDoc = JSON.parse(JSON.stringify(doc));
		const mutatedStep = Object.values(mutated.jobs ?? {})
			.flatMap((job) => job?.steps ?? [])
			.find((step) => step.name === 'Validate and apply fragment cleanup');
		delete mutatedStep?.env?.GH_TOKEN;
		expect(findEnvViolations(mutated, MODES_REQUIRING_GH)).toEqual([
			{
				jobId: target.jobId,
				stepName: 'Validate and apply fragment cleanup',
				modes: ['apply-cleanup'],
				missingKeys: ['GH_TOKEN'],
			},
		]);
	});

	test('mutation RED: stripping GITHUB_REPOSITORY from the apply step is flagged', () => {
		const doc = loadWorkflow('.github/workflows/release-and-publish.yml');
		const mutated: WorkflowDoc = JSON.parse(JSON.stringify(doc));
		const mutatedStep = Object.values(mutated.jobs ?? {})
			.flatMap((job) => job?.steps ?? [])
			.find((step) => step.name === 'Validate and apply fragment cleanup');
		delete mutatedStep?.env?.GITHUB_REPOSITORY;
		// prepare-cleanup and apply-cleanup reach requireRepoSlug(), which
		// throws without GITHUB_REPOSITORY — the CI runner normally injects it,
		// but the explicit env declaration is the documented contract.
		expect(findEnvViolations(mutated, MODES_REQUIRING_GH)).toEqual([
			{
				jobId: 'cleanup-release-fragments',
				stepName: 'Validate and apply fragment cleanup',
				modes: ['apply-cleanup'],
				missingKeys: ['GITHUB_REPOSITORY'],
			},
		]);
	});

	test('mutation RED: a backslash-newline continuation between script and mode is still detected', () => {
		const doc: WorkflowDoc = {
			jobs: {
				example: {
					steps: [
						{
							name: 'Continuation-form invocation',
							run: 'node scripts/release-notes-fragments.mjs \\\n  apply-cleanup \\\n  --plan p.json',
						},
					],
				},
			},
		};
		expect(
			modesInvokedByStep(
				doc.jobs?.example?.steps?.[0]?.run ?? '',
				MODES_REQUIRING_GH,
			),
		).toEqual(['apply-cleanup']);
		expect(findEnvViolations(doc, MODES_REQUIRING_GH)).toEqual([
			{
				jobId: 'example',
				stepName: 'Continuation-form invocation',
				modes: ['apply-cleanup'],
				missingKeys: ['GH_TOKEN', 'GITHUB_REPOSITORY'],
			},
		]);
	});

	test('mutation RED: a job-level env does not silently satisfy a stripped step env', () => {
		const doc: WorkflowDoc = {
			jobs: {
				example: {
					env: { GH_TOKEN: 'job-level', GITHUB_REPOSITORY: 'o/r' },
					steps: [
						{
							name: 'Runs a gh mode with step env override',
							run: 'node scripts/release-notes-fragments.mjs apply-cleanup --plan p.json',
							env: { TAG_NAME: 'v0.0.0' },
						},
					],
				},
			},
		};
		// Effective env = job ∪ step, so the job-level keys DO satisfy the
		// guard when present...
		expect(findEnvViolations(doc, MODES_REQUIRING_GH)).toEqual([]);
		const withoutJobEnv: WorkflowDoc = JSON.parse(JSON.stringify(doc));
		delete withoutJobEnv.jobs?.example?.env;
		// ...and removing them flips the step to a violation.
		expect(findEnvViolations(withoutJobEnv, MODES_REQUIRING_GH)).toEqual([
			{
				jobId: 'example',
				stepName: 'Runs a gh mode with step env override',
				modes: ['apply-cleanup'],
				missingKeys: ['GH_TOKEN', 'GITHUB_REPOSITORY'],
			},
		]);
	});
});
