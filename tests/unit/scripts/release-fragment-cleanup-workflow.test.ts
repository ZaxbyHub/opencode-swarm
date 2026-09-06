import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { bashCommand } from '../../helpers/bash';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

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
const tempRoots: string[] = [];

afterEach(() => {
	for (const root of tempRoots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

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
		expect(releaseWorkflow).toContain(
			'git diff --name-only "$parent_sha" "$remote_sha"',
		);
		expect(releaseWorkflow).toContain('cut -c4-');
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
		expect(releaseWorkflow).toContain(
			'gh workflow run drift-check.yml --ref "$branch"',
		);
		expect(releaseWorkflow).toContain('--base main');
		expect(releaseWorkflow).toContain('baseRefName,headRefOid');
		expect(releaseWorkflow).toContain('wait_for_dispatched_run()');
		expect(releaseWorkflow).toContain(
			'--json databaseId,url,headSha,createdAt,status,conclusion',
		);
		expect(releaseWorkflow).toContain('run_status" = "completed"');
		expect(releaseWorkflow).toContain('run_conclusion" != "success"');
		expect(releaseWorkflow).toContain(
			'Cleanup PR body violates the PR contract.',
		);
		expect(releaseWorkflow).toContain('CI run $ci_run_id: $ci_run_url');
		expect(releaseWorkflow).toContain(
			'PR Standards run $standards_run_id: $standards_run_url',
		);
		expect(releaseWorkflow).toContain(
			'Drift/retention run $drift_run_id: $drift_run_url',
		);
		expect(ciWorkflow).toMatch(/on:\s*\n\s+workflow_dispatch:/);
		expect(standardsWorkflow).toMatch(/on:\s*\n\s+workflow_dispatch:/);
		expect(driftWorkflow).toMatch(/on:\s*\n\s+workflow_dispatch:/);
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
		expect(standardsWorkflow).toContain('head_sha');
		expect(standardsWorkflow).toContain('$GITHUB_SHA');
		for (let invariant = 1; invariant <= 12; invariant += 1) {
			expect(releaseWorkflow).toContain(`- ${invariant} (`);
		}
		expect(releaseWorkflow).not.toContain('- 1-2:');
		expect(releaseWorkflow).not.toContain('- 4-11:');
	});

	test('executes the dispatched-run success gate (FB-004/FB-006) against a completed-success fixture', () => {
		const start = releaseWorkflow.indexOf(
			'          wait_for_dispatched_run() {',
		);
		const end = releaseWorkflow.indexOf('          ci_record=', start);
		expect(start).toBeGreaterThan(-1);
		expect(end).toBeGreaterThan(start);
		const functionSource = releaseWorkflow
			.slice(start, end)
			.replace(/^ {10}/gm, '');
		const root = canonicalMkdtemp('release-workflow-gate-');
		tempRoots.push(root);
		const script = path.join(root, 'probe.sh');
		writeFileSync(
			script,
			[
				'set -euo pipefail',
				'gh() { printf "123\\thttps://example.invalid/run\\tdeadbeef\\tcompleted\\tsuccess\\n"; }',
				'head_sha=deadbeef',
				'branch=chore/release-fragments-test',
				'dispatch_after=2026-01-01T00:00:00Z',
				functionSource,
				'wait_for_dispatched_run ci.yml',
			].join('\n'),
			'utf8',
		);
		const result = Bun.spawnSync({
			cmd: bashCommand(script),
			cwd: root,
			stdin: 'ignore',
			stdout: 'pipe',
			stderr: 'pipe',
			timeout: 15_000,
		});
		expect(result.exitCode).toBe(0);
		expect(result.stdout.toString()).toContain('completed\tsuccess');
	});

	test('enforces the bounded retention audit in drift CI', () => {
		expect(driftWorkflow).toContain(
			'node scripts/release-notes-fragments.mjs verify-retention',
		);
	});
});
