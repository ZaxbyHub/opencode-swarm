import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	CANDIDATE_CONFIDENCES,
	CANDIDATE_HEADERS,
	CANDIDATE_SEVERITIES,
	CLEAN_TEMPLATES,
	candidateHeaderFamily,
	splitPipeFields,
} from '../../../src/background/candidate-contract';
import { PR_REVIEW_REQUIRED_TRIGGER_IDS } from '../../../src/background/pr-review-trigger-contract';
import { PR_REVIEW_BASE_DIMENSION_IDS } from '../../../src/hooks/pr-workflow-gate';

const CANONICAL_SKILL = '.opencode/skills/swarm-pr-review/SKILL.md';
const PROMPT_TEMPLATES =
	'.opencode/skills/swarm-pr-review/references/prompt-templates.md';
const STALE_CLEAN_TEMPLATE = [
	'[CLEAN]',
	'workflow_lane',
	'coverage_scope',
	'evidence',
].join(' | ');
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
	test('early Profile A quick reference stays in runtime parity and fixes micro retry ordering', () => {
		const source = readSkill(CANONICAL_SKILL);
		const section = sectionBetween(
			source,
			'### Profile A controller quick reference',
			'## Review Modes',
		);
		const sectionStartLine = source
			.slice(0, source.indexOf('### Profile A controller quick reference'))
			.split(/\r?\n/).length;

		expect(sectionStartLine).toBeLessThan(150);
		for (const id of PR_REVIEW_BASE_DIMENSION_IDS) {
			expect(section).toContain(`\`${id}\``);
		}
		for (const id of PR_REVIEW_REQUIRED_TRIGGER_IDS) {
			expect(section).toContain(`\`${id}\``);
		}
		for (const header of Object.values(CANDIDATE_HEADERS)) {
			expect(section).toContain(header);
		}
		for (const clean of Object.values(CLEAN_TEMPLATES)) {
			expect(section).toContain(clean);
		}
		for (const severity of CANDIDATE_SEVERITIES) {
			expect(section).toContain(severity);
		}
		for (const confidence of CANDIDATE_CONFIDENCES) {
			expect(section).toContain(confidence);
		}

		const orderedSteps = [
			'bind the immutable head/base range',
			'dispatch,\nsettle, and parse base lanes',
			'evaluate every trigger row',
			'dispatch micro lanes',
			'persist the trigger evaluation',
			'persist post-explorer findings',
			'run reviewers',
			'run critics',
			'complete the workflow',
		];
		let priorIndex = -1;
		for (const step of orderedSteps) {
			const index = section.indexOf(step);
			expect(index).toBeGreaterThan(priorIndex);
			priorIndex = index;
		}
		expect(section).toContain('initial** micro dispatch MUST');
		expect(section).toContain('MAY omit `trigger_evaluation`');
		expect(section).toContain('MUST remain exactly identical');
		expect(section).toContain('unfenced plain text');
		expect(section).toContain('documentation fences only');
	});

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
		const councilSection = source.slice(
			source.indexOf('# Council Mode Workflow'),
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
			'[CLEAN] | lane | coverage_scope | evidence',
		);
		expect(phase3Section).toContain('collection reports `status: failed`');
		expect(phase3Section).toContain(
			'retaining the non-empty preview, digest, and `output_ref`',
		);
		expect(phase3Section).not.toContain(
			'Lane reports `status: completed` with non-empty output',
		);
		expect(phase3Section).not.toContain(STALE_CLEAN_TEMPLATE);
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
		expect(source).not.toContain(STALE_CLEAN_TEMPLATE);
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
		expect(councilSection).toContain(
			'[CANDIDATE] | candidate_id | micro_lane | severity | category | file:line | claim | invariant_violated | evidence_summary | confidence',
		);
		expect(councilSection).toContain(CLEAN_TEMPLATES.micro_lane);
		expect(councilSection).toContain(
			'exact council `workflow_lane` value in the `micro_lane` data field',
		);
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

	test('canonical prompt templates split base from micro/council and stay runtime-owned', () => {
		const source = readSkill(PROMPT_TEMPLATES);
		const base = sectionBetween(
			source,
			'# Base Explorer Prompt Template',
			'# Micro-Lane / Council Explorer Prompt Template',
		);
		const micro = sectionBetween(
			source,
			'# Micro-Lane / Council Explorer Prompt Template',
			'Under Profile A',
		);

		expect(base).toContain(CANDIDATE_HEADERS.base_explorer);
		expect(base).toContain(CLEAN_TEMPLATES.base_explorer);
		expect(base).not.toContain(CANDIDATE_HEADERS.micro_lane);
		expect(base).not.toContain(CLEAN_TEMPLATES.micro_lane);
		expect(micro).toContain(CANDIDATE_HEADERS.micro_lane);
		expect(micro).toContain(CLEAN_TEMPLATES.micro_lane);
		expect(micro).not.toContain(CANDIDATE_HEADERS.base_explorer);
		expect(micro).not.toContain(CLEAN_TEMPLATES.base_explorer);
		for (const templateSection of [base, micro]) {
			expect(templateSection).toContain('unfenced plain text');
			expect(templateSection).toContain('documentation only');
			expect(templateSection).toContain('do not emit backticks');
		}
		expect(source).not.toContain(STALE_CLEAN_TEMPLATE);
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
			expect(source).toContain(CLEAN_TEMPLATES.base_explorer);
			expect(source).toContain(CLEAN_TEMPLATES.micro_lane);
			expect(source).not.toContain(STALE_CLEAN_TEMPLATE);
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

	test('canonical Profile A guidance diagnoses contract failures without bypass or hindsight', () => {
		const source = readSkill(CANONICAL_SKILL);
		const phase3Section = sectionBetween(
			source,
			'## Phase 3: Parallel Base Explorer Lanes',
			'## Phase 4: Mandatory Repository-Agnostic Micro-Lanes',
		);
		const compact = phase3Section.replace(/\s+/g, ' ');

		expect(compact).toContain('### Contract-failure diagnosis and recovery');
		expect(compact).toContain('controller-appended row contract');
		expect(compact).toContain('Do not duplicate that contract');
		expect(compact).toContain('isolate the emitting validator');
		expect(compact).toContain('minimal correct single-lane reproduction');
		expect(compact).toContain('header schema');
		expect(compact).toContain('data-row values');
		expect(compact).toContain('tool argument shape');
		expect(compact).toContain('actual user-visible harm');
		expect(compact).toContain('post-hoc fallback');
		expect(compact).toContain('shared row parser');
		expect(compact).toContain('durable provenance');
		expect(compact).toContain('opacity defect');
		expect(compact).toContain('not proof that correct input was rejected');
	});
});
