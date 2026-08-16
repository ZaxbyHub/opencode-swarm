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
	kind: 'identical' | 'divergent' | 'opencode-only' | 'adapter' | 'agents-only';
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
		kind: 'divergent',
		extraIdenticalPaths: [
			'.github/skills/commit-pr/SKILL.md',
			'.agents/skills/commit-pr/SKILL.md',
		],
		reason:
			"Intentional per-tree divergence (#1692): .claude/skills/commit-pr is the repo-INTERNAL publication protocol enforced by .github/workflows/pr-standards.yml (invariant audit, release fragments, bun/biome tiers, canonical-remote heuristic). .opencode/skills/commit-pr is the PORTABLE, project-agnostic version bundled into end-user projects via BUNDLED_PROJECT_SKILLS — it must NOT carry this repo's internal references (AGENTS.md, bun/biome, docs/releases/pending, ZaxbyHub), so the two trees intentionally differ. .github/skills/commit-pr is a GitHub/Copilot adapter shim that delegates to .claude; .agents/skills/commit-pr is a Codex adapter shim that also delegates to .claude.",
	},
	{
		slug: 'engineering-conventions',
		kind: 'divergent',
		extraIdenticalPaths: ['.agents/skills/engineering-conventions/SKILL.md'],
		sharedSafetyHeadings: [
			'## SAST baseline capturing',
			'### Critical safety guard',
			'## Agent prompt strings — escaping pitfalls',
		],
		reason:
			'Intentional per-runtime divergence: .claude is titled "(Claude Code)" and carries an `effort:` frontmatter field; .opencode targets the OpenCode agent. Both point at AGENTS.md as the authoritative source. The `.claude` tree additionally carries the "Bounded is not free" nuance in invariant 1; `.opencode` now mirrors it. Designated safety sections — "## SAST baseline capturing" (with its "### Critical safety guard") and "## Agent prompt strings — escaping pitfalls" — are now parity-enforced across BOTH trees via `sharedSafetyHeadings`: drift:check fails if any of them exists in one tree but is absent from the other, closing the M13 safety-drift gap where the divergent branch did existence-only checks. .agents/skills/engineering-conventions is a Codex adapter shim that delegates to .opencode.',
	},
	{
		slug: 'swarm-implement',
		kind: 'divergent',
		extraIdenticalPaths: ['.agents/skills/swarm-implement/SKILL.md'],
		reason:
			'.opencode is the canonical implementation workflow; .claude is a thin adapter that delegates to it; .agents/skills/swarm-implement is a Codex-specific adapter shim also delegating to .opencode. Classified divergent because ADDITIONAL contracts do not yet model adapter shims.',
	},
	{
		slug: 'writing-tests',
		kind: 'divergent',
		extraIdenticalPaths: ['.agents/skills/writing-tests/SKILL.md'],
		reason:
			'.opencode is the canonical published test-authoring protocol; .claude is a thin adapter that delegates to it; .agents/skills/writing-tests is a Codex-specific adapter shim also delegating to .opencode. Classified divergent because ADDITIONAL contracts do not yet model adapter shims.',
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
		extraIdenticalPaths: ['.agents/skills/swarm/SKILL.md'],
		reason:
			'MODE: SWARM is the canonical OpenCode swarm workflow (behavior model); .claude/skills/swarm is a thin runtime adapter that documents the /swarm command and its subcommands. Both exist but serve different purposes — .opencode is the canonical workflow definition, .claude is the command-interface adapter. .agents/skills/swarm is a Codex-specific workflow adapter that delegates to .opencode.',
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
	{
		slug: 'issue-tracer',
		kind: 'adapter',
		adapterPaths: [
			'.claude/skills/issue-tracer/SKILL.md',
			'.agents/skills/issue-tracer/SKILL.md',
		],
		expectedCanonicalRef: '../../../.opencode/skills/issue-tracer/SKILL.md',
		reason:
			'Canonicalized (issue-tracer v2, issue-tracer-skill-update): .opencode/skills/issue-tracer/SKILL.md is the single agent-neutral protocol (Full-Resolution Contract, Phase 4.2 recurrence sweep, gate-integrity edits); .claude and .agents are thin adapter shims that reference it via the ../../../ relative path (modeled on the swarm-pr-review adapter shape). Bundled to npm consumers via BUNDLED_PROJECT_SKILLS + package.json#files.',
	},
	// ---------------------------------------------------------------------------
	// .agents-only skills — no .opencode counterpart; live in .claude and/or
	// .agents trees. Drift-check enforces extraIdenticalPaths existence for this kind
	// (see detectSkillMirrorDrift in scripts/drift-check.ts).
	// ---------------------------------------------------------------------------
	{
		slug: 'qa-sweep',
		kind: 'agents-only',
		extraIdenticalPaths: [
			'.claude/skills/qa-sweep/SKILL.md',
			'.agents/skills/qa-sweep/SKILL.md',
		],
		reason:
			'Orphaned .claude+.agents skill with no .opencode counterpart: .claude is the canonical audit structure, .agents is a Codex-specific adapter translating it to Codex tool names.',
	},
	{
		slug: 'research-first',
		kind: 'agents-only',
		extraIdenticalPaths: [
			'.claude/skills/research-first/SKILL.md',
			'.agents/skills/research-first/SKILL.md',
		],
		reason:
			'Orphaned .claude+.agents skill with no .opencode counterpart: .claude is the canonical research protocol, .agents is a Codex-specific adapter.',
	},
	{
		slug: 'tech-debt-ci-review',
		kind: 'agents-only',
		extraIdenticalPaths: [
			'.claude/skills/tech-debt-ci-review/SKILL.md',
			'.agents/skills/tech-debt-ci-review/SKILL.md',
		],
		reason:
			'Orphaned .claude+.agents skill with no .opencode counterpart: .claude is the canonical audit structure, .agents is a Codex-specific adapter.',
	},
	{
		slug: 'unswarm',
		kind: 'agents-only',
		extraIdenticalPaths: [
			'.claude/skills/unswarm/SKILL.md',
			'.agents/skills/unswarm/SKILL.md',
		],
		reason:
			'Orphaned .claude+.agents skill with no .opencode counterpart: .claude is the canonical command semantics, .agents is a Codex-specific adapter with modified workflow posture.',
	},
	{
		slug: 'orchestrating-subagents',
		kind: 'identical',
		canonical: '.opencode',
		reason:
			'Promoted to first-class bundled skill (criterion F): .opencode is canonical, .claude is a byte-identical mirror. No .agents counterpart.',
	},
	{
		slug: 'durable-session-state',
		kind: 'identical',
		canonical: '.opencode',
		reason:
			'Promoted to first-class bundled skill (criterion F): .opencode is canonical, .claude is a byte-identical mirror. No .agents counterpart.',
	},
	{
		slug: 'rust-crate-ci',
		kind: 'agents-only',
		extraIdenticalPaths: ['.claude/skills/rust-crate-ci/SKILL.md'],
		reason:
			'Orphaned .claude-only skill: .claude/skills/rust-crate-ci/SKILL.md exists; .agents/skills/rust-crate-ci/ does not exist. Covers the runners/swarm-sandbox-runner Rust crate CI.',
	},
	{
		slug: 'editing-skills',
		kind: 'agents-only',
		extraIdenticalPaths: ['.claude/skills/editing-skills/SKILL.md'],
		reason:
			'Orphaned .claude-only skill: .claude/skills/editing-skills/SKILL.md exists; .agents/skills/editing-skills/ does not exist. No .opencode counterpart.',
	},
	{
		slug: 'pr-review-fix',
		kind: 'agents-only',
		extraIdenticalPaths: ['.agents/skills/pr-review-fix/SKILL.md'],
		reason:
			'.agents-only skill with no .opencode or .claude counterpart. The .agents shim references .opencode/swarm-pr-feedback as its canonical reference.',
	},
	{
		slug: 'contributing',
		kind: 'agents-only',
		extraIdenticalPaths: ['.agents/skills/contributing/SKILL.md'],
		reason:
			'.agents-only skill: .opencode/contributing/SKILL.md exists (outside skills/ tree) and is the canonical contribution checklist; .agents/skills/contributing/SKILL.md is a Codex adapter referencing it. No .claude counterpart.',
	},
	{
		slug: 'guardrail-patterns',
		kind: 'agents-only',
		extraIdenticalPaths: ['.agents/skills/guardrail-patterns/SKILL.md'],
		reason:
			'.agents-only skill with no .claude counterpart. The .agents shim references .opencode/skills/generated/guardrail-patterns as its canonical reference.',
	},
	{
		slug: 'mock-to-internals-migration',
		kind: 'agents-only',
		extraIdenticalPaths: [
			'.agents/skills/mock-to-internals-migration/SKILL.md',
		],
		reason:
			'.agents-only skill with no .claude counterpart. The .agents shim references .opencode/skills/generated/mock-to-internals-migration as its canonical reference.',
	},
	{
		slug: 'subprocess-safety',
		kind: 'agents-only',
		extraIdenticalPaths: ['.agents/skills/subprocess-safety/SKILL.md'],
		reason:
			'.agents-only skill with no .opencode or .claude counterpart. This is the canonical Codex subprocess-safety protocol consolidated from AGENTS.md Invariant 3.',
	},
];

/**
 * Top-level entries under `.opencode/skills/` that are not bundled skills and
 * must be ignored by the drift checker. `generated/` holds user-generated
 * skills produced at runtime (src/services/skill-generator.ts) and has no
 * direct SKILL.md.
 */
export const NON_SKILL_OPENCODE_DIRS = new Set<string>(['generated']);
