/**
 * Issue #3527 (trace
 * `.agents/issue-traces/3501-3285-3527-dep-bump-channel/`) — frozen checks
 * C4 (whole-file checkout coverage), C5 (`-t tag-proof`), and C10
 * (`persist-credentials`) for the release cleanup checkout contract.
 *
 * At base, `cleanup-release-fragments` checks out `ref: main`, so the exact
 * tag proof that `modeApplyCleanup` enforces (remote == local == HEAD) is
 * computed against whatever main happens to be at dispatch time, not the
 * commit the release-please tag points at. The approved design reroutes the
 * checkout to `${{ needs.release-please.outputs.tag_name }}` (the pin the
 * three other release jobs already use) and adds
 * `persist-credentials: false` to every actions/checkout in the workflow.
 *
 * RED at base, GREEN after the fix:
 * - the cleanup checkout `with.ref` pin (C4; `main` at base),
 * - the tag-proof leg C re-assertion of the same pin (the C5 filter
 *   therefore proves BOTH the fail-closed proof contract and the rerouting),
 * - the persist-credentials walk (C10; the three tag-ref checkouts at base
 *   lack the flag).
 * The `validateExactTagProof` legs are expected GREEN at base — the fix
 * reroutes the checkout, it must never weaken the proof itself.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
// @ts-expect-error JavaScript CLI module intentionally has no declaration file.
import { validateExactTagProof } from '../../../scripts/release-notes-fragments.mjs';

const root = path.resolve(import.meta.dir, '../../..');
const releaseWorkflowPath = path.join(
	root,
	'.github',
	'workflows',
	'release-and-publish.yml',
);
const releaseWorkflow = parse(readFileSync(releaseWorkflowPath, 'utf8'));

/** The exact tag ref expression the release jobs pin their checkouts to. */
const TAG_REF_EXPRESSION = '${{ needs.release-please.outputs.tag_name }}';

interface CheckoutStep {
	uses?: string;
	with?: {
		ref?: string;
		'fetch-depth'?: number;
		'persist-credentials'?: boolean;
	};
}

/** Every actions/checkout step of one job, in workflow order. */
function checkoutSteps(jobName: string): CheckoutStep[] {
	const steps: CheckoutStep[] = releaseWorkflow.jobs[jobName]?.steps ?? [];
	return steps.filter((step) =>
		(step.uses ?? '').startsWith('actions/checkout@'),
	);
}

/** The first actions/checkout step of the cleanup job (its repo pin). */
function cleanupCheckout(): CheckoutStep | undefined {
	return checkoutSteps('cleanup-release-fragments')[0];
}

describe('cleanup checkout tag-ref pin (C4)', () => {
	test('first actions/checkout step of cleanup-release-fragments pins with.ref to the release tag expression', () => {
		const checkout = cleanupCheckout();
		expect(checkout).toBeDefined();
		expect(checkout?.with?.ref).toBe(TAG_REF_EXPRESSION);
	});

	test('cleanup checkout keeps fetch-depth 0 and persist-credentials false', () => {
		const checkout = cleanupCheckout();
		expect(checkout?.with?.['fetch-depth']).toBe(0);
		expect(checkout?.with?.['persist-credentials']).toBe(false);
	});
});

describe('tag-proof fail-closed legs (C5)', () => {
	test('tag-proof drifted triple (remote != local) throws fail-closed', () => {
		const shaA = 'a'.repeat(40);
		const shaB = 'b'.repeat(40);
		expect(() => validateExactTagProof(shaA, shaB, shaA)).toThrow(
			/exact tag proof failed/,
		);
	});

	test('tag-proof exact triple of equal 40-hex SHAs does not throw', () => {
		const exact = '0123456789abcdef0123456789abcdef01234567';
		expect(validateExactTagProof(exact, exact, exact)).toBe(exact);
	});

	test('tag-proof cleanup checkout ref is the tag expression (rerouting, not proof weakening)', () => {
		expect(cleanupCheckout()?.with?.ref).toBe(TAG_REF_EXPRESSION);
	});
});

describe('persist-credentials legs (C10)', () => {
	test('persist-credentials: every actions/checkout step in every job of release-and-publish.yml sets false', () => {
		const workflowJobs: Record<string, { steps?: CheckoutStep[] }> =
			releaseWorkflow.jobs;
		const offenders: string[] = [];
		for (const [jobName, job] of Object.entries(workflowJobs)) {
			const steps: CheckoutStep[] = job.steps ?? [];
			for (const [index, step] of steps.entries()) {
				if ((step.uses ?? '').startsWith('actions/checkout@')) {
					if (step.with?.['persist-credentials'] !== false) {
						offenders.push(`${jobName} -> steps[${index}] (${step.uses})`);
					}
				}
			}
		}
		expect(offenders).toEqual([]);
	});

	test('persist-credentials walk covers the five known checkout-bearing jobs (non-vacuous)', () => {
		for (const jobName of [
			'build-sandbox-runner',
			'publish-npm',
			'update-release-notes',
			'cleanup-release-fragments',
			'update-pr-notes',
		]) {
			expect(checkoutSteps(jobName).length).toBeGreaterThan(0);
		}
	});
});
