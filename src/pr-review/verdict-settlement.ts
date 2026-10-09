import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import {
	type BackgroundDelegationRecord,
	findByBatchIdDetailed,
} from '../background/pending-delegations.js';
import { writeAtomicJson } from './persistence.js';

/**
 * N-of-M truthful verdict settlement (issue #3101).
 *
 * When a reviewer/critic verdict lane is liveness-dead and the bounded retry
 * budget for its items is exhausted, the settlement may settle truthfully
 * over the surviving items instead of blocking the whole run — under four
 * conjunctive, non-negotiable constraints (the issue's validated design):
 *
 * 1. terminality evidence only — the trigger is the controller-written typed
 *    liveness class on the durable delegation record (never lane self-report,
 *    never mere absence/silence);
 * 2. silence blocks — an unclaimed item with an EMPTY owner set keeps
 *    blocking (subset batch declarations and capacity-GC pruning make empty
 *    owner sets reachable; absence of declarations is not evidence);
 * 3. downgrade-only — the verdict matrix constrains the report to
 *    REQUEST_CHANGES/INCOMPLETE via the existing DEGRADED_DISCLOSED channel
 *    (never APPROVE, never synthesized verdicts);
 * 4. per-item disclosure — an immutable receipt under
 *    `.swarm/pr-review/<runId>/verdict-settlement.<phase>.json` carries one
 *    structured (lane, disposition, evidence class) row per settled item.
 *
 * This module deliberately mirrors the discovery-phase dead-family admission
 * (`write-pr-review-trigger-eval.ts` + `PR_REVIEW_MICRO_FAMILY_RETRY_BUDGET`)
 * rather than generalizing `bound_fallback`: a verdict artifact is the FIRST
 * write of its fact, so disclose-and-proceed there would trust silence.
 */

/** Sibling of `PR_REVIEW_MICRO_FAMILY_RETRY_BUDGET` (micro discovery families). */
export const PR_REVIEW_VERDICT_RETRY_BUDGET = 2;

export const VERDICT_SETTLEMENT_SCHEMA_VERSION = 1;

/** Bounded receipt read: per-item rows are small, but a wide dead set must
 * still never produce an unbounded blocking read. 64 KiB ≈ hundreds of rows. */
const VERDICT_SETTLEMENT_MAX_RECEIPT_BYTES = 65_536;

export const PrReviewVerdictSettlementPhaseSchema = z.enum([
	'reviewer',
	'critic',
]);
export type PrReviewVerdictSettlementPhase = z.infer<
	typeof PrReviewVerdictSettlementPhaseSchema
>;

export const PrReviewVerdictSettlementItemSchema = z
	.object({
		itemId: z.string().trim().min(1),
		sourceBatchId: z.string().trim().min(1),
		sourceLaneId: z.string().trim().min(1),
		disposition: z.literal('liveness_dead'),
		evidenceClass: z.literal('liveness'),
		terminalStatus: z.enum(['stale', 'cancelled', 'error']),
	})
	.strict();
export type PrReviewVerdictSettlementItem = z.infer<
	typeof PrReviewVerdictSettlementItemSchema
>;

export const PrReviewVerdictSettlementReceiptSchema = z
	.object({
		schemaVersion: z.literal(VERDICT_SETTLEMENT_SCHEMA_VERSION),
		runId: z.string().trim().min(1),
		prHeadSha: z.string().trim().min(1),
		revisionDigest: z.string().trim().min(1),
		phase: PrReviewVerdictSettlementPhaseSchema,
		items: z.array(PrReviewVerdictSettlementItemSchema).min(1),
	})
	.strict();
export type PrReviewVerdictSettlementReceipt = z.infer<
	typeof PrReviewVerdictSettlementReceiptSchema
>;

/** Phase-qualified receipt path (dual-death runs carry one receipt per phase). */
export function verdictSettlementRelativePath(
	runId: string,
	phase: PrReviewVerdictSettlementPhase,
): string {
	return path.join('pr-review', runId, `verdict-settlement.${phase}.json`);
}

/**
 * Mirrors `isLivenessTerminalLaneRecord` (pr-workflow-gate.ts, issue #2585
 * AC13) without importing the gate (which imports this module). Record-state
 * gated only — never time-based. Keep the two predicates in sync; the parity
 * is pinned by tests/unit/pr-review/n-of-m-verdict-settlement.test.ts.
 */
function isLivenessTerminalLaneRecord(
	record: BackgroundDelegationRecord,
): boolean {
	if (
		record.status !== 'cancelled' &&
		record.status !== 'stale' &&
		record.status !== 'error'
	) {
		return false;
	}
	return (
		record.terminalResult?.result.workflowLaneFailureClass === 'liveness' ||
		record.result?.workflowLaneFailureClass === 'liveness'
	);
}

/** Structural slice of `PrReviewValidationBatchRecord` this module consumes. */
export interface VerdictSettlementWindowBatch {
	batchId: string;
	lanes: ReadonlyArray<{
		laneId: string;
		workflowLane: string;
		reviewItemIds?: readonly string[];
	}>;
}

export interface VerdictSettlementAdmission {
	admitted: boolean;
	/** Human-readable, non-admitting reason (also embedded in BLOCKED guidance). */
	reason: string;
	items: PrReviewVerdictSettlementItem[];
}

/**
 * The admissibility predicate (constraint 1 + 2 + the budget arm).
 *
 * `attempts` counts the distinct window batches that declared ANY lane owning
 * at least one unclaimed item (per-item-family counting mirroring
 * `countFamilyDispatchAttempts`, not a raw phase-level batch count), and the
 * latest such batch must be among them (cited-batch conjunction). Uncertain
 * delegation-store reads fail closed (settlement keeps blocking).
 */
export function deriveVerdictSettlementAdmission(args: {
	directory: string;
	prHeadSha: string;
	phase: PrReviewVerdictSettlementPhase;
	/** The phase window batches composition scans (`prReviewPhaseWindow`). */
	window: readonly VerdictSettlementWindowBatch[];
	unclaimed: readonly string[];
}): VerdictSettlementAdmission {
	const { directory, prHeadSha, phase, window, unclaimed } = args;
	if (unclaimed.length === 0) {
		return {
			admitted: false,
			reason: 'no unclaimed items',
			items: [],
		};
	}
	const expectedMode = `swarm-pr-review:${phase}`;
	const items: PrReviewVerdictSettlementItem[] = [];
	const attemptBatchIds = new Set<string>();
	for (const itemId of unclaimed) {
		// Owner set = declared lanes in the window whose reviewItemIds contain
		// the item. Empty owner set keeps blocking (constraint 2).
		const owners = window.flatMap((batch) =>
			batch.lanes
				.filter((lane) => (lane.reviewItemIds ?? []).includes(itemId))
				.map((lane) => ({ batch, lane })),
		);
		if (owners.length === 0) {
			return {
				admitted: false,
				reason: `item ${itemId} has no declared owner lane in the phase window (absence is not terminality evidence)`,
				items: [],
			};
		}
		const dead: Array<{
			batchId: string;
			laneId: string;
			status: 'stale' | 'cancelled' | 'error';
		}> = [];
		for (const { batch, lane } of owners) {
			attemptBatchIds.add(batch.batchId);
			// Decision-time re-read with an exact identity conjunction (the
			// #3094 TOCTOU discipline). Uncertain reads fail closed.
			const read = findByBatchIdDetailed(directory, batch.batchId);
			if (read.status === 'uncertain') {
				return {
					admitted: false,
					reason: `delegation store read was uncertain for batch ${batch.batchId}`,
					items: [],
				};
			}
			const record = read.value.find(
				(candidate: BackgroundDelegationRecord) =>
					candidate.batchId === batch.batchId &&
					candidate.laneId === lane.laneId &&
					candidate.mode === expectedMode &&
					candidate.workspace?.prHeadSha === prHeadSha,
			);
			if (!record || !isLivenessTerminalLaneRecord(record)) {
				return {
					admitted: false,
					reason: `item ${itemId} still has a non-liveness-terminal owner lane ${lane.laneId}`,
					items: [],
				};
			}
			dead.push({
				batchId: batch.batchId,
				laneId: lane.laneId,
				status:
					record.status === 'cancelled' || record.status === 'error'
						? record.status
						: 'stale',
			});
		}
		const first = dead[0]!;
		items.push({
			itemId,
			sourceBatchId: first.batchId,
			sourceLaneId: first.laneId,
			disposition: 'liveness_dead',
			evidenceClass: 'liveness',
			terminalStatus: first.status,
		});
	}
	// Budget arm: every unclaimed item's owner batches count as attempts;
	// exhaustion = attempts >= 1 + budget. A budget exhausted by lanes that
	// are not provably dead never reaches this line (the liveness conjunct
	// above already refused).
	if (attemptBatchIds.size < 1 + PR_REVIEW_VERDICT_RETRY_BUDGET) {
		return {
			admitted: false,
			reason: `verdict retry budget not exhausted (${attemptBatchIds.size} of ${1 + PR_REVIEW_VERDICT_RETRY_BUDGET} required attempts)`,
			items: [],
		};
	}
	return { admitted: true, reason: 'admitted', items };
}

export function buildVerdictSettlementReceipt(args: {
	runId: string;
	prHeadSha: string;
	revisionDigest: string;
	phase: PrReviewVerdictSettlementPhase;
	items: readonly PrReviewVerdictSettlementItem[];
}): PrReviewVerdictSettlementReceipt {
	return {
		schemaVersion: VERDICT_SETTLEMENT_SCHEMA_VERSION,
		runId: args.runId,
		prHeadSha: args.prHeadSha,
		revisionDigest: args.revisionDigest,
		phase: args.phase,
		items: [...args.items],
	};
}

export async function persistVerdictSettlementReceipt(
	directory: string,
	receipt: PrReviewVerdictSettlementReceipt,
): Promise<void> {
	const absolute = path.join(
		directory,
		'.swarm',
		verdictSettlementRelativePath(receipt.runId, receipt.phase),
	);
	await writeAtomicJson(directory, absolute, receipt);
}

export type VerdictSettlementReceiptRead =
	| { status: 'ok'; receipt: PrReviewVerdictSettlementReceipt }
	| { status: 'absent' }
	| { status: 'invalid'; reason: string };

export function readVerdictSettlementReceipt(
	directory: string,
	runId: string,
	phase: PrReviewVerdictSettlementPhase,
): VerdictSettlementReceiptRead {
	const relative = verdictSettlementRelativePath(runId, phase);
	const absolute = path.join(directory, '.swarm', relative);
	let raw: string;
	try {
		const stat = readFileSync(absolute, 'utf-8');
		if (stat.length > VERDICT_SETTLEMENT_MAX_RECEIPT_BYTES) {
			return { status: 'invalid', reason: 'receipt exceeds size bound' };
		}
		raw = stat;
	} catch {
		return { status: 'absent' };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { status: 'invalid', reason: 'receipt is not valid JSON' };
	}
	const validated = PrReviewVerdictSettlementReceiptSchema.safeParse(parsed);
	if (!validated.success) {
		return { status: 'invalid', reason: 'receipt fails schema validation' };
	}
	return { status: 'ok', receipt: validated.data };
}

/**
 * The single shared effective-set helper every consumer uses (constraint 4 +
 * receipt re-verification): the receipt is immutable, but the EFFECTIVE
 * disclosed set is `receipt.items ∩ currentUnclaimed`. An item claimed after
 * the receipt was written drops out; an empty effective set exerts no
 * constraint (no degradation flag, no exemptions).
 */
export function effectiveVerdictSettlementItems(
	receipt: PrReviewVerdictSettlementReceipt | undefined,
	currentUnclaimed: readonly string[],
): PrReviewVerdictSettlementItem[] {
	if (!receipt || currentUnclaimed.length === 0) return [];
	const unclaimed = new Set(currentUnclaimed);
	return receipt.items.filter((item) => unclaimed.has(item.itemId));
}

/**
 * Whether an admitted N-of-M verdict settlement currently downgrades the
 * verdict matrix (the DEGRADED_DISCLOSED channel): true when either phase's
 * receipt identity-verifies AND its EFFECTIVE set (receipt ∩ current
 * unclaimed) is non-empty. An empty effective set exerts no constraint.
 */
export function verdictSettlementDegradationActive(args: {
	directory: string;
	runId: string | undefined;
	prHeadSha: string | undefined;
	reviewerUnclaimed: readonly string[];
	criticUnclaimed: readonly string[];
}): boolean {
	const { directory, runId, prHeadSha } = args;
	if (!runId || !prHeadSha) return false;
	const phases = [
		{ phase: 'reviewer' as const, unclaimed: args.reviewerUnclaimed },
		{ phase: 'critic' as const, unclaimed: args.criticUnclaimed },
	];
	for (const { phase, unclaimed } of phases) {
		if (unclaimed.length === 0) continue;
		const read = readVerdictSettlementReceipt(directory, runId, phase);
		if (read.status !== 'ok' || read.receipt.prHeadSha !== prHeadSha) {
			continue;
		}
		if (effectiveVerdictSettlementItems(read.receipt, unclaimed).length > 0) {
			return true;
		}
	}
	return false;
}

export const _internals = {
	findByBatchIdDetailed,
	isLivenessTerminalLaneRecord,
};
