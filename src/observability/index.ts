/**
 * The observability event contract (issue #2029).
 *
 * Reference documentation: `docs/observability-event-contract.md`.
 *
 * ## What this module is
 *
 * A versioned, discriminated, catalogued envelope for every observability record
 * this plugin produces, plus the adapter that projects the existing untyped
 * telemetry payloads onto it. The defect class it closes: *a production
 * telemetry record is written without a versioned, discriminated, catalogued
 * envelope — so a consumer cannot determine producer, schema generation, or
 * unknown-versus-absent, and a new event kind can enter the stream without any
 * registration.*
 *
 * ## The guarantees callers can rely on
 *
 * - **Zero I/O.** No filesystem, network, subprocess, dynamic import, or
 *   OpenTelemetry SDK anywhere in this directory. `node:crypto` and `zod` are
 *   the only imports. That is what keeps `initObservability` safe on the plugin
 *   init path (AGENTS.md invariant 1) and the bundle Node-ESM-portable
 *   (invariant 2).
 * - **`createObservation` never throws** — not on a circular object, a
 *   function/`Symbol`/`BigInt` payload, an unknown kind, or `null` data. It
 *   never serializes, clones, or deep-traverses the payload.
 * - **`legacy.raw` is an ALIAS** to the caller's payload, never a copy. Key
 *   order, key collisions and `undefined`-key elision in the written line depend
 *   on it.
 * - **Nothing is synthesized.** An identifier the producer does not hold stays
 *   `undefined`; an unversioned store records `sourceSchemaVersion: null`
 *   (unknown, not zero); an absent field is listed in `legacy.unknown` rather
 *   than defaulted.
 * - **Validation returns, never throws.** `validateEventRelationships` and
 *   `assertBoundedCardinality` both yield verdicts.
 *
 * ## What it is NOT, stated plainly
 *
 * The envelope is not yet authoritative. `toLegacyTelemetryLine` is a
 * deliberately lossy, legacy-pinned projection: the non-legacy fields
 * (`eventId`, `trace`, `lineage`, `provenance`, `policy`, `writerSequence`,
 * `relationshipViolations`) are currently discarded, and their consumer lands in
 * **#2047**. Consequently `validateEventRelationships` does not bite at runtime
 * today — it bites in unit tests and in the static contract check.
 */

export type { CatalogEntry, OtelMappingKind } from './catalog.js';
// ── Catalog ─────────────────────────────────────────────────────────────────
export {
	CATALOG_KINDS,
	EVENT_CATALOG,
	getCatalogEntry,
} from './catalog.js';
export type {
	Lineage,
	ObservabilityEvent,
	Outcome,
	Policy,
	Provenance,
} from './envelope.js';
// ── Envelope ────────────────────────────────────────────────────────────────
export {
	OBSERVABILITY_SCHEMA_VERSION,
	ObservabilityEventSchema,
} from './envelope.js';
export type { TraceAndSpanId } from './ids.js';
// ── Identity ────────────────────────────────────────────────────────────────
// `newTraceId` is deliberately NOT re-exported. It had zero consumers through
// this barrel, and its name collides with `newTraceId` in
// `src/hooks/knowledge-events.ts` — identical `(): string` signature, different
// on-wire shape (32 hex vs. a 36-character UUID) and no type guard between them.
// The function itself stays in `./ids.js`, where `newTraceAndSpanId` uses it.
export {
	newEventId,
	newSpanId,
	pseudonymousRef,
	SPAN_ID_HEX_LENGTH,
	TRACE_ID_HEX_LENGTH,
} from './ids.js';
// ── Legacy adapter ──────────────────────────────────────────────────────────
export {
	adaptLegacyTelemetryPayload,
	extractOutcome,
	extractWorkflowIds,
	KNOWN_TELEMETRY_KEYS,
	LEGACY_ADAPTER_RULES,
	NON_OBJECT_PAYLOAD_MARKER,
} from './legacy.js';
export type { InitObservabilityInput } from './observe.js';
// ── Observation ─────────────────────────────────────────────────────────────
export {
	createObservation,
	initObservability,
	resetObservabilityForTesting,
	toLegacyTelemetryLine,
} from './observe.js';
// ── External convention mappings ────────────────────────────────────────────
export {
	mappingForEntry,
	OPENINFERENCE_ATTRIBUTES,
	OPENINFERENCE_MAPPING_VERSION,
	OTEL_GENAI_ATTRIBUTES,
	OTEL_GENAI_MAPPING_VERSION,
} from './otel-mapping.js';
export type { RelationshipValidationResult } from './relationships.js';
// ── Relationships ───────────────────────────────────────────────────────────
export {
	RELATIONSHIP_VIOLATION_CODES,
	validateEventRelationships,
} from './relationships.js';
export type { CardinalityResult } from './sampling.js';
// ── Sampling and metric cardinality ─────────────────────────────────────────
export {
	assertBoundedCardinality,
	METRIC_LABEL_ALLOWLIST,
	shouldSample,
} from './sampling.js';
