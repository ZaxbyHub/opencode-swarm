/**
 * Issue #3315 acceptance check AC24 — prescribed-tools reachability sweep.
 * Classification: DISCRIMINATING — RED at base, GREEN after the fix.
 *
 * Contract: every tool named in `src/agents/architect.ts` and the
 * swarm-pr-review / swarm-pr-feedback skills (backticked identifiers ∩
 * `TOOL_METADATA` keys) is admitted through `enforcePrWorkflowToolBefore` in
 * its prescribed mode, except the explicit exclusion list below.
 *
 * Expected base rejects (issue #3315 D1/D2, verified 2026-10-18 by the
 * runtime sweep this file freezes): `rebind_pr_feedback_head`,
 * `pr_workflow_status`, `git_blame`, `gitingest` (and additionally
 * `swarm_command`, defect E3) are rejected at base in a prescribed mode, so
 * the empty-rejected-list assertion below fails at base and the printed
 * rejected list is the base evidence. After the fix every non-excluded
 * prescribed tool is admitted and the assertion goes green.
 *
 * Mode derivation (frozen):
 *  - named in the swarm-pr-review skill → PR_REVIEW;
 *  - named in the swarm-pr-feedback skill → PR_FEEDBACK;
 *  - controller tools (the sets at src/hooks/pr-workflow-gate.ts ~14658-14681,
 *    mirrored below) → their mode (shared set → both);
 *  - `pr_workflow_status` / `git_blame` / `gitingest` → BOTH modes (the
 *    gate's own BLOCKED remediation text prescribes pr_workflow_status in
 *    both modes; git_blame/gitingest are the architect's observe-capability
 *    PR tools per AC5);
 *  - `swarm_command` → BOTH modes (AC17 prescribes it for PR_REVIEW and
 *    PR_FEEDBACK recovery commands);
 *  - anything else (e.g. architect.ts's council/phase prose) → ambiguous →
 *    BOTH modes.
 * A tool is reachable when admitted in AT LEAST its prescribed mode(s);
 * cross-mode results are informational and printed.
 *
 * Outcome classification rule: a tool/mode pair counts as REJECTED only when
 * the rejection message matches one of the three ADMISSION rejections —
 * /rejects unclassified plugin\/MCP tools/, /publication is not armed/,
 * /read-only and fail-closed/. ANY other throw (e.g. the mechanical-ladder
 * preconditions like "requires an immutable inventory and verification
 * batches") counts as ADMITTED: those errors prove the tool was let past the
 * admission classifier and was stopped by workflow-state preconditions the
 * operator can satisfy, which is exactly the reachability AC24 freezes.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	activatePrWorkflow,
	enforcePrWorkflowToolBefore,
} from '../../../src/hooks/pr-workflow-gate.js';
import { TOOL_NAMES } from '../../../src/tools/tool-metadata.js';
import {
	HEAD_SHA,
	SESSION_ID,
	setupPrWorkflowGateFixtures,
	teardownPrWorkflowGateFixtures,
	tempDir,
} from './pr-workflow-gate.test-fixtures.js';

type PrMode = 'PR_REVIEW' | 'PR_FEEDBACK';

/** Repository-relative source paths resolved from this test file's location. */
const REPO_ROOT = join(__dirname, '..', '..', '..');
const SOURCES = {
	architect: join(REPO_ROOT, 'src', 'agents', 'architect.ts'),
	reviewSkill: join(
		REPO_ROOT,
		'.opencode',
		'skills',
		'swarm-pr-review',
		'SKILL.md',
	),
	feedbackSkill: join(
		REPO_ROOT,
		'.opencode',
		'skills',
		'swarm-pr-feedback',
		'SKILL.md',
	),
} as const;

/**
 * Every backticked single-word lowercase identifier in a source file. The
 * escaped form backslash-backtick identifier backslash-backtick is normalized
 * to bare backticks first: the architect prompt prose lives inside a template
 * literal, so every prose backtick there is source-escaped and invisible to a
 * bare-backtick regex (final-critic round 1 — the sweep was blind to 14 named
 * tools). The escape pair is built with String.fromCharCode so no write
 * transport can collapse it back into a no-op.
 */
const ESCAPED_BACKTICK = String.fromCharCode(92, 96);

function backtickedIdentifiers(filePath: string): Set<string> {
	const raw = readFileSync(filePath, 'utf-8');
	const content = raw.split(ESCAPED_BACKTICK).join('`');
	const matches = content.match(/`[a-z_][a-z0-9_]*`/g) ?? [];
	return new Set(matches.map((token) => token.slice(1, -1)));
}

/**
 * Self-assertion (final-critic round 2): the escaped-only architect names must
 * be present in the extracted architect set — if the normalization above ever
 * becomes a byte-level no-op again (a write-transport escape collapse did
 * exactly that once), the sweep must fail loudly here, not pass vacuously.
 */
function assertExtractionSeesEscapedArchitectNames(
	architectNames: ReadonlySet<string>,
): void {
	for (const name of [
		'summarize_work',
		'web_search',
		'web_fetch',
		'get_approved_plan',
		'checkpoint',
	]) {
		if (!architectNames.has(name)) {
			throw new Error(
				`C24 extraction self-check failed: escaped-only architect name "${name}" not extracted — the escaped-backtick normalization is not working`,
			);
		}
	}
}

const TOOL_NAME_SET = new Set<string>(TOOL_NAMES);

// Controller tool sets — mirrored from src/hooks/pr-workflow-gate.ts
// (~14658-14681: PR_WORKFLOW_SHARED_CONTROLLER_TOOLS,
// PR_REVIEW_CONTROLLER_TOOLS, PR_FEEDBACK_CONTROLLER_TOOLS). Each controller
// tool's prescribed mode is its set membership; the shared set applies to
// both modes.
const CONTROLLER_TOOL_MODES: Record<string, PrMode[]> = {
	// PR_WORKFLOW_SHARED_CONTROLLER_TOOLS
	abort_pr_workflow: ['PR_REVIEW', 'PR_FEEDBACK'],
	cancel_lane_batch: ['PR_REVIEW', 'PR_FEEDBACK'],
	collect_lane_results: ['PR_REVIEW', 'PR_FEEDBACK'],
	complete_pr_workflow: ['PR_REVIEW', 'PR_FEEDBACK'],
	dispatch_lanes_async: ['PR_REVIEW', 'PR_FEEDBACK'],
	prepare_pr_workflow_checkout: ['PR_REVIEW', 'PR_FEEDBACK'],
	// PR_REVIEW_CONTROLLER_TOOLS
	authorize_pr_review_reentry: ['PR_REVIEW'],
	parse_lane_candidates: ['PR_REVIEW'],
	write_pr_review_artifact: ['PR_REVIEW'],
	write_pr_review_trigger_eval: ['PR_REVIEW'],
	// PR_FEEDBACK_CONTROLLER_TOOLS
	invalidate_pr_feedback_publication: ['PR_FEEDBACK'],
	prepare_pr_feedback_scope: ['PR_FEEDBACK'],
	run_pr_feedback_stage_a: ['PR_FEEDBACK'],
};

// Frozen AC5/AC17 additions — prescribed in BOTH modes by the gate's own
// remediation text and the issue's acceptance criteria even though only some
// are backticked in the three sweep sources (git_blame/gitingest are not;
// they are frozen in per AC5 as the architect's observe-capability PR tools).
const FROZEN_BOTH_MODE_TOOLS: ReadonlySet<string> = new Set([
	'pr_workflow_status',
	'git_blame',
	'gitingest',
	'swarm_command',
]);

/**
 * FROZEN exclusion list — tools whose base rejection is CORRECT BY DESIGN.
 * Each entry names a tool present in the swept intersection whose active-gate
 * rejection is the intended behavior, with the reason. This list must NOT
 * contain rebind_pr_feedback_head, pr_workflow_status, git_blame, or
 * gitingest (issue #3315 AC24).
 */
const EXCLUDED_TOOLS: ReadonlyMap<string, string> = new Map([
	[
		'dispatch_lanes',
		'blocking dispatch variant; the swarm-pr-review skill itself states blocking `dispatch_lanes` cannot satisfy the structured provenance gate while the controller is active — the mention is prohibitive, and the gate deliberately requires dispatch_lanes_async',
	],
	[
		'pr_review_submission',
		'post-gate GitHub publication surface; the tool\'s own contract refuses while a gate is active ("refuses while a gate is active"), so the skill\'s session-availability mention does not prescribe in-gate use',
	],
	[
		'export_pr_review_partial_results',
		"post-abort salvage export; the tool's own contract requires the gate CLEARED and an abort event binding, so an active-gate rejection is by design",
	],
	[
		'declare_scope',
		'the swarm-pr-feedback skill explicitly prohibits it for feedback work ("do not use `declare_scope`; those tools belong to the normal implementation-plan" workflow) — prohibitive mention',
	],
	[
		'save_plan',
		'the swarm-pr-feedback skill explicitly prohibits synthesizing it ("Do not create a synthetic `save_plan` merely to authorize feedback work") — prohibitive mention',
	],
	[
		'convene_general_council',
		'named only in architect.ts ordinary council/PLAN-mode prose, not PR-workflow context; PR gates deliberately fail closed for non-PR ceremony tools',
	],
	[
		'declare_council_criteria',
		'named only in architect.ts ordinary council-mode prose; PR gates deliberately fail closed for non-PR ceremony tools',
	],
	[
		'phase_complete',
		'named only in architect.ts plan-phase completion prose; PR gates deliberately fail closed for non-PR plan tools',
	],
	[
		'submit_council_verdicts',
		'named only in architect.ts council-mode prose; PR gates deliberately fail closed for non-PR ceremony tools',
	],
	[
		'submit_phase_council_verdicts',
		'named only in architect.ts plan-phase council prose; PR gates deliberately fail closed for non-PR ceremony tools',
	],
	// Final-critic round 1: the ten tools below surfaced only after the
	// extraction learned to read the template-escaped backticks of the
	// architect prompt prose. Each is named exclusively in non-PR-workflow
	// prose (plan authoring, retro, memory, council-evidence, supervisor
	// flows that belong to the ordinary implementation workflow), so the
	// PR gates deliberately fail closed for them — the same reason class
	// as the council/phase five above. Probed at the final head: all ten
	// reject in both PR modes.
	[
		'checkpoint',
		'named only in architect.ts plan-checkpoint prose (prohibitive mention: do not checkpoint mid-PR); PR gates deliberately fail closed for non-PR plan tools',
	],
	[
		'write_retro',
		'named only in architect.ts retro-capture prose; a PR-workflow retro is not prescribed, the gate deliberately fails closed for non-PR ceremony tools',
	],
	[
		'set_qa_gates',
		'named only in architect.ts QA-gate configuration prose for ordinary plan work; PR gates deliberately fail closed for non-PR plan tools',
	],
	[
		'write_final_council_evidence',
		'named only in architect.ts council-evidence prose; PR gates deliberately fail closed for non-PR ceremony tools',
	],
	[
		'skill_improve',
		'named only in architect.ts skill-improvement prose for ordinary plan work; PR gates deliberately fail closed for non-PR plan tools',
	],
	[
		'spec_write',
		'named only in architect.ts spec-authoring prose for ordinary plan work; PR gates deliberately fail closed for non-PR plan tools',
	],
	[
		'knowledge_receipt',
		'named only in architect.ts knowledge- filing prose for ordinary plan work; PR gates deliberately fail closed for non-PR plan tools',
	],
	[
		'swarm_memory_outcome',
		'named only in architect.ts memory-outcome prose for ordinary plan work; PR gates deliberately fail closed for non-PR plan tools',
	],
	[
		'summarize_work',
		'named only in architect.ts work-summary prose for ordinary plan work; PR gates deliberately fail closed for non-PR plan tools',
	],
	[
		'write_architecture_supervisor_evidence',
		'named only in architect.ts supervisor-evidence prose; PR gates deliberately fail closed for non-PR plan tools',
	],
]);

/** Minimal plausible args; admission classifies by name/capability. */
const ARGS_BY_TOOL: Record<string, Record<string, unknown>> = {
	// swarm_command admission is command-scoped post-fix (AC17 admits the
	// recovery commands, AC18 keeps others rejected) — use a recovery command.
	swarm_command: { command: 'diagnose' },
};

/** The three ADMISSION rejections (see the classification rule in the file docstring). */
const ADMISSION_REJECTIONS: RegExp[] = [
	/rejects unclassified plugin\/MCP tools/,
	/publication is not armed/,
	/read-only and fail-closed/,
];

function isAdmissionRejection(message: string): boolean {
	return ADMISSION_REJECTIONS.some((pattern) => pattern.test(message));
}

/** Resolve the prescribed modes for a swept tool per the frozen rules. */
function prescribedModes(
	tool: string,
	reviewSet: Set<string>,
	feedbackSet: Set<string>,
): PrMode[] {
	const modes = new Set<PrMode>();
	if (reviewSet.has(tool)) modes.add('PR_REVIEW');
	if (feedbackSet.has(tool)) modes.add('PR_FEEDBACK');
	for (const mode of CONTROLLER_TOOL_MODES[tool] ?? []) modes.add(mode);
	if (FROZEN_BOTH_MODE_TOOLS.has(tool)) {
		modes.add('PR_REVIEW');
		modes.add('PR_FEEDBACK');
	}
	// Ambiguous (no prescribing source): test BOTH modes.
	if (modes.size === 0) {
		modes.add('PR_REVIEW');
		modes.add('PR_FEEDBACK');
	}
	return [...modes];
}

async function admissionMessage(
	session: string,
	tool: string,
	args: Record<string, unknown>,
): Promise<string> {
	return enforcePrWorkflowToolBefore(tempDir, session, tool, args).then(
		() => 'ADMITTED',
		(error: unknown) =>
			error instanceof Error ? error.message : String(error),
	);
}

describe('prescribed-tools reachability sweep (issue #3315 AC24)', () => {
	beforeEach(() => {
		setupPrWorkflowGateFixtures();
	});

	test('every tool the architect prompt and PR skills prescribe is admitted in its prescribed mode', async () => {
		try {
			const reviewSet = backtickedIdentifiers(SOURCES.reviewSkill);
			const feedbackSet = backtickedIdentifiers(SOURCES.feedbackSkill);
			const architectSet = backtickedIdentifiers(SOURCES.architect);
			assertExtractionSeesEscapedArchitectNames(architectSet);

			// The sweep set: backticked identifiers ∩ TOOL_METADATA keys, plus
			// the frozen AC5/AC17 both-mode additions below (git_blame/gitingest
			// are not backticked in the three sources but are prescribed by the
			// gate text and AC5).
			const swept = new Set<string>();
			for (const identifier of [
				...reviewSet,
				...feedbackSet,
				...architectSet,
			]) {
				if (TOOL_NAME_SET.has(identifier)) swept.add(identifier);
			}
			for (const tool of FROZEN_BOTH_MODE_TOOLS) {
				if (TOOL_NAME_SET.has(tool)) swept.add(tool);
			}
			expect(swept.size).toBeGreaterThan(10);

			const reviewSession = `${SESSION_ID}-3315-sweep-rv`;
			const feedbackSession = `${SESSION_ID}-3315-sweep-fb`;
			await activatePrWorkflow(tempDir, reviewSession, 'PR_REVIEW', {
				prHeadSha: HEAD_SHA,
			});
			await activatePrWorkflow(tempDir, feedbackSession, 'PR_FEEDBACK', {
				prHeadSha: HEAD_SHA,
			});

			const rejected: string[] = [];
			for (const tool of [...swept].sort()) {
				const modes = prescribedModes(tool, reviewSet, feedbackSet);
				const args = ARGS_BY_TOOL[tool] ?? {};
				for (const mode of modes) {
					const session =
						mode === 'PR_REVIEW' ? reviewSession : feedbackSession;
					const message = await admissionMessage(session, tool, args);
					if (isAdmissionRejection(message)) {
						const label = `${tool} [${mode}]`;
						if (EXCLUDED_TOOLS.has(tool)) {
							console.log(
								`SWEEP-EXCLUDED ${label}: ${EXCLUDED_TOOLS.get(tool)}`,
							);
							continue;
						}
						rejected.push(label);
						console.log(`SWEEP-REJECTED ${label}: ${message.slice(0, 160)}`);
					}
				}
			}
			// Informational cross-mode evidence (not part of the contract).
			for (const tool of [...swept].sort()) {
				const modes = prescribedModes(tool, reviewSet, feedbackSet);
				if (modes.length === 2 || EXCLUDED_TOOLS.has(tool)) continue;
				const other: PrMode =
					modes[0] === 'PR_REVIEW' ? 'PR_FEEDBACK' : 'PR_REVIEW';
				const session = other === 'PR_REVIEW' ? reviewSession : feedbackSession;
				const message = await admissionMessage(
					session,
					tool,
					ARGS_BY_TOOL[tool] ?? {},
				);
				if (isAdmissionRejection(message)) {
					console.log(
						`SWEEP-CROSS-MODE (informational) ${tool} [${other}]: ${message.slice(0, 120)}`,
					);
				}
			}

			// Post-fix contract: the rejected list is empty. At base this fails
			// and the actual list — which MUST include rebind_pr_feedback_head,
			// pr_workflow_status, git_blame, and gitingest (plus swarm_command)
			// per the D1/D2/E3 defects — is the base evidence.
			expect(
				rejected,
				`prescribed tools rejected at gate admission (issue #3315 AC24): ${rejected.join('; ')}`,
			).toEqual([]);
		} finally {
			await teardownPrWorkflowGateFixtures();
		}
	});
});
