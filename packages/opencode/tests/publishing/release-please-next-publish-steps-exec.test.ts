import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

/**
 * Executable publish-step harness (issue #3229 residual 1).
 *
 * The line-shaped suite proves the required constructs EXIST as statement
 * lines; this file proves they BEHAVE: each real workflow publish step's
 * `run:` body is EXECUTED under a fake `npm` on PATH whose surface matches
 * the real npm's (argv recorded; error text on STDERR — npm writes errors
 * to stderr, and the steps' `2>&1 | tee` merge is load-bearing for the
 * version-conflict tolerance grep), and the exit codes must discriminate
 * npm failure / version-conflict / tolerance / success exactly as the step
 * promises.
 *
 * The harness resolves the workflow path through RELEASE_PLEASE_NEXT_WORKFLOW
 * (injection seam) so mutation legs can run the suite against a mutated COPY
 * of the workflow and prove the legs actually catch the three known
 * neutralization shapes (review PRR-003/FB-2) plus a `--tag latest` and a
 * lost `2>&1` regression.
 */

const REPO_ROOT = path.resolve(import.meta.dir, '..', '..', '..', '..');
const DEFAULT_WORKFLOW_PATH = path.join(REPO_ROOT, '.github', 'workflows', 'release-please-next.yml');
// Injection seam (review PRR-020e): mutation legs point this at a temp copy.
const WORKFLOW_PATH = process.env.RELEASE_PLEASE_NEXT_WORKFLOW ?? DEFAULT_WORKFLOW_PATH;
const PACKAGE_DIRS = ['packages/telemetry', 'packages/core', 'packages/claude-code', 'packages/opencode'];
/** The exact npm argv contract every publish step must invoke. */
const EXPECTED_NPM_ARGS = 'publish --tag next --access public';

interface NpmScenario {
	name: string;
	stdout: string;
	stderr: string;
	exitCode: number;
}

const npmHardFail: NpmScenario = {
	name: 'hard-fail-e403',
	stdout: '',
	stderr: 'npm error code E403\nnpm error 403 Forbidden - PUT https://registry.npmjs.org/x\n',
	exitCode: 1,
};
const npmVersionConflict: NpmScenario = {
	name: 'version-conflict',
	stdout: '',
	stderr: 'npm error code EPUBLISHCONFLICT\nnpm error cannot publish over the previously published versions\n',
	exitCode: 1,
};
const npmSuccess: NpmScenario = {
	name: 'success',
	stdout: '+ @opencode-swarm/x@8.0.2-beta.0\n',
	stderr: '',
	exitCode: 0,
};

function indentOf(line: string): number {
	const m = /^\s*/.exec(line);
	return m ? m[0].length : 0;
}

function isCommentLine(line: string): boolean {
	return line.trimStart().startsWith('#');
}

// Step-block extraction (indent-aware, comment-stripped) with YAML
// block-scalar semantics for the run: body: the body is every following
// line that is blank or MORE indented than the `run: |` line — a
// less-indented line (the step's `env:`, the next step) ends the scalar,
// so non-script YAML never leaks into executed text.
function collectPublishStepBodies(workflowPath = WORKFLOW_PATH): Array<{ name: string; body: string }> {
	const lines = readFileSync(workflowPath, 'utf8').split(/\r?\n/);
	const steps: Array<{ name: string; body: string }> = [];
	let i = 0;
	while (i < lines.length) {
		const m = /^(\s*)-\s+name:\s*(Publish\S?.*)$/.exec(lines[i]);
		if (!m) {
			i += 1;
			continue;
		}
		const stepIndent = m[1].length;
		const block: string[] = [];
		let j = i + 1;
		while (j < lines.length) {
			const ln = lines[j];
			if (ln.trim() === '') {
				block.push(ln);
				j += 1;
				continue;
			}
			if (indentOf(ln) <= stepIndent) break;
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
	/** Recorded argv of every fake-npm invocation (one line per call). */
	argsLog: string;
}

// Execute one step body in a sandboxed workspace with the fake npm on PATH.
// The shim records its argv (one line per invocation) and emits error text
// on STDERR (real npm behavior) — a step that loses its `2>&1` merge into
// the tee'd pub.log therefore fails the tolerance leg exactly as it would
// in production. Every spawned process is bounded (10 s timeout, 4 MiB
// maxBuffer) — a hung bash can never hang the suite.
function runStepBody(body: string, scenario: NpmScenario, envExtra: Record<string, string> = {}): RunResult {
	const workspace = mkdtempSync(path.join(os.tmpdir(), 'pubstep-'));
	try {
		for (const dir of PACKAGE_DIRS) {
			mkdirSync(path.join(workspace, dir), { recursive: true });
		}
		const binDir = path.join(workspace, 'fake-bin');
		mkdirSync(binDir, { recursive: true });
		const npmPath = path.join(binDir, 'npm');
		// Extensionless bash script on every platform: bash does not apply
		// PATHEXT, so an npm.cmd shim would be skipped on Windows and the
		// REAL npm would run instead (observed: failure legs pass vacuously
		// while success legs fail with real-npm ENOENT).
		writeFileSync(
			npmPath,
			`#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "\${0%/*}/npm-args.log"\nif [ -s "\${0%/*}/npm-err.txt" ]; then cat "\${0%/*}/npm-err.txt" >&2; fi\ncat "\${0%/*}/npm-out.txt"\nexit ${scenario.exitCode}\n`,
		);
		writeFileSync(path.join(binDir, 'npm-out.txt'), scenario.stdout);
		writeFileSync(path.join(binDir, 'npm-err.txt'), scenario.stderr);
		writeFileSync(path.join(binDir, 'npm-args.log'), '');
		if (process.platform !== 'win32') {
			spawnSync('chmod', ['+x', npmPath], { timeout: 10_000 });
		}
		// /tmp/pub.log resolves under Git Bash's MSYS tree on Windows.
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
		const argsLog = readFileSync(path.join(binDir, 'npm-args.log'), 'utf8');
		return { code: result.status ?? -1, stdout: result.stdout ?? '', argsLog };
	} finally {
		rmSync(workspace, { recursive: true, force: true, maxRetries: 3 });
	}
}

// Execute the ref-guard step body with a controlled GITHUB_REF (no fake npm
// needed — the guard only inspects the env var and echoes/exits).
function runGuardBody(body: string, githubRef: string): { code: number; stdout: string } {
	const result = spawnSync('bash', ['-c', body], {
		cwd: process.cwd(),
		timeout: 10_000,
		maxBuffer: 1024 * 1024,
		env: { ...process.env, GITHUB_REF: githubRef },
		encoding: 'utf8',
	});
	return { code: result.status ?? -1, stdout: result.stdout ?? '' };
}

// Extract the ref-guard step's run body by step name (parameterized path).
function extractGuardBody(workflowPath = WORKFLOW_PATH): string {
	const lines = readFileSync(workflowPath, 'utf8').split(/\r?\n/);
	const nameIdx = lines.findIndex((ln) => /-\s+name:\s*Refuse (publishes|runs) from (refs|ref) (other|other) than next\s*$/.test(ln));
	if (nameIdx === -1) throw new Error('ref-guard step not found');
	const runIdx = lines.findIndex((ln, idx) => idx > nameIdx && /^\s*run:\s*\|\s*$/.test(ln));
	if (runIdx === -1 || runIdx < nameIdx) throw new Error('ref-guard run body not found');
	const runIndent = indentOf(lines[runIdx]);
	const body: string[] = [];
	for (let k = runIdx + 1; k < lines.length; k += 1) {
		const ln = lines[k];
		if (ln.trim() !== '' && indentOf(ln) <= runIndent) break;
		body.push(ln);
	}
	return body.join('\n');
}

// The three neutralization shapes from the #3220 review record. Each keeps
// every construct the line-shaped suite requires while making the step exit
// 0 under npm failure.
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

/** Copy the real workflow to a temp file with one text mutation applied. */
function mutatedWorkflowCopy(label: string, mutate: (text: string) => string): string {
	const dir = mkdtempSync(path.join(os.tmpdir(), `pubstep-mut-${label}-`));
	const target = path.join(dir, 'release-please-next.yml');
	writeFileSync(target, mutate(readFileSync(DEFAULT_WORKFLOW_PATH, 'utf8')));
	return target;
}

describe('release-please-next publish steps — executable harness (#3229 R1)', () => {
	test('bash is available (the harness executes real shell)', () => {
		const probe = spawnSync('bash', ['-c', 'echo ok'], { timeout: 10_000, encoding: 'utf8' });
		expect(probe.status).toBe(0);
		expect((probe.stdout ?? '').trim()).toBe('ok');
	});

	test('the workflow has exactly four publish steps with run bodies', () => {
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

			test('invokes the exact npm publish contract (tag next, public)', () => {
				const result = runStepBody(step.body, npmSuccess);
				expect(result.argsLog, 'every npm invocation must be exactly the publish contract').toBe(
					`${EXPECTED_NPM_ARGS}\n`,
				);
			});
		});
	}

	describe('ref guard (review F-4): the refusal step is EXECUTED, not just present', () => {
		const guardBody = extractGuardBody();

		test('exits nonzero when GITHUB_REF is not refs/heads/next', () => {
			const result = runGuardBody(guardBody, 'refs/heads/feature/x');
			expect(result.code, `stdout: ${result.stdout}`).not.toBe(0);
			expect(result.stdout.includes('refused')).toBe(true);
		});

		test('exits 0 when GITHUB_REF is refs/heads/next (dispatch recovery preserved)', () => {
			const result = runGuardBody(guardBody, 'refs/heads/next');
			expect(result.code, `stdout: ${result.stdout}`).toBe(0);
		});
	});

	describe('neutralization mutants genuinely neutralize (the class the real-step legs guard)', () => {
		const firstStep = collectPublishStepBodies()[0];
		for (const variant of neutralizedVariants(firstStep.body)) {
			test(`${variant.label}: exits 0 under npm hard failure — only execution catches it`, () => {
				const result = runStepBody(variant.body, npmHardFail);
				expect(result.code, `stdout: ${result.stdout}`).toBe(0);
			});
		}
	});

	describe('harness discriminating power: mutated workflow COPIES are caught (FB-2)', () => {
		// A --tag latest regression: the real legs' exit codes are unchanged
		// (the shim is argv-faithful, not argv-strict) — the argv leg is what
		// catches it. Prove the argv leg discriminates against a mutated copy.
		test('--tag latest regression: the argv contract leg FAILS on a mutated copy', () => {
			const mutantPath = mutatedWorkflowCopy('tag', (text) =>
				text.replaceAll('npm publish --tag next --access public', 'npm publish --tag latest --access public'),
			);
			try {
				const mutantStep = collectPublishStepBodies(mutantPath)[0];
				const result = runStepBody(mutantStep.body, npmSuccess);
				expect(result.code).toBe(0); // exit codes unchanged...
				expect(result.argsLog === `${EXPECTED_NPM_ARGS}\n`, 'argv leg must catch --tag latest').toBe(false);
			} finally {
				rmSync(path.dirname(mutantPath), { recursive: true, force: true, maxRetries: 3 });
			}
		});

		// A lost `2>&1` merge: real npm writes errors to stderr, so a step
		// without the merge tee's only stdout into pub.log — the tolerance
		// grep never matches and the documented recovery fails. The shim's
		// stderr emission makes the tolerance leg catch it.
		test('lost 2>&1 merge: the tolerance leg FAILS on a mutated copy', () => {
			const mutantPath = mutatedWorkflowCopy('tee', (text) =>
				text.replaceAll('2>&1 | tee /tmp/pub.log', '| tee /tmp/pub.log'),
			);
			try {
				const mutantSteps = collectPublishStepBodies(mutantPath);
				expect(mutantSteps.length).toBe(4);
				const result = runStepBody(mutantSteps[0].body, npmVersionConflict, { FORCE_PUBLISH: 'true' });
				expect(result.code, 'tolerance leg must FAIL when the stderr merge is lost').not.toBe(0);
			} finally {
				rmSync(path.dirname(mutantPath), { recursive: true, force: true, maxRetries: 3 });
			}
		});
	});
});
