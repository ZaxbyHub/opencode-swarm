/**
 * Learning/operations health — bounded-window alarm registry (issue #2044).
 *
 * Lives in `src/health/`, NOT `src/observability/`: this module performs
 * bounded artifact I/O (`.swarm/learning-health.json`) and imports telemetry,
 * both of which the observability directory's zero-I/O contract forbids
 * (enforced by `tests/unit/observability/no-io.test.ts`).
 *
 * This module owns the eight alarm families the observability series assigned
 * to PR 16:
 *
 *   1. `headroom_dead_streak`       — repeated zero/negative effective headroom
 *   2. `model_limit_fallback`       — context-limit resolution fell back off the
 *                                     host/live or user-override rungs
 *   3. `retrieval_outcome_liveness` — retrieval → terminal receipt → application
 *                                     outcome chain stalled
 *   4. `role_participation`         — eligible workflow roles not participating
 *   5. `promoted_fixture_share`     — promoted-tier evidence dominated by
 *                                     non-field (fixture/synthetic-class) sources
 *   6. `archive_activity_mismatch`  — close archive empty/invalid while recorded
 *                                     activity predicted content
 *   7. `recovery_ledger_pressure`   — background delegation recovery ledger near
 *                                     its 4 MiB bound
 *   8. `compaction_drop_coverage`   — store compaction dropping/corrupting
 *                                     records across the six audited stores
 *
 * ## Contracts (issue #2044 items 5-10)
 *
 * - **Bounded windows with cooldown + hysteresis.** Every alarm raises only on
 *   its per-family condition inside a bounded window, re-emits at most once per
 *   cooldown interval (`sustained`), and recovers explicitly. Duplicate facts
 *   (same kind + timestamp) and late/out-of-order facts never storm alerts: the
 *   window is a monotonic append; a late fact counts but never rewinds
 *   `windowStartMs`.
 * - **Per-canonical-project/session state with explicit eviction.** Session
 *   scopes are keyed `<projectRef>/<sessionRef>` when the producer knows its
 *   project directory and `u/<sessionRef>` when it does not (the chat-transform
 *   hooks receive no directory), so identical session ids under distinct
 *   projects never collide. Scope maps are FIFO-evicted at
 *   {@link MAX_HEALTH_SCOPES}; fact rings at {@link MAX_FACTS_PER_SCOPE}.
 * - **No raw content.** Payloads and the persisted artifact carry counts,
 *   closed-vocabulary enums, booleans, millisecond timestamps, model/provider
 *   identity, and 16-hex salted session refs from
 *   `pseudonymousSessionRef` — never raw session ids, paths, queries, prompts,
 *   or responses (item 10).
 * - **Persistence is transitions + compact per-scope counters ONLY** (item 9):
 *   what incident reconstruction needs. This module intentionally contains NO
 *   invocation-owned transient-retry or `nonTransientCircuit` state, so there is
 *   nothing of that class to persist or rehydrate — restarts resume health
 *   accumulation from the persisted counters, which is health state, not
 *   invocation state.
 * - **Typed health-source registration, no fake sink** (item 8):
 *   {@link HEALTH_SOURCES} cites every real producer and reader file:line.
 *   There is deliberately NO `sink` source and NO "sink loss" value — issue
 *   #2047 / PR 19 must register its own real producer and reader.
 *
 * Every alarm is wired to production readers: the `/swarm status` Learning
 * Health section and the `/swarm diagnose` learning-health check (both via
 * {@link readLearningHealth}); `context_status` additionally exposes model-limit
 * provenance directly.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ContextWindowSource } from '../config/context-window';
import {
	pseudonymousRef,
	pseudonymousSessionRef,
	resolveLineageSalt,
} from '../observability/ids';
import type { TelemetryEvent } from '../telemetry';
import { telemetry } from '../telemetry';
import { atomicWriteSwarmFile } from '../utils/atomic-write';
import { canonicalRootKeyFresh } from '../utils/canonical-root.js';

/** The eight alarm families owned by this module. */
export type LearningHealthAlarmId =
	| 'headroom_dead_streak'
	| 'model_limit_fallback'
	| 'retrieval_outcome_liveness'
	| 'role_participation'
	| 'promoted_fixture_share'
	| 'archive_activity_mismatch'
	| 'recovery_ledger_pressure'
	| 'compaction_drop_coverage';

export type LearningHealthTransition = 'raised' | 'sustained' | 'recovered';
export type LearningHealthSeverity = 'warning' | 'critical';
export type LearningHealthScopeClass = 'session' | 'identity' | 'project';

/** Identifier of a producer subsystem feeding alarms (typed registration). */
export type HealthSourceId =
	| 'context_budget'
	| 'model_limits'
	| 'knowledge_receipts'
	| 'curator_compliance'
	| 'promotion_evidence'
	| 'close_archive'
	| 'delegation_ledger'
	| 'store_health_events';

export interface HealthSourceRegistration {
	/** file:line of the live producer call site. */
	readonly producer: string;
	/** file:line of every live reader of this source's data. */
	readonly readers: readonly string[];
	/** Alarms this source feeds. */
	readonly alarms: readonly LearningHealthAlarmId[];
}

/**
 * Typed health-source registration (issue #2044 item 8). Producers and readers
 * are REAL file:line citations; update them when call sites move. There is
 * intentionally no `sink` entry and no sink-loss value: the observability sink
 * is issue #2047's work and must register its own producer + reader there.
 */
const HEALTH_SOURCES_TABLE: Record<HealthSourceId, HealthSourceRegistration> = {
	context_budget: {
		producer: 'src/hooks/context-budget.ts:199',
		readers: [
			'src/services/status-service.ts',
			'src/services/diagnose-service.ts',
		],
		alarms: ['headroom_dead_streak'],
	},
	model_limits: {
		producer: 'src/hooks/model-limits.ts:333',
		readers: [
			'src/tools/context-status.ts',
			'src/services/status-service.ts',
			'src/services/diagnose-service.ts',
		],
		alarms: ['model_limit_fallback'],
	},
	knowledge_receipts: {
		producer: 'src/hooks/knowledge-receipt-ledger.ts:2219',
		readers: [
			'src/services/status-service.ts',
			'src/services/diagnose-service.ts',
		],
		alarms: ['retrieval_outcome_liveness'],
	},
	curator_compliance: {
		producer: 'src/hooks/curator.ts:1906',
		readers: [
			'src/services/status-service.ts',
			'src/services/diagnose-service.ts',
		],
		alarms: ['role_participation'],
	},
	promotion_evidence: {
		producer: 'src/hooks/promotion-evidence-store.ts:94',
		readers: [
			'src/services/status-service.ts',
			'src/services/diagnose-service.ts',
		],
		alarms: ['promoted_fixture_share'],
	},
	close_archive: {
		producer: 'src/commands/close.ts:754',
		readers: [
			'src/services/status-service.ts',
			'src/services/diagnose-service.ts',
		],
		alarms: ['archive_activity_mismatch'],
	},
	delegation_ledger: {
		producer: 'src/background/delegation-health.ts:581',
		readers: [
			'src/services/status-service.ts',
			'src/services/diagnose-service.ts',
		],
		alarms: ['recovery_ledger_pressure'],
	},
	store_health_events: {
		producer:
			'src/events/core-events.ts:1616 (direct observeStoreHealth; one per audited store)',
		readers: [
			'src/services/status-service.ts',
			'src/services/diagnose-service.ts',
		],
		alarms: ['compaction_drop_coverage'],
	},
};

export const HEALTH_SOURCES: Readonly<
	Record<HealthSourceId, HealthSourceRegistration>
> = Object.freeze(HEALTH_SOURCES_TABLE);

/** Per-family thresholds. Documented constants, deliberately not user config. */
export const LEARNING_HEALTH_ALARM_CONFIG = Object.freeze({
	headroom_dead_streak: Object.freeze({
		windowMs: 600_000,
		raiseFacts: 3,
		cooldownMs: 1_800_000,
		severity: 'warning' as LearningHealthSeverity,
	}),
	model_limit_fallback: Object.freeze({
		windowMs: 1_800_000,
		cooldownMs: 3_600_000,
		severity: 'warning' as LearningHealthSeverity,
	}),
	retrieval_outcome_liveness: Object.freeze({
		// Gap age beyond which a stalled retrieval→receipt→outcome chain raises.
		windowMs: 1_800_000,
		cooldownMs: 900_000,
		severity: 'warning' as LearningHealthSeverity,
		// Gap-2 (terminal 'applied' → authoritative closure) opens only after the
		// application gate's own staleness horizon (DEFAULT_GATE_STALENESS_MS =
		// 600_000, src/hooks/knowledge-application-gate.ts:93) — we never raise
		// before the system itself would have escalated.
		gap2StalenessMs: 600_000,
	}),
	role_participation: Object.freeze({
		windowMs: 86_400_000,
		// Structural-zero guard: a single review window with no eligible
		// opportunity can never raise; two gaps within the window can.
		raiseFacts: 2,
		cooldownMs: 43_200_000,
		severity: 'warning' as LearningHealthSeverity,
	}),
	promoted_fixture_share: Object.freeze({
		windowMs: 604_800_000,
		raiseShare: 0.5,
		clearShare: 0.3,
		minEvidence: 4,
		cooldownMs: 86_400_000,
		severity: 'warning' as LearningHealthSeverity,
	}),
	archive_activity_mismatch: Object.freeze({
		windowMs: 0,
		cooldownMs: 86_400_000,
		severity: 'warning' as LearningHealthSeverity,
	}),
	recovery_ledger_pressure: Object.freeze({
		windowMs: 900_000,
		raisePct: 0.8,
		clearPct: 0.7,
		cooldownMs: 1_800_000,
		severity: 'warning' as LearningHealthSeverity,
	}),
	compaction_drop_coverage: Object.freeze({
		windowMs: 3_600_000,
		corruptRaise: 1,
		droppedRaise: 100,
		cooldownMs: 3_600_000,
		severity: 'warning' as LearningHealthSeverity,
	}),
});

/**
 * Receipt sources that count as FIELD evidence for the fixture-share alarm:
 * real workflow actors in a real run. `delegate` is field-but-non-independent —
 * the independence dimension belongs to the promotion gate
 * (src/hooks/knowledge-types.ts:410-418) and is deliberately NOT duplicated
 * here.
 */
export const FIELD_RECEIPT_SOURCES: ReadonlySet<string> = new Set([
	'delegate',
	'reviewer',
	'architect',
	'architect_marker',
	'test_engineer',
]);

/**
 * Receipt sources that count as NON-FIELD (fixture/synthetic-class) evidence:
 * authorized overrides, manual/migration imports, administrative gate
 * releases, and `unknown` (fail-closed — a forged or missing label never counts
 * as field).
 */
export const NON_FIELD_RECEIPT_SOURCES: ReadonlySet<string> = new Set([
	'phase_override',
	'manual',
	'migration',
	'application_gate_staleness_release',
	'application_gate_denial_limit_release',
	'application_gate_session_reset_release',
	'unknown',
]);

const MAX_HEALTH_SCOPES = 64;
const MAX_FACTS_PER_SCOPE = 64;
const MAX_LIVENESS_GAPS = 64;
const MAX_TRANSITION_RING = 100;
const PERSIST_DEBOUNCE_MS = 5_000;
const CLOCK_SKEW_TOLERANCE_MS = 300_000;
const ARTIFACT_FILENAME = 'learning-health.json';
const ARTIFACT_SCHEMA_VERSION = 1;

/** The six audited stores whose `*_health` telemetry feeds the drop alarm. */
const STORE_HEALTH_KINDS: ReadonlySet<string> = new Set([
	'context_telemetry_health',
	'skill_usage_health',
	'core_events_health',
	'shell_audit_health',
	'trajectory_health',
	'pr_subscription_health',
]);

const STORE_LABEL_BY_KIND: Readonly<Record<string, string>> = Object.freeze({
	context_telemetry_health: 'context_telemetry',
	skill_usage_health: 'skill_usage',
	core_events_health: 'core_events',
	shell_audit_health: 'shell_audit',
	trajectory_health: 'trajectory',
	pr_subscription_health: 'pr_subscription',
});

interface HealthFact {
	atMs: number;
	/** Closed vocabulary per family (e.g. 'dead' | 'healthy'; 'field' | 'non_field'). */
	kind: string;
}

interface ScopeHealthState {
	status: 'idle' | 'active';
	severity: LearningHealthSeverity;
	windowStartMs: number;
	factCount: number;
	lastFactAtMs: number;
	raisedAtMs: number;
	lastEmitAtMs: number;
	transitionCount: number;
	facts: HealthFact[];
}

interface LivenessGap {
	gapType: 'membership_to_terminal' | 'terminal_to_application';
	openedAtMs: number;
	eligibleAtMs: number;
}

interface PersistedScope {
	status: 'idle' | 'active';
	severity: LearningHealthSeverity;
	windowStartMs: number;
	factCount: number;
	lastFactAtMs: number;
	raisedAtMs: number;
	transitionCount: number;
}

interface PersistedTransition {
	alarm: LearningHealthAlarmId;
	transition: LearningHealthTransition;
	severity: LearningHealthSeverity;
	atMs: number;
	coverageFacts: number;
}

interface PersistedArtifact {
	schemaVersion: number;
	updatedAtMs: number;
	alarms: Record<string, { scopes: Record<string, PersistedScope> }>;
	transitions: PersistedTransition[];
}

const alarmScopes = new Map<
	LearningHealthAlarmId,
	Map<string, ScopeHealthState>
>();
const livenessGaps = new Map<string, Map<string, LivenessGap>>();
const transitionRing: PersistedTransition[] = [];
const lastPersistAtByDirectory = new Map<string, number>();
/**
 * Bounded fallback persistence target (final-critic finding 2): facts observed
 * without a directory (model-limit resolutions)
 * persist under the most recent directory a directory-bearing producer or
 * reader used — the plugin host process serves one project, so this is the
 * owning project in practice. Bounded like every other map here.
 */
interface RecentPersistDirectory {
	/** Stable physical identity captured when this entry was observed. */
	key: string;
	/** Usable caller spelling retained for artifact I/O. */
	directory: string;
}

const recentPersistDirectories: RecentPersistDirectory[] = [];

const MAX_TRACKED_DIRECTORIES = 16;

function rememberPersistDirectory(directory: string): void {
	const key = canonicalRootKeyFresh(directory);
	const idx = recentPersistDirectories.findIndex((entry) => entry.key === key);
	if (idx >= 0) {
		recentPersistDirectories.splice(idx, 1);
	}
	recentPersistDirectories.push({ key, directory });
	while (recentPersistDirectories.length > MAX_TRACKED_DIRECTORIES) {
		const evicted = recentPersistDirectories.shift();
		if (evicted !== undefined) lastPersistAtByDirectory.delete(evicted.key);
	}
}

export const _internals: {
	now: () => number;
	emitTelemetry: (payload: Record<string, unknown>) => void;
	writeArtifact: (directory: string, contents: string) => Promise<void>;
	readArtifact: (directory: string) => Promise<string | null>;
} = {
	now: () => Date.now(),
	emitTelemetry: (payload) => {
		telemetry.learningHealthAlarm(
			payload as Parameters<typeof telemetry.learningHealthAlarm>[0],
		);
	},
	writeArtifact: (directory, contents) =>
		atomicWriteSwarmFile(
			path.join(directory, '.swarm', ARTIFACT_FILENAME),
			contents,
		),
	readArtifact: async (directory) => {
		try {
			return await fs.readFile(
				path.join(directory, '.swarm', ARTIFACT_FILENAME),
				'utf-8',
			);
		} catch {
			return null;
		}
	},
};

const projectRefCache = new Map<string, string>();
function projectRef(directory: string): string {
	// Memoized (PRR-013): the chat-transform hot path re-derives the same
	// directory ref on every observation; a bounded memo removes the repeated
	// sha256 per transform while staying within the directory-tracking cap.
	const key = canonicalRootKeyFresh(directory);
	const cached = projectRefCache.get(key);
	if (cached !== undefined) return cached;
	const ref = pseudonymousRef(key, resolveLineageSalt());
	if (!projectRefCache.has(key)) {
		while (projectRefCache.size >= MAX_TRACKED_DIRECTORIES) {
			const oldest = projectRefCache.keys().next().value;
			if (oldest === undefined) break;
			projectRefCache.delete(oldest);
		}
	}
	projectRefCache.set(key, ref);
	return ref;
}

/**
 * Project ref emitted before #2474 switched learning-health ownership to the
 * canonical physical root. Keep it as a read-only compatibility alias so
 * existing `.swarm/learning-health.json` artifacts do not orphan active
 * alarms after an upgrade. New observations always use `projectRef`.
 */
function legacyProjectRef(directory: string): string {
	return pseudonymousRef(directory, resolveLineageSalt());
}

function sessionScopeKey(
	directory: string | undefined,
	sessionID: string,
): string {
	const ref = pseudonymousSessionRef(sessionID);
	return directory ? `${projectRef(directory)}/${ref}` : `u/${ref}`;
}

function getScopeMap(
	alarm: LearningHealthAlarmId,
): Map<string, ScopeHealthState> {
	let map = alarmScopes.get(alarm);
	if (!map) {
		map = new Map();
		alarmScopes.set(alarm, map);
	}
	return map;
}

function ensureScope(
	alarm: LearningHealthAlarmId,
	scopeKey: string,
	now: number,
): ScopeHealthState {
	const map = getScopeMap(alarm);
	let scope = map.get(scopeKey);
	if (scope) return scope;
	while (map.size >= MAX_HEALTH_SCOPES) {
		const oldest = map.keys().next().value;
		if (oldest === undefined) break;
		if (oldest === scopeKey) break;
		map.delete(oldest);
	}
	scope = {
		status: 'idle',
		severity: LEARNING_HEALTH_ALARM_CONFIG[alarm].severity,
		windowStartMs: now,
		factCount: 0,
		lastFactAtMs: 0,
		raisedAtMs: 0,
		lastEmitAtMs: 0,
		transitionCount: 0,
		facts: [],
	};
	map.set(scopeKey, scope);
	return scope;
}

/**
 * Append a fact to a scope's bounded window. Deduplicates (kind, atMs)
 * repeats, tolerates late/out-of-order timestamps without rewinding the
 * window, and prunes the in-memory ring by age and size.
 */
function appendFact(
	scope: ScopeHealthState,
	kind: string,
	atMs: number,
	windowMs: number,
): void {
	const duplicate = scope.facts.some((f) => f.kind === kind && f.atMs === atMs);
	if (!duplicate) {
		scope.facts.push({ atMs, kind });
		while (scope.facts.length > MAX_FACTS_PER_SCOPE) scope.facts.shift();
	}
	const skewAdjusted = Math.min(
		atMs,
		_internals.now() + CLOCK_SKEW_TOLERANCE_MS,
	);
	scope.lastFactAtMs = Math.max(scope.lastFactAtMs, skewAdjusted);
	if (skewAdjusted - scope.windowStartMs > windowMs) {
		// Window slide: drop facts older than the window edge, keep the count of
		// in-window facts authoritative.
		const edge = skewAdjusted - windowMs;
		scope.facts = scope.facts.filter((f) => f.atMs >= edge);
		scope.windowStartMs = edge;
	}
	scope.factCount = scope.facts.length;
}

function countFacts(scope: ScopeHealthState, kind: string): number {
	let n = 0;
	for (const fact of scope.facts) if (fact.kind === kind) n += 1;
	return n;
}

/** Alarm payload detail — counts/enums/refs only, never raw content. */
export interface AlarmEmitDetail {
	sessionRef?: string;
	model?: string;
	provider?: string;
	limitSource?: string;
	denominatorFallback?: boolean;
	pressurePct?: number;
	band?: string;
	sharePct?: number;
	fieldCount?: number;
	nonFieldCount?: number;
	store?: string;
	dropped?: number;
	corrupt?: number;
	retained?: number;
	accepted?: number;
	gapType?: 'membership_to_terminal' | 'terminal_to_application';
	role?: string;
	phase?: number;
	reason?: string;
}

const DETAIL_PAYLOAD_KEYS: Readonly<Record<string, string>> = Object.freeze({
	sessionRef: 'session_ref',
	limitSource: 'limit_source',
	denominatorFallback: 'denominator_fallback',
	pressurePct: 'pressure_pct',
	sharePct: 'share_pct',
	fieldCount: 'field_count',
	nonFieldCount: 'non_field_count',
	gapType: 'gap_type',
});

function emitTransition(
	alarm: LearningHealthAlarmId,
	scopeClass: LearningHealthScopeClass,
	scopeKey: string,
	transition: LearningHealthTransition,
	severity: LearningHealthSeverity,
	detail: AlarmEmitDetail,
	scope: ScopeHealthState,
	now: number,
): void {
	scope.lastEmitAtMs = now;
	scope.transitionCount += 1;
	const payload: Record<string, unknown> = {
		alarm,
		transition,
		severity,
		scope_class: scopeClass,
		window_ms: LEARNING_HEALTH_ALARM_CONFIG[alarm].windowMs,
		coverage_facts: scope.factCount,
		raise_facts: scope.raisedAtMs > 0 ? countRaiseFacts(alarm, scope) : 0,
		age_ms: scope.raisedAtMs > 0 ? Math.max(0, now - scope.raisedAtMs) : 0,
	};
	// session_ref surfaces the pseudonym for session-class scopes only; the
	// scopeKey itself is already ref-based, but it may carry a project prefix.
	if (scopeClass === 'session') {
		payload.session_ref = scopeKey.split('/').pop();
	}
	for (const [key, value] of Object.entries(detail)) {
		if (value === undefined) continue;
		const payloadKey = DETAIL_PAYLOAD_KEYS[key] ?? key;
		payload[payloadKey] = value;
	}
	transitionRing.push({
		alarm,
		transition,
		severity,
		atMs: now,
		coverageFacts: scope.factCount,
	});
	while (transitionRing.length > MAX_TRANSITION_RING) transitionRing.shift();
	_internals.emitTelemetry(payload);
}

function countRaiseFacts(
	alarm: LearningHealthAlarmId,
	scope: ScopeHealthState,
): number {
	switch (alarm) {
		case 'headroom_dead_streak':
			return countFacts(scope, 'dead');
		case 'role_participation':
			return countFacts(scope, 'gap');
		case 'promoted_fixture_share':
			return countFacts(scope, 'non_field');
		case 'compaction_drop_coverage':
			return countFacts(scope, 'corrupt') + countFacts(scope, 'dropped');
		default:
			return scope.factCount;
	}
}

/**
 * Apply an alarm state transition with cooldown + hysteresis semantics.
 * `raise` on an already-active scope emits `sustained` only past the cooldown;
 * `clear` on an idle scope is a no-op.
 */
function applyAlarmState(
	alarm: LearningHealthAlarmId,
	scopeClass: LearningHealthScopeClass,
	scopeKey: string,
	desired: 'active' | 'idle',
	severity: LearningHealthSeverity,
	detail: AlarmEmitDetail,
	directory: string | undefined,
	now: number,
): void {
	// Remember the owning directory at observation time (not only when a
	// persist is scheduled) so directory-less facts can anchor to it.
	if (directory) rememberPersistDirectory(directory);
	const scope = ensureScope(alarm, scopeKey, now);
	const config = LEARNING_HEALTH_ALARM_CONFIG[alarm] as { cooldownMs: number };
	if (desired === 'active') {
		scope.severity = severity;
		if (scope.status === 'idle') {
			scope.status = 'active';
			scope.raisedAtMs = now;
			emitTransition(
				alarm,
				scopeClass,
				scopeKey,
				'raised',
				severity,
				detail,
				scope,
				now,
			);
			schedulePersist(directory, now, true);
		} else if (now - scope.lastEmitAtMs >= config.cooldownMs) {
			emitTransition(
				alarm,
				scopeClass,
				scopeKey,
				'sustained',
				severity,
				detail,
				scope,
				now,
			);
			schedulePersist(directory, now, true);
		}
		return;
	}
	if (scope.status === 'active') {
		scope.status = 'idle';
		scope.severity = LEARNING_HEALTH_ALARM_CONFIG[alarm].severity;
		emitTransition(
			alarm,
			scopeClass,
			scopeKey,
			'recovered',
			severity,
			detail,
			scope,
			now,
		);
		schedulePersist(directory, now, true);
	}
}

function schedulePersist(
	directory: string | undefined,
	now: number,
	force: boolean,
): void {
	// Facts observed without a directory (model-limit identity scopes,
	// store-health events) still persist — under the most recent
	// directory a directory-bearing producer or reader used (final-critic
	// finding 2). With no known directory at all, persistence waits for a
	// reader; correctness never depends on the artifact.
	const target = directory ?? recentPersistDirectories.at(-1)?.directory;
	if (!target) return;
	const targetKey = canonicalRootKeyFresh(target);
	const last = lastPersistAtByDirectory.get(targetKey) ?? 0;
	if (!force && now - last < PERSIST_DEBOUNCE_MS) return;
	lastPersistAtByDirectory.set(targetKey, now);
	void persistLearningHealth(target).catch(() => undefined);
}

/** Serialize current health state to `.swarm/learning-health.json` (fire-and-forget). */
export async function persistLearningHealth(directory: string): Promise<void> {
	const artifact: PersistedArtifact = {
		schemaVersion: ARTIFACT_SCHEMA_VERSION,
		updatedAtMs: _internals.now(),
		alarms: {},
		transitions: [...transitionRing],
	};
	for (const [alarm, scopes] of alarmScopes) {
		if (scopes.size === 0) continue;
		const serialized: Record<string, PersistedScope> = {};
		for (const [key, scope] of scopes) {
			serialized[key] = {
				status: scope.status,
				severity: scope.severity,
				windowStartMs: scope.windowStartMs,
				factCount: scope.factCount,
				lastFactAtMs: scope.lastFactAtMs,
				raisedAtMs: scope.raisedAtMs,
				transitionCount: scope.transitionCount,
			};
		}
		artifact.alarms[alarm] = { scopes: serialized };
	}
	// Never-throw at the write boundary: the artifact is best-effort
	// visibility; a failed write must not propagate to direct awaiters
	// (the fire-and-forget callers already .catch, but the exported
	// function's contract is fail-open on its own too).
	try {
		await _internals.writeArtifact(directory, `${JSON.stringify(artifact)}\n`);
	} catch {
		// a lost write loses only visibility, never alarm truth
	}
}

async function rehydrateFromArtifact(directory: string): Promise<void> {
	const raw = await _internals.readArtifact(directory);
	if (!raw) return;
	let parsed: PersistedArtifact;
	try {
		parsed = JSON.parse(raw) as PersistedArtifact;
	} catch {
		return;
	}
	if (parsed.schemaVersion !== ARTIFACT_SCHEMA_VERSION) return;
	const now = _internals.now();
	// Seed the transition ring from persisted history (PRR-012/C6): without
	// this, the first post-restart persist overwrites the artifact's
	// transitions with a fresh short ring and status reports 0 transitions
	// despite durable history. Bounded by the ring cap as always.
	if (transitionRing.length === 0 && Array.isArray(parsed.transitions)) {
		for (const tr of parsed.transitions) {
			if (
				!tr ||
				typeof tr.alarm !== 'string' ||
				!Object.hasOwn(LEARNING_HEALTH_ALARM_CONFIG, tr.alarm) ||
				typeof tr.atMs !== 'number' ||
				!Number.isFinite(tr.atMs)
			) {
				continue;
			}
			transitionRing.push({
				alarm: tr.alarm as LearningHealthAlarmId,
				transition:
					tr.transition === 'raised' ||
					tr.transition === 'sustained' ||
					tr.transition === 'recovered'
						? tr.transition
						: 'raised',
				severity: tr.severity === 'critical' ? 'critical' : 'warning',
				atMs: tr.atMs,
				coverageFacts:
					typeof tr.coverageFacts === 'number' &&
					Number.isFinite(tr.coverageFacts)
						? tr.coverageFacts
						: 0,
			});
		}
		while (transitionRing.length > MAX_TRANSITION_RING) transitionRing.shift();
	}
	// Adopt persisted scope counters that the in-process state does not have
	// (restart case). In-memory state always wins within a live process.
	for (const [alarm, section] of Object.entries(parsed.alarms ?? {})) {
		// A tampered/foreign artifact must not inject unknown alarm families
		// into the in-memory registry (review blind-spot 8), and every adopted
		// FIELD is shape-validated so hostile strings can never reach the
		// rendered status/diagnose output (PRR-005: scope keys and severity
		// flow verbatim into user-visible markdown otherwise).
		if (!Object.hasOwn(LEARNING_HEALTH_ALARM_CONFIG, alarm)) continue;
		if (!section?.scopes) continue;
		const map = getScopeMap(alarm as LearningHealthAlarmId);
		for (const [key, persisted] of Object.entries(section.scopes)) {
			if (map.has(key)) continue;
			if (!isAdoptableScopeKey(key)) continue;
			if (
				!persisted ||
				(persisted.status !== 'idle' && persisted.status !== 'active') ||
				(persisted.severity !== 'warning' &&
					persisted.severity !== 'critical') ||
				!isFiniteCounter(persisted.windowStartMs) ||
				!isFiniteCounter(persisted.factCount) ||
				!isFiniteCounter(persisted.lastFactAtMs) ||
				!isFiniteCounter(persisted.raisedAtMs) ||
				!isFiniteCounter(persisted.transitionCount)
			) {
				continue;
			}
			map.set(key, {
				status: persisted.status,
				severity: persisted.severity,
				windowStartMs: persisted.windowStartMs,
				factCount: persisted.factCount,
				lastFactAtMs: persisted.lastFactAtMs,
				raisedAtMs: persisted.raisedAtMs,
				// Reset the emission clock to the rehydration time so a fresh
				// process never re-emits `sustained` within one cooldown of
				// restart for an alarm it merely rehydrated (review F3).
				lastEmitAtMs: now,
				transitionCount: persisted.transitionCount,
				// Facts are not persisted (transitions + counters only, item 9):
				// restart resumes counting from the persisted counter; the ring
				// rebuilds from new facts.
				facts: [],
			});
		}
	}
}

/**
 * Shape gate for scope keys adopted from the artifact (PRR-005): real keys
 * are hex refs, u/store/identity namespace segments, and model::provider
 * identities — all within a conservative safe alphabet. Anything else
 * (markup, ANSI escapes, quotes, over-long) is rejected rather than rendered.
 */
function isAdoptableScopeKey(key: string): boolean {
	if (typeof key !== 'string' || key.length === 0 || key.length > 200) {
		return false;
	}
	return /^[-0-9a-zA-Z:_.\u002f]+$/.test(key);
}

function isFiniteCounter(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

// ── Producer feed 1: headroom dead streak ──────────────────────────────────

/**
 * Observe one context-budget evaluation. `dead` = usagePercent ≥ 1.0
 * (zero/negative effective headroom). The alarm raises after
 * {@link LEARNING_HEALTH_ALARM_CONFIG.headroom_dead_streak.raiseFacts} distinct
 * dead observations in the window and recovers on a healthy observation below
 * the warn threshold. Attribution, not suppression: the payload always carries
 * `limit_source` and `denominator_fallback` so an operator can tell real
 * exhaustion from a stale static-table denominator — the "fallback hides
 * dead-headroom loops" defect this alarm exists to surface.
 */
export function observeContextHeadroom(input: {
	sessionID: string;
	/** Project directory when the producer knows it (threaded from the plugin
	 * wiring at handler construction); the chat-transform input itself carries
	 * none. Scopes key by `<projectRef>/<sessionRef>` when present. */
	directory?: string;
	usagePercent: number;
	limit: number;
	limitSource: string;
	warnThreshold: number;
}): void {
	try {
		ensureLearningHealth();
		const now = _internals.now();
		const scopeKey = sessionScopeKey(input.directory, input.sessionID);
		const scope = ensureScope('headroom_dead_streak', scopeKey, now);
		const config = LEARNING_HEALTH_ALARM_CONFIG.headroom_dead_streak;
		const dead =
			Number.isFinite(input.usagePercent) && input.usagePercent >= 1.0;
		const healthy =
			Number.isFinite(input.usagePercent) &&
			input.usagePercent < input.warnThreshold;
		const kind = dead ? 'dead' : healthy ? 'healthy' : 'warm';
		appendFact(scope, kind, now, config.windowMs);
		const deadFacts = countFacts(scope, 'dead');
		const denominatorFallback =
			input.limitSource === 'provider_cap' ||
			input.limitSource === 'native' ||
			input.limitSource === 'fallback';
		const detail: AlarmEmitDetail = {
			limitSource: input.limitSource,
			denominatorFallback,
		};
		if (deadFacts >= config.raiseFacts) {
			applyAlarmState(
				'headroom_dead_streak',
				'session',
				scopeKey,
				'active',
				config.severity,
				detail,
				input.directory,
				now,
			);
		} else if (healthy) {
			applyAlarmState(
				'headroom_dead_streak',
				'session',
				scopeKey,
				'idle',
				config.severity,
				detail,
				input.directory,
				now,
			);
		}
	} catch {
		// Health observation must never break the chat transform.
	}
}

// ── Producer feed 2: model-limit fallback ──────────────────────────────────

/**
 * Observe one model-limit resolution. Fallback-active when the resolution came
 * from the static tables or the flat default (not host/live, not a user
 * override); recovery when the same identity later resolves from host/override.
 */
export function observeModelLimitResolution(input: {
	modelID?: string;
	providerID?: string;
	/** Project directory when the producer knows it (threaded through
	 * resolveModelLimit); identity scopes key project-prefixed when present. */
	directory?: string;
	resolution: ContextWindowSource;
	/** Which override key class matched (compound/model/default) — the alias
	 * provenance for user-authored limits (issue #2044 item 2). */
	aliasKeyClass?: 'compound' | 'model' | 'default';
	/** True when a user-authored override failed usability validation and was
	 * skipped (never coerced) — surfaced durably, not just as a warning. */
	invalidOverride?: boolean;
}): void {
	try {
		ensureLearningHealth();
		const now = _internals.now();
		// Identity scopes are prefixed for snapshot visibility (#2044 final-critic
		// round 2): project-scoped when the producer knows its directory, else the
		// documented process-global `u/` namespace — never a bare invisible key.
		const identity = input.directory
			? `${projectRef(input.directory)}/identity/${input.modelID || 'unknown'}::${input.providerID || 'unknown'}`
			: `u/identity/${input.modelID || 'unknown'}::${input.providerID || 'unknown'}`;
		const scope = ensureScope('model_limit_fallback', identity, now);
		const config = LEARNING_HEALTH_ALARM_CONFIG.model_limit_fallback;
		const fallback =
			input.resolution === 'static_provider_cap' ||
			input.resolution === 'static_native' ||
			input.resolution === 'static_default';
		appendFact(scope, fallback ? 'fallback' : 'resolved', now, config.windowMs);
		if (input.invalidOverride) {
			appendFact(scope, 'invalid_override', now, config.windowMs);
		}
		const detail: AlarmEmitDetail = {
			model: input.modelID || 'unknown',
			provider: input.providerID || 'unknown',
			// The alias key class rides on the role field (bounded enum).
			role: input.aliasKeyClass,
			reason: input.invalidOverride
				? 'invalid_override_skipped'
				: fallback
					? String(input.resolution)
					: undefined,
		};
		if (fallback || input.invalidOverride) {
			applyAlarmState(
				'model_limit_fallback',
				'identity',
				identity,
				'active',
				config.severity,
				detail,
				input.directory,
				now,
			);
		} else {
			applyAlarmState(
				'model_limit_fallback',
				'identity',
				identity,
				'idle',
				config.severity,
				detail,
				input.directory,
				now,
			);
		}
	} catch {
		// never break limit resolution
	}
}

// ── Producer feed 3: retrieval → receipt → application liveness ───────────

function livenessMap(directory: string): Map<string, LivenessGap> {
	const key = canonicalRootKeyFresh(directory);
	let map = livenessGaps.get(key);
	if (!map) {
		// Evict the directory carrying the LEAST gap evidence (PRR-006):
		// prefer empty maps; among non-empty ones, the fewest open gaps.
		// Evicting a map that holds unresolved gaps loses liveness
		// obligations and could let the next evaluation report a false
		// recovery — so it is the last resort, and bounded.
		if (livenessGaps.size >= MAX_TRACKED_DIRECTORIES) {
			let victim: string | undefined;
			let victimSize = Number.POSITIVE_INFINITY;
			for (const [dir, entry] of livenessGaps) {
				if (entry.size < victimSize) {
					victim = dir;
					victimSize = entry.size;
				}
			}
			if (victim !== undefined) livenessGaps.delete(victim);
		}
		map = new Map();
		livenessGaps.set(key, map);
	}
	return map;
}

function evaluateLiveness(directory: string, now: number): void {
	const config = LEARNING_HEALTH_ALARM_CONFIG.retrieval_outcome_liveness;
	const gaps = livenessMap(directory);
	// Age-out (review F5): a gap whose membership went unclosed for multiple
	// liveness windows is stale evidence, not a live obligation — drop it so
	// orphaned entries can never pin the map at MAX_LIVENESS_GAPS or hold the
	// alarm active indefinitely without re-evaluation.
	const ageOutAt = config.windowMs * 4;
	for (const [key, gap] of gaps) {
		if (now - gap.openedAtMs > ageOutAt) gaps.delete(key);
	}
	const scopeKey = `${projectRef(directory)}/liveness`;
	const _scope = ensureScope('retrieval_outcome_liveness', scopeKey, now);
	let stalled = 0;
	let oldestAgeMs = 0;
	let stalledType:
		| 'membership_to_terminal'
		| 'terminal_to_application'
		| undefined;
	for (const gap of gaps.values()) {
		if (gap.eligibleAtMs > now) continue;
		const age = now - gap.openedAtMs;
		if (age > config.windowMs) {
			stalled += 1;
			if (age > oldestAgeMs) {
				oldestAgeMs = age;
				stalledType = gap.gapType;
			}
		}
	}
	if (stalled > 0) {
		applyAlarmState(
			'retrieval_outcome_liveness',
			'project',
			scopeKey,
			'active',
			config.severity,
			{ reason: 'gap_open', gapType: stalledType },
			directory,
			now,
		);
	} else if (stalled === 0 && _scope.status === 'active') {
		// Recovery mirrors the raise condition exactly (`stalled > 0` ↔
		// `stalled === 0`): an open-but-INELIGIBLE gap (inside the gate's
		// staleness grace) must not pin a previously raised alarm active —
		// it is not stall evidence. If such a gap later becomes stalled, the
		// next evaluation re-raises, cooldown-bounded (PR-comment C5).
		applyAlarmState(
			'retrieval_outcome_liveness',
			'project',
			scopeKey,
			'idle',
			config.severity,
			{},
			directory,
			now,
		);
	}
}

/**
 * Observe one receipt-ledger transition. Called from the ledger's post-lock
 * observation drain where the project directory and the observation record are
 * both in hand. Gap-1: membership committed without a terminal within the
 * window. Gap-2: a terminal with outcome 'applied' without an authoritative
 * application closure — either an `architect_marker`-sourced application
 * outcome or any gate release (the release valve is one-way, so a release MUST
 * count as closure). Gap-2 opens only past the gate's staleness horizon.
 */
export function observeReceiptTransition(input: {
	directory: string;
	kind: string;
	traceId: string;
	receiptOutcome?: string;
	receiptSource?: string;
	/**
	 * OPTIONAL membership commit time for gap-2 staleness anchoring. Intentionally
	 * not populated by the current ledger drain (PRR-008): anchoring gap-2
	 * eligibility to the TERMINAL time (the fallback when absent) is the
	 * conservative bound — it can only delay eligibility, never fire the alarm
	 * before the application gate's own staleness escalation has had its
	 * window. Kept as an explicit input so a future ledger observation can
	 * tighten the anchor without an API change.
	 */
	membershipCommittedAtMs?: number;
	atMs?: number;
}): void {
	try {
		ensureLearningHealth();
		const now = input.atMs ?? _internals.now();
		const config = LEARNING_HEALTH_ALARM_CONFIG.retrieval_outcome_liveness;
		const gaps = livenessMap(input.directory);
		const gapKey1 = `m:${input.traceId}`;
		const gapKey2 = `a:${input.traceId}`;
		switch (input.kind) {
			case 'membership_committed': {
				const existing = gaps.get(gapKey1);
				if (!existing) {
					while (gaps.size >= MAX_LIVENESS_GAPS) {
						const oldest = gaps.keys().next().value;
						if (oldest === undefined) break;
						gaps.delete(oldest);
					}
					gaps.set(gapKey1, {
						gapType: 'membership_to_terminal',
						openedAtMs: now,
						// Gap-1 is eligible immediately.
						eligibleAtMs: now,
					});
				}
				break;
			}
			// `legacy_imported` is deliberately NOT a gap-opener (review F2):
			// the one-shot cutover imports historical memberships WITH their
			// terminals already attached (knowledge-receipt-ledger.ts:1930-1942
			// constructs the terminal from the legacy store), and no
			// `terminal_committed` will ever follow the import batch — treating
			// it as a fresh membership would open gap-1 entries that can never
			// close and would permanently pin the liveness alarm.
			case 'legacy_imported':
				break;
			case 'terminal_committed': {
				gaps.delete(gapKey1);
				if (input.receiptOutcome === 'applied') {
					const committedAt = input.membershipCommittedAtMs ?? now;
					const existing = gaps.get(gapKey2);
					if (!existing) {
						while (gaps.size >= MAX_LIVENESS_GAPS) {
							const oldest = gaps.keys().next().value;
							if (oldest === undefined) break;
							gaps.delete(oldest);
						}
						gaps.set(gapKey2, {
							gapType: 'terminal_to_application',
							openedAtMs: now,
							// Never raise before the application gate's own
							// staleness escalation would have run.
							eligibleAtMs: Math.max(now, committedAt + config.gap2StalenessMs),
						});
					}
				} else {
					// Non-'applied' terminals are their own closure: the delegate
					// reported an explicit non-application outcome.
					gaps.delete(gapKey2);
				}
				break;
			}
			case 'application_marker_committed': {
				// Only the architect-marker source is an authoritative application
				// closure; other sources close via their own kinds below.
				if (input.receiptSource === 'architect_marker') {
					gaps.delete(gapKey2);
				}
				break;
			}
			case 'gate_release_committed':
			case 'phase_closed':
			case 'authorized_transition_committed': {
				gaps.delete(gapKey1);
				gaps.delete(gapKey2);
				break;
			}
			default:
				break;
		}
		evaluateLiveness(input.directory, now);
	} catch {
		// never break the ledger drain
	}
}

// ── Producer feed 4: role participation ────────────────────────────────────

const PARTICIPATION_GAP_TYPES: ReadonlySet<string> = new Set([
	'missing_reviewer',
	'missing_retro',
	'missing_sme',
]);

/**
 * Expected participating roles per gap type (#2044): a participation fact only
 * disproves a gap when the RIGHT role participated — 'coder' activity must not
 * mask a missing reviewer. `missing_retro` accepts the orchestrating roles
 * that author retrospectives; a coder-only phase authored no retro.
 */
const EXPECTED_ROLES_BY_GAP_TYPE: Readonly<Record<string, readonly string[]>> =
	Object.freeze({
		missing_reviewer: Object.freeze(['reviewer']),
		missing_sme: Object.freeze(['sme']),
		missing_retro: Object.freeze(['reviewer', 'architect']),
	});

function normalizeParticipationAgent(agent: string): string {
	// Agents are recorded with any swarm prefix stripped (curator
	// normalizeAgentName semantics); a prefixed 'swarm_reviewer' is still the
	// reviewer role participating.
	const stripped = agent.includes('_')
		? (agent.split('_').pop() ?? agent)
		: agent;
	return stripped.trim().toLowerCase();
}

/**
 * Observe one curator phase-compliance pass. `gaps` carries the compliance
 * observation types counted as participation gaps; `agentsUsed` is the set of
 * roles that DID participate. The structural-zero guard keeps a single review
 * window with no eligible opportunity from ever raising.
 */
export function observeCuratorCompliance(input: {
	directory: string;
	phase?: number;
	gapTypes: readonly string[];
	agentsUsed: readonly string[];
}): void {
	try {
		ensureLearningHealth();
		const now = _internals.now();
		const scopeKey = `${projectRef(input.directory)}/participation`;
		const scope = ensureScope('role_participation', scopeKey, now);
		const config = LEARNING_HEALTH_ALARM_CONFIG.role_participation;
		for (const type of input.gapTypes) {
			if (!PARTICIPATION_GAP_TYPES.has(type)) continue;
			appendFact(scope, `gap:${type}`, now, config.windowMs);
		}
		for (const agent of input.agentsUsed) {
			appendFact(
				scope,
				`participated:${normalizeParticipationAgent(agent)}`,
				now,
				config.windowMs,
			);
		}
		const gapFacts = scope.facts.filter((f) => f.kind.startsWith('gap:'));
		// Latest-signal-wins recovery, role-matched: a participation fact only
		// disproves a gap when the RIGHT role participated (a coder running does
		// not mask a missing reviewer), and only when that participation arrived
		// at or after the most recent gap fact of a type it satisfies.
		let lastGapAtMs = 0;
		const openTypes = new Set<string>();
		for (const fact of scope.facts) {
			if (fact.kind.startsWith('gap:')) {
				lastGapAtMs = Math.max(lastGapAtMs, fact.atMs);
				openTypes.add(fact.kind.slice('gap:'.length));
			}
		}
		const matchingLateParticipation = scope.facts.some((fact) => {
			if (!fact.kind.startsWith('participated:')) return false;
			if (fact.atMs < lastGapAtMs) return false;
			const agent = fact.kind.slice('participated:'.length);
			for (const type of openTypes) {
				const expected = EXPECTED_ROLES_BY_GAP_TYPE[type];
				if (expected?.includes(agent)) return true;
			}
			return false;
		});
		if (gapFacts.length >= config.raiseFacts && !matchingLateParticipation) {
			applyAlarmState(
				'role_participation',
				'project',
				scopeKey,
				'active',
				config.severity,
				{ reason: 'eligible_role_gap', phase: input.phase },
				input.directory,
				now,
			);
		} else if (matchingLateParticipation) {
			applyAlarmState(
				'role_participation',
				'project',
				scopeKey,
				'idle',
				config.severity,
				{},
				input.directory,
				now,
			);
		}
	} catch {
		// never break the curator merge
	}
}

// ── Producer feed 5: promoted fixture share ────────────────────────────────

/**
 * Observe one promotion-evidence record. Classification is closed-vocabulary:
 * field sources are real workflow actors; everything else (overrides, manual
 * and migration imports, administrative releases, unknown) is non-field and
 * `unknown` NEVER counts as field (fail-closed against forged labels).
 */
export function observePromotionEvidence(input: {
	directory: string;
	receiptSource: string | undefined;
}): void {
	try {
		ensureLearningHealth();
		const now = _internals.now();
		const scopeKey = `${projectRef(input.directory)}/fixture-share`;
		const scope = ensureScope('promoted_fixture_share', scopeKey, now);
		const config = LEARNING_HEALTH_ALARM_CONFIG.promoted_fixture_share;
		const source = input.receiptSource ?? 'unknown';
		const isField = FIELD_RECEIPT_SOURCES.has(source);
		appendFact(scope, isField ? 'field' : 'non_field', now, config.windowMs);
		const field = countFacts(scope, 'field');
		const nonField = countFacts(scope, 'non_field');
		const total = field + nonField;
		const share = total > 0 ? nonField / total : 0;
		const detail: AlarmEmitDetail = {
			sharePct: Math.round(share * 100),
			fieldCount: field,
			nonFieldCount: nonField,
		};
		if (total >= config.minEvidence && share >= config.raiseShare) {
			applyAlarmState(
				'promoted_fixture_share',
				'project',
				scopeKey,
				'active',
				config.severity,
				detail,
				input.directory,
				now,
			);
		} else if (total >= config.minEvidence && share < config.clearShare) {
			applyAlarmState(
				'promoted_fixture_share',
				'project',
				scopeKey,
				'idle',
				config.severity,
				detail,
				input.directory,
				now,
			);
		}
	} catch {
		// never break the promotion write
	}
}

// ── Producer feed 6: archive activity mismatch ────────────────────────────

/**
 * Observe one close-archive result. Raises when the archive is empty/invalid
 * while recorded activity predicted content; recovers on the next valid,
 * non-empty archive. Late-arriving activity never retro-raises — the payload
 * records what was known at decision time.
 */
export function observeCloseArchive(input: {
	directory: string;
	archiveValid: boolean;
	archiveEmpty: boolean;
	activityPredictsContent: boolean;
}): void {
	try {
		ensureLearningHealth();
		const now = _internals.now();
		const scopeKey = `${projectRef(input.directory)}/archive`;
		const scope = ensureScope('archive_activity_mismatch', scopeKey, now);
		const config = LEARNING_HEALTH_ALARM_CONFIG.archive_activity_mismatch;
		const mismatch =
			(!input.archiveValid || input.archiveEmpty) &&
			input.activityPredictsContent;
		appendFact(scope, mismatch ? 'mismatch' : 'ok', now, config.windowMs || 1);
		const detail: AlarmEmitDetail = {
			reason: mismatch
				? input.archiveEmpty
					? 'archive_empty_with_activity'
					: 'archive_invalid_with_activity'
				: undefined,
		};
		if (mismatch) {
			applyAlarmState(
				'archive_activity_mismatch',
				'project',
				scopeKey,
				'active',
				config.severity,
				detail,
				input.directory,
				now,
			);
		} else {
			applyAlarmState(
				'archive_activity_mismatch',
				'project',
				scopeKey,
				'idle',
				config.severity,
				{},
				input.directory,
				now,
			);
		}
	} catch {
		// never break the close flow
	}
}

// ── Producer feed 7: recovery ledger pressure ──────────────────────────────

/**
 * Observe one delegation-ledger health collection. Raises at pressure ≥ 0.8
 * (near the 4 MiB recovery bound) or on the compact-overdue / fail-closed
 * bands; clears below 0.7 (hysteresis). `uncertain` surfaces recovery
 * observation failures as closed reason codes.
 */
export function observeDelegationLedgerPressure(input: {
	directory: string;
	pressurePct: number;
	band: string;
	uncertain?: boolean;
}): void {
	try {
		ensureLearningHealth();
		const now = _internals.now();
		const scopeKey = `${projectRef(input.directory)}/ledger`;
		const scope = ensureScope('recovery_ledger_pressure', scopeKey, now);
		const config = LEARNING_HEALTH_ALARM_CONFIG.recovery_ledger_pressure;
		const badBand =
			input.band === 'compact-overdue' || input.band === 'fail-closed';
		const high = badBand || input.pressurePct >= config.raisePct;
		const low =
			!badBand && input.pressurePct < config.clearPct && !input.uncertain;
		appendFact(scope, high ? 'high' : 'ok', now, config.windowMs);
		const detail: AlarmEmitDetail = {
			pressurePct: Math.round(input.pressurePct * 100),
			band: input.band,
			reason: input.uncertain ? 'recovery_observation_uncertain' : undefined,
		};
		if (high) {
			applyAlarmState(
				'recovery_ledger_pressure',
				'project',
				scopeKey,
				'active',
				config.severity,
				detail,
				input.directory,
				now,
			);
		} else if (low) {
			applyAlarmState(
				'recovery_ledger_pressure',
				'project',
				scopeKey,
				'idle',
				config.severity,
				detail,
				input.directory,
				now,
			);
		}
	} catch {
		// never break the health collection
	}
}

// ── Producer feed 8: compaction drop coverage (direct store feeds) ──────

/**
 * Direct, directory-bearing store-health observation (final-critic finding 3):
 * the six audited stores call this at their health-event emit sites, so family
 * 8 is fed from its real producers from the FIRST event — not only after an
 * operator opens a status surface.
 */
export function observeStoreHealth(input: {
	directory: string;
	kind: string;
	payload: Record<string, unknown>;
}): void {
	try {
		observeStoreHealthEvent(input.kind, input.payload, input.directory);
	} catch {
		// never break a store health emit
	}
}

function observeStoreHealthEvent(
	event: string,
	data: Record<string, unknown>,
	directory?: string,
): void {
	ensureLearningHealth();
	if (!STORE_HEALTH_KINDS.has(event as TelemetryEvent)) return;
	const store = STORE_LABEL_BY_KIND[event];
	if (!store) return;
	// Five of the six store-health kinds emit `*_count`-suffixed payload keys;
	// `skill_usage_health` (issue #2038) emits unsuffixed `corrupt` / `dropped`
	// / `accepted` (src/telemetry.ts:999-1012). Read both shapes — the alarm
	// must not be structurally silent for the skill-usage store (review F1).
	const corrupt = Math.max(toCount(data.corrupt_count), toCount(data.corrupt));
	const dropped = Math.max(
		toCount(data.dropped_count),
		toCount(data.dropped),
		toCount(data.dropped_audit_count),
	);
	const retained = toCount(data.retained_count);
	const accepted = Math.max(
		toCount(data.accepted_count),
		toCount(data.accepted),
	);
	const now = _internals.now();
	const scopeKey = directory
		? `${projectRef(directory)}/store/${store}`
		: `store/${store}`;
	const scope = ensureScope('compaction_drop_coverage', scopeKey, now);
	const config = LEARNING_HEALTH_ALARM_CONFIG.compaction_drop_coverage;
	if (corrupt > 0) {
		appendFact(scope, 'corrupt', now, config.windowMs);
	} else if (dropped >= config.droppedRaise) {
		appendFact(scope, 'dropped', now, config.windowMs);
	} else {
		appendFact(scope, 'clean', now, config.windowMs);
	}
	const corruptFacts = countFacts(scope, 'corrupt');
	const droppedFacts = countFacts(scope, 'dropped');
	const cleanFacts = countFacts(scope, 'clean');
	const detail: AlarmEmitDetail = {
		store,
		dropped,
		corrupt,
		retained,
		accepted,
	};
	// Severity bands with windowed hysteresis (PR-comment C7): the raise
	// severity NEVER regresses while evidence persists — any in-window
	// mass-drop fact keeps the alarm at `critical` even when a newer corrupt
	// fact arrives (corruption is not a downgrade). Recovery happens only
	// when the window contains ONLY clean facts.
	if (corruptFacts >= config.corruptRaise || droppedFacts > 0) {
		applyAlarmState(
			'compaction_drop_coverage',
			'project',
			scopeKey,
			'active',
			droppedFacts > 0 ? 'critical' : 'warning',
			detail,
			directory,
			now,
		);
	} else if (cleanFacts > 0 && corruptFacts === 0 && droppedFacts === 0) {
		applyAlarmState(
			'compaction_drop_coverage',
			'project',
			scopeKey,
			'idle',
			'warning',
			detail,
			directory,
			now,
		);
	}
}

function toCount(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) && value > 0
		? value
		: 0;
}

/**
 * Idempotent no-op registration point (PR #2446 review): family 8 is fed
 * DIRECTLY by all six audited stores via {@link observeStoreHealth}, so no
 * telemetry listener is attached. The historical listener double-fed every
 * store event (direct + listener observed the same emission into two scope
 * namespaces); it was removed. This function remains as the documented
 * registration seam so future feeds have one call site to wire — it performs
 * no work today and never touches the plugin init path.
 */
export function ensureLearningHealth(): void {
	// Intentionally empty — see the doc comment above.
}

/**
 * Test teardown: clear all in-memory health state. Never used in production
 * code paths.
 */
export function resetLearningHealthForTest(): void {
	alarmScopes.clear();
	livenessGaps.clear();
	transitionRing.length = 0;
	lastPersistAtByDirectory.clear();
	recentPersistDirectories.length = 0;
	projectRefCache.clear();
}

// ── Read API for operator surfaces ────────────────────────────────────────

export interface ActiveLearningHealthAlarm {
	alarm: LearningHealthAlarmId;
	severity: LearningHealthSeverity;
	scopeClass: LearningHealthScopeClass;
	scopeRef: string;
	ageMs: number;
	coverageFacts: number;
	transitionCount: number;
}

export interface LearningHealthSnapshot {
	activeAlarms: readonly ActiveLearningHealthAlarm[];
	totalTransitions: number;
	updatedAtMs: number;
}

/**
 * Read learning health for a project: rehydrate any persisted artifact,
 * lazily evaluate window-based alarms (liveness gaps age into raises without a
 * timer), and persist the refreshed state. Fail-open: any error yields an
 * empty snapshot.
 */
export async function readLearningHealth(
	directory: string,
): Promise<LearningHealthSnapshot> {
	ensureLearningHealth();
	try {
		await rehydrateFromArtifact(directory);
		const now = _internals.now();
		evaluateLiveness(directory, now);
		// Directory-scoped snapshot (final-critic finding 1): render only the
		// scopes attributable to THIS project (`<projectRef>/…`) plus the two
		// deliberately process-global namespaces — `u/…` (chat-transform session
		// facts whose hook input carries no directory) and `store/…` (store
		// store events observed without a directory — tests and future feeds).
		// A single host process serves one project, so the global namespaces are
		// the reading project's own facts in practice, and the filter prevents a
		// multi-project process from rendering another project's prefixed scopes.
		const scopeOwner = projectRef(directory);
		const legacyScopeOwner = legacyProjectRef(directory);
		const active: ActiveLearningHealthAlarm[] = [];
		for (const [alarm, scopes] of alarmScopes) {
			for (const [key, scope] of scopes) {
				if (scope.status !== 'active') continue;
				const owned =
					key.startsWith(`${scopeOwner}/`) ||
					key.startsWith(`${legacyScopeOwner}/`) ||
					key.startsWith('u/') ||
					key.startsWith('store/');
				if (!owned) continue;
				active.push({
					alarm,
					severity: scope.severity,
					scopeClass: scopeClassFor(alarm),
					scopeRef: key.split('/').pop() ?? key,
					ageMs: scope.raisedAtMs > 0 ? Math.max(0, now - scope.raisedAtMs) : 0,
					coverageFacts: scope.factCount,
					transitionCount: scope.transitionCount,
				});
			}
		}
		schedulePersist(directory, now, false);
		return {
			activeAlarms: active,
			totalTransitions: transitionRing.length,
			updatedAtMs: now,
		};
	} catch {
		return { activeAlarms: [], totalTransitions: 0, updatedAtMs: 0 };
	}
}

function scopeClassFor(alarm: LearningHealthAlarmId): LearningHealthScopeClass {
	switch (alarm) {
		case 'headroom_dead_streak':
			return 'session';
		case 'model_limit_fallback':
			return 'identity';
		default:
			return 'project';
	}
}

/** All transitions in the bounded ring (newest last). Test/diagnostic accessor. */
export function getLearningHealthTransitions(): readonly PersistedTransition[] {
	return [...transitionRing];
}

/**
 * Tier-0 test exports (writing-tests skill): pure-or-near-pure internals that
 * tests exercise directly. `observeStoreHealthEvent` is the shared core the
 * public `observeStoreHealth` wraps; tests use it to drive family-8 logic
 * without constructing a directory scope.
 */
export const _test_exports = {
	observeStoreHealthEvent,
};
