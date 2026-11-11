import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/*
 * Step-scoped diagnostic pins for the `coverage` aggregator job — issue
 * #3250 (trace 3250-2738-merge-queue-ci-reliability).
 *
 * Forensics for #3250 showed the aggregator's own `if: always()` final
 * upload warned "No files were found with the provided path:
 * coverage/lcov.info" on every failed aggregation — 14/14 signature runs
 * were upstream cascades (11 quality-job pending-fragment failures that
 * skipped the whole shard matrix, 3 genuine shard test failures); the merge
 * step never ran, so the file was never produced. No run ever lost a file.
 *
 * These pins keep the diagnostic contract honest: the fail-closed error
 * names the upstream quality result, the merge step's id is exactly the one
 * the upload gate references, the step ORDER stays fail-closed -> download
 * -> merge -> upload (reordering makes outcome 'failure' pass the
 * `!= 'skipped'` gate and re-emit the misleading warning), and the upload
 * gate is never success-only (threshold-failure merges keep their report).
 *
 * Split from ci-coverage-sharding.test.ts per FR-006: the sharding file was
 * 444 lines on main and the #3250 additions pushed it past the 500-line cap
 * (508 at the fix commit); these tests belong to the #3250 diagnostics
 * surface, not the sharding topology surface, so they live here.
 */

const CI_YML_PATH = join(
	import.meta.dir,
	'../../../../.github/workflows/ci.yml',
);

// CRLF-normalize: Windows checkouts can hold CRLF working copies while the
// committed file is LF; assertions must hold on both (sharding-suite
// precedent).
function readText(path: string): string {
	return readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Job slicer (same semantics as ci-coverage-sharding.test.ts — see its
// header comment for the EOF-alternative caveat).
function extractJob(yml: string, job: string): string {
	const match = yml.match(
		new RegExp(
			`^ {2}${escapeRegExp(job)}:[\\s\\S]*?(?=^ {2}[A-Za-z][\\w-]*:|(?![\\s\\S]))`,
			'm',
		),
	);
	return match ? match[0] : '';
}

// Step slicer (same semantics as the sharding suite).
function extractStep(yml: string, name: string): string {
	const match = yml.match(
		new RegExp(
			`- name: ${escapeRegExp(name)}[\\s\\S]*?(?=\\n {6}- name:|\\n {6}- uses:|\\n {6}#|\\n {2}[A-Za-z][\\w-]*:|(?![\\s\\S]))`,
			'm',
		),
	);
	return match ? match[0] : '';
}

describe('ci.yml coverage aggregator diagnostics — issue #3250', () => {
	const yml = readText(CI_YML_PATH);
	const coverageAggJob = extractJob(yml, 'coverage');

	test('fail-closed step names the upstream quality job result', () => {
		// 11 of the 14 signature runs were quality failures
		// (check:pending-fragment) that skipped the whole shard matrix; the
		// old error named only the matrix result, not the layer that caused
		// it. The quality result rides an env var (never interpolate needs.*
		// into shell source), and the step-scoped slice proves the strings
		// sit in THIS step, not a sibling.
		const failClosedStep = extractStep(
			yml,
			'Check coverage shard results (fail closed)',
		);
		expect(failClosedStep).not.toBe('');
		expect(failClosedStep).toContain(
			'QUALITY_RESULT: ${{ needs.quality.result }}',
		);
		expect(failClosedStep).toContain(
			"::error::coverage-shard matrix result was '$COVERAGE_SHARD_RESULT', not 'success' (upstream quality job result: '$QUALITY_RESULT')",
		);
		// F-04: the fail-closed step must actually fail — pin the explicit
		// nonzero exit as a STANDALONE line at the run block's shell depth
		// so both a removed exit (the reports-but-does-not-exit mutant) and
		// a commented-out one (`# exit 1`) stay red.
		expect(failClosedStep).toMatch(/^ {12}exit 1$/m);
	});

	test('merge step carries the exact id the upload gate references', () => {
		const mergeStep = extractStep(
			yml,
			'Merge shard reports and enforce threshold',
		);
		expect(mergeStep).not.toBe('');
		// Exact-token pin: a prefixed rename (id: merge-coverage-v2) detaches
		// the upload gate's steps.merge-coverage.outcome reference — the
		// outcome expression resolves empty, `'' != 'skipped'` is true, and
		// the upload runs unconditionally again — while a substring pin stays
		// green under that exact mutation.
		expect(mergeStep).toMatch(/^ {8}id: merge-coverage$/m);
		// Reference resolution: every steps.<id>.outcome reference in the job
		// must name an id this job actually declares.
		const declaredIds = [
			...coverageAggJob.matchAll(/^ {8}id: ([A-Za-z0-9_-]+)$/gm),
		].map((match) => match[1]);
		const referencedIds = [
			...coverageAggJob.matchAll(/steps\.([A-Za-z0-9_-]+)\.outcome/g),
		].map((match) => match[1]);
		expect(referencedIds.length).toBeGreaterThan(0);
		for (const referenced of referencedIds) {
			expect(declaredIds).toContain(referenced);
		}
	});

	test('aggregator step order is fail-closed -> download -> merge -> upload', () => {
		// The upload gate is only meaningful because the fail-closed step
		// precedes the merge: reordering them makes the merge run first and
		// fail at the per-shard presence check, so outcome becomes 'failure',
		// the != 'skipped' gate passes, and the always()-upload re-emits the
		// misleading "No files were found" warning — the exact #3250 symptom
		// reintroduced with every membership pin still green. Order is
		// load-bearing; pin it.
		const failClosed = coverageAggJob.indexOf(
			'Check coverage shard results (fail closed)',
		);
		const download = coverageAggJob.indexOf('Download shard reports');
		const merge = coverageAggJob.indexOf(
			'Merge shard reports and enforce threshold',
		);
		const upload = coverageAggJob.indexOf('Upload coverage report');
		expect(failClosed).toBeGreaterThanOrEqual(0);
		expect(download).toBeGreaterThan(failClosed);
		expect(merge).toBeGreaterThan(download);
		expect(upload).toBeGreaterThan(merge);
	});

	test('final upload gates on the merge step having run, not on its exit status', () => {
		// Outcome semantics pinned for all three material cases:
		//   success  -> upload runs (normal artifact)
		//   failure  -> upload runs (threshold-failure report is the
		//               diagnostic; a success-only gate would discard exactly
		//               the runs that need diagnosis)
		//   skipped  -> upload suppressed: the fail-closed step exited first,
		//               the merge never ran, coverage/lcov.info was never
		//               produced, and the unconditional always()-upload used
		//               to warn "No files were found with the provided path:
		//               coverage/lcov.info" — the misleading #3250 headline.
		// With this gate, that warning firing again means a GENUINE
		// merge-ran-but-no-file event.
		const uploadStep = extractStep(yml, 'Upload coverage report');
		expect(uploadStep).not.toBe('');
		expect(uploadStep).toContain('if: always() &&');
		expect(uploadStep).toContain("steps.merge-coverage.outcome != 'skipped'");
		// The success-only regression must stay impossible to reintroduce
		// silently: this pin is what the comparator reverse-mutation flips.
		expect(uploadStep).not.toContain(
			"steps.merge-coverage.outcome == 'success'",
		);
		// PRR-002: substring pins alone cannot catch condition APPENDS — a
		// mutant appending `|| failure()` to this `if:` restores the
		// always-upload cascade warning while every substring pin stays
		// green (scratch-executed in review round 2). Pin the WHOLE
		// expression by normalized line equality so any edit to the gate
		// is a deliberate, red-shown change.
		const uploadIfLine = uploadStep
			.split('\n')
			.map((line) => line.trim())
			.find((line) => line.startsWith('if: '));
		expect(uploadIfLine).toBe(
			"if: always() && github.event_name == 'merge_group' && needs.detect-release.outputs.is-release != 'true' && needs.detect-release.outputs.docs-only != 'true' && steps.merge-coverage.outcome != 'skipped'",
		);
	});
});
