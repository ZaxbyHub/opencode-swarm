import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

/**
 * #2498 pipeline driver contract tests: pure branch derivation, dry-run
 * evidence bundle + idempotency, oversight pause exit code, and the
 * failed-gate publish gate (CI_EXIT ordering + observable publish decision).
 */

const PIPELINE = path.join(
	import.meta.dir,
	'..',
	'..',
	'..',
	'scripts',
	'swarm-implement-pipeline.sh',
);

const PIPELINE_SOURCE = readFileSync(PIPELINE, 'utf8');

function makeDemoRepo(): string {
	const repo = canonicalMkdtemp('swarm-implement-pipeline-');
	execFileSync('git', ['init', '-q', repo]);
	execFileSync('git', [
		'-C',
		repo,
		'config',
		'user.email',
		'test@example.invalid',
	]);
	execFileSync('git', ['-C', repo, 'config', 'user.name', 'pipeline-test']);
	execFileSync('git', [
		'-C',
		repo,
		'commit',
		'--allow-empty',
		'-m',
		'demo base',
	]);
	return repo;
}

function runPipeline(
	repo: string,
	args: string[],
	env: Record<string, string> = {},
): { status: number; stdout: string; stderr: string } {
	try {
		const stdout = execFileSync('bash', [PIPELINE, ...args], {
			cwd: repo,
			env: { ...process.env, ...env },
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		return { status: 0, stdout, stderr: '' };
	} catch (error) {
		const err = error as {
			status?: number;
			stdout?: string;
			stderr?: string;
		};
		return {
			status: err.status ?? -1,
			stdout: err.stdout ?? '',
			stderr: err.stderr ?? '',
		};
	}
}

describe('swarm-implement pipeline driver (#2498)', () => {
	test('branch derivation is pure, cwd-independent, and stable across calls', () => {
		const elsewhere = canonicalMkdtemp('swarm-impl-elsewhere-');
		const fromRepo = runPipeline(elsewhere, ['branch', '2498']);
		const again = runPipeline(elsewhere, ['branch', '2498']);
		const otherIssue = runPipeline(elsewhere, ['branch', '4242']);
		expect(fromRepo.status).toBe(0);
		expect(fromRepo.stdout).toBe('swarm/implement-2498\n');
		expect(again.stdout).toBe(fromRepo.stdout);
		expect(otherIssue.stdout).toBe('swarm/implement-4242\n');
	}, 30000);

	test('dry run creates the branch, evidence bundle, and PR body; second run is idempotent', () => {
		const repo = makeDemoRepo();
		const first = runPipeline(repo, ['1234'], { SWARM_PIPELINE_DRY_RUN: '1' });
		expect(first.status).toBe(0);
		const branchList = execFileSync('git', [
			'-C',
			repo,
			'for-each-ref',
			'--format=%(refname:short)',
			'refs/heads/',
		]).toString();
		expect(
			branchList.split('\n').filter((b) => b === 'swarm/implement-1234').length,
		).toBe(1);

		const phases = readFileSync(
			path.join(repo, '.swarm/pipeline-evidence/phases.txt'),
			'utf8',
		);
		for (const token of ['ingest', 'spec', 'plan', 'review']) {
			expect(phases.toLowerCase()).toContain(token);
		}
		const body = readFileSync(
			path.join(repo, '.swarm/pipeline-evidence/pr-body.md'),
			'utf8',
		);
		expect(/^#+.*plan/im.test(body)).toBe(true);
		expect(/^#+.*gate/im.test(body)).toBe(true);
		expect(/^#+.*oversight/im.test(body)).toBe(true);

		const second = runPipeline(repo, ['1234'], { SWARM_PIPELINE_DRY_RUN: '1' });
		expect(second.status).toBe(0);
		const branchesAfter = execFileSync('git', [
			'-C',
			repo,
			'for-each-ref',
			'--format=%(refname:short)',
			'refs/heads/',
		]).toString();
		expect(
			branchesAfter.split('\n').filter((b) => b === 'swarm/implement-1234')
				.length,
		).toBe(1);
	}, 60000);

	test('simulated oversight pause exits 10 with the OVERSIGHT_PAUSE marker', () => {
		const repo = makeDemoRepo();
		const result = runPipeline(repo, ['1234'], {
			SWARM_PIPELINE_DRY_RUN: '1',
			SWARM_DRY_RUN_PAUSE: '1',
		});
		expect(result.status).toBe(10);
		expect(result.stdout).toContain('OVERSIGHT_PAUSE:');
	}, 30000);

	test('failed gate handling: violations block publishing and the publish step is gated in source order', () => {
		// Observable behavior: a stubbed violations verdict exits nonzero and
		// records that publishing did not happen.
		const repo = makeDemoRepo();
		const result = runPipeline(repo, ['1234'], {
			SWARM_PIPELINE_DRY_RUN: '1',
			SWARM_DRY_RUN_CI_EXIT: '1',
		});
		expect(result.status).toBe(1);
		expect(
			existsSync(
				path.join(repo, '.swarm/pipeline-evidence/publish-decision.txt'),
			),
		).toBe(false);
		expect(
			readFileSync(
				path.join(repo, '.swarm/pipeline-evidence/run-status.txt'),
				'utf8',
			),
		).toContain('no PR published');

		// Differential positive control: the passing stub records a ready
		// publish decision, proving the gate discriminates rather than
		// always blocking.
		const okRepo = makeDemoRepo();
		const ok = runPipeline(okRepo, ['1234'], {
			SWARM_PIPELINE_DRY_RUN: '1',
			SWARM_DRY_RUN_CI_EXIT: '0',
		});
		expect(ok.status).toBe(0);
		expect(
			readFileSync(
				path.join(okRepo, '.swarm/pipeline-evidence/publish-decision.txt'),
				'utf8',
			),
		).toContain('publish=ready');

		// Source-order contract (frozen by C8): the CI_EXIT guard line
		// strictly precedes the single-line gh pr create.
		const lines = PIPELINE_SOURCE.split('\n');
		const guardLine = lines.findIndex((l) =>
			/(if|case|test).*CI_EXIT|CI_EXIT.*(-eq|-ne)/.test(l),
		);
		const createLine = lines.findIndex((l) => l.includes('gh pr create'));
		expect(guardLine).toBeGreaterThan(-1);
		expect(createLine).toBeGreaterThan(guardLine);
	}, 60000);
});
