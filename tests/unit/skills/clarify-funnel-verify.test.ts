/**
 * Verification tests for Task 1.2 — clarification-funnel protocol.
 *
 * Validates:
 * 1. .opencode/skills/clarify/SKILL.md no longer contains "Ask up to 3 questions"
 * 2. Contains all four funnel stages
 * 3. Contains all five classification categories
 * 4. Contains all four critic outcomes
 * 5. Contains "Always-Surface Categories"
 * 6. .claude/skills/clarify/SKILL.md is byte-identical to .opencode version
 */

import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const OPENCODE_CLARIFY = join(
	process.cwd(),
	'.opencode/skills/clarify/SKILL.md',
);
const CLAUDE_CLARIFY = join(process.cwd(), '.claude/skills/clarify/SKILL.md');
const INDEX_FILE = join(process.cwd(), 'src', 'index.ts');

describe('Task 1.2 — clarification funnel protocol', () => {
	describe('Skill file existence', () => {
		it('exists in .opencode/skills/clarify/', () => {
			expect(existsSync(OPENCODE_CLARIFY)).toBe(true);
		});

		it('exists in .claude/skills/clarify/', () => {
			expect(existsSync(CLAUDE_CLARIFY)).toBe(true);
		});
	});

	describe('No "Ask up to 3 questions" cap', () => {
		it('opencode version does not contain the old "Ask up to 3 questions" phrase', () => {
			const content = readFileSync(OPENCODE_CLARIFY, 'utf-8');
			expect(content).not.toContain('Ask up to 3 questions');
		});

		it('opencode version does not contain a numeric question cap anywhere', () => {
			const content = readFileSync(OPENCODE_CLARIFY, 'utf-8');
			// The new protocol says "There is NO hard cap on the internal inventory"
			// So there should be no "up to N questions" pattern remaining
			expect(content).not.toMatch(/up to \d+ question/);
		});
	});

	describe('Four funnel stages', () => {
		const content: string = readFileSync(OPENCODE_CLARIFY, 'utf-8');

		it('Stage 1: Inventory All Material Uncertainties', () => {
			expect(content).toContain(
				'Stage 1: Inventory All Material Uncertainties',
			);
		});

		it('Stage 2: Classify Each Uncertainty', () => {
			expect(content).toContain('Stage 2: Classify Each Uncertainty');
		});

		it('Stage 3: Consult Critic Sounding Board', () => {
			expect(content).toContain('Stage 3: Consult Critic Sounding Board');
		});

		it('Stage 4: Surface User Decision Packet', () => {
			expect(content).toContain('Stage 4: Surface User Decision Packet');
		});
	});

	describe('Five classification categories', () => {
		const content: string = readFileSync(OPENCODE_CLARIFY, 'utf-8');

		it('self_resolved', () => {
			expect(content).toContain('self_resolved');
		});

		it('critic_resolved', () => {
			expect(content).toContain('critic_resolved');
		});

		it('research_needed', () => {
			expect(content).toContain('research_needed');
		});

		it('user_decision', () => {
			expect(content).toContain('user_decision');
		});

		it('deferred_nonblocking', () => {
			expect(content).toContain('deferred_nonblocking');
		});
	});

	describe('Four critic outcomes', () => {
		const content: string = readFileSync(OPENCODE_CLARIFY, 'utf-8');

		// Anchor assertions to the Stage 3 section to prevent false positives
		// if the words appear elsewhere but the structured mapping is removed
		const stage3Start = content.indexOf(
			'#### Stage 3: Consult Critic Sounding Board',
		);
		const stage4Start = content.indexOf(
			'#### Stage 4: Surface User Decision Packet',
		);
		expect(stage3Start).toBeGreaterThan(-1);
		expect(stage4Start).toBeGreaterThan(stage3Start);
		const stage3Section = content.slice(stage3Start, stage4Start);

		it('UNNECESSARY', () => {
			expect(stage3Section).toContain('UNNECESSARY');
		});

		it('RESOLVE', () => {
			expect(stage3Section).toContain('RESOLVE');
		});

		it('REPHRASE', () => {
			expect(stage3Section).toContain('REPHRASE');
		});

		it('APPROVED', () => {
			expect(stage3Section).toContain('APPROVED');
		});

		it('verdict mapping table is present in Stage 3', () => {
			expect(stage3Section).toContain('SoundingBoardVerdict');
			expect(stage3Section).toContain('Funnel Action');
		});

		it('always-surface DROP protection uses critic verdict labels', () => {
			expect(stage3Section).toContain('UNNECESSARY');
			expect(stage3Section).toContain('APPROVED');
		});

		it('overconfidence guard is present in Stage 3', () => {
			expect(stage3Section).toContain('Overconfidence guard');
		});
	});

	describe('Always-Surface Categories', () => {
		const content: string = readFileSync(OPENCODE_CLARIFY, 'utf-8');

		it('section heading exists', () => {
			expect(content).toContain('Always-Surface Categories');
		});

		it('lists scope boundaries', () => {
			expect(content).toContain('Scope boundaries');
		});

		it('lists data loss or destructive behavior', () => {
			expect(content).toContain('Data loss or destructive behavior');
		});

		it('lists security/privacy risk tolerance', () => {
			expect(content).toContain('Security/privacy risk tolerance');
		});
	});

	describe('Mirror parity — byte-identical files', () => {
		it('.claude version is byte-identical to .opencode version', () => {
			const opencodeContent = readFileSync(OPENCODE_CLARIFY);
			const claudeContent = readFileSync(CLAUDE_CLARIFY);
			expect(claudeContent).toEqual(opencodeContent);
		});
	});

	describe('Cross-skill consistency (F-008)', () => {
		it('abbreviated funnel summaries in specify, brainstorm, issue-ingest contain overconfidence guard', () => {
			for (const slug of ['specify', 'brainstorm', 'issue-ingest']) {
				const skillPath = join(
					process.cwd(),
					'.opencode/skills',
					slug,
					'SKILL.md',
				);
				const content = readFileSync(skillPath, 'utf-8');
				expect(content, `${slug} missing overconfidence guard`).toContain(
					'overconfidence guard',
				);
			}
		});

		it('abbreviated funnel summaries in specify, brainstorm, issue-ingest contain always-surface protection', () => {
			for (const slug of ['specify', 'brainstorm', 'issue-ingest']) {
				const skillPath = join(
					process.cwd(),
					'.opencode/skills',
					slug,
					'SKILL.md',
				);
				const content = readFileSync(skillPath, 'utf-8');
				expect(
					content,
					`${slug} missing always-surface DROP protection`,
				).toContain('always-surface');
				expect(
					content,
					`${slug} missing UNNECESSARY/DROP override language`,
				).toMatch(/UNNECESSARY.*DROP/);
			}
		});

		it('abbreviated funnel summaries reference SoundingBoardVerdict mapping', () => {
			for (const slug of ['specify', 'brainstorm', 'issue-ingest']) {
				const skillPath = join(
					process.cwd(),
					'.opencode/skills',
					slug,
					'SKILL.md',
				);
				const content = readFileSync(skillPath, 'utf-8');
				expect(
					content,
					`${slug} missing SoundingBoardVerdict reference`,
				).toContain('SoundingBoardVerdict');
			}
		});

		it('clarify-spec contains scoped funnel protocol', () => {
			const clarifySpecPath = join(
				process.cwd(),
				'.opencode/skills/clarify-spec/SKILL.md',
			);
			const content = readFileSync(clarifySpecPath, 'utf-8');
			expect(content).toContain('Scoped Funnel Protocol');
			expect(content.toLowerCase()).toContain('overconfidence guard');
			expect(content).toContain('always-surface protection');
			expect(content).toContain('SoundingBoardVerdict');
		});
	});

	describe('Sounding board null-parse fallback (F-005) — src/index.ts', () => {
		it('fallback does NOT say "Treat as APPROVED" (conservative, not fail-open)', () => {
			const indexContent = readFileSync(INDEX_FILE, 'utf-8');
			expect(indexContent).not.toContain('Treat as APPROVED');
		});

		it('fallback instructs conservative REPHRASE behavior', () => {
			const indexContent = readFileSync(INDEX_FILE, 'utf-8');
			expect(indexContent).toContain('Treat as REPHRASE');
			expect(indexContent).toContain(
				'review the raw response before surfacing',
			);
		});
	});
});
