import { z } from 'zod';
import {
	completePrWorkflow,
	type PrWorkflowMode,
} from '../hooks/pr-workflow-gate.js';
import { createSwarmTool } from './create-tool.js';

const CompletePrWorkflowArgsSchema = z
	.object({
		mode: z.enum(['PR_REVIEW', 'PR_FEEDBACK']),
		pr_head_sha: z.string().trim().min(1).max(80),
	})
	.strict();

export async function executeCompletePrWorkflow(
	args: unknown,
	directory: string,
	context: { sessionID?: string } = {},
): Promise<string> {
	const parsed = CompletePrWorkflowArgsSchema.safeParse(args);
	if (!parsed.success) {
		return JSON.stringify({
			success: false,
			message: `Invalid PR workflow completion: ${parsed.error.issues
				.map((issue) => `${issue.path.join('.')}: ${issue.message}`)
				.join('; ')}`,
		});
	}
	if (!context.sessionID?.trim()) {
		return JSON.stringify({
			success: false,
			message: 'PR workflow completion requires an active sessionID',
		});
	}
	try {
		const status = await completePrWorkflow(
			directory,
			context.sessionID,
			parsed.data.mode as PrWorkflowMode,
			parsed.data.pr_head_sha,
		);
		return JSON.stringify({
			success: true,
			mode: parsed.data.mode,
			pr_head_sha: parsed.data.pr_head_sha,
			status,
			ready_to_publish: status === 'ready-to-publish',
			gate_cleared: status === 'completed',
		});
	} catch (error) {
		return JSON.stringify({
			success: false,
			message: error instanceof Error ? error.message : String(error),
		});
	}
}

export const complete_pr_workflow: ReturnType<typeof createSwarmTool> =
	createSwarmTool({
		description:
			'Validate terminal PR workflow coverage. After the ordered PR_FEEDBACK gates permit one standalone commit, the first call requires a clean tree and a non-merge direct child of intake HEAD, then binds its structured upstream target; the second clears only after both the local tracking ref and an actual-remote query point to that exact commit.',
		args: {
			mode: CompletePrWorkflowArgsSchema.shape.mode,
			pr_head_sha: CompletePrWorkflowArgsSchema.shape.pr_head_sha,
		},
		execute: executeCompletePrWorkflow,
	});
