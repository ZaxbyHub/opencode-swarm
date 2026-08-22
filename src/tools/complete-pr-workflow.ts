import { z } from 'zod';
import {
	completePrWorkflow,
	type PrFeedbackInventoryAmendmentRecord,
	type PrWorkflowMode,
	readPrWorkflowGateState,
	settlePresumedStalePrWorkflowLanes,
} from '../hooks/pr-workflow-gate.js';
import { createSwarmTool } from './create-tool.js';
import { listPendingPrWorkflowCheckoutRestores } from './prepare-pr-workflow-checkout.js';

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
	// Issue #2242 R2 (W-4): resolve the presumed-stale lane settlement BEFORE
	// completion so the disclosure is available on both the success and the
	// failure response — completion legitimately fails on real coverage after a
	// lane died, and the operator still needs to see which lanes were settled
	// without an observed terminal snapshot. `completePrWorkflow` applies the
	// same settlement internally (defence in depth for non-tool callers); the
	// sweep is idempotent, so calling it here costs nothing on the second pass.
	let staleDisclosure: {
		presumed_stale_lanes?: string[];
		presumed_stale_disclosure?: string;
		probe_retained_lanes?: string[];
		probe_status?: string;
	} = {};
	try {
		const settlement = await _internals.settlePresumedStalePrWorkflowLanes(
			directory,
			context.sessionID,
		);
		if (settlement.presumedStaleLaneIds.length > 0) {
			staleDisclosure = {
				presumed_stale_lanes: settlement.presumedStaleLaneIds,
				presumed_stale_disclosure: settlement.disclosure,
			};
		}
		// Issue #2251: independent of whether anything settled. A lane the liveness
		// probe reported as still running is exactly why completion is refused, and
		// a degraded probe is why a lane was settled WITHOUT re-verification — both
		// have to be visible on the failure response, which is the one an operator
		// reads in this situation.
		if (settlement.probedAliveLaneIds?.length) {
			staleDisclosure.probe_retained_lanes = settlement.probedAliveLaneIds;
		}
		if (settlement.probeDegradedReason) {
			staleDisclosure.probe_status = settlement.probeDegradedReason;
		}
	} catch {
		// Observation only. A settlement-read failure must never convert a
		// completable workflow into a refusal; the gate re-derives it anyway.
	}
	// Issue #2242 R3 (W-2): the completion disclosure lists every entry appended
	// to the inventory after its first declaration. Read BEFORE completing —
	// a successful completion clears the durable state that carries the ledger.
	let amendmentDisclosure: {
		inventory_amendments?: PrFeedbackInventoryAmendmentRecord[];
	} = {};
	try {
		const gateState = await _internals.readPrWorkflowGateState(
			directory,
			context.sessionID,
		);
		if (gateState?.prFeedbackInventoryAmendments?.length) {
			amendmentDisclosure = {
				inventory_amendments: gateState.prFeedbackInventoryAmendments,
			};
		}
	} catch {
		// Observation only; the gate re-validates everything that matters.
	}
	try {
		const status = await _internals.completePrWorkflow(
			directory,
			context.sessionID,
			parsed.data.mode as PrWorkflowMode,
			parsed.data.pr_head_sha,
		);
		let checkoutRestoreRequired = false;
		let checkoutRestoreReceipts: Awaited<
			ReturnType<typeof listPendingPrWorkflowCheckoutRestores>
		> = [];
		if (status === 'completed') {
			try {
				checkoutRestoreReceipts =
					await _internals.listPendingPrWorkflowCheckoutRestores(
						directory,
						context.sessionID,
					);
				checkoutRestoreRequired = checkoutRestoreReceipts.length > 0;
			} catch {
				// Terminal coverage already cleared the gate. Preserve the safer signal
				// when receipt inventory cannot be proven empty.
				checkoutRestoreRequired = true;
			}
		}
		return JSON.stringify({
			success: true,
			mode: parsed.data.mode,
			pr_head_sha: parsed.data.pr_head_sha,
			status,
			ready_to_publish: status === 'ready-to-publish',
			// 'verified-no-change' is also a terminal clearing (issue #2131
			// criterion C1): the gate is cleared with nothing to publish.
			verified_no_change: status === 'verified-no-change',
			gate_cleared: status === 'completed' || status === 'verified-no-change',
			checkout_restore_required: checkoutRestoreRequired,
			checkout_restore_receipts: checkoutRestoreReceipts,
			...staleDisclosure,
			...amendmentDisclosure,
		});
	} catch (error) {
		return JSON.stringify({
			success: false,
			message: error instanceof Error ? error.message : String(error),
			...staleDisclosure,
			...amendmentDisclosure,
		});
	}
}

export const complete_pr_workflow: ReturnType<typeof createSwarmTool> =
	createSwarmTool({
		description:
			'Validate terminal PR workflow coverage. After the ordered PR_FEEDBACK gates permit one standalone commit, the first call requires a clean tree and a non-merge direct child of intake HEAD, then binds its structured upstream target; the second clears only after both the local tracking ref and an actual-remote query point to that exact commit. A cleared result reports checkout_restore_required when preserved pre-workflow changes must be restored.',
		args: {
			mode: CompletePrWorkflowArgsSchema.shape.mode,
			pr_head_sha: CompletePrWorkflowArgsSchema.shape.pr_head_sha,
		},
		execute: executeCompletePrWorkflow,
	});

export const _internals: {
	completePrWorkflow: typeof completePrWorkflow;
	listPendingPrWorkflowCheckoutRestores: typeof listPendingPrWorkflowCheckoutRestores;
	readPrWorkflowGateState: typeof readPrWorkflowGateState;
	settlePresumedStalePrWorkflowLanes: typeof settlePresumedStalePrWorkflowLanes;
} = {
	completePrWorkflow,
	listPendingPrWorkflowCheckoutRestores,
	readPrWorkflowGateState,
	settlePresumedStalePrWorkflowLanes,
};
