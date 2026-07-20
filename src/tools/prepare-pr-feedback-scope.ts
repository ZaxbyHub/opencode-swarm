import { z } from 'zod';
import { checkWriteTargetForSymlink } from '../hooks/guardrails.js';
import { declarePrFeedbackScope } from '../hooks/pr-workflow-gate.js';
import { normalizeScopeFiles } from '../scope/scope-binding.js';
import { createSwarmTool } from './create-tool.js';

const PreparePrFeedbackScopeArgsSchema = z
	.object({
		task_id: z
			.string()
			.regex(/^\d+\.\d+(?:\.\d+)*$/, 'task_id must use N.M notation'),
		files: z.array(z.string().min(1).max(4096)).min(1).max(10_000),
	})
	.strict();

function failure(message: string): string {
	return JSON.stringify({ success: false, message }, null, 2);
}

export async function executePreparePrFeedbackScope(
	args: unknown,
	directory: string,
	context: { sessionID?: string } = {},
): Promise<string> {
	const parsed = PreparePrFeedbackScopeArgsSchema.safeParse(args);
	if (!parsed.success) {
		return failure(
			`Invalid PR-feedback scope: ${parsed.error.issues
				.map((issue) => `${issue.path.join('.')}: ${issue.message}`)
				.join('; ')}`,
		);
	}
	const sessionID = context.sessionID?.trim();
	if (!sessionID)
		return failure('PR-feedback scope requires an active session');
	const files = normalizeScopeFiles(parsed.data.files);
	if (!files) return failure('PR-feedback scope contains an unsafe file path');
	for (const file of files) {
		const symlinkBlock = checkWriteTargetForSymlink(file, directory);
		if (symlinkBlock) return failure(symlinkBlock);
	}
	try {
		await declarePrFeedbackScope(
			directory,
			sessionID,
			parsed.data.task_id,
			files,
		);
	} catch (error) {
		return failure(error instanceof Error ? error.message : String(error));
	}
	return JSON.stringify(
		{
			success: true,
			task_id: parsed.data.task_id,
			files,
			message:
				'Scope is bound to the verified PR-feedback revision and will authorize only the next matching coder Task.',
		},
		null,
		2,
	);
}

export const prepare_pr_feedback_scope: ReturnType<typeof createSwarmTool> =
	createSwarmTool({
		description:
			'Prepare an exact file scope for one PR-feedback coder Task after immutable feedback verification settles.',
		args: {
			task_id: PreparePrFeedbackScopeArgsSchema.shape.task_id,
			files: PreparePrFeedbackScopeArgsSchema.shape.files,
		},
		execute: executePreparePrFeedbackScope,
	});
