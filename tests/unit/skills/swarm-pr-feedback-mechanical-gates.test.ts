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
		]) {
			expect(source).toContain(required);
		}
		expect(source).toContain('There is no speed, efficiency, token, or time');
		expect(source).not.toContain('.claude/session/tasks/<slug>/gates.md');
	});

	for (const adapter of ADAPTERS) {
		test(`${adapter} preserves the structured-mode prohibition on fallback`, () => {
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
			expect(source).not.toContain('.claude/session/tasks/<slug>/gates.md');
			expect(source).not.toContain('$writing-tests');
			expect(source).not.toContain('$commit-pr');
			expect(source).not.toContain('Task-tool dispatch as the final fallback');
		});
	}
});
