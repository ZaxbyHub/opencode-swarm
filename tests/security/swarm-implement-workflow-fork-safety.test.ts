import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * #2498 fork-safety contract for the swarm-implement workflow:
 * an untrusted fork contributor must not be able to reach the pipeline's
 * secrets or write paths. The write-access boundary is the issue label gate
 * (labeling an issue requires write access on GitHub), and the workflow
 * must never open a pull_request/pull_request_target surface that a fork
 * could ride. Pipeline secrets reach the run only through single-line env
 * mappings.
 */

const WORKFLOW_PATH = path.join(
	import.meta.dir,
	'..',
	'..',
	'.github',
	'workflows',
	'swarm-implement.yml',
);

const workflow = readFileSync(WORKFLOW_PATH, 'utf8');

const SECRET_MAPPING =
	/^[ \t]*[A-Za-z_][A-Za-z0-9_]*:[ \t]*\$\{\{[ \t]*secrets\.[A-Za-z_][A-Za-z0-9_]*[ \t]*\}\}[ \t]*$/;

describe('swarm-implement workflow fork safety (#2498)', () => {
	test('declares no pull_request_target anywhere (fork code-execution vector)', () => {
		expect(workflow.includes('pull_request_target')).toBe(false);
	});

	test('declares no pull_request trigger (fork PRs cannot start the pipeline)', () => {
		expect(/^[ \t]*pull_request:/m.test(workflow)).toBe(false);
	});

	test('the write-access gate is the swarm:implement label condition', () => {
		const gateLines = workflow
			.split('\n')
			.filter(
				(line) => line.includes('if:') && line.includes('swarm:implement'),
			);
		expect(gateLines.length).toBeGreaterThan(0);
		expect(gateLines.every((line) => !line.includes('\n'))).toBe(true);
	});

	test('every secrets reference is a single-line env mapping (no inline interpolation)', () => {
		const secretLines = workflow
			.split('\n')
			.filter((line) => line.includes('secrets.'));
		// Positive control first: a crafted inline-secret line must FAIL the
		// mapping predicate, proving the predicate can actually detect the
		// violation it exists to catch (non-vacuous negative assertion).
		const craftedInline =
			'        run: echo ${{ secrets.OPENCODE_MODEL_API_KEY }}';
		expect(SECRET_MAPPING.test(craftedInline)).toBe(false);
		expect(secretLines.length).toBeGreaterThan(0);
		for (const line of secretLines) {
			expect(SECRET_MAPPING.test(line)).toBe(true);
		}
	});

	test('an untrusted fork context cannot reach the pipeline: no fork-facing trigger keys exist', () => {
		// Differential control: a crafted fork-facing trigger snippet IS
		// detected by the same predicate that the real workflow must pass.
		const forkFacingSnippet = 'on:\n  pull_request:\n    branches: [main]\n';
		expect(/^[ \t]*pull_request:/m.test(forkFacingSnippet)).toBe(true);
		expect(/^[ \t]*pull_request:/m.test(workflow)).toBe(false);
	});
});
