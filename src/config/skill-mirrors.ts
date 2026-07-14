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
 * Claude Code and OpenCode sessions cannot diverge silently.
 *
 * `canonical` records which side wins when they drift (fix direction only;
 * detection is symmetric). For architect MODE skills `.opencode` is always
 * canonical because it is the operative protocol the MODE stubs load. Issue
 * #1781 E3 added this field so `drift:fix` can copy the canonical side to the
 * mirror without guessing.
 */
export const MIRRORED_ARCHITECT_MODE_SKILLS: Array<{
	slug: string;
	opencodePath: string;
	claudePath: string;
	canonical: '.opencode' | '.claude';
}> = [
	{
		slug: 'brainstorm',
		opencodePath: '.opencode/skills/brainstorm/SKILL.md',
		claudePath: '.claude/skills/brainstorm/SKILL.md',
		canonical: '.opencode',
	},
	{
		slug: 'specify',
		opencodePath: '.opencode/skills/specify/SKILL.md',
		claudePath: '.claude/skills/specify/SKILL.md',
		canonical: '.opencode',
	},
	{
		slug: 'clarify-spec',
		opencodePath: '.opencode/skills/clarify-spec/SKILL.md',
		claudePath: '.claude/skills/clarify-spec/SKILL.md',
		canonical: '.opencode',
	},
	{
		slug: 'resume',
		opencodePath: '.opencode/skills/resume/SKILL.md',
		claudePath: '.claude/skills/resume/SKILL.md',
		canonical: '.opencode',
	},
	{
		slug: 'clarify',
		opencodePath: '.opencode/skills/clarify/SKILL.md',
		claudePath: '.claude/skills/clarify/SKILL.md',
		canonical: '.opencode',
	},
	{
		slug: 'discover',
		opencodePath: '.opencode/skills/discover/SKILL.md',
		claudePath: '.claude/skills/discover/SKILL.md',
		canonical: '.opencode',
	},
	{
		slug: 'consult',
		opencodePath: '.opencode/skills/consult/SKILL.md',
		claudePath: '.claude/skills/consult/SKILL.md',
		canonical: '.opencode',
	},
	{
		slug: 'pre-phase-briefing',
		opencodePath: '.opencode/skills/pre-phase-briefing/SKILL.md',
		claudePath: '.claude/skills/pre-phase-briefing/SKILL.md',
		canonical: '.opencode',
	},
	{
		slug: 'council',
		opencodePath: '.opencode/skills/council/SKILL.md',
		claudePath: '.claude/skills/council/SKILL.md',
		canonical: '.opencode',
	},
	{
		slug: 'deep-dive',
		opencodePath: '.opencode/skills/deep-dive/SKILL.md',
		claudePath: '.claude/skills/deep-dive/SKILL.md',
		canonical: '.opencode',
	},
	{
		slug: 'deep-research',
		opencodePath: '.opencode/skills/deep-research/SKILL.md',
		claudePath: '.claude/skills/deep-research/SKILL.md',
		canonical: '.opencode',
	},
	{
		slug: 'issue-ingest',
		opencodePath: '.opencode/skills/issue-ingest/SKILL.md',
		claudePath: '.claude/skills/issue-ingest/SKILL.md',
		canonical: '.opencode',
	},
	{
		slug: 'plan',
		opencodePath: '.opencode/skills/plan/SKILL.md',
		claudePath: '.claude/skills/plan/SKILL.md',
		canonical: '.opencode',
	},
	{
		slug: 'critic-gate',
		opencodePath: '.opencode/skills/critic-gate/SKILL.md',
		claudePath: '.claude/skills/critic-gate/SKILL.md',
		canonical: '.opencode',
	},
	{
		slug: 'design-docs',
		opencodePath: '.opencode/skills/design-docs/SKILL.md',
		claudePath: '.claude/skills/design-docs/SKILL.md',
		canonical: '.opencode',
	},
];

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
		slug: 'execute',
		canonicalPath: '.opencode/skills/execute/SKILL.md',
		adapterPaths: ['.claude/skills/execute/SKILL.md'],
		expectedCanonicalRef: '../../../.opencode/skills/execute/SKILL.md',
	},
	{
		slug: 'phase-wrap',
		canonicalPath: '.opencode/skills/phase-wrap/SKILL.md',
		adapterPaths: ['.claude/skills/phase-wrap/SKILL.md'],
		expectedCanonicalRef: '../../../.opencode/skills/phase-wrap/SKILL.md',
	},
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
	{
		slug: 'swarm-pr-subscribe',
		canonicalPath: '.opencode/skills/swarm-pr-subscribe/SKILL.md',
		adapterPaths: [
			'.claude/skills/swarm-pr-subscribe/SKILL.md',
			'.agents/skills/swarm-pr-subscribe/SKILL.md',
		],
		expectedCanonicalRef:
			'../../../.opencode/skills/swarm-pr-subscribe/SKILL.md',
	},
	{
		slug: 'swarm-ci-monitor',
		canonicalPath: '.opencode/skills/swarm-ci-monitor/SKILL.md',
		adapterPaths: [
			'.claude/skills/swarm-ci-monitor/SKILL.md',
			'.agents/skills/swarm-ci-monitor/SKILL.md',
		],
		expectedCanonicalRef: '../../../.opencode/skills/swarm-ci-monitor/SKILL.md',
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
 *    detection is symmetric). `extraIdenticalPaths` narrowly extends the same
 *    byte-identity contract to additional runtime mirrors when present.
 *  - `divergent`: both must exist; content intentionally differs per runtime.
 *  - `opencode-only`: `.opencode` exists; no `.claude` mirror expected.
 *  - `adapter`: a non-architect-MODE skill whose `.opencode` copy is
 *    canonical and has no `.claude` copy at all, but does have one or more
 *    thin adapter shims (e.g. `.agents/skills/<slug>/`) that reference the
 *    canonical file by a fixed substring (`expectedCanonicalRef`). Mirrors
 *    the `ADAPTER_ARCHITECT_MODE_SKILLS` check, generalized to skills that
 *    are not architect MODE skills (so `identical`/`divergent`, which both
 *    require a `.claude` copy to exist, do not fit).
 */
export const ADDITIONAL_SKILL_MIRROR_CONTRACTS: Array<{
	slug: string;
	kind: 'identical' | 'divergent' | 'opencode-only' | 'adapter';
	canonical?: '.claude' | '.opencode';
	extraIdenticalPaths?: string[];
	/**
	 * For `divergent` pairs only: a set of Markdown section headings that must be
	 * present in BOTH trees (`.opencode` and `.claude`). Divergence is still
	 * allowed for genuinely runtime-specific prose (title line, `effort:`
	 * frontmatter, "(Claude Code)" phrasing), but these designated safety
	 * sections are parity-enforced by scripts/drift-check.ts so a whole safety
	 * guard cannot silently exist in one tree and be absent from the other.
	 * Match is a substring test, so a heading may omit a trailing parenthetical.
	 * Fixes the M13 skill-mirror safety-drift defect: the divergent branch
	 * previously did existence-only checks with no content comparison.
	 */
	sharedSafetyHeadings?: string[];
	adapterPaths?: string[];
	expectedCanonicalRef?: string;
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
		sharedSafetyHeadings: [
			'## SAST baseline capturing',
			'### Critical safety guard',
			'## Agent prompt strings — escaping pitfalls',
		],
		reason:
			'Intentional per-runtime divergence: .claude is titled "(Claude Code)" and carries an `effort:` frontmatter field; .opencode targets the OpenCode agent. Both point at AGENTS.md as the authoritative source. The `.claude` tree additionally carries the "Bounded is not free" nuance in invariant 1; `.opencode` now mirrors it. Designated safety sections — "## SAST baseline capturing" (with its "### Critical safety guard") and "## Agent prompt strings — escaping pitfalls" — are now parity-enforced across BOTH trees via `sharedSafetyHeadings`: drift:check fails if any of them exists in one tree but is absent from the other, closing the M13 safety-drift gap where the divergent branch did existence-only checks.',
	},
	{
		slug: 'swarm-implement',
		kind: 'divergent',
		reason:
			'.opencode is the canonical implementation workflow; .claude and .agents are thin adapters that delegate to it. Classified divergent because ADDITIONAL contracts do not yet model adapter shims.',
	},
	{
		slug: 'writing-tests',
		kind: 'divergent',
		reason:
			'.opencode is the canonical published test-authoring protocol; .claude is a thin adapter that delegates to it. Classified divergent because ADDITIONAL contracts do not yet model adapter shims.',
	},
	{
		slug: 'running-tests',
		kind: 'opencode-only',
		reason:
			'PENDING MAINTAINER CONFIRMATION (#1497): OpenCode-runtime test execution guidance (test_runner tool); no .claude mirror currently exists. Classified opencode-only (non-failing) until confirmed.',
	},
	{
		slug: 'swarm',
		kind: 'divergent',
		canonical: '.opencode',
		reason:
			'MODE: SWARM is the canonical OpenCode swarm workflow (behavior model); .claude/skills/swarm is a thin runtime adapter that documents the /swarm command and its subcommands. Both exist but serve different purposes — .opencode is the canonical workflow definition, .claude is the command-interface adapter.',
	},
	{
		slug: 'test-file-split',
		kind: 'identical',
		canonical: '.opencode',
		extraIdenticalPaths: ['.agents/skills/test-file-split/SKILL.md'],
		reason:
			'Byte-identical across .opencode, .claude, and .agents trees; .opencode is the canonical source.',
	},
	{
		slug: 'fork-pr-operations',
		kind: 'identical',
		canonical: '.opencode',
		extraIdenticalPaths: ['.agents/skills/fork-pr-operations/SKILL.md'],
		reason:
			'Byte-identical across .opencode, .claude, and .agents trees; .opencode is the canonical source.',
	},
	{
		slug: 'ci-fix-monitor',
		kind: 'adapter',
		adapterPaths: ['.agents/skills/ci-fix-monitor/SKILL.md'],
		expectedCanonicalRef: '.opencode/skills/ci-fix-monitor/SKILL.md',
		reason:
			'.opencode is the canonical protocol (a static, non-architect-MODE support skill composed by swarm-ci-monitor); .agents/skills/ci-fix-monitor is a thin Codex adapter shim that reads "Read .opencode/skills/ci-fix-monitor/SKILL.md for the full protocol." There is no .claude copy, so identical/divergent (which both require one) do not fit — same "adapter shim not yet modeled by ADDITIONAL contracts" situation as swarm-implement/writing-tests, generalized here into an explicit adapter kind (issue #1806).',
	},
];

/**
 * Top-level entries under `.opencode/skills/` that are not bundled skills and
 * must be ignored by the drift checker. `generated/` holds user-generated
 * skills produced at runtime (src/services/skill-generator.ts) and has no
 * direct SKILL.md.
 */
export const NON_SKILL_OPENCODE_DIRS = new Set<string>(['generated']);
