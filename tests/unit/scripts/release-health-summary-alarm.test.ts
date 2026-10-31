/**
 * Issue #3510 AC1 — the release-health-summary alarm must see the
 * update-release-notes producer.
 *
 * In .github/workflows/release-and-publish.yml the `release-health-summary`
 * job declares `needs: [release-please, cleanup-release-fragments]` and its
 * alarm step tolerates a skipped cleanup (`!= 'success' ] && [ ... !=
 * 'skipped' ]`). But `cleanup-release-fragments` itself declares
 * `needs: [release-please, update-release-notes]`, so when update-release-notes
 * FAILS, cleanup is SKIPPED and the summary reports success — the failed
 * producer is invisible (live evidence: runs 40258324624 and 39642416739:
 * update failure, cleanup skipped, summary success).
 *
 * RED at base, GREEN after the fix: the summary job must depend on
 * update-release-notes, its alarm step must gate on
 * `needs.update-release-notes.result`, and any skip-tolerance for cleanup
 * must be qualified by update-release-notes' success. The healthy-path shape
 * (timeout, always() + releases_created gate) is pinned so the fix cannot
 * silently reshape the job.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';

const root = path.resolve(import.meta.dir, '../../..');
const releaseWorkflowText = readFileSync(
	path.join(root, '.github/workflows/release-and-publish.yml'),
	'utf8',
);
const releaseWorkflow = parse(releaseWorkflowText);

interface WorkflowStep {
	name?: string;
	run?: string;
}

const summaryJob = releaseWorkflow.jobs['release-health-summary'];
const alarmStep: WorkflowStep | undefined = (
	summaryJob.steps as WorkflowStep[]
).find((step: WorkflowStep) => step.name === 'Report release job conclusions');

/**
 * Extract every shell `if`/`elif` condition expression (text up to the
 * matching `then`) from a step's run script, so gate contracts can be
 * asserted on the actual conditions rather than on echo prose. Line-anchored:
 * a matching `if`/`elif` must START a shell line, so prose that merely
 * contains the token "if" cannot fabricate a condition (issue #3519 feedback).
 */
function shellConditions(runText: string): string[] {
	return runText
		.split('\n')
		.filter((line: string) => /^\s*(?:if|elif)\s/.test(line))
		.map((line: string) => line.trim())
		.map((line: string) =>
			line
				.replace(/^(?:if|elif)\s+/, '')
				.replace(/;\s*then\s*$/, '')
				.trim(),
		)
		.filter((condition: string) => condition.length > 0);
}

/**
 * Extract the if-block whose condition references `needle`: the condition
 * line and the body up to (not including) its closing `fi`. Used to scope
 * alarm assertions to the producer branch itself (issue #3519 feedback).
 */
function ifBlockFor(
	runText: string,
	needle: string,
): { condition: string; body: string } | null {
	const lines = runText.split('\n');
	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i];
		if (!/^\s*(?:if|elif)\s/.test(line)) continue;
		const condition = line
			.trim()
			.replace(/^(?:if|elif)\s+/, '')
			.replace(/;\s*then\s*$/, '')
			.trim();
		if (!condition.includes(needle)) continue;
		let body = '';
		for (let j = i + 1; j < lines.length; j += 1) {
			if (/^\s*fi\s*$/.test(lines[j])) break;
			body += `${lines[j]}\n`;
		}
		return { condition, body };
	}
	return null;
}

describe('release-health-summary alarm coverage (issue #3510)', () => {
	test('the summary job needs update-release-notes so a failed producer is in scope', () => {
		// RED at base (needs is [release-please, cleanup-release-fragments]
		// only), GREEN after the fix.
		const needs: string[] = Array.isArray(summaryJob.needs)
			? summaryJob.needs
			: [summaryJob.needs];

		expect(needs).toContain('update-release-notes');
	});

	test('the alarm step inspects and gates on needs.update-release-notes.result', () => {
		// RED at base (the run text never references update-release-notes, so
		// a failed producer is invisible and a skipped cleanup passes), GREEN
		// after the fix. Issue #3519 feedback: the assertions below are
		// BRANCH-SCOPED — the previous whole-runText ::error::/exit 1 checks
		// stayed green if the producer branch degraded to echo-only while the
		// cleanup branch kept its own alarm, which is exactly the #3510 defect
		// shape. The comparison polarity is pinned so an inverted condition
		// (alarm on success) cannot pass.
		expect(alarmStep).toBeDefined();
		const runText = alarmStep?.run ?? '';

		// Visibility: the producer's conclusion must at least be referenced.
		expect(runText).toContain('needs.update-release-notes.result');

		const producerBlock = ifBlockFor(runText, 'update-release-notes.result');
		expect(producerBlock).not.toBeNull();

		// Gate polarity: the producer branch must alarm on NON-success (an
		// inverted `= "success"` condition would alarm on the healthy path and
		// go silent on the failure path). The negative leg uses a lookbehind so
		// the `!=` in the positive leg does not satisfy it.
		expect(producerBlock?.condition).toMatch(/!=\s*["']success["']/);
		expect(producerBlock?.condition).not.toMatch(
			/(?<![!=<>])=\s*["']success["']/,
		);

		// The alarm mechanism itself must live INSIDE the producer branch —
		// an annotation plus a job failure, not prose echoes elsewhere.
		expect(producerBlock?.body).toContain('::error::');
		expect(producerBlock?.body).toContain('exit 1');

		// Skip-tolerance must be qualified: any condition that tolerates a
		// skipped cleanup-release-fragments must ALSO reference
		// update-release-notes.result in the same condition, so a skipped
		// cleanup caused by a failed update-release-notes can never read as
		// success. (Removing the skip tolerance entirely also satisfies this
		// — the filter then finds nothing.)
		const conditions = shellConditions(runText);
		const unqualifiedTolerance = conditions.filter(
			(condition: string) =>
				condition.includes('cleanup-release-fragments.result') &&
				/!=\s*['"]skipped['"]/.test(condition) &&
				!condition.includes('update-release-notes.result'),
		);
		expect(unqualifiedTolerance).toEqual([]);
	});

	test('preserves the healthy-path job shape (timeout and releases_created gate)', () => {
		// GREEN at base and must stay GREEN after the fix — pins the job's
		// bounded runtime and its always-run gate on releases_created so the
		// fix cannot silently reshape the summary job.
		expect(typeof summaryJob['timeout-minutes']).toBe('number');
		expect(summaryJob['timeout-minutes']).toBeGreaterThan(0);
		expect(String(summaryJob.if)).toContain('always()');
		expect(String(summaryJob.if)).toContain("releases_created == 'true'");
	});
});
