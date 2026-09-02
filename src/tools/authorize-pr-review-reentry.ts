import { z } from 'zod';
import {
	issuePrReviewReentryAuthorization,
	type PrReviewReentryRole,
} from '../pr-review/authorization.js';
import { createSwarmTool } from './create-tool.js';

const AuthorizePrReviewReentryArgsSchema = z
	.object({
		run_id: z
			.string()
			.regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)
			.optional(),
		pr_head_sha: z
			.string()
			.trim()
			.regex(/^[0-9a-f]{6,64}$/i),
		role: z.enum(['reviewer', 'test_engineer']),
	})
	.strict();

/**
 * Issue a ONE-USE reviewer re-entry authorization (issue #2383) for the
 * CURRENT active PR_REVIEW workflow. The very next direct Task dispatch of
 * the declared role consumes it atomically and bypasses ONLY the generic
 * Stage-A task-workflow requirement; every other delegation gate stays
 * authoritative. Bindings are exact (session, workflow, run, head SHA,
 * worktree revision digest, role, gate generation): replay, cross-session
 * use, wrong role, expiry, or any workflow progress since issuance fails
 * closed. Issue immediately before the Task dispatch — authorizations are
 * not stockpilable.
 */
export async function executeAuthorizePrReviewReentry(
	args: unknown,
	directory: string,
	context: { sessionID?: string } = {},
): Promise<string> {
	const parsed = AuthorizePrReviewReentryArgsSchema.safeParse(args);
	if (!parsed.success) {
		return JSON.stringify({
			success: false,
			message: `Invalid PR-review re-entry authorization: ${parsed.error.issues
				.map((issue) => `${issue.path.join('.')}: ${issue.message}`)
				.join('; ')}`,
		});
	}
	if (!context.sessionID?.trim()) {
		return JSON.stringify({
			success: false,
			message: 'PR-review re-entry authorization requires an active sessionID',
		});
	}
	try {
		const record = await issuePrReviewReentryAuthorization(
			directory,
			context.sessionID,
			{
				...(parsed.data.run_id ? { runId: parsed.data.run_id } : {}),
				prHeadSha: parsed.data.pr_head_sha,
				role: parsed.data.role as PrReviewReentryRole,
			},
		);
		return JSON.stringify(
			{
				success: true,
				authorization_id: record.authorizationId,
				role: record.role,
				pr_head_sha: record.prHeadSha,
				run_id: record.runId,
				generation: record.generation,
				revision_digest: record.revisionDigest,
				expires_at: record.expiresAt,
				instructions: `Immediately dispatch exactly one Task call with subagent_type "${record.role}" for this PR-review re-entry; the delegation gate consumes this authorization once. Any other dispatch falls back to normal gating.`,
			},
			null,
			2,
		);
	} catch (error) {
		return JSON.stringify({
			success: false,
			message: error instanceof Error ? error.message : String(error),
		});
	}
}

export const authorize_pr_review_reentry: ReturnType<typeof createSwarmTool> =
	createSwarmTool({
		description:
			'Issue a one-use, identity-bound reviewer/test_engineer re-entry authorization for the active PR_REVIEW workflow (issue #2383). The authorization is consumed atomically by the very next direct Task dispatch of the declared role and bypasses ONLY the generic Stage-A task-workflow requirement — all other delegation gates remain authoritative. Bound to the exact session, workflow, run, PR head SHA, worktree revision digest, role, and gate generation; replay, cross-session use, wrong role, expiry (10 minutes), or any workflow progress since issuance fails closed. Requires an active head-bound PR_REVIEW gate. Issue immediately before the Task dispatch; unconsumed same-role authorizations at the same generation are refused.',
		args: {
			run_id: AuthorizePrReviewReentryArgsSchema.shape.run_id,
			pr_head_sha: AuthorizePrReviewReentryArgsSchema.shape.pr_head_sha,
			role: AuthorizePrReviewReentryArgsSchema.shape.role,
		},
		execute: executeAuthorizePrReviewReentry,
	});
