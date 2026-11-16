import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
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
 * 4. per-item disclosure — a durable receipt under
 *    `.swarm/pr-review/<runId>/verdict-settlement.<phase>.json` carries one
 *    structured (lane, disposition, evidence class) row per settled item. The
 *    receipt is rename-overwritten on re-admission (last-writer-wins); every
 *    consumer re-derives truth from the CURRENT file plus its state identity,
 *    never from a prior read.
 *
 * This module deliberately mirrors the discovery-phase dead-family admission
 * (`write-pr-review-trigger-eval.ts` + `PR_REVIEW_MICRO_FAMILY_RETRY_BUDGET`)
 * rather than generalizing `bound_fallback`: a verdict artifact is the FIRST
 * write of its fact, so disclose-and-proceed there would trust silence.
 */

/** Sibling of `PR_REVIEW_MICRO_FAMILY_RETRY_BUDGET` (micro discovery families). */
export const PR_REVIEW_VERDICT_RETRY_BUDGET = 2;

export const VERDICT_SETTLEMENT_SCHEMA_VERSION = 1;

/**
 * Bounded receipt read: per-item rows are small, but a wide dead set must
 * still never produce an unbounded blocking read. 64 KiB ≈ hundreds of rows.
 */
export const VERDICT_SETTLEMENT_MAX_RECEIPT_BYTES = 65_536;

/**
 * Writer-side item cap mirroring the byte bound above: 128 rows of
 * pretty-printed receipt stay well under `VERDICT_SETTLEMENT_MAX_RECEIPT_BYTES`
 * on every encoding, so the writer can never persist a receipt the bounded
 * reader would refuse (that would wedge the run into a rewrite loop).
 */
export const VERDICT_SETTLEMENT_MAX_RECEIPT_ITEMS = 128;

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
		disposition: z.enum([
			'liveness_dead',
			'verdict_contract_dead',
			'resource_dead',
		]),
		evidenceClass: z.enum(['liveness', 'verdict_contract', 'resource']),
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
		items: z
			.array(PrReviewVerdictSettlementItemSchema)
			.min(1)
			.max(VERDICT_SETTLEMENT_MAX_RECEIPT_ITEMS),
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
 * The typed-dead disclosure classes N-of-M admission accepts as terminality
 * evidence (issue #3311). The gate's strictly-liveness parent-repair predicate
 * (`isLivenessTerminalLaneRecord`, pr-workflow-gate.ts:2088, issue #2585 AC13)
 * and this classifier intentionally DIVERGE: this side admits the widened
 * typed-dead classes, that side stays liveness-only for base/micro discovery
 * repair. Do not re-twin them.
 */
type VerdictSettlementDisclosureClass =
	| 'liveness'
	| 'verdict_contract'
	| 'resource';

/**
 * Classify an owner record for settlement (issue #3311):
 * - typed-dead(disclosureClass): terminal status AND a class that maps to a
 *   disclosure class. `contract` on a verdict-mode record maps to
 *   `verdict_contract` as READER-SIDE LEGACY TOLERANCE: the only 'contract'
 *   producer at the time of the widening is discovery-gated
 *   (dispatch-lanes.ts base|micro|council block) and cannot stamp a
 *   `swarm-pr-review:reviewer|critic` record, so a class-'contract'
 *   verdict-mode owner is a pre-upgrade fixture shape that must disclose as
 *   `verdict_contract` (frozen by the #3311 acceptance checks).
 * - consumed-completed (status 'completed'): counts as a consumed attempt,
 *   never terminality evidence — completed status takes precedence over any
 *   present class.
 * - blocking (classless, `operator_cancelled`, `deadline`, wrong status):
 *   keeps blocking settlement.
 * The claimed `terminalResult.result` class is authoritative when present; the
 * `record.result` class is the fallback (the same precedence the circuit and
 * the completion typed-failure reader apply).
 */
function typedDeadDisclosureClassForRecord(
	record: BackgroundDelegationRecord,
): VerdictSettlementDisclosureClass | null {
	if (
		record.status !== 'cancelled' &&
		record.status !== 'stale' &&
		record.status !== 'error'
	) {
		return null;
	}
	const terminalClass =
		record.terminalResult?.result.workflowLaneFailureClass ?? null;
	const resultClass = record.result?.workflowLaneFailureClass ?? null;
	for (const cls of [terminalClass, resultClass]) {
		switch (cls) {
			case 'liveness':
				return 'liveness';
			case 'verdict_contract':
			case 'contract':
				return 'verdict_contract';
			case 'resource':
				return 'resource';
			default:
				break;
		}
	}
	return null;
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
 * The budget arm is PER ITEM: only the distinct window batches whose owner
 * lanes declare THAT item count toward it (per-item-family counting mirroring
 * `countFamilyDispatchAttempts` — never a raw phase-level batch count), and
 * exhaustion requires `1 + budget` such attempts. The settled row's cited
 * batch is one of its counted attempts by construction, so the cited-batch
 * conjunction holds for every admitted row. Uncertain delegation-store reads
 * fail closed (settlement keeps blocking).
 */
export function deriveVerdictSettlementAdmission(args: {
	directory: string;
	prHeadSha: string;
	phase: PrReviewVerdictSettlementPhase;
	/** The phase window batches composition scans (`prReviewPhaseWindow`). */
	window: readonly VerdictSettlementWindowBatch[];
	unclaimed: readonly string[];
	/** Session scoping for delegation-store reads (sibling call-site parity). */
	parentSessionId?: string;
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
	// One delegation-store read per batch id per admission call: the store is
	// re-parsed on every lookup, so every owner pair sharing a batch shares the
	// read instead of costing an O(items × owners) full-store re-parse.
	const batchReads = new Map<
		string,
		ReturnType<typeof _internals.findByBatchIdDetailed>
	>();
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
		// Per-item attempt set (see docstring): sibling items' dispatches never
		// count toward this item's budget.
		const itemAttemptBatchIds = new Set<string>();
		const dead: Array<{
			batchId: string;
			laneId: string;
			status: 'stale' | 'cancelled' | 'error';
			disclosure: VerdictSettlementDisclosureClass;
		}> = [];
		for (const { batch, lane } of owners) {
			itemAttemptBatchIds.add(batch.batchId);
			// Decision-time re-read with an exact identity conjunction (the
			// #3094 TOCTOU discipline). Uncertain reads fail closed.
			let read = batchReads.get(batch.batchId);
			if (!read) {
				read = _internals.findByBatchIdDetailed(directory, batch.batchId, {
					parentSessionId: args.parentSessionId,
				});
				batchReads.set(batch.batchId, read);
			}
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
			// Issue #3311 widened admission: every owner must be typed-dead or a
			// consumed-completed attempt; a missing record, a classless record,
			// operator_cancelled and any other non-admissible class keep blocking
			// (constraints 1 + 2 of #3101 are unchanged — this types terminality,
			// it never loosens identity or admits silence).
			if (!record) {
				return {
					admitted: false,
					reason: `item ${itemId} still has a non-admissible owner lane ${lane.laneId} (missing delegation record)`,
					items: [],
				};
			}
			if (record.status === 'completed') {
				// Consumed-completed attempt (V1 A3): a completed lane whose claim
				// was dropped produced output that is stale by construction; it
				// counts toward the budget but is never terminality evidence.
				continue;
			}
			const disclosure = typedDeadDisclosureClassForRecord(record);
			if (!disclosure) {
				const blockingClass =
					record.terminalResult?.result.workflowLaneFailureClass ??
					record.result?.workflowLaneFailureClass ??
					'classless';
				return {
					admitted: false,
					reason: `item ${itemId} still has a non-admissible owner lane ${lane.laneId} (${blockingClass})`,
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
				disclosure,
			});
		}
		if (itemAttemptBatchIds.size < 1 + PR_REVIEW_VERDICT_RETRY_BUDGET) {
			return {
				admitted: false,
				reason: `item ${itemId} verdict retry budget not exhausted (${itemAttemptBatchIds.size} of ${1 + PR_REVIEW_VERDICT_RETRY_BUDGET} required attempts)`,
				items: [],
			};
		}
		// At least one owner must be typed-dead: the receipt row cites a
		// typed-dead source batch/lane, so completed owners alone can never
		// admit an item (frozen by the #3311 no-typed-owner floor).
		if (dead.length === 0) {
			return {
				admitted: false,
				reason: `item ${itemId} has no typed-dead owner lane to cite (completed owners consume attempts but are never terminality evidence)`,
				items: [],
			};
		}
		const first = dead[0]!;
		items.push({
			itemId,
			sourceBatchId: first.batchId,
			sourceLaneId: first.laneId,
			disposition: `${first.disclosure}_dead`,
			evidenceClass: first.disclosure,
			terminalStatus: first.status,
		});
	}
	return { admitted: true, reason: 'admitted', items };
}

/** Per-item verdict attempt accounting (issue #3311 AC22/AC24 shape). */
export interface VerdictSettlementAttemptCount {
	itemId: string;
	/** Distinct window batches whose lanes declare the item. */
	attemptsUsed: number;
	/** Always `1 + PR_REVIEW_VERDICT_RETRY_BUDGET`. */
	attemptsRequired: number;
	remaining: number;
}

/**
 * Per-item attempt counts over the SAME window semantics the admission's
 * budget arm uses (distinct window batches whose lanes declare the item —
 * window-based, independent of delegation-store state). The gate's BLOCKED
 * text and the pr_workflow_status projection both consume this single
 * derivation so their counts cannot drift (issue #3311).
 */
export function deriveVerdictAttemptCounts(args: {
	window: readonly VerdictSettlementWindowBatch[];
	unclaimed: readonly string[];
}): VerdictSettlementAttemptCount[] {
	const attemptsRequired = 1 + PR_REVIEW_VERDICT_RETRY_BUDGET;
	return args.unclaimed.map((itemId) => {
		const batches = new Set<string>();
		for (const batch of args.window) {
			if (
				batch.lanes.some((lane) => (lane.reviewItemIds ?? []).includes(itemId))
			) {
				batches.add(batch.batchId);
			}
		}
		const attemptsUsed = batches.size;
		return {
			itemId,
			attemptsUsed,
			attemptsRequired,
			remaining: Math.max(0, attemptsRequired - attemptsUsed),
		};
	});
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
	// Writer-side mirror of the reader's bounds: persisting a receipt the
	// bounded reader would refuse would wedge the run into a rewrite loop
	// (invalid read → block → re-admit → rewrite). Refuse here instead — both
	// the byte cap AND the schema item cap (a 129–item receipt can sit under
	// the byte bound while still failing schema validation at read).
	if (receipt.items.length > VERDICT_SETTLEMENT_MAX_RECEIPT_ITEMS) {
		throw new Error(
			`verdict-settlement receipt exceeds the ${VERDICT_SETTLEMENT_MAX_RECEIPT_ITEMS}-item bounded-reader cap (${receipt.items.length} items); narrow the disclosed dead set before settling`,
		);
	}
	const serialized = JSON.stringify(receipt, null, 2);
	const serializedBytes = Buffer.byteLength(serialized, 'utf8');
	if (serializedBytes > VERDICT_SETTLEMENT_MAX_RECEIPT_BYTES) {
		throw new Error(
			`verdict-settlement receipt exceeds the ${VERDICT_SETTLEMENT_MAX_RECEIPT_BYTES}-byte bounded-reader cap (${serializedBytes} bytes); narrow the disclosed dead set before settling`,
		);
	}
	const absolute = path.join(
		directory,
		'.swarm',
		verdictSettlementRelativePath(receipt.runId, receipt.phase),
	);
	await writeAtomicJson(directory, absolute, receipt);
}

export type VerdictSettlementReceiptRead =
	| {
			status: 'ok';
			receipt: PrReviewVerdictSettlementReceipt;
			/** sha256 of the exact file bytes, for consumption-time anchor checks. */
			rawSha256: string;
	  }
	| { status: 'absent' }
	| { status: 'invalid'; reason: string };

type BoundedBytesRead =
	| { status: 'ok'; bytes: Buffer }
	| { status: 'absent' }
	| { status: 'invalid'; reason: string };

function boundedReadErrno(error: unknown): BoundedBytesRead {
	if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
		return { status: 'absent' };
	}
	const code = (error as NodeJS.ErrnoException)?.code ?? 'unknown';
	return {
		status: 'invalid',
		reason: `receipt is unreadable (${String(code)})`,
	};
}

/**
 * Bounded, symlink-safe, byte-denominated regular-file read (the sync twin of
 * the gate's `readBoundedSwarmRegularFile`): lstat before open so a symlink
 * never materializes, realpath containment, identity re-check after open and
 * after read, and a pre-allocated max+1 buffer so an oversized file is never
 * fully materialized. `absent` is reserved for ENOENT — every other failure
 * keeps its errno in the reason.
 */
function readBoundedSwarmRegularFileBytes(
	swarmRoot: string,
	absolute: string,
	maxBytes: number,
): BoundedBytesRead {
	const rootStat = fs.lstatSync(swarmRoot, {
		bigint: true,
		throwIfNoEntry: false,
	});
	if (!rootStat) return { status: 'absent' };
	if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
		return {
			status: 'invalid',
			reason: 'receipt root must be a real project .swarm directory',
		};
	}
	const fileStat = fs.lstatSync(absolute, {
		bigint: true,
		throwIfNoEntry: false,
	});
	if (!fileStat) return { status: 'absent' };
	if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
		return {
			status: 'invalid',
			reason: 'receipt must be a bounded regular file',
		};
	}
	if (fileStat.size > BigInt(maxBytes)) {
		return { status: 'invalid', reason: 'receipt exceeds size bound' };
	}
	let realRoot: string;
	let realFile: string;
	try {
		realRoot = fs.realpathSync(swarmRoot);
		realFile = fs.realpathSync(absolute);
	} catch (error) {
		return boundedReadErrno(error);
	}
	const relative = path.relative(realRoot, realFile);
	if (
		relative === '' ||
		relative === '..' ||
		relative.startsWith(`..${path.sep}`) ||
		path.isAbsolute(relative)
	) {
		return {
			status: 'invalid',
			reason: 'receipt escapes the project .swarm directory',
		};
	}
	let fd: number;
	try {
		fd = fs.openSync(realFile, 'r');
	} catch (error) {
		return boundedReadErrno(error);
	}
	try {
		const openedStat = fs.fstatSync(fd, { bigint: true });
		if (
			!openedStat.isFile() ||
			openedStat.size > BigInt(maxBytes) ||
			openedStat.dev !== fileStat.dev ||
			openedStat.ino !== fileStat.ino
		) {
			return {
				status: 'invalid',
				reason: 'receipt changed or grew during its bounded read',
			};
		}
		const buffer = Buffer.allocUnsafe(maxBytes + 1);
		const bytesRead = fs.readSync(fd, buffer, 0, maxBytes + 1, 0);
		if (bytesRead > maxBytes) {
			return { status: 'invalid', reason: 'receipt exceeds size bound' };
		}
		// Post-read identity re-check: the file on disk must still be the same
		// non-symlink regular file it was at lstat time.
		const postStat = fs.lstatSync(absolute, {
			bigint: true,
			throwIfNoEntry: false,
		});
		if (
			!postStat ||
			postStat.isSymbolicLink() ||
			!postStat.isFile() ||
			postStat.dev !== fileStat.dev ||
			postStat.ino !== fileStat.ino
		) {
			return {
				status: 'invalid',
				reason: 'receipt changed during its bounded read',
			};
		}
		return { status: 'ok', bytes: buffer.subarray(0, bytesRead) };
	} catch (error) {
		return boundedReadErrno(error);
	} finally {
		fs.closeSync(fd);
	}
}

export function readVerdictSettlementReceipt(
	directory: string,
	runId: string,
	phase: PrReviewVerdictSettlementPhase,
): VerdictSettlementReceiptRead {
	const relative = verdictSettlementRelativePath(runId, phase);
	const absolute = path.join(directory, '.swarm', relative);
	const read = readBoundedSwarmRegularFileBytes(
		path.join(directory, '.swarm'),
		absolute,
		VERDICT_SETTLEMENT_MAX_RECEIPT_BYTES,
	);
	if (read.status !== 'ok') return read;
	let parsed: unknown;
	try {
		parsed = JSON.parse(read.bytes.toString('utf-8'));
	} catch {
		return { status: 'invalid', reason: 'receipt is not valid JSON' };
	}
	const validated = PrReviewVerdictSettlementReceiptSchema.safeParse(parsed);
	if (!validated.success) {
		return { status: 'invalid', reason: 'receipt fails schema validation' };
	}
	return {
		status: 'ok',
		receipt: validated.data,
		rawSha256: createHash('sha256').update(read.bytes).digest('hex'),
	};
}

/**
 * The single shared effective-set helper every consumer uses (constraint 4 +
 * receipt re-verification): the EFFECTIVE disclosed set is
 * `receipt.items ∩ currentUnclaimed`. An item claimed after the receipt was
 * written drops out; an empty effective set exerts no constraint (no
 * degradation flag, no exemptions).
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
 *
 * Note the deliberate one-way divergence from the gate's
 * `settlementCoveringAllUnclaimed` predicate: that one requires FULL cover of
 * the current unclaimed set before exempting anything, while this one fires
 * on a non-empty intersection. The divergence is strictly fail-closed —
 * degradation-on-while-exemptions-off is reachable, exemptions-on-while-
 * degradation-off is not (full cover implies a non-empty intersection).
 */
export function verdictSettlementDegradationActive(args: {
	directory: string;
	runId: string | undefined;
	prHeadSha: string | undefined;
	revisionDigest: string | undefined;
	reviewerUnclaimed: readonly string[];
	criticUnclaimed: readonly string[];
}): boolean {
	const { directory, runId, prHeadSha, revisionDigest } = args;
	if (!runId || !prHeadSha || !revisionDigest) return false;
	const phases = [
		{ phase: 'reviewer' as const, unclaimed: args.reviewerUnclaimed },
		{ phase: 'critic' as const, unclaimed: args.criticUnclaimed },
	];
	for (const { phase, unclaimed } of phases) {
		if (unclaimed.length === 0) continue;
		const read = readVerdictSettlementReceipt(directory, runId, phase);
		if (
			read.status !== 'ok' ||
			read.receipt.prHeadSha !== prHeadSha ||
			read.receipt.revisionDigest !== revisionDigest
		) {
			continue;
		}
		if (effectiveVerdictSettlementItems(read.receipt, unclaimed).length > 0) {
			return true;
		}
	}
	return false;
}

/**
 * Test seam (DI over `mock.module`, repo convention): the delegation lookup is
 * injectable so admission arms (uncertain store reads) are testable without
 * corrupting a real store. Restore in `afterEach`.
 */
export const _internals: {
	findByBatchIdDetailed: typeof findByBatchIdDetailed;
} = { findByBatchIdDetailed };
