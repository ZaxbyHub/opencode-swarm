import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();

function readSkill(path: string): string {
	return readFileSync(join(ROOT, path), 'utf-8');
}

function sectionBetween(
	source: string,
	startHeading: string,
	endHeading: string,
) {
	const start = source.indexOf(startHeading);
	const end = source.indexOf(endHeading, start + startHeading.length);
	expect(start).toBeGreaterThan(-1);
	expect(end).toBeGreaterThan(start);
	return source.slice(start, end);
}

describe('process-improvement skill guidance', () => {
	test('execute protocol requires phase-scoped SAST baseline before coder delegation', () => {
		const source = readSkill('.opencode/skills/execute/SKILL.md');
		const taskGate = sectionBetween(
			source,
			'5b-PRE (required):',
			'5b. the active swarm',
		);
		const preCommitGate = sectionBetween(
			source,
			'PRE-COMMIT RULE',
			'## ROLE-BOUNDARY CHANGE VALIDATION',
		);

		expect(taskGate).toContain('capture_baseline: true');
		expect(taskGate).toContain('phase-scoped');
		expect(taskGate).toContain(
			'SAST baseline captured before first coder delegation?',
		);
		expect(preCommitGate).toContain(
			'SAST baseline captured before first coder delegation',
		);
	});

	test('swarm-pr-review persists findings across explorer, reviewer, and critic phases', () => {
		const source = readSkill('.opencode/skills/swarm-pr-review/SKILL.md');
		const persistence = sectionBetween(
			source,
			'## Review Finding Persistence',
			'## Phase 1:',
		);

		for (const field of [
			'finding_id',
			'status',
			'file_line',
			'evidence',
			'next_action',
		]) {
			expect(persistence).toContain(field);
		}
		for (const status of [
			'PENDING',
			'CONFIRMED',
			'DISPROVED',
			'PRE_EXISTING',
		]) {
			expect(persistence).toContain(status);
		}
		expect(persistence).toContain('Post-explorer');
		expect(persistence).toContain('Post-reviewer');
		expect(persistence).toContain('Post-critic');
		expect(persistence).toContain('Resume/reload procedure');
		expect(source).toContain('persist the post-explorer');
		expect(source).toContain('persist the post-reviewer');
		expect(source).toContain('persist the post-critic');
		expect(source).toContain('.swarm/pr-review/<run_id>/trigger-eval.json');
		expect(source).toContain('separate from `findings.jsonl`');
	});

	test('review and implementation workflows require local PR checkout and commit-range context', () => {
		const codebase = readSkill(
			'.opencode/skills/codebase-review-swarm/SKILL.md',
		);
		const feedback = readSkill('.opencode/skills/swarm-pr-feedback/SKILL.md');
		const implement = readSkill('.opencode/skills/swarm-implement/SKILL.md');

		for (const source of [codebase, implement]) {
			const lower = source.toLowerCase();
			expect(source).toContain('git status --porcelain');
			expect(lower).toContain('check out');
			expect(source).toContain('base_ref..head_ref');
		}
		expect(feedback).toContain('git status --porcelain');
		expect(feedback.toLowerCase()).toContain('check out');
		expect(feedback).toContain('merge_base...head_ref');

		// FB-001: isolated assertion — swarm-implement must have its own Phase 0b section
		const implementSource = readSkill(
			'.opencode/skills/swarm-implement/SKILL.md',
		);
		expect(implementSource).toContain('### Phase 0b');
		expect(implementSource).toContain('PR branch checkout pre-flight');
	});

	test('regression coverage requires falsification evidence in authoring and phase gates', () => {
		const writingTests = readSkill('.opencode/skills/writing-tests/SKILL.md');
		const phaseWrap = readSkill('.opencode/skills/phase-wrap/SKILL.md');
		const implement = readSkill('.opencode/skills/swarm-implement/SKILL.md');

		expect(writingTests).toContain('Regression tests must be falsifiable');
		expect(writingTests).toContain('temporarily remove or bypass the fix');
		expect(phaseWrap).toContain('regression-test falsification evidence');
		expect(phaseWrap).toContain('fix removed/bypassed -> test fails');
		expect(implement).toContain('falsification');
		expect(implement).toContain('evidence');
		expect(implement).toContain('the fix was temporarily');
	});

	test('swarm-implement keeps .opencode canonical with thin adapters', () => {
		const claudeAdapter = readSkill('.claude/skills/swarm-implement/SKILL.md');
		const codexAdapter = readSkill('.agents/skills/swarm-implement/SKILL.md');

		for (const adapter of [claudeAdapter, codexAdapter]) {
			expect(adapter).toContain(
				'../../../.opencode/skills/swarm-implement/SKILL.md',
			);
			expect(adapter).toContain('canonical workflow');
			expect(adapter).not.toContain('### Phase 0b');
		}

		// FB-002: line-count bound — ADDITIONAL contract adapters must stay thin
		const claudeLines = claudeAdapter.split('\n').length;
		const codexLines = codexAdapter.split('\n').length;
		expect(claudeLines).toBeLessThan(30);
		expect(codexLines).toBeLessThan(30);
	});

	test('writing-tests keeps .opencode canonical with thin Claude/Codex adapters', () => {
		const claudeAdapter = readSkill('.claude/skills/writing-tests/SKILL.md');
		const codexAdapter = readSkill('.agents/skills/writing-tests/SKILL.md');

		expect(claudeAdapter).toContain(
			'../../../.opencode/skills/writing-tests/SKILL.md',
		);
		expect(claudeAdapter).toContain('canonical workflow');
		expect(codexAdapter).toContain('.opencode/skills/writing-tests/SKILL.md');
		expect(codexAdapter).toContain('Regression tests must also be falsifiable');

		// FB-002: line-count bound — ADDITIONAL contract adapters must stay thin
		const claudeAdapterLines = claudeAdapter.split('\n').length;
		expect(claudeAdapterLines).toBeLessThan(30);
	});
});
