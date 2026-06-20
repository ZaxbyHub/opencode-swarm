import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CANONICAL_SKILL = '.opencode/skills/swarm-pr-review/SKILL.md';
const ADAPTER_SKILLS = [
	'.agents/skills/swarm-pr-review/SKILL.md',
	'.claude/skills/swarm-pr-review/SKILL.md',
] as const;

function readSkill(skillPath: string): string {
	return readFileSync(join(process.cwd(), skillPath), 'utf-8');
}

function sectionBetween(
	source: string,
	startHeading: string,
	nextHeading: string,
): string {
	const start = source.indexOf(startHeading);
	const end = source.indexOf(nextHeading, start + startHeading.length);
	expect(start).toBeGreaterThan(-1);
	expect(end).toBeGreaterThan(start);
	return source.slice(start, end);
}

describe('swarm-pr-review deterministic async lane dispatch guidance', () => {
	test('canonical .opencode skill uses async lane collection and documents the review handoff contract', () => {
		const source = readSkill(CANONICAL_SKILL);
		const handoffSection = sectionBetween(
			source,
			'## Handoff To PR Feedback',
			'## Operating Stance',
		);
		const mergeabilitySection = sectionBetween(
			source,
			'## Phase 0B: Mergeability and Branch-State Intake',
			'## Phase 0: Context Pack and Review Signal Collection',
		);
		const phase3Section = sectionBetween(
			source,
			'## Phase 3: Parallel Base Explorer Lanes',
			'## Phase 4: Triggered Swarm Plugin Micro-Lanes',
		);

		expect(phase3Section).toContain('dispatch_lanes_async');
		expect(phase3Section).toContain('collect_lane_results');
		expect(phase3Section).toContain('lane_results');
		expect(phase3Section).toContain('dispatch_lanes');
		expect(phase3Section).not.toContain('run_in_background');
		expect(phase3Section).not.toContain(
			'single message with multiple Agent tool calls',
		);
		expect(source).toContain(
			'review comments, review summaries, requested changes',
		);
		expect(source).toContain('CI/check failures');
		expect(source).toContain('mergeability/conflicts');
		expect(source).toContain('GraphQL review-thread inspection');
		expect(handoffSection).toContain(
			'.swarm/pr-review/<run_id>/feedback-handoff.md',
		);
		expect(handoffSection).toContain(
			'/swarm pr-feedback <PR_URL> continue from .swarm/pr-review/<run_id>/feedback-handoff.md',
		);
		expect(handoffSection).toContain('stop and ask the user');
		expect(mergeabilitySection).toContain('remains read-only');
		expect(mergeabilitySection).toContain('Record conflicts and blockers');
		expect(mergeabilitySection).not.toContain('Resolve before reviewing');
		expect(mergeabilitySection).not.toContain(
			'Resolve conflicts (when CONFLICTING or DIRTY)',
		);
		expect(mergeabilitySection).not.toContain(
			'git merge origin/$BASE_REF --no-commit --no-ff',
		);
	});

	for (const skillPath of ADAPTER_SKILLS) {
		test(`${skillPath} stays a thin adapter to the canonical .opencode skill`, () => {
			const source = readSkill(skillPath);
			const lineCount = source.trimEnd().split(/\r?\n/).length;

			expect(lineCount).toBeLessThan(60);
			expect(source).toContain(
				'../../../.opencode/skills/swarm-pr-review/SKILL.md',
			);
			expect(source).toContain('canonical workflow');
			expect(source).toContain('read-only');
			expect(source).toContain('dispatch_lanes_async');
			expect(source).toContain('collect_lane_results');
			expect(source).not.toContain('## Phase 0A:');
			expect(source).not.toContain('## Phase 0B:');
			expect(source).not.toContain(
				'Legacy mirror text retained only as commented reference',
			);
			expect(source).not.toContain('<!--');
		});
	}
});
