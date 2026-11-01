import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

// Repo root relative to this test file: packages/opencode/tests/publishing/
const REPO_ROOT = path.resolve(import.meta.dir, '..', '..', '..', '..');
const WORKFLOW_PATH = path.join(REPO_ROOT, '.github', 'workflows', 'release-please-next.yml');
const CONFIG_PATH = path.join(REPO_ROOT, 'release-please-config.json');

function indentOf(line: string): number {
	const m = /^\s*/.exec(line);
	return m ? m[0].length : 0;
}

function isCommentLine(line: string): boolean {
	return line.trimStart().startsWith('#');
}

// Collect each "- name: Publish ..." step block (the name line through the
// last more-indented line: its run:/env: lines). Comment lines are STRIPPED
// from the block text before any assertion consumes it: a token hidden in a
// comment (`# set -eo pipefail`) must not satisfy a semantic assertion.
function collectPublishSteps(): Array<{ name: string; text: string; codeLines: string[] }> {
	const lines = readFileSync(WORKFLOW_PATH, 'utf8').split(/\r?\n/);
	const steps: Array<{ name: string; text: string; codeLines: string[] }> = [];
	let i = 0;
	while (i < lines.length) {
		const m = /^(\s*)-\s+name:\s*(Publish\S?.*)$/.exec(lines[i]);
		if (!m) {
			i += 1;
			continue;
		}
		const indent = m[1].length;
		const block: string[] = [lines[i]];
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
		const codeLines = block.filter((ln) => ln.trim() !== '' && !isCommentLine(ln));
		steps.push({ name: m[2].trim(), text: codeLines.join('\n') });
		i = j;
	}
	return steps;
}

function collectPackagePaths(): string[] {
	if (!existsSync(CONFIG_PATH)) {
		throw new Error(`release-please-config.json not found at ${CONFIG_PATH}`);
	}
	const cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as { packages?: Record<string, unknown> };
	return Object.keys(cfg.packages ?? {}).sort();
}

// The ONLY tolerated skip reason: npm's version-conflict rejection (and the
// generic "already exists" phrasing). Deliberately message-specific — npm
// emits code E403 for genuine authorization failures too, and those must
// fail the job.
const TOLERANCE_PATTERN = "grep -q 'cannot publish over the previously published versions\\|already exists' /tmp/pub.log";

describe('release-please-next publish steps (issue #3150 silent-skip guard)', () => {
	test('workflow has exactly four Publish steps', () => {
		expect(collectPublishSteps().length).toBe(4);
	});

	test('every publish step is bound to exactly one configured package (no duplicate, no omission)', () => {
		const steps = collectPublishSteps();
		const packagePaths = collectPackagePaths();
		expect(steps.length).toBe(packagePaths.length);
		for (const pkgPath of packagePaths) {
			const matching = steps.filter(({ text }) => text.includes(`cd ${pkgPath}`));
			expect(matching.length, `${pkgPath} must be published by exactly one step (found ${matching.length})`).toBe(1);
		}
	});

	test('every publish step propagates failures: statement-shaped pipefail, if-guarded pipeline, and a reachable exit 1', () => {
		const steps = collectPublishSteps();
		expect(steps.length).toBeGreaterThan(0);
		for (const { name, text } of steps) {
			// Line-SHAPED assertions, not token presence: each required construct
			// must appear as a real statement line (comments are already
			// stripped), so `true # set -eo pipefail`, an `echo "..."` string
			// embedding the tokens, or an unreachable `if false; then exit 1; fi`
			// arm all fail.
			const codeLines = text.split('\n');
			const pipefailStatement = codeLines.find((ln) => {
				const t = ln.trim();
				return /^set\s+-e/.test(t) && /pipefail/.test(t);
			});
			expect(pipefailStatement, `${name}: a real 'set ... pipefail' statement line is required`).toBeTypeOf('string');
			const pipelineGuard = codeLines.find((ln) => /^\s*if ! npm publish .*\| tee \/tmp\/pub\.log; then$/.test(ln));
			expect(pipelineGuard, `${name}: npm publish must run inside 'if ! npm publish ... | tee /tmp/pub.log; then'`).toBeTypeOf('string');
			const exitLine = codeLines.find((ln) => ln.trim() === 'exit 1');
			expect(exitLine, `${name}: an exact 'exit 1' statement line is required`).toBeTypeOf('string');
		}
	});

	test('the version-conflict tolerance is gated on the force_publish input', () => {
		const steps = collectPublishSteps();
		for (const { name, text } of steps) {
			const codeLines = text.split('\n');
			// The gate must be ONE condition line that binds BOTH the input and
			// the message-specific tolerance pattern — a mention of the input
			// anywhere else (echo, comment, separate branch) does not gate the
			// tolerance. Since #3229 AC1 the input reaches the script through
			// the job-level FORCE_PUBLISH env var (${{ }} interpolation into
			// run: text is the injection pattern GitHub's hardening guide
			// forbids).
			const gateLine = codeLines.find(
				(ln) => ln.trim().startsWith('if [') && ln.includes('"$FORCE_PUBLISH"') && ln.includes(TOLERANCE_PATTERN),
			);
			expect(gateLine, `${name}: the tolerance grep must be gated by 'if [ "$FORCE_PUBLISH" = "true" ] && grep' on a single line`).toBeTypeOf('string');
			expect(gateLine.includes('|| cat /tmp/pub.log'), `${name}: ungated || cat masking must not remain`).toBe(false);
		}
	});

	test('force_publish reaches scripts via env: indirection, never shell interpolation (#3229 AC1)', () => {
		const raw = readFileSync(WORKFLOW_PATH, 'utf8');
		// Extract every literal run-pipe block precisely: the `run: |` line
		// plus every following line that is blank or MORE indented than it
		// (a less-indented line — env:, the next step — ends the block, so a
		// legitimate ${{ secrets.* }} in a following env: block is not
		// misattributed to the script text).
		const lines = raw.split(/\r?\n/);
		const runBlocks: string[] = [];
		let i = 0;
		while (i < lines.length) {
			const m = /^(\s*)run:\s*\|\s*$/.exec(lines[i]);
			if (!m) {
				i += 1;
				continue;
			}
			const indent = m[1].length;
			const block: string[] = [lines[i]];
			let j = i + 1;
			while (j < lines.length) {
				const ln = lines[j];
				if (ln.trim() !== '' && indentOf(ln) <= indent) break;
				block.push(ln);
				j += 1;
			}
			runBlocks.push(block.join('\n'));
			i = j;
		}
		expect(runBlocks.length, 'the workflow must have run-pipe blocks to inspect').toBeGreaterThan(0);
		for (const block of runBlocks) {
			expect(block.includes('${{'), 'a run: block must not contain ${{ }} expression interpolation').toBe(false);
		}
		// The job-level env block defines FORCE_PUBLISH from the input.
		const envDefinition = /publish-npm-next:[\s\S]*?env:[\s\S]*?FORCE_PUBLISH:\s*\$\{\{\s*inputs\.force_publish\s*\}\}/.exec(raw);
		expect(envDefinition, 'publish-npm-next must define FORCE_PUBLISH via its env: block').not.toBeNull();
	});

	test('the publish job refuses refs other than next before any npm publish (#3229 AC3)', () => {
		const raw = readFileSync(WORKFLOW_PATH, 'utf8');
		// The ref guard runs as the publish job's FIRST step (before the
		// checkout that precedes npm publish) and compares the runner-provided
		// GITHUB_REF — no expression interpolation.
		const guardStep = /- name: Refuse publishes from refs other than next\s*\n\s*run:\s*\|\s*\n[\s\S]*?GITHUB_REF[\s\S]*?refs\/heads\/next/.exec(raw);
		expect(guardStep, 'publish job must carry the GITHUB_REF refusal guard step').not.toBeNull();
		const publishOrder = raw.indexOf('Refuse publishes from refs other than next');
		const firstPublish = raw.indexOf('Publish @opencode-swarm/telemetry');
		expect(publishOrder, 'ref guard must precede the first publish step').toBeLessThan(firstPublish);
	});

	test('the workflow serializes runs through a concurrency group (#3229 AC2)', () => {
		const raw = readFileSync(WORKFLOW_PATH, 'utf8');
		const concurrency = /^concurrency:\s*$/m.exec(raw);
		expect(concurrency, 'workflow must declare a top-level concurrency key').not.toBeNull();
		const group = /group:\s*release-please-next/.exec(raw);
		expect(group, 'concurrency group must be the workflow identity').not.toBeNull();
		const cancel = /cancel-in-progress:\s*false/.exec(raw);
		expect(cancel, 'cancel-in-progress must be false (never cancel a run that may be mid-publish)').not.toBeNull();
	});

	test('continue-on-error appears nowhere in the workflow (step-level, quoted, or job-level)', () => {
		// A raw-text scan: job-level and quoted ("continue-on-error": true)
		// variants hide outside individual step blocks, and any form would
		// neutralize the fail-closed exit this file guards.
		const raw = readFileSync(WORKFLOW_PATH, 'utf8');
		expect(raw.includes('continue-on-error'), 'continue-on-error must not appear anywhere in the workflow').toBe(false);
	});

	test('the publish job is gated on a release existing or an explicit force_publish dispatch', () => {
		const raw = readFileSync(WORKFLOW_PATH, 'utf8');
		const jobIf = /publish-npm-next:[\s\S]*?\n\s*if:\s*(.*)/.exec(raw);
		expect(jobIf, 'publish-npm-next must carry a job-level if: gate').not.toBeNull();
		const gate = jobIf?.[1] ?? '';
		expect(gate.includes('releases_created'), 'gate must reference releases_created').toBe(true);
		expect(gate.includes('force_publish'), 'gate must reference force_publish').toBe(true);
	});

	test('the historical ungated skip form is absent from the whole workflow', () => {
		const raw = readFileSync(WORKFLOW_PATH, 'utf8');
		expect(
			raw.includes(`grep -q 'E403\\|already exists' /tmp/pub.log && echo "Already published, skipping" || cat`),
		).toBe(false);
	});
});
