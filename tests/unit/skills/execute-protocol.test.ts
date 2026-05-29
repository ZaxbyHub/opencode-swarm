/**
 * Verification tests for .opencode/skills/execute/SKILL.md protocol content.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SKILL_PATH = join(process.cwd(), '.opencode/skills/execute/SKILL.md');
const skillContent = readFileSync(SKILL_PATH, 'utf-8');

describe('.opencode/skills/execute/SKILL.md protocol content', () => {
	describe('frontmatter', () => {
		it('declares the execute skill', () => {
			expect(skillContent).toContain('name: execute');
			expect(skillContent).toContain('description:');
		});
	});

	describe('execution protocol', () => {
		it('keeps retry and coder gate-failure rules', () => {
			expect(skillContent).toContain('RETRY PROTOCOL');
			expect(skillContent).toContain('GATE FAILURE RESPONSE RULES');
			expect(skillContent).toContain(
				"You MUST return to the active swarm's coder agent",
			);
		});

		it('keeps scope declaration and baseline rules', () => {
			expect(skillContent).toContain('5b-PRE (required)');
			expect(skillContent).toContain('declare_scope({ taskId, files })');
			expect(skillContent).toContain('5b-BASE (required, once per task)');
			expect(skillContent).toContain('sast-baseline');
		});

		it('keeps all named per-task gates', () => {
			for (const gate of [
				'diff',
				'syntax_check',
				'placeholder_scan',
				'imports',
				'lint',
				'build_check',
				'pre_check_batch',
				'reviewer',
				'security-reviewer',
				'testengineer-verification',
				'regression-sweep',
				'test-drift',
				'todo-scan',
			]) {
				expect(skillContent).toContain(gate);
			}
		});

		it('keeps pre-commit and task completion gates', () => {
			expect(skillContent).toContain('PRE-COMMIT RULE');
			expect(skillContent).toContain('TASK COMPLETION GATE');
			expect(skillContent).toContain('Any blank "value: ___" field');
		});

		it('does not contain raw config-renderer placeholders', () => {
			expect(skillContent).not.toContain('{{ADVERSARIAL_TEST_STEP}}');
			expect(skillContent).not.toContain('{{ADVERSARIAL_TEST_CHECKLIST}}');
			expect(skillContent).toContain('MODE: EXECUTE architect stub');
		});
	});
});
