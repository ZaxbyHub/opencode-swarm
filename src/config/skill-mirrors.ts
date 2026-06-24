/**
 * Single source of truth for skill mirror contracts between the OpenCode-side
 * (`.opencode/skills/`) and Claude-side (`.claude/skills/`) skill trees, plus
 * Codex/GitHub adapter shims (`.agents/skills/`, `.github/skills/`).
 *
 * Consumed by:
 *  - tests/unit/skills/skill-mirrors.test.ts (architect MODE mirror regression)
 *  - scripts/drift-check.ts (issue #1497 CI drift detector)
 *
 * Keeping the lists here — rather than inline in the test — means the drift
 * checker and the regression test cannot themselves drift apart.
 */

/**
 * Architect MODE skills whose `.opencode` and `.claude` mirrors must be
 * byte-identical. `.opencode` is the operative protocol loaded by
 * `src/agents/architect.ts` MODE stubs; the `.claude` mirror must match so
 * Claude Code and OpenCode sessions cannot diverge silently. Tuple shape is
 * `[slug, opencodePath, claudePath]`.
 */
export const MIRRORED_ARCHITECT_MODE_SKILLS = [
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

/**
 * Architect MODE skills where `.opencode` is the full operative protocol and
 * `.claude` is an intentionally different surface. Both must exist; byte
 * identity is not required, but the divergence is documented here.
 */
export const DIVERGENT_ARCHITECT_MODE_SKILLS: Array<{
	slug: string;
	opencodePath: string;
	claudePath: string;
	reason: string;
}> = [
	{
		slug: 'codebase-review-swarm',
		opencodePath: '.opencode/skills/codebase-review-swarm/SKILL.md',
		claudePath: '.claude/skills/codebase-review-swarm/SKILL.md',
		reason:
			'.opencode is the full portable package loaded by architect.ts MODE: CODEBASE_REVIEW; .claude is a thin adapter',
	},
];

/**
 * Architect MODE skills whose `.opencode` SKILL.md is canonical and whose
 * `.claude`/`.agents` surfaces are thin adapter shims that delegate back to the
 * canonical `.opencode` skill.
 *
 * `expectedCanonicalRef` is the relative path that each adapter SKILL.md must
 * contain as a reference back to the canonical `.opencode` skill. All adapter
 * shims live exactly three directory levels deep (`.{runtime}/skills/{slug}/`),
 * so `../../../` always resolves to the repo root from any adapter path. If
 * the directory structure changes (e.g., skills are reorganised to a flat
 * layout), update `expectedCanonicalRef` entries accordingly.
 */
export const ADAPTER_ARCHITECT_MODE_SKILLS: Array<{
	slug: string;
	canonicalPath: string;
	adapterPaths: string[];
	expectedCanonicalRef: string;
}> = [
	{
		slug: 'swarm-pr-review',
		canonicalPath: '.opencode/skills/swarm-pr-review/SKILL.md',
		adapterPaths: [
			'.claude/skills/swarm-pr-review/SKILL.md',
			'.agents/skills/swarm-pr-review/SKILL.md',
		],
		expectedCanonicalRef: '../../../.opencode/skills/swarm-pr-review/SKILL.md',
	},
	{
		slug: 'swarm-pr-feedback',
		canonicalPath: '.opencode/skills/swarm-pr-feedback/SKILL.md',
		adapterPaths: [
			'.claude/skills/swarm-pr-feedback/SKILL.md',
			'.agents/skills/swarm-pr-feedback/SKILL.md',
		],
		expectedCanonicalRef:
			'../../../.opencode/skills/swarm-pr-feedback/SKILL.md',
	},
];

/**
 * Architect MODE skills whose `.opencode` protocol is intentionally NOT mirrored
 * to `.claude` (e.g. a `.claude` mirror would shadow a Claude Code built-in
 * skill of the same name, or the mode is only reachable through the OpenCode
 * plugin runtime).
 */
export const OPENCODE_ONLY_ARCHITECT_MODE_SKILLS: Array<{
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

/**
 * Skill mirror contracts for skill pairs that are NOT architect MODE skills but
 * still exist across the `.opencode`/`.claude` trees. The drift checker
 * (scripts/drift-check.ts) classifies every cross-tree skill pair; without an
 * entry here a both-tree pair is reported as "unclassified" so a human decides
 * its contract. See issue #1497.
 *
 * `kind`:
 *  - `identical`: `.opencode` and `.claude` SKILL.md must be byte-identical.
 *    `canonical` records which side wins when they drift (fix direction only;
 *    detection is symmetric).
 *  - `divergent`: both must exist; content intentionally differs per runtime.
 *  - `opencode-only`: `.opencode` exists; no `.claude` mirror expected.
 */
export const ADDITIONAL_SKILL_MIRROR_CONTRACTS: Array<{
	slug: string;
	kind: 'identical' | 'divergent' | 'opencode-only';
	canonical?: '.claude' | '.opencode';
	reason: string;
}> = [
	{
		slug: 'commit-pr',
		kind: 'identical',
		canonical: '.claude',
		reason:
			'.github/workflows/pr-standards.yml declares .claude/skills/commit-pr/SKILL.md canonical ("it wins on any conflict"); .opencode must mirror it byte-for-byte (PR #1480 / #1497).',
	},
	{
		slug: 'engineering-conventions',
		kind: 'divergent',
		reason:
			'Intentional per-runtime divergence: .claude is titled "(Claude Code)" and carries an `effort:` frontmatter field; .opencode targets the OpenCode agent. Both point at AGENTS.md as the authoritative source.',
	},
	{
		slug: 'writing-tests',
		kind: 'divergent',
		reason:
			'PENDING MAINTAINER CONFIRMATION (#1497): shared intro but the .opencode variant is substantially longer. Classified divergent (non-failing) until the intended contract is confirmed; promote to `identical` if they should match.',
	},
	{
		slug: 'running-tests',
		kind: 'opencode-only',
		reason:
			'PENDING MAINTAINER CONFIRMATION (#1497): OpenCode-runtime test execution guidance (test_runner tool); no .claude mirror currently exists. Classified opencode-only (non-failing) until confirmed.',
	},
];

/**
 * Top-level entries under `.opencode/skills/` that are not bundled skills and
 * must be ignored by the drift checker. `generated/` holds user-generated
 * skills produced at runtime (src/services/skill-generator.ts) and has no
 * direct SKILL.md.
 */
export const NON_SKILL_OPENCODE_DIRS = new Set<string>(['generated']);
