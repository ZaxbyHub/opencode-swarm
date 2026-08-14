import { z } from 'zod';
import {
	abortPrWorkflow,
	type PrWorkflowMode,
} from '../hooks/pr-workflow-gate.js';
import { createSwarmTool } from './create-tool.js';
import { listPendingPrWorkflowCheckoutRestores } from './prepare-pr-workflow-checkout.js';

const AbortPrWorkflowArgsSchema = z
	.object({
		mode: z.enum(['PR_REVIEW', 'PR_FEEDBACK']).optional(),
		/**
		 * The architect's bounded recovery abort for an unrecoverable unbound or
		 * bound workflow after every PR lane has settled. The `force` variant is
		 * restricted to the human-only `/swarm abort-pr-workflow` command and is
		 * not agent-callable.
		 */
		kind: z.literal('recovery'),
		reason: z.string().trim().min(1).max(500),
	})
	.strict();

export async function executeAbortPrWorkflow(
	args: unknown,
	directory: string,
	context: { sessionID?: string } = {},
): Promise<string> {
	const parsed = AbortPrWorkflowArgsSchema.safeParse(args);
	if (!parsed.success) {
		return JSON.stringify({
			success: false,
			message: `Invalid PR workflow abort: ${parsed.error.issues
				.map((issue) => `${issue.path.join('.')}: ${issue.message}`)
				.join('; ')}`,
		});
	}
	if (!context.sessionID?.trim()) {
		return JSON.stringify({
			success: false,
			message: 'PR workflow abort requires an active sessionID',
		});
	}
	try {
		const summary = await abortPrWorkflow(directory, context.sessionID, {
			kind: parsed.data.kind,
			reason: parsed.data.reason,
			...(parsed.data.mode
				? { expectedMode: parsed.data.mode as PrWorkflowMode }
				: {}),
		});
		let checkoutRestoreRequired = true;
		let checkoutRestoreReceipts: Awaited<
			ReturnType<typeof listPendingPrWorkflowCheckoutRestores>
		> = [];
		try {
			checkoutRestoreReceipts = await listPendingPrWorkflowCheckoutRestores(
				directory,
				context.sessionID,
			);
			checkoutRestoreRequired = checkoutRestoreReceipts.length > 0;
		} catch {
			// The gate is already safely cleared. Fail toward preserving recovery:
			// the caller should inspect/restore rather than assume no stash exists.
		}
		return JSON.stringify({
			success: true,
			mode: summary.mode,
			...(summary.prHeadSha ? { pr_head_sha: summary.prHeadSha } : {}),
			open_lanes: summary.openLanes,
			gate_cleared: true,
			checkout_restore_required: checkoutRestoreRequired,
			checkout_restore_receipts: checkoutRestoreReceipts,
		});
	} catch (error) {
		return JSON.stringify({
			success: false,
			message: error instanceof Error ? error.message : String(error),
		});
	}
}

export const abort_pr_workflow: ReturnType<typeof createSwarmTool> =
	createSwarmTool({
		description:
			'Abort an active PR_REVIEW or PR_FEEDBACK mechanical gate and clear its durable session state, stopping the auto-resume loop. Requires kind: "recovery" and a one-line `reason`. Use after bounded recovery is exhausted, including a bound review or feedback workflow; do NOT use as a shortcut while useful recovery work remains. Refuses to abort while the workflow is armed for publication (call complete_pr_workflow instead) or while PR workflow lanes are still in flight (collect their results first). Reports checkout_restore_required when preserved pre-workflow changes remain. Records a best-effort audit event to .swarm/events.jsonl.',
		args: {
			mode: AbortPrWorkflowArgsSchema.shape.mode,
			kind: AbortPrWorkflowArgsSchema.shape.kind,
			reason: AbortPrWorkflowArgsSchema.shape.reason,
		},
		execute: executeAbortPrWorkflow,
	});
