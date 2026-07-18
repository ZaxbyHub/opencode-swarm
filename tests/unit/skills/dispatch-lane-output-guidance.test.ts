import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const GUIDANCE_FILES = [
	'.opencode/skills/deep-dive/SKILL.md',
	'.claude/skills/deep-dive/SKILL.md',
	'.opencode/skills/deep-research/SKILL.md',
	'.claude/skills/deep-research/SKILL.md',
	'.opencode/skills/council/SKILL.md',
	'.claude/skills/council/SKILL.md',
	'.opencode/skills/swarm-pr-feedback/SKILL.md',
	'.agents/skills/swarm-pr-feedback/SKILL.md',
	'.claude/skills/swarm-pr-feedback/SKILL.md',
	'.opencode/skills/codebase-review-swarm/references/review-protocol-v8.2.md',
	'.agents/skills/codebase-review-swarm/SKILL.md',
	'.claude/skills/codebase-review-swarm/SKILL.md',
] as const;

function readRepoFile(filePath: string): string {
	return readFileSync(join(process.cwd(), filePath), 'utf-8');
}

describe('dispatch lane full-output retrieval guidance', () => {
	for (const filePath of GUIDANCE_FILES) {
		test(`${filePath} requires full output retrieval before consuming lane results`, () => {
			const source = readRepoFile(filePath);

			expect(source).toContain('output_ref');
			// The .agents (Codex) adapter uses capability phrasing instead of the
			// OpenCode-specific tool name (GPT-17, issue #1804); all other files
			// pin the concrete retrieve_lane_output tool.
			if (!filePath.startsWith('.agents/')) {
				expect(source).toContain('retrieve_lane_output');
			} else {
				expect(source).toMatch(
					/lane-output retrieval capability|retrieve.*output_ref/i,
				);
			}
			expect(source).toMatch(/preview/i);
			expect(source).toMatch(
				/degraded|incomplete|coverage gap|coverage limitation|evidence gaps/i,
			);
		});
	}

	for (const filePath of [
		'.opencode/skills/deep-research/SKILL.md',
		'.claude/skills/deep-research/SKILL.md',
		'.opencode/skills/council/SKILL.md',
		'.claude/skills/council/SKILL.md',
	] as const) {
		test(`${filePath} keeps advisory lanes on lane tools before Task fallback`, () => {
			const source = readRepoFile(filePath);

			expect(source).toContain('dispatch_lanes_async');
			expect(source).toContain('collect_lane_results');
			expect(source).toMatch(/without\s+`wait`/);
			expect(source).toContain('wait: false');
			expect(source).toContain('wait: true');
			expect(source).toContain('blocking `dispatch_lanes`');
			expect(source).toContain('Task is the final fallback');
			expect(source).toContain('verified as equivalent');
			expect(source).not.toContain('blocking parallel dispatch');
		});
	}
});

describe('swarm-pr-feedback host-neutral batch collection', () => {
	for (const filePath of [
		'.opencode/skills/swarm-pr-feedback/SKILL.md',
		'.claude/skills/swarm-pr-feedback/SKILL.md',
	] as const) {
		test(`${filePath} contains batch-collection step`, () => {
			const source = readRepoFile(filePath);

			// Batch collection step: gh pr checks → gh run view --log-failed → full ledger
			expect(source).toContain('gh pr checks');
			expect(source).toContain('--log-failed');
			expect(source).toMatch(/host-(?:neutral|equivalent)/i);
			expect(source).toMatch(/batch|one batch|all failures in one/i);
		});
	}
});
