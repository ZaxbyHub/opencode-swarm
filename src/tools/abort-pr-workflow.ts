import { z } from 'zod';
import { loadPluginConfig } from '../config/loader.js';
import {
	abortPrWorkflow,
	type PrWorkflowLaneLivenessOptions,
	type PrWorkflowMode,
	recoverArmedPrWorkflow,
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
		 * not agent-callable. `cancel-publication` (issue #2108) is the audited
		 * cancellation-without-publication exit for an armed PR_FEEDBACK
		 * publication generation: it requires `cancel_publication: true` and
		 * records a terminal no-publish state — it never grants push authority.
		 */
		kind: z.literal('recovery').or(z.literal('cancel-publication')),
		reason: z.string().trim().min(1).max(500),
		cancel_publication: z.boolean().optional(),
	})
	.strict();

const ArmedRecoveryArgsSchema = z
	.object({
		mode: z.enum(['PR_REVIEW', 'PR_FEEDBACK']).optional(),
		/**
		 * Issue #2383 audited armed recovery: the explicit, identity-correlated
		 * escape for a publication-armed workflow whose exact publication cannot
		 * proceed. Requires the exact bound head SHA, the staged authorization's
		 * revision digest, and the current gate-state generation; every mismatch
		 * fails closed and no `force` variant exists. Settles lanes first,
		 * appends one bounded audit event, invalidates the staged publication
		 * authorization, and leaves a recoverable terminal state that preserves
		 * validated work.
		 */
		kind: z.literal('armed_recovery'),
		reason: z.string().trim().min(1).max(500),
		armed_recovery: z
			.object({
				pr_head_sha: z.string().trim().min(6).max(64),
				/** Exact merge-base SHA; required by the gate when the workflow carries one. */
				base_sha: z.string().trim().min(6).max(64).optional(),
				revision_digest: z.string().trim().min(1).max(256),
				generation: z.number().int().nonnegative(),
				workflow_instance_id: z.string().trim().min(1).max(128).optional(),
			})
			.strict(),
	})
	.strict();

const AbortOrRecoverArgsSchema = z.union([
	AbortPrWorkflowArgsSchema,
	ArmedRecoveryArgsSchema,
]);

const RegisteredAbortKindSchema = z.union([
	AbortPrWorkflowArgsSchema.shape.kind,
	ArmedRecoveryArgsSchema.shape.kind,
]);

export async function executeAbortPrWorkflow(
	args: unknown,
	directory: string,
	context: { sessionID?: string } = {},
): Promise<string> {
	const parsed = AbortOrRecoverArgsSchema.safeParse(args);
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
	// Issue #2506: resolve the lane-liveness watchdog policy from the
	// directory-scoped plugin config (dispatch-lanes `loadPluginConfig`
	// precedent) and thread it into both abort arms.
	let laneLiveness: PrWorkflowLaneLivenessOptions | undefined;
	try {
		const config = loadPluginConfig(directory);
		const hooks = (
			config as { hooks?: { background_pending_timeout_minutes?: number } }
		).hooks;
		laneLiveness = {
			laneLivenessWatchdog: config.lane_liveness_watchdog,
			backgroundPendingTimeoutMs:
				hooks?.background_pending_timeout_minutes !== undefined
					? hooks.background_pending_timeout_minutes * 60_000
					: undefined,
		};
	} catch {
		// Config read failure must not block the abort escape hatch; the
		// disabled default is always safe.
	}
	if (parsed.data.kind === 'armed_recovery') {
		try {
			const summary = await recoverArmedPrWorkflow(
				directory,
				context.sessionID,
				{
					...(parsed.data.mode
						? { expectedMode: parsed.data.mode as PrWorkflowMode }
						: {}),
					prHeadSha: parsed.data.armed_recovery.pr_head_sha,
					...(parsed.data.armed_recovery.base_sha
						? { baseSha: parsed.data.armed_recovery.base_sha }
						: {}),
					revisionDigest: parsed.data.armed_recovery.revision_digest,
					generation: parsed.data.armed_recovery.generation,
					...(parsed.data.armed_recovery.workflow_instance_id
						? {
								workflowInstanceId:
									parsed.data.armed_recovery.workflow_instance_id,
							}
						: {}),
					reason: parsed.data.reason,
					...(laneLiveness ? { laneLiveness } : {}),
				},
			);
			return JSON.stringify({
				success: true,
				mode: summary.mode,
				pr_head_sha: summary.prHeadSha,
				open_lanes: summary.openLanes,
				settled_lanes: summary.settledLanes,
				cancelled_dimensions: summary.cancelledDimensions,
				recovered_at: summary.recoveredAt,
				armed_recovery: true,
				publication_authorization_invalidated: true,
				gate_preserved: true,
			});
		} catch (error) {
			return JSON.stringify({
				success: false,
				message: error instanceof Error ? error.message : String(error),
			});
		}
	}
	try {
		if (parsed.data.kind === 'cancel-publication') {
			if (parsed.data.cancel_publication !== true) {
				return JSON.stringify({
					success: false,
					message:
						'Invalid PR workflow abort: kind "cancel-publication" requires cancel_publication: true',
				});
			}
		}
		const summary = await abortPrWorkflow(directory, context.sessionID, {
			kind: parsed.data.kind,
			reason: parsed.data.reason,
			...(parsed.data.cancel_publication !== undefined
				? { cancelPublication: parsed.data.cancel_publication }
				: {}),
			...(parsed.data.mode
				? { expectedMode: parsed.data.mode as PrWorkflowMode }
				: {}),
			...(laneLiveness ? { laneLiveness } : {}),
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
			...(parsed.data.kind === 'cancel-publication'
				? { status: 'cancelled_without_publication' }
				: {}),
			...(summary.prHeadSha ? { pr_head_sha: summary.prHeadSha } : {}),
			open_lanes: summary.openLanes,
			// Issue #2242 R2 (W-4): lanes settled as presumed-stale rather than
			// observed terminal. Disclosed so the operator can see what was NOT
			// re-verified before the gate cleared.
			...(summary.presumedStaleLanes?.length
				? {
						presumed_stale_lanes: summary.presumedStaleLanes,
						presumed_stale_disclosure: summary.presumedStaleDisclosure,
					}
				: {}),
			// Issue #2251: why the liveness probe produced no evidence, so the
			// operator can tell "settled, probe found no live session" apart from
			// "settled without re-verification because the probe could not run" at
			// the surface they read first.
			//
			// Deliberately NOT surfacing `probeRetainedLanes` /
			// `probeRetentionOverrideDisclosure` here: a retained lane keeps
			// `openLanes > 0`, and only a `force` abort may override that. This tool
			// admits only non-armed abort kinds, so on any response that reaches this
			// point those two fields are unreachable — a spread that could never
			// fire is unwired code, not defence in depth. They are surfaced on the
			// human-only `/swarm abort-pr-workflow` force path
			// (`src/commands/abort-pr-workflow.ts`) and on the `pr_workflow_aborted`
			// audit event, which are the two places a force override is observable.
			...(summary.probeDegradedReason
				? { probe_status: summary.probeDegradedReason }
				: {}),
			// Issue #2242 R4 (W-5): the gate state was schema-invalid and had to be
			// SALVAGED to clear it, and/or the CAS guard was deliberately dropped
			// because the revision itself was unsalvageable. The operator reads this
			// tool response before anything else, so the "survives with a loud
			// disclosure" contract has to hold at THIS surface, not only in
			// events.jsonl and pr_workflow_status. Split into two spreads, matching
			// the gate's own conditions: casEscape implies salvaged today, but
			// encoding that coupling here would be a latent bug if they diverge.
			...(summary.stateSalvaged
				? {
						state_salvaged: true,
						state_salvage_disclosure: summary.stateSalvageDisclosure,
					}
				: {}),
			...(summary.casEscapeDisclosure
				? { cas_escape_disclosure: summary.casEscapeDisclosure }
				: {}),
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
			'Abort an active PR_REVIEW or PR_FEEDBACK mechanical gate and clear its durable session state, stopping the auto-resume loop. Requires kind: "recovery" and a one-line `reason`. Use after bounded recovery is exhausted, including a bound review or feedback workflow; do NOT use as a shortcut while useful recovery work remains. Refuses to abort while the workflow is armed for publication (call complete_pr_workflow instead) or while PR workflow lanes are still in flight (collect their results first). To change approved content after arming, use invalidate_pr_feedback_publication (audited invalidation; the full ladder re-runs). To cancel an armed PR_FEEDBACK workflow WITHOUT publication, use kind: "cancel-publication" with cancel_publication: true and a reason: the publication generation is recorded as cancelled_without_publication (terminal, never grants push authority, observed remote head disclosed) before the gate clears. kind "armed_recovery" (issue #2383) is the audited, identity-correlated escape for a publication-armed workflow whose exact publication cannot proceed: pass armed_recovery {pr_head_sha, revision_digest, generation, workflow_instance_id?} plus a reason; it settles lanes first, appends one bounded audit event, invalidates the staged publication authorization, and leaves a recoverable terminal state that preserves validated work (exact approved publication via complete_pr_workflow remains available and preferred). Identity/revision mismatches fail closed and no force variant exists. A lane past the staleness horizon whose session a liveness probe still reports as running also refuses the abort, and only the human-only /swarm abort-pr-workflow force path can override that retention; probe_status reports when a lane was instead settled without re-verification because the probe itself could not run. Reports checkout_restore_required when preserved pre-workflow changes remain. Reports state_salvaged with state_salvage_disclosure when the durable gate state was schema-invalid and had to be salvaged to clear it, and cas_escape_disclosure when the state revision was unsalvageable and the gate was therefore cleared without its compare-and-swap guard — treat either as a signal to re-verify the workflow before proceeding. Records a best-effort audit event to .swarm/events.jsonl.',
		args: {
			mode: AbortPrWorkflowArgsSchema.shape.mode,
			kind: RegisteredAbortKindSchema,
			reason: AbortPrWorkflowArgsSchema.shape.reason,
			cancel_publication: AbortPrWorkflowArgsSchema.shape.cancel_publication,
			armed_recovery: ArmedRecoveryArgsSchema.shape.armed_recovery.optional(),
		},
		execute: executeAbortPrWorkflow,
	});
