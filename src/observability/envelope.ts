/**
 * Canonical observability event envelope (issue #2029).
 *
 * These zod schemas are the contract definition. They are used by tests and by
 * the static contract check — NOT on the `emit()` hot path. `createObservation`
 * constructs a plain object and never calls `.parse()`, because parsing would
 * reallocate the envelope on every emit and, critically, would clone or reject
 * `legacy.raw` (see {@link LegacyProjectionSchema}).
 *
 * Import rules: `zod` only. No filesystem, network, subprocess, or OTel SDK.
 */
import { z } from 'zod';

/**
 * Version of the envelope shape itself.
 *
 * Deliberately independent of the OTel GenAI / OpenInference mapping versions in
 * `otel-mapping.ts`: external convention churn must never force a change to
 * internal domain state (issue #2029 item 6).
 */
export const OBSERVABILITY_SCHEMA_VERSION = 1;

// ============================================================================
// Enumerations
// ============================================================================

/**
 * Coarse event family. `unrecognized` is reserved for the runtime fail-open
 * path: an event kind absent from `EVENT_CATALOG` is classified, never dropped.
 */
export const EventCategorySchema = z.enum([
	'lifecycle',
	'delegation',
	'gate',
	'plan',
	'evidence',
	'guardrail',
	'knowledge',
	'cost',
	'prm',
	'conflict',
	'unrecognized',
]);
export type EventCategory = z.infer<typeof EventCategorySchema>;

/** Syslog-shaped severity ladder. */
export const EventSeveritySchema = z.enum([
	'debug',
	'info',
	'notice',
	'warning',
	'error',
	'critical',
]);
export type EventSeverity = z.infer<typeof EventSeveritySchema>;

/**
 * Handling class for the payload an event carries.
 *
 * - `operational`  — counters, enums, durations. No identifiers.
 * - `pseudonymous` — session/task/agent identifiers, but no paths or free text.
 * - `sensitive`    — filesystem paths or free-text error strings that can embed
 *                    a path.
 * - `content`      — prompts, responses, documents, tool payloads. No event in
 *                    the current catalog is `content`; the class exists so a
 *                    future producer cannot enter the stream unclassified.
 */
export const PrivacyClassSchema = z.enum([
	'operational',
	'pseudonymous',
	'sensitive',
	'content',
]);
export type PrivacyClass = z.infer<typeof PrivacyClassSchema>;

/**
 * How much trust the recorded time deserves.
 *
 * - `exact`        — the producer supplied the instant the thing happened.
 * - `writer-clock` — the time was read by the writer at record time (this is
 *                    what every current producer does).
 * - `inferred`     — reconstructed from surrounding records.
 * - `unknown`      — no defensible statement can be made. NOT a synonym for
 *                    `writer-clock` (issue #2029 item 4: unknown is not zero).
 */
export const TimingConfidenceSchema = z.enum([
	'exact',
	'writer-clock',
	'inferred',
	'unknown',
]);
export type TimingConfidence = z.infer<typeof TimingConfidenceSchema>;

// ============================================================================
// Trace context
// ============================================================================

/**
 * A non-parent relationship to another span.
 *
 * `kind` records WHY the link exists, so a consumer can tell a resumed session
 * apart from a parallel lane apart from a retry — a distinction the issue calls
 * out as unrecoverable once flattened into an untyped parent pointer.
 */
export const SpanLinkSchema = z.object({
	traceId: z.string(),
	spanId: z.string(),
	kind: z.enum(['resume', 'lane', 'cross-process', 'retry', 'parent-batch']),
	note: z.string().optional(),
});
export type SpanLink = z.infer<typeof SpanLinkSchema>;

/** W3C-compatible trace context plus typed links. */
export const TraceContextSchema = z.object({
	/** 32 lowercase hex characters. */
	traceId: z.string(),
	/** 16 lowercase hex characters. */
	spanId: z.string(),
	/**
	 * Absent when this event has no parent. Never `''` and never a synthesized
	 * value — an absent parent is recorded as absent.
	 */
	parentSpanId: z.string().optional(),
	links: z.array(SpanLinkSchema),
});
export type TraceContext = z.infer<typeof TraceContextSchema>;

// ============================================================================
// Workflow identity
// ============================================================================

/**
 * The correlation identifiers the contract recognizes.
 *
 * All optional by contract. An ID that the producer does not genuinely hold
 * stays `undefined` — never `''`, never synthesized (issue #2029 item 2: never
 * manufacture an ID to make a join succeed).
 *
 * The enumeration is exhaustive on purpose. A producer that needs a correlation
 * axis not listed here must extend this schema and the catalog together, so a
 * new join key cannot enter the stream unregistered.
 */
export const WorkflowIdsSchema = z.object({
	/** Outermost user-facing conversation. */
	rootConversationId: z.string().optional(),
	/** The host runtime's session identifier (`sessionId` in legacy payloads). */
	hostSessionId: z.string().optional(),
	/** The swarm's own session identity, when distinct from the host's. */
	swarmSessionId: z.string().optional(),
	taskId: z.string().optional(),
	/** Stringified phase number. Stringified because phases are labels, not math. */
	phaseId: z.string().optional(),
	laneId: z.string().optional(),
	batchId: z.string().optional(),
	resultId: z.string().optional(),
	councilRoundId: z.string().optional(),
	backgroundInvocationId: z.string().optional(),
	knowledgeTraceId: z.string().optional(),
	knowledgeEntryId: z.string().optional(),
	prRunId: z.string().optional(),
});
export type WorkflowIds = z.infer<typeof WorkflowIdsSchema>;

/** Key of a recognized correlation identifier. */
export type WorkflowIdKey = keyof WorkflowIds;

// ============================================================================
// Lineage and provenance
// ============================================================================

/**
 * Pseudonymous lineage refs.
 *
 * Every field is a salted, truncated SHA-256 digest produced by
 * `pseudonymousRef` — never a path, never a label. Absent means "the producer
 * did not hold this", not "empty".
 */
export const LineageSchema = z.object({
	projectRef: z.string().optional(),
	cohortRef: z.string().optional(),
	worktreeRef: z.string().optional(),
});
export type Lineage = z.infer<typeof LineageSchema>;

/**
 * Environment facts about the writer.
 *
 * `gitSha` and `configHash` are deliberately left `undefined` by the current
 * initialization path. This is a decision, not an oversight: obtaining a HEAD
 * SHA would require a THIRD init-path subprocess (`ensureSwarmGitExcluded`
 * already runs `git rev-parse --show-toplevel` and `git rev-parse --git-path
 * info/exclude`, neither of which yields a SHA), and AGENTS.md invariant 1
 * forbids adding unbounded Git work before the plugin manifest returns —
 * "bounded is not free". See fix plan W2.
 *
 * Recording them as explicitly missing rather than as `''` or `'unknown'` is the
 * issue's own item-4 rule ("unknown is not zero") applied to ourselves.
 */
export const ProvenanceSchema = z.object({
	pluginVersion: z.string().optional(),
	opencodeVersion: z.string().optional(),
	runtime: z.string().optional(),
	runtimeVersion: z.string().optional(),
	os: z.string().optional(),
	arch: z.string().optional(),
	model: z.string().optional(),
	provider: z.string().optional(),
	/** Deliberately undefined — see the schema doc comment. */
	gitSha: z.string().optional(),
	/** Deliberately undefined — see the schema doc comment. */
	configHash: z.string().optional(),
});
export type Provenance = z.infer<typeof ProvenanceSchema>;

// ============================================================================
// Outcome and policy
// ============================================================================

/**
 * Terminal disposition, when the producer reported one.
 *
 * `status` absent means the producer said nothing about success or failure.
 * `'unknown'` means the producer DID report a result the contract cannot map —
 * a different fact, kept distinct on purpose.
 */
export const OutcomeSchema = z.object({
	status: z.enum(['success', 'failure', 'partial', 'unknown']).optional(),
	reason: z.string().optional(),
	errorName: z.string().optional(),
	errorMessage: z.string().optional(),
	retryIndex: z.number().optional(),
	durationMs: z.number().optional(),
});
export type Outcome = z.infer<typeof OutcomeSchema>;

/**
 * Sampling and privacy policy stamped on the event.
 *
 * `sampled: false` plus a `dropReason` is how a drop is made observable. A
 * silently discarded event is exactly the failure the issue names.
 */
export const PolicySchema = z.object({
	sampled: z.boolean(),
	sampleRate: z.number(),
	dropReason: z.string().optional(),
	privacyClass: PrivacyClassSchema,
});
export type Policy = z.infer<typeof PolicySchema>;

// ============================================================================
// Legacy projection
// ============================================================================

/**
 * What the legacy adapter could establish about a pre-contract record.
 *
 * ## `raw` is an ALIAS, not a copy
 *
 * `raw` holds a REFERENCE to the caller's payload object. It is never cloned,
 * never `JSON.stringify`-ed, never deep-traversed, and never passed through
 * `.parse()`. Three properties depend on that:
 *
 *   1. **Key order** — the legacy JSONL line spreads the caller's object last,
 *      so caller key order is preserved byte-for-byte.
 *   2. **Key collisions** — a caller that supplies its own `timestamp` (see
 *      `src/hooks/conflict-resolution.ts:55-66`) must keep winning on value.
 *   3. **`undefined` elision** — `JSON.stringify` drops `undefined`-valued keys.
 *      Any clone or parse step would change which keys survive.
 *
 * It is also a hard safety requirement: `src/telemetry.test.ts:137-162` emits
 * circular objects, functions, `Symbol`s and `BigInt`s and asserts `emit()` does
 * not throw. Cloning or serializing `raw` would throw on those payloads.
 *
 * ## `sourceSchemaVersion: null`
 *
 * `null` means "this store does not version its records — the version is
 * UNKNOWN". It does NOT mean version zero. `.swarm/telemetry.jsonl` carries no
 * version field at all; that absence is itself a finding of issue #2029, and
 * recording it as `0` would fabricate a fact the store never stated.
 */
export const LegacyProjectionSchema = z.object({
	/** Store the record came from, e.g. `.swarm/telemetry.jsonl`. */
	sourceStore: z.string(),
	/** `null` = store is unversioned (unknown), NOT version zero. */
	sourceSchemaVersion: z.number().nullable(),
	timingConfidence: TimingConfidenceSchema,
	/**
	 * Fields the producer was EXPECTED to supply but did not. These are
	 * "producer did not know" — explicitly not zero, not empty string, not a
	 * default.
	 */
	unknown: z.array(z.string()),
	/**
	 * Own keys present on the payload that the contract does not recognize.
	 * Values are held by reference. Unrecognized fields are never dropped.
	 */
	extra: z.record(z.string(), z.unknown()),
	/** ALIAS to the caller's payload — see the schema doc comment. */
	raw: z.unknown(),
});

/**
 * `raw` is required on every projection. zod infers a key typed `unknown` as
 * optional (because `undefined extends unknown`), so the required-ness is
 * restated here rather than weakened in the schema.
 */
export type LegacyProjection = Omit<
	z.infer<typeof LegacyProjectionSchema>,
	'raw' | 'unknown' | 'extra'
> & {
	raw: unknown;
	// Declared `readonly` because the common-case values are FROZEN module-level
	// singletons shared by every observation (see EMPTY_UNKNOWN / EMPTY_EXTRA in
	// legacy.ts). Typing them mutable would be a lie the compiler cannot catch —
	// a consumer that pushed onto `unknown` would throw at runtime in strict mode.
	// Issue #2029 exists to close type-system bypasses; it must not ship one.
	readonly unknown: readonly string[];
	readonly extra: Readonly<Record<string, unknown>>;
};

// ============================================================================
// The envelope
// ============================================================================

/** The canonical observability event. */
export const ObservabilityEventSchema = z.object({
	schemaVersion: z.number(),
	eventId: z.string(),
	kind: z.string(),
	category: EventCategorySchema,
	severity: EventSeveritySchema,
	/**
	 * When the described thing happened. Currently equal to `observedAt` for
	 * every producer, because no producer supplies a distinct occurred time.
	 * That equality is a recorded finding of the producer/consumer matrix, not
	 * an invented value.
	 */
	occurredAt: z.string(),
	/** When the writer recorded the event. */
	observedAt: z.string(),
	/** Per-process monotonic counter — see `observe.ts`. */
	writerSequence: z.number(),
	trace: TraceContextSchema,
	workflow: WorkflowIdsSchema,
	lineage: LineageSchema,
	provenance: ProvenanceSchema,
	outcome: OutcomeSchema,
	policy: PolicySchema,
	legacy: LegacyProjectionSchema,
	/**
	 * Stable machine-readable violation codes from
	 * `validateEventRelationships`. Empty means the event satisfied every
	 * catalogued relationship rule.
	 */
	relationshipViolations: z.array(z.string()),
});

/** See {@link LegacyProjection} for why `legacy` is restated. */
export type ObservabilityEvent = Omit<
	z.infer<typeof ObservabilityEventSchema>,
	'legacy'
> & { legacy: LegacyProjection };
