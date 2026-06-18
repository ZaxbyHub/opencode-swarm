/**
 * Regression coverage for mirrored on-demand skills.
 */

import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const architectSource = readFileSync(
	join(process.cwd(), 'src/agents/architect.ts'),
	'utf-8',
);

// Skills where .opencode and .claude mirrors must be byte-identical.
// When adding a new architect mode stub that loads a skill, add it here
// (or to DIVERGENT_ARCHITECT_MODE_SKILLS if the .claude variant is intentionally condensed).
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
	[
		'resume',
		'.opencode/skills/resume/SKILL.md',
		'.claude/skills/resume/SKILL.md',
	],
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
		'deep-research',
		'.opencode/skills/deep-research/SKILL.md',
		'.claude/skills/deep-research/SKILL.md',
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
	[
		'design-docs',
		'.opencode/skills/design-docs/SKILL.md',
		'.claude/skills/design-docs/SKILL.md',
	],
] as const;

// Skills where .opencode is the full operative protocol loaded by architect.ts and
// .claude is an intentionally condensed variant for Claude Code sessions.
// Both files must exist; byte-identity is not required but divergence is documented here.
const DIVERGENT_ARCHITECT_MODE_SKILLS: Array<{
	slug: string;
	opencodePath: string;
	claudePath: string;
	reason: string;
}> = [
	{
		slug: 'swarm-pr-review',
		opencodePath: '.opencode/skills/swarm-pr-review/SKILL.md',
		claudePath: '.claude/skills/swarm-pr-review/SKILL.md',
		reason:
			'.claude is a 6-phase condensed variant; .opencode is the 12-phase full protocol loaded by architect.ts MODE: PR_REVIEW',
	},
	{
		slug: 'swarm-pr-feedback',
		opencodePath: '.opencode/skills/swarm-pr-feedback/SKILL.md',
		claudePath: '.claude/skills/swarm-pr-feedback/SKILL.md',
		reason:
			'.claude/.agents are thin adapters that delegate to canonical; .opencode is the full protocol loaded by architect.ts MODE: PR_FEEDBACK',
	},
	{
		slug: 'codebase-review-swarm',
		opencodePath: '.opencode/skills/codebase-review-swarm/SKILL.md',
		claudePath: '.claude/skills/codebase-review-swarm/SKILL.md',
		reason:
			'.opencode is the full portable package loaded by architect.ts MODE: CODEBASE_REVIEW; .claude is a thin adapter',
	},
];

// Skills whose architect mode stub loads a .opencode protocol that is
// intentionally NOT mirrored to .claude. Used when a .claude mirror would
// collide with a Claude Code built-in skill of the same name, or when the mode
// is only reachable through the OpenCode plugin runtime (not a Claude Code
// command). Both facts are asserted below so the intent is durable.
const OPENCODE_ONLY_ARCHITECT_MODE_SKILLS: Array<{
	slug: string;
	opencodePath: string;
	reason: string;
}> = [
	{
		slug: 'loop',
		opencodePath: '.opencode/skills/loop/SKILL.md',
		reason:
			"MODE: LOOP is reachable only through the OpenCode /swarm loop command; a .claude/skills/loop mirror would shadow Claude Code's built-in /loop (recurring-interval) skill, so it is intentionally not mirrored.",
	},
];

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

	for (const {
		slug,
		opencodePath,
		claudePath,
		reason,
	} of DIVERGENT_ARCHITECT_MODE_SKILLS) {
		it(`${slug} skill: both .opencode and .claude mirrors exist (${reason})`, () => {
			expect(existsSync(join(process.cwd(), opencodePath))).toBe(true);
			expect(existsSync(join(process.cwd(), claudePath))).toBe(true);
		});
	}

	for (const {
		slug,
		opencodePath,
		reason,
	} of OPENCODE_ONLY_ARCHITECT_MODE_SKILLS) {
		it(`${slug} skill: .opencode exists and is intentionally NOT mirrored to .claude (${reason})`, () => {
			expect(existsSync(join(process.cwd(), opencodePath))).toBe(true);
			const claudePath = opencodePath.replace(
				'.opencode/skills/',
				'.claude/skills/',
			);
			expect(existsSync(join(process.cwd(), claudePath))).toBe(false);
		});
	}

	it('keeps mirrored skill list in sync with architect mode stubs', () => {
		// Previous coverage used only this hardcoded list, so a new architect
		// stub could reference a skill that was never checked for mirror parity.
		const stubSlugs = [
			...architectSource.matchAll(
				/file:\.opencode\/skills\/([^/\s`]+)\/SKILL\.md/g,
			),
		].map((match) => match[1]);
		const mirroredSlugs = [
			...MIRRORED_ARCHITECT_MODE_SKILLS.map(([skillName]) => skillName),
			...DIVERGENT_ARCHITECT_MODE_SKILLS.map(({ slug }) => slug),
			...OPENCODE_ONLY_ARCHITECT_MODE_SKILLS.map(({ slug }) => slug),
		];

		// Deduplicate both sides — architect.ts may reference a slug in multiple
		// MODE stubs (e.g. when the same skill is loaded by two modes), and a
		// future editor could mistakenly add a slug to both MIRRORED and DIVERGENT.
		expect([...new Set(stubSlugs)].sort()).toEqual(
			[...new Set(mirroredSlugs)].sort(),
		);
	});
});
