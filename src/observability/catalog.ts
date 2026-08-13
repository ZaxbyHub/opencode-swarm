/**
 * The event catalog (issue #2029).
 *
 * Exactly 40 entries, matching the `TelemetryEvent` union at
 * `src/telemetry.ts:15-91`. Thirty-eight predate the #2029 contract; the 39th is
 * `agent_conflict_detected` (previously emitted through a force-cast past the
 * type system), and the 40th is `close_archive_result` (issue #2030 — the
 * structured close/archive result event). Both late additions are instances of
 * the defect class this contract exists to close: an event kind entering the
 * stream with no registration.
 *
 * Every entry names a real producer `file:line`, a retention owner issue at or
 * above #2030 — every entry today cites the #2030-#2051 programme, but only the
 * LOWER bound is enforced, so a successor issue numbered past that window is not
 * forced into a false in-window citation — a privacy class, a doc anchor and a
 * test file. An entry with no
 * live reader declares `consumers: []` AND a `futureOwnerIssue` — an empty
 * consumer list without an owner is a contract violation, not a shrug.
 *
 * Import rules: no filesystem, network, subprocess, or OTel SDK.
 */
import type {
	EventCategory,
	EventSeverity,
	PrivacyClass,
	WorkflowIdKey,
} from './envelope.js';

/** Which external attribute table, if any, an entry projects onto. */
export type OtelMappingKind = 'genai' | 'openinference' | 'none';

/** One catalogued event kind. */
export interface CatalogEntry {
	/** The wire value written as the `event` field. */
	readonly kind: string;
	readonly category: EventCategory;
	readonly severity: EventSeverity;
	readonly privacyClass: PrivacyClass;
	/** Real `file:line` of the emit call that produces this kind. */
	readonly producer: string;
	/**
	 * Real `file:line` of each live reader. Empty is permitted ONLY together
	 * with {@link futureOwnerIssue}.
	 */
	readonly consumers: readonly string[];
	/** Owner issue for a kind that currently has no reader. */
	readonly futureOwnerIssue?: number;
	/**
	 * Owner issue for this kind's retention/lifecycle decision. Must be >= #2030;
	 * every entry today names the #2030-#2051 programme, but no upper bound is
	 * enforced (see `scripts/check-event-contract.ts`).
	 */
	readonly retentionOwnerIssue: number;
	/**
	 * Correlation IDs the producer GENUINELY always supplies. Conservative by
	 * construction: listing an ID the producer sometimes omits would turn a
	 * truthful "absent" into a false violation, and listing one nothing
	 * populates would make every event of that kind violate.
	 */
	readonly requiredWorkflowIds: readonly WorkflowIdKey[];
	/**
	 * Correlation IDs this producer genuinely never holds. Presence of one means
	 * an ID was manufactured somewhere upstream to make a join succeed — the
	 * exact anti-pattern issue #2029 item 2 forbids.
	 */
	readonly forbiddenWorkflowIds: readonly WorkflowIdKey[];
	/**
	 * Whether an event of this kind must carry `trace.parentSpanId`.
	 *
	 * `false` for all 40 entries today, and that is a truthful statement about
	 * the current system rather than a placeholder: no producer supplies a
	 * parent span, so `createObservation` never sets one. Setting this to `true`
	 * for a kind whose producer cannot supply a parent would make every
	 * production event of that kind violate.
	 */
	readonly requiresParent: boolean;
	/** Whether typed span links are meaningful for this kind. */
	readonly allowsLinks: boolean;
	readonly otelMapping: OtelMappingKind;
	/** Anchor in `docs/observability-event-contract.md`. */
	readonly docAnchor: string;
	/** Test that asserts this entry's completeness. */
	readonly testFile: string;
}

/** Every catalog entry is asserted by this test. */
const CATALOG_TEST_FILE = 'tests/unit/observability/catalog-contract.test.ts';

/** Owner of the observability sink / consumer work; also the default backstop. */
const ISSUE_SINK = 2047;
/** Owner of lifecycle + terminal-state retention. */
const ISSUE_LIFECYCLE_RETENTION = 2045;
/** Owner of cost provenance retention. */
const ISSUE_COST_RETENTION = 2043;
/** Owner of the plan/evidence retention registry. */
const ISSUE_PLAN_EVIDENCE_RETENTION = 2036;

const NO_WORKFLOW_IDS: readonly WorkflowIdKey[] = Object.freeze([]);
const NO_CONSUMERS: readonly string[] = Object.freeze([]);

const REQUIRE_SESSION: readonly WorkflowIdKey[] = Object.freeze([
	'hostSessionId',
]);
const REQUIRE_SESSION_AND_TASK: readonly WorkflowIdKey[] = Object.freeze([
	'hostSessionId',
	'taskId',
]);
const REQUIRE_TASK: readonly WorkflowIdKey[] = Object.freeze(['taskId']);

/**
 * `hostSessionId` is FORBIDDEN on the kinds whose producer genuinely has no
 * session in scope. Verified against source, not assumed:
 * `gate_parse_error` (`src/telemetry.ts:456-462`) takes only `taskId` and the
 * error; the three evidence-lock kinds and the three plan kinds are emitted from
 * modules that never receive a session id. If one of these ever arrives with a
 * session id, it was manufactured.
 */
const FORBID_SESSION: readonly WorkflowIdKey[] = Object.freeze([
	'hostSessionId',
]);

/** Live reader of `delegation_end` cost fields. */
const CONSUMER_COST_ACCOUNTING = Object.freeze([
	'src/services/cost-accounting.ts:127',
]);
/** Live reader of reviewer-gate decisions. */
const CONSUMER_GATE_STATS = Object.freeze(['src/evaluation/gate-stats.ts:99']);
/** In-process listener that tracks last-activity per session. */
const CONSUMER_HEARTBEAT_LISTENER = Object.freeze(['src/telemetry.ts:158']);

interface CatalogEntryInput {
	readonly category: EventCategory;
	readonly severity: EventSeverity;
	readonly privacyClass: PrivacyClass;
	readonly producer: string;
	readonly consumers: readonly string[];
	readonly futureOwnerIssue?: number;
	readonly retentionOwnerIssue: number;
	readonly requiredWorkflowIds?: readonly WorkflowIdKey[];
	readonly forbiddenWorkflowIds?: readonly WorkflowIdKey[];
	readonly requiresParent?: boolean;
	readonly allowsLinks?: boolean;
	readonly otelMapping?: OtelMappingKind;
}

function defineEntry(kind: string, input: CatalogEntryInput): CatalogEntry {
	const entry: CatalogEntry = {
		kind,
		category: input.category,
		severity: input.severity,
		privacyClass: input.privacyClass,
		producer: input.producer,
		consumers: input.consumers,
		retentionOwnerIssue: input.retentionOwnerIssue,
		requiredWorkflowIds: input.requiredWorkflowIds ?? NO_WORKFLOW_IDS,
		forbiddenWorkflowIds: input.forbiddenWorkflowIds ?? NO_WORKFLOW_IDS,
		requiresParent: input.requiresParent ?? false,
		allowsLinks: input.allowsLinks ?? true,
		otelMapping: input.otelMapping ?? 'none',
		docAnchor: `#${kind}`,
		testFile: CATALOG_TEST_FILE,
	};
	// Only attach the key when an owner exists, so a consumer can distinguish
	// "declared no owner" from "declared owner undefined" via `in`/`hasOwn`.
	if (input.futureOwnerIssue !== undefined) {
		return Object.freeze({
			...entry,
			futureOwnerIssue: input.futureOwnerIssue,
		});
	}
	return Object.freeze(entry);
}

/**
 * The catalog source table.
 *
 * Producer lines were derived by reading the emit call sites, not by memory:
 * the 26 convenience helpers live at `src/telemetry.ts:397-759`, the six "dark"
 * kinds (documented at `src/telemetry.ts:39` as "emitted but no live parallel
 * paths") at `src/evidence/lock.ts:86,94,129`, `src/plan/manager.ts:335,1724`
 * and `src/plan/ledger.ts:681`, and the force-cast kind at
 * `src/hooks/conflict-resolution.ts:73`.
 */
const CATALOG_SOURCE: readonly (readonly [string, CatalogEntryInput])[] = [
	// ── lifecycle ──────────────────────────────────────────────────────────
	[
		'session_started',
		{
			category: 'lifecycle',
			severity: 'info',
			privacyClass: 'pseudonymous',
			producer: 'src/telemetry.ts:463',
			consumers: NO_CONSUMERS,
			futureOwnerIssue: ISSUE_SINK,
			retentionOwnerIssue: ISSUE_LIFECYCLE_RETENTION,
			requiredWorkflowIds: REQUIRE_SESSION,
			otelMapping: 'openinference',
		},
	],
	[
		'session_ended',
		{
			category: 'lifecycle',
			severity: 'info',
			privacyClass: 'pseudonymous',
			producer: 'src/telemetry.ts:467',
			consumers: NO_CONSUMERS,
			futureOwnerIssue: ISSUE_SINK,
			retentionOwnerIssue: ISSUE_LIFECYCLE_RETENTION,
			requiredWorkflowIds: REQUIRE_SESSION,
			otelMapping: 'openinference',
		},
	],
	[
		'agent_activated',
		{
			category: 'lifecycle',
			severity: 'info',
			privacyClass: 'pseudonymous',
			producer: 'src/telemetry.ts:471',
			consumers: NO_CONSUMERS,
			futureOwnerIssue: ISSUE_SINK,
			retentionOwnerIssue: ISSUE_LIFECYCLE_RETENTION,
			requiredWorkflowIds: REQUIRE_SESSION,
			otelMapping: 'openinference',
		},
	],
	[
		'task_state_changed',
		{
			category: 'lifecycle',
			severity: 'info',
			privacyClass: 'pseudonymous',
			producer: 'src/telemetry.ts:508',
			consumers: NO_CONSUMERS,
			futureOwnerIssue: ISSUE_SINK,
			retentionOwnerIssue: ISSUE_LIFECYCLE_RETENTION,
			requiredWorkflowIds: REQUIRE_SESSION_AND_TASK,
			otelMapping: 'openinference',
		},
	],
	[
		'phase_changed',
		{
			category: 'lifecycle',
			severity: 'info',
			privacyClass: 'pseudonymous',
			producer: 'src/telemetry.ts:556',
			consumers: NO_CONSUMERS,
			futureOwnerIssue: ISSUE_SINK,
			retentionOwnerIssue: ISSUE_LIFECYCLE_RETENTION,
			// `oldPhase`/`newPhase` are emitted, not `phase`, so no phaseId is
			// extractable and requiring one would violate on every event.
			requiredWorkflowIds: REQUIRE_SESSION,
			otelMapping: 'openinference',
		},
	],
	[
		'heartbeat',
		{
			category: 'lifecycle',
			severity: 'debug',
			privacyClass: 'pseudonymous',
			producer: 'src/telemetry.ts:706',
			consumers: CONSUMER_HEARTBEAT_LISTENER,
			retentionOwnerIssue: ISSUE_LIFECYCLE_RETENTION,
			requiredWorkflowIds: REQUIRE_SESSION,
			// A heartbeat is a point-in-time liveness ping; it has no work to
			// link to.
			allowsLinks: false,
		},
	],
	[
		'turbo_mode_changed',
		{
			category: 'lifecycle',
			severity: 'info',
			privacyClass: 'pseudonymous',
			producer: 'src/telemetry.ts:714',
			consumers: NO_CONSUMERS,
			futureOwnerIssue: ISSUE_SINK,
			retentionOwnerIssue: ISSUE_LIFECYCLE_RETENTION,
			requiredWorkflowIds: REQUIRE_SESSION,
		},
	],
	[
		'environment_detected',
		{
			category: 'lifecycle',
			severity: 'info',
			privacyClass: 'pseudonymous',
			producer: 'src/telemetry.ts:739',
			consumers: NO_CONSUMERS,
			futureOwnerIssue: ISSUE_SINK,
			retentionOwnerIssue: ISSUE_LIFECYCLE_RETENTION,
			requiredWorkflowIds: REQUIRE_SESSION,
			// A host-environment fact, not a unit of work.
			allowsLinks: false,
		},
	],

	// ── delegation ─────────────────────────────────────────────────────────
	[
		'delegation_begin',
		{
			category: 'delegation',
			severity: 'info',
			privacyClass: 'pseudonymous',
			producer: 'src/telemetry.ts:475',
			consumers: NO_CONSUMERS,
			futureOwnerIssue: ISSUE_SINK,
			retentionOwnerIssue: ISSUE_LIFECYCLE_RETENTION,
			requiredWorkflowIds: REQUIRE_SESSION_AND_TASK,
			otelMapping: 'genai',
		},
	],
	[
		'delegation_end',
		{
			category: 'delegation',
			severity: 'info',
			privacyClass: 'pseudonymous',
			producer: 'src/telemetry.ts:485',
			consumers: CONSUMER_COST_ACCOUNTING,
			retentionOwnerIssue: ISSUE_COST_RETENTION,
			requiredWorkflowIds: REQUIRE_SESSION_AND_TASK,
			otelMapping: 'genai',
		},
	],
	[
		'model_fallback',
		{
			category: 'delegation',
			severity: 'notice',
			privacyClass: 'pseudonymous',
			producer: 'src/telemetry.ts:570',
			consumers: NO_CONSUMERS,
			futureOwnerIssue: ISSUE_SINK,
			retentionOwnerIssue: ISSUE_LIFECYCLE_RETENTION,
			requiredWorkflowIds: REQUIRE_SESSION,
			otelMapping: 'genai',
		},
	],

	// ── gate ───────────────────────────────────────────────────────────────
	[
		'gate_passed',
		{
			category: 'gate',
			severity: 'info',
			privacyClass: 'pseudonymous',
			producer: 'src/telemetry.ts:517',
			// Verified: `src/evaluation/gate-stats.ts:99` filters for
			// `reviewer_gate_decision` ONLY. Nothing reads gate_passed.
			consumers: NO_CONSUMERS,
			futureOwnerIssue: ISSUE_SINK,
			retentionOwnerIssue: ISSUE_LIFECYCLE_RETENTION,
			requiredWorkflowIds: REQUIRE_SESSION_AND_TASK,
		},
	],
	[
		'gate_failed',
		{
			category: 'gate',
			severity: 'warning',
			privacyClass: 'pseudonymous',
			producer: 'src/telemetry.ts:534',
			// Verified: not read by gate-stats — see `gate_passed` above.
			consumers: NO_CONSUMERS,
			futureOwnerIssue: ISSUE_SINK,
			retentionOwnerIssue: ISSUE_LIFECYCLE_RETENTION,
			requiredWorkflowIds: REQUIRE_SESSION_AND_TASK,
		},
	],
	[
		'gate_parse_error',
		{
			category: 'gate',
			severity: 'warning',
			// Carries a free-text error message that can embed a path.
			privacyClass: 'sensitive',
			producer: 'src/telemetry.ts:521',
			consumers: NO_CONSUMERS,
			futureOwnerIssue: ISSUE_SINK,
			retentionOwnerIssue: ISSUE_LIFECYCLE_RETENTION,
			// Verified at src/telemetry.ts:456-462: the producer takes only
			// (taskId, error). It has NO sessionId, so requiring hostSessionId
			// would violate on every event; it is forbidden instead.
			requiredWorkflowIds: REQUIRE_TASK,
			forbiddenWorkflowIds: FORBID_SESSION,
		},
	],
	[
		'reviewer_gate_decision',
		{
			category: 'gate',
			severity: 'info',
			privacyClass: 'pseudonymous',
			producer: 'src/telemetry.ts:544',
			consumers: CONSUMER_GATE_STATS,
			retentionOwnerIssue: ISSUE_LIFECYCLE_RETENTION,
			requiredWorkflowIds: REQUIRE_SESSION_AND_TASK,
		},
	],

	// ── cost ───────────────────────────────────────────────────────────────
	[
		'budget_updated',
		{
			category: 'cost',
			severity: 'info',
			privacyClass: 'pseudonymous',
			producer: 'src/telemetry.ts:560',
			consumers: NO_CONSUMERS,
			futureOwnerIssue: ISSUE_SINK,
			retentionOwnerIssue: ISSUE_COST_RETENTION,
			requiredWorkflowIds: REQUIRE_SESSION,
		},
	],

	// ── guardrail ──────────────────────────────────────────────────────────
	[
		'hard_limit_hit',
		{
			category: 'guardrail',
			severity: 'error',
			privacyClass: 'pseudonymous',
			producer: 'src/telemetry.ts:585',
			consumers: NO_CONSUMERS,
			futureOwnerIssue: ISSUE_SINK,
			retentionOwnerIssue: ISSUE_SINK,
			requiredWorkflowIds: REQUIRE_SESSION,
		},
	],
	[
		'revision_limit_hit',
		{
			category: 'guardrail',
			severity: 'warning',
			privacyClass: 'pseudonymous',
			producer: 'src/telemetry.ts:594',
			consumers: NO_CONSUMERS,
			futureOwnerIssue: ISSUE_SINK,
			retentionOwnerIssue: ISSUE_SINK,
			requiredWorkflowIds: REQUIRE_SESSION,
		},
	],
	[
		'loop_detected',
		{
			category: 'guardrail',
			severity: 'warning',
			// `sensitive`, not `pseudonymous`, because the `loopType` argument
			// carries FILESYSTEM PATHS today. The guardrail producer at
			// `src/hooks/guardrails/messages-transform.ts:554` passes
			// `pending.message`, which is built at
			// `src/hooks/guardrails/tool-before.ts:1513` as
			// `Modified N file(s): <paths>`. That is free text embedding paths,
			// which `src/observability/envelope.ts` defines as `sensitive`.
			// A per-kind class must take the WORST CASE across producers: the
			// second producer (`src/hooks/guardrails/nontransient-circuit.ts:282`)
			// passes a clean closed-vocabulary `nontransient:<category>`, but one
			// clean producer cannot downgrade the kind.
			privacyClass: 'sensitive',
			producer: 'src/telemetry.ts:598',
			consumers: NO_CONSUMERS,
			futureOwnerIssue: ISSUE_SINK,
			retentionOwnerIssue: ISSUE_SINK,
			requiredWorkflowIds: REQUIRE_SESSION,
		},
	],
	[
		'scope_violation',
		{
			category: 'guardrail',
			severity: 'error',
			// Carries `file`, a repository-relative or absolute path.
			privacyClass: 'sensitive',
			producer: 'src/telemetry.ts:694',
			consumers: NO_CONSUMERS,
			futureOwnerIssue: ISSUE_SINK,
			retentionOwnerIssue: ISSUE_SINK,
			requiredWorkflowIds: REQUIRE_SESSION,
		},
	],
	[
		'qa_skip_violation',
		{
			category: 'guardrail',
			severity: 'warning',
			privacyClass: 'pseudonymous',
			producer: 'src/telemetry.ts:702',
			consumers: NO_CONSUMERS,
			futureOwnerIssue: ISSUE_SINK,
			retentionOwnerIssue: ISSUE_SINK,
			requiredWorkflowIds: REQUIRE_SESSION,
		},
	],
	[
		'auto_oversight_escalation',
		{
			category: 'guardrail',
			severity: 'warning',
			privacyClass: 'pseudonymous',
			producer: 'src/telemetry.ts:724',
			consumers: NO_CONSUMERS,
			futureOwnerIssue: ISSUE_SINK,
			retentionOwnerIssue: ISSUE_SINK,
			// `phase` is an OPTIONAL parameter here (src/telemetry.ts:658), so
			// phaseId is not required.
			requiredWorkflowIds: REQUIRE_SESSION,
		},
	],

	// ── prm ────────────────────────────────────────────────────────────────
	[
		'no_op_strong_warning',
		{
			category: 'guardrail',
			severity: 'warning',
			// Repeated no-op agent turns crossed the strong-warning threshold.
			privacyClass: 'pseudonymous',
			producer: 'src/telemetry.ts:612',
			consumers: NO_CONSUMERS,
			futureOwnerIssue: ISSUE_SINK,
			retentionOwnerIssue: ISSUE_SINK,
			requiredWorkflowIds: REQUIRE_SESSION,
		},
	],
	[
		'gate_denial_loop',
		{
			category: 'guardrail',
			severity: 'warning',
			// The same (session, tool, denial-code) streak reached the hard rung (#2063 B1).
			privacyClass: 'pseudonymous',
			producer: 'src/telemetry.ts:633',
			consumers: NO_CONSUMERS,
			futureOwnerIssue: ISSUE_SINK,
			retentionOwnerIssue: ISSUE_SINK,
			requiredWorkflowIds: REQUIRE_SESSION,
		},
	],
	[
		'execution_stall_warning',
		{
			category: 'guardrail',
			severity: 'warning',
			// An ARMED execution episode reached the advisory rung (#2063 B5).
			privacyClass: 'pseudonymous',
			producer: 'src/telemetry.ts:647',
			consumers: NO_CONSUMERS,
			futureOwnerIssue: ISSUE_SINK,
			retentionOwnerIssue: ISSUE_SINK,
			requiredWorkflowIds: REQUIRE_SESSION,
		},
	],
	[
		'execution_stall_denied',
		{
			category: 'guardrail',
			severity: 'error',
			// A non-productive tool was hard-denied at the stop rung (#2063 B5).
			privacyClass: 'pseudonymous',
			producer: 'src/telemetry.ts:664',
			consumers: NO_CONSUMERS,
			futureOwnerIssue: ISSUE_SINK,
			retentionOwnerIssue: ISSUE_SINK,
			requiredWorkflowIds: REQUIRE_SESSION,
		},
	],
	[
		'swarm_internals_read_denied',
		{
			category: 'guardrail',
			severity: 'error',
			// A read resolved inside the installed opencode-swarm package and was denied (#2063 B4).
			privacyClass: 'sensitive',
			producer: 'src/telemetry.ts:681',
			consumers: NO_CONSUMERS,
			futureOwnerIssue: ISSUE_SINK,
			retentionOwnerIssue: ISSUE_SINK,
			requiredWorkflowIds: REQUIRE_SESSION,
		},
	],
	[
		'prm_hard_stop_delivered',
		{
			category: 'prm',
			severity: 'error',
			// DELIVERY of a PRM hard stop, distinct from the `prm_hard_stop` TRIGGER (#2063 C2).
			privacyClass: 'pseudonymous',
			producer: 'src/telemetry.ts:848',
			consumers: NO_CONSUMERS,
			futureOwnerIssue: ISSUE_SINK,
			retentionOwnerIssue: ISSUE_SINK,
			requiredWorkflowIds: REQUIRE_SESSION,
		},
	],
	[
		'prm_pattern_detected',
		{
			category: 'prm',
			severity: 'notice',
			privacyClass: 'pseudonymous',
			producer: 'src/telemetry.ts:754',
			consumers: NO_CONSUMERS,
			futureOwnerIssue: ISSUE_SINK,
			retentionOwnerIssue: ISSUE_SINK,
			requiredWorkflowIds: REQUIRE_SESSION,
		},
	],
	[
		'prm_course_correction_injected',
		{
			category: 'prm',
			severity: 'notice',
			privacyClass: 'pseudonymous',
			producer: 'src/telemetry.ts:768',
			consumers: NO_CONSUMERS,
			futureOwnerIssue: ISSUE_SINK,
			retentionOwnerIssue: ISSUE_SINK,
			requiredWorkflowIds: REQUIRE_SESSION,
		},
	],
	[
		'prm_escalation_triggered',
		{
			category: 'prm',
			severity: 'warning',
			privacyClass: 'pseudonymous',
			producer: 'src/telemetry.ts:781',
			consumers: NO_CONSUMERS,
			futureOwnerIssue: ISSUE_SINK,
			retentionOwnerIssue: ISSUE_SINK,
			requiredWorkflowIds: REQUIRE_SESSION,
		},
	],
	[
		'prm_hard_stop',
		{
			category: 'prm',
			severity: 'critical',
			privacyClass: 'pseudonymous',
			producer: 'src/telemetry.ts:795',
			consumers: NO_CONSUMERS,
			futureOwnerIssue: ISSUE_SINK,
			retentionOwnerIssue: ISSUE_SINK,
			requiredWorkflowIds: REQUIRE_SESSION,
		},
	],

	// ── evidence (dark: emitted, no live parallel paths — src/telemetry.ts:38)
	[
		'evidence_lock_acquired',
		{
			category: 'evidence',
			severity: 'info',
			// Carries `directory` and `evidencePath` — absolute paths.
			privacyClass: 'sensitive',
			producer: 'src/evidence/lock.ts:94',
			consumers: NO_CONSUMERS,
			futureOwnerIssue: ISSUE_SINK,
			retentionOwnerIssue: ISSUE_PLAN_EVIDENCE_RETENTION,
			requiredWorkflowIds: REQUIRE_TASK,
			forbiddenWorkflowIds: FORBID_SESSION,
		},
	],
	[
		'evidence_lock_contended',
		{
			category: 'evidence',
			severity: 'notice',
			privacyClass: 'sensitive',
			producer: 'src/evidence/lock.ts:129',
			consumers: NO_CONSUMERS,
			futureOwnerIssue: ISSUE_SINK,
			retentionOwnerIssue: ISSUE_PLAN_EVIDENCE_RETENTION,
			requiredWorkflowIds: REQUIRE_TASK,
			forbiddenWorkflowIds: FORBID_SESSION,
		},
	],
	[
		'evidence_lock_stale_recovered',
		{
			category: 'evidence',
			severity: 'notice',
			privacyClass: 'sensitive',
			producer: 'src/evidence/lock.ts:86',
			consumers: NO_CONSUMERS,
			futureOwnerIssue: ISSUE_SINK,
			retentionOwnerIssue: ISSUE_PLAN_EVIDENCE_RETENTION,
			requiredWorkflowIds: REQUIRE_TASK,
			forbiddenWorkflowIds: FORBID_SESSION,
		},
	],

	// ── plan (dark) ────────────────────────────────────────────────────────
	[
		'plan_ledger_cas_retry',
		{
			category: 'plan',
			severity: 'notice',
			// Only an attempt counter, a hash PREFIX and a delay. No identifiers.
			privacyClass: 'operational',
			producer: 'src/plan/manager.ts:340',
			consumers: NO_CONSUMERS,
			futureOwnerIssue: ISSUE_SINK,
			retentionOwnerIssue: ISSUE_PLAN_EVIDENCE_RETENTION,
			forbiddenWorkflowIds: FORBID_SESSION,
		},
	],
	[
		'plan_md_write_failed',
		{
			category: 'plan',
			severity: 'warning',
			// Carries `directory` and a free-text filesystem error.
			privacyClass: 'sensitive',
			producer: 'src/plan/manager.ts:1772',
			consumers: NO_CONSUMERS,
			futureOwnerIssue: ISSUE_SINK,
			retentionOwnerIssue: ISSUE_PLAN_EVIDENCE_RETENTION,
			forbiddenWorkflowIds: FORBID_SESSION,
		},
	],
	[
		'snapshot_failed',
		{
			category: 'plan',
			severity: 'error',
			// Carries a free-text filesystem error message.
			privacyClass: 'sensitive',
			producer: 'src/plan/ledger.ts:704',
			consumers: NO_CONSUMERS,
			futureOwnerIssue: ISSUE_SINK,
			retentionOwnerIssue: ISSUE_PLAN_EVIDENCE_RETENTION,
			forbiddenWorkflowIds: FORBID_SESSION,
		},
	],

	// ── conflict ───────────────────────────────────────────────────────────
	[
		'agent_conflict_detected',
		{
			category: 'conflict',
			severity: 'warning',
			privacyClass: 'pseudonymous',
			producer: 'src/hooks/conflict-resolution.ts:73',
			consumers: NO_CONSUMERS,
			futureOwnerIssue: ISSUE_SINK,
			retentionOwnerIssue: ISSUE_SINK,
			// `sessionId` and `phase` are required on the producer's input
			// (src/hooks/conflict-resolution.ts:12-21); `taskId` is OPTIONAL
			// there, so it is deliberately not required.
			requiredWorkflowIds: Object.freeze([
				'hostSessionId',
				'phaseId',
			]) as readonly WorkflowIdKey[],
		},
	],

	// ── close / archive (issue #2030) ──────────────────────────────────────
	[
		'close_archive_result',
		{
			// Close is a session-lifecycle terminal event. The payload is one
			// structured result per archived artifact (requiredness/attempt/
			// validation/source_disposition/method/reason_code) plus aggregate
			// archive_valid/archive_empty health facts. Counts only — no row
			// content, no session/task identifiers — so `operational` is the
			// truthful privacy class. No live consumer yet; PR 16 will alarm on
			// it and PR 20 will report it.
			category: 'lifecycle',
			severity: 'notice',
			privacyClass: 'operational',
			producer: 'src/telemetry.ts:832',
			consumers: NO_CONSUMERS,
			futureOwnerIssue: ISSUE_SINK,
			retentionOwnerIssue: ISSUE_SINK,
		},
	],
];

// Pure, allocation-only construction of a frozen lookup table. No I/O, no
// environment reads, no observable side effect outside this module.
const catalog: Record<string, CatalogEntry> = {};
for (const [kind, input] of CATALOG_SOURCE) {
	catalog[kind] = defineEntry(kind, input);
}

/** The catalog, keyed by wire event kind. */
export const EVENT_CATALOG: Readonly<Record<string, CatalogEntry>> =
	Object.freeze(catalog);

/** Every catalogued kind, in declaration order. */
export const CATALOG_KINDS: readonly string[] = Object.freeze(
	Object.keys(EVENT_CATALOG),
);

/** Own-property catalog lookup. Returns `undefined` for an unknown kind. */
export function getCatalogEntry(kind: string): CatalogEntry | undefined {
	return Object.hasOwn(EVENT_CATALOG, kind) ? EVENT_CATALOG[kind] : undefined;
}
