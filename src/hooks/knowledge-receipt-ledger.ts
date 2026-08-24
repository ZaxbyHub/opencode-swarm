import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { loadPluginConfigWithMeta } from '../config/index.js';
import { KnowledgeConfigSchema } from '../config/schema.js';
import {
	appendFsynced,
	atomicWriteFsynced,
	RECEIPT_CUTOVER_VERSION,
	RECEIPT_SCHEMA_VERSION,
	type ReceiptLedgerPaths,
	ReceiptStoreError,
	type ReceiptStoreErrorCode,
	readBytesIfPresent,
	readUtf8IfPresent,
	receiptRecordHash,
	withReceiptLedgerLock,
} from './knowledge-receipt-ledger-storage.js';
import {
	emitKnowledgeReceiptTransition,
	type KnowledgeReceiptObservationReasonCode,
	type KnowledgeReceiptTransitionObservation,
} from './knowledge-receipt-observability.js';

/**
 * Canonical terminal-outcome vocabulary for the authoritative receipt ledger
 * (issue #2032). This is the single declaration the outcome-aware consumers
 * import and derive from: the shared validator (`VALID_OUTCOMES`), the
 * collectors, the application and phase gates, the counter rollups, the
 * scoring signal, and the diagnostics. (The curator consumes outcomes only
 * through the derived signal and counter rollups — it does not switch on
 * this set directly.) Semantics: `applied` = followed (positive signal;
 * reviewer VERIFIED maps here); `ignored` = judged relevant but deliberately
 * not followed (negative signal, policy consequences retained);
 * `contradicted` = current authority disproves (negative); `violated` =
 * runtime violation (negative, blocks phase completion until remediated);
 * `n_a` = not applicable to the current action (neutral — clears only the
 * acknowledgement/applicability obligation, never proves application, never
 * feeds promotion evidence).
 */
export type ReceiptOutcome =
	| 'applied'
	| 'ignored'
	| 'contradicted'
	| 'violated'
	| 'n_a';

/** Runtime set form of {@link ReceiptOutcome} — derive, never redeclare. */
export const RECEIPT_TERMINAL_OUTCOMES: ReadonlySet<ReceiptOutcome> =
	new Set<ReceiptOutcome>([
		'applied',
		'ignored',
		'contradicted',
		'violated',
		'n_a',
	]);

/**
 * Canonical terminal-source taxonomy (issue #2032). `source` answers WHO
 * produced the terminal as a provenance class, while the separate `agent`
 * field records the agent identity. Storage stays permissive (`string`) for
 * legacy tolerance: a legacy record with an absent or ambiguous source is
 * preserved as `'unknown'` and is never coerced to delegate, ignored, or any
 * other class. New producers must stamp one of the closed values below.
 */
export type ReceiptSourceCode =
	| 'delegate'
	| 'reviewer'
	| 'architect'
	| 'architect_marker'
	| 'test_engineer'
	| 'phase_override'
	| 'application_gate_staleness_release'
	| 'application_gate_denial_limit_release'
	| 'manual'
	| 'migration'
	| 'unknown';

/** Closed set form of {@link ReceiptSourceCode}. */
export const CANONICAL_RECEIPT_SOURCES: ReadonlySet<string> = new Set([
	'delegate',
	'reviewer',
	'architect',
	'architect_marker',
	'test_engineer',
	'phase_override',
	'application_gate_staleness_release',
	'application_gate_denial_limit_release',
	'manual',
	'migration',
	'unknown',
]);

/**
 * Normalize a would-be terminal source to the canonical taxonomy (issue
 * #2032 review F-001): a canonical value passes through verbatim; anything
 * else (absent, whitespace, out-of-taxonomy string such as a legacy agent
 * name) becomes the honest `'unknown'` class. Deliberately NOT a hard
 * reject — storage stays permissive for legacy tolerance, and reads of the
 * historical journal remain unchanged; only NEW commit boundaries normalize.
 */
export function normalizeReceiptSource(value: unknown): string {
	if (typeof value !== 'string') return 'unknown';
	const trimmed = value.trim();
	return CANONICAL_RECEIPT_SOURCES.has(trimmed) ? trimmed : 'unknown';
}

export interface ReceiptPredicateCheck {
	predicate: string;
	result: 'pass' | 'fail' | 'error';
	detail: string;
}

export interface ReceiptTerminal {
	outcome: ReceiptOutcome;
	source: string;
	reason?: string;
	predicate_check?: ReceiptPredicateCheck;
	event_id: string;
	committed_at: string;
	authorized_transition?: {
		actor: 'manual-override' | 'reviewer-remediation' | 'phase-override';
		reason: string;
		previous_event_id: string;
		previous_outcome?: ReceiptOutcome;
	};
}

export interface ReceiptApplicationMarker {
	outcome: ReceiptOutcome;
	source: string;
	reason?: string;
	event_id: string;
	committed_at: string;
}

export interface ReceiptGateRelease {
	source: string;
	reason?: string;
	event_id: string;
	committed_at: string;
	membership_event_id: string;
}

export interface ReceiptMembership {
	trace_id: string;
	entry_id: string;
	session_id: string;
	phase?: string;
	task_id?: string;
	agent?: string;
	critical: boolean;
	rank?: number;
	score?: number;
	committed_at: string;
	membership_event_id: string;
	grace_days: number;
	phase_close_intent_at?: string;
	phase_closed_at?: string;
	terminal?: ReceiptTerminal;
	/** Append-only audited terminal transitions; `terminal` is the current gate state. */
	terminal_history?: ReceiptTerminal[];
	application_marker?: ReceiptApplicationMarker;
	gate_release?: ReceiptGateRelease;
	cohort_id?: string;
	source_link_id?: string;
	exposure_kind: ReceiptExposureKind;
	origin: 'v2' | 'legacy';
}

export interface ReceiptRepairUncertainty {
	phase: string;
	session_id: string;
	task_id?: string;
	reason: string;
	repair_id: string;
	installed_at: string;
	raw_journal_sha256: string;
	raw_journal_bytes: number;
	salvage_through_seq: number;
	salvage_through_hash: string;
}

export type ReceiptExposureKind =
	| 'architect_directive'
	| 'delegate_directive'
	| 'manual_recall'
	| 'legacy_unknown';

interface EmptyTrace {
	trace_id: string;
	session_id: string;
	phase?: string;
	task_id?: string;
	committed_at: string;
	empty_event_id: string;
	grace_days: number;
	phase_close_intent_at?: string;
	phase_closed_at?: string;
	terminal_event_id?: string;
}

interface PhaseLifecycle {
	phase: string;
	session_id: string;
	task_id?: string;
	intent_event_id?: string;
	intent_at?: string;
	closed_event_id?: string;
	closed_at?: string;
}

interface ReceiptAuditSummary {
	original_seq: number;
	original_hash: string;
	event_id: string;
	timestamp: string;
	kind: ReceiptTransitionKind;
	trace_id?: string;
	phase?: string;
	entry_ids?: string[];
	reason_codes?: string[];
}

export type ReceiptTransitionKind =
	| 'membership_committed'
	| 'empty_retrieval_committed'
	| 'terminal_committed'
	| 'terminal_attempt_rejected'
	| 'terminal_attempt_idempotent'
	| 'authorized_transition_committed'
	| 'application_marker_committed'
	| 'gate_release_committed'
	| 'phase_close_intent'
	| 'phase_closed'
	| 'repair_uncertainty_installed'
	| 'repair_uncertainty_cleared'
	| 'legacy_imported'
	| 'legacy_unverifiable'
	| 'cutover_completed'
	| 'checkpoint';

interface JournalRecord {
	schema_version: 2;
	cutover_version: 1;
	seq: number;
	prev_hash: string;
	event_id: string;
	timestamp: string;
	kind: ReceiptTransitionKind;
	payload: Record<string, unknown>;
	hash: string;
}

interface LedgerState {
	memberships: Map<string, ReceiptMembership>;
	traceIds: Set<string>;
	emptyTraces: Map<string, EmptyTrace>;
	cutoverCompleted: boolean;
	legacyUnverifiable: boolean;
	legacyTraceRegistry: Set<string>;
	legacyUnverifiableTraceIds: Set<string>;
	phaseLifecycle: Map<string, PhaseLifecycle>;
	repairUncertainties: Map<string, ReceiptRepairUncertainty>;
	auditTail: ReceiptAuditSummary[];
	lastSeq: number;
	lastHash: string;
	recordCount: number;
	observations: KnowledgeReceiptTransitionObservation[];
}

export type ReceiptUnavailable = {
	ok: false;
	code: ReceiptStoreErrorCode | 'legacy_unverifiable';
	detail: string;
	/** Compatibility alias for hook responses that surface typed uncertainty. */
	uncertainty: string;
};

export type ReceiptLedgerResult<T> = ({ ok: true } & T) | ReceiptUnavailable;

const GENESIS_HASH = 'GENESIS';
const MAX_JOURNAL_RECORDS = 2_000;
const MAX_AUDIT_TAIL_RECORDS = 256;
const MAX_JOURNAL_BYTES = 32 * 1024 * 1024;
const MAX_ARCHIVE_RECORDS = 10_000;
const MAX_ARCHIVE_BYTES = 16 * 1024 * 1024;
const MAX_LEGACY_BYTES = 32 * 1024 * 1024;
const MAX_REPAIR_CAPTURE_BYTES = 4 * 1024 * 1024;
const MAX_REPAIR_QUARANTINE_RECORDS = 8;
const REPAIR_QUARANTINE_SCHEMA_VERSION = 1;
const DEFAULT_RECEIPT_GRACE_DAYS = 7;
const keyOf = (traceId: string, entryId: string): string =>
	`${traceId.length}:${traceId}${entryId}`;
const emptyKeyOf = (traceId: string, sessionId: string): string =>
	`${traceId.length}:${traceId}${sessionId}`;
const phaseLifecycleKey = (
	phase: string,
	sessionId: string,
	taskId?: string,
): string =>
	`${sessionId.length}:${sessionId}${phase.length}:${phase}${
		taskId === undefined ? 'u:' : `s:${taskId.length}:${taskId}`
	}`;
const repairUncertaintyKey = (phase: string, sessionId: string): string =>
	`${sessionId.length}:${sessionId}${phase.length}:${phase}`;

function nowIso(): string {
	return new Date(_internals.nowMs()).toISOString();
}

function configuredGraceDays(directory: string): number {
	try {
		const { config } = loadPluginConfigWithMeta(directory);
		return KnowledgeConfigSchema.parse(config.knowledge ?? {})
			.receipt_close_grace_days;
	} catch {
		return DEFAULT_RECEIPT_GRACE_DAYS;
	}
}

function emptyState(
	observations: KnowledgeReceiptTransitionObservation[] = [],
): LedgerState {
	return {
		memberships: new Map(),
		traceIds: new Set(),
		emptyTraces: new Map(),
		cutoverCompleted: false,
		legacyUnverifiable: false,
		legacyTraceRegistry: new Set(),
		legacyUnverifiableTraceIds: new Set(),
		phaseLifecycle: new Map(),
		repairUncertainties: new Map(),
		auditTail: [],
		lastSeq: 0,
		lastHash: GENESIS_HASH,
		recordCount: 0,
		observations,
	};
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return (
		value !== null &&
		typeof value === 'object' &&
		!Array.isArray(value) &&
		(Object.getPrototypeOf(value) === Object.prototype ||
			Object.getPrototypeOf(value) === null)
	);
}

function hasOnlyKeys(
	value: Record<string, unknown>,
	allowed: readonly string[],
): boolean {
	const allow = new Set(allowed);
	return Object.keys(value).every((key) => allow.has(key));
}

function isOptionalString(value: unknown): value is string | undefined {
	return value === undefined || typeof value === 'string';
}

function isValidTimestamp(value: unknown): value is string {
	return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function parsePredicateCheck(value: unknown): ReceiptPredicateCheck | null {
	if (!isPlainRecord(value)) return null;
	if (
		!hasOnlyKeys(value, ['predicate', 'result', 'detail']) ||
		typeof value.predicate !== 'string' ||
		(value.result !== 'pass' &&
			value.result !== 'fail' &&
			value.result !== 'error') ||
		typeof value.detail !== 'string'
	) {
		return null;
	}
	return {
		predicate: value.predicate,
		result: value.result,
		detail: value.detail,
	};
}

function parseAuthorizedTransition(
	value: unknown,
): ReceiptTerminal['authorized_transition'] | null {
	if (!isPlainRecord(value)) return null;
	if (
		!hasOnlyKeys(value, [
			'actor',
			'reason',
			'previous_event_id',
			'previous_outcome',
		]) ||
		(value.actor !== 'manual-override' &&
			value.actor !== 'reviewer-remediation' &&
			value.actor !== 'phase-override') ||
		typeof value.reason !== 'string' ||
		typeof value.previous_event_id !== 'string' ||
		(value.previous_outcome !== undefined &&
			!isReceiptOutcome(value.previous_outcome))
	) {
		return null;
	}
	return {
		actor: value.actor,
		reason: value.reason,
		previous_event_id: value.previous_event_id,
		previous_outcome: value.previous_outcome,
	};
}

function parseTerminal(value: unknown): ReceiptTerminal | null {
	if (!isPlainRecord(value)) return null;
	if (
		!hasOnlyKeys(value, [
			'outcome',
			'source',
			'reason',
			'predicate_check',
			'event_id',
			'committed_at',
			'authorized_transition',
		]) ||
		!isReceiptOutcome(value.outcome) ||
		typeof value.source !== 'string' ||
		!isOptionalString(value.reason) ||
		typeof value.event_id !== 'string' ||
		!value.event_id ||
		!isValidTimestamp(value.committed_at)
	) {
		return null;
	}
	const predicate =
		value.predicate_check === undefined
			? undefined
			: parsePredicateCheck(value.predicate_check);
	if (predicate === null) return null;
	const authorization =
		value.authorized_transition === undefined
			? undefined
			: parseAuthorizedTransition(value.authorized_transition);
	if (authorization === null) return null;
	return {
		outcome: value.outcome,
		source: value.source,
		reason: value.reason,
		predicate_check: predicate,
		event_id: value.event_id,
		committed_at: value.committed_at,
		authorized_transition: authorization,
	};
}

function parseApplicationMarker(
	value: unknown,
): ReceiptApplicationMarker | null {
	if (!isPlainRecord(value)) return null;
	if (
		!hasOnlyKeys(value, [
			'outcome',
			'source',
			'reason',
			'event_id',
			'committed_at',
		]) ||
		!isReceiptOutcome(value.outcome) ||
		typeof value.source !== 'string' ||
		!isOptionalString(value.reason) ||
		typeof value.event_id !== 'string' ||
		!value.event_id ||
		!isValidTimestamp(value.committed_at)
	) {
		return null;
	}
	return {
		outcome: value.outcome,
		source: value.source,
		reason: value.reason,
		event_id: value.event_id,
		committed_at: value.committed_at,
	};
}

function parseGateRelease(value: unknown): ReceiptGateRelease | null {
	if (!isPlainRecord(value)) return null;
	if (
		!hasOnlyKeys(value, [
			'source',
			'reason',
			'event_id',
			'committed_at',
			'membership_event_id',
		]) ||
		typeof value.source !== 'string' ||
		!isOptionalString(value.reason) ||
		typeof value.event_id !== 'string' ||
		!value.event_id ||
		!isValidTimestamp(value.committed_at) ||
		typeof value.membership_event_id !== 'string' ||
		!value.membership_event_id
	) {
		return null;
	}
	return {
		source: value.source,
		reason: value.reason,
		event_id: value.event_id,
		committed_at: value.committed_at,
		membership_event_id: value.membership_event_id,
	};
}

function parseRepairUncertainty(
	value: unknown,
): ReceiptRepairUncertainty | null {
	if (!isPlainRecord(value)) return null;
	if (
		!hasOnlyKeys(value, [
			'phase',
			'session_id',
			'task_id',
			'reason',
			'repair_id',
			'installed_at',
			'raw_journal_sha256',
			'raw_journal_bytes',
			'salvage_through_seq',
			'salvage_through_hash',
		]) ||
		typeof value.phase !== 'string' ||
		!value.phase ||
		typeof value.session_id !== 'string' ||
		!value.session_id ||
		!isOptionalString(value.task_id) ||
		typeof value.reason !== 'string' ||
		!value.reason ||
		typeof value.repair_id !== 'string' ||
		!value.repair_id ||
		!isValidTimestamp(value.installed_at) ||
		typeof value.raw_journal_sha256 !== 'string' ||
		!/^[a-f0-9]{64}$/.test(value.raw_journal_sha256) ||
		!Number.isInteger(value.raw_journal_bytes) ||
		(value.raw_journal_bytes as number) < 0 ||
		!Number.isInteger(value.salvage_through_seq) ||
		(value.salvage_through_seq as number) < 0 ||
		typeof value.salvage_through_hash !== 'string' ||
		!value.salvage_through_hash
	) {
		return null;
	}
	return {
		phase: value.phase,
		session_id: value.session_id,
		task_id: value.task_id,
		reason: value.reason,
		repair_id: value.repair_id,
		installed_at: value.installed_at,
		raw_journal_sha256: value.raw_journal_sha256,
		raw_journal_bytes: value.raw_journal_bytes as number,
		salvage_through_seq: value.salvage_through_seq as number,
		salvage_through_hash: value.salvage_through_hash,
	};
}

function parseMembership(value: unknown): ReceiptMembership | null {
	if (!isPlainRecord(value)) return null;
	if (
		!hasOnlyKeys(value, [
			'trace_id',
			'entry_id',
			'session_id',
			'phase',
			'task_id',
			'agent',
			'critical',
			'rank',
			'score',
			'committed_at',
			'membership_event_id',
			'grace_days',
			'phase_close_intent_at',
			'phase_closed_at',
			'terminal',
			'terminal_history',
			'application_marker',
			'gate_release',
			'cohort_id',
			'source_link_id',
			'exposure_kind',
			'origin',
		]) ||
		typeof value.trace_id !== 'string' ||
		!value.trace_id ||
		typeof value.entry_id !== 'string' ||
		!value.entry_id ||
		typeof value.session_id !== 'string' ||
		!value.session_id ||
		!isOptionalString(value.phase) ||
		!isOptionalString(value.task_id) ||
		!isOptionalString(value.agent) ||
		typeof value.critical !== 'boolean' ||
		(value.rank !== undefined && !Number.isFinite(value.rank)) ||
		(value.score !== undefined && !Number.isFinite(value.score)) ||
		!isValidTimestamp(value.committed_at) ||
		typeof value.membership_event_id !== 'string' ||
		!value.membership_event_id ||
		!Number.isFinite(value.grace_days) ||
		(value.grace_days as number) < 0 ||
		(value.phase_close_intent_at !== undefined &&
			!isValidTimestamp(value.phase_close_intent_at)) ||
		(value.phase_closed_at !== undefined &&
			!isValidTimestamp(value.phase_closed_at)) ||
		!isOptionalString(value.cohort_id) ||
		!isOptionalString(value.source_link_id) ||
		!isReceiptExposureKind(value.exposure_kind) ||
		(value.origin !== 'v2' && value.origin !== 'legacy')
	) {
		return null;
	}
	const terminal =
		value.terminal === undefined ? undefined : parseTerminal(value.terminal);
	if (terminal === null) return null;
	let terminalHistory: ReceiptTerminal[] | undefined;
	if (value.terminal_history !== undefined) {
		if (!Array.isArray(value.terminal_history)) return null;
		terminalHistory = [];
		for (const item of value.terminal_history) {
			const parsed = parseTerminal(item);
			if (!parsed) return null;
			terminalHistory.push(parsed);
		}
	}
	const marker =
		value.application_marker === undefined
			? undefined
			: parseApplicationMarker(value.application_marker);
	if (marker === null) return null;
	const gateRelease =
		value.gate_release === undefined
			? undefined
			: parseGateRelease(value.gate_release);
	if (gateRelease === null) return null;
	return {
		trace_id: value.trace_id,
		entry_id: value.entry_id,
		session_id: value.session_id,
		phase: value.phase,
		task_id: value.task_id,
		agent: value.agent,
		critical: value.critical,
		rank: value.rank as number | undefined,
		score: value.score as number | undefined,
		committed_at: value.committed_at,
		membership_event_id: value.membership_event_id,
		grace_days: value.grace_days as number,
		phase_close_intent_at: value.phase_close_intent_at as string | undefined,
		phase_closed_at: value.phase_closed_at as string | undefined,
		terminal,
		terminal_history: terminalHistory,
		application_marker: marker,
		gate_release: gateRelease,
		cohort_id: value.cohort_id,
		source_link_id: value.source_link_id,
		exposure_kind: value.exposure_kind,
		origin: value.origin,
	};
}

function isReceiptExposureKind(value: unknown): value is ReceiptExposureKind {
	return (
		value === 'architect_directive' ||
		value === 'delegate_directive' ||
		value === 'manual_recall' ||
		value === 'legacy_unknown'
	);
}

function legacyExposureKind(
	event: Record<string, unknown>,
): ReceiptExposureKind {
	if (event.retrieval_mode === 'auto_injection') return 'architect_directive';
	if (event.retrieval_mode === 'delegate_inject') return 'delegate_directive';
	if (event.retrieval_mode === 'manual') return 'manual_recall';
	return 'legacy_unknown';
}

function normalizeExposureKind(value: unknown): ReceiptExposureKind {
	if (isReceiptExposureKind(value)) return value;
	// Normalize the short-lived pre-schema spelling before persistence. Strict
	// reload may not admit an arbitrary enum, but existing callers must not write
	// a journal row that immediately poisons their next receipt transition.
	if (value === 'delegate') return 'delegate_directive';
	return 'legacy_unknown';
}

interface ArchivedEmptyTrace extends EmptyTrace {
	summary_kind: 'empty_trace';
}

type ArchiveSummary = ReceiptMembership | ArchivedEmptyTrace;

function parseEmptyTrace(
	value: unknown,
	requireSummaryKind = false,
): EmptyTrace | ArchivedEmptyTrace | null {
	if (!isPlainRecord(value)) return null;
	if (
		!hasOnlyKeys(value, [
			'trace_id',
			'session_id',
			'phase',
			'task_id',
			'committed_at',
			'empty_event_id',
			'grace_days',
			'phase_close_intent_at',
			'phase_closed_at',
			'terminal_event_id',
			'summary_kind',
		]) ||
		(requireSummaryKind && value.summary_kind !== 'empty_trace') ||
		(!requireSummaryKind && value.summary_kind !== undefined) ||
		typeof value.trace_id !== 'string' ||
		!value.trace_id ||
		typeof value.session_id !== 'string' ||
		!value.session_id ||
		!isOptionalString(value.phase) ||
		!isOptionalString(value.task_id) ||
		!isValidTimestamp(value.committed_at) ||
		typeof value.empty_event_id !== 'string' ||
		!value.empty_event_id ||
		!Number.isFinite(value.grace_days) ||
		(value.grace_days as number) < 0 ||
		(value.phase_close_intent_at !== undefined &&
			!isValidTimestamp(value.phase_close_intent_at)) ||
		(value.phase_closed_at !== undefined &&
			!isValidTimestamp(value.phase_closed_at)) ||
		!isOptionalString(value.terminal_event_id)
	) {
		return null;
	}
	const trace: EmptyTrace = {
		trace_id: value.trace_id,
		session_id: value.session_id,
		phase: value.phase,
		task_id: value.task_id,
		committed_at: value.committed_at,
		empty_event_id: value.empty_event_id,
		grace_days: value.grace_days as number,
		phase_close_intent_at: value.phase_close_intent_at as string | undefined,
		phase_closed_at: value.phase_closed_at as string | undefined,
		terminal_event_id: value.terminal_event_id,
	};
	return requireSummaryKind ? { ...trace, summary_kind: 'empty_trace' } : trace;
}

function parsePhaseLifecycle(value: unknown): PhaseLifecycle | null {
	if (!isPlainRecord(value)) return null;
	if (
		!hasOnlyKeys(value, [
			'phase',
			'session_id',
			'task_id',
			'intent_event_id',
			'intent_at',
			'closed_event_id',
			'closed_at',
		]) ||
		typeof value.phase !== 'string' ||
		!value.phase ||
		typeof value.session_id !== 'string' ||
		!value.session_id ||
		!isOptionalString(value.task_id) ||
		!isOptionalString(value.intent_event_id) ||
		(value.intent_at !== undefined && !isValidTimestamp(value.intent_at)) ||
		!isOptionalString(value.closed_event_id) ||
		(value.closed_at !== undefined && !isValidTimestamp(value.closed_at))
	) {
		return null;
	}
	return {
		phase: value.phase,
		session_id: value.session_id,
		task_id: value.task_id,
		intent_event_id: value.intent_event_id,
		intent_at: value.intent_at as string | undefined,
		closed_event_id: value.closed_event_id,
		closed_at: value.closed_at as string | undefined,
	};
}

function parseAuditSummary(value: unknown): ReceiptAuditSummary | null {
	if (!isPlainRecord(value)) return null;
	if (
		!hasOnlyKeys(value, [
			'original_seq',
			'original_hash',
			'event_id',
			'timestamp',
			'kind',
			'trace_id',
			'phase',
			'entry_ids',
			'reason_codes',
		]) ||
		!Number.isInteger(value.original_seq) ||
		(value.original_seq as number) <= 0 ||
		typeof value.original_hash !== 'string' ||
		!value.original_hash ||
		typeof value.event_id !== 'string' ||
		!value.event_id ||
		!isValidTimestamp(value.timestamp) ||
		typeof value.kind !== 'string' ||
		!isOptionalString(value.trace_id) ||
		!isOptionalString(value.phase) ||
		(value.entry_ids !== undefined &&
			(!Array.isArray(value.entry_ids) ||
				!value.entry_ids.every(
					(entryId) => typeof entryId === 'string' && !!entryId,
				))) ||
		(value.reason_codes !== undefined &&
			(!Array.isArray(value.reason_codes) ||
				!value.reason_codes.every(
					(reason) => typeof reason === 'string' && !!reason,
				)))
	) {
		return null;
	}
	const kind = value.kind as ReceiptTransitionKind;
	if (
		!(
			[
				'membership_committed',
				'empty_retrieval_committed',
				'terminal_committed',
				'terminal_attempt_rejected',
				'terminal_attempt_idempotent',
				'authorized_transition_committed',
				'application_marker_committed',
				'gate_release_committed',
				'phase_close_intent',
				'phase_closed',
				'repair_uncertainty_installed',
				'repair_uncertainty_cleared',
				'legacy_imported',
				'legacy_unverifiable',
				'cutover_completed',
				'checkpoint',
			] as unknown[]
		).includes(kind)
	)
		return null;
	return {
		original_seq: value.original_seq as number,
		original_hash: value.original_hash,
		event_id: value.event_id,
		timestamp: value.timestamp,
		kind,
		trace_id: value.trace_id,
		phase: value.phase,
		entry_ids: value.entry_ids as string[] | undefined,
		reason_codes: value.reason_codes as string[] | undefined,
	};
}

function summarizeRecord(record: JournalRecord): ReceiptAuditSummary {
	const payload = record.payload;
	const entryIds = new Set<string>();
	for (const collection of [
		payload.memberships,
		payload.transitions,
		payload.markers,
		payload.rejected,
	]) {
		if (!Array.isArray(collection)) continue;
		for (const item of collection) {
			if (isPlainRecord(item) && typeof item.entry_id === 'string') {
				entryIds.add(item.entry_id);
			}
		}
	}
	for (const entryId of Array.isArray(payload.entry_ids)
		? payload.entry_ids
		: []) {
		if (typeof entryId === 'string') entryIds.add(entryId);
	}
	const reasonCodes = new Set<string>();
	for (const reason of Array.isArray(payload.reason_codes)
		? payload.reason_codes
		: []) {
		if (typeof reason === 'string') reasonCodes.add(reason);
	}
	for (const rejected of Array.isArray(payload.rejected)
		? payload.rejected
		: []) {
		if (isPlainRecord(rejected) && typeof rejected.reason === 'string') {
			reasonCodes.add(rejected.reason);
		}
	}
	return {
		original_seq: record.seq,
		original_hash: record.hash,
		event_id: record.event_id,
		timestamp: record.timestamp,
		kind: record.kind,
		trace_id:
			typeof payload.trace_id === 'string'
				? payload.trace_id
				: typeof payload.empty_trace_id === 'string'
					? payload.empty_trace_id
					: undefined,
		phase: typeof payload.phase === 'string' ? payload.phase : undefined,
		entry_ids: entryIds.size ? [...entryIds].sort() : undefined,
		reason_codes: reasonCodes.size ? [...reasonCodes].sort() : undefined,
	};
}

function parseArchiveSummary(value: unknown): ArchiveSummary | null {
	const membership = parseMembership(value);
	if (membership) return membership;
	return parseEmptyTrace(value, true) as ArchivedEmptyTrace | null;
}

function archiveKey(summary: ArchiveSummary): string {
	return 'entry_id' in summary
		? `membership:${keyOf(summary.trace_id, summary.entry_id)}`
		: `empty:${emptyKeyOf(summary.trace_id, summary.session_id)}`;
}

function applyRecord(state: LedgerState, record: JournalRecord): void {
	const memberships = record.payload.memberships;
	if (record.kind === 'checkpoint') {
		state.memberships.clear();
		state.traceIds.clear();
		state.emptyTraces.clear();
		state.legacyTraceRegistry.clear();
		state.legacyUnverifiableTraceIds.clear();
		state.phaseLifecycle.clear();
		state.repairUncertainties.clear();
		state.auditTail = [];
		if (Array.isArray(memberships)) {
			for (const value of memberships) {
				const membership = parseMembership(value);
				if (membership) {
					state.traceIds.add(membership.trace_id);
					state.memberships.set(
						keyOf(membership.trace_id, membership.entry_id),
						membership,
					);
				}
			}
		}
		for (const value of Array.isArray(record.payload.empty_traces)
			? record.payload.empty_traces
			: []) {
			const trace = parseEmptyTrace(value);
			if (trace && !('summary_kind' in trace)) {
				state.emptyTraces.set(emptyKeyOf(trace.trace_id, trace.session_id), {
					...trace,
				});
			}
		}
		for (const traceId of Array.isArray(record.payload.legacy_trace_registry)
			? record.payload.legacy_trace_registry
			: []) {
			if (typeof traceId === 'string' && traceId) {
				state.legacyTraceRegistry.add(traceId);
			}
		}
		for (const traceId of Array.isArray(
			record.payload.legacy_unverifiable_trace_ids,
		)
			? record.payload.legacy_unverifiable_trace_ids
			: []) {
			if (typeof traceId === 'string' && traceId) {
				state.legacyUnverifiableTraceIds.add(traceId);
			}
		}
		for (const value of Array.isArray(record.payload.phase_lifecycle)
			? record.payload.phase_lifecycle
			: []) {
			const lifecycle = parsePhaseLifecycle(value);
			if (lifecycle)
				state.phaseLifecycle.set(
					phaseLifecycleKey(
						lifecycle.phase,
						lifecycle.session_id,
						lifecycle.task_id,
					),
					lifecycle,
				);
		}
		for (const value of Array.isArray(record.payload.repair_uncertainties)
			? record.payload.repair_uncertainties
			: []) {
			const uncertainty = parseRepairUncertainty(value);
			if (uncertainty) {
				state.repairUncertainties.set(
					repairUncertaintyKey(uncertainty.phase, uncertainty.session_id),
					uncertainty,
				);
			}
		}
		for (const value of Array.isArray(record.payload.audit_tail)
			? record.payload.audit_tail
			: []) {
			const summary = parseAuditSummary(value);
			if (summary) state.auditTail.push(summary);
		}
		state.cutoverCompleted = record.payload.cutover_completed === true;
		state.legacyUnverifiable = record.payload.legacy_unverifiable === true;
	} else if (
		record.kind === 'membership_committed' ||
		record.kind === 'legacy_imported'
	) {
		if (Array.isArray(memberships)) {
			for (const value of memberships) {
				const membership = parseMembership(value);
				if (membership) {
					state.traceIds.add(membership.trace_id);
					state.memberships.set(
						keyOf(membership.trace_id, membership.entry_id),
						membership,
					);
					if (record.kind === 'legacy_imported') {
						state.legacyTraceRegistry.add(membership.trace_id);
					}
				}
			}
		}
	} else if (record.kind === 'empty_retrieval_committed') {
		const trace = parseEmptyTrace(record.payload.trace);
		if (trace && !('summary_kind' in trace)) {
			state.emptyTraces.set(emptyKeyOf(trace.trace_id, trace.session_id), {
				...trace,
			});
		}
	} else if (
		record.kind === 'terminal_committed' ||
		record.kind === 'authorized_transition_committed'
	) {
		for (const value of Array.isArray(record.payload.transitions)
			? record.payload.transitions
			: []) {
			const transition = value as {
				trace_id: string;
				entry_id: string;
				terminal: unknown;
				cohort_id?: string;
				source_link_id?: string;
			};
			const membership = state.memberships.get(
				keyOf(transition.trace_id, transition.entry_id),
			);
			const terminal = parseTerminal(transition.terminal);
			if (membership && terminal) {
				const history = membership.terminal_history ?? [];
				if (!history.some((item) => item.event_id === terminal.event_id)) {
					history.push({ ...terminal });
				}
				membership.terminal_history = history;
				membership.terminal = { ...terminal };
				if (transition.cohort_id !== undefined) {
					membership.cohort_id = transition.cohort_id;
				}
				if (transition.source_link_id !== undefined) {
					membership.source_link_id = transition.source_link_id;
				}
			}
		}
		const emptyTraceId = record.payload.empty_trace_id;
		if (typeof emptyTraceId === 'string') {
			const emptySessionId = record.payload.empty_trace_session_id;
			const trace =
				typeof emptySessionId === 'string'
					? state.emptyTraces.get(emptyKeyOf(emptyTraceId, emptySessionId))
					: [...state.emptyTraces.values()].find(
							(candidate) => candidate.trace_id === emptyTraceId,
						);
			if (trace) trace.terminal_event_id = record.event_id;
		}
	} else if (record.kind === 'application_marker_committed') {
		for (const value of Array.isArray(record.payload.transitions)
			? record.payload.transitions
			: []) {
			const transition = value as {
				trace_id: string;
				entry_id: string;
				terminal: unknown;
			};
			const membership = state.memberships.get(
				keyOf(transition.trace_id, transition.entry_id),
			);
			const terminal = parseTerminal(transition.terminal);
			if (membership && terminal) {
				const history = membership.terminal_history ?? [];
				if (!history.some((item) => item.event_id === terminal.event_id)) {
					history.push({ ...terminal });
				}
				membership.terminal_history = history;
				membership.terminal = { ...terminal };
			}
		}
		for (const value of Array.isArray(record.payload.markers)
			? record.payload.markers
			: []) {
			const transition = value as {
				trace_id: string;
				entry_id: string;
				marker: unknown;
			};
			const membership = state.memberships.get(
				keyOf(transition.trace_id, transition.entry_id),
			);
			const marker = parseApplicationMarker(transition.marker);
			if (membership && marker) {
				membership.application_marker = { ...marker };
			}
		}
	} else if (record.kind === 'gate_release_committed') {
		for (const value of Array.isArray(record.payload.releases)
			? record.payload.releases
			: []) {
			const transition = value as {
				trace_id: string;
				entry_id: string;
				release: unknown;
			};
			const membership = state.memberships.get(
				keyOf(transition.trace_id, transition.entry_id),
			);
			const release = parseGateRelease(transition.release);
			if (
				membership &&
				release &&
				release.membership_event_id === membership.membership_event_id
			) {
				membership.gate_release = { ...release };
			}
		}
	} else if (
		record.kind === 'phase_close_intent' ||
		record.kind === 'phase_closed'
	) {
		const phase = record.payload.phase;
		const sessionId = record.payload.session_id;
		const taskId = record.payload.task_id;
		if (
			typeof phase === 'string' &&
			typeof sessionId === 'string' &&
			isOptionalString(taskId)
		) {
			const lifecycleKey = phaseLifecycleKey(phase, sessionId, taskId);
			const lifecycle = state.phaseLifecycle.get(lifecycleKey) ?? {
				phase,
				session_id: sessionId,
				task_id: taskId,
			};
			if (record.kind === 'phase_close_intent' && !lifecycle.intent_event_id) {
				lifecycle.intent_event_id = record.event_id;
				lifecycle.intent_at = record.timestamp;
			} else if (record.kind === 'phase_closed' && !lifecycle.closed_event_id) {
				lifecycle.closed_event_id = record.event_id;
				lifecycle.closed_at = record.timestamp;
			}
			state.phaseLifecycle.set(lifecycleKey, lifecycle);
			for (const membership of state.memberships.values()) {
				if (
					membership.phase !== phase ||
					membership.session_id !== sessionId ||
					membership.task_id !== taskId
				)
					continue;
				if (
					record.kind === 'phase_close_intent' &&
					!membership.phase_close_intent_at
				)
					membership.phase_close_intent_at = record.timestamp;
				else if (record.kind === 'phase_closed' && !membership.phase_closed_at)
					membership.phase_closed_at = record.timestamp;
			}
			for (const trace of state.emptyTraces.values()) {
				if (
					trace.phase !== phase ||
					trace.session_id !== sessionId ||
					trace.task_id !== taskId
				)
					continue;
				if (
					record.kind === 'phase_close_intent' &&
					!trace.phase_close_intent_at
				) {
					trace.phase_close_intent_at = record.timestamp;
				} else if (record.kind === 'phase_closed' && !trace.phase_closed_at) {
					trace.phase_closed_at = record.timestamp;
				}
			}
		}
	} else if (record.kind === 'repair_uncertainty_installed') {
		const uncertainty = parseRepairUncertainty(record.payload.uncertainty);
		if (uncertainty) {
			state.repairUncertainties.set(
				repairUncertaintyKey(uncertainty.phase, uncertainty.session_id),
				uncertainty,
			);
		}
	} else if (record.kind === 'repair_uncertainty_cleared') {
		const phase = record.payload.phase;
		const sessionId = record.payload.session_id;
		const repairId = record.payload.repair_id;
		if (
			typeof phase === 'string' &&
			phase &&
			typeof sessionId === 'string' &&
			sessionId
		) {
			const key = repairUncertaintyKey(phase, sessionId);
			const existing = state.repairUncertainties.get(key);
			if (!repairId || existing?.repair_id === repairId) {
				state.repairUncertainties.delete(key);
			}
		}
	} else if (record.kind === 'cutover_completed') {
		state.cutoverCompleted = true;
		for (const traceId of Array.isArray(record.payload.imported_trace_ids)
			? record.payload.imported_trace_ids
			: []) {
			if (typeof traceId === 'string' && traceId)
				state.legacyTraceRegistry.add(traceId);
		}
	} else if (record.kind === 'legacy_unverifiable') {
		state.legacyUnverifiable = true;
		for (const traceId of Array.isArray(record.payload.trace_ids)
			? record.payload.trace_ids
			: []) {
			if (typeof traceId === 'string' && traceId) {
				state.legacyUnverifiableTraceIds.add(traceId);
			}
		}
	}
	if (record.kind !== 'checkpoint') {
		state.auditTail.push(summarizeRecord(record));
		if (state.auditTail.length > MAX_AUDIT_TAIL_RECORDS) {
			state.auditTail.splice(
				0,
				state.auditTail.length - MAX_AUDIT_TAIL_RECORDS,
			);
		}
	}
	state.lastSeq = record.seq;
	state.lastHash = record.hash;
	state.recordCount++;
}

function isTerminalTransition(value: unknown): boolean {
	if (!isPlainRecord(value)) return false;
	return (
		hasOnlyKeys(value, [
			'trace_id',
			'entry_id',
			'terminal',
			'cohort_id',
			'source_link_id',
		]) &&
		typeof value.trace_id === 'string' &&
		!!value.trace_id &&
		typeof value.entry_id === 'string' &&
		!!value.entry_id &&
		parseTerminal(value.terminal) !== null &&
		isOptionalString(value.cohort_id) &&
		isOptionalString(value.source_link_id)
	);
}

function isMarkerTransition(value: unknown): boolean {
	if (!isPlainRecord(value)) return false;
	return (
		hasOnlyKeys(value, ['trace_id', 'entry_id', 'marker']) &&
		typeof value.trace_id === 'string' &&
		!!value.trace_id &&
		typeof value.entry_id === 'string' &&
		!!value.entry_id &&
		parseApplicationMarker(value.marker) !== null
	);
}

function isAuthorizationPayload(value: unknown): boolean {
	if (!isPlainRecord(value)) return false;
	return (
		hasOnlyKeys(value, [
			'actor',
			'reason',
			'expected_event_id',
			'expected_outcome',
		]) &&
		(value.actor === 'manual-override' ||
			value.actor === 'reviewer-remediation' ||
			value.actor === 'phase-override') &&
		typeof value.reason === 'string' &&
		typeof value.expected_event_id === 'string' &&
		(value.expected_outcome === undefined ||
			isReceiptOutcome(value.expected_outcome))
	);
}

function validateRecordPayload(row: JournalRecord): boolean {
	const payload = row.payload;
	if (!isPlainRecord(payload)) return false;
	switch (row.kind) {
		case 'membership_committed':
		case 'legacy_imported':
			return (
				hasOnlyKeys(payload, ['memberships']) &&
				Array.isArray(payload.memberships) &&
				payload.memberships.length > 0 &&
				payload.memberships.every((item) => parseMembership(item) !== null)
			);
		case 'empty_retrieval_committed':
			return (
				hasOnlyKeys(payload, ['trace']) &&
				parseEmptyTrace(payload.trace) !== null
			);
		case 'terminal_committed':
		case 'authorized_transition_committed': {
			if (
				!hasOnlyKeys(payload, [
					'transitions',
					'authorization',
					'empty_trace_id',
					'empty_trace_session_id',
				])
			)
				return false;
			const transitionsValid =
				payload.transitions === undefined ||
				(Array.isArray(payload.transitions) &&
					payload.transitions.every(isTerminalTransition));
			const emptyValid =
				payload.empty_trace_id === undefined ||
				(typeof payload.empty_trace_id === 'string' &&
					!!payload.empty_trace_id &&
					typeof payload.empty_trace_session_id === 'string' &&
					!!payload.empty_trace_session_id);
			const authorizationValid =
				payload.authorization === undefined ||
				isAuthorizationPayload(payload.authorization);
			return (
				transitionsValid &&
				emptyValid &&
				authorizationValid &&
				(payload.transitions !== undefined ||
					payload.empty_trace_id !== undefined)
			);
		}
		case 'application_marker_committed':
			return (
				hasOnlyKeys(payload, ['markers', 'transitions']) &&
				(payload.markers === undefined ||
					(Array.isArray(payload.markers) &&
						payload.markers.every(isMarkerTransition))) &&
				(payload.transitions === undefined ||
					(Array.isArray(payload.transitions) &&
						payload.transitions.every(isTerminalTransition))) &&
				(payload.markers !== undefined || payload.transitions !== undefined)
			);
		case 'gate_release_committed':
			return (
				hasOnlyKeys(payload, ['releases']) &&
				Array.isArray(payload.releases) &&
				payload.releases.every(
					(item) =>
						isPlainRecord(item) &&
						hasOnlyKeys(item, ['trace_id', 'entry_id', 'release']) &&
						typeof item.trace_id === 'string' &&
						!!item.trace_id &&
						typeof item.entry_id === 'string' &&
						!!item.entry_id &&
						parseGateRelease(item.release) !== null,
				)
			);
		case 'terminal_attempt_idempotent':
			return (
				hasOnlyKeys(payload, ['trace_id', 'entry_ids']) &&
				typeof payload.trace_id === 'string' &&
				Array.isArray(payload.entry_ids) &&
				payload.entry_ids.every(
					(entryId) => typeof entryId === 'string' && !!entryId,
				)
			);
		case 'terminal_attempt_rejected':
			return (
				hasOnlyKeys(payload, ['trace_id', 'rejected']) &&
				typeof payload.trace_id === 'string' &&
				Array.isArray(payload.rejected) &&
				payload.rejected.every(
					(item) =>
						isPlainRecord(item) &&
						hasOnlyKeys(item, ['entry_id', 'reason']) &&
						typeof item.entry_id === 'string' &&
						typeof item.reason === 'string',
				)
			);
		case 'phase_close_intent':
		case 'phase_closed':
			return (
				hasOnlyKeys(payload, ['phase', 'session_id', 'task_id']) &&
				typeof payload.phase === 'string' &&
				!!payload.phase &&
				typeof payload.session_id === 'string' &&
				!!payload.session_id &&
				isOptionalString(payload.task_id)
			);
		case 'repair_uncertainty_installed':
			return (
				hasOnlyKeys(payload, ['uncertainty']) &&
				parseRepairUncertainty(payload.uncertainty) !== null
			);
		case 'repair_uncertainty_cleared':
			return (
				hasOnlyKeys(payload, [
					'phase',
					'session_id',
					'task_id',
					'repair_id',
					'cleared_by_event_id',
					'cleared_by_trace_id',
					'cleared_by_kind',
				]) &&
				typeof payload.phase === 'string' &&
				!!payload.phase &&
				typeof payload.session_id === 'string' &&
				!!payload.session_id &&
				isOptionalString(payload.task_id) &&
				isOptionalString(payload.repair_id) &&
				typeof payload.cleared_by_event_id === 'string' &&
				!!payload.cleared_by_event_id &&
				typeof payload.cleared_by_trace_id === 'string' &&
				!!payload.cleared_by_trace_id &&
				(payload.cleared_by_kind === 'membership_committed' ||
					payload.cleared_by_kind === 'empty_retrieval_committed')
			);
		case 'legacy_unverifiable':
			return (
				hasOnlyKeys(payload, ['reason_codes', 'trace_ids']) &&
				Array.isArray(payload.reason_codes) &&
				payload.reason_codes.every(
					(reason) => typeof reason === 'string' && !!reason,
				) &&
				(payload.trace_ids === undefined ||
					(Array.isArray(payload.trace_ids) &&
						payload.trace_ids.every(
							(traceId) => typeof traceId === 'string' && !!traceId,
						)))
			);
		case 'cutover_completed':
			return (
				hasOnlyKeys(payload, ['imported_count', 'imported_trace_ids']) &&
				Number.isInteger(payload.imported_count) &&
				(payload.imported_count as number) >= 0 &&
				Array.isArray(payload.imported_trace_ids) &&
				payload.imported_trace_ids.every(
					(traceId) => typeof traceId === 'string' && !!traceId,
				)
			);
		case 'checkpoint':
			return (
				hasOnlyKeys(payload, [
					'memberships',
					'empty_traces',
					'cutover_completed',
					'legacy_unverifiable',
					'legacy_trace_registry',
					'legacy_unverifiable_trace_ids',
					'phase_lifecycle',
					'repair_uncertainties',
					'audit_tail',
				]) &&
				Array.isArray(payload.memberships) &&
				payload.memberships.every((item) => parseMembership(item) !== null) &&
				Array.isArray(payload.empty_traces) &&
				payload.empty_traces.every((item) => parseEmptyTrace(item) !== null) &&
				typeof payload.cutover_completed === 'boolean' &&
				typeof payload.legacy_unverifiable === 'boolean' &&
				Array.isArray(payload.legacy_trace_registry) &&
				payload.legacy_trace_registry.every(
					(traceId) => typeof traceId === 'string' && !!traceId,
				) &&
				Array.isArray(payload.legacy_unverifiable_trace_ids) &&
				payload.legacy_unverifiable_trace_ids.every(
					(traceId) => typeof traceId === 'string' && !!traceId,
				) &&
				Array.isArray(payload.phase_lifecycle) &&
				payload.phase_lifecycle.every(
					(item) => parsePhaseLifecycle(item) !== null,
				) &&
				Array.isArray(payload.repair_uncertainties) &&
				payload.repair_uncertainties.every(
					(item) => parseRepairUncertainty(item) !== null,
				) &&
				Array.isArray(payload.audit_tail) &&
				payload.audit_tail.length <= MAX_AUDIT_TAIL_RECORDS &&
				payload.audit_tail.every((item) => parseAuditSummary(item) !== null)
			);
	}
}

function validateRecord(value: unknown, state: LedgerState): JournalRecord {
	if (!value || typeof value !== 'object')
		throw new Error('record is not an object');
	const row = value as JournalRecord;
	if (
		row.schema_version !== RECEIPT_SCHEMA_VERSION ||
		row.cutover_version !== RECEIPT_CUTOVER_VERSION ||
		row.seq !== state.lastSeq + 1 ||
		row.prev_hash !== state.lastHash ||
		!Number.isInteger(row.seq) ||
		typeof row.event_id !== 'string' ||
		!row.event_id ||
		!isValidTimestamp(row.timestamp) ||
		!(
			[
				'membership_committed',
				'empty_retrieval_committed',
				'terminal_committed',
				'terminal_attempt_rejected',
				'terminal_attempt_idempotent',
				'authorized_transition_committed',
				'application_marker_committed',
				'gate_release_committed',
				'phase_close_intent',
				'phase_closed',
				'repair_uncertainty_installed',
				'repair_uncertainty_cleared',
				'legacy_imported',
				'legacy_unverifiable',
				'cutover_completed',
				'checkpoint',
			] as unknown[]
		).includes(row.kind) ||
		typeof row.hash !== 'string'
	)
		throw new Error('record contract or chain mismatch');
	const { hash, ...withoutHash } = row;
	if (receiptRecordHash(withoutHash) !== hash)
		throw new Error('record hash mismatch');
	if (!validateRecordPayload(row)) throw new Error('record payload mismatch');
	return row;
}

async function loadState(
	paths: ReceiptLedgerPaths,
	observations: KnowledgeReceiptTransitionObservation[] = [],
): Promise<LedgerState> {
	const raw = await readUtf8IfPresent(paths.journal, MAX_JOURNAL_BYTES);
	const state = emptyState(observations);
	if (!raw) return state;
	const lines = raw.split('\n');
	const endedWithNewline = raw.endsWith('\n');
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!line) continue;
		try {
			applyRecord(state, validateRecord(JSON.parse(line), state));
		} catch (error) {
			const tailDetail =
				i === lines.length - 1 && !endedWithNewline
					? ' (including an unterminated final record)'
					: '';
			throw new ReceiptStoreError(
				'store_corrupt',
				`receipt journal corruption at line ${i + 1}${tailDetail}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	return state;
}

function makeRecord(
	state: LedgerState,
	kind: ReceiptTransitionKind,
	payload: Record<string, unknown>,
	eventId = randomUUID(),
): JournalRecord {
	const withoutHash = {
		schema_version: RECEIPT_SCHEMA_VERSION as 2,
		cutover_version: RECEIPT_CUTOVER_VERSION as 1,
		seq: state.lastSeq + 1,
		prev_hash: state.lastHash,
		event_id: eventId,
		timestamp: nowIso(),
		kind,
		payload,
	};
	return { ...withoutHash, hash: receiptRecordHash(withoutHash) };
}

async function appendRecord(
	paths: ReceiptLedgerPaths,
	state: LedgerState,
	row: JournalRecord,
): Promise<void> {
	await appendFsynced(paths.journal, `${JSON.stringify(row)}\n`);
	applyRecord(state, row);
	queueRecordObservations(state, row);
}

function rejectionReasonCode(
	value: unknown,
): KnowledgeReceiptObservationReasonCode {
	switch (value) {
		case 'trace_not_found':
		case 'id_not_in_trace':
		case 'wrong_session':
		case 'wrong_phase':
		case 'wrong_task':
		case 'duplicate_conflicting_terminal':
		case 'event_id_conflict':
		case 'invalid_outcome':
		case 'empty_receipt':
		case 'unauthorized_transition':
		case 'legacy_unverifiable':
			return value;
		default:
			return 'store_unavailable';
	}
}

function queueRecordObservations(state: LedgerState, row: JournalRecord): void {
	const base = {
		transition: row.kind,
		schemaVersion: RECEIPT_SCHEMA_VERSION,
	} as const;
	if (row.kind === 'membership_committed' || row.kind === 'legacy_imported') {
		for (const value of Array.isArray(row.payload.memberships)
			? row.payload.memberships
			: []) {
			const membership = parseMembership(value);
			if (!membership) continue;
			state.observations.push({
				...base,
				reasonCode: 'committed',
				knowledgeTraceId: membership.trace_id,
				knowledgeEntryId: membership.entry_id,
				sessionId: membership.session_id,
				taskId: membership.task_id,
				phase: membership.phase,
				receiptOutcome: membership.terminal?.outcome,
				receiptSource: membership.terminal?.source,
			});
		}
		return;
	}
	if (row.kind === 'empty_retrieval_committed') {
		const trace = row.payload.trace as EmptyTrace | undefined;
		if (trace?.trace_id) {
			state.observations.push({
				...base,
				reasonCode: 'committed',
				knowledgeTraceId: trace.trace_id,
				sessionId: trace.session_id,
				taskId: trace.task_id,
				phase: trace.phase,
				receiptOutcome: trace.terminal_event_id ? 'no_relevant' : undefined,
			});
		}
		return;
	}
	if (
		row.kind === 'terminal_committed' ||
		row.kind === 'authorized_transition_committed' ||
		row.kind === 'application_marker_committed'
	) {
		const values =
			row.kind === 'application_marker_committed'
				? row.payload.markers
				: row.payload.transitions;
		for (const value of Array.isArray(values) ? values : []) {
			const transition = value as {
				trace_id?: string;
				entry_id?: string;
				terminal?: ReceiptTerminal;
				marker?: ReceiptApplicationMarker;
			};
			const outcome =
				transition.terminal?.outcome ?? transition.marker?.outcome;
			const source = transition.terminal?.source ?? transition.marker?.source;
			state.observations.push({
				...base,
				reasonCode: 'committed',
				knowledgeTraceId: transition.trace_id,
				knowledgeEntryId: transition.entry_id,
				receiptOutcome: outcome,
				receiptSource: source,
			});
		}
		if (typeof row.payload.empty_trace_id === 'string') {
			state.observations.push({
				...base,
				reasonCode: 'committed',
				knowledgeTraceId: row.payload.empty_trace_id,
				receiptOutcome: 'no_relevant',
			});
		}
		return;
	}
	if (row.kind === 'terminal_attempt_rejected') {
		for (const value of Array.isArray(row.payload.rejected)
			? row.payload.rejected
			: []) {
			const rejected = value as { entry_id?: string; reason?: string };
			state.observations.push({
				...base,
				reasonCode: rejectionReasonCode(rejected.reason),
				knowledgeTraceId:
					typeof row.payload.trace_id === 'string'
						? row.payload.trace_id
						: undefined,
				knowledgeEntryId: rejected.entry_id,
			});
		}
		return;
	}
	if (row.kind === 'gate_release_committed') {
		for (const value of Array.isArray(row.payload.releases)
			? row.payload.releases
			: []) {
			if (!isPlainRecord(value)) continue;
			const release = parseGateRelease(value.release);
			if (!release) continue;
			state.observations.push({
				...base,
				reasonCode: 'committed',
				knowledgeTraceId:
					typeof value.trace_id === 'string' ? value.trace_id : undefined,
				knowledgeEntryId:
					typeof value.entry_id === 'string' ? value.entry_id : undefined,
				receiptSource: release.source,
			});
		}
		return;
	}
	if (row.kind === 'terminal_attempt_idempotent') {
		for (const entryId of Array.isArray(row.payload.entry_ids)
			? row.payload.entry_ids
			: []) {
			state.observations.push({
				...base,
				reasonCode: 'idempotent',
				knowledgeTraceId:
					typeof row.payload.trace_id === 'string'
						? row.payload.trace_id
						: undefined,
				knowledgeEntryId: typeof entryId === 'string' ? entryId : undefined,
			});
		}
		return;
	}
	state.observations.push({
		...base,
		reasonCode:
			row.kind === 'legacy_unverifiable' ? 'legacy_unverifiable' : 'committed',
		knowledgeTraceId:
			typeof row.payload.trace_id === 'string'
				? row.payload.trace_id
				: undefined,
		phase:
			typeof row.payload.phase === 'string' ? row.payload.phase : undefined,
	});
}

async function writeSnapshot(
	paths: ReceiptLedgerPaths,
	state: LedgerState,
): Promise<void> {
	const snapshot = {
		schema_version: RECEIPT_SCHEMA_VERSION,
		cutover_version: RECEIPT_CUTOVER_VERSION,
		authoritative: false,
		rebuildable: true,
		through_seq: state.lastSeq,
		through_hash: state.lastHash,
		memberships: [...state.memberships.values()],
		empty_traces: [...state.emptyTraces.values()],
		cutover_completed: state.cutoverCompleted,
		legacy_unverifiable: state.legacyUnverifiable,
		legacy_trace_registry: [...state.legacyTraceRegistry].sort(),
		legacy_unverifiable_trace_ids: [...state.legacyUnverifiableTraceIds].sort(),
		phase_lifecycle: [...state.phaseLifecycle.values()],
		repair_uncertainties: [...state.repairUncertainties.values()],
		audit_tail: state.auditTail,
	};
	await atomicWriteFsynced(paths.snapshot, `${JSON.stringify(snapshot)}\n`);
}

function unavailable(error: unknown): ReceiptUnavailable {
	if (error instanceof ReceiptStoreError)
		return {
			ok: false,
			code: error.code,
			detail: error.message,
			uncertainty: error.message,
		};
	const detail = error instanceof Error ? error.message : String(error);
	return { ok: false, code: 'store_unavailable', detail, uncertainty: detail };
}

async function ensureCutoverLocked(
	paths: ReceiptLedgerPaths,
	state: LedgerState,
	graceDays: number,
): Promise<void> {
	if (state.cutoverCompleted) return;
	const imported: ReceiptMembership[] = [];
	const unverifiable = new Set<string>();
	const unverifiableTraceIds = new Set<string>();
	if (existsSync(paths.linkPointer)) {
		unverifiable.add('linked_legacy_store');
	} else {
		let raw: string | null = null;
		try {
			raw = await readUtf8IfPresent(paths.legacyEvents, MAX_LEGACY_BYTES);
		} catch (error) {
			if (
				error instanceof ReceiptStoreError &&
				error.code === 'store_corrupt'
			) {
				unverifiable.add('oversized_legacy_store');
			} else {
				throw error;
			}
		}
		if (raw) {
			const events: Array<Record<string, unknown>> = [];
			for (const line of raw.split('\n').filter(Boolean)) {
				try {
					events.push(JSON.parse(line) as Record<string, unknown>);
				} catch {
					unverifiable.add('malformed_legacy_line');
				}
			}
			const retrievals = new Map<string, Array<Record<string, unknown>>>();
			const observedTraceIds = new Set<string>();
			for (const event of events) {
				if (typeof event.trace_id === 'string' && event.trace_id) {
					observedTraceIds.add(event.trace_id);
				}
				if (event.type !== 'retrieved' || typeof event.trace_id !== 'string') {
					continue;
				}
				const rows = retrievals.get(event.trace_id) ?? [];
				rows.push(event);
				retrievals.set(event.trace_id, rows);
			}
			for (const [traceId, rows] of retrievals) {
				if (rows.length !== 1) {
					unverifiable.add('duplicate_legacy_trace');
					unverifiableTraceIds.add(traceId);
					continue;
				}
				const event = rows[0];
				if (
					typeof event.session_id !== 'string' ||
					!event.session_id ||
					!Array.isArray(event.result_ids)
				) {
					unverifiable.add('malformed_legacy_membership');
					unverifiableTraceIds.add(traceId);
					continue;
				}
				const timestamp =
					typeof event.timestamp === 'string' ? event.timestamp : '';
				if (!Number.isFinite(Date.parse(timestamp))) {
					unverifiable.add('malformed_legacy_timestamp');
					unverifiableTraceIds.add(traceId);
					continue;
				}
				// Legacy diagnostics contain no durable phase-close proof. A structurally
				// complete unresolved membership therefore remains live regardless of age;
				// timestamp-only expiry would discard multi-day phases.
				const entryIds = event.result_ids;
				if (
					entryIds.length === 0 ||
					entryIds.some((entryId) => typeof entryId !== 'string' || !entryId) ||
					new Set(entryIds).size !== entryIds.length
				) {
					unverifiable.add('malformed_legacy_membership');
					unverifiableTraceIds.add(traceId);
					continue;
				}
				const traceMemberships: ReceiptMembership[] = [];
				let traceUnverifiable = false;
				for (const entryId of entryIds as string[]) {
					const terminals = events.filter(
						(candidate) =>
							isReceiptOutcome(candidate.type) &&
							candidate.trace_id === traceId &&
							candidate.knowledge_id === entryId &&
							candidate.session_id === event.session_id,
					);
					const distinctOutcomes = new Set(
						terminals.map((terminal) => terminal.type),
					);
					if (distinctOutcomes.size > 1) {
						unverifiable.add('conflicting_legacy_terminal');
						unverifiableTraceIds.add(traceId);
						traceUnverifiable = true;
						break;
					}
					const terminalEvent = terminals.at(-1);
					let terminal: ReceiptTerminal | undefined;
					if (terminalEvent) {
						if (
							typeof terminalEvent.event_id !== 'string' ||
							!terminalEvent.event_id ||
							typeof terminalEvent.timestamp !== 'string' ||
							!Number.isFinite(Date.parse(terminalEvent.timestamp))
						) {
							unverifiable.add('malformed_legacy_terminal');
							unverifiableTraceIds.add(traceId);
							traceUnverifiable = true;
							break;
						}
						terminal = {
							outcome: terminalEvent.type as ReceiptOutcome,
							// Legacy cutover: an out-of-taxonomy legacy source (e.g.
							// the pre-#2032 agent-name strings) is legacy ambiguity —
							// typed 'unknown', never inferred (#2032 review F-001).
							source: normalizeReceiptSource(terminalEvent.source),
							reason:
								typeof terminalEvent.reason === 'string'
									? terminalEvent.reason
									: undefined,
							event_id: terminalEvent.event_id,
							committed_at: terminalEvent.timestamp,
						};
					}
					traceMemberships.push({
						trace_id: traceId,
						entry_id: entryId,
						session_id: event.session_id,
						phase: typeof event.phase === 'string' ? event.phase : undefined,
						task_id:
							typeof event.task_id === 'string' ? event.task_id : undefined,
						agent: typeof event.agent === 'string' ? event.agent : undefined,
						// Legacy rows did not persist an exact critical snapshot. Preserve the
						// fail-closed obligation instead of inferring a safe non-critical value.
						critical: true,
						committed_at: timestamp,
						membership_event_id:
							typeof event.event_id === 'string' && event.event_id
								? event.event_id
								: randomUUID(),
						grace_days: graceDays,
						exposure_kind: legacyExposureKind(event),
						origin: 'legacy',
						terminal,
						terminal_history: terminal ? [{ ...terminal }] : undefined,
					});
				}
				if (!traceUnverifiable) {
					imported.push(...traceMemberships);
				}
			}
			for (const traceId of observedTraceIds) {
				if (!retrievals.has(traceId)) {
					unverifiable.add('evicted_legacy_membership');
					unverifiableTraceIds.add(traceId);
				}
			}
		} else {
			unverifiable.add(
				existsSync(paths.legacyEvents)
					? 'empty_legacy_store'
					: 'missing_legacy_store',
			);
		}
	}
	if (imported.length)
		await appendRecord(
			paths,
			state,
			makeRecord(state, 'legacy_imported', { memberships: imported }),
		);
	if (unverifiable.size) {
		await appendRecord(
			paths,
			state,
			makeRecord(state, 'legacy_unverifiable', {
				reason_codes: [...unverifiable].sort(),
				trace_ids: [...unverifiableTraceIds].sort(),
			}),
		);
	}
	await appendRecord(
		paths,
		state,
		makeRecord(state, 'cutover_completed', {
			imported_count: imported.length,
			imported_trace_ids: [
				...new Set(imported.map((membership) => membership.trace_id)),
			].sort(),
		}),
	);
}

function isReceiptOutcome(value: unknown): value is ReceiptOutcome {
	return (
		value === 'applied' ||
		value === 'ignored' ||
		value === 'contradicted' ||
		value === 'violated' ||
		value === 'n_a'
	);
}

function isLegacyUnverifiableTrace(
	state: LedgerState,
	traceId: string,
): boolean {
	if (state.legacyTraceRegistry.has(traceId)) return true;
	if (state.legacyUnverifiableTraceIds.has(traceId)) return true;
	if (!state.legacyUnverifiable) return false;
	// A project with no V2 authority yet cannot distinguish an absent/evicted
	// pre-cutover trace. Once exact V2 memberships exist, unrelated unknown IDs
	// are ordinary trace misses rather than being mislabeled legacy forever.
	return ![...state.memberships.values()].some(
		(membership) => membership.origin === 'v2',
	);
}

function rawSha256(value: Buffer | string): string {
	return createHash('sha256').update(value).digest('hex');
}

function overlappingRepairUncertainties(
	state: LedgerState,
	filters: {
		phase?: string;
		session_id?: string;
	},
): ReceiptRepairUncertainty[] {
	return [...state.repairUncertainties.values()].filter((uncertainty) => {
		if (filters.phase && filters.phase !== uncertainty.phase) return false;
		if (filters.session_id && filters.session_id !== uncertainty.session_id) {
			return false;
		}
		return true;
	});
}

function repairUncertaintyUnavailable(
	uncertainties: ReceiptRepairUncertainty[],
): ReceiptUnavailable {
	const scoped = uncertainties
		.map((uncertainty) => `${uncertainty.session_id}/${uncertainty.phase}`)
		.join(', ');
	const detail = `receipt authority pending re-evaluation for repaired phase/session scope: ${scoped}`;
	return {
		ok: false,
		code: 'store_unavailable',
		detail,
		uncertainty: detail,
	};
}

interface ReceiptRepairQuarantineEntry {
	schema_version: 1;
	repair_id: string;
	created_at: string;
	phase: string;
	session_id: string;
	task_id?: string;
	reason: string;
	corruption_detail: string;
	original_journal_sha256: string;
	original_journal_bytes: number;
	original_journal_base64: string;
	salvage_through_seq: number;
	salvage_through_hash: string;
}

function parseRepairQuarantineEntry(
	value: unknown,
): ReceiptRepairQuarantineEntry | null {
	if (!isPlainRecord(value)) return null;
	if (
		!hasOnlyKeys(value, [
			'schema_version',
			'repair_id',
			'created_at',
			'phase',
			'session_id',
			'task_id',
			'reason',
			'corruption_detail',
			'original_journal_sha256',
			'original_journal_bytes',
			'original_journal_base64',
			'salvage_through_seq',
			'salvage_through_hash',
		]) ||
		value.schema_version !== REPAIR_QUARANTINE_SCHEMA_VERSION ||
		typeof value.repair_id !== 'string' ||
		!value.repair_id ||
		!isValidTimestamp(value.created_at) ||
		typeof value.phase !== 'string' ||
		!value.phase ||
		typeof value.session_id !== 'string' ||
		!value.session_id ||
		!isOptionalString(value.task_id) ||
		typeof value.reason !== 'string' ||
		!value.reason ||
		typeof value.corruption_detail !== 'string' ||
		!value.corruption_detail ||
		typeof value.original_journal_sha256 !== 'string' ||
		!/^[a-f0-9]{64}$/.test(value.original_journal_sha256) ||
		!Number.isInteger(value.original_journal_bytes) ||
		(value.original_journal_bytes as number) < 0 ||
		typeof value.original_journal_base64 !== 'string' ||
		!Number.isInteger(value.salvage_through_seq) ||
		(value.salvage_through_seq as number) < 0 ||
		typeof value.salvage_through_hash !== 'string' ||
		!value.salvage_through_hash
	) {
		return null;
	}
	return {
		schema_version: REPAIR_QUARANTINE_SCHEMA_VERSION,
		repair_id: value.repair_id,
		created_at: value.created_at,
		phase: value.phase,
		session_id: value.session_id,
		task_id: value.task_id,
		reason: value.reason,
		corruption_detail: value.corruption_detail,
		original_journal_sha256: value.original_journal_sha256,
		original_journal_bytes: value.original_journal_bytes as number,
		original_journal_base64: value.original_journal_base64,
		salvage_through_seq: value.salvage_through_seq as number,
		salvage_through_hash: value.salvage_through_hash,
	};
}

function hasAuthoritativeEventId(state: LedgerState, eventId: string): boolean {
	for (const membership of state.memberships.values()) {
		if (
			membership.membership_event_id === eventId ||
			membership.application_marker?.event_id === eventId ||
			membership.gate_release?.event_id === eventId ||
			membership.terminal?.event_id === eventId ||
			membership.terminal_history?.some(
				(terminal) => terminal.event_id === eventId,
			)
		) {
			return true;
		}
	}
	for (const trace of state.emptyTraces.values()) {
		if (
			trace.empty_event_id === eventId ||
			trace.terminal_event_id === eventId
		) {
			return true;
		}
	}
	for (const lifecycle of state.phaseLifecycle.values()) {
		if (
			lifecycle.intent_event_id === eventId ||
			lifecycle.closed_event_id === eventId
		) {
			return true;
		}
	}
	return state.auditTail.some((summary) => summary.event_id === eventId);
}

async function runLocked<T>(
	directory: string,
	graceDays: number | undefined,
	action: (
		paths: ReceiptLedgerPaths,
		state: LedgerState,
		resolvedGraceDays: number,
	) => Promise<T>,
	options: { compact?: boolean; writeSnapshot?: boolean } = {},
): Promise<ReceiptLedgerResult<T>> {
	const observations: KnowledgeReceiptTransitionObservation[] = [];
	try {
		const result = await withReceiptLedgerLock(directory, async (paths) => {
			const state = await loadState(paths, observations);
			const resolvedGraceDays =
				graceDays ??
				(state.cutoverCompleted
					? DEFAULT_RECEIPT_GRACE_DAYS
					: configuredGraceDays(directory));
			await ensureCutoverLocked(paths, state, resolvedGraceDays);
			if (options.compact !== false) await compactIfNeeded(paths, state);
			const result = await action(paths, state, resolvedGraceDays);
			// The journal is authoritative and has already been fsynced. A derived
			// snapshot failure must never turn that commit into an apparent failure or
			// suppress an exposure whose membership is now durable.
			if (options.writeSnapshot !== false) {
				await _internals.writeSnapshot(paths, state).catch(() => undefined);
			}
			return { ok: true as const, ...result };
		});
		for (const observation of observations) {
			emitKnowledgeReceiptTransition(observation);
		}
		return result;
	} catch (error) {
		for (const observation of observations) {
			emitKnowledgeReceiptTransition(observation);
		}
		return unavailable(error);
	}
}

function buildCheckpointPayload(state: LedgerState): Record<string, unknown> {
	return {
		memberships: [...state.memberships.values()],
		empty_traces: [...state.emptyTraces.values()],
		cutover_completed: state.cutoverCompleted,
		legacy_unverifiable: state.legacyUnverifiable,
		legacy_trace_registry: [...state.legacyTraceRegistry].sort(),
		legacy_unverifiable_trace_ids: [...state.legacyUnverifiableTraceIds].sort(),
		phase_lifecycle: [...state.phaseLifecycle.values()],
		repair_uncertainties: [...state.repairUncertainties.values()],
		audit_tail: state.auditTail,
	};
}

async function clearRepairUncertaintyIfFresh(
	paths: ReceiptLedgerPaths,
	state: LedgerState,
	input: {
		phase?: string;
		session_id: string;
		task_id?: string;
		repair_re_evaluation?: ReceiptRepairReevaluationProof;
	},
	clearedBy: {
		event_id: string;
		trace_id: string;
		kind: 'membership_committed' | 'empty_retrieval_committed';
	},
): Promise<void> {
	if (!input.phase) return;
	const key = repairUncertaintyKey(input.phase, input.session_id);
	const active = state.repairUncertainties.get(key);
	if (!active) return;
	const proof = input.repair_re_evaluation;
	if (
		!proof?.scope_complete ||
		proof.repair_id !== active.repair_id ||
		(active.task_id !== undefined && input.task_id !== active.task_id)
	) {
		return;
	}
	await appendRecord(
		paths,
		state,
		makeRecord(state, 'repair_uncertainty_cleared', {
			phase: input.phase,
			session_id: input.session_id,
			task_id: input.task_id,
			repair_id: active.repair_id,
			cleared_by_event_id: clearedBy.event_id,
			cleared_by_trace_id: clearedBy.trace_id,
			cleared_by_kind: clearedBy.kind,
		}),
	);
}

interface SalvagedReceiptJournal {
	state: LedgerState;
	corruption_detail: string;
	salvage_through_seq: number;
	salvage_through_hash: string;
}

function salvageReceiptJournal(
	raw: Buffer,
	observations: KnowledgeReceiptTransitionObservation[],
): SalvagedReceiptJournal {
	const state = emptyState(observations);
	const lines: Buffer[] = [];
	let start = 0;
	for (let index = 0; index < raw.byteLength; index++) {
		if (raw[index] !== 0x0a) continue;
		lines.push(raw.subarray(start, index));
		start = index + 1;
	}
	if (start < raw.byteLength) lines.push(raw.subarray(start));
	const endedWithNewline = raw.at(-1) === 0x0a;
	const decoder = new TextDecoder('utf-8', { fatal: true });
	for (let i = 0; i < lines.length; i++) {
		const lineBytes = lines[i];
		if (lineBytes.byteLength === 0) continue;
		try {
			const line = decoder.decode(lineBytes);
			applyRecord(state, validateRecord(JSON.parse(line), state));
		} catch (error) {
			const tailDetail =
				i === lines.length - 1 && !endedWithNewline
					? ' (including an unterminated final record)'
					: '';
			return {
				state,
				corruption_detail: `receipt journal corruption at line ${i + 1}${tailDetail}: ${
					error instanceof Error ? error.message : String(error)
				}`,
				salvage_through_seq: state.lastSeq,
				salvage_through_hash: state.lastHash,
			};
		}
	}
	throw new ReceiptStoreError(
		'store_unavailable',
		'repair requested on readable receipt authority',
	);
}

async function writeRepairQuarantineEntry(
	paths: ReceiptLedgerPaths,
	entry: ReceiptRepairQuarantineEntry,
): Promise<void> {
	const raw = await readUtf8IfPresent(
		paths.quarantine,
		MAX_REPAIR_CAPTURE_BYTES,
	);
	const existing: ReceiptRepairQuarantineEntry[] = [];
	for (const line of raw?.split('\n') ?? []) {
		if (!line.trim()) continue;
		let parsed: ReceiptRepairQuarantineEntry | null = null;
		try {
			parsed = parseRepairQuarantineEntry(JSON.parse(line));
		} catch {
			parsed = null;
		}
		if (!parsed) {
			throw new ReceiptStoreError(
				'store_corrupt',
				'receipt repair quarantine metadata is invalid',
			);
		}
		existing.push(parsed);
	}
	if (
		existing.some(
			(candidate) =>
				candidate.original_journal_sha256 === entry.original_journal_sha256 &&
				candidate.phase === entry.phase &&
				candidate.session_id === entry.session_id,
		)
	) {
		return;
	}
	if (existing.length >= MAX_REPAIR_QUARANTINE_RECORDS) {
		throw new ReceiptStoreError(
			'store_unavailable',
			'receipt repair quarantine is full; existing immutable records were preserved',
		);
	}
	await _internals.appendFsynced(
		paths.quarantine,
		`${JSON.stringify(entry)}\n`,
	);
}

export interface RepairKnowledgeReceiptLedgerInput {
	phase: string;
	session_id: string;
	task_id?: string;
	reason: string;
	grace_days?: number;
}

export interface ReceiptRepairReevaluationProof {
	repair_id: string;
	/** Exact producer assertion that this retrieval covered the full repaired scope. */
	scope_complete: boolean;
}

export async function repairKnowledgeReceiptLedger(
	directory: string,
	input: RepairKnowledgeReceiptLedgerInput,
): Promise<
	ReceiptLedgerResult<{
		status:
			| 'validated_projection'
			| 'repaired_authority'
			| 'pending_re_evaluation';
		pending_re_evaluation: boolean;
		repair_id?: string;
		salvage_through_seq: number;
		salvage_through_hash: string;
	}>
> {
	const observations: KnowledgeReceiptTransitionObservation[] = [];
	try {
		const result = await withReceiptLedgerLock(directory, async (paths) => {
			const repairReason = input.reason.trim();
			if (
				!input.phase.trim() ||
				!input.session_id.trim() ||
				repairReason.length < 12 ||
				/^(fix|repair|test|debug|unknown|n\/?a|none)$/i.test(repairReason)
			) {
				throw new ReceiptStoreError(
					'store_unavailable',
					'receipt repair requires exact phase/session identity and a substantive reason',
				);
			}
			let raw: Buffer | null = null;
			try {
				raw = await readBytesIfPresent(paths.journal, MAX_JOURNAL_BYTES);
			} catch (error) {
				if (error instanceof ReceiptStoreError) throw error;
				throw new ReceiptStoreError(
					'store_unavailable',
					error instanceof Error ? error.message : String(error),
				);
			}
			try {
				const state = await loadState(paths, observations);
				const resolvedGraceDays =
					input.grace_days ??
					(state.cutoverCompleted
						? DEFAULT_RECEIPT_GRACE_DAYS
						: configuredGraceDays(directory));
				await ensureCutoverLocked(paths, state, resolvedGraceDays);
				const overlaps = overlappingRepairUncertainties(state, {
					phase: input.phase,
					session_id: input.session_id,
				});
				await _internals.writeSnapshot(paths, state).catch(() => undefined);
				if (overlaps.length > 0) {
					return {
						ok: true as const,
						status: 'pending_re_evaluation' as const,
						pending_re_evaluation: true,
						repair_id: overlaps[0]?.repair_id,
						salvage_through_seq: state.lastSeq,
						salvage_through_hash: state.lastHash,
					};
				}
				return {
					ok: true as const,
					status: 'validated_projection' as const,
					pending_re_evaluation: false,
					salvage_through_seq: state.lastSeq,
					salvage_through_hash: state.lastHash,
				};
			} catch (error) {
				if (
					!(error instanceof ReceiptStoreError) ||
					error.code !== 'store_corrupt'
				) {
					throw error;
				}
				if (raw === null) throw error;
				const rawBytes = raw.byteLength;
				if (rawBytes > MAX_REPAIR_CAPTURE_BYTES) {
					throw new ReceiptStoreError(
						'store_unavailable',
						`receipt repair requires original authority <= ${MAX_REPAIR_CAPTURE_BYTES} bytes`,
					);
				}
				const salvaged = salvageReceiptJournal(raw, observations);
				const resolvedGraceDays =
					input.grace_days ??
					(salvaged.state.cutoverCompleted
						? DEFAULT_RECEIPT_GRACE_DAYS
						: configuredGraceDays(directory));
				await ensureCutoverLocked(paths, salvaged.state, resolvedGraceDays);
				const key = repairUncertaintyKey(input.phase, input.session_id);
				const existing = salvaged.state.repairUncertainties.get(key);
				const repairId = existing?.repair_id ?? randomUUID();
				const journalHash = rawSha256(raw);
				await writeRepairQuarantineEntry(paths, {
					schema_version: REPAIR_QUARANTINE_SCHEMA_VERSION,
					repair_id: repairId,
					created_at: nowIso(),
					phase: input.phase,
					session_id: input.session_id,
					task_id: input.task_id,
					reason: repairReason,
					corruption_detail: salvaged.corruption_detail,
					original_journal_sha256: journalHash,
					original_journal_bytes: rawBytes,
					original_journal_base64: raw.toString('base64'),
					salvage_through_seq: salvaged.salvage_through_seq,
					salvage_through_hash: salvaged.salvage_through_hash,
				});
				const fresh = emptyState(observations);
				fresh.memberships = new Map(salvaged.state.memberships);
				fresh.traceIds = new Set(salvaged.state.traceIds);
				fresh.emptyTraces = new Map(salvaged.state.emptyTraces);
				fresh.cutoverCompleted = salvaged.state.cutoverCompleted;
				fresh.legacyUnverifiable = salvaged.state.legacyUnverifiable;
				fresh.legacyTraceRegistry = new Set(salvaged.state.legacyTraceRegistry);
				fresh.legacyUnverifiableTraceIds = new Set(
					salvaged.state.legacyUnverifiableTraceIds,
				);
				fresh.phaseLifecycle = new Map(salvaged.state.phaseLifecycle);
				fresh.repairUncertainties = new Map(salvaged.state.repairUncertainties);
				fresh.auditTail = [...salvaged.state.auditTail];
				const checkpoint = makeRecord(
					fresh,
					'checkpoint',
					buildCheckpointPayload(salvaged.state),
				);
				const rewritten = [`${JSON.stringify(checkpoint)}\n`];
				applyRecord(fresh, checkpoint);
				if (!existing) {
					const uncertainty: ReceiptRepairUncertainty = {
						phase: input.phase,
						session_id: input.session_id,
						task_id: input.task_id,
						reason: repairReason,
						repair_id: repairId,
						installed_at: nowIso(),
						raw_journal_sha256: journalHash,
						raw_journal_bytes: rawBytes,
						salvage_through_seq: salvaged.salvage_through_seq,
						salvage_through_hash: salvaged.salvage_through_hash,
					};
					const install = makeRecord(fresh, 'repair_uncertainty_installed', {
						uncertainty,
					});
					rewritten.push(`${JSON.stringify(install)}\n`);
					applyRecord(fresh, install);
				}
				await _internals.atomicWriteFsynced(paths.journal, rewritten.join(''));
				await _internals.writeSnapshot(paths, fresh).catch(() => undefined);
				return {
					ok: true as const,
					status: 'repaired_authority' as const,
					pending_re_evaluation: true,
					repair_id: repairId,
					salvage_through_seq: salvaged.salvage_through_seq,
					salvage_through_hash: salvaged.salvage_through_hash,
				};
			}
		});
		for (const observation of observations) {
			emitKnowledgeReceiptTransition(observation);
		}
		return result;
	} catch (error) {
		for (const observation of observations) {
			emitKnowledgeReceiptTransition(observation);
		}
		return unavailable(error);
	}
}

export interface CommitDisplayedMembershipInput {
	trace_id: string;
	session_id: string;
	phase?: string;
	task_id?: string;
	agent?: string;
	entries: Array<{
		entry_id: string;
		critical: boolean;
		rank?: number;
		score?: number;
	}>;
	grace_days?: number;
	cohort_id?: string;
	source_link_id?: string;
	/** Producer provenance used by application gates; omitted callers fail closed. */
	exposure_kind?: ReceiptExposureKind;
	/** Explicit repair-bound proof; ordinary retrievals intentionally omit this. */
	repair_re_evaluation?: ReceiptRepairReevaluationProof;
}

export async function commitDisplayedMembership(
	directory: string,
	input: CommitDisplayedMembershipInput,
): Promise<
	ReceiptLedgerResult<{ event_id: string; memberships: ReceiptMembership[] }>
> {
	return runLocked(
		directory,
		input.grace_days,
		async (paths, state, graceDays) => {
			if (!input.trace_id || !input.session_id || input.entries.length === 0)
				throw new ReceiptStoreError(
					'store_unavailable',
					'invalid displayed membership',
				);
			const eventId = randomUUID();
			const committedAt = nowIso();
			const exposureKind = normalizeExposureKind(input.exposure_kind);
			const memberships: ReceiptMembership[] = [];
			const newMemberships: ReceiptMembership[] = [];
			for (const entry of input.entries) {
				const existing = state.memberships.get(
					keyOf(input.trace_id, entry.entry_id),
				);
				if (existing) {
					if (
						existing.session_id !== input.session_id ||
						existing.phase !== input.phase ||
						existing.task_id !== input.task_id ||
						existing.critical !== entry.critical ||
						existing.cohort_id !== input.cohort_id ||
						existing.source_link_id !== input.source_link_id ||
						existing.exposure_kind !== exposureKind
					) {
						throw new ReceiptStoreError(
							'store_unavailable',
							`conflicting immutable membership for ${input.trace_id}/${entry.entry_id}`,
						);
					}
					memberships.push({
						...existing,
						terminal: existing.terminal ? { ...existing.terminal } : undefined,
					});
					continue;
				}
				const closedLifecycle =
					state.phaseLifecycle.get(
						phaseLifecycleKey(
							input.phase ?? '',
							input.session_id,
							input.task_id,
						),
					) ??
					(input.task_id !== undefined
						? state.phaseLifecycle.get(
								phaseLifecycleKey(input.phase ?? '', input.session_id),
							)
						: undefined);
				if (input.phase && closedLifecycle?.closed_event_id) {
					throw new ReceiptStoreError(
						'store_unavailable',
						`cannot add receipt membership to closed lifecycle ${input.session_id}/${input.phase}`,
					);
				}
				const membership: ReceiptMembership = {
					trace_id: input.trace_id,
					entry_id: entry.entry_id,
					session_id: input.session_id,
					phase: input.phase,
					task_id: input.task_id,
					agent: input.agent,
					critical: entry.critical,
					rank: entry.rank,
					score: entry.score,
					committed_at: committedAt,
					membership_event_id: eventId,
					grace_days: graceDays,
					cohort_id: input.cohort_id,
					source_link_id: input.source_link_id,
					exposure_kind: exposureKind,
					origin: 'v2',
				};
				memberships.push(membership);
				newMemberships.push(membership);
			}
			if (newMemberships.length) {
				await appendRecord(
					paths,
					state,
					makeRecord(
						state,
						'membership_committed',
						{ memberships: newMemberships },
						eventId,
					),
				);
				await clearRepairUncertaintyIfFresh(paths, state, input, {
					event_id: eventId,
					trace_id: input.trace_id,
					kind: 'membership_committed',
				});
			}
			return {
				event_id: newMemberships.length
					? eventId
					: memberships[0].membership_event_id,
				memberships,
			};
		},
	);
}

export async function commitEmptyRetrieval(
	directory: string,
	input: Omit<CommitDisplayedMembershipInput, 'entries'>,
): Promise<
	ReceiptLedgerResult<{ event_id: string; terminal_event_id: string }>
> {
	return runLocked(
		directory,
		input.grace_days,
		async (paths, state, graceDays) => {
			const existing = state.emptyTraces.get(
				emptyKeyOf(input.trace_id, input.session_id),
			);
			if (existing) {
				if (
					existing.phase !== input.phase ||
					existing.task_id !== input.task_id ||
					existing.grace_days !== graceDays
				) {
					throw new ReceiptStoreError(
						'store_unavailable',
						`conflicting immutable empty retrieval for ${input.trace_id}/${input.session_id}`,
					);
				}
				if (!existing.terminal_event_id) {
					const terminal = makeRecord(state, 'terminal_committed', {
						empty_trace_id: input.trace_id,
						empty_trace_session_id: input.session_id,
					});
					await appendRecord(paths, state, terminal);
				}
				return {
					event_id: existing.empty_event_id,
					terminal_event_id: existing.terminal_event_id as string,
				};
			}
			const eventId = randomUUID();
			const terminalEventId = randomUUID();
			const trace: EmptyTrace = {
				trace_id: input.trace_id,
				session_id: input.session_id,
				phase: input.phase,
				task_id: input.task_id,
				committed_at: nowIso(),
				empty_event_id: eventId,
				grace_days: graceDays,
			};
			await appendRecord(
				paths,
				state,
				makeRecord(state, 'empty_retrieval_committed', { trace }, eventId),
			);
			await appendRecord(
				paths,
				state,
				makeRecord(
					state,
					'terminal_committed',
					{
						empty_trace_id: input.trace_id,
						empty_trace_session_id: input.session_id,
					},
					terminalEventId,
				),
			);
			await clearRepairUncertaintyIfFresh(paths, state, input, {
				event_id: eventId,
				trace_id: input.trace_id,
				kind: 'empty_retrieval_committed',
			});
			return { event_id: eventId, terminal_event_id: terminalEventId };
		},
	);
}

export interface TerminalBatchInput {
	trace_id: string;
	session_id: string;
	phase?: string;
	task_id?: string;
	agent?: string;
	cohort_id?: string;
	source_link_id?: string;
	grace_days?: number;
	items?: Array<{
		entry_id: string;
		outcome: ReceiptOutcome;
		source?: string;
		reason?: string;
		predicate_check?: ReceiptPredicateCheck;
		event_id?: string;
	}>;
	/** Alias used by reviewer/delegate batch producers. */
	terminals?: Array<{
		entry_id: string;
		outcome: ReceiptOutcome;
		source?: string;
		reason?: string;
		predicate_check?: ReceiptPredicateCheck;
		event_id?: string;
	}>;
	no_relevant_knowledge?: boolean;
	authorization?: {
		actor: 'manual-override' | 'reviewer-remediation' | 'phase-override';
		reason: string;
		expected_event_id: string;
		expected_outcome?: ReceiptOutcome;
	};
}

export async function validateAndCommitTerminalBatch(
	directory: string,
	input: TerminalBatchInput,
): Promise<
	ReceiptLedgerResult<{
		accepted: Array<{
			entry_id: string;
			outcome: ReceiptOutcome;
			event_id: string;
		}>;
		committed: Array<{
			entry_id: string;
			outcome: ReceiptOutcome;
			event_id: string;
		}>;
		idempotent: string[];
		idempotent_events: Array<{
			entry_id: string;
			outcome: ReceiptOutcome;
			event_id: string;
		}>;
		rejected: Array<{ entry_id: string; reason: string }>;
		closes_no_relevant: boolean;
		terminal_event_id?: string;
	}>
> {
	return runLocked(directory, input.grace_days, async (paths, state) => {
		const items = input.items ?? input.terminals ?? [];
		if (
			items.some(
				(item) =>
					typeof item.entry_id !== 'string' ||
					!item.entry_id ||
					!isReceiptOutcome(item.outcome) ||
					!isOptionalString(item.source) ||
					!isOptionalString(item.reason) ||
					(item.predicate_check !== undefined &&
						parsePredicateCheck(item.predicate_check) === null) ||
					!isOptionalString(item.event_id),
			)
		) {
			throw new ReceiptStoreError(
				'store_unavailable',
				'invalid terminal payload',
			);
		}
		const accepted: Array<{
			entry_id: string;
			outcome: ReceiptOutcome;
			event_id: string;
		}> = [];
		const idempotent: string[] = [];
		const idempotentEvents: Array<{
			entry_id: string;
			outcome: ReceiptOutcome;
			event_id: string;
		}> = [];
		const rejected: Array<{ entry_id: string; reason: string }> = [];
		if (input.no_relevant_knowledge) {
			const empty = state.emptyTraces.get(
				emptyKeyOf(input.trace_id, input.session_id),
			);
			if (!empty || empty.session_id !== input.session_id || items.length) {
				return {
					accepted,
					committed: accepted,
					idempotent,
					idempotent_events: idempotentEvents,
					rejected: [{ entry_id: '', reason: 'trace_not_found' }],
					closes_no_relevant: false,
					terminal_event_id: undefined,
				};
			}
			if (!empty.terminal_event_id) {
				const row = makeRecord(state, 'terminal_committed', {
					empty_trace_id: input.trace_id,
					empty_trace_session_id: input.session_id,
				});
				await appendRecord(paths, state, row);
			}
			return {
				accepted,
				committed: accepted,
				idempotent,
				idempotent_events: idempotentEvents,
				rejected,
				closes_no_relevant: true,
				terminal_event_id: state.emptyTraces.get(
					emptyKeyOf(input.trace_id, input.session_id),
				)?.terminal_event_id,
			};
		}
		const transitions: Array<{
			trace_id: string;
			entry_id: string;
			terminal: ReceiptTerminal;
			cohort_id?: string;
			source_link_id?: string;
		}> = [];
		const traceExists = state.traceIds.has(input.trace_id);
		const stagedOutcomes = new Map<string, ReceiptOutcome>();
		const reservedEventIds = new Set<string>();
		let authorized = false;
		for (const item of items) {
			const membership = state.memberships.get(
				keyOf(input.trace_id, item.entry_id),
			);
			if (!membership) {
				rejected.push({
					entry_id: item.entry_id,
					reason: traceExists
						? 'id_not_in_trace'
						: isLegacyUnverifiableTrace(state, input.trace_id)
							? 'legacy_unverifiable'
							: 'trace_not_found',
				});
				continue;
			}
			if (membership.session_id !== input.session_id) {
				rejected.push({ entry_id: item.entry_id, reason: 'wrong_session' });
				continue;
			}
			if (input.phase !== undefined && membership.phase !== input.phase) {
				rejected.push({ entry_id: item.entry_id, reason: 'wrong_phase' });
				continue;
			}
			if (input.task_id !== undefined && membership.task_id !== input.task_id) {
				rejected.push({ entry_id: item.entry_id, reason: 'wrong_task' });
				continue;
			}
			const stagedOutcome = stagedOutcomes.get(item.entry_id);
			if (stagedOutcome !== undefined) {
				if (stagedOutcome === item.outcome) {
					idempotent.push(item.entry_id);
					const stagedCommit = accepted.find(
						(entry) => entry.entry_id === item.entry_id,
					);
					if (stagedCommit) idempotentEvents.push(stagedCommit);
				} else
					rejected.push({
						entry_id: item.entry_id,
						reason: 'duplicate_conflicting_terminal',
					});
				continue;
			}
			stagedOutcomes.set(item.entry_id, item.outcome);
			if (
				membership.terminal?.outcome === item.outcome &&
				!input.authorization
			) {
				idempotent.push(item.entry_id);
				idempotentEvents.push({
					entry_id: item.entry_id,
					outcome: item.outcome,
					event_id: membership.terminal.event_id,
				});
				continue;
			}
			if (membership.terminal) {
				const auth = input.authorization;
				if (
					!auth ||
					!auth.reason ||
					auth.expected_event_id !== membership.terminal.event_id ||
					(auth.expected_outcome !== undefined &&
						auth.expected_outcome !== membership.terminal.outcome)
				) {
					rejected.push({
						entry_id: item.entry_id,
						reason: 'duplicate_conflicting_terminal',
					});
					continue;
				}
				authorized = true;
			} else if (input.authorization) {
				if (
					!input.authorization.reason ||
					input.authorization.expected_event_id !== ''
				) {
					rejected.push({
						entry_id: item.entry_id,
						reason: 'unauthorized_transition',
					});
					continue;
				}
				authorized = true;
			}
			if (
				(input.cohort_id !== undefined &&
					membership.cohort_id !== undefined &&
					membership.cohort_id !== input.cohort_id) ||
				(input.source_link_id !== undefined &&
					membership.source_link_id !== undefined &&
					membership.source_link_id !== input.source_link_id)
			) {
				throw new ReceiptStoreError(
					'store_unavailable',
					`conflicting receipt correlation metadata for ${input.trace_id}/${item.entry_id}`,
				);
			}
			const requestedEventId = item.event_id?.trim();
			if (requestedEventId) {
				if (
					hasAuthoritativeEventId(state, requestedEventId) ||
					reservedEventIds.has(requestedEventId)
				) {
					rejected.push({
						entry_id: item.entry_id,
						reason: 'event_id_conflict',
					});
					continue;
				}
			}
			const eventId = requestedEventId || randomUUID();
			reservedEventIds.add(eventId);
			transitions.push({
				trace_id: input.trace_id,
				entry_id: item.entry_id,
				terminal: {
					outcome: item.outcome,
					source: normalizeReceiptSource(item.source),
					reason: item.reason,
					predicate_check: item.predicate_check,
					event_id: eventId,
					committed_at: nowIso(),
					...(input.authorization
						? {
								authorized_transition: {
									actor: input.authorization.actor,
									reason: input.authorization.reason,
									previous_event_id: membership.terminal?.event_id ?? '',
									previous_outcome: membership.terminal?.outcome,
								},
							}
						: {}),
				},
				cohort_id: input.cohort_id,
				source_link_id: input.source_link_id,
			});
			accepted.push({
				entry_id: item.entry_id,
				outcome: item.outcome,
				event_id: eventId,
			});
		}
		if (transitions.length)
			await appendRecord(
				paths,
				state,
				makeRecord(
					state,
					authorized ? 'authorized_transition_committed' : 'terminal_committed',
					{
						transitions,
						authorization: authorized ? input.authorization : undefined,
					},
				),
			);
		if (idempotent.length)
			await appendRecord(
				paths,
				state,
				makeRecord(state, 'terminal_attempt_idempotent', {
					trace_id: input.trace_id,
					entry_ids: idempotent,
				}),
			);
		if (rejected.length)
			await appendRecord(
				paths,
				state,
				makeRecord(state, 'terminal_attempt_rejected', {
					trace_id: input.trace_id,
					rejected,
				}),
			);
		return {
			accepted,
			committed: accepted,
			idempotent,
			idempotent_events: idempotentEvents,
			rejected,
			closes_no_relevant: false,
			terminal_event_id: undefined,
		};
	});
}

interface ApplicationMarkerBatchInput {
	trace_id: string;
	session_id: string;
	items?: Array<{
		entry_id: string;
		outcome: ReceiptOutcome;
		source?: string;
		reason?: string;
	}>;
	markers?: Array<{
		entry_id: string;
		outcome: ReceiptOutcome;
		source?: string;
		reason?: string;
	}>;
}

async function commitApplicationMarkerBatch(
	directory: string,
	input: ApplicationMarkerBatchInput,
): Promise<
	ReceiptLedgerResult<{
		committed: Array<{
			entry_id: string;
			outcome: ReceiptOutcome;
			event_id: string;
		}>;
		idempotent: string[];
		rejected: Array<{ entry_id: string; reason: string }>;
	}>
> {
	return runLocked(directory, undefined, async (paths, state) => {
		const items = input.items ?? input.markers ?? [];
		const committed: Array<{
			entry_id: string;
			outcome: ReceiptOutcome;
			event_id: string;
		}> = [];
		const idempotent: string[] = [];
		const rejected: Array<{ entry_id: string; reason: string }> = [];
		const transitions: Array<{
			trace_id: string;
			entry_id: string;
			marker: ReceiptApplicationMarker;
		}> = [];
		const traceExists = state.traceIds.has(input.trace_id);
		const staged = new Map<string, ReceiptOutcome>();
		for (const item of items) {
			const membership = state.memberships.get(
				keyOf(input.trace_id, item.entry_id),
			);
			if (!membership) {
				rejected.push({
					entry_id: item.entry_id,
					reason: traceExists
						? 'id_not_in_trace'
						: isLegacyUnverifiableTrace(state, input.trace_id)
							? 'legacy_unverifiable'
							: 'trace_not_found',
				});
				continue;
			}
			if (membership.session_id !== input.session_id) {
				rejected.push({ entry_id: item.entry_id, reason: 'wrong_session' });
				continue;
			}
			const stagedOutcome = staged.get(item.entry_id);
			if (stagedOutcome !== undefined) {
				if (stagedOutcome === item.outcome) idempotent.push(item.entry_id);
				else {
					rejected.push({
						entry_id: item.entry_id,
						reason: 'duplicate_conflicting_terminal',
					});
				}
				continue;
			}
			staged.set(item.entry_id, item.outcome);
			if (membership.application_marker?.outcome === item.outcome) {
				idempotent.push(item.entry_id);
				continue;
			}
			if (membership.application_marker) {
				rejected.push({
					entry_id: item.entry_id,
					reason: 'duplicate_conflicting_terminal',
				});
				continue;
			}
			const eventId = randomUUID();
			const marker: ReceiptApplicationMarker = {
				outcome: item.outcome,
				source: normalizeReceiptSource(item.source),
				reason: item.reason,
				event_id: eventId,
				committed_at: nowIso(),
			};
			transitions.push({
				trace_id: input.trace_id,
				entry_id: item.entry_id,
				marker,
			});
			committed.push({
				entry_id: item.entry_id,
				outcome: item.outcome,
				event_id: eventId,
			});
		}
		if (transitions.length) {
			await appendRecord(
				paths,
				state,
				makeRecord(state, 'application_marker_committed', {
					markers: transitions,
				}),
			);
		}
		return { committed, idempotent, rejected };
	});
}

export interface GateReleaseBatchInput {
	trace_id: string;
	session_id: string;
	grace_days?: number;
	items: Array<{
		entry_id: string;
		source?: string;
		reason?: string;
	}>;
}

export async function commitGateReleaseBatch(
	directory: string,
	input: GateReleaseBatchInput,
): Promise<
	ReceiptLedgerResult<{
		committed: Array<{
			entry_id: string;
			event_id: string;
			membership_event_id: string;
		}>;
		idempotent: Array<{
			entry_id: string;
			event_id: string;
		}>;
		rejected: Array<{ entry_id: string; reason: string }>;
	}>
> {
	return runLocked(directory, input.grace_days, async (paths, state) => {
		const committed: Array<{
			entry_id: string;
			event_id: string;
			membership_event_id: string;
		}> = [];
		const idempotent: Array<{
			entry_id: string;
			event_id: string;
		}> = [];
		const rejected: Array<{ entry_id: string; reason: string }> = [];
		const releases: Array<{
			trace_id: string;
			entry_id: string;
			release: ReceiptGateRelease;
		}> = [];
		const traceExists = state.traceIds.has(input.trace_id);
		const staged = new Set<string>();
		for (const item of input.items) {
			const membership = state.memberships.get(
				keyOf(input.trace_id, item.entry_id),
			);
			if (!membership) {
				rejected.push({
					entry_id: item.entry_id,
					reason: traceExists
						? 'id_not_in_trace'
						: isLegacyUnverifiableTrace(state, input.trace_id)
							? 'legacy_unverifiable'
							: 'trace_not_found',
				});
				continue;
			}
			if (membership.session_id !== input.session_id) {
				rejected.push({ entry_id: item.entry_id, reason: 'wrong_session' });
				continue;
			}
			if (staged.has(item.entry_id)) {
				idempotent.push({
					entry_id: item.entry_id,
					event_id:
						membership.gate_release?.event_id ??
						releases.at(-1)?.release.event_id ??
						'',
				});
				continue;
			}
			staged.add(item.entry_id);
			if (
				membership.gate_release?.membership_event_id ===
				membership.membership_event_id
			) {
				idempotent.push({
					entry_id: item.entry_id,
					event_id: membership.gate_release.event_id,
				});
				continue;
			}
			const release: ReceiptGateRelease = {
				source: normalizeReceiptSource(item.source),
				reason: item.reason,
				event_id: randomUUID(),
				committed_at: nowIso(),
				membership_event_id: membership.membership_event_id,
			};
			releases.push({
				trace_id: input.trace_id,
				entry_id: item.entry_id,
				release,
			});
			committed.push({
				entry_id: item.entry_id,
				event_id: release.event_id,
				membership_event_id: release.membership_event_id,
			});
		}
		if (releases.length) {
			await appendRecord(
				paths,
				state,
				makeRecord(state, 'gate_release_committed', {
					releases,
				}),
			);
		}
		return { committed, idempotent, rejected };
	});
}

export interface ApplicationOutcomeBatchInput {
	trace_id: string;
	session_id: string;
	grace_days?: number;
	items: Array<{
		entry_id: string;
		outcome: ReceiptOutcome;
		source?: string;
		reason?: string;
	}>;
}

/**
 * Atomically commit the architect application marker and its receipt terminal.
 * Each exact pair is validated before either state projection is staged, so a
 * terminal conflict can never leave a marker behind. Existing same-outcome
 * state is preserved and any missing half is repaired in the same journal row.
 */
export async function commitApplicationOutcomeBatch(
	directory: string,
	input: ApplicationOutcomeBatchInput,
): Promise<
	ReceiptLedgerResult<{
		committed: Array<{
			entry_id: string;
			outcome: ReceiptOutcome;
			marker_event_id: string;
			terminal_event_id: string;
		}>;
		idempotent: Array<{
			entry_id: string;
			outcome: ReceiptOutcome;
			marker_event_id: string;
			terminal_event_id: string;
		}>;
		rejected: Array<{ entry_id: string; reason: string }>;
	}>
> {
	return runLocked(directory, input.grace_days, async (paths, state) => {
		const committed: Array<{
			entry_id: string;
			outcome: ReceiptOutcome;
			marker_event_id: string;
			terminal_event_id: string;
		}> = [];
		const idempotent: typeof committed = [];
		const rejected: Array<{ entry_id: string; reason: string }> = [];
		const markers: Array<{
			trace_id: string;
			entry_id: string;
			marker: ReceiptApplicationMarker;
		}> = [];
		const transitions: Array<{
			trace_id: string;
			entry_id: string;
			terminal: ReceiptTerminal;
		}> = [];
		const traceExists = state.traceIds.has(input.trace_id);
		const staged = new Map<string, ReceiptOutcome>();
		const stagedResults = new Map<string, (typeof committed)[number]>();
		for (const item of input.items) {
			const membership = state.memberships.get(
				keyOf(input.trace_id, item.entry_id),
			);
			if (!membership) {
				rejected.push({
					entry_id: item.entry_id,
					reason: traceExists
						? 'id_not_in_trace'
						: isLegacyUnverifiableTrace(state, input.trace_id)
							? 'legacy_unverifiable'
							: 'trace_not_found',
				});
				continue;
			}
			if (membership.session_id !== input.session_id) {
				rejected.push({ entry_id: item.entry_id, reason: 'wrong_session' });
				continue;
			}
			const stagedOutcome = staged.get(item.entry_id);
			if (stagedOutcome !== undefined) {
				const stagedResult = stagedResults.get(item.entry_id);
				if (stagedOutcome === item.outcome && stagedResult) {
					idempotent.push(stagedResult);
				} else {
					rejected.push({
						entry_id: item.entry_id,
						reason: 'duplicate_conflicting_terminal',
					});
				}
				continue;
			}
			staged.set(item.entry_id, item.outcome);
			if (
				(membership.application_marker &&
					membership.application_marker.outcome !== item.outcome) ||
				(membership.terminal && membership.terminal.outcome !== item.outcome)
			) {
				rejected.push({
					entry_id: item.entry_id,
					reason: 'duplicate_conflicting_terminal',
				});
				continue;
			}

			const now = nowIso();
			const source = normalizeReceiptSource(item.source);
			const marker =
				membership.application_marker ??
				({
					outcome: item.outcome,
					source,
					reason: item.reason,
					event_id: randomUUID(),
					committed_at: now,
				} satisfies ReceiptApplicationMarker);
			const terminal =
				membership.terminal ??
				({
					outcome: item.outcome,
					source,
					reason: item.reason,
					event_id: randomUUID(),
					committed_at: now,
				} satisfies ReceiptTerminal);
			if (!membership.application_marker) {
				markers.push({
					trace_id: input.trace_id,
					entry_id: item.entry_id,
					marker,
				});
			}
			if (!membership.terminal) {
				transitions.push({
					trace_id: input.trace_id,
					entry_id: item.entry_id,
					terminal,
				});
			}
			const result = {
				entry_id: item.entry_id,
				outcome: item.outcome,
				marker_event_id: marker.event_id,
				terminal_event_id: terminal.event_id,
			};
			stagedResults.set(item.entry_id, result);
			if (membership.application_marker && membership.terminal) {
				idempotent.push(result);
			} else {
				committed.push(result);
			}
		}
		if (markers.length || transitions.length) {
			await appendRecord(
				paths,
				state,
				makeRecord(state, 'application_marker_committed', {
					markers,
					transitions,
				}),
			);
		}
		return { committed, idempotent, rejected };
	});
}

export async function queryLiveMemberships(
	directory: string,
	filters: {
		phase?: string;
		task_id?: string;
		session_id?: string;
		include_terminal?: boolean;
		include_phase_closed?: boolean;
		exposure_kind?: ReceiptExposureKind;
		grace_days?: number;
	} = {},
): Promise<ReceiptLedgerResult<{ memberships: ReceiptMembership[] }>> {
	return runLocked(
		directory,
		filters.grace_days,
		async (_paths, state) => {
			const overlaps = overlappingRepairUncertainties(state, {
				phase: filters.phase,
				session_id: filters.session_id,
			});
			if (overlaps.length > 0) {
				throw new ReceiptStoreError(
					'store_unavailable',
					repairUncertaintyUnavailable(overlaps).detail,
				);
			}
			return {
				memberships: [...state.memberships.values()]
					.filter(
						(m) =>
							(!filters.phase || m.phase === filters.phase) &&
							(!filters.task_id || m.task_id === filters.task_id) &&
							(!filters.session_id || m.session_id === filters.session_id) &&
							(filters.include_terminal !== false || !m.terminal) &&
							(filters.include_phase_closed !== false || !m.phase_closed_at) &&
							(!filters.exposure_kind ||
								m.exposure_kind === filters.exposure_kind),
					)
					.map((m) => ({
						...m,
						terminal: m.terminal ? { ...m.terminal } : undefined,
					})),
			};
		},
		{ compact: false, writeSnapshot: false },
	);
}

export async function queryHistoricalOutcomes(
	directory: string,
	entryIds?: string[],
	graceDays?: number,
): Promise<ReceiptLedgerResult<{ memberships: ReceiptMembership[] }>> {
	return runLocked(
		directory,
		graceDays,
		async (paths, state) => {
			const wanted = entryIds ? new Set(entryIds) : null;
			const memberships = new Map<string, ReceiptMembership>();
			for (const membership of state.memberships.values()) {
				if (!wanted || wanted.has(membership.entry_id)) {
					memberships.set(archiveKey(membership), membership);
				}
			}
			const raw = await readUtf8IfPresent(paths.archive, MAX_ARCHIVE_BYTES);
			if (raw) {
				for (const line of raw.split('\n').filter(Boolean)) {
					let summary: ArchiveSummary | null = null;
					try {
						summary = parseArchiveSummary(JSON.parse(line));
					} catch {
						// handled below
					}
					if (!summary) {
						throw new ReceiptStoreError(
							'store_corrupt',
							'receipt archive contains an invalid authoritative summary',
						);
					}
					if (
						'entry_id' in summary &&
						(!wanted || wanted.has(summary.entry_id))
					) {
						const key = archiveKey(summary);
						if (!memberships.has(key)) memberships.set(key, summary);
					}
				}
			}
			return { memberships: [...memberships.values()] };
		},
		{ compact: false, writeSnapshot: false },
	);
}

/**
 * Compact the authoritative receipt journal under its dedicated lock.
 * Read-only queries intentionally never rewrite receipt state, so maintenance
 * callers and focused recovery tests use this explicit mutation boundary.
 */
export async function compactKnowledgeReceiptLedger(
	directory: string,
): Promise<ReceiptLedgerResult<{ compacted: true }>> {
	return runLocked(directory, undefined, async () => ({ compacted: true }));
}

async function phaseTransition(
	directory: string,
	phase: string,
	kind: 'phase_close_intent' | 'phase_closed',
	sessionId?: string,
	taskId?: string,
	graceDays?: number,
): Promise<ReceiptLedgerResult<{ event_id: string }>> {
	return runLocked(directory, graceDays, async (paths, state) => {
		if (!phase.trim()) {
			throw new ReceiptStoreError('store_unavailable', 'phase is required');
		}
		const scopeKeys = new Map<
			string,
			{ session_id: string; task_id?: string }
		>();
		const addScope = (scopeSessionId: string, scopeTaskId?: string) => {
			if (
				(sessionId !== undefined && scopeSessionId !== sessionId) ||
				(taskId !== undefined && scopeTaskId !== taskId)
			)
				return;
			scopeKeys.set(phaseLifecycleKey(phase, scopeSessionId, scopeTaskId), {
				session_id: scopeSessionId,
				task_id: scopeTaskId,
			});
		};
		for (const membership of state.memberships.values()) {
			if (membership.phase === phase)
				addScope(membership.session_id, membership.task_id);
		}
		for (const trace of state.emptyTraces.values()) {
			if (trace.phase === phase) addScope(trace.session_id, trace.task_id);
		}
		for (const lifecycle of state.phaseLifecycle.values()) {
			if (lifecycle.phase === phase)
				addScope(lifecycle.session_id, lifecycle.task_id);
		}
		if (scopeKeys.size === 0 && sessionId !== undefined) {
			addScope(sessionId, taskId);
		}
		if (scopeKeys.size === 0) {
			throw new ReceiptStoreError(
				'store_unavailable',
				'no exact receipt lifecycle scope exists for phase closure',
			);
		}
		if (sessionId === undefined && scopeKeys.size !== 1) {
			throw new ReceiptStoreError(
				'store_unavailable',
				'receipt lifecycle scope is ambiguous without an exact session identity',
			);
		}
		let eventId = '';
		for (const [key, scope] of scopeKeys) {
			const lifecycle = state.phaseLifecycle.get(key);
			const existingEventId =
				kind === 'phase_close_intent'
					? lifecycle?.intent_event_id
					: lifecycle?.closed_event_id;
			if (existingEventId) {
				eventId ||= existingEventId;
				continue;
			}
			const row = makeRecord(state, kind, { phase, ...scope });
			await appendRecord(paths, state, row);
			eventId ||= row.event_id;
		}
		if (kind === 'phase_closed') await compactIfNeeded(paths, state);
		return { event_id: eventId };
	});
}

export const recordPhaseCloseIntent = (
	directory: string,
	phase: string,
	sessionId?: string,
	taskId?: string,
) => phaseTransition(directory, phase, 'phase_close_intent', sessionId, taskId);
export const commitPhaseClosed = (
	directory: string,
	phase: string,
	sessionId?: string,
	taskId?: string,
) => phaseTransition(directory, phase, 'phase_closed', sessionId, taskId);
export async function reconcilePhaseClose(
	directory: string,
	phase: string,
	durablePlanClosed: boolean,
	sessionId?: string,
	taskId?: string,
): Promise<ReceiptLedgerResult<{ reconciled: boolean }>> {
	if (!durablePlanClosed) return { ok: true, reconciled: false };
	const result = await commitPhaseClosed(directory, phase, sessionId, taskId);
	return result.ok ? { ok: true, reconciled: true } : result;
}

async function compactIfNeeded(
	paths: ReceiptLedgerPaths,
	state: LedgerState,
): Promise<void> {
	const now = _internals.nowMs();
	const eligible = [...state.memberships.values()].filter(
		(m) =>
			(m.terminal || m.gate_release) &&
			m.phase_closed_at &&
			now >= Date.parse(m.phase_closed_at) + m.grace_days * 86_400_000,
	);
	const eligibleEmpty = [...state.emptyTraces.values()].filter(
		(trace) =>
			trace.terminal_event_id &&
			trace.phase_closed_at &&
			now >= Date.parse(trace.phase_closed_at) + trace.grace_days * 86_400_000,
	);
	if (
		!eligible.length &&
		!eligibleEmpty.length &&
		state.recordCount <= _internals.maxJournalRecords
	)
		return;
	const archiveById = new Map<string, ArchiveSummary>();
	const existing = await readUtf8IfPresent(paths.archive, MAX_ARCHIVE_BYTES);
	if (existing) {
		for (const line of existing.split('\n').filter(Boolean)) {
			let summary: ArchiveSummary | null = null;
			try {
				summary = parseArchiveSummary(JSON.parse(line));
			} catch {
				// handled below
			}
			if (!summary) {
				throw new ReceiptStoreError(
					'store_corrupt',
					'receipt archive contains an invalid summary',
				);
			}
			archiveById.set(archiveKey(summary), summary);
		}
	}
	const retainedArchive = [...archiveById.values()];
	let archiveContent = serializeArchive(retainedArchive);
	let archiveBytes = Buffer.byteLength(archiveContent, 'utf8');
	let archiveChanged = false;
	const retainIfCapacity = (summary: ArchiveSummary): void => {
		const key = archiveKey(summary);
		if (archiveById.has(key)) return;
		const line = `${JSON.stringify(summary)}\n`;
		const lineBytes = Buffer.byteLength(line, 'utf8');
		if (
			retainedArchive.length + 1 > _internals.maxArchiveRecords ||
			archiveBytes + lineBytes > _internals.maxArchiveBytes
		) {
			// Capacity pressure never discards prior authority. This summary remains
			// live and protected until archive capacity becomes available.
			return;
		}
		archiveById.set(key, summary);
		retainedArchive.push(summary);
		archiveContent += line;
		archiveBytes += lineBytes;
		archiveChanged = true;
	};
	for (const membership of eligible) retainIfCapacity(membership);
	for (const trace of eligibleEmpty) {
		retainIfCapacity({ ...trace, summary_kind: 'empty_trace' });
	}
	if (archiveChanged) {
		await _internals.atomicWriteFsynced(paths.archive, archiveContent);
	}
	const retainedIds = new Set(retainedArchive.map(archiveKey));
	for (const membership of eligible) {
		if (retainedIds.has(archiveKey(membership))) {
			state.memberships.delete(keyOf(membership.trace_id, membership.entry_id));
		}
	}
	for (const trace of eligibleEmpty) {
		const summary: ArchivedEmptyTrace = {
			...trace,
			summary_kind: 'empty_trace',
		};
		if (retainedIds.has(archiveKey(summary))) {
			state.emptyTraces.delete(emptyKeyOf(trace.trace_id, trace.session_id));
		}
	}
	for (const traceId of [...state.legacyTraceRegistry]) {
		const stillLive = [...state.memberships.values()].some(
			(membership) =>
				membership.origin === 'legacy' && membership.trace_id === traceId,
		);
		if (!stillLive) state.legacyTraceRegistry.delete(traceId);
	}
	state.traceIds = new Set(
		[...state.memberships.values()].map((membership) => membership.trace_id),
	);
	const fresh = emptyState(state.observations);
	fresh.cutoverCompleted = state.cutoverCompleted;
	fresh.legacyUnverifiable = state.legacyUnverifiable;
	fresh.legacyTraceRegistry = new Set(state.legacyTraceRegistry);
	fresh.legacyUnverifiableTraceIds = new Set(state.legacyUnverifiableTraceIds);
	fresh.phaseLifecycle = new Map(state.phaseLifecycle);
	fresh.repairUncertainties = new Map(state.repairUncertainties);
	fresh.auditTail = [...state.auditTail];
	const checkpoint = makeRecord(fresh, 'checkpoint', {
		memberships: [...state.memberships.values()],
		empty_traces: [...state.emptyTraces.values()],
		cutover_completed: state.cutoverCompleted,
		legacy_unverifiable: state.legacyUnverifiable,
		legacy_trace_registry: [...state.legacyTraceRegistry].sort(),
		legacy_unverifiable_trace_ids: [...state.legacyUnverifiableTraceIds].sort(),
		phase_lifecycle: [...state.phaseLifecycle.values()],
		repair_uncertainties: [...state.repairUncertainties.values()],
		audit_tail: state.auditTail,
	});
	await _internals.atomicWriteFsynced(
		paths.journal,
		`${JSON.stringify(checkpoint)}\n`,
	);
	state.lastSeq = checkpoint.seq;
	state.lastHash = checkpoint.hash;
	state.recordCount = 1;
	queueRecordObservations(state, checkpoint);
}

function serializeArchive(summaries: ArchiveSummary[]): string {
	return summaries.length
		? `${summaries.map((summary) => JSON.stringify(summary)).join('\n')}\n`
		: '';
}

export async function ensureLegacyCutover(
	directory: string,
	graceDays?: number,
): Promise<ReceiptLedgerResult<{ completed: true }>> {
	return runLocked(directory, graceDays, async () => ({
		completed: true as const,
	}));
}

export const _internals = {
	nowMs: (): number => Date.now(),
	writeSnapshot,
	atomicWriteFsynced,
	appendFsynced,
	/** Test-only migration fixture for pre-atomic marker-only state. */
	commitApplicationMarkerBatch,
	maxJournalRecords: MAX_JOURNAL_RECORDS,
	maxArchiveRecords: MAX_ARCHIVE_RECORDS,
	maxArchiveBytes: MAX_ARCHIVE_BYTES,
	maxRepairQuarantineRecords: MAX_REPAIR_QUARANTINE_RECORDS,
};
