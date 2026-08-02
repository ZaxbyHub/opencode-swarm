import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	candidateHeaderFamily,
	splitPipeFields,
} from '../../../src/background/candidate-contract';

const CANONICAL_SKILL = '.opencode/skills/swarm-pr-review/SKILL.md';
const ADAPTER_SKILLS = [
	'.agents/skills/swarm-pr-review/SKILL.md',
	'.claude/skills/swarm-pr-review/SKILL.md',
] as const;

function readSkill(skillPath: string): string {
	return readFileSync(join(process.cwd(), skillPath), 'utf-8');
}

function sectionBetween(
	source: string,
	startHeading: string,
	nextHeading: string,
): string {
	const start = source.indexOf(startHeading);
	const end = source.indexOf(nextHeading, start + startHeading.length);
	expect(start).toBeGreaterThan(-1);
	expect(end).toBeGreaterThan(start);
	return source.slice(start, end);
}

describe('swarm-pr-review deterministic async lane dispatch guidance', () => {
	test('canonical .opencode skill uses async lane collection and documents the review handoff contract', () => {
		const source = readSkill(CANONICAL_SKILL);
		const handoffSection = sectionBetween(
			source,
			'## Handoff To PR Feedback',
			'## Operating Stance',
		);
		const phase0aSection = sectionBetween(
			source,
			'## Phase 0A: Existing PR Signal Ingestion',
			'## Phase 0B: Mergeability and Branch-State Intake',
		);
		const mergeabilitySection = sectionBetween(
			source,
			'## Phase 0B: Mergeability and Branch-State Intake',
			'## Phase 0: Context Pack and Review Signal Collection',
		);
		const phase3Section = sectionBetween(
			source,
			'## Phase 3: Parallel Base Explorer Lanes',
			'## Phase 4: Mandatory Repository-Agnostic Micro-Lanes',
		);
		const phase4Section = sectionBetween(
			source,
			'## Phase 4: Mandatory Repository-Agnostic Micro-Lanes',
			'## Phase 5: Swarm-Native Verifier Routing',
		);
		const phase6Section = sectionBetween(
			source,
			'## Phase 6: Independent Reviewer Confirmation',
			'## Phase 7: Falsification Probe Requirement',
		);

		expect(phase3Section).toContain('dispatch_lanes_async');
		expect(phase3Section).toContain('collect_lane_results');
		expect(phase3Section).toContain('lane_results');
		expect(phase3Section).toContain('output_ref');
		expect(phase3Section).toContain('retrieve_lane_output');
		expect(phase3Section).toContain('exact six-lane gate');
		expect(phase3Section).toContain('retry only the failed `workflow_lane`');
		expect(phase3Section).toContain('same exact `pr_head_sha`');
		expect(phase3Section).toContain('direct Task dispatch are not equivalent');
		expect(phase3Section).toContain('STOP and surface the lane failure');
		expect(phase3Section).toContain('Do not present partial findings');
		expect(phase3Section).toContain(
			'A low-quality partial review is worse than no review',
		);
		expect(phase3Section).toContain(
			'[CLEAN] | workflow_lane | coverage_scope | evidence',
		);
		expect(phase3Section).toContain('Header-only `[CLEAN]` markers');
		expect(phase3Section).toContain('UNVERIFIED');
		expect(phase3Section).toContain('dispatch_lanes');
		expect(phase3Section).not.toContain('report to the user as INCOMPLETE');
		expect(phase3Section).not.toContain('Present partial findings');
		expect(phase3Section).not.toContain('run_in_background');
		expect(phase3Section).not.toContain(
			'single message with multiple Agent tool calls',
		);
		expect(phase3Section).toContain('do not dispatch reviewers yet');
		expect(phase3Section).toContain('expected_family: "base_explorer"');
		expect(phase3Section).toContain('`expected_lane`');
		expect(phase3Section).toContain('`expected_lanes`');
		expect(phase3Section).toContain(
			'complete\n   `owned_workflow_lanes` array',
		);
		const canonicalBaseHeader = source
			.split(/\r?\n/)
			.find((line) => line.startsWith('[CANDIDATE] | candidate_id | lane'));
		expect(canonicalBaseHeader).toBeDefined();
		expect(
			candidateHeaderFamily(splitPipeFields(canonicalBaseHeader ?? '')),
		).toBe('base_explorer');
		expect(source).toContain(
			'The confidence data value must be exactly LOW, MEDIUM, or HIGH.',
		);
		// Depth tiers scale dispatch shape (never dimension coverage) on
		// profiles without the controller.
		expect(phase3Section).toContain('### Review depth tiers');
		expect(phase3Section).toContain(
			'no tier permits skipping a dimension or family',
		);
		expect(phase3Section).toContain(
			'Under Profile B, dispatch the same wave as parallel subagents',
		);
		expect(phase4Section).toContain('[TRIGGER-EVAL]');
		expect(phase4Section).toContain('one row per map row');
		expect(phase4Section).toContain('write_pr_review_trigger_eval');
		expect(phase4Section).toContain('source_batch_id');
		expect(phase4Section).toContain('source_lane_id');
		expect(phase4Section).toContain('expected_family: "micro_lane"');
		expect(phase4Section).toContain('`expected_micro_lane`');
		expect(phase4Section).toContain(
			'Repository-agnostic mandatory micro-lane map',
		);
		expect(phase4Section).toContain('`NOT_TRIGGERED` only when');
		expect(phase4Section).toContain('not a waiver');
		expect(phase4Section).toContain('must not be dispatched');
		expect(phase4Section).not.toContain('`NO-MATCH`');
		expect(phase4Section).toContain('exact eleven-row v2 receipt');
		expect(phase4Section).toContain('Scope');
		expect(phase4Section).toContain('universal');
		expect(phase4Section).not.toContain('swarm-extension');
		expect(phase4Section).toContain('unclassified-risk');
		expect(phase4Section).toContain('zero malformed rows');
		expect(phase4Section).toContain('matches the trigger row');
		expect(phase4Section).toContain('[CLEAN]');
		expect(phase4Section).toContain('UNATTESTED');
		expect(phase4Section).toContain('the active controller rejects blocking');
		expect(phase4Section).toContain('Task-derived');
		expect(phase4Section).toContain('Repository identity');
		expect(phase4Section).toContain('never justifies skipping a row');
		// Family evaluation is universal; dispatch shape scales by depth tier
		// on profiles without the controller.
		expect(phase4Section).toContain('**Profiles B/C dispatch.**');
		expect(phase4Section).toContain(
			'Scale the lane shape to the depth tier while',
		);
		expect(phase4Section).toContain('all eleven family evaluations');
		expect(phase6Section).toContain('join barrier');
		expect(phase6Section).toContain('malformed `[REVIEWED]`');
		expect(phase0aSection).toContain(
			'discover whether the repository defines a PR',
		);
		expect(phase0aSection).toContain('publication contract');
		expect(phase0aSection).toContain(
			'do not invent opencode-swarm-specific title/body',
		);
		expect(phase0aSection).not.toContain(
			"commit-pr skill's publication contract",
		);
		expect(source).toContain(
			'[VALIDATION] micro risk families evaluated and attested: ___ / 11 OR BLOCKED — <missing rows> (micro lanes dispatched: ___)',
		);
		expect(source).toContain(
			'[VALIDATION] capability profile (A/B/C) and depth tier (S/M/L): ___ / ___',
		);
		// Capability-profile model: the canonical skill must define all three
		// profiles and must not treat controller absence as a BLOCKED condition.
		expect(source).toContain('## Runtime Capability Profiles');
		expect(source).toContain(
			'first-class execution paths, not degraded fallbacks',
		);
		expect(source).toContain('Profile C — single context, no subagents');
		expect(source).toContain(
			'review comments, review summaries, requested changes',
		);
		expect(source).toContain('CI/check failures');
		expect(source).toContain('mergeability/conflicts');
		expect(source).toContain('GraphQL review-thread inspection');
		expect(source).toContain(
			'Council mode supplements the default mechanical workflow',
		);
		expect(source).toContain(
			'blocking, sequential, or direct-Task fallback is not equivalent',
		);
		expect(source).toContain('mode: "swarm-pr-review:council"');
		expect(source).toContain('runtime enforces this join barrier');
		expect(source).toContain(
			'Council prose without one of those markers does not settle the lane',
		);
		expect(source).not.toContain(
			'Council mode is mutually exclusive with the default layered workflow',
		);
		expect(source).not.toContain(
			'Fall back to blocking `dispatch_lanes` when async launch is unavailable',
		);
		expect(handoffSection).toContain(
			'.swarm/pr-review/<run_id>/feedback-handoff.json',
		);
		expect(handoffSection).toContain(
			'pr-review/<run_id>/feedback-handoff.json` inside your session/task workspace',
		);
		// The continuation-prompt example must use a profile-neutral placeholder,
		// not either profile's concrete path hardcoded into an "exact" example —
		// Profile A's path and the session-workspace path are genuinely
		// different, so hardcoding either one here would misdocument the other.
		expect(handoffSection).toContain(
			'/swarm pr-feedback <PR_URL> continue from <handoff_artifact_path>',
		);
		expect(handoffSection).toContain('stop and ask the user');
		expect(mergeabilitySection).toContain('remains read-only');
		expect(mergeabilitySection).toContain('Record conflicts and blockers');
		expect(mergeabilitySection).not.toContain('Resolve before reviewing');
		expect(mergeabilitySection).not.toContain(
			'Resolve conflicts (when CONFLICTING or DIRTY)',
		);
		expect(mergeabilitySection).not.toContain(
			'git merge origin/$BASE_REF --no-commit --no-ff',
		);
	});

	for (const skillPath of ADAPTER_SKILLS) {
		test(`${skillPath} stays a thin adapter to the canonical .opencode skill`, () => {
			const source = readSkill(skillPath);
			const lineCount = source.trimEnd().split(/\r?\n/).length;

			expect(lineCount).toBeLessThan(70);
			expect(source).toContain(
				'../../../.opencode/skills/swarm-pr-review/SKILL.md',
			);
			expect(source).toContain('canonical workflow');
			expect(source).toContain('read-only');
			expect(source).toContain('workflow-lane');
			expect(source).toContain('exact-head provenance');
			expect(source).toContain('PR publication contract');
			expect(source).toContain('BLOCKED');
			expect(source).toContain('degraded review');
			expect(source).toContain('output_ref');
			expect(source).not.toContain('## Phase 0A:');
			expect(source).not.toContain('## Phase 0B:');
			expect(source).not.toContain(
				'Legacy mirror text retained only as commented reference',
			);
			expect(source).not.toContain('<!--');
		});
	}

	// The Codex adapter uses runtime-agnostic capability phrasing while preserving
	// the controller-bypass prohibition for hosts where the controller is active.
	test('.agents/skills/swarm-pr-review/SKILL.md uses capability phrasing, not runtime-specific tool names', () => {
		const source = readSkill('.agents/skills/swarm-pr-review/SKILL.md');
		expect(source).toContain("runtime's parallel-execution capability");
		expect(source).toContain('different dispatch path is not equivalent');
		expect(source).toContain('one structured exact-six batch');
		expect(source).toContain('PR publication contract');
		expect(source).not.toContain('run the lanes sequentially');
		// Controller absence is the normal Codex/ZCode state, never a dead end —
		// and both runtimes dispatch fresh-context subagents (Profile B).
		expect(source).toContain('Profile B, not an error');
		expect(source).toContain('fresh-context');
		expect(source).toContain('report BLOCKED merely because');
		// Adapter must not leak runtime-specific tool names.
		expect(source).not.toContain('dispatch_lanes_async');
		expect(source).not.toContain('collect_lane_results');
		expect(source).not.toContain('retrieve_lane_output');
		expect(source).not.toContain('parse_lane_candidates');
		expect(source).not.toContain('dispatch_lanes');
		expect(source).not.toContain('Task-tool dispatch');
	});

	test('.claude/skills/swarm-pr-review/SKILL.md gives Claude Code a native Profile B path and keeps controller tools conditional', () => {
		const source = readSkill('.claude/skills/swarm-pr-review/SKILL.md');
		// Controller tool names may appear only inside the conditional Profile A
		// path; the default Claude Code path is native Agent/Task dispatch.
		expect(source).toContain('dispatch_lanes_async');
		expect(source).toContain('collect_lane_results');
		expect(source).toContain('direct-Task dispatch are not');
		expect(source).toContain('PR publication contract');
		expect(source).not.toContain('Task-tool dispatch is the final fallback');
		expect(source).toContain('retrieve_lane_output');
		expect(source).toContain('Profile B, not an error');
		expect(source).toContain('report BLOCKED merely');
		expect(source).toContain('`Agent`/`Task` subagent tool');
		expect(source).toContain(
			'Only if this session actually exposes the swarm controller tools',
		);
	});
});
