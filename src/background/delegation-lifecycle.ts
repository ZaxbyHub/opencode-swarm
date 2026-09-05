/**
 * Shared Task/lane delegation lifecycle operations (issue #2045).
 *
 * Task-tool delegations and `dispatch_lanes` lanes both persist their state in
 * the background-delegations ledger and both record their start through
 * `recordPendingDelegationDetailed`; before issue #2045 only the Task side
 * settled terminals through `claimTerminalResult`, leaving lanes with the
 * weaker status-only `appendDelegationTransition` write. This module gives
 * lanes the same exactly-once terminal semantics — `settleDelegationTerminal`
 * wraps the SAME `claimTerminalResult` primitive the Task completion observer
 * calls directly (one claim implementation, no second lifecycle state machine)
 * — and emits the lane-side terminal observations the Task side produces
 * through its `tool.execute.*` hooks (cost telemetry, trajectory, knowledge
 * receipt reconciliation), so equivalent Task and lane dispatches leave
 * equivalent lifecycle facts behind.
 *
 * Every observation is fail-open and split into two durability classes — see
 * the `settleDelegationTerminal` docstring for the contract: AUTHORITATIVE
 * ledger-committed receipts re-run on `duplicate` replays (crash recovery),
 * while DIAGNOSTIC observations run only on `claimed` (exactly-once-at-emit).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
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
import { buildDelegationTerminalIdentityFields } from './delegation-cost-identity.js';
import {
	type BackgroundDelegationRecord,
	type BackgroundDelegationResult,
	type BackgroundTerminalResult,
	buildBackgroundCompletionEventId,
	claimTerminalResult,
	findByCorrelationId,
	isTerminalDelegationStatus,
	readDelegations,
	registerStaleSweepObserver,
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
	| 'missing';

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
 * already-terminal handling and `missing`/`not_open` to their
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
		// #2482 / #2244: the record reached a terminal status WITHOUT the
		// claim path ever emitting the terminal event — by definition no
		// `delegation_end` exists for its begin. Emit the exactly-once
		// recovered end so the delegation pair completes. (A `conflict` above
		// has a terminalResult — the original claimer's emission stands.)
		emitDelegationEventlessTerminalEnd(reread, reread.status);
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
 * Canonical cost-record identity material for a lane/delegation terminal —
 * re-exported from the leaf module `delegation-cost-identity.ts` (issue
 * #2482) so `pending-delegations.ts` (imported by this module) can construct
 * the exact same identity for its stale-sweep terminal emissions without an
 * import cycle. Records WITH a `laneId` (lane records) use the `lane:`
 * discriminator; records WITHOUT one (Task-tool delegations) use the
 * pre-documented Task shape `${sessionId}\0${callID}` (the same material the
 * foreground Task handoff hashes). Hash inputs stay distinct, so lane and
 * Task ids can never collide even for a shared (sessionId, callID) pair.
 */
export { delegationCostRecordMaterial } from './delegation-cost-identity.js';

/** Durable record fields the terminal emitters need (record-attributed). */
type TerminalEmitRecord = Pick<
	BackgroundDelegationRecord,
	| 'parentSessionId'
	| 'swarmPrefixedAgent'
	| 'planTaskId'
	| 'callID'
	| 'laneId'
	| 'subagentSessionId'
>;

/**
 * Emit the `delegation_end` cost observation for a claimed lane terminal.
 * `terminalStatus` is the durable record's terminal status string (may be a
 * sweep status like `stale`, which the narrow `DelegationTerminalStatus` input
 * union does not name).
 */
function emitDelegationCostObservation(
	record: TerminalEmitRecord,
	observations: DelegationObservationInput,
	terminalStatus: string,
	recovered = false,
): void {
	try {
		const costFields = buildDelegationCostFields({
			raw: observations.costRaw,
			model: observations.model,
			pricing: observations.pricing,
		});
		Object.assign(
			costFields,
			buildDelegationTerminalIdentityFields({
				record,
				model: observations.model,
				recovered,
			}),
		);
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

/**
 * Emit the exactly-once `delegation_end` pairing observation for an
 * EVENTLESS terminal (issue #2482 / #2244): a durable record that reached a
 * terminal status without the claim path ever emitting the terminal event —
 * the `already_terminal_without_event` settle outcome and the stale sweep.
 * Attribution and pairing identity come from the durable record (correct
 * across restarts; never the in-memory parent-session map), and the
 * deterministic `record_id` keeps cost rollups deduped. `recovered: true`
 * marks these ends in the payload. `duplicate`/`conflict` outcomes must NOT
 * call this — the original claimer's emission stands (exactly-once-at-emit).
 */
export function emitDelegationEventlessTerminalEnd(
	record: TerminalEmitRecord,
	terminalStatus: string,
): void {
	emitDelegationCostObservation(record, {}, terminalStatus, true);
}

// #2482: wire the stale sweep's recovered-end emission through this module so
// both halves of the delegation pair live beside each other (the sweep runs
// under the pending-delegations store lock and calls this observer
// fail-open). Registration is a single assignment — no I/O; production always
// loads this module (dispatch lanes, completion observer, plugin init).
registerStaleSweepObserver((record) => {
	emitDelegationEventlessTerminalEnd(record, 'stale');
});

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

/**
 * Pre-record admission deadline for the directory-wide recovery pass
 * (session-close hook): checked before EACH reconciliation, bounding how many
 * records a pass may START — not the enumeration read/sort or an
 * already-started reconciliation.
 */
export const TERMINAL_LANE_RECEIPT_RECOVERY_DEADLINE_MS = 5_000;

const RECOVERY_CURSOR_FILE = 'lane-receipt-recovery-cursor.json';

interface RecoveryCursor {
	/** Ordering key of the last processed record (fold `updatedAt`). */
	updatedAt: number;
	correlationId: string;
}

function candidateAfter(
	record: BackgroundDelegationRecord,
	cursor: RecoveryCursor,
): boolean {
	if (record.updatedAt !== cursor.updatedAt) {
		return record.updatedAt > cursor.updatedAt;
	}
	return record.correlationId > cursor.correlationId;
}

function readRecoveryCursor(directory: string): RecoveryCursor | null {
	try {
		const filePath = path.join(directory, '.swarm', RECOVERY_CURSOR_FILE);
		if (!fs.existsSync(filePath)) return null;
		const parsed = JSON.parse(
			fs.readFileSync(filePath, 'utf-8'),
		) as Partial<RecoveryCursor>;
		if (
			typeof parsed.updatedAt === 'number' &&
			Number.isFinite(parsed.updatedAt) &&
			typeof parsed.correlationId === 'string' &&
			parsed.correlationId.length > 0
		) {
			return {
				updatedAt: parsed.updatedAt,
				correlationId: parsed.correlationId,
			};
		}
		return null;
	} catch {
		return null;
	}
}

/** Best-effort cursor persistence; a lost cursor only causes idempotent rework. */
function writeRecoveryCursor(
	directory: string,
	cursor: RecoveryCursor | null,
): void {
	try {
		const swarmDir = path.join(directory, '.swarm');
		fs.mkdirSync(swarmDir, { recursive: true });
		const filePath = path.join(swarmDir, RECOVERY_CURSOR_FILE);
		if (cursor === null) {
			fs.rmSync(filePath, { force: true });
		} else {
			fs.writeFileSync(filePath, JSON.stringify(cursor), 'utf-8');
		}
	} catch {
		// fail-open — recovery stays correct without the cursor
	}
}

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
	/** True when the pass ended before every candidate was attempted. */
	exhaustedBudget: boolean;
}

export interface RecoverTerminalLaneReceiptsOptions {
	/**
	 * Admission budget for STARTING a reconciliation. Default 5s; the pass
	 * stops cleanly before the next record when exhausted. Does not bound the
	 * enumeration or an in-flight reconciliation.
	 */
	deadlineMs?: number;
	/** Test seam for the clock. */
	now?: () => number;
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
 * over the batch's terminal records (the async-lane restart path — a batch is
 * at most MAX_LANES records, so batch mode needs no cursor), and (b) the
 * session-close maintenance trigger runs it directory-wide, which is what
 * recovers BLOCKING lane records that have no collector.
 *
 * Forward progress (final-critic round 3): the directory-wide pass is bounded
 * by a record cap and a pre-record admission deadline (checked before EACH
 * reconciliation; it does not bound the candidate enumeration read/sort or an
 * already-started reconciliation — those are bounded by the ledger read and
 * the cap), and it persists an advancing
 * cursor (`.swarm/lane-receipt-recovery-cursor.json`, ordered by
 * `(updatedAt, correlationId)`), so each pass resumes after the last processed
 * record and wraps to the oldest once the end is reached. Guarantees, stated
 * exactly: under steady arrivals a candidate whose terminal commits with an
 * ordering key OLDER than the cursor's position (a lock-contention straggler)
 * is skipped until the next wrap — so a straggler is deferred, not lost, and
 * an idle drain (a pass with nothing after the cursor) wraps immediately.
 * Replays are ledger-idempotent, so a lost, stale, or wrapped cursor only
 * causes harmless rework. Fail-open per record; never throws.
 */
export async function recoverTerminalLaneReceipts(
	directory: string,
	records?: readonly BackgroundDelegationRecord[],
	options: RecoverTerminalLaneReceiptsOptions = {},
): Promise<TerminalLaneReceiptRecoveryResult> {
	const now = options.now ?? Date.now;
	const deadlineMs =
		options.deadlineMs ?? TERMINAL_LANE_RECEIPT_RECOVERY_DEADLINE_MS;
	const deadline = now() + deadlineMs;
	if (records !== undefined) {
		// Batch mode (collect path): the slice is already small (≤ MAX_LANES);
		// no cursor, no cap interplay — every terminal record is attempted.
		let recovered = 0;
		for (const record of records) {
			if (!isRecoverableTerminalLaneRecord(record)) continue;
			const transcript = record.terminalResult?.result.text;
			if (!transcript) continue;
			if (now() >= deadline) {
				return { recovered, exhaustedBudget: true };
			}
			try {
				await reconcileLaneKnowledgeReceipts(
					directory,
					record,
					{ transcript },
					true,
				);
				recovered += 1;
			} catch {
				// fail-open per record
			}
		}
		return { recovered, exhaustedBudget: false };
	}
	const candidates = readDelegations(directory)
		.filter(isRecoverableTerminalLaneRecord)
		.sort((left, right) => {
			if (left.updatedAt !== right.updatedAt) {
				return left.updatedAt - right.updatedAt;
			}
			return left.correlationId < right.correlationId
				? -1
				: left.correlationId > right.correlationId
					? 1
					: 0;
		});
	if (candidates.length === 0) return { recovered: 0, exhaustedBudget: false };
	const cursor = readRecoveryCursor(directory);
	let selected = cursor
		? candidates.filter((record) => candidateAfter(record, cursor))
		: candidates;
	let wrapped = false;
	if (selected.length === 0) {
		// Everything is behind the cursor: wrap to the oldest for this pass.
		selected = candidates;
		wrapped = true;
	}
	let recovered = 0;
	let lastProcessed: RecoveryCursor | null = null;
	for (const record of selected) {
		if (recovered >= MAX_TERMINAL_LANE_RECEIPT_RECOVERY) break;
		if (now() >= deadline) break;
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
			lastProcessed = {
				updatedAt: record.updatedAt,
				correlationId: record.correlationId,
			};
		} catch {
			// fail-open per record — one bad record never blocks the rest.
			// Still advance past it so a persistently failing record cannot
			// starve everything behind it.
			lastProcessed = {
				updatedAt: record.updatedAt,
				correlationId: record.correlationId,
			};
		}
	}
	// Value comparison on the ordering key — `lastProcessed` is a fresh cursor
	// literal, never the same reference as the record (review finding: the
	// previous `===` was always false, so the wrap reset never fired).
	const lastCandidate = selected[selected.length - 1];
	const processedAll =
		selected.length > 0 &&
		lastProcessed !== null &&
		lastCandidate !== undefined &&
		lastProcessed.updatedAt === lastCandidate.updatedAt &&
		lastProcessed.correlationId === lastCandidate.correlationId;
	// Persist the advance; a WRAPPED pass that reached the very end resets the
	// cursor so the next pass starts from the oldest record again.
	const nextCursor =
		wrapped && processedAll ? null : (lastProcessed ?? cursor ?? null);
	if (nextCursor?.correlationId !== cursor?.correlationId) {
		writeRecoveryCursor(directory, nextCursor);
	}
	return {
		recovered,
		exhaustedBudget:
			recovered < selected.length &&
			(now() >= deadline || recovered >= MAX_TERMINAL_LANE_RECEIPT_RECOVERY),
	};
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
