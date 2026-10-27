import { z } from 'zod';
import { loadPluginConfig } from '../config/loader.js';
import {
	completePrWorkflow,
	type PrFeedbackInventoryAmendmentRecord,
	type PrWorkflowLaneLivenessOptions,
	type PrWorkflowMode,
	readPrReviewFinalFindingPolicyForReport,
	readPrReviewTerminalCoverageForReport,
	readPrWorkflowGateState,
	settlePresumedStalePrWorkflowLanes,
} from '../hooks/pr-workflow-gate.js';
import { createSwarmTool } from './create-tool.js';
import { listPendingPrWorkflowCheckoutRestores } from './prepare-pr-workflow-checkout.js';

const CompletePrWorkflowArgsSchema = z
	.object({
		mode: z.enum(['PR_REVIEW', 'PR_FEEDBACK']),
		pr_head_sha: z.string().trim().min(1).max(80),
		/**
		 * Terminal report verdict (issue #2383). REQUIRED for PR_REVIEW
		 * completions: the gate validates it against the settlement-derived
		 * coverage kind — PARTIAL may only REQUEST_CHANGES or INCOMPLETE,
		 * NO_COVERAGE is a forced INCOMPLETE operational report, and neither
		 * may ever APPROVE. Unused for PR_FEEDBACK.
		 */
		report_verdict: z
			.enum(['APPROVE', 'REQUEST_CHANGES', 'INCOMPLETE'])
			.optional(),
	})
	.strict()
	.superRefine((value, ctx) => {
		if (value.mode === 'PR_REVIEW' && value.report_verdict === undefined) {
			ctx.addIssue({
				code: 'custom',
				path: ['report_verdict'],
				message:
					'is required for PR_REVIEW completion (issue #2383 terminal report)',
			});
		}
	});

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
		presumed_stale_disclosure?: string | undefined;
		probe_retained_lanes?: string[];
		probe_status?: string;
		horizon_conflict?: string;
	} = {};
	// Issue #2506: resolve the lane-liveness watchdog policy from the same
	// directory-scoped plugin config the resilience policy uses
	// (`loadPluginConfig`, the dispatch-lanes precedent) and thread it plus
	// the background pending timeout so the settlement applies ONE
	// effective horizon with conflict disclosure. Declared outside the
	// observation try so the gate call below threads the SAME policy.
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
		// Config read failure must not block completion. The fallback keeps
		// the watchdog off (the explicit opt-out semantics), independent of
		// the schema's default — the fail-open here means "no policy read",
		// not "safe because the default is disabled".
	}
	try {
		const settlement = await _internals.settlePresumedStalePrWorkflowLanes(
			directory,
			context.sessionID,
			laneLiveness,
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
		// Issue #2506 review round 2: surface the horizon disagreement (AC2
		// conflictDisclosed) on the response whenever it exists — not gated on
		// anything having settled, because a silently absorbed config conflict
		// is exactly what the operator needs to see even on success paths.
		if (settlement.horizonConflictNote) {
			staleDisclosure.horizon_conflict = settlement.horizonConflictNote;
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
		// Issue #2383: read the truthful terminal settlement BEFORE the
		// terminal clear so the response can carry it (read-before-clear, the
		// same discipline as staleDisclosure above).
		let terminalReport: Record<string, unknown> | undefined;
		if (parsed.data.mode === 'PR_REVIEW') {
			let coverage: Awaited<
				ReturnType<typeof readPrReviewTerminalCoverageForReport>
			> | null = null;
			try {
				coverage = await _internals.readPrReviewTerminalCoverageForReport(
					directory,
					context.sessionID,
				);
			} catch {
				// Coverage is optional observation data; the completion gate remains
				// authoritative below and still completes without this report.
			}
			if (coverage) {
				let findingPolicy:
					| Awaited<ReturnType<typeof readPrReviewFinalFindingPolicyForReport>>
					| undefined;
				try {
					findingPolicy =
						await _internals.readPrReviewFinalFindingPolicyForReport(
							directory,
							context.sessionID,
						);
				} catch {
					// The optional finding-policy sidecar must not erase the truthful
					// coverage-derived terminal report (F-012).
				}
				terminalReport = {
					kind: coverage.kind,
					covered_dimensions: coverage.coveredDimensions,
					unresolved_dimensions: coverage.unresolvedDimensions,
					live_dimensions: coverage.liveDimensions,
					allowed_verdicts:
						findingPolicy?.permittedVerdicts ?? coverage.allowedVerdicts,
					...(findingPolicy
						? {
								finding_policy_version: findingPolicy.policyVersion,
								blocking_finding_ids: findingPolicy.blockingFindingIds,
							}
						: {}),
					report_verdict: parsed.data.report_verdict,
					// Issue #3098: bounded findings and degradation summaries, captured
					// before the terminal clear deletes the gate-state pointer fields
					// that address this evidence. Both readers are fail-open.
					...((summary) => (summary ? { findings_summary: summary } : {}))(
						await findingsSummaryForReportSafe(directory, context.sessionID),
					),
					coverage_degradations: await coverageDegradationsForReportSafe(
						directory,
						context.sessionID,
					),
					verdict_settlement: await verdictSettlementSummaryForReportSafe(
						directory,
						context.sessionID,
					),
				};
			}
		}
		const status = await _internals.completePrWorkflow(
			directory,
			context.sessionID,
			parsed.data.mode as PrWorkflowMode,
			parsed.data.pr_head_sha,
			// Issue #2506: thread the resolved watchdog policy into the gate's
			// internal settlement too — the observation settlement above and
			// the gate re-validation must run the SAME effective horizon.
			parsed.data.mode === 'PR_REVIEW'
				? {
						reportVerdict: parsed.data.report_verdict,
						...(laneLiveness ? { laneLiveness } : {}),
					}
				: laneLiveness
					? { laneLiveness }
					: undefined,
		);
		let checkoutRestoreRequired = false;
		let checkoutRestoreReceipts: Awaited<
			ReturnType<typeof listPendingPrWorkflowCheckoutRestores>
		> = [];
		if (status === 'completed') {
			if (
				parsed.data.mode === 'PR_REVIEW' &&
				parsed.data.report_verdict === 'INCOMPLETE' &&
				terminalReport
			) {
				// Feedback F2 round 2: a run that COMPLETED with report_verdict
				// INCOMPLETE never admits APPROVE/REQUEST_CHANGES on any path —
				// the bypass arm (which persists a skip disclosure), a
				// fully-settled ladder INCOMPLETE, or NO_COVERAGE. The override
				// is keyed on the completed verdict, not pre-completion state,
				// so it is truthful for first-time bypass runs and cannot leak
				// into an APPROVE/REQUEST_CHANGES ladder completion.
				terminalReport.allowed_verdicts = ['INCOMPLETE'];
			}
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
			...(terminalReport ? { terminal_report: terminalReport } : {}),
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
			report_verdict: CompletePrWorkflowArgsSchema.shape.report_verdict,
		},
		execute: executeCompletePrWorkflow,
	});

export const _internals: {
	completePrWorkflow: typeof completePrWorkflow;
	listPendingPrWorkflowCheckoutRestores: typeof listPendingPrWorkflowCheckoutRestores;
	readPrWorkflowGateState: typeof readPrWorkflowGateState;
	readPrReviewTerminalCoverageForReport: typeof readPrReviewTerminalCoverageForReport;
	readPrReviewFinalFindingPolicyForReport: typeof readPrReviewFinalFindingPolicyForReport;
	settlePresumedStalePrWorkflowLanes: typeof settlePresumedStalePrWorkflowLanes;
	verdictSettlementSummaryForReportSafe: typeof verdictSettlementSummaryForReportSafe;
} = {
	completePrWorkflow,
	listPendingPrWorkflowCheckoutRestores,
	readPrWorkflowGateState,
	readPrReviewTerminalCoverageForReport,
	readPrReviewFinalFindingPolicyForReport,
	settlePresumedStalePrWorkflowLanes,
	verdictSettlementSummaryForReportSafe,
};

/** Issue #3101: additive per-item disclosure echo for admitted N-of-M verdict settlements. */
async function verdictSettlementSummaryForReport(
	directory: string,
	sessionID: string,
): Promise<
	Array<{
		itemId: string;
		sourceBatchId: string;
		sourceLaneId: string;
		disposition: string;
		evidenceClass: string;
		terminalStatus: string;
	}>
> {
	const { readPrReviewVerdictSettlementReceiptItems } = await import(
		'../hooks/pr-workflow-gate.js'
	);
	return readPrReviewVerdictSettlementReceiptItems(directory, sessionID);
}

/** Observation-only echo: a read failure degrades to an absent echo (the
 * sibling observation-only reads above follow the same guard pattern) rather
 * than failing the completion report itself. */
async function verdictSettlementSummaryForReportSafe(
	directory: string,
	sessionID: string,
) {
	try {
		return await verdictSettlementSummaryForReport(directory, sessionID);
	} catch {
		return undefined;
	}
}

/**
 * Issue #3098: count-based findings summary for the terminal report, captured
 * before the terminal clear. `by_severity` keys are constrained to the
 * FindingSeverity enum values plus a literal `OTHER` bucket, so no rendered
 * key can ever be an arbitrary (or sentinel-bearing) string.
 */
async function findingsSummaryForReport(
	directory: string,
	sessionID: string,
): Promise<{
	total: number;
	by_severity: Record<string, number>;
}> {
	const { readAuthoritativeFindingPolicy } = await import(
		'../hooks/pr-workflow-gate.js'
	);
	const state = await readPrWorkflowGateState(directory, sessionID);
	if (!state) {
		throw new Error('BLOCKED: no active PR workflow gate state');
	}
	const { policyFindings } = await readAuthoritativeFindingPolicy(
		directory,
		state,
	);
	const severityAxes = new Set([
		'CRITICAL',
		'HIGH',
		'MEDIUM',
		'LOW',
		'INFO',
		'NONE',
	]);
	const bySeverity: Record<string, number> = {};
	for (const finding of policyFindings) {
		const axis = severityAxes.has(finding.severity)
			? finding.severity
			: 'OTHER';
		bySeverity[axis] = (bySeverity[axis] ?? 0) + 1;
	}
	return { total: policyFindings.length, by_severity: bySeverity };
}

/** Observation-only echo (same guard pattern as the sibling readers above). */
async function findingsSummaryForReportSafe(
	directory: string,
	sessionID: string,
): Promise<{ total: number; by_severity: Record<string, number> } | undefined> {
	try {
		return await findingsSummaryForReport(directory, sessionID);
	} catch {
		return undefined;
	}
}

/**
 * Issue #3098: bounded coverage-degradation disclosure for the terminal
 * report, read from the run's trigger-eval receipt before the terminal clear.
 * Free-text `reason` values are CLEAN-redacted: the terminal report shape
 * invariant (r04 / the #3098 frozen check) forbids the bare literal CLEAN
 * anywhere in the report.
 */
const MAX_TERMINAL_COVERAGE_DEGRADATIONS = 10;
const MAX_TERMINAL_DEGRADATION_REASON_CHARS = 200;
const MAX_TERMINAL_DEGRADATION_ID_CHARS = 200;

function boundTerminalText(value: string, max: number): string {
	return value.slice(0, max);
}

function redactTerminalCleanLiteral(value: string): string {
	return value.includes('CLEAN')
		? value.split('CLEAN').join('clean-attestation')
		: value;
}

async function coverageDegradationsForReport(
	directory: string,
	sessionID: string,
): Promise<
	Array<{
		trigger_id: string;
		source_batch_id: string;
		source_lane_id: string;
		reason: string;
	}>
> {
	const state = await readPrWorkflowGateState(directory, sessionID);
	if (!state) return [];
	const { readPrReviewTriggerReceiptForGate } = await import(
		'../background/pr-review-trigger-receipt-reader.js'
	);
	const read = readPrReviewTriggerReceiptForGate(
		directory,
		state.prReviewTriggerEvalPath ?? null,
	);
	if ('noReceipt' in read) return [];
	return read.receipt.coverageDegradations
		.slice(0, MAX_TERMINAL_COVERAGE_DEGRADATIONS)
		.map((degradation) => ({
			trigger_id: degradation.trigger_id,
			source_batch_id: boundTerminalText(
				redactTerminalCleanLiteral(degradation.source_batch_id),
				MAX_TERMINAL_DEGRADATION_ID_CHARS,
			),
			source_lane_id: boundTerminalText(
				redactTerminalCleanLiteral(degradation.source_lane_id),
				MAX_TERMINAL_DEGRADATION_ID_CHARS,
			),
			// Bound AFTER redaction: CLEAN -> clean-attestation expands 5 -> 16
			// chars, so slicing first let the rendered value exceed the cap.
			reason: boundTerminalText(
				redactTerminalCleanLiteral(degradation.reason),
				MAX_TERMINAL_DEGRADATION_REASON_CHARS,
			),
		}));
}

/** Observation-only echo (same guard pattern as the sibling readers above). */
async function coverageDegradationsForReportSafe(
	directory: string,
	sessionID: string,
): Promise<
	Array<{
		trigger_id: string;
		source_batch_id: string;
		source_lane_id: string;
		reason: string;
	}>
> {
	try {
		return await coverageDegradationsForReport(directory, sessionID);
	} catch {
		return [];
	}
}
