/**
 * PR-review resilience circuit — typed, recoverable, versioned (issue #2382).
 *
 * Pure state machine + typed-signal classification for the PR_REVIEW
 * resilience circuit. No I/O: the owning gate (`pr-workflow-gate.ts`) reads
 * the delegation ledger and persists transitions under its CAS write path.
 *
 * Contracts implemented (issue #2382 "Required design"):
 * - Only durable, typed `provider_terminal` signals contribute; every other
 *   outcome is an `ignored` kind that can never open, reopen, or close the
 *   circuit.
 * - The threshold counts distinct `(generation, batchId, laneId)` contributor
 *   lanes per provider class — never owned dimensions, never repeated
 *   collections of the same lane.
 * - State is a versioned v2 record: CLOSED → OPEN (bounded interval) →
 *   exactly-one HALF_OPEN probe → CLOSED (generation bump + evidence
 *   waterline) or back to OPEN (new interval). Legacy unversioned records
 *   migrate once to a nonblocking v2 CLOSED record with an evidence waterline;
 *   malformed records fail open.
 */

import { z } from 'zod';
import type { BackgroundDelegationRecord } from '../background/pending-delegations.js';

/** Bounded contributor ledger. Mirrors `MAX_WORKFLOW_BATCHES (128) × 6` base dimensions. */
export const PR_REVIEW_CIRCUIT_CONTRIBUTOR_LIMIT = 768;

export type PrReviewCircuitIgnoredReason =
	| 'observer_deadline'
	| 'client_unavailable'
	| 'parser'
	| 'validation'
	| 'policy'
	| 'filesystem'
	| 'git'
	| 'cancellation'
	| 'stale_observation'
	| 'unknown';

export type PrReviewCircuitSignal =
	| {
			kind: 'provider_terminal';
			providerClass: string;
			batchId: string;
			laneId: string;
			terminalAtMs: number;
	  }
	| { kind: 'ignored'; reason: PrReviewCircuitIgnoredReason };

export type PrReviewCircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface PrReviewCircuitContributor {
	batchId: string;
	laneId: string;
	/** ISO timestamp of the contributing lane's terminal evidence. */
	terminalAt: string;
}

export interface PrReviewCircuitProbeRecord {
	batchId: string;
	laneId: string;
	admittedAt: string;
}

export interface PrReviewCircuitRecordV2 {
	version: 2;
	state: PrReviewCircuitState;
	generation: number;
	providerClass?: string;
	contributors: PrReviewCircuitContributor[];
	openedAt?: string;
	openUntil?: string;
	/** Evidence at or before this ISO instant can never contribute again. */
	evidenceWaterline?: string;
	probe?: PrReviewCircuitProbeRecord;
}

/** The unversioned pre-#2382 persisted circuit shape. */
export interface PrReviewCircuitLegacyRecord {
	signature: string;
	count: number;
	contributors: Array<{ batchId: string; laneId: string }>;
	openedAt: string;
}

// ---------------------------------------------------------------------------
// Persisted schemas (strict; composed into PrWorkflowGateStateSchema)
// ---------------------------------------------------------------------------

export const PrReviewCircuitLegacyRecordSchema = z
	.object({
		signature: z.string().min(1).max(512),
		count: z.number().int().min(2).max(PR_REVIEW_CIRCUIT_CONTRIBUTOR_LIMIT),
		contributors: z
			.array(
				z
					.object({ batchId: z.string().min(1), laneId: z.string().min(1) })
					.strict(),
			)
			.min(2)
			.max(PR_REVIEW_CIRCUIT_CONTRIBUTOR_LIMIT),
		openedAt: z.string().min(1),
	})
	.strict();

export const PrReviewCircuitRecordV2Schema = z
	.object({
		version: z.literal(2),
		state: z.enum(['CLOSED', 'OPEN', 'HALF_OPEN']),
		generation: z.number().int().min(1),
		providerClass: z.string().min(1).max(128).optional(),
		contributors: z
			.array(
				z
					.object({
						batchId: z.string().min(1),
						laneId: z.string().min(1),
						terminalAt: z.string().min(1),
					})
					.strict(),
			)
			.max(PR_REVIEW_CIRCUIT_CONTRIBUTOR_LIMIT),
		openedAt: z.string().min(1).optional(),
		openUntil: z.string().min(1).optional(),
		evidenceWaterline: z.string().min(1).optional(),
		probe: z
			.object({
				batchId: z.string().min(1),
				laneId: z.string().min(1),
				admittedAt: z.string().min(1),
			})
			.strict()
			.optional(),
	})
	.strict();

export const PrReviewCircuitRecordSchema = z.union([
	PrReviewCircuitLegacyRecordSchema,
	PrReviewCircuitRecordV2Schema,
]);

// ---------------------------------------------------------------------------
// Typed-signal classification (durable record → circuit signal)
// ---------------------------------------------------------------------------

/**
 * The terminal delegation statuses the circuit consults. Mirrors
 * `TERMINAL_FAILED_DELEGATION_STATUSES` in `pr-workflow-gate.ts`.
 */
const CIRCUIT_TERMINAL_DELEGATION_STATUSES: ReadonlySet<string> = new Set([
	'completed',
	'error',
	'cancelled',
	'stale',
]);

function zeroOutputResult(result: {
	outputRef?: string;
	text?: string;
	chars?: number;
}): boolean {
	const outputRef = result.outputRef?.trim();
	const text = result.text?.trim() ?? '';
	return !outputRef && text.length === 0 && (result.chars ?? 0) === 0;
}

/**
 * Derive the typed circuit signal from a durable delegation record's LATEST
 * terminal state. Returns `null` for anything that is not a terminal failure
 * signal (pending/running lanes, healthy completions).
 *
 * Trust rules: only the structured `terminalErrorClass` captured at settle
 * time can produce `provider_terminal`; display text is never parsed. Records
 * settled before this field existed, launch failures (the child never ran),
 * presumed-stale sweeps, cancellations, and empty completions are `ignored`
 * kinds or no signal at all.
 */
export function classifyPrReviewCircuitSignal(
	record: Pick<
		BackgroundDelegationRecord,
		'status' | 'result' | 'terminalResult'
	> & {
		batchId?: string;
		laneId?: string;
	},
): PrReviewCircuitSignal | null {
	if (!CIRCUIT_TERMINAL_DELEGATION_STATUSES.has(record.status)) return null;
	const result = record.terminalResult?.result ?? record.result;
	const providerClass = result?.terminalErrorClass?.category;
	if (result?.terminalErrorClass && providerClass) {
		if (record.status !== 'error') {
			// Only an `error` settlement is a terminal provider failure. An
			// aborted lane settles `cancelled` (cancellation), never evidence.
			return { kind: 'ignored', reason: 'cancellation' };
		}
		if (result.terminalErrorClass.kind === 'provider') {
			return {
				kind: 'provider_terminal',
				providerClass,
				batchId: record.batchId ?? '',
				laneId: record.laneId ?? '',
				terminalAtMs:
					record.terminalResult?.recordedAt ??
					(record as { completedAt?: number }).completedAt ??
					(record as { updatedAt?: number }).updatedAt ??
					(record as { createdAt?: number }).createdAt ??
					0,
			};
		}
		if (result.terminalErrorClass.kind === 'aborted') {
			return { kind: 'ignored', reason: 'cancellation' };
		}
		if (result.terminalErrorClass.kind === 'output_length') {
			return { kind: 'ignored', reason: 'validation' };
		}
		return { kind: 'ignored', reason: 'unknown' };
	}
	switch (record.status) {
		case 'error':
			// Pre-upgrade records, launch failures, contract failures: no durable
			// evidence of a provider termination — never trusted.
			return { kind: 'ignored', reason: 'unknown' };
		case 'stale':
			return { kind: 'ignored', reason: 'stale_observation' };
		case 'cancelled':
			return { kind: 'ignored', reason: 'cancellation' };
		case 'completed':
			return zeroOutputResult(result ?? {})
				? { kind: 'ignored', reason: 'parser' }
				: null;
		default:
			return null;
	}
}

// ---------------------------------------------------------------------------
// Evidence scan (pure; the gate supplies one signal per dispatch lane)
// ---------------------------------------------------------------------------

/**
 * Reduce per-lane signals into per-providerClass distinct-lane evidence under
 * the CURRENT circuit generation. Dedupes on `(generation, batchId, laneId)`,
 * drops evidence at or before the waterline, sorts newest-first, and bounds
 * each class's contributor list with deterministic keep-newest eviction.
 */
export function scanPrReviewCircuitEvidence(
	signals: readonly PrReviewCircuitSignal[],
	generation: number,
	waterlineMs: number | undefined,
): Map<string, Array<PrReviewCircuitSignal & { kind: 'provider_terminal' }>> {
	const byKey = new Map<
		string,
		{ signal: PrReviewCircuitSignal & { kind: 'provider_terminal' } }
	>();
	for (const signal of signals) {
		if (signal.kind !== 'provider_terminal') continue;
		if (
			signal.terminalAtMs <= 0 ||
			(waterlineMs !== undefined && signal.terminalAtMs <= waterlineMs)
		) {
			continue;
		}
		const key = `${generation}\u0000${signal.batchId}\u0000${signal.laneId}`;
		const existing = byKey.get(key);
		if (!existing || existing.signal.terminalAtMs < signal.terminalAtMs) {
			byKey.set(key, { signal });
		}
	}
	const grouped = new Map<
		string,
		Array<PrReviewCircuitSignal & { kind: 'provider_terminal' }>
	>();
	const ordered = [...byKey.values()].sort(
		(left, right) =>
			right.signal.terminalAtMs - left.signal.terminalAtMs ||
			left.signal.providerClass.localeCompare(right.signal.providerClass) ||
			left.signal.batchId.localeCompare(right.signal.batchId) ||
			left.signal.laneId.localeCompare(right.signal.laneId),
	);
	for (const { signal } of ordered) {
		const list = grouped.get(signal.providerClass) ?? [];
		if (list.length < PR_REVIEW_CIRCUIT_CONTRIBUTOR_LIMIT) {
			list.push(signal);
		}
		grouped.set(signal.providerClass, list);
	}
	return grouped;
}

// ---------------------------------------------------------------------------
// Adoption / migration (legacy + malformed → v2)
// ---------------------------------------------------------------------------

export type PrReviewCircuitAdoptionDiagnostic =
	| { code: 'migrated_legacy_circuit'; legacySignatureCount: number }
	| {
			code: 'malformed_circuit_dropped';
			bodyHash8: string;
			byteLength: number;
	  };

export type PrReviewCircuitAdoption =
	| { kind: 'v2'; record: PrReviewCircuitRecordV2 }
	| { kind: 'absent' }
	| {
			kind: 'migrated';
			record: PrReviewCircuitRecordV2;
			diagnostic: PrReviewCircuitAdoptionDiagnostic;
	  }
	| { kind: 'malformed'; diagnostic: PrReviewCircuitAdoptionDiagnostic };

/**
 * Adopt a persisted circuit field: v2 records pass through, legacy unversioned
 * records migrate ONCE to a nonblocking v2 CLOSED record whose evidence
 * waterline is `now` (historical evidence can never immediately reopen), and
 * malformed records fail open with a bounded hash-only diagnostic.
 */
export function adoptPrReviewCircuit(
	raw: unknown,
	nowMs: number,
): PrReviewCircuitAdoption {
	if (raw === undefined || raw === null) return { kind: 'absent' };
	const asV2 = PrReviewCircuitRecordV2Schema.safeParse(raw);
	if (asV2.success) return { kind: 'v2', record: asV2.data };
	const asLegacy = PrReviewCircuitLegacyRecordSchema.safeParse(raw);
	if (asLegacy.success) {
		return {
			kind: 'migrated',
			record: {
				version: 2,
				state: 'CLOSED',
				generation: 1,
				contributors: [],
				evidenceWaterline: new Date(nowMs).toISOString(),
			},
			diagnostic: {
				code: 'migrated_legacy_circuit',
				legacySignatureCount: asLegacy.data.contributors.length,
			},
		};
	}
	const body = JSON.stringify(raw);
	let hash = '';
	try {
		// FNV-1a 32-bit rendered as 8 hex: bounded, dependency-light, enough to
		// correlate repeated diagnostics for the same malformed body without
		// ever exposing record content.
		let h = 0x811c9dc5;
		for (let index = 0; index < body.length; index += 1) {
			h ^= body.charCodeAt(index);
			h = Math.imul(h, 0x01000193);
		}
		hash = (h >>> 0).toString(16).padStart(8, '0');
	} catch {
		hash = 'unserializable';
	}
	return {
		kind: 'malformed',
		diagnostic: {
			code: 'malformed_circuit_dropped',
			bodyHash8: hash,
			byteLength: body.length,
		},
	};
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

export interface PrReviewCircuitAdvanceInput {
	nowMs: number;
	threshold: number;
	openDurationMs: number;
	/** The staged dispatch requesting admission, when this advance guards one. */
	admission?: { batchId: string; laneId: string };
	/** Latest-record signals for every dispatch lane of the current workflow. */
	laneSignals: readonly PrReviewCircuitSignal[];
	/**
	 * Observation of the CURRENT probe lane's latest record (HALF_OPEN only).
	 * The gate supplies it only when it read the recorded probe's batch/lane,
	 * which structurally drops late results from older generations.
	 */
	probeObservation?: {
		terminalStatus: string;
		signal: PrReviewCircuitSignal | null;
		terminalAtMs: number;
	};
}

export type PrReviewCircuitAdvanceResult =
	| { action: 'admit'; changed: false }
	| { action: 'admit'; changed: true; record: PrReviewCircuitRecordV2 }
	| { action: 'admit_as_probe'; changed: true; record: PrReviewCircuitRecordV2 }
	| { action: 'admit_as_probe'; changed: false }
	| {
			action: 'block';
			reason: 'circuit_open' | 'probe_in_flight';
			changed: boolean;
			record?: PrReviewCircuitRecordV2;
	  };

function freshRecord(
	nowMs: number,
	withWaterline: boolean,
): PrReviewCircuitRecordV2 {
	return {
		version: 2,
		state: 'CLOSED',
		generation: 1,
		contributors: [],
		...(withWaterline
			? { evidenceWaterline: new Date(nowMs).toISOString() }
			: {}),
	};
}

/**
 * Advance the circuit one step. `current === null` means no circuit record
 * exists yet (plain birth: no waterline — post-upgrade evidence counts; the
 * gate passes an explicit waterlined record for migration / re-enable births).
 */
export function advancePrReviewCircuit(
	current: PrReviewCircuitRecordV2 | null,
	input: PrReviewCircuitAdvanceInput,
): PrReviewCircuitAdvanceResult {
	const record = current ?? freshRecord(input.nowMs, false);
	if (record.state === 'CLOSED') {
		const evidence = scanPrReviewCircuitEvidence(
			input.laneSignals,
			record.generation,
			record.evidenceWaterline
				? Date.parse(record.evidenceWaterline)
				: undefined,
		);
		let best: {
			providerClass: string;
			lanes: Array<PrReviewCircuitSignal & { kind: 'provider_terminal' }>;
		} | null = null;
		for (const [providerClass, lanes] of evidence) {
			if (lanes.length < input.threshold) continue;
			if (
				!best ||
				lanes.length > best.lanes.length ||
				(lanes.length === best.lanes.length &&
					providerClass.localeCompare(best.providerClass) < 0)
			) {
				best = { providerClass, lanes };
			}
		}
		if (!best) return { action: 'admit', changed: false };
		const openedAt = new Date(input.nowMs).toISOString();
		const opened: PrReviewCircuitRecordV2 = {
			...record,
			state: 'OPEN',
			providerClass: best.providerClass,
			contributors: best.lanes.map((signal) => ({
				batchId: signal.batchId,
				laneId: signal.laneId,
				terminalAt: new Date(signal.terminalAtMs).toISOString(),
			})),
			openedAt,
			openUntil: new Date(input.nowMs + input.openDurationMs).toISOString(),
		};
		return {
			action: 'block',
			reason: 'circuit_open',
			changed: true,
			record: opened,
		};
	}
	if (record.state === 'OPEN') {
		const openUntilMs = record.openUntil ? Date.parse(record.openUntil) : 0;
		if (input.nowMs < openUntilMs) {
			return { action: 'block', reason: 'circuit_open', changed: false };
		}
		if (!input.admission) {
			return { action: 'block', reason: 'circuit_open', changed: false };
		}
		const probing: PrReviewCircuitRecordV2 = {
			...record,
			state: 'HALF_OPEN',
			probe: {
				batchId: input.admission.batchId,
				laneId: input.admission.laneId,
				admittedAt: new Date(input.nowMs).toISOString(),
			},
		};
		return { action: 'admit_as_probe', changed: true, record: probing };
	}
	// HALF_OPEN
	const probe = record.probe;
	if (!probe) {
		// Structurally unreachable (HALF_OPEN always carries a probe); fail
		// closed defensively.
		return { action: 'block', reason: 'probe_in_flight', changed: false };
	}
	if (
		input.admission &&
		input.admission.batchId === probe.batchId &&
		!input.probeObservation
	) {
		// Idempotent re-admission of the recorded probe (e.g. a concurrent
		// contender that lost the CAS but retries the identical dispatch).
		return { action: 'admit_as_probe', changed: false };
	}
	if (!input.probeObservation) {
		return { action: 'block', reason: 'probe_in_flight', changed: false };
	}
	const { terminalStatus, signal } = input.probeObservation;
	if (signal?.kind === 'provider_terminal') {
		const contributor = {
			batchId: probe.batchId,
			laneId: probe.laneId,
			terminalAt: new Date(signal.terminalAtMs).toISOString(),
		};
		const contributors = [
			...record.contributors.filter(
				(entry) =>
					!(
						entry.batchId === contributor.batchId &&
						entry.laneId === contributor.laneId
					),
			),
			contributor,
		].slice(-PR_REVIEW_CIRCUIT_CONTRIBUTOR_LIMIT);
		const reopened: PrReviewCircuitRecordV2 = {
			...record,
			state: 'OPEN',
			contributors,
			openUntil: new Date(input.nowMs + input.openDurationMs).toISOString(),
			probe: undefined,
		};
		return {
			action: 'block',
			reason: 'circuit_open',
			changed: true,
			record: reopened,
		};
	}
	if (terminalStatus === 'completed' && signal === null) {
		const closed: PrReviewCircuitRecordV2 = {
			version: 2,
			state: 'CLOSED',
			generation: record.generation + 1,
			contributors: [],
			evidenceWaterline: new Date(
				input.probeObservation.terminalAtMs || input.nowMs,
			).toISOString(),
		};
		return { action: 'admit', changed: true, record: closed };
	}
	// Ignored probe outcome: the ignored signal changes NO circuit state — the
	// probe lifecycle simply ends and the recovery cooldown RESTARTS (state
	// stays OPEN; contributors, generation, and waterline untouched). The next
	// probe is only eligible after the full new interval, via the normal
	// OPEN-expired rule.
	const cooled: PrReviewCircuitRecordV2 = {
		...record,
		state: 'OPEN',
		openUntil: new Date(input.nowMs + input.openDurationMs).toISOString(),
		probe: undefined,
	};
	return {
		action: 'block',
		reason: 'circuit_open',
		changed: true,
		record: cooled,
	};
}
