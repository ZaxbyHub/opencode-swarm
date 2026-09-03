import { z } from 'zod';
import { PrReviewLaneResultEnvelopeSchema } from '../background/pr-review-contract.js';
import { submitPrReviewResult } from '../hooks/pr-workflow-gate.js';
import { createSwarmTool } from './create-tool.js';

const SubmitPrReviewResultArgsSchema = z
	.object({
		schemaVersion: z.literal(1),
		batchId: z.string().trim().min(1).max(120).optional(),
		laneId: z.string().trim().min(1).max(120).optional(),
		revisionDigest: z
			.string()
			.trim()
			.regex(/^[0-9a-f]{64}$/i),
		result: PrReviewLaneResultEnvelopeSchema,
	})
	.strict();

export async function executeSubmitPrReviewResult(
	args: unknown,
	directory: string,
	context: { sessionID?: string } = {},
): Promise<string> {
	const parsed = SubmitPrReviewResultArgsSchema.safeParse(args);
	const childSessionId = context.sessionID?.trim();
	if (!childSessionId) {
		return JSON.stringify({
			success: false,
			message:
				'submit_pr_review_result requires an authenticated child session',
		});
	}
	if (!parsed.success) {
		return JSON.stringify({
			success: false,
			message: `Invalid PR-review result: ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`,
		});
	}
	const outcome = await submitPrReviewResult(directory, childSessionId, {
		...(parsed.data.batchId ? { batchId: parsed.data.batchId } : {}),
		...(parsed.data.laneId ? { laneId: parsed.data.laneId } : {}),
		revisionDigest: parsed.data.revisionDigest,
		result: parsed.data.result,
	});
	return JSON.stringify({
		success: outcome.status === 'recorded' || outcome.status === 'duplicate',
		...outcome,
	});
}

export const submit_pr_review_result: ReturnType<typeof createSwarmTool> =
	createSwarmTool({
		description:
			'Submit exactly one typed CLEAN, FINDINGS, or INCOMPLETE result for the active child-bound PR-review base/micro lane. The authenticated child session identifies its exact delegation and supplies authoritative batch/lane provenance; optional batchId/laneId values are checked when present. The receipt is atomically bound to the child session, workflow instance, revision, batch, lane, root, base, and head. Identical replay is idempotent; conflicting or late submissions fail closed. Call once, then stop.',
		args: {
			schemaVersion: SubmitPrReviewResultArgsSchema.shape.schemaVersion,
			batchId: SubmitPrReviewResultArgsSchema.shape.batchId,
			laneId: SubmitPrReviewResultArgsSchema.shape.laneId,
			revisionDigest: SubmitPrReviewResultArgsSchema.shape.revisionDigest,
			result: SubmitPrReviewResultArgsSchema.shape.result,
		},
		execute: executeSubmitPrReviewResult,
	});
