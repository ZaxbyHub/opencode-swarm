import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { load as parse } from 'js-yaml';
import { main } from '../../../scripts/check-workflow-timeouts';
import { bashCommand } from '../../helpers/bash';
import { safeRmRecursive } from '../../helpers/safe-test-dir';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

/**
 * Issue #3259 (#2952 residual): the cleanup job's ci.yml wait must cover the
 * dispatched run's 40-minute per-shard ceiling — budget 480 x 5 s = 40 min,
 * `# target-duration: 40`, and the dispatched ci.yml `unit` matrix job itself
 * declares `timeout-minutes: 40`. The coupled job timeout must then cover the
 * new sum: 3,600 s declared -> required ceil(3,600 x 1.2) + 300 = 4,620 s =
 * 77 min -> `timeout-minutes: 80`. RED at the pre-fix 360 x 5 / target-30 /
 * timeout-70 shape (live-file pins and the PRR-012 probe fail there), GREEN
 * after. Fixture-copy tests stay shape-independent either way.
 */

const root = path.resolve(import.meta.dir, '../../..');
const releaseWorkflow = fs.readFileSync(
	path.join(root, '.github/workflows/release-and-publish.yml'),
	'utf8',
);
const ciWorkflow = fs.readFileSync(
	path.join(root, '.github/workflows/ci.yml'),
	'utf8',
);

interface WorkflowJob {
	'timeout-minutes'?: number;
	steps?: { name?: string }[];
}
interface WorkflowFile {
	jobs: Record<string, WorkflowJob>;
}
const ciConfig = parse(ciWorkflow) as WorkflowFile;
const releaseConfig = parse(releaseWorkflow) as WorkflowFile;

const roots: string[] = [];

afterEach(() => {
	for (const r of roots.splice(0)) safeRmRecursive(r);
});

function makeWorkflowRepo(text: string): string {
	const repo = canonicalMkdtemp('workflow-timeouts-3259-');
	roots.push(repo);
	const dir = path.join(repo, '.github', 'workflows');
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, 'release-and-publish.yml'), text);
	return repo;
}

function runMain(
	argv: string[] = [],
	scanRoot: string,
): { code: number; out: string } {
	const original = console.log;
	let out = '';
	console.log = (message: string) => {
		out += `${message}\n`;
	};
	try {
		const code = main(argv, scanRoot);
		return { code, out };
	} finally {
		console.log = original;
	}
}

// The post-#3259 shipped helper shape: ci.yml wait raised to 480 x 5 s under
// `# target-duration: 40`, sibling waits unchanged at 120 x 5 s, coupled job
// timeout 80. Sum 2,400 + 600 + 600 = 3,600 s -> required 4,620 s (77 min).
const SHIPPED_SHAPE_3259 = `name: release
on:
  workflow_dispatch:
jobs:
  cleanup-release-fragments:
    runs-on: ubuntu-latest
    timeout-minutes: 80
    steps:
      - name: Wait
        run: |
          wait_for_dispatched_run() {
            workflow="$1"
            max_attempts="\${2:-120}"
            poll_seconds="\${3:-5}"
            for _attempt in $(seq 1 "$max_attempts"); do
              gh run list >/dev/null
              sleep "$poll_seconds"
            done
          }
          # target-duration: 40
          ci_record="$(wait_for_dispatched_run ci.yml 480 5)"
          # target-duration: 10
          standards_record="$(wait_for_dispatched_run pr-standards.yml 120 5)"
          # target-duration: 10
          drift_record="$(wait_for_dispatched_run drift-check.yml 120 5)"
`;

describe('check-workflow-timeouts (#3259 ci.yml ceiling coupling)', () => {
	test('reds when the budget rises but the timeout is left at 70 (AC2)', () => {
		const stale = SHIPPED_SHAPE_3259.replace(
			'timeout-minutes: 80',
			'timeout-minutes: 70',
		);
		const repo = makeWorkflowRepo(stale);
		const { code, out } = runMain([], repo);
		expect(code).toBe(1);
		expect(out).toContain('timeout-below-wait-sum');
		expect(out).toContain('sum waits 3600s x 1.2 + 5min margin');
		expect(out).toContain('timeout 70min (4200s) < required 4620s');
	});

	test('reds when the ci.yml budget stays at the old 360 x 5 under target 40 (AC1)', () => {
		const underfunded = SHIPPED_SHAPE_3259.replace(
			'# target-duration: 40\n          ci_record="$(wait_for_dispatched_run ci.yml 480 5)"',
			'# target-duration: 40\n          ci_record="$(wait_for_dispatched_run ci.yml 360 5)"',
		);
		const repo = makeWorkflowRepo(underfunded);
		const { code, out } = runMain([], repo);
		expect(code).toBe(1);
		expect(out).toContain('budget-below-target');
		expect(out).toContain('30min (360x5s) < declared target-duration 40min');
	});

	test('greens on the post-#3259 shipped shape', () => {
		const repo = makeWorkflowRepo(SHIPPED_SHAPE_3259);
		const { code, out } = runMain([], repo);
		expect(code).toBe(0);
		expect(out).toContain('pass (0 finding(s), 1 workflow file(s)');
	});

	test('ratchet: live workflows scan green with the new ci.yml wait (AC1/AC2)', () => {
		const { code, out } = runMain([], root);
		expect(code).toBe(0);
		expect(out).toContain('pass (0 finding(s)');
		expect(releaseWorkflow).toContain('# target-duration: 40');
		expect(releaseWorkflow).toContain('wait_for_dispatched_run ci.yml 480 5');
		// AC1's ceiling half: the dispatched ci.yml unit matrix job's own
		// declared ceiling must not exceed the wait's budget minutes.
		const unitTimeout = ciConfig.jobs.unit?.['timeout-minutes'];
		expect(unitTimeout).toBe(40);
		expect((480 * 5) / 60).toBeGreaterThanOrEqual(unitTimeout ?? 0);
	});

	test('ratchet: sibling waits and release-health-summary untouched (AC3)', () => {
		expect(releaseWorkflow).toContain(
			'wait_for_dispatched_run pr-standards.yml 120 5',
		);
		expect(releaseWorkflow).toContain(
			'wait_for_dispatched_run drift-check.yml 120 5',
		);
		const siblingDirectives = releaseWorkflow.match(/# target-duration: 10/g);
		expect(siblingDirectives).toHaveLength(2);
		const healthSummary = releaseConfig.jobs['release-health-summary'];
		expect(healthSummary?.['timeout-minutes']).toBe(3);
		expect(
			healthSummary?.steps?.some(
				(step) => step.name === 'Report release job conclusions',
			),
		).toBe(true);
	});

	test('PRR-012: the wait helper rejects non-numeric budgets, never false-times-out', () => {
		const start = releaseWorkflow.indexOf(
			'          wait_for_dispatched_run() {',
		);
		const end = releaseWorkflow.indexOf('          ci_record=', start);
		expect(start).toBeGreaterThan(-1);
		expect(end).toBeGreaterThan(start);
		const functionSource = releaseWorkflow
			.slice(start, end)
			.replace(/^ {10}/gm, '');

		const probeWith = (call: string) => {
			const dir = canonicalMkdtemp('release-workflow-guard-');
			roots.push(dir);
			const script = path.join(dir, 'probe.sh');
			fs.writeFileSync(
				script,
				[
					'set -euo pipefail',
					'gh() { printf "123\\thttps://example.invalid/run\\tdeadbeef\\tcompleted\\tsuccess\\n"; }',
					'head_sha=deadbeef',
					'branch=chore/release-fragments-test',
					'dispatch_after=2026-01-01T00:00:00Z',
					functionSource,
					call,
				].join('\n'),
				'utf8',
			);
			return Bun.spawnSync({
				cmd: bashCommand(script),
				cwd: dir,
				stdin: 'ignore',
				stdout: 'pipe',
				stderr: 'pipe',
				timeout: 15_000,
			});
		};

		const badAttempts = probeWith(
			'wait_for_dispatched_run ci.yml not-a-number 5',
		);
		expect(badAttempts.exitCode).toBe(1);
		const badAttemptsErr = badAttempts.stderr.toString();
		expect(badAttemptsErr).toContain('non-numeric max_attempts');
		expect(badAttemptsErr).not.toContain('Timed out');

		const badSleep = probeWith('wait_for_dispatched_run ci.yml 480 five');
		expect(badSleep.exitCode).toBe(1);
		const badSleepErr = badSleep.stderr.toString();
		expect(badSleepErr).toContain('non-numeric poll_seconds');
		expect(badSleepErr).not.toContain('Timed out');
	});
});
