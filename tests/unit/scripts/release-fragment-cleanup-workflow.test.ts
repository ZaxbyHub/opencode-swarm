import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';

const root = path.resolve(import.meta.dir, '../../..');
const releaseWorkflow = readFileSync(
	path.join(root, '.github/workflows/release-and-publish.yml'),
	'utf8',
);
const ciWorkflow = readFileSync(
	path.join(root, '.github/workflows/ci.yml'),
	'utf8',
);
const standardsWorkflow = readFileSync(
	path.join(root, '.github/workflows/pr-standards.yml'),
	'utf8',
);
const standardsConfig = parse(standardsWorkflow);
const driftWorkflow = readFileSync(
	path.join(root, '.github/workflows/drift-check.yml'),
	'utf8',
);

describe('release fragment cleanup workflow', () => {
	test('prepares provenance at the exact release tag and transports one plan', () => {
		expect(releaseWorkflow).toContain(
			'ref: ${{ needs.release-please.outputs.tag_name }}',
		);
		expect(releaseWorkflow).toContain(
			'node scripts/release-notes-fragments.mjs prepare-cleanup',
		);
		expect(releaseWorkflow).toContain('name: release-fragment-cleanup-plan');
		expect(releaseWorkflow).toContain('retention-days: 1');
	});

	test('dry-runs before apply and stages only release documentation', () => {
		const validate = releaseWorkflow.indexOf(
			'node scripts/release-notes-fragments.mjs apply-cleanup',
		);
		const apply = releaseWorkflow.indexOf('--apply', validate);
		expect(validate).toBeGreaterThan(-1);
		expect(apply).toBeGreaterThan(validate);
		expect(releaseWorkflow).toContain('git add -- docs/releases');
	});

	test('reuses a stranded owned branch safely and never pushes main', () => {
		expect(releaseWorkflow).toContain(
			'branch="chore/release-fragments-${TAG_NAME#v}"',
		);
		expect(releaseWorkflow).toContain(
			'git push --force-with-lease="refs/heads/$branch:$remote_sha"',
		);
		expect(releaseWorkflow).not.toMatch(/git push origin main/);
		expect(releaseWorkflow).toContain('gh pr create');
		expect(releaseWorkflow).toContain(
			'Refusing to replace an unrelated cleanup branch',
		);
		expect(releaseWorkflow).toContain(
			"awk '$0 !~ /^docs\\/releases\\//' ".trim(),
		);
		expect(releaseWorkflow).not.toContain("grep -v '^docs/releases/' || true");
	});

	test('updates an existing PR then redispatches required workflows', () => {
		const edit = releaseWorkflow.indexOf('gh pr edit "$existing_pr"');
		const create = releaseWorkflow.indexOf('gh pr create');
		const dispatch = releaseWorkflow.indexOf(
			'gh workflow run ci.yml --ref "$branch"',
		);
		expect(edit).toBeGreaterThan(-1);
		expect(create).toBeGreaterThan(edit);
		expect(dispatch).toBeGreaterThan(create);
		expect(releaseWorkflow).toContain('gh workflow run ci.yml --ref "$branch"');
		expect(releaseWorkflow).toContain(
			'gh workflow run pr-standards.yml --ref "$branch" -f pr_number="$pr_number"',
		);
		expect(releaseWorkflow).toContain('--base main');
		expect(releaseWorkflow).toContain('baseRefName,headRefOid');
		expect(releaseWorkflow).toContain('wait_for_dispatched_run()');
		expect(releaseWorkflow).toContain(
			'Cleanup PR body violates the PR contract.',
		);
		expect(releaseWorkflow).toContain('CI run $ci_run_id: $ci_run_url');
		expect(releaseWorkflow).toContain(
			'PR Standards run $standards_run_id: $standards_run_url',
		);
		expect(ciWorkflow).toMatch(/on:\s*\n\s+workflow_dispatch:/);
		expect(standardsWorkflow).toMatch(/on:\s*\n\s+workflow_dispatch:/);
		expect(standardsWorkflow).toContain('pr_number:');
		expect(standardsWorkflow).toContain('Validate dispatched PR title');
		expect(standardsWorkflow).toContain('Validate dispatched PR contract');
		expect(standardsWorkflow).not.toContain('dispatched-pr-standards:');
		expect(
			standardsConfig.jobs['check-title'].steps.some(
				(step: { name?: string }) =>
					step.name === 'Validate dispatched PR title',
			),
		).toBe(true);
		expect(
			standardsConfig.jobs['pr-standards'].steps.some(
				(step: { name?: string }) =>
					step.name === 'Validate dispatched PR contract',
			),
		).toBe(true);
		expect(standardsWorkflow).toContain(
			'gh api "repos/${GITHUB_REPOSITORY}/pulls/${PR_NUMBER}"',
		);
	});

	test('enforces the bounded retention audit in drift CI', () => {
		expect(driftWorkflow).toContain(
			'node scripts/release-notes-fragments.mjs verify-retention',
		);
	});
});
