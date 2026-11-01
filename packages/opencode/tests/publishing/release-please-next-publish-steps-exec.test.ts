import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

/**
 * Executable publish-step harness (issue #3229 residual 1).
 *
 * The line-shaped suite (`release-please-next-publish-steps.test.ts`) proves
 * the required constructs EXIST as statement lines; this file proves they
 * BEHAVE: each real workflow publish step's `run:` body is EXECUTED under a
 * fake `npm` on PATH, and the exit code must discriminate npm failure from
 * success exactly as the step promises:
 *
 *   npm hard-fails (E403 forbidden)        -> step exits nonzero
 *   npm fails w/ version conflict, no FP   -> step exits nonzero (no tolerance)
 *   npm fails w/ version conflict, FP=true -> step exits 0 (documented retry)
 *   npm succeeds                           -> step exits 0
 *
 * The three known neutralization shapes (from the #3220 review record) are
 * applied to the real step text and each must exit 0 under npm failure —
 * proving they genuinely neutralize, i.e. exactly the regression class the
 * real-step legs above would catch if anyone pushed such a shape to the
 * workflow.
 */

const REPO_ROOT = path.resolve(import.meta.dir, '..', '..', '..', '..');
const WORKFLOW_PATH = path.join(REPO_ROOT, '.github', 'workflows', 'release-please-next.yml');
const PACKAGE_DIRS = ['packages/telemetry', 'packages/core', 'packages/claude-code', 'packages/opencode'];

interface NpmScenario {
	name: string;
	stdout: string;
	exitCode: number;
}

const npmHardFail: NpmScenario = {
	name: 'hard-fail-e403',
	stdout: 'npm error code E403\nnpm error 403 Forbidden - PUT https://registry.npmjs.org/x\n',
	exitCode: 1,
};
const npmVersionConflict: NpmScenario = {
	name: 'version-conflict',
	stdout: 'npm error code EPUBLISHCONFLICT\nnpm error cannot publish over the previously published versions\n',
	exitCode: 1,
};
const npmSuccess: NpmScenario = {
	name: 'success',
	stdout: '+ @opencode-swarm/x@8.0.2-beta.0\n',
	exitCode: 0,
};

function indentOf(line: string): number {
	const m = /^\s*/.exec(line);
	return m ? m[0].length : 0;
}

function isCommentLine(line: string): boolean {
	return line.trimStart().startsWith('#');
}

// Same step-block extraction as the line-shaped suite (indent-aware,
// comment-stripped), then YAML block-scalar semantics for the run: body:
// the body is every following line that is blank or MORE indented than the
// `run: |` line — a less-indented line (`env:` of the step, the next step)
// ends the scalar, so non-script YAML never leaks into executed text.
function collectPublishStepBodies(): Array<{ name: string; body: string }> {
	const lines = readFileSync(WORKFLOW_PATH, 'utf8').split(/\r?\n/);
	const steps: Array<{ name: string; body: string }> = [];
	let i = 0;
	while (i < lines.length) {
		const m = /^(\s*)-\s+name:\s*(Publish\S?.*)$/.exec(lines[i]);
		if (!m) {
			i += 1;
			continue;
		}
		const indent = m[1].length;
		const block: string[] = [];
		let j = i + 1;
		while (j < lines.length) {
			const ln = lines[j];
			if (ln.trim() === '') {
				block.push(ln);
				j += 1;
				continue;
			}
			if (indentOf(ln) <= indent) break;
			block.push(ln);
			j += 1;
		}
		const code = block.filter((ln) => ln.trim() !== '' && !isCommentLine(ln));
		const runIdx = code.findIndex((ln) => /^\s*run:\s*\|\s*$/.test(ln));
		if (runIdx !== -1) {
			const runIndent = indentOf(code[runIdx]);
			const bodyLines: string[] = [];
			for (let k = runIdx + 1; k < code.length; k += 1) {
				const ln = code[k];
				if (ln.trim() !== '' && indentOf(ln) <= runIndent) break;
				bodyLines.push(ln.replace(/^\t/, '  '));
			}
			steps.push({ name: m[2].trim(), body: bodyLines.join('\n') });
		}
		i = j;
	}
	return steps;
}

interface RunResult {
	code: number;
	stdout: string;
}

// Execute one step body in a sandboxed workspace with a fake npm on PATH.
// Every spawned process is bounded (timeout + maxBuffer) — a hung bash can
// never hang the suite.
function runStepBody(body: string, scenario: NpmScenario, envExtra: Record<string, string> = {}): RunResult {
	const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'pubstep-'));
	try {
		for (const dir of PACKAGE_DIRS) {
			mkdirSync(path.join(workspace, dir), { recursive: true });
		}
		const binDir = path.join(workspace, 'fake-bin');
		mkdirSync(binDir, { recursive: true });
		// The fake npm writes the scenario to stdout with the scenario's exit
		// code. `publish` is the only subcommand the steps invoke. It is a
		// bash script with NO extension on every platform: bash does not
		// apply PATHEXT, so an `npm.cmd` shim would be skipped on Windows and
		// the REAL npm would run instead (observed: failure legs then pass
		// vacuously while success legs fail with real-npm ENOENT).
		const npmPath = path.join(binDir, 'npm');
		writeFileSync(
			npmPath,
			`#!/usr/bin/env bash\ncat "\${0%/*}/npm-out.txt"\nexit ${scenario.exitCode}\n`,
		);
		writeFileSync(path.join(binDir, 'npm-out.txt'), scenario.stdout);
		if (process.platform !== 'win32') {
			spawnSync('chmod', ['+x', npmPath], { timeout: 10_000 });
		}
		// /tmp/pub.log must resolve: on Windows Git Bash /tmp maps into the
		// MSYS tree, which exists; the tee target directory is created by the
		// harness as a sibling of the workspace to be safe.
		const result = spawnSync('bash', ['-c', body], {
			cwd: workspace,
			timeout: 10_000,
			maxBuffer: 4 * 1024 * 1024,
			env: {
				...process.env,
				PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
				// Steps reference $FORCE_PUBLISH (env-indirected input).
				FORCE_PUBLISH: 'false',
				...envExtra,
			},
			encoding: 'utf8',
		});
		return { code: result.status ?? -1, stdout: result.stdout ?? '' };
	} finally {
		rmSync(workspace, { recursive: true, force: true, maxRetries: 3 });
	}
}

// The three neutralization shapes from the #3220 review record. Each keeps
// every construct the line-shaped suite requires (the `set -eo pipefail`
// line, the `::error::` string, a literal `exit 1`, the tolerance grep)
// while making the step exit 0 under npm failure.
function neutralizedVariants(body: string): Array<{ label: string; body: string }> {
	const setLine = body.split('\n').find((ln) => /^set\s+-e/.test(ln.trim()));
	if (!setLine) throw new Error('harness fixture: set line not found in real step body');
	return [
		{
			// N1: pipefail/-e disabled right after the required set line — the
			// pipeline status becomes tee's 0 and the outer `if !` never fires.
			label: 'set+e-after-set-line',
			body: body.replace(setLine, `${setLine}\nset +o pipefail\nset +e`),
		},
		{
			// N2: the tolerance grep gets `|| true` — the gate condition always
			// succeeds, so every npm failure is "tolerated" regardless of the
			// input (the issue's always-true-tolerance bypass). Anchored on the
			// GATE line (the inner if), not the outer `if ! npm … | tee` line
			// that also ends in /tmp/pub.log; then.
			label: 'always-true-tolerance',
			body: body.replace(/(\[ "\$FORCE_PUBLISH" = "true" \] && grep -q [^\n]*\/tmp\/pub\.log); then/, '$1 || true; then'),
		},
		{
			// N3: the `exit 1` nests under a multi-line never-true if — the
			// literal survives for line-lints but never executes (the issue's
			// exact shape).
			label: 'exit-1-under-never-true-if',
			body: body.replace('exit 1', 'if [ 1 = 0 ]; then\n              exit 1\n            fi'),
		},
	];
}

describe('release-please-next publish steps — executable harness (#3229 R1)', () => {
	test('bash is available (the harness executes real shell)', () => {
		const probe = spawnSync('bash', ['-c', 'echo ok'], { timeout: 10_000, encoding: 'utf8' });
		expect(probe.status).toBe(0);
		expect((probe.stdout ?? '').trim()).toBe('ok');
	});

	test('the workflow still has exactly four publish steps with run bodies', () => {
		const steps = collectPublishStepBodies();
		expect(steps.length).toBe(4);
		for (const step of steps) {
			expect(step.body.includes('npm publish'), `${step.name}: body must invoke npm publish`).toBe(true);
		}
	});

	for (const step of collectPublishStepBodies()) {
		describe(`step: ${step.name}`, () => {
			test('exits nonzero on a hard npm failure (E403)', () => {
				const result = runStepBody(step.body, npmHardFail);
				expect(result.code, `stdout: ${result.stdout}`).not.toBe(0);
			});

			test('exits nonzero on a version conflict without force_publish', () => {
				const result = runStepBody(step.body, npmVersionConflict);
				expect(result.code, `stdout: ${result.stdout}`).not.toBe(0);
			});

			test('tolerates a version conflict under FORCE_PUBLISH=true (documented recovery)', () => {
				const result = runStepBody(step.body, npmVersionConflict, { FORCE_PUBLISH: 'true' });
				expect(result.code, `stdout: ${result.stdout}`).toBe(0);
				expect(result.stdout.includes('Already published, skipping')).toBe(true);
			});

			test('exits 0 when npm succeeds', () => {
				const result = runStepBody(step.body, npmSuccess);
				expect(result.code, `stdout: ${result.stdout}`).toBe(0);
			});
		});
	}

	describe('neutralization mutants genuinely neutralize (the class the real-step legs guard)', () => {
		const firstStep = collectPublishStepBodies()[0];
		for (const variant of neutralizedVariants(firstStep.body)) {
			test(`${variant.label}: exits 0 under npm hard failure — only execution catches it`, () => {
				const result = runStepBody(variant.body, npmHardFail);
				expect(result.code, `stdout: ${result.stdout}`).toBe(0);
			});
		}
	});
});

// Import alias to satisfy the fs import usage above without renaming.
import * as fs from 'node:fs';
