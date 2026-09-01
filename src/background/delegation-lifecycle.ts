/**
 * Shared Task/lane delegation lifecycle operations (issue #2045).
 *
 * Task-tool delegations and `dispatch_lanes` lanes both persist their state in
 * the background-delegations ledger and both record their start through
 * `recordPendingDelegationDetailed`; before issue #2045 only the Task side
 * settled terminals through `claimTerminalResult`, leaving lanes with the
 * weaker status-only `appendDelegationTransition` write. This module is the
 * single shared settle operation both transports converge on: it wraps the
 * existing exactly-once terminal claim (no second lifecycle implementation)
 * and emits the terminal observations the Task side already produces through
 * its `tool.execute.*` hooks — cost telemetry, trajectory, and knowledge
 * receipt reconciliation — so equivalent Task and lane dispatches leave
 * equivalent lifecycle facts behind.
 *
 * Every observation is fail-open and split into two durability classes — see
 * the `settleDelegationTerminal` docstring for the contract: AUTHORITATIVE
 * ledger-committed receipts re-run on `duplicate` replays (crash recovery),
 * while DIAGNOSTIC observations run only on `claimed` (exactly-once-at-emit).
 */

import { createHash } from 'node:crypto';
import { collectLaneDelegateAcks } from '../hooks/delegate-ack-collector.js';
import { readPhaseDirectivesToVerify } from '../hooks/phase-directives.js';
import { reconcileReviewerVerdicts } from '../hooks/reviewer-verdict-parser.js';
import {
	nextTrajectoryStep,
	seedTrajectoryStepCounter,
} from '../hooks/trajectory-step-state.js';
import {
	appendTrajectoryEntry,
	getCurrentStep,
} from '../prm/trajectory-store.js';
import type { TrajectoryEntry } from '../prm/types.js';
import {
	buildDelegationCostFields,
	type PricingConfig,
} from '../services/cost-accounting.js';
import { telemetry } from '../telemetry.js';
import * as logger from '../utils/logger.js';
import {
	type BackgroundDelegationRecord,
	type BackgroundDelegationResult,
	type BackgroundTerminalResult,
	buildBackgroundCompletionEventId,
	claimTerminalResult,
	findByCorrelationId,
	isTerminalDelegationStatus,
	readDelegations,
} from './pending-delegations.js';

/** Terminal statuses a shared settle may establish (mirrors Task semantics). */
export type DelegationTerminalStatus = 'completed' | 'error' | 'cancelled';

/**
 * Why `settleDelegationTerminal` returned without a fresh claim.
 *
 * `already_terminal_without_event` is deliberately distinct from `conflict`:
 * a record terminalized WITHOUT an immutable event (the 30-minute stale sweep
 * or a legacy status-only writer won the race) is a benign outcome that must
 * not tick the late-terminal audit — the audit belongs to the writer that
 * owns the conflicting *event*, and there is none.
 */
export type DelegationSettleKind =
	| 'claimed'
	| 'duplicate'
	| 'conflict'
	| 'already_terminal_without_event'
	| 'not_open'
	| 'missing'
	| 'failed';

export interface DelegationSettleOutcome {
	kind: DelegationSettleKind;
	record?: BackgroundDelegationRecord;
}

/**
 * Settle outcomes that mean "the work item is already durably terminal; the
 * caller's benign already-terminal handling applies" (no retry, no failure
 * diagnostic — the race was routine).
 */
export function isBenignSettleOutcome(kind: DelegationSettleKind): boolean {
	return (
		kind === 'duplicate' ||
		kind === 'conflict' ||
		kind === 'already_terminal_without_event'
	);
}

export interface DelegationTerminalInput {
	status: DelegationTerminalStatus;
	result: BackgroundDelegationResult;
}

export interface DelegationObservationInput {
	/** Full lane/delegate transcript text; drives knowledge reconciliation. */
	transcript?: string;
	/** Raw cost-evidence source (assistant info/metadata), when available. */
	costRaw?: unknown;
	/** Configured model for cost projection fallback. */
	model?: string;
	/** Pricing config for normalized cost estimation. */
	pricing?: PricingConfig;
	/** Wall-clock dispatch start (ms epoch), for trajectory elapsed_ms. */
	startedAt?: number;
}

/**
 * Build the immutable terminal event for a delegation record. The eventId is
 * derived from trusted correlation + immutable result metadata (no timestamps,
 * no process state), so a replayed observation of the same result claims
 * idempotently and a different result is a distinct, auditable event.
 */
export function buildDelegationTerminal(
	record: Pick<BackgroundDelegationRecord, 'correlationId' | 'jobId'>,
	terminal: DelegationTerminalInput,
	now: number,
): BackgroundTerminalResult {
	return {
		eventId: buildBackgroundCompletionEventId({
			correlationId: record.correlationId,
			jobId: record.jobId,
			status: terminal.status,
			resultDigest: terminal.result.digest,
		}),
		status: terminal.status,
		recordedAt: now,
		result: terminal.result,
	};
}

/**
 * Settle a delegation terminal exactly once through the shared claim, then —
 * only on a fresh `claimed` disposition — run the terminal observations.
 *
 * Durability model (final-critic challenge, crash between claim and
 * observations):
 * - The AUTHORITATIVE receipts (validator/ledger-committed delegate ACK
 *   terminals, unacknowledged-critical violations, and reviewer verdicts) are
 *   re-run on `duplicate` replays: the receipt ledger's terminal authority is
 *   idempotent (same-outcome replays are `idempotent_skips`), so a replay
 *   after a crash closes the receipts exactly once — a lane whose observation
 *   pass died mid-flight recovers on any later settle replay (restart,
 *   concurrent collector).
 * - The DIAGNOSTIC observations are exactly-once-at-emit on `claimed` only —
 *   they have no deduplicating sink, and re-emitting them on replay would
 *   duplicate records. This covers cost telemetry, trajectory, AND the
 *   audit-only non-critical `unacknowledged` knowledge observation (which
 *   bypasses the receipt ledger). It is the same crash window the Task
 *   transport's `tool.execute.*` hook emissions have always had (documented
 *   transport parity, not a regression).
 *
 * See {@link DelegationSettleKind} for the non-claim outcomes; callers map
 * `duplicate`/`conflict`/`already_terminal_without_event` to their benign
 * already-terminal handling and `missing`/`not_open`/`failed` to their
 * settle-failure diagnostics.
 */
export async function settleDelegationTerminal(
	directory: string,
	record: BackgroundDelegationRecord,
	terminal: DelegationTerminalInput,
	observations: DelegationObservationInput = {},
	now: number = Date.now(),
): Promise<DelegationSettleOutcome> {
	const claim = await _internals.claimTerminalResult(
		directory,
		record.correlationId,
		buildDelegationTerminal(record, terminal, now),
	);
	if (claim) {
		if (claim.disposition === 'claimed') {
			await runDelegationTerminalObservations(
				directory,
				claim.record,
				terminal,
				observations,
				now,
			);
			return { kind: 'claimed', record: claim.record };
		}
		// duplicate | resume_settlement | retry_ingestion | preserved | consumed —
		// the terminal already exists. Replay the AUTHORITATIVE knowledge
		// reconciliation only (ledger-idempotent, crash-recovery path); never the
		// exactly-once-at-emit diagnostics — including the audit-only
		// non-critical `unacknowledged` observation, which bypasses the ledger
		// and would double-append on replay.
		if (claim.disposition === 'duplicate' && observations.transcript) {
			await reconcileLaneKnowledgeReceipts(
				directory,
				claim.record,
				observations,
				true,
			);
		}
		return { kind: 'duplicate', record: claim.record };
	}
	// claimTerminalResult returns null for four distinct cases: unparseable
	// terminal, unreadable store, missing record, or a record whose status is
	// not open (terminal WITHOUT an event, or an event conflict it already
	// audited). Re-read to classify; the fresh read is the truth.
	// Edge note: a re-read of a `consumed` record (Task-only post-terminal
	// machinery) would classify a replay as `conflict` rather than `duplicate`;
	// lane records never reach `consumed`, and the claim-side duplicate check
	// (terminalResult identity) fires first in every reachable lane path.
	const reread = _internals.findByCorrelationId(
		directory,
		record.correlationId,
	);
	if (!reread) return { kind: 'missing' };
	if (isTerminalDelegationStatus(reread.status)) {
		if (reread.terminalResult) return { kind: 'conflict', record: reread };
		return { kind: 'already_terminal_without_event', record: reread };
	}
	return { kind: 'not_open', record: reread };
}

/**
 * Emit the `delegation_begin` pairing observation when a lane/delegation start
 * record lands (issue #2045 Task/lane cost-event parity). Best-effort.
 */
export function emitDelegationBegin(
	record: Pick<
		BackgroundDelegationRecord,
		'parentSessionId' | 'swarmPrefixedAgent' | 'planTaskId'
	>,
): void {
	try {
		_internals.telemetry.delegationBegin(
			record.parentSessionId,
			record.swarmPrefixedAgent,
			record.planTaskId ?? '',
		);
	} catch {
		// fail-open — observation only
	}
}

/**
 * Canonical cost-record identity material for a lane/delegation terminal.
 * Joining back to the delegation record uses exactly these record fields —
 * never agent-name matching. The `lane:` discriminator keeps lane identities
 * disjoint from Task-tool records, whose material is `${sessionId}\0${callID}`.
 */
export function delegationCostRecordMaterial(
	record: Pick<
		BackgroundDelegationRecord,
		'parentSessionId' | 'callID' | 'laneId'
	>,
): string {
	if (!record.laneId) {
		throw new Error(
			'delegation cost identity requires a laneId (all lane records set one)',
		);
	}
	return `${record.parentSessionId}\0${record.callID}\0lane:${record.laneId}`;
}

/** Emit the `delegation_end` cost observation for a claimed lane terminal. */
function emitDelegationCostObservation(
	record: BackgroundDelegationRecord,
	observations: DelegationObservationInput,
	terminalStatus: DelegationTerminalStatus,
): void {
	try {
		const material = delegationCostRecordMaterial(record);
		const costFields = buildDelegationCostFields({
			raw: observations.costRaw,
			model: observations.model,
			pricing: observations.pricing,
		});
		costFields.record_id = createHash('sha256')
			.update(`delegation-cost-id-v1\0${material}`)
			.digest('hex')
			.slice(0, 32);
		costFields.identity_fingerprint = createHash('sha256')
			.update(
				`delegation-cost-identity-v1\0${material}\0${record.swarmPrefixedAgent}\0${observations.model ?? ''}`,
			)
			.digest('hex')
			.slice(0, 32);
		costFields.version = 1;
		costFields.parent_session_digest = createHash('sha256')
			.update(`delegation-cost-parent-v1\0${record.parentSessionId}`)
			.digest('hex')
			.slice(0, 32);
		costFields.child_session_digest = createHash('sha256')
			.update(`delegation-cost-child-v1\0${record.subagentSessionId}`)
			.digest('hex')
			.slice(0, 32);
		_internals.telemetry.delegationEnd(
			record.parentSessionId,
			record.swarmPrefixedAgent,
			record.planTaskId ?? '',
			terminalStatus,
			costFields,
		);
	} catch (error) {
		logger.log(
			`[delegation-lifecycle] cost observation skipped: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
}

/** Append the trajectory observation for a claimed lane terminal. */
async function appendDelegationTrajectoryObservation(
	directory: string,
	record: BackgroundDelegationRecord,
	terminalStatus: DelegationTerminalStatus,
	observations: DelegationObservationInput,
	now: number,
): Promise<void> {
	try {
		// Seed from the persisted high-water mark so steps stay monotonic with
		// any existing trajectory for this parent session (issue #2041 pattern).
		const lastStep = await getCurrentStep(record.parentSessionId, directory);
		seedTrajectoryStepCounter(record.parentSessionId, directory, lastStep);
		const entry: TrajectoryEntry = {
			step: nextTrajectoryStep(record.parentSessionId, directory),
			agent: record.swarmPrefixedAgent,
			action: 'delegate',
			target: record.laneId ?? record.correlationId,
			intent: `dispatch_lanes terminal ${terminalStatus}`,
			timestamp: new Date(now).toISOString(),
			result: terminalStatus === 'completed' ? 'success' : 'failure',
			tool: 'dispatch_lanes',
			...(observations.startedAt !== undefined
				? { elapsed_ms: Math.max(0, now - observations.startedAt) }
				: {}),
			// Canonical join keys (issue #2045: no heuristic name matching).
			...(record.batchId !== undefined ? { batchId: record.batchId } : {}),
			laneId: record.laneId ?? record.correlationId,
			...(record.planTaskId ? { taskId: record.planTaskId } : {}),
		};
		await appendTrajectoryEntry(record.parentSessionId, entry, directory);
	} catch {
		// fail-open — observation only
	}
}

/**
 * Reconcile knowledge receipts for a claimed lane terminal: ACK markers in the
 * transcript against the directives actually shown to the lane session
 * (receipt-ledger memberships bound to the subagent session), plus — for
 * reviewer-role lanes — per-directive compliance adjudication.
 *
 * `replay: true` (the duplicate-settle crash-recovery path) keeps the
 * ledger-committed receipts closing while suppressing the audit-only
 * non-critical `unacknowledged` observation, which bypasses the ledger and
 * must stay exactly-once-at-emit.
 */
async function reconcileLaneKnowledgeReceipts(
	directory: string,
	record: BackgroundDelegationRecord,
	observations: DelegationObservationInput,
	replay = false,
): Promise<void> {
	if (!observations.transcript) return;
	try {
		const ack = await collectLaneDelegateAcks({
			directory,
			// Memberships bind to the SUBAGENT (lane) session — the transform-path
			// injector commits with the child session id, so the query key must be
			// the child id, never the parent's.
			sessionId: record.subagentSessionId,
			agent: record.swarmPrefixedAgent,
			transcript: observations.transcript,
			replay,
		});
		if (record.normalizedAgent !== 'reviewer') return;
		const phase = ack.phases.find((value) => Boolean(value));
		if (!phase) return;
		const directivesToVerify = await readPhaseDirectivesToVerify(
			directory,
			phase,
		);
		if (directivesToVerify.length === 0) return;
		await reconcileReviewerVerdicts({
			directory,
			transcript: observations.transcript,
			directivesToVerify,
			sessionId: record.subagentSessionId,
			agent: 'reviewer',
		});
	} catch {
		// fail-open — reconciliation must never break the settle path
	}
}

async function runDelegationTerminalObservations(
	directory: string,
	record: BackgroundDelegationRecord,
	terminal: DelegationTerminalInput,
	observations: DelegationObservationInput,
	now: number,
): Promise<void> {
	emitDelegationCostObservation(record, observations, terminal.status);
	await appendDelegationTrajectoryObservation(
		directory,
		record,
		terminal.status,
		observations,
		now,
	);
	await reconcileLaneKnowledgeReceipts(directory, record, observations);
}

/** Bounded per-pass cap for terminal-lane receipt recovery (crash window). */
export const MAX_TERMINAL_LANE_RECEIPT_RECOVERY = 64;

/** A terminal lane record whose durable transcript can still reconcile receipts. */
function isRecoverableTerminalLaneRecord(
	record: BackgroundDelegationRecord,
): boolean {
	return Boolean(
		record.laneId &&
			record.terminalResult &&
			typeof record.terminalResult.result.text === 'string' &&
			record.terminalResult.result.text.length > 0,
	);
}

export interface TerminalLaneReceiptRecoveryResult {
	/** Terminal lane records whose receipt reconciliation replay was attempted. */
	recovered: number;
}

/**
 * Durable crash-recovery pass for terminal lane records (final-critic
 * challenge): a lane whose terminal claim landed but whose observation pass
 * died is TERMINAL, so the collector's active-record filter skips it forever —
 * the duplicate-replay path in {@link settleDelegationTerminal} would never be
 * entered again on its own. This pass re-enters it: the durable transcript
 * (`terminalResult.result.text`, persisted by the claim) is replayed through
 * the ledger-idempotent receipt reconciliation in replay mode — authoritative
 * receipts close exactly once; diagnostics never re-emit.
 *
 * Production wiring: (a) `collect_lane_results` runs it once per invocation
 * over the batch's terminal records (the async-lane restart path), and (b) the
 * session-close maintenance trigger runs it directory-wide, bounded
 * (`MAX_TERMINAL_LANE_RECEIPT_RECOVERY`), which is what recovers BLOCKING lane
 * records that have no collector. Fail-open per record; never throws.
 */
export async function recoverTerminalLaneReceipts(
	directory: string,
	records?: readonly BackgroundDelegationRecord[],
): Promise<TerminalLaneReceiptRecoveryResult> {
	const candidates = (records ?? readDelegations(directory)).filter(
		isRecoverableTerminalLaneRecord,
	);
	let recovered = 0;
	for (const record of candidates.slice(
		0,
		MAX_TERMINAL_LANE_RECEIPT_RECOVERY,
	)) {
		const transcript = record.terminalResult?.result.text;
		if (!transcript) continue;
		try {
			await reconcileLaneKnowledgeReceipts(
				directory,
				record,
				{ transcript },
				true,
			);
			recovered += 1;
		} catch {
			// fail-open per record — one bad record never blocks the rest
		}
	}
	return { recovered };
}

/**
 * Test seam (repo convention): the telemetry sink and the claim are injectable
 * so tests can stub them without `mock.module`.
 */
export const _internals = {
	claimTerminalResult,
	findByCorrelationId,
	telemetry,
};
