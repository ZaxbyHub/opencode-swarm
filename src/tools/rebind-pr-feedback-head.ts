/**
 * rebind_pr_feedback_head — controlled base-sync/rebind transition for a
 * PR_FEEDBACK workflow (issue #2131 criterion C2).
 *
 * After a merge/rebase used to resolve base drift or conflicts, the local
 * history is no longer a direct child of the immutable intake head, so the
 * ordinary exactly-one-reviewed-commit publication path can never be satisfied.
 * This tool moves the intake head to the new verified remote PR head and
 * invalidates every ancestry-bound receipt (Stage A, verification batches,
 * ordered gates), forcing the full mechanical ladder to re-run on the new
 * ancestry. Refuses while publication is armed or while lanes are in flight.
 */

import { z } from 'zod';
import { rebindPrFeedbackHead } from '../hooks/pr-workflow-gate.js';
import { createSwarmTool } from './create-tool';

const RebindPrFeedbackHeadArgsSchema = z
	.object({
		pr_head_sha: z
			.string()
			.trim()
			.regex(/^[0-9a-f]{40}$/i),
	})
	.strict();

export async function executeRebindPrFeedbackHead(
	args: unknown,
	directory: string,
	context: { sessionID?: string } = {},
): Promise<string> {
	const parsed = RebindPrFeedbackHeadArgsSchema.safeParse(args);
	if (!parsed.success) {
		return JSON.stringify({
			success: false,
			message: `Invalid PR feedback rebind: ${parsed.error.issues
				.map((issue) => `${issue.path.join('.')}: ${issue.message}`)
				.join('; ')}`,
		});
	}
	if (!context.sessionID?.trim()) {
		return JSON.stringify({
			success: false,
			message: 'PR feedback rebind requires an active sessionID',
		});
	}
	try {
		const state = await rebindPrFeedbackHead(
			directory,
			context.sessionID,
			parsed.data.pr_head_sha,
		);
		return JSON.stringify({
			success: true,
			pr_head_sha: state.prHeadSha,
			rebind_count: state.prFeedbackRebindCount ?? 1,
			message:
				'Rebound the PR_FEEDBACK intake head; every Stage A / verification / gate receipt is invalidated — re-run the full mechanical ladder on the new ancestry.',
		});
	} catch (error) {
		return JSON.stringify({
			success: false,
			message: error instanceof Error ? error.message : String(error),
		});
	}
}

export const rebind_pr_feedback_head: ReturnType<typeof createSwarmTool> =
	createSwarmTool({
		description:
			'Rebind a PR_FEEDBACK workflow to a new verified remote PR head after merge/rebase/conflict repair (base-sync). Use ONLY when the history genuinely changed to repair base drift or conflicts: it refuses a no-op rebind to the current intake head, refuses while publication is armed, and refuses while lanes are in flight. It invalidates every ancestry-bound receipt (Stage A, verification, ordered gates) so the full mechanical ladder re-runs on the new ancestry. Requires the full 40-char new PR head SHA; the current checkout must equal it.',
		args: {
			pr_head_sha: RebindPrFeedbackHeadArgsSchema.shape.pr_head_sha,
		},
		execute: executeRebindPrFeedbackHead,
	});
