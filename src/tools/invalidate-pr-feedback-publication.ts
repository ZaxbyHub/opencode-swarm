/**
 * invalidate_pr_feedback_publication — audited invalidation/rework
 * transition for an armed PR_FEEDBACK publication generation (issue #2108).
 *
 * The armed publication window is deliberately immutable: only read-only
 * inspection, the exact approved push, and complete_pr_workflow pass. When
 * approved content MUST change, this tool is the explicit revocation: it
 * marks the current generation `invalidated` with the given reason,
 * supersedes every content-dependent approval of that generation (Stage A
 * result, verification batches, ordered-gate batches, scope declarations —
 * historical records remain readable), and reopens the productive path:
 * scoped rework, Stage A rerun, fresh reviewer/critic dispatch, and a fresh
 * generation armed only after every ordered gate re-passes. It never grants
 * publication authority and never deletes audit evidence.
 */

import { z } from 'zod';
import { invalidatePrFeedbackPublication } from '../hooks/pr-workflow-gate.js';
import { createSwarmTool } from './create-tool';

const InvalidatePrFeedbackPublicationArgsSchema = z
	.object({
		reason: z.string().trim().min(1).max(500),
	})
	.strict();

export async function executeInvalidatePrFeedbackPublication(
	args: unknown,
	directory: string,
	context: { sessionID?: string } = {},
): Promise<string> {
	const parsed = InvalidatePrFeedbackPublicationArgsSchema.safeParse(args);
	if (!parsed.success) {
		return JSON.stringify({
			success: false,
			message: `Invalid publication invalidation: ${parsed.error.issues
				.map((issue) => `${issue.path.join('.')}: ${issue.message}`)
				.join('; ')}`,
		});
	}
	if (!context.sessionID?.trim()) {
		return JSON.stringify({
			success: false,
			message: 'Publication invalidation requires an active sessionID',
		});
	}
	try {
		const generation = await invalidatePrFeedbackPublication(
			directory,
			context.sessionID,
			parsed.data.reason,
		);
		return JSON.stringify({
			success: true,
			generation: generation.generation,
			previous_state: 'armed',
			message: `Publication generation ${generation.generation} is INVALIDATED (${generation.invalidationReason}). Every approval of this generation is superseded: rerun Stage A and every independent gate on the corrected content, then arm a fresh generation with complete_pr_workflow. Scoped rework reopens via prepare_pr_feedback_scope; the full audit trail is in the .swarm events store.`,
		});
	} catch (error) {
		return JSON.stringify({
			success: false,
			message: error instanceof Error ? error.message : String(error),
		});
	}
}

export const invalidate_pr_feedback_publication: ReturnType<
	typeof createSwarmTool
> = createSwarmTool({
	description:
		'Invalidate the armed PR_FEEDBACK publication generation so approved content can change (issue #2108). The explicit audited revocation/rework transition: it marks the current generation invalidated with a required reason, supersedes every content-dependent approval (Stage A, verification batches, ordered gates, scope declarations — audit history is preserved), and reopens the exact scoped rework path. A fresh generation arms only after the full ordered ladder re-passes via complete_pr_workflow. Use ONLY when approved content genuinely must change after arming; it never grants publication authority.',
	args: {
		reason: InvalidatePrFeedbackPublicationArgsSchema.shape.reason,
	},
	execute: executeInvalidatePrFeedbackPublication,
});
