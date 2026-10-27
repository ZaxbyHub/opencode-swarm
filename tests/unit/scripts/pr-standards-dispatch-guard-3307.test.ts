import { afterAll, describe, expect, test } from 'bun:test';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { parse } from 'yaml';
import { bashCommand } from '../../helpers/bash';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

/**
 * Issue #3307 AC1: the workflow_dispatch `pr_number` input is an unvalidated
 * string that both dispatched run blocks interpolate into `gh api` REST
 * paths. Each surface must refuse a non-decimal value BEFORE any gh call —
 * proven here by executing the REAL extracted run blocks with a call-recording
 * gh stub (a numeric seed must still reach gh, so the guard is not
 * over-broad). The changed_files non-integer guard (AC2/#3297) is pinned in
 * fragment-gate-workflow-contract.test.ts; the concurrency and posture pins
 * live in workflow-hardening.test.ts.
 */

const root = path.resolve(import.meta.dir, '../../..');
const workflow = parse(
	readFileSync(
		path.join(root, '.github', 'workflows', 'pr-standards.yml'),
		'utf8',
	),
);

const createdTempDirs: string[] = [];

afterAll(() => {
	for (const dir of createdTempDirs) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function stepRun(jobName: string, stepName: string): string {
	const steps: Array<{ name?: string; run?: string }> =
		workflow.jobs[jobName].steps;
	const step = steps.find((s) => s.name === stepName);
	if (typeof step?.run !== 'string')
		throw new Error(`step not found: ${stepName}`);
	return step.run;
}

/** Runs an extracted dispatch block with the stubbed gh and given PR_NUMBER. */
function runDispatchBlock(
	block: string,
	prNumber: string,
	rawChangedFiles?: string,
): { exitCode: number; stdout: string; ghCalls: string } {
	const dir = canonicalMkdtemp('dispatch-guard-3307-');
	createdTempDirs.push(dir);
	const ghLog = path.join(dir, 'gh-calls.log');
	const prJson =
		'{"title":"fix: seeded title","state":"open","base":{"ref":"main"},' +
		`"changed_files":${rawChangedFiles ?? 2},` +
		'"head":{"sha":"deadbeefcafe"},"body":"## Summary\\n\\n## Invariant audit\\n\\n## Test plan\\n"}';
	const script = [
		'set -uo pipefail',
		`PR_NUMBER='${prNumber.replace(/'/g, "'\\''")}'`,
		'GITHUB_REPOSITORY=example/example',
		'GITHUB_SHA=deadbeefcafe',
		'GH_TOKEN=dummy',
		`PR_JSON='${prJson}'`,
		`GH_LOG='${ghLog.replace(/'/g, "'\\''")}'`,
		': > "$GH_LOG"',
		'gh() {',
		'  printf \'%s\\n\' "$*" >> "$GH_LOG"',
		'  case "$*" in',
		"    *'repos/'*'/pulls/'*) printf '%s\\n' \"$PR_JSON\"; return 0;;",
		'    *) return 0;;',
		'  esac',
		'}',
		'set +e',
		block,
	].join('\n');
	const proc = Bun.spawnSync({
		cmd: bashCommand('-c', script),
		cwd: root,
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
		timeout: 30_000,
	});
	return {
		exitCode: proc.exitCode ?? 1,
		stdout: proc.stdout.toString(),
		ghCalls: readFileSync(ghLog, 'utf8'),
	};
}

describe('dispatched pr_number guard (#3307, both surfaces)', () => {
	const surfaces: Array<[string, string]> = [
		['check-title', 'Validate dispatched PR title'],
		['pr-standards', 'Validate dispatched PR contract'],
	];

	for (const [jobName, stepName] of surfaces) {
		const block = stepRun(jobName, stepName);

		test(`${jobName}: the guard precedes the first gh api call`, () => {
			const lines = block.split('\n');
			const guardIndex = lines.findIndex((l) => l.includes('*[!0-9]*'));
			// Match the invocation form, not the word: the guard's own comment
			// mentions "gh api" before the case statement.
			const ghIndex = lines.findIndex((l) => l.includes('$(gh api'));
			expect(guardIndex).toBeGreaterThan(-1);
			expect(ghIndex).toBeGreaterThan(guardIndex);
		});

		test(`${jobName}: non-numeric pr_number fails before any gh call`, () => {
			for (const bad of ['12x7', '']) {
				const result = runDispatchBlock(block, bad);
				expect(result.exitCode).not.toBe(0);
				expect(result.ghCalls).toBe('');
			}
		});

		test(`${jobName}: numeric pr_number reaches gh (guard not over-broad)`, () => {
			const result = runDispatchBlock(block, '4321');
			expect(result.ghCalls).toContain('repos/example/example/pulls/4321');
		});
	}

	// PRR-011: the non-integer changed_files guard pin in
	// fragment-gate-workflow-contract.test.ts covers only the null shape;
	// these siblings (fractional, signed) are exercised here so the guard's
	// full rejection surface is pinned without growing the 499-line contract
	// file past the FR-006 cap.
	test('dispatched arm: fractional and signed changed_files fail closed', () => {
		const prStandardsBlock = stepRun(
			'pr-standards',
			'Validate dispatched PR contract',
		);
		for (const raw of ['3.5', '-1']) {
			const result = runDispatchBlock(prStandardsBlock, '4321', raw);
			expect(result.exitCode).not.toBe(0);
			expect(result.stdout).toContain('non-integer changed_files');
		}
	});
});
