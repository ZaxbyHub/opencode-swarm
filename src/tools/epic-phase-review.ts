/**
 * Epic Mode phase review tool (`epic_phase_review`).
 *
 * Satisfies the `epic_phase_readiness` gate in `phase_complete`. The tool —
 * not the architect — dispatches a read-only phase reviewer and, when the
 * reviewer APPROVES, a read-only phase critic through the plugin-owned review
 * dispatcher, parses each verdict from the agent's own response, and records
 * both to `.swarm/evidence/{phase}/epic-phase-review.json` bound to the
 * current plan / phase task state. See `src/epic/phase-readiness.ts`.
 */

import type { ToolDefinition } from '@opencode-ai/plugin/tool';
import { z } from 'zod';
import {
	EPIC_PHASE_VERDICTS_KEEP,
	getOpenEpic,
	isEpicOpenForProject,
	updateEpicRecord,
} from '../epic/lifecycle.js';
import {
	describeOpenEpicWaves,
	type EpicPhaseReviewRunResult,
	resolveEpicPhaseReviewTimeoutMs,
	runEpicPhaseReview,
} from '../epic/phase-readiness.js';
import type { ReviewModelDispatcher } from '../review/contracts.js';
import type { ReviewAgentModelRegistry } from '../review/runtime.js';
import { createSwarmTool } from './create-tool.js';

export type EpicPhaseReviewToolResult =
	| EpicPhaseReviewRunResult
	| {
			success: false;
			phase: number;
			reason:
				| 'epic-mode-not-active'
				| 'no-session'
				| 'invalid-phase'
				| 'waves-open';
			message: string;
	  };

/**
 * DI seam (AGENTS.md invariant 7); restore in afterEach.
 * @tool-opt-out Test-only dependency-injection seam; not a public tool.
 */
export const _internals = {
	runEpicPhaseReview,
	resolveEpicPhaseReviewTimeoutMs,
	isEpicOpenForProject,
	describeOpenEpicWaves,
	getOpenEpic,
	updateEpicRecord,
};

/**
 * Record one review run and its verdicts on the open epic (Epic v2 C2).
 * Best-effort: the evidence file is the gate's authority; this is the
 * epic's own history for `/swarm epic status` and the close report.
 */
function recordReviewRun(
	directory: string,
	phase: number,
	result: EpicPhaseReviewRunResult,
): void {
	if (!result.success) return;
	try {
		const epic = _internals.getOpenEpic(directory);
		if (!epic) return;
		const verdict = `reviewer:${result.reviewer.verdict} critic:${result.critic?.verdict ?? 'not-run'}`;
		_internals.updateEpicRecord(
			directory,
			epic.epicKey,
			(record) => {
				const key = String(phase);
				const prior = record.phases[key];
				return {
					...record,
					phases: {
						...record.phases,
						[key]: {
							status: prior?.status ?? 'review',
							reviewRuns: (prior?.reviewRuns ?? 0) + 1,
							verdicts: [...(prior?.verdicts ?? []), verdict].slice(
								-EPIC_PHASE_VERDICTS_KEEP,
							),
						},
					},
				};
			},
			epic.token,
		);
	} catch {
		// history only — never fails the review
	}
}

export async function executeEpicPhaseReview(
	args: { phase: number },
	directory: string,
	sessionID: string | undefined,
	options: {
		dispatcher?: ReviewModelDispatcher;
		generatedAgentNames?: readonly string[];
		agentModelRegistry?: ReviewAgentModelRegistry;
		activeAgentName?: string;
	} = {},
): Promise<EpicPhaseReviewToolResult> {
	const phase = Number(args.phase);
	if (!Number.isInteger(phase) || phase < 1) {
		return {
			success: false,
			phase,
			reason: 'invalid-phase',
			message: 'phase must be a positive integer',
		};
	}
	if (!sessionID) {
		return {
			success: false,
			phase,
			reason: 'no-session',
			message:
				'epic_phase_review must be called from an architect session (no sessionID in tool context).',
		};
	}
	if (!_internals.isEpicOpenForProject(directory)) {
		return {
			success: false,
			phase,
			reason: 'epic-mode-not-active',
			message:
				'No epic is open for the current plan; the Epic phase review is only required (and only recorded) while an epic is open (`/swarm epic start`).',
		};
	}
	const openWaves = _internals.describeOpenEpicWaves(directory, phase);
	if (openWaves !== null) {
		return {
			success: false,
			phase,
			reason: 'waves-open',
			message: `Cannot review phase ${phase} yet: ${openWaves}`,
		};
	}
	const result = await _internals.runEpicPhaseReview(
		directory,
		phase,
		sessionID,
		{
			...options,
			timeoutMs: _internals.resolveEpicPhaseReviewTimeoutMs(directory),
		},
	);
	recordReviewRun(directory, phase, result);
	return result;
}

export function createEpicPhaseReviewTool(
	dispatcher?: ReviewModelDispatcher,
	generatedAgentNames?: readonly string[],
	agentModelRegistry?: ReviewAgentModelRegistry,
	getActiveAgentName?: (sessionID: string) => string | undefined,
): ToolDefinition {
	return createSwarmTool({
		description:
			'Epic Mode phase readiness: dispatch a read-only phase reviewer and then (only if it APPROVES) a read-only phase critic over the completed phase, parse their verdicts, and record them to .swarm/evidence/{phase}/epic-phase-review.json. ' +
			'Required by phase_complete while an epic is open for the current plan. Call after every task in the phase is completed; re-run after any fix (evidence goes stale when task gate evidence or the plan changes). ' +
			'Takes only the phase number — verdicts come from the dispatched agents, never from arguments.',
		args: {
			phase: z
				.number()
				.int()
				.positive()
				.describe('Phase number whose completed work should be reviewed'),
		},
		execute: async (args: unknown, directory: string, ctx) => {
			const sessionID = ctx?.sessionID;
			const result = await executeEpicPhaseReview(
				args as { phase: number },
				directory,
				sessionID,
				{
					dispatcher,
					generatedAgentNames,
					agentModelRegistry,
					activeAgentName:
						ctx?.agent !== undefined
							? String(ctx.agent)
							: sessionID
								? getActiveAgentName?.(sessionID)
								: undefined,
				},
			);
			return JSON.stringify(result, null, 2);
		},
	});
}

export const epic_phase_review: ToolDefinition = createEpicPhaseReviewTool();
