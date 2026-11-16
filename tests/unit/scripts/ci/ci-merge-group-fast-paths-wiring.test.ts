import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import yaml from 'js-yaml';

/*
 * Wiring pins for the docs-only merge-group fast path (detect-release's
 * `docs-only` output). A docs-only group still runs `quality` and the full
 * three-OS `unit` matrix; every other heavy job reports success without
 * running. `unit-passed` deliberately reads no detector output, so the
 * report-completeness check cannot be relaxed by this fast path. The
 * behavioral side of the classifier is pinned in
 * ci-merge-group-fast-paths.test.ts.
 */

const CI_YML = path.join(
	import.meta.dir,
	'../../../../.github/workflows/ci.yml',
);
const workflow = yaml.load(
	readFileSync(CI_YML, 'utf8').replace(/\r\n/g, '\n'),
) as any;
const jobs: Record<string, any> = workflow.jobs;

const RELEASE_GUARD = "needs.detect-release.outputs.is-release != 'true'";
const DOCS_GUARD = "needs.detect-release.outputs.docs-only != 'true'";

// Jobs a docs-only group skips. Each still reports its required context.
const SKIPPED_IN_DOCS_ONLY = [
	'memory-recall-regression',
	'coverage-shard',
	'coverage',
	'integration',
	'package-check',
	'security',
	'php-validation',
	'rust-sandbox-runner',
	'smoke',
];

// Jobs that must keep running for a docs-only group.
const ALWAYS_RUN_IN_DOCS_ONLY = ['quality', 'unit'];

function guardedSteps(job: any): any[] {
	return (job.steps ?? []).filter((step: any) =>
		String(step.if ?? '').includes(RELEASE_GUARD),
	);
}

describe('docs-only merge-group fast path wiring', () => {
	test('detect-release exposes the docs-only output from the check step', () => {
		expect(jobs['detect-release'].outputs['docs-only']).toBe(
			'${{ steps.check.outputs.docs-only }}',
		);
		const env = jobs['detect-release'].steps.find(
			(s: any) => s.id === 'check',
		).env;
		expect(env.BASE_REF).toContain('github.event.merge_group.base_ref');
		expect(env.BASE_SHA).toBeUndefined();
	});

	test('detect-release checks out full history so the base branch ref exists', () => {
		const checkout = jobs['detect-release'].steps.find((s: any) =>
			String(s.uses ?? '').startsWith('actions/checkout@'),
		);
		expect(checkout.with['fetch-depth']).toBe(0);
	});

	test('every release-guarded step of a skipped job also honors docs-only', () => {
		for (const name of SKIPPED_IN_DOCS_ONLY) {
			const steps = guardedSteps(jobs[name]);
			expect(steps.length, `${name} has release-guarded steps`).toBeGreaterThan(
				0,
			);
			for (const step of steps) {
				expect(String(step.if), `${name}: ${step.name ?? step.uses}`).toContain(
					DOCS_GUARD,
				);
			}
		}
	});

	test('quality and unit never skip for a docs-only group', () => {
		for (const name of ALWAYS_RUN_IN_DOCS_ONLY) {
			for (const step of jobs[name].steps ?? []) {
				expect(
					String(step.if ?? ''),
					`${name}: ${step.name ?? step.uses}`,
				).not.toContain('docs-only');
			}
		}
	});

	test('no job outside the declared set reads docs-only', () => {
		const readers = Object.entries(jobs)
			.filter(([, job]) => JSON.stringify(job).includes('outputs.docs-only'))
			.map(([name]) => name)
			.sort();
		expect(readers).toEqual([...SKIPPED_IN_DOCS_ONLY, 'detect-release'].sort());
	});

	test('a docs-only group still runs the full three-OS unit matrix', () => {
		const os = String(jobs.unit.strategy.matrix.os);
		expect(os).not.toContain('docs-only');
		expect(os).toContain(
			`fromJSON('["ubuntu-latest","macos-latest","windows-latest"]')`,
		);
	});

	test('unit-passed stays independent of every detector output', () => {
		const job = jobs['unit-passed'];
		expect(job.needs).toEqual(['unit']);
		expect(JSON.stringify(job)).not.toContain('needs.detect-');
	});
});
