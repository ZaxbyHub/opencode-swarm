/**
 * Observation construction and the legacy line projection (issue #2029).
 *
 * Import rules: no filesystem, network, subprocess, or OTel SDK. Everything here
 * is synchronous and allocation-only.
 *
 * ## Module state
 *
 * Four process-scoped variables. None is session-keyed, so AGENTS.md invariant 8
 * (session-scoped state must be keyed by `sessionID` and bounded) does not
 * apply: `_provenance` and `_lineage` are single small frozen-by-convention
 * records describing THIS process, `_sampleRate` is a scalar, and
 * `_writerSequence` is a scalar counter. None of them grows with session count,
 * so there is nothing to evict. All four have a reset seam
 * ({@link resetObservabilityForTesting}) so no test's assertions become order
 * dependent.
 */

import { getCatalogEntry } from './catalog.js';
import {
	type Lineage,
	OBSERVABILITY_SCHEMA_VERSION,
	type ObservabilityEvent,
	type Provenance,
} from './envelope.js';
import {
	newEventId,
	newTraceAndSpanId,
	pseudonymousRef,
	resolveLineageSalt,
} from './ids.js';
import {
	adaptLegacyTelemetryPayload,
	extractOutcome,
	extractWorkflowIds,
	KNOWN_TELEMETRY_KEYS,
	LEGACY_TELEMETRY_SOURCE_STORE,
} from './legacy.js';
import { validateEventRelationships } from './relationships.js';
import { DEFAULT_SAMPLE_RATE, shouldSample } from './sampling.js';

// ============================================================================
// Module state
// ============================================================================

let _provenance: Provenance = Object.freeze({});
// Frozen even here: every observation receives THIS object by reference, so an
// unfrozen shared default (before init, or if initObservability catches) would
// let one consumer mutate lineage for every subsequent event.
let _lineage: Lineage = Object.freeze({});
/**
 * PER-PROCESS monotonic counter. It disambiguates the order of two records that
 * carry the same timestamp WITHIN one writer process — it is meaningless across
 * processes and across sessions, and must never be used as a global ordering.
 */
let _writerSequence = 0;
let _sampleRate: number = DEFAULT_SAMPLE_RATE;

const EMPTY_KNOWN_KEYS: readonly string[] = Object.freeze([]);

/**
 * Sentinel identities used only by the fallback event. They are CONSTANTS, not
 * generated: the fallback exists to survive a failure that may well have been
 * `randomBytes`/`randomUUID` throwing, so it must not call them again. Both are
 * W3C-shaped and non-all-zero. They are intentionally NOT unique — an event
 * carrying them is identifiable as a construction failure.
 */
const FALLBACK_EVENT_ID = '00000000-0000-4000-8000-000000000000';
const FALLBACK_TRACE_ID = '00000000000000000000000000000001';
const FALLBACK_SPAN_ID = '0000000000000001';
const FALLBACK_TIMESTAMP = '1970-01-01T00:00:00.000Z';

/** Violation code stamped on a fallback event. */
export const OBSERVATION_BUILD_FAILED = 'observation_build_failed';

// ============================================================================
// Initialization
// ============================================================================

/** Input to {@link initObservability}. */
export interface InitObservabilityInput {
	/** Absolute project root. Pseudonymized, never stored. */
	directory?: string;
	/** Cohort label (e.g. a swarm id). Pseudonymized together with `directory`. */
	cohortLabel?: string;
	/** Worktree identity. Pseudonymized, never stored. */
	worktreeId?: string;
	provenance?: Provenance;
	sampleRate?: number;
}

/**
 * Install process provenance and lineage.
 *
 * Performs ZERO I/O — it hashes strings the caller already holds. That matters
 * for AGENTS.md invariant 1: this runs on the plugin init path, and init-path
 * work must be fast, bounded and side-effect-minimal.
 *
 * Lineage refs are computed ONCE here and reused by every subsequent
 * observation. Computing them per-emit would put three SHA-256 digests on the
 * hot path for values that never change within a process.
 *
 * NEVER THROWS. The whole body is guarded: a failure here must not prevent the
 * plugin manifest from being returned (invariant 1, fail-open).
 */
export function initObservability(input: InitObservabilityInput): void {
	try {
		const salt = resolveLineageSalt();
		const lineage: Lineage = {};

		const directory =
			typeof input.directory === 'string' && input.directory.length > 0
				? input.directory
				: undefined;
		if (directory !== undefined) {
			lineage.projectRef = pseudonymousRef(directory, salt);
		}

		// The cohort ref is bound to the project path, not just the label. Two
		// projects using the SAME cohort label must not share an identity —
		// that is acceptance criterion AC3.
		if (typeof input.cohortLabel === 'string' && input.cohortLabel.length > 0) {
			lineage.cohortRef = pseudonymousRef(
				`${directory ?? ''}\u0000${input.cohortLabel}`,
				salt,
			);
		}

		if (typeof input.worktreeId === 'string' && input.worktreeId.length > 0) {
			lineage.worktreeRef = pseudonymousRef(input.worktreeId, salt);
		}

		// Frozen because every observation receives the SAME object reference
		// (they are computed once, never per-emit). Without the freeze, a future
		// consumer that mutated `event.lineage` would corrupt every subsequent
		// event in the process.
		_lineage = Object.freeze(lineage);
		// Shallow copy, then freeze, so neither a later mutation by the caller nor
		// one by a consumer can retroactively change events already emitted.
		_provenance = Object.freeze(
			input.provenance ? { ...input.provenance } : {},
		);

		if (
			typeof input.sampleRate === 'number' &&
			Number.isFinite(input.sampleRate)
		) {
			_sampleRate = input.sampleRate;
		}
	} catch {
		// Fail open: observability must never break plugin initialization.
	}
}

// ============================================================================
// Observation
// ============================================================================

function nextWriterSequence(): number {
	// Wrap defensively rather than drift into imprecise integers. Unreachable in
	// any real process (2^53 emits), but a silently wrong counter would be worse
	// than a restarted one.
	if (_writerSequence >= Number.MAX_SAFE_INTEGER) _writerSequence = 0;
	_writerSequence += 1;
	return _writerSequence;
}

function safeNowIso(): string {
	try {
		return new Date().toISOString();
	} catch {
		return FALLBACK_TIMESTAMP;
	}
}

/**
 * Minimal valid event used when construction fails.
 *
 * Built from literals only — no CSPRNG call, no catalog lookup, no validation —
 * so it cannot fail for the same reason the main path did. `legacy.raw` still
 * aliases the caller's payload, so the legacy projection remains byte-identical.
 */
function buildFallbackObservation(
	kind: string,
	data: unknown,
	writerSequence: number,
): ObservabilityEvent {
	const now = safeNowIso();
	return {
		schemaVersion: OBSERVABILITY_SCHEMA_VERSION,
		eventId: FALLBACK_EVENT_ID,
		kind,
		category: 'unrecognized',
		severity: 'error',
		occurredAt: now,
		observedAt: now,
		writerSequence,
		trace: { traceId: FALLBACK_TRACE_ID, spanId: FALLBACK_SPAN_ID, links: [] },
		workflow: {},
		lineage: {},
		provenance: {},
		outcome: {},
		policy: {
			sampled: true,
			sampleRate: DEFAULT_SAMPLE_RATE,
			privacyClass: 'operational',
		},
		legacy: {
			sourceStore: LEGACY_TELEMETRY_SOURCE_STORE,
			sourceSchemaVersion: null,
			// No defensible statement can be made about this record's timing.
			timingConfidence: 'unknown',
			unknown: [],
			extra: {},
			raw: data,
		},
		relationshipViolations: [OBSERVATION_BUILD_FAILED],
	};
}

/**
 * Build the canonical observation for one emit.
 *
 * **NEVER THROWS.** Not on a circular object, not on a function / `Symbol` /
 * `BigInt` payload, not on an unknown kind, not on `null` or `undefined` data.
 * It never calls `JSON.stringify`, never clones, and never deep-traverses
 * `data` — `src/telemetry.test.ts:137-162` emits exactly those payloads and
 * asserts `emit()` does not throw, and `src/telemetry.ts:266` documents the
 * never-throw guarantee. If anything inside fails, a minimal valid event is
 * returned carrying `relationshipViolations: ['observation_build_failed']`.
 *
 * An UNCATALOGUED kind is classified (`category: 'unrecognized'`), never
 * dropped. Preventing new unrecognized kinds is the static contract check's job,
 * not a runtime drop.
 *
 * `occurredAt` is set equal to `observedAt`. That is a recorded finding, not an
 * invention: no current producer supplies a distinct time at which the described
 * thing happened, so claiming one would fabricate precision the source does not
 * have.
 */
export function createObservation(
	kind: string,
	data: unknown,
): ObservabilityEvent {
	// Taken before the guarded region so the counter advances exactly once per
	// call, on both the normal and the fallback path.
	const writerSequence = nextWriterSequence();
	try {
		const entry = getCatalogEntry(kind);
		const { traceId, spanId } = newTraceAndSpanId();
		const observedAt = new Date().toISOString();
		const knownKeys = Object.hasOwn(KNOWN_TELEMETRY_KEYS, kind)
			? KNOWN_TELEMETRY_KEYS[kind]
			: EMPTY_KNOWN_KEYS;

		const event: ObservabilityEvent = {
			schemaVersion: OBSERVABILITY_SCHEMA_VERSION,
			eventId: newEventId(),
			kind,
			category: entry?.category ?? 'unrecognized',
			severity: entry?.severity ?? 'warning',
			occurredAt: observedAt,
			observedAt,
			writerSequence,
			// No producer supplies a parent span or links today, so neither is
			// synthesized. `parentSpanId` stays absent rather than becoming ''.
			trace: { traceId, spanId, links: [] },
			workflow: extractWorkflowIds(data),
			// Shared references to process-scoped records, computed once at init.
			lineage: _lineage,
			provenance: _provenance,
			outcome: extractOutcome(data),
			policy: {
				sampled: shouldSample(traceId, _sampleRate),
				sampleRate: _sampleRate,
				privacyClass: entry?.privacyClass ?? 'operational',
			},
			legacy: adaptLegacyTelemetryPayload(kind, data, knownKeys),
			relationshipViolations: [],
		};

		const validation = validateEventRelationships(event);
		if (!validation.ok) event.relationshipViolations = validation.violations;

		return event;
	} catch {
		return buildFallbackObservation(kind, data, writerSequence);
	}
}

// ============================================================================
// Legacy projection
// ============================================================================

/**
 * Project a canonical event onto the legacy `.swarm/telemetry.jsonl` record.
 *
 * ## This projection is LOSSY and LEGACY-PINNED
 *
 * The envelope's non-legacy fields — `eventId`, `trace` (`traceId`, `spanId`,
 * `parentSpanId`, `links`), `lineage`, `provenance`, `policy`, `writerSequence`,
 * `schemaVersion` and `relationshipViolations` — are **currently DISCARDED**.
 * Nothing in this change consumes them; their consumer lands in **#2047**. That
 * is stated here rather than buried: a reader of this function must not conclude
 * the written line is the canonical record. It is not.
 *
 * ## Byte-for-byte preservation
 *
 * The caller's object is spread **LAST**, exactly as
 * `the pre-change inline construction (removed by this change)` does today. Three properties depend on that
 * ordering, and all three are observable in
 * `tests/fixtures/observability/telemetry-lines-golden.json` (issue #2029 item
 * 5 arm (a) — "preserve the existing output"):
 *
 *   1. **Caller key order** is preserved after `timestamp` and `event`.
 *   2. **Caller key collisions win on value.** `conflict-resolution.ts:55-66`
 *      supplies its own `timestamp` and `type`; the caller's `timestamp` value
 *      overwrites the envelope's while the key keeps position 1.
 *   3. **`undefined`-key elision** is unchanged, because the caller's own object
 *      is spread rather than a reconstruction of it.
 *
 * `timestamp` is taken from `event.observedAt` — a real, load-bearing data
 * dependency on the canonical event, which is why this composition is not the
 * identity function on the emit path.
 *
 * A non-object, `null`, or array payload yields just `{ timestamp, event }`,
 * matching what `JSON.stringify({ timestamp, event, ...data })` produces for
 * those inputs.
 */
export function toLegacyTelemetryLine(
	event: ObservabilityEvent,
): Record<string, unknown> {
	// The spread is DELIBERATELY unconditional and un-narrowed. Object spread is
	// already total: `null`/`undefined` spread to nothing, primitives spread their
	// own enumerable properties (a string spreads to index keys), and arrays spread
	// to index keys. Pre-guarding on `typeof raw === 'object'` would silently DROP
	// those keys and change the bytes for off-contract payloads — and byte
	// preservation is this PR's compliance condition (issue #2029 item 5 arm (a)),
	// not a best-effort. `...raw` here is exactly `...data` at the original
	// `src/telemetry.ts` construction site, for every possible input.
	return {
		timestamp: event.observedAt,
		event: event.kind,
		...(event.legacy.raw as Record<string, unknown>),
	};
}

// ============================================================================
// Test seams
// ============================================================================

/**
 * Reset all four module-scoped variables.
 *
 * Called alongside `resetTelemetryForTesting` so no test's assertions become
 * dependent on how many events an earlier test emitted.
 *
 * @internal - For testing only
 */
export function resetObservabilityForTesting(): void {
	_provenance = Object.freeze({});
	_lineage = Object.freeze({});
	_writerSequence = 0;
	_sampleRate = DEFAULT_SAMPLE_RATE;
}
