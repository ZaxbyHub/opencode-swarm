import { z } from 'zod';
import {
	abortPrWorkflow,
	type PrWorkflowMode,
} from '../hooks/pr-workflow-gate.js';
import { createSwarmTool } from './create-tool.js';

const AbortPrWorkflowArgsSchema = z
	.object({
		mode: z.enum(['PR_REVIEW', 'PR_FEEDBACK']).optional(),
		reason: z.string().trim().max(500).optional(),
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
		const summary = await abortPrWorkflow(
			directory,
			context.sessionID,
			parsed.data.mode
				? {
						expectedMode: parsed.data.mode as PrWorkflowMode,
						reason: parsed.data.reason,
					}
				: { reason: parsed.data.reason },
		);
		return JSON.stringify({
			success: true,
			mode: summary.mode,
			...(summary.prHeadSha ? { pr_head_sha: summary.prHeadSha } : {}),
			open_lanes: summary.openLanes,
			gate_cleared: true,
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
			'Abort an active PR_REVIEW or PR_FEEDBACK mechanical gate and clear its durable session state, stopping the auto-resume loop. Use only when the workflow cannot reach complete_pr_workflow — for example a compound `git fetch && git checkout` was rejected as read-only shell syntax, the PR head cannot be fetched, or the working tree is on the wrong branch. Refuses to abort while the workflow is armed for publication (call complete_pr_workflow instead) or while PR workflow lanes are still in flight (collect their results first). Records a best-effort audit event to .swarm/events.jsonl. Prefer this tool over leaving the session trapped in a stale gate.',
		args: {
			mode: AbortPrWorkflowArgsSchema.shape.mode,
			reason: AbortPrWorkflowArgsSchema.shape.reason,
		},
		execute: executeAbortPrWorkflow,
	});
