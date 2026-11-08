import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CANONICAL = '.opencode/skills/swarm-pr-feedback/SKILL.md';
const ADAPTERS = [
	'.agents/skills/swarm-pr-feedback/SKILL.md',
	'.claude/skills/swarm-pr-feedback/SKILL.md',
] as const;

function read(relativePath: string): string {
	return readFileSync(join(process.cwd(), relativePath), 'utf-8');
}

describe('swarm-pr-feedback mechanical gates', () => {
	test('canonical skill requires the executable, ordered, revision-bound protocol', () => {
		const source = read(CANONICAL);
		for (const required of [
			'run_pr_feedback_stage_a',
			'swarm-pr-feedback:stage-b-reviewer',
			'swarm-pr-feedback:stage-b-test',
			'swarm-pr-feedback:closeout-reviewer',
			'swarm-pr-feedback:closeout-critic',
			'[STAGE-B-REVIEW]',
			'[STAGE-B-TEST]',
			'[CLOSEOUT-REVIEW]',
			'[CLOSEOUT-CRITIC]',
			'Any content change after Stage A',
			'`git commit`/`git push` remain blocked',
			'only one standalone `git commit`',
			'binds that post-commit HEAD',
			'non-merge direct child',
			'index/worktree are clean',
			'exact failing CI/test reproduction',
			'repo-appropriate targeted regression/test command',
			'session task-gates artifact',
			'cancel-publication',
			'cancel_publication: true',
			'cancelled_without_publication',
			'never grants push authority',
			'invalidate_pr_feedback_publication',
		]) {
			expect(source).toContain(required);
		}
		expect(source).toContain('There is no speed, efficiency, token, or time');
		expect(source).not.toContain('.claude/session/tasks/<slug>/gates.md');
		// The gates are profile-aware: the controller sequence is Profile A, and
		// the same ordered gates run without the controller on Profiles B/C.
		expect(source).toContain('## Runtime Capability Profiles');
		expect(source).toContain('**Mechanical controller contract (Profile A).**');
		expect(source).toContain('**Without the controller (Profiles B/C).**');
		expect(source).toContain(
			'Controller-tool absence is NOT a blocker; Profiles B and C are first-class',
		);
	});

	test('canonical cancellation path is explicit and plain armed abort remains prohibited', () => {
		const source = read(CANONICAL);
		expect(source).toContain('Plain recovery/force aborts');
		expect(source).toContain('Do not substitute a plain abort');
		expect(source).toContain(
			'A published generation is never cleared by abort',
		);
	});

	for (const adapter of ADAPTERS) {
		test(`${adapter} gives a native gate path and keeps controller modes conditional`, () => {
			const source = read(adapter);
			expect(source).toContain(
				'../../../.opencode/skills/swarm-pr-feedback/SKILL.md',
			);
			expect(source).toContain('run_pr_feedback_stage_a');
			expect(source).toContain('swarm-pr-feedback:stage-b-reviewer');
			expect(source).toContain('repo-appropriate targeted');
			expect(source).toContain('regression/test command');
			expect(source).toContain('session task-gates artifact');
			expect(source).toMatch(/direct/i);
			// Controller absence is the normal non-OpenCode state, never a dead
			// end; the controller sequence applies only when its tools exist.
			expect(source).toContain('not an error');
			expect(source).toContain('Never report BLOCKED merely because');
			expect(source).toMatch(
				/Only if (this|the) session actually exposes the plugin's mechanical tools/,
			);
			expect(source).not.toContain('.claude/session/tasks/<slug>/gates.md');
			expect(source).not.toContain('$writing-tests');
			expect(source).not.toContain('$commit-pr');
			expect(source).not.toContain('Task-tool dispatch as the final fallback');
		});
	}

	// #3607 round-contract pins: the AC2/AC5 checks in the issue demand that a
	// deletion of the new contract text FAILS the skills suite (the digest-stamp
	// test alone is self-consistent and would pass after a delete + restamp).
	// Prose needles are matched against whitespace-normalized text so markdown
	// line wraps cannot mask a real deletion.
	test('#3607 round contract: external-comment intake and critic enumeration are pinned', () => {
		const text = read(CANONICAL).replace(/\s+/g, ' ');
		expect(text).toContain('Re-fetch at every round boundary');
		expect(text).toContain('re-fetch issue comments, inline review');
		expect(text).toContain('before the closeout gate');
		expect(text).toContain(
			'references/intake-surfaces.md` (## Round-boundary re-fetch)',
		);
		expect(text).toContain('a delta approval is invalid');
		expect(text).toContain('while unreviewed external feedback exists');
		expect(text).toContain('fetches all three surfaces fresh');
		expect(text).toContain(
			'reconciles each external finding against the ledger',
		);
		expect(text).toContain(
			'references/intake-surfaces.md` (## What counts as feedback or findings)',
		);
	});

	test('#3607 round contract: durable pre-critic ledger and post-push publication are pinned', () => {
		const text = read(CANONICAL).replace(/\s+/g, ' ');
		// The pre-critic artifact is the DURABLE task-gates ledger, not a PR
		// comment: PR-comment publication is gated until the push in every
		// profile (pr-workflow-gate classifies gh pr comment as publication).
		expect(text).toContain(
			'record the closure ledger in the durable session task-gates',
		);
		expect(text).toContain('bound to the reviewed head SHA and fetch time');
		expect(text).toContain('Publish the ledger as a PR comment only');
		expect(text).toContain('after the reviewed commit is pushed');
		expect(text).toContain('.zcode/session/tasks/<slug>/gates.md');
		// Case-insensitive: a capital-P reintroduction must also fail.
		expect(text.toLowerCase()).not.toContain(
			'publish the closure ledger as a pr comment',
		);
	});

	test('#3607 round contract: intake-surfaces reference carries the re-fetch procedure and queue traps', () => {
		const intake = read(
			'.opencode/skills/swarm-pr-feedback/references/intake-surfaces.md',
		);
		expect(intake).toContain('## Round-boundary re-fetch');
		expect(intake).toContain('issues/<n>/comments --paginate');
		expect(intake).toContain('pulls/<n>/comments --paginate');
		expect(intake).toContain('pulls/<n>/reviews --paginate');
		expect(intake).toContain('## What counts as feedback or findings');
		expect(intake).toContain('## Merge-queue wait poll loop');
		// Second-confirmation trap: a single null read is UNKNOWN, never eviction.
		expect(intake).toContain('nulls=$((nulls + 1))');
		expect(intake).toContain('-ge 2');
		expect(intake).toContain(
			're-enqueue with gh pr merge <N> --repo <owner>/<repo> --match-head-commit <SHA>',
		);
		expect(intake).not.toContain('--auto --merge');
		expect(intake).toContain('untrusted data');
		// Error discrimination (#3611 hermes follow-up): a failed or error-bearing
		// query is state-unknown and NEVER increments the null counter; the merge
		// exit requires mergedAt non-null, not state alone.
		expect(intake).toContain('grc=$?');
		expect(intake).toContain('grep -q \'"errors"\'');
		expect(intake).toContain('state unknown, counter held');
		expect(intake).toContain('pullRequest missing from response');
		expect(intake).toContain('[ -n "$mergedAt" ]');
		expect(intake).not.toContain('Gate on state==MERGED + mergedAt');
	});
});
