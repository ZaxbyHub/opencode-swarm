import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { parse } from 'yaml';

/**
 * Execution-boundary pins for the pr-standards job (issue #3282, absorbed by
 * #3290). The job executes PR-head-controlled TypeScript, so three properties
 * are load-bearing: the job is bounded, and no checkout leaves the job token
 * on disk for that code to read. A round-2 reviewer mutation (PR #3297)
 * deleted all three and every existing suite stayed green — this file is the
 * named falsifier #3282's acceptance criteria asked for.
 */

const root = path.resolve(import.meta.dir, '..', '..', '..');
const workflow = parse(
	readFileSync(
		path.join(root, '.github', 'workflows', 'pr-standards.yml'),
		'utf8',
	),
) as {
	jobs: Record<
		string,
		{
			'timeout-minutes'?: number;
			permissions?: unknown;
			steps: Array<{
				name?: string;
				uses?: string;
				with?: Record<string, unknown>;
			}>;
		}
	>;
	permissions?: Record<string, string>;
	concurrency?: { group?: string; 'cancel-in-progress'?: unknown };
};

describe('pr-standards execution-boundary hardening (issue #3282)', () => {
	const job = workflow.jobs['pr-standards'];

	test('3290 the pr-standards job declares a timeout-minutes bound', () => {
		expect(typeof job['timeout-minutes']).toBe('number');
		expect(job['timeout-minutes'] as number).toBeGreaterThanOrEqual(1);
	});

	test('every checkout in the pr-standards job sets persist-credentials false', () => {
		const checkouts = job.steps.filter((step) =>
			(step.uses ?? '').startsWith('actions/checkout'),
		);
		// The pull_request checkout (token otherwise persisted next to PR-head
		// code) and the workflow_dispatch checkout (added in #3276).
		expect(checkouts.length).toBe(2);
		for (const step of checkouts) {
			expect(step.with?.['persist-credentials']).toBe(false);
		}
	});
});

/**
 * Issue #3300 + #3307 posture pins. #3297 added the pr-standards job bound
 * and persist-credentials pins (above); #3300 closes the remaining unbounded
 * job (check-title), and #3307 pins the least-privilege top-level
 * permissions block verbatim plus the run-supersession concurrency group —
 * whose cancel semantics must stay scoped to pull_request so merge-queue
 * checks are never cancelled mid-batch.
 */
describe('pr-standards workflow posture pins (#3300, #3307)', () => {
	test('3300 the check-title job declares the documented 10-minute bound', () => {
		// PRR-007: the PR body, release fragment, and issue AC6 all claim
		// exactly 10 — a >= 1 pin let a 360 (or 5) bound ship green.
		expect(workflow.jobs['check-title']?.['timeout-minutes']).toBe(10);
	});

	test('3307 the top-level permissions block is least-privilege, verbatim', () => {
		expect(workflow.permissions).toEqual({
			contents: 'read',
			'pull-requests': 'read',
		});
	});

	test('3307 no job overrides the workflow permissions with a wider block', () => {
		// PRR-008: GitHub honors a job-level permissions block as an override
		// of the workflow-level one, so a top-level pin alone certifies
		// nothing about the effective scope of any step.
		for (const [jobName, job] of Object.entries(workflow.jobs)) {
			expect(job.permissions).toBeUndefined();
			expect(jobName.length).toBeGreaterThan(0);
		}
	});

	test('3307 the concurrency group is per-PR for pull_request runs only', () => {
		const group = workflow.concurrency?.group;
		expect(typeof group).toBe('string');
		// Verbatim pin (not token presence): the group keys on the event name
		// and the PR number for pull_request, falling back to a run-unique id
		// for every other event — merge_group and dispatch runs therefore
		// never share a group with anything.
		expect(group).toBe(
			"pr-standards-${{ github.event_name }}-${{ github.event_name == 'pull_request' && github.event.number || github.run_id }}",
		);
	});

	test('3307 cancel-in-progress is conditional on pull_request, never literal true', () => {
		const cancel = workflow.concurrency?.['cancel-in-progress'];
		// A literal true would cancel merge_group checks and block the merge
		// queue; the expression form evaluates false for every non-PR event.
		expect(cancel).not.toBe(true);
		expect(cancel).toBe("${{ github.event_name == 'pull_request' }}");
	});
});
