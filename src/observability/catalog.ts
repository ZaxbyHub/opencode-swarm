/**
 * The event catalog (issue #2029).
 *
 * Exactly 59 entries, matching the `TelemetryEvent` union at
 * `src/telemetry.ts:15-165`. Thirty-eight predate the #2029 contract; the 39th is
 * `agent_conflict_detected` (previously emitted through a force-cast past the
 * type system), the 40th is `close_archive_result` (issue #2030 — the
 * structured close/archive result event), the 41st is the bounded diagnostic
 * projection of authoritative knowledge-receipt transitions (issue #2031).
 * The 42nd is the human-only `knowledge_maintenance` quarantine audit
 * (issue #2033), the 43rd is the aggregate `context_pruned` transcript
 * mutation audit, the 44th is the bounded `residue_health` atomic-write
 * residue audit (issue #2035), the 46th is the bounded
 * `context_telemetry_health` storage audit for the issue-#2037
 * `.swarm/context-telemetry.jsonl` store, the 47th is the counts-only
 * `skill_usage_health` storage audit for the issue-#2038
 * `.swarm/skill-usage.jsonl` store and its authoritative pending sidecar,
 * the 48th is the bounded `core_events_health` storage audit for the
 * issue-#2039 `.swarm/events.jsonl` store, the 49th is the bounded
 * `shell_audit_health` storage audit for the issue-#2040
 * `.swarm/session/shell-audit.jsonl` security-audit store, and the 50th is
 * the bounded `trajectory_health` storage audit for the issue-#2041
 * `.swarm/trajectories/` PRM session store, and the 51st is the bounded
 * `pr_subscription_health` storage audit for the issue-#2042
 * `.swarm/pr-monitor/` subscription checkpoint store. The 52nd is
 * `delegation_cost_correction`, the 53rd is `delegation_cost_binding`, and the
 * 54th is `delegation_cost_join`. The 57th is `council_attempt`, the 58th is
 * `council_round_transition`, and the 59th is `council_attempt_unscoped`
 * (issue #2046 item 9 — canonical council attempt / accepted-transition
 * observations joined to the lifecycle correlation system via the
 * server-derived `councilRoundId`). These late
 * additions are instances
 * of the defect class this contract exists to close: an event kind entering
 * the stream with no registration.
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
	 * `false` for all 59 entries today, and that is a truthful statement about
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
/** Owner of the council-attempt observability emissions (issue #2046 item 9). */
const ISSUE_COUNCIL_OBSERVABILITY = 2046;
/** Future consumer of council events: the rebuildable index / `/swarm report`. */
const ISSUE_COUNCIL_REPORT = 2048;

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
 * The server-derived council scope token — the durable round identity shared
 * with `.swarm/council/attempts/{token}.jsonl`. Every scoped council event
 * genuinely carries it (computed from the authoritative scope, never from
 * client input), so requiring it is truthful and gives council events a
 * machine-enforced correlation axis.
 */
const REQUIRE_COUNCIL_ROUND: readonly WorkflowIdKey[] = Object.freeze([
	'councilRoundId',
]);

/**
 * `hostSessionId` is FORBIDDEN on the kinds whose producer genuinely has no
 * session in scope. Verified against source, not assumed:
 * `gate_parse_error` (`src/telemetry.ts:608-615`) takes only `taskId` and the
 * error; the three evidence-lock kinds and the three plan kinds are emitted from
 * modules that never receive a session id. If one of these ever arrives with a
 * session id, it was manufactured.
 */
const FORBID_SESSION: readonly WorkflowIdKey[] = Object.freeze([
	'hostSessionId',
]);
/**
 * `councilRoundId` is FORBIDDEN on the unscoped council kind: pre-validation
 * failures genuinely have no round identity (no resolvable scope), so a
 * present one was manufactured upstream — the exact anti-pattern issue #2029
 * item 2 forbids (PR #2466 review follow-up). The scoped council kinds
 * REQUIRE the axis instead, making round-identity provenance
 * machine-enforced in both directions.
 */
const FORBID_COUNCIL_ROUND: readonly WorkflowIdKey[] = Object.freeze([
	'councilRoundId',
]);

/** Live reader of `delegation_end` cost fields. */
const CONSUMER_COST_ACCOUNTING = Object.freeze([
	'src/services/cost-accounting.ts:429',
]);
const CONSUMER_COST_CORRECTION = Object.freeze([
	'src/services/cost-accounting.ts:426',
]);
const CONSUMER_COST_JOIN = Object.freeze([
	'src/services/cost-accounting.ts:413',
]);
/** Live reader of reviewer-gate decisions. */
const CONSUMER_GATE_STATS = Object.freeze(['src/evaluation/gate-stats.ts:99']);
/** In-process listener that tracks last-activity per session. */
const CONSUMER_HEARTBEAT_LISTENER = Object.freeze(['src/telemetry.ts:232']);

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
 * the convenience helpers live at `src/telemetry.ts:548-1218`, the six "dark"
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
			producer: 'src/telemetry.ts:550',
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
			producer: 'src/telemetry.ts:554',
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
			producer: 'src/telemetry.ts:558',
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
			producer: 'src/telemetry.ts:596',
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
			producer: 'src/telemetry.ts:644',
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
			producer: 'src/telemetry.ts:826',
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
			producer: 'src/telemetry.ts:834',
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
			producer: 'src/telemetry.ts:859',
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
			producer: 'src/telemetry.ts:562',
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
			producer: 'src/telemetry.ts:572',
			consumers: CONSUMER_COST_ACCOUNTING,
			retentionOwnerIssue: ISSUE_COST_RETENTION,
			requiredWorkflowIds: REQUIRE_SESSION_AND_TASK,
			otelMapping: 'genai',
		},
	],
	[
		'delegation_cost_correction',
		{
			category: 'delegation',
			severity: 'info',
			privacyClass: 'pseudonymous',
			producer: 'src/index.ts:649',
			consumers: CONSUMER_COST_CORRECTION,
			retentionOwnerIssue: ISSUE_COST_RETENTION,
			requiredWorkflowIds: REQUIRE_SESSION_AND_TASK,
			otelMapping: 'genai',
		},
	],
	[
		'delegation_cost_binding',
		{
			category: 'delegation',
			severity: 'info',
			privacyClass: 'pseudonymous',
			producer: 'src/index.ts:1579',
			consumers: NO_CONSUMERS,
			futureOwnerIssue: ISSUE_SINK,
			retentionOwnerIssue: ISSUE_COST_RETENTION,
			requiredWorkflowIds: REQUIRE_SESSION,
			otelMapping: 'none',
		},
	],
	[
		'delegation_cost_join',
		{
			category: 'delegation',
			severity: 'notice',
			privacyClass: 'pseudonymous',
			producer: 'src/index.ts:1599',
			consumers: CONSUMER_COST_JOIN,
			retentionOwnerIssue: ISSUE_COST_RETENTION,
			requiredWorkflowIds: REQUIRE_SESSION,
			otelMapping: 'none',
		},
	],
	[
		'model_fallback',
		{
			category: 'delegation',
			severity: 'notice',
			privacyClass: 'pseudonymous',
			producer: 'src/telemetry.ts:677',
			consumers: NO_CONSUMERS,
			futureOwnerIssue: ISSUE_SINK,
			retentionOwnerIssue: ISSUE_LIFECYCLE_RETENTION,
			requiredWorkflowIds: REQUIRE_SESSION,
			otelMapping: 'genai',
		},
	],
	[
		'model_unresolved',
		{
			// Issue #2271 bug 4: preflight confirmed a configured agent model id
			// does not resolve against the provider catalog (distinct from a
			// runtime model_fallback — this fires before any dispatch attempt).
			category: 'delegation',
			severity: 'warning',
			privacyClass: 'pseudonymous',
			producer: 'src/telemetry.ts:691',
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
			producer: 'src/telemetry.ts:605',
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
			producer: 'src/telemetry.ts:622',
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
			producer: 'src/telemetry.ts:609',
			consumers: NO_CONSUMERS,
			futureOwnerIssue: ISSUE_SINK,
			retentionOwnerIssue: ISSUE_LIFECYCLE_RETENTION,
			// Verified at src/telemetry.ts:608-615: the producer takes only
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
			producer: 'src/telemetry.ts:632',
			consumers: CONSUMER_GATE_STATS,
			retentionOwnerIssue: ISSUE_LIFECYCLE_RETENTION,
			requiredWorkflowIds: REQUIRE_SESSION_AND_TASK,
		},
	],
	[
		'council_attempt',
		{
			category: 'gate',
			severity: 'info',
			privacyClass: 'pseudonymous',
			producer: 'src/council/council-observability.ts:85',
			consumers: NO_CONSUMERS,
			futureOwnerIssue: ISSUE_COUNCIL_REPORT,
			retentionOwnerIssue: ISSUE_COUNCIL_OBSERVABILITY,
			requiredWorkflowIds: REQUIRE_COUNCIL_ROUND,
		},
	],
	[
		'council_round_transition',
		{
			category: 'gate',
			severity: 'info',
			privacyClass: 'pseudonymous',
			producer: 'src/council/council-observability.ts:115',
			consumers: NO_CONSUMERS,
			futureOwnerIssue: ISSUE_COUNCIL_REPORT,
			retentionOwnerIssue: ISSUE_COUNCIL_OBSERVABILITY,
			requiredWorkflowIds: REQUIRE_COUNCIL_ROUND,
		},
	],
	[
		'council_attempt_unscoped',
		{
			category: 'gate',
			severity: 'warning',
			privacyClass: 'pseudonymous',
			producer: 'src/council/council-observability.ts:152',
			consumers: NO_CONSUMERS,
			futureOwnerIssue: ISSUE_COUNCIL_REPORT,
			retentionOwnerIssue: ISSUE_COUNCIL_OBSERVABILITY,
			forbiddenWorkflowIds: FORBID_COUNCIL_ROUND,
			// Pre-validation failures (invalid arguments, wrong root, round-state
			// uncertainty/persistence failure) carry no round identity; the
			// submitter session is optional and joins when present.
		},
	],

	// ── cost ───────────────────────────────────────────────────────────────
	[
		'budget_updated',
		{
			category: 'cost',
			severity: 'info',
			privacyClass: 'pseudonymous',
			producer: 'src/telemetry.ts:648',
			consumers: NO_CONSUMERS,
			futureOwnerIssue: ISSUE_SINK,
			retentionOwnerIssue: ISSUE_COST_RETENTION,
			requiredWorkflowIds: REQUIRE_SESSION,
		},
	],
	[
		'context_pruned',
		{
			category: 'guardrail',
			severity: 'notice',
			privacyClass: 'pseudonymous',
			producer: 'src/telemetry.ts:667',
			consumers: NO_CONSUMERS,
			futureOwnerIssue: ISSUE_SINK,
			retentionOwnerIssue: ISSUE_SINK,
			requiredWorkflowIds: REQUIRE_SESSION,
		},
	],
	[
		'retrieval_routed',
		{
			category: 'guardrail',
			severity: 'info',
			privacyClass: 'pseudonymous',
			producer: 'src/telemetry.ts:1216',
			consumers: NO_CONSUMERS,
			futureOwnerIssue: ISSUE_SINK,
			retentionOwnerIssue: ISSUE_SINK,
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
			producer: 'src/telemetry.ts:705',
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
			producer: 'src/telemetry.ts:714',
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
			producer: 'src/telemetry.ts:718',
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
			producer: 'src/telemetry.ts:814',
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
			producer: 'src/telemetry.ts:822',
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
			producer: 'src/telemetry.ts:844',
			consumers: NO_CONSUMERS,
			futureOwnerIssue: ISSUE_SINK,
			retentionOwnerIssue: ISSUE_SINK,
			// `phase` is an OPTIONAL parameter here (src/telemetry.ts:668), so
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
			producer: 'src/telemetry.ts:732',
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
			producer: 'src/telemetry.ts:753',
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
			producer: 'src/telemetry.ts:767',
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
			producer: 'src/telemetry.ts:784',
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
			producer: 'src/telemetry.ts:801',
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
			producer: 'src/telemetry.ts:1197',
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
			producer: 'src/telemetry.ts:874',
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
			producer: 'src/telemetry.ts:888',
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
			producer: 'src/telemetry.ts:901',
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
			producer: 'src/telemetry.ts:915',
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
			producer: 'src/evidence/lock.ts:99',
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
			producer: 'src/evidence/lock.ts:134',
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
			producer: 'src/evidence/lock.ts:91',
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
			producer: 'src/plan/manager.ts:346',
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
			producer: 'src/plan/manager.ts:1854',
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
			producer: 'src/plan/ledger.ts:1176',
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
			producer: 'src/telemetry.ts:952',
			consumers: NO_CONSUMERS,
			futureOwnerIssue: ISSUE_SINK,
			retentionOwnerIssue: ISSUE_SINK,
		},
	],
	[
		'knowledge_receipt_transition',
		{
			category: 'knowledge',
			severity: 'info',
			// Optional trace/entry/session/task/phase IDs are pseudonymous. There
			// is no prose, path, or non-transient circuit state in the payload.
			privacyClass: 'pseudonymous',
			producer: 'src/hooks/knowledge-receipt-observability.ts:197',
			consumers: NO_CONSUMERS,
			futureOwnerIssue: ISSUE_SINK,
			retentionOwnerIssue: ISSUE_LIFECYCLE_RETENTION,
			// Empty retrievals and uncertain legacy transitions truthfully lack
			// some or all correlation IDs, so none is universally required.
			requiredWorkflowIds: NO_WORKFLOW_IDS,
			allowsLinks: false,
		},
	],
	[
		'knowledge_maintenance',
		{
			category: 'knowledge',
			severity: 'notice',
			// Issue #2033 human-only hive-store quarantine audit: bounded phase and
			// abort-reason codes, counts, hash/token prefixes. Entry IDs are
			// pseudonymous; no lesson text, prose, or filesystem path is emitted.
			privacyClass: 'pseudonymous',
			producer: 'src/knowledge/hive-quarantine.ts:1265',
			consumers: NO_CONSUMERS,
			futureOwnerIssue: ISSUE_SINK,
			retentionOwnerIssue: ISSUE_LIFECYCLE_RETENTION,
			// The maintenance command runs outside any session/workflow context,
			// so no workflow correlation ID is universally present.
			requiredWorkflowIds: NO_WORKFLOW_IDS,
			allowsLinks: false,
		},
	],

	// ── atomic-write residue (issue #2035) ────────────────────────────────
	[
		'residue_health',
		{
			// Emitted after a residue quarantine run (close clean stage or
			// `/swarm config doctor --quarantine-residue`). Payload is counts,
			// one age figure, total bytes, and per-grammar counts keyed by the
			// frozen registry ids in src/utils/atomic-write.ts — no file names,
			// no paths, no content — so `operational` is the truthful privacy
			// class. No live consumer yet; PR 16/19 reporting will consume it.
			category: 'lifecycle',
			severity: 'notice',
			privacyClass: 'operational',
			producer: 'src/telemetry.ts:974',
			consumers: NO_CONSUMERS,
			futureOwnerIssue: ISSUE_SINK,
			retentionOwnerIssue: ISSUE_SINK,
			// Aggregate-only counts; no workflow correlation applies.
			requiredWorkflowIds: NO_WORKFLOW_IDS,
			allowsLinks: false,
		},
	],

	// ── context-map telemetry storage (issue #2037) ───────────────────────
	[
		'context_telemetry_health',
		{
			// Emitted after a compaction or close cut for the bounded
			// `.swarm/context-telemetry.jsonl` store (issue #2037). Payload is
			// accepted/compacted/retained/dropped/corrupt counts, oldest/newest
			// timestamps, and byte figures — counts ONLY, no capsule/query
			// content and no filesystem paths — so `operational` is the truthful
			// privacy class. No live consumer yet; PR 16/19 reporting will
			// consume it.
			category: 'lifecycle',
			severity: 'notice',
			privacyClass: 'operational',
			producer: 'src/telemetry.ts:998',
			consumers: NO_CONSUMERS,
			futureOwnerIssue: ISSUE_SINK,
			retentionOwnerIssue: ISSUE_SINK,
			// Aggregate-only counts; no workflow correlation applies.
			requiredWorkflowIds: NO_WORKFLOW_IDS,
			allowsLinks: false,
		},
	],

	// ── skill-usage tracking storage health (issue #2038) ─────────────────
	[
		'skill_usage_health',
		{
			// Emitted on compaction, migration, consumption, and pressure
			// events for skill-usage tracking (issue #2038). Payload is
			// accepted/compacted/dropped/corrupt/retained counts, retry and
			// curator figures, oldest/newest timestamps, and byte figures —
			// counts ONLY, no per-skill identifier and no filesystem paths —
			// so `operational` is the truthful privacy class. The adversarial
			// case is thousands of distinct skill IDs, so a per-skill label
			// would be an unbounded label set; this payload is deliberately
			// aggregate-only. No live consumer yet; PR 16/19 reporting will
			// consume it.
			category: 'lifecycle',
			severity: 'notice',
			privacyClass: 'operational',
			producer: 'src/telemetry.ts:1035',
			consumers: NO_CONSUMERS,
			futureOwnerIssue: ISSUE_SINK,
			retentionOwnerIssue: ISSUE_SINK,
			// Aggregate-only counts; no workflow correlation applies.
			requiredWorkflowIds: NO_WORKFLOW_IDS,
			allowsLinks: false,
		},
	],

	// ── core event store (issue #2039) ────────────────────────────────────
	[
		'core_events_health',
		{
			// Emitted after a compaction or close cut for the bounded
			// `.swarm/events.jsonl` store (issue #2039). Payload is
			// accepted/compacted/retained/dropped/corrupt counts,
			// authority-index size and FIFO-eviction counts, oldest/newest
			// timestamps, and byte figures — counts ONLY, no event content and
			// no filesystem paths — so `operational` is the truthful privacy
			// class. No live consumer yet; PR 16/19 reporting will consume it.
			category: 'lifecycle',
			severity: 'notice',
			privacyClass: 'operational',
			producer: 'src/telemetry.ts:1061',
			consumers: NO_CONSUMERS,
			futureOwnerIssue: ISSUE_SINK,
			retentionOwnerIssue: ISSUE_SINK,
			// Aggregate-only counts; no workflow correlation applies.
			requiredWorkflowIds: NO_WORKFLOW_IDS,
			allowsLinks: false,
		},
	],

	// ── shell-audit store (issue #2040) ───────────────────────────────────
	[
		'shell_audit_health',
		{
			// Emitted after a compaction or close cut for the bounded
			// `.swarm/session/shell-audit.jsonl` security-audit store
			// (issue #2040). Payload is accepted/compacted/retained/dropped/
			// corrupt counts, oldest/newest timestamps, and byte figures —
			// counts ONLY, no command content, no filesystem paths, no agent
			// or session identifiers — so `operational` is the truthful
			// privacy class. No live consumer yet; PR 16/19 reporting will
			// consume it.
			category: 'lifecycle',
			severity: 'notice',
			privacyClass: 'operational',
			producer: 'src/telemetry.ts:1085',
			consumers: NO_CONSUMERS,
			futureOwnerIssue: ISSUE_SINK,
			retentionOwnerIssue: ISSUE_SINK,
			// Aggregate-only counts; no workflow correlation applies.
			requiredWorkflowIds: NO_WORKFLOW_IDS,
			allowsLinks: false,
		},
	],

	// ── PRM session-trajectory store (issue #2041) ────────────────────────
	[
		'trajectory_health',
		{
			// Emitted after a compaction pass or cleanup sweep, and
			// (cooldown-bounded) when an append is skipped because the
			// per-file cross-process lock stayed busy, for the bounded
			// `.swarm/trajectories/` PRM session store (issue #2041). Payload
			// is retained/dropped/corrupt counts, lock-skip counts, and byte
			// figures — counts ONLY, no trajectory content, no filesystem
			// paths, no session identifiers — so `operational` is the truthful
			// privacy class. No live consumer yet; reporting surfaces will
			// consume it.
			category: 'lifecycle',
			severity: 'notice',
			privacyClass: 'operational',
			producer: 'src/telemetry.ts:1108',
			consumers: NO_CONSUMERS,
			futureOwnerIssue: ISSUE_SINK,
			retentionOwnerIssue: ISSUE_SINK,
			// Aggregate-only counts; no workflow correlation applies.
			requiredWorkflowIds: NO_WORKFLOW_IDS,
			allowsLinks: false,
		},
	],

	// ── PR-monitor subscription store (issue #2042) ───────────────────────
	[
		'pr_subscription_health',
		{
			// Emitted after a terminal-record compaction, a legacy-JSONL
			// migration completion (including the one-time read-bootstrap),
			// a legacy-log archive, or a foreign/corrupt checkpoint recovery,
			// for the bounded `.swarm/pr-monitor/` PR-monitor subscription
			// checkpoint store (issue #2042). Payload is active/terminal
			// counts, compaction and corrupt/drop counters, and byte figures —
			// counts ONLY, no correlationIds, no filesystem paths, no repo
			// identities — so `operational` is the truthful privacy class. No
			// live consumer yet; the /swarm pr status storage footer surfaces
			// the same figures synchronously (including recovery_resets).
			category: 'lifecycle',
			severity: 'notice',
			privacyClass: 'operational',
			producer: 'src/telemetry.ts:1137',
			consumers: NO_CONSUMERS,
			futureOwnerIssue: ISSUE_SINK,
			retentionOwnerIssue: ISSUE_SINK,
			// Aggregate-only counts; no workflow correlation applies.
			requiredWorkflowIds: NO_WORKFLOW_IDS,
			allowsLinks: false,
		},
	],

	// ── Learning/operations health alarms (issue #2044) ──────────────────
	[
		'learning_health_alarm',
		{
			// Emitted by the learning-health registry
			// (`src/health/learning-health.ts`) when one of the eight PR-16
			// alarm families raises, re-emits past its cooldown (`sustained`),
			// or recovers. Payload is counts, closed-vocabulary enums (`alarm`
			// from the eight-family closed set, `transition`, `severity`,
			// `scope_class`), millisecond timestamps, model/provider identity,
			// and 16-hex salted `session_ref` values — counts and refs ONLY,
			// no raw session IDs, no filesystem paths, no query/prompt/response
			// content — so `operational` is the truthful privacy class. No
			// stream consumer yet (the sink is #2047); the `/swarm status`
			// Learning Health section and the `/swarm diagnose`
			// learning-health check surface the same state synchronously from
			// the `.swarm/learning-health.json` artifact.
			category: 'lifecycle',
			severity: 'warning',
			privacyClass: 'operational',
			producer: 'src/telemetry.ts:1181',
			consumers: NO_CONSUMERS,
			futureOwnerIssue: ISSUE_SINK,
			retentionOwnerIssue: 2044,
			// Aggregate-only counts and refs; no workflow correlation applies.
			requiredWorkflowIds: NO_WORKFLOW_IDS,
			allowsLinks: false,
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
