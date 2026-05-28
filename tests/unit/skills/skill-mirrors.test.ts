/**
 * Regression coverage for mirrored on-demand skills.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const MIRRORED_ARCHITECT_MODE_SKILLS = [
	[
		'brainstorm',
		'.opencode/skills/brainstorm/SKILL.md',
		'.claude/skills/brainstorm/SKILL.md',
	],
	[
		'specify',
		'.opencode/skills/specify/SKILL.md',
		'.claude/skills/specify/SKILL.md',
	],
	[
		'clarify-spec',
		'.opencode/skills/clarify-spec/SKILL.md',
		'.claude/skills/clarify-spec/SKILL.md',
	],
	['resume', '.opencode/skills/resume/SKILL.md', '.claude/skills/resume/SKILL.md'],
	[
		'clarify',
		'.opencode/skills/clarify/SKILL.md',
		'.claude/skills/clarify/SKILL.md',
	],
	[
		'discover',
		'.opencode/skills/discover/SKILL.md',
		'.claude/skills/discover/SKILL.md',
	],
	[
		'consult',
		'.opencode/skills/consult/SKILL.md',
		'.claude/skills/consult/SKILL.md',
	],
	[
		'pre-phase-briefing',
		'.opencode/skills/pre-phase-briefing/SKILL.md',
		'.claude/skills/pre-phase-briefing/SKILL.md',
	],
	[
		'council',
		'.opencode/skills/council/SKILL.md',
		'.claude/skills/council/SKILL.md',
	],
	[
		'deep-dive',
		'.opencode/skills/deep-dive/SKILL.md',
		'.claude/skills/deep-dive/SKILL.md',
	],
	[
		'issue-ingest',
		'.opencode/skills/issue-ingest/SKILL.md',
		'.claude/skills/issue-ingest/SKILL.md',
	],
	['plan', '.opencode/skills/plan/SKILL.md', '.claude/skills/plan/SKILL.md'],
	[
		'critic-gate',
		'.opencode/skills/critic-gate/SKILL.md',
		'.claude/skills/critic-gate/SKILL.md',
	],
	[
		'execute',
		'.opencode/skills/execute/SKILL.md',
		'.claude/skills/execute/SKILL.md',
	],
	[
		'phase-wrap',
		'.opencode/skills/phase-wrap/SKILL.md',
		'.claude/skills/phase-wrap/SKILL.md',
	],
] as const;

describe('architect mode skill mirrors - regression: prevent mirror drift (F-001)', () => {
	for (const [
		skillName,
		opencodePath,
		claudePath,
	] of MIRRORED_ARCHITECT_MODE_SKILLS) {
		it(`${skillName} skill stays byte-identical across OpenCode and Claude mirrors`, () => {
			// Future protocol edits must update both mirrors together; otherwise
			// OpenCode and Claude sessions can diverge silently.
			const opencodeSkill = readFileSync(
				join(process.cwd(), opencodePath),
				'utf-8',
			);
			const claudeSkill = readFileSync(
				join(process.cwd(), claudePath),
				'utf-8',
			);

			expect(claudeSkill).toBe(opencodeSkill);
		});
	}
});
