/**
 * FR-004 task 3.2 verification: swarm-resume SKILL.md mirrors stay byte-identical
 * and both carry the new worktree-reconciliation step added in the stale
 * worktree/branch reconciliation PR.
 *
 * Byte-identity of the resume mirrors is also covered by
 * MIRRORED_ARCHITECT_MODE_SKILLS in skill-mirrors.test.ts; this file
 * provides the additional section-anchored content check for the new step.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const OPENCODE_PATH = join(
	process.cwd(),
	'.opencode/skills/swarm-resume/SKILL.md',
);
const CLAUDE_PATH = join(process.cwd(), '.claude/skills/swarm-resume/SKILL.md');

function errorMessage(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err);
}

describe('swarm-resume SKILL.md mirrors — FR-004 task 3.2', () => {
	// ─────────────────────────────────────────────────────────────────────
	// Byte-identity (also covered by skill-mirrors.test.ts)
	// ─────────────────────────────────────────────────────────────────────

	it('both mirror files exist', () => {
		expect(existsSync(OPENCODE_PATH)).toBe(true);
		expect(existsSync(CLAUDE_PATH)).toBe(true);
	});

	it('.opencode and .claude swarm-resume skills are byte-identical', () => {
		// Normalize line endings so CRLF/LF differences don't cause spurious failures
		// on Windows git clones.
		const opencodeContent = readFileSync(OPENCODE_PATH, 'utf-8').replace(
			/\r\n/g,
			'\n',
		);
		const claudeContent = readFileSync(CLAUDE_PATH, 'utf-8').replace(
			/\r\n/g,
			'\n',
		);
		expect(claudeContent).toBe(opencodeContent);
	});

	// ─────────────────────────────────────────────────────────────────────
	// Worktree-reconciliation step content (FR-004 task 3.2)
	// ─────────────────────────────────────────────────────────────────────

	describe('worktree-reconciliation step present in both mirrors', () => {
		for (const [label, filePath] of [
			['.opencode', OPENCODE_PATH],
			['.claude', CLAUDE_PATH],
		] as const) {
			it(`${label}: MODE: RESUME section contains worktree-reconciliation step (step 2)`, () => {
				const content = readFileSync(filePath, 'utf-8').replace(/\r\n/g, '\n');

				// Anchor to the MODE: RESUME heading so we know we're in the right section
				const modeStart = content.indexOf('### MODE: RESUME');
				expect(modeStart).toBeGreaterThanOrEqual(0);

				// The step-2 block (lines 14-16 in the file) contains the reconciliation directive
				const step2Start = content.indexOf(
					'If Swarm field missing or matches the active swarm id:',
					modeStart,
				);
				expect(step2Start).toBeGreaterThan(modeStart);

				// Section ends at step 3 (next if-branch) or the "If new project" block
				const step3Start = content.indexOf(
					'If Swarm field differs',
					step2Start,
				);
				const sectionEnd =
					step3Start > 0 ? step3Start : content.indexOf('If new project');
				const step2Section = content.slice(step2Start, sectionEnd);

				expect(step2Section).toContain('.swarm-worktrees/');
				expect(step2Section).toContain('cleanupOrphanedBranches');
			});

			it(`${label}: MODE: RESUME section contains worktree-reconciliation step (step 3 cross-swarm)`, () => {
				const content = readFileSync(filePath, 'utf-8').replace(/\r\n/g, '\n');

				const modeStart = content.indexOf('### MODE: RESUME');
				expect(modeStart).toBeGreaterThanOrEqual(0);

				// Step 3: cross-swarm resume
				const step3Start = content.indexOf('If Swarm field differs', modeStart);
				expect(step3Start).toBeGreaterThan(modeStart);

				const step3Section = content.slice(
					step3Start,
					content.indexOf('If .swarm/plan.md does not exist', step3Start),
				);

				expect(step3Section).toContain('.swarm-worktrees/');
				expect(step3Section).toContain('cleanupOrphanedBranches');
			});
		}
	});

	it('skill-mirrors.test.ts resume entry confirms byte-identity (do not duplicate — just confirm)', () => {
		// This test exists solely as a marker/reminder that the actual
		// byte-identity regression assertion lives in
		// tests/unit/skills/skill-mirrors.test.ts via
		// MIRRORED_ARCHITECT_MODE_SKILLS. If that test ever starts failing
		// for resume, the mirrors have drifted.
		//
		// We do a lightweight sanity-check here: verify the skill-mirrors
		// source still references resume.
		const skillMirrorsSrc = readFileSync(
			join(process.cwd(), 'src/config/skill-mirrors.ts'),
			'utf-8',
		);
		expect(skillMirrorsSrc).toContain('swarm-resume');
		expect(skillMirrorsSrc).toContain('.opencode/skills/swarm-resume/SKILL.md');
	});
});
