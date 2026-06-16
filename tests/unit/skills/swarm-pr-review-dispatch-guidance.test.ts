import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SWARM_PR_REVIEW_SKILLS = [
	'.opencode/skills/swarm-pr-review/SKILL.md',
	'.agents/skills/swarm-pr-review/SKILL.md',
	'.claude/skills/swarm-pr-review/SKILL.md',
] as const;

describe('swarm-pr-review deterministic lane dispatch guidance', () => {
	for (const skillPath of SWARM_PR_REVIEW_SKILLS) {
		test(`${skillPath} uses dispatch_lanes instead of native background Task batching`, () => {
			const source = readFileSync(join(process.cwd(), skillPath), 'utf-8');

			expect(source).toContain('dispatch_lanes');
			expect(source).toContain('lane_results');
			expect(source).not.toContain('run_in_background');
			expect(source).not.toContain(
				'single message with multiple Agent tool calls',
			);
		});
	}
});
