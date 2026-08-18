/**
 * Legacy telemetry adapter (issue #2029 item 4 / AC2).
 *
 * Its real production input is the untyped `data: Record<string, unknown>` that
 * `src/telemetry.ts:emit()` receives from 40+ call sites: caller-ordered,
 * unversioned, with extra and missing fields. That is legacy-shaped input by
 * definition, and adapting it is this module's genuine job.
 *
 * Two hard constraints govern every function here:
 *   1. **Never throw.** `emit()` documents a never-throw guarantee
 *      (`src/telemetry.ts:266,294`) and `src/telemetry.test.ts:137-162`
 *      exercises circular objects, functions, `Symbol`s and `BigInt`s.
 *   2. **Never deep-traverse, clone, or serialize the payload.** Only
 *      `Object.keys` (shallow) and own-key reads. See `LegacyProjectionSchema`
 *      for why `raw` must stay an alias.
 *
 * Import rules: no filesystem, network, subprocess, or OTel SDK.
 */
import type { LegacyProjection, Outcome, WorkflowIds } from './envelope.js';

/** The store these payloads are written to. */
export const LEGACY_TELEMETRY_SOURCE_STORE = '.swarm/telemetry.jsonl';

/** Marker recorded in `legacy.unknown` when the payload is not an object. */
export const NON_OBJECT_PAYLOAD_MARKER = '<non-object-payload>';

/**
 * Marker recorded when the payload resisted shallow introspection — a Proxy
 * whose `ownKeys` trap throws, or a throwing getter. The payload is still kept
 * by reference; only our description of it is degraded.
 */
export const INTROSPECTION_FAILED_MARKER = '<payload-introspection-failed>';

/**
 * The adapter rules, stated as a checkable list.
 *
 * These are the item-4 rules of issue #2029. They are exported as data (not
 * prose in a doc file) so the static contract check and the unit tests can
 * assert against the same statement of intent the implementation follows.
 */
export const LEGACY_ADAPTER_RULES: readonly string[] = Object.freeze([
	'Preserve unknown fields: an own key the contract does not recognize is kept under `extra` by reference and is never dropped.',
	'Record the source store and its schema version: `sourceStore` names the file; `sourceSchemaVersion` is the version the store declares.',
	'Preserve originally reported values: values are aliased, never coerced, normalized, rounded, or re-serialized.',
	'Record timing confidence: a time read by the writer at record time is `writer-clock`, never `exact`.',
	"Unknown is not zero: the adapter lists in `unknown` every catalogued key the PRODUCER left undefined, and never itself defaults one to 0, \"\", false, or null. The guarantee stops at the adapter boundary — a producer that pre-coerces its own defaults defeats it, because the adapter only ever sees the coerced value. The known instance is `delegation_end` (`src/telemetry.ts` `delegationEnd`, pre-existing): it coerces `?? 0` / `?? null` / `?? 'unavailable'` before emitting, so its cost fields can never appear in `unknown`; there, `cost_source: 'unavailable'` is how absence stays recoverable.",
	'Missing lineage stays missing: an absent correlation ID stays `undefined` and is never synthesized to make a join succeed.',
	'Never drop unrecognized fields: no allowlist filter is applied to the payload on the way through.',
]);

/**
 * Payload keys each producer is known to emit.
 *
 * Derived from the emit call sites in source, NOT from captured output: a key
 * whose value is `undefined` is elided by `JSON.stringify`, so a captured line
 * under-reports the producer's key set. Listing those keys here is precisely
 * what makes `legacy.unknown` non-vacuous — `delegation_end` naming `model`,
 * `gate` and `retry_index` lets the adapter say "the producer did not know
 * these" instead of silently omitting them.
 */
export const KNOWN_TELEMETRY_KEYS: Readonly<Record<string, readonly string[]>> =
	Object.freeze({
		// src/telemetry.ts:397-759 — the 26 convenience helpers.
		session_started: Object.freeze(['sessionId', 'agentName']),
		session_ended: Object.freeze(['sessionId', 'reason']),
		agent_activated: Object.freeze(['sessionId', 'agentName', 'oldName']),
		delegation_begin: Object.freeze(['sessionId', 'agentName', 'taskId']),
		delegation_end: Object.freeze([
			'sessionId',
			'agentName',
			'taskId',
			'result',
			'tokens_input',
			'tokens_output',
			'tokens_reasoning',
			'tokens_cache',
			'cost_usd',
			'cost_source',
			'model',
			'gate',
			'retry_index',
		]),
		task_state_changed: Object.freeze([
			'sessionId',
			'taskId',
			'newState',
			'oldState',
		]),
		gate_passed: Object.freeze(['sessionId', 'gate', 'taskId']),
		gate_parse_error: Object.freeze(['taskId', 'errorName', 'errorMessage']),
		gate_failed: Object.freeze(['sessionId', 'gate', 'taskId', 'reason']),
		reviewer_gate_decision: Object.freeze([
			'sessionId',
			'gate',
			'taskId',
			'blocked',
			'allowed',
			'reasonCode',
			'evidenceKind',
		]),
		phase_changed: Object.freeze(['sessionId', 'oldPhase', 'newPhase']),
		budget_updated: Object.freeze(['sessionId', 'budgetPct', 'agentName']),
		model_fallback: Object.freeze([
			'sessionId',
			'agentName',
			'fromModel',
			'toModel',
			'reason',
		]),
		hard_limit_hit: Object.freeze([
			'sessionId',
			'agentName',
			'limitType',
			'value',
		]),
		revision_limit_hit: Object.freeze(['sessionId', 'agentName']),
		loop_detected: Object.freeze(['sessionId', 'agentName', 'loopType']),
		scope_violation: Object.freeze([
			'sessionId',
			'agentName',
			'file',
			'reason',
		]),
		qa_skip_violation: Object.freeze(['sessionId', 'agentName', 'skipCount']),
		heartbeat: Object.freeze(['sessionId']),
		turbo_mode_changed: Object.freeze(['sessionId', 'enabled', 'agentName']),
		auto_oversight_escalation: Object.freeze([
			'sessionId',
			'reason',
			'interactionCount',
			'deadlockCount',
			'phase',
		]),
		environment_detected: Object.freeze([
			'sessionId',
			'hostOS',
			'shellFamily',
			'executionMode',
		]),
		prm_pattern_detected: Object.freeze([
			'sessionId',
			'pattern',
			'severity',
			'category',
			'stepRange',
		]),
		prm_course_correction_injected: Object.freeze([
			'sessionId',
			'pattern',
			'level',
		]),
		prm_escalation_triggered: Object.freeze([
			'sessionId',
			'pattern',
			'level',
			'occurrenceCount',
		]),
		prm_hard_stop: Object.freeze([
			'sessionId',
			'pattern',
			'level',
			'occurrenceCount',
		]),

		// Issue #2063 / #2065 containment events, catalogued when this branch
		// merged main.
		no_op_strong_warning: Object.freeze([
			'sessionId',
			'agentName',
			'count',
			'threshold',
		]),
		gate_denial_loop: Object.freeze(['sessionId', 'tool', 'code', 'count']),
		execution_stall_warning: Object.freeze(['sessionId', 'count', 'threshold']),
		execution_stall_denied: Object.freeze([
			'sessionId',
			'tool',
			'count',
			'threshold',
		]),
		swarm_internals_read_denied: Object.freeze(['sessionId', 'tool', 'target']),
		prm_hard_stop_delivered: Object.freeze([
			'sessionId',
			'pattern',
			'level',
			'occurrenceCount',
		]),

		// src/evidence/lock.ts:86,94,129 — direct emit call sites.
		evidence_lock_acquired: Object.freeze([
			'directory',
			'evidencePath',
			'agent',
			'taskId',
			'attempt',
		]),
		evidence_lock_contended: Object.freeze([
			'directory',
			'evidencePath',
			'agent',
			'taskId',
			'attempt',
		]),
		evidence_lock_stale_recovered: Object.freeze([
			'directory',
			'evidencePath',
			'agent',
			'taskId',
			'attempt',
		]),

		// src/plan/manager.ts:329,1696 and src/plan/ledger.ts:681.
		plan_ledger_cas_retry: Object.freeze([
			'attempt',
			'expectedHashPrefix',
			'delayMs',
		]),
		plan_md_write_failed: Object.freeze(['directory', 'error', 'timestamp']),
		snapshot_failed: Object.freeze(['error', 'retries', 'source']),

		// src/hooks/conflict-resolution.ts:55-73. Note `type` and `timestamp`: this
		// producer supplies its own, and the caller's values must keep winning in
		// the legacy line.
		agent_conflict_detected: Object.freeze([
			'type',
			'timestamp',
			'sessionId',
			'phase',
			'taskId',
			'sourceAgent',
			'targetAgent',
			'conflictType',
			'resolutionPath',
			'summary',
		]),

		// Best-effort projection only. receiptOutcome/receiptSource are domain
		// values and do not populate the generic observability outcome.
		// receiptSemantics versions the outcome/source meaning contract (#2032).
		knowledge_receipt_transition: Object.freeze([
			'transition',
			'reasonCode',
			'schemaVersion',
			'receiptSemantics',
			'knowledgeTraceId',
			'knowledgeEntryId',
			'sessionId',
			'taskId',
			'phase',
			'receiptOutcome',
			'receiptSource',
		]),
		// Issue #2033 human-only hive-store maintenance audit: metadata only — bounded
		// phase/abort codes, counts, and hash/token prefixes.
		knowledge_maintenance: Object.freeze([
			'phase',
			'abortReason',
			'selectedCount',
			'storeEntriesBefore',
			'storeEntriesAfter',
			'backupBytes',
			'storeSha256Prefix',
			'token12',
		]),
	});

const EMPTY_EXTRA: Record<string, unknown> = Object.freeze({});

/** Key that needs `defineProperty` rather than assignment — see the loop below. */
const PROTO_KEY = '__proto__';

function degradedProjection(marker: string, data: unknown): LegacyProjection {
	return {
		sourceStore: LEGACY_TELEMETRY_SOURCE_STORE,
		sourceSchemaVersion: null,
		timingConfidence: 'writer-clock',
		unknown: [marker],
		extra: EMPTY_EXTRA,
		raw: data,
	};
}

/**
 * Project a legacy telemetry payload onto the contract's legacy fields.
 *
 * NEVER throws and NEVER deep-traverses. `Object.keys` is shallow, so a circular
 * payload is safe; the whole introspection is nonetheless wrapped, because a
 * Proxy `ownKeys` trap or a throwing getter can raise on a shallow read too.
 *
 * @param kind - Wire event kind (used only for the caller's own bookkeeping;
 *   the projection itself is kind-agnostic).
 * @param data - The caller's payload. Held BY REFERENCE as `raw`.
 * @param knownKeys - Keys the producer of `kind` is known to emit, normally
 *   `KNOWN_TELEMETRY_KEYS[kind]`.
 */
/**
 * Shared frozen empties returned when a payload has no unrecognized keys and no
 * unknown fields — the common case. Frozen so a consumer cannot mutate one
 * observation's projection and corrupt every other observation that shares it.
 */
const EMPTY_UNKNOWN: readonly string[] = Object.freeze([]);

/**
 * Memoized `knownKeys` -> Set, keyed by ARRAY IDENTITY.
 *
 * Safe because every production caller passes a frozen singleton from
 * {@link KNOWN_TELEMETRY_KEYS}. A caller that builds a fresh array per call
 * simply misses the cache and pays the old cost — never a wrong answer. The map
 * is bounded by the number of distinct arrays the process ever passes, which for
 * production is the 39 catalogued kinds plus the shared empty array.
 */
const _knownKeySetCache = new WeakMap<readonly string[], ReadonlySet<string>>();

function knownKeySetFor(knownKeys: readonly string[]): ReadonlySet<string> {
	const cached = _knownKeySetCache.get(knownKeys);
	if (cached !== undefined) return cached;
	const built: ReadonlySet<string> = new Set(knownKeys);
	_knownKeySetCache.set(knownKeys, built);
	return built;
}

export function adaptLegacyTelemetryPayload(
	kind: string,
	data: unknown,
	knownKeys: readonly string[],
): LegacyProjection {
	// `kind` is part of the documented signature and is intentionally not used
	// to alter the projection: the adapter must describe the payload it was
	// handed, not the payload the catalog expected for this kind.
	void kind;

	if (data === null || typeof data !== 'object') {
		return degradedProjection(NON_OBJECT_PAYLOAD_MARKER, data);
	}

	try {
		const record = data as Record<string, unknown>;
		// `knownKeys` comes from the frozen `KNOWN_TELEMETRY_KEYS` singletons, so the
		// array identity is stable per kind and the derived Set can be memoized.
		// Rebuilding it per emit was the single largest cost on the `emit()` hot
		// path (~2.3us p50); AGENTS.md invariant 1 and the frugality contract at
		// src/telemetry.ts:315-317 make that worth avoiding.
		const known = knownKeySetFor(knownKeys);
		const ownKeys = Object.keys(record);

		// Unrecognized own keys are preserved by reference — never dropped, never
		// cloned. Allocation is deferred: the overwhelmingly common case is a
		// payload that exactly matches its catalogued keys, and allocating two
		// empty containers per emit for that case is pure waste.
		let extra: Record<string, unknown> | undefined;
		for (const key of ownKeys) {
			if (known.has(key)) continue;
			extra ??= {};
			if (key === PROTO_KEY) {
				// A plain assignment to `__proto__` sets the prototype instead of
				// creating an own property, silently DROPPING the value — which would
				// break the "never drop unrecognized fields" rule. Define it instead.
				Object.defineProperty(extra, key, {
					value: record[key],
					enumerable: true,
					writable: true,
					configurable: true,
				});
				continue;
			}
			extra[key] = record[key];
		}

		// "Producer did not know" fields. Absent OR explicitly `undefined` both
		// count: `JSON.stringify` elides an `undefined` value, so on the wire the
		// two are indistinguishable, and neither is zero.
		// `record[key] === undefined` already covers "absent" as well as "present but
		// explicitly undefined" — the two are indistinguishable on the wire because
		// JSON.stringify elides both — so the extra `present` Set this used to build
		// was redundant work on the hot path.
		let unknownFields: string[] | undefined;
		for (const key of knownKeys) {
			if (record[key] === undefined) {
				unknownFields ??= [];
				unknownFields.push(key);
			}
		}

		return {
			sourceStore: LEGACY_TELEMETRY_SOURCE_STORE,
			// `.swarm/telemetry.jsonl` has no version field at all. `null` records
			// that the version is UNKNOWN — it is not version zero. That absence is
			// itself a finding of issue #2029.
			sourceSchemaVersion: null,
			// Every current producer's time is read by the writer at record time.
			timingConfidence: 'writer-clock',
			unknown: unknownFields ?? EMPTY_UNKNOWN,
			extra: extra ?? EMPTY_EXTRA,
			raw: data,
		};
	} catch {
		return degradedProjection(INTROSPECTION_FAILED_MARKER, data);
	}
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Extract recognized correlation IDs from a legacy payload.
 *
 * Shallow, never throws, and NEVER synthesizes: an ID that is absent, empty, or
 * of the wrong type stays `undefined`. Only the mappings a producer actually
 * populates are implemented — `sessionId` to `hostSessionId`, `taskId`, `phase`
 * to `phaseId`, `laneId`, `batchId`, plus the canonical receipt payload keys
 * `knowledgeTraceId` and `knowledgeEntryId`. Unmapped IDs stay absent; inventing
 * an extraction for them would manufacture exactly the joins issue #2029 item 2
 * forbids.
 */
export function extractWorkflowIds(data: unknown): WorkflowIds {
	const ids: WorkflowIds = {};
	try {
		if (data === null || typeof data !== 'object') return ids;
		const record = data as Record<string, unknown>;

		const hostSessionId = nonEmptyString(record.sessionId);
		if (hostSessionId !== undefined) ids.hostSessionId = hostSessionId;

		const taskId = nonEmptyString(record.taskId);
		if (taskId !== undefined) ids.taskId = taskId;

		const laneId = nonEmptyString(record.laneId);
		if (laneId !== undefined) ids.laneId = laneId;

		const batchId = nonEmptyString(record.batchId);
		if (batchId !== undefined) ids.batchId = batchId;

		const knowledgeTraceId = nonEmptyString(record.knowledgeTraceId);
		if (knowledgeTraceId !== undefined) {
			ids.knowledgeTraceId = knowledgeTraceId;
		}

		const knowledgeEntryId = nonEmptyString(record.knowledgeEntryId);
		if (knowledgeEntryId !== undefined) {
			ids.knowledgeEntryId = knowledgeEntryId;
		}

		// Phase 0 is a real phase, so numeric truthiness must not be used here.
		const phase = record.phase;
		if (typeof phase === 'number' && Number.isFinite(phase)) {
			ids.phaseId = String(phase);
		} else {
			const phaseString = nonEmptyString(phase);
			if (phaseString !== undefined) ids.phaseId = phaseString;
		}
	} catch {
		// A hostile payload degrades to "no IDs established", never to a throw.
	}
	return ids;
}

/**
 * Map a legacy `result` string onto a contract status.
 *
 * A reported-but-unmappable result becomes `'unknown'` — a different fact from
 * "the producer said nothing", which leaves `status` absent entirely.
 */
const RESULT_STATUS_MAP: Readonly<Record<string, Outcome['status']>> =
	Object.freeze({
		success: 'success',
		succeeded: 'success',
		ok: 'success',
		pass: 'success',
		passed: 'success',
		complete: 'success',
		completed: 'success',
		failure: 'failure',
		failed: 'failure',
		fail: 'failure',
		error: 'failure',
		partial: 'partial',
	});

/**
 * Extract terminal disposition from a legacy payload.
 *
 * Shallow and never throws. `durationMs` is deliberately never populated: no
 * current producer reports a duration, and deriving one would fabricate a
 * measurement.
 */
export function extractOutcome(data: unknown): Outcome {
	const outcome: Outcome = {};
	try {
		if (data === null || typeof data !== 'object') return outcome;
		const record = data as Record<string, unknown>;

		const result = nonEmptyString(record.result);
		if (result !== undefined) {
			const normalized = result.toLowerCase();
			outcome.status = Object.hasOwn(RESULT_STATUS_MAP, normalized)
				? RESULT_STATUS_MAP[normalized]
				: 'unknown';
		}

		const reason = nonEmptyString(record.reason);
		if (reason !== undefined) outcome.reason = reason;

		const errorName = nonEmptyString(record.errorName);
		if (errorName !== undefined) outcome.errorName = errorName;

		const errorMessage = nonEmptyString(record.errorMessage);
		if (errorMessage !== undefined) outcome.errorMessage = errorMessage;

		const retryIndex = record.retry_index;
		if (typeof retryIndex === 'number' && Number.isFinite(retryIndex)) {
			outcome.retryIndex = retryIndex;
		}
	} catch {
		// A hostile payload degrades to "no outcome established", never a throw.
	}
	return outcome;
}
