/**
 * FB-10 hardening companion to frozen AC24 (pr-workflow-prescribed-tools-
 * reachable-l2.test.ts) — coverage the frozen sweep structurally lacks:
 *
 *   1. EXCLUDED_TOOLS counter-assertions: the frozen sweep only asserts the
 *      rejected list is EMPTY — an exclusion-list entry that STOPS rejecting
 *      (stale exclusion) is never noticed. This companion re-derives the same
 *      swept set, finds every current admission rejection, and requires each
 *      one to be covered by the FROZEN file's EXCLUDED_TOOLS keys (read from
 *      that file's source, so the two surfaces cannot drift apart); it also
 *      asserts the protected four (rebind_pr_feedback_head, pr_workflow_status,
 *      git_blame, gitingest) are never excluded.
 *   2. The admission-rejection classifier gains the test_runner refusal
 *      pattern (F-R33): `test_runner` is not backticked in the sweep sources
 *      today, so the frozen three-pattern classifier cannot misclassify it —
 *      yet. A direct probe pins the refusal so a future skill edit that
 *      prescribes test_runner cannot smuggle a misclassified admission past
 *      the sweep.
 *   3. CONTROLLER_TOOL_MODES mirror, corrected: the frozen file's mirror
 *      predates the two new PR_FEEDBACK controllers this PR added
 *      (rebind_pr_feedback_head, prepare_pr_feedback_commit_message) and its
 *      line-number citation has drifted (the sets now live at the
 *      PR_WORKFLOW_SHARED_CONTROLLER_TOOLS / PR_REVIEW_CONTROLLER_TOOLS /
 *      PR_FEEDBACK_CONTROLLER_TOOLS definitions near :14984-15013 of
 *      src/hooks/pr-workflow-gate.ts — cited by symbol, since line pins in
 *      comments rot). The mirror here adds both controllers.
 *   4. Capability cases for both new controllers (F-R48): each is admitted
 *      PAST the PR_FEEDBACK admission classifier (bound, unarmed gate) and
 *      then reaches its own controller behavior; the gate's own
 *      unclassified-tool refusal text must also list them (the bounded
 *      recovery pointer the blocked agent reads).
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	activatePrWorkflow,
	enforcePrWorkflowToolBefore,
	rebindPrFeedbackHead,
} from '../../../src/hooks/pr-workflow-gate.js';
import { executePreparePrFeedbackCommitMessage } from '../../../src/tools/prepare-pr-feedback-commit-message.js';
import { TOOL_NAMES } from '../../../src/tools/tool-metadata.js';
import {
	HEAD_SHA,
	SESSION_ID,
	setupPrWorkflowGateFixtures,
	teardownPrWorkflowGateFixtures,
	tempDir,
} from './pr-workflow-gate.test-fixtures.js';

type PrMode = 'PR_REVIEW' | 'PR_FEEDBACK';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const C24_SOURCE = join(
	REPO_ROOT,
	'tests',
	'unit',
	'hooks',
	'pr-workflow-prescribed-tools-reachable-l2.test.ts',
);
const SWEEP_SOURCES = [
	join(REPO_ROOT, 'src', 'agents', 'architect.ts'),
	join(REPO_ROOT, '.opencode', 'skills', 'swarm-pr-review', 'SKILL.md'),
	join(REPO_ROOT, '.opencode', 'skills', 'swarm-pr-feedback', 'SKILL.md'),
];

const TOOL_NAME_SET = new Set<string>(TOOL_NAMES);

/**
 * Controller mirror, CORRECTED (see docstring item 3): the frozen C24 mirror
 * plus the two PR_FEEDBACK controllers this PR added. Cited by symbol —
 * PR_WORKFLOW_SHARED_CONTROLLER_TOOLS / PR_REVIEW_CONTROLLER_TOOLS /
 * PR_FEEDBACK_CONTROLLER_TOOLS in src/hooks/pr-workflow-gate.ts.
 */
const CONTROLLER_TOOL_MODES: Record<string, PrMode[]> = {
	abort_pr_workflow: ['PR_REVIEW', 'PR_FEEDBACK'],
	cancel_lane_batch: ['PR_REVIEW', 'PR_FEEDBACK'],
	collect_lane_results: ['PR_REVIEW', 'PR_FEEDBACK'],
	complete_pr_workflow: ['PR_REVIEW', 'PR_FEEDBACK'],
	dispatch_lanes_async: ['PR_REVIEW', 'PR_FEEDBACK'],
	prepare_pr_workflow_checkout: ['PR_REVIEW', 'PR_FEEDBACK'],
	authorize_pr_review_reentry: ['PR_REVIEW'],
	parse_lane_candidates: ['PR_REVIEW'],
	write_pr_review_artifact: ['PR_REVIEW'],
	write_pr_review_trigger_eval: ['PR_REVIEW'],
	invalidate_pr_feedback_publication: ['PR_FEEDBACK'],
	prepare_pr_feedback_commit_message: ['PR_FEEDBACK'],
	prepare_pr_feedback_scope: ['PR_FEEDBACK'],
	rebind_pr_feedback_head: ['PR_FEEDBACK'],
	run_pr_feedback_stage_a: ['PR_FEEDBACK'],
};

const FROZEN_BOTH_MODE_TOOLS: ReadonlySet<string> = new Set([
	'pr_workflow_status',
	'git_blame',
	'gitingest',
	'swarm_command',
]);

const ARGS_BY_TOOL: Record<string, Record<string, unknown>> = {
	swarm_command: { command: 'diagnose' },
};

/**
 * The frozen three ADMISSION rejections PLUS the test_runner refusal (F-R33):
 * `BLOCKED: PR_REVIEW test_runner would execute inside the bound checkout …`.
 */
const ADMISSION_REJECTIONS: RegExp[] = [
	/rejects unclassified plugin\/MCP tools/,
	/publication is not armed/,
	/read-only and fail-closed/,
	/PR_REVIEW test_runner would execute inside the bound checkout/,
];

function isAdmissionRejection(message: string): boolean {
	return ADMISSION_REJECTIONS.some((pattern) => pattern.test(message));
}

/** Every backticked single-word identifier, template-escape-normalized. */
function backtickedIdentifiers(filePath: string): Set<string> {
	const ESCAPED_BACKTICK = String.fromCharCode(92, 96);
	const raw = readFileSync(filePath, 'utf-8');
	const content = raw.split(ESCAPED_BACKTICK).join('`');
	const matches = content.match(/`[a-z_][a-z0-9_]*`/g) ?? [];
	return new Set(matches.map((token) => token.slice(1, -1)));
}

/** EXCLUDED_TOOLS keys, read from the FROZEN C24 source (no duplication). */
function frozenExclusionKeys(): Set<string> {
	const source = readFileSync(C24_SOURCE, 'utf-8');
	const keys = new Set<string>();
	for (const match of source.matchAll(/^\t\t'([a-z_]+)',$/gm)) {
		keys.add(match[1]);
	}
	expect(keys.size).toBeGreaterThan(10);
	return keys;
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

describe('AC24 sweep hardening companion (FB-10 / F-R33/34/35/48)', () => {
	beforeEach(() => {
		setupPrWorkflowGateFixtures();
	});

	test('every current admission rejection is covered by the frozen EXCLUDED_TOOLS keys, and the protected four are never excluded', async () => {
		try {
			const sourceSets = SWEEP_SOURCES.map(backtickedIdentifiers);
			const swept = new Set<string>();
			for (const set of sourceSets) {
				for (const identifier of set) {
					if (TOOL_NAME_SET.has(identifier)) swept.add(identifier);
				}
			}
			for (const tool of FROZEN_BOTH_MODE_TOOLS) {
				if (TOOL_NAME_SET.has(tool)) swept.add(tool);
			}

			const reviewSession = `${SESSION_ID}-hardening-rv`;
			const feedbackSession = `${SESSION_ID}-hardening-fb`;
			await activatePrWorkflow(tempDir, reviewSession, 'PR_REVIEW', {
				prHeadSha: HEAD_SHA,
			});
			await activatePrWorkflow(tempDir, feedbackSession, 'PR_FEEDBACK', {
				prHeadSha: HEAD_SHA,
			});

			const exclusions = frozenExclusionKeys();
			for (const protectedTool of [
				'rebind_pr_feedback_head',
				'pr_workflow_status',
				'git_blame',
				'gitingest',
			]) {
				expect(
					exclusions.has(protectedTool),
					`protected tool "${protectedTool}" must never appear in EXCLUDED_TOOLS`,
				).toBe(false);
			}

			const uncoveredRejections: string[] = [];
			for (const tool of [...swept].sort()) {
				const modes = new Set<PrMode>();
				if (sourceSets[1].has(tool)) modes.add('PR_REVIEW');
				if (sourceSets[2].has(tool)) modes.add('PR_FEEDBACK');
				for (const mode of CONTROLLER_TOOL_MODES[tool] ?? []) {
					modes.add(mode);
				}
				if (FROZEN_BOTH_MODE_TOOLS.has(tool)) {
					modes.add('PR_REVIEW');
					modes.add('PR_FEEDBACK');
				}
				if (modes.size === 0) {
					modes.add('PR_REVIEW');
					modes.add('PR_FEEDBACK');
				}
				for (const mode of modes) {
					const session =
						mode === 'PR_REVIEW' ? reviewSession : feedbackSession;
					const message = await admissionMessage(
						session,
						tool,
						ARGS_BY_TOOL[tool] ?? {},
					);
					if (isAdmissionRejection(message) && !exclusions.has(tool)) {
						uncoveredRejections.push(
							`${tool} [${mode}]: ${message.slice(0, 120)}`,
						);
					}
				}
			}
			expect(
				uncoveredRejections,
				`admission rejections not covered by the frozen EXCLUDED_TOOLS list: ${uncoveredRejections.join('; ')}`,
			).toEqual([]);
		} finally {
			await teardownPrWorkflowGateFixtures();
		}
	});

	test('test_runner in a bound PR_REVIEW gate refuses with the admission-class refusal (F-R33)', async () => {
		try {
			const session = `${SESSION_ID}-hardening-tr`;
			await activatePrWorkflow(tempDir, session, 'PR_REVIEW', {
				prHeadSha: HEAD_SHA,
			});
			const message = await admissionMessage(session, 'test_runner', {
				files: ['tests/unit/skills/skill-mirrors.test.ts'],
			});
			expect(message).toMatch(
				/PR_REVIEW test_runner would execute inside the bound checkout/,
			);
			expect(isAdmissionRejection(message)).toBe(true);
		} finally {
			await teardownPrWorkflowGateFixtures();
		}
	});

	test('the PR_FEEDBACK unclassified refusal lists both new controllers (F-R48 recovery pointer)', async () => {
		try {
			const session = `${SESSION_ID}-hardening-ptr`;
			await activatePrWorkflow(tempDir, session, 'PR_FEEDBACK', {
				prHeadSha: HEAD_SHA,
			});
			const message = await admissionMessage(session, 'phase_complete', {});
			expect(message).toMatch(/rejects unclassified plugin\/MCP tools/);
			expect(message).toContain('rebind_pr_feedback_head');
			expect(message).toContain('prepare_pr_feedback_commit_message');
		} finally {
			await teardownPrWorkflowGateFixtures();
		}
	});

	test('both new controllers are admitted past the classifier and reach their controller behavior (F-R48)', async () => {
		try {
			const session = `${SESSION_ID}-hardening-cap`;
			await activatePrWorkflow(tempDir, session, 'PR_FEEDBACK', {
				prHeadSha: HEAD_SHA,
			});
			// rebind_pr_feedback_head: admitted (no admission rejection), then its
			// own contract refuses the no-op rebind to the bound intake head.
			await expect(
				enforcePrWorkflowToolBefore(
					tempDir,
					session,
					'rebind_pr_feedback_head',
					{
						pr_head_sha: HEAD_SHA,
					},
				),
			).resolves.toBeUndefined();
			await expect(
				rebindPrFeedbackHead(tempDir, session, HEAD_SHA),
			).rejects.toThrow(/no-op/);

			// prepare_pr_feedback_commit_message: on a bound-but-unverified gate it
			// is let PAST the admission classifier and stops at the ladder
			// precondition (the C24 reachability semantics: refused only by a
			// workflow-state precondition the operator can satisfy). The tool's
			// own execution path is probed separately for the schema refusal.
			const message = await admissionMessage(
				session,
				'prepare_pr_feedback_commit_message',
				{ message: 'x' },
			);
			expect(message).toMatch(
				/requires an immutable inventory and verification batches/,
			);
			expect(isAdmissionRejection(message)).toBe(false);
			const outcome = await executePreparePrFeedbackCommitMessage(
				{ message: '   ' },
				tempDir,
				{ sessionID: session },
			);
			const parsed = JSON.parse(outcome) as {
				success: boolean;
				message: string;
			};
			expect(parsed.success).toBe(false);
			expect(parsed.message).toMatch(/Invalid commit-message request/);
		} finally {
			await teardownPrWorkflowGateFixtures();
		}
	});
});
