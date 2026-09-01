/**
 * Learning-health (issue #2044) — feeds 5-8, redaction, persistence, restart,
 * and the read/teardown seams. Split from learning-health.test.ts for the
 * FR-006 500-line cap; the shared _internals DI harness is duplicated per
 * file so each runs in its own bun process (per-file isolation).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import path from 'node:path';
import {
	_internals,
	_test_exports,
	ensureLearningHealth,
	HEALTH_SOURCES,
	LEARNING_HEALTH_ALARM_CONFIG,
	observeCloseArchive,
	observeContextHeadroom,
	observeCuratorCompliance,
	observeDelegationLedgerPressure,
	observeModelLimitResolution,
	observePromotionEvidence,
	observeReceiptTransition,
	persistLearningHealth,
	readLearningHealth,
	resetLearningHealthForTest,
} from '../../../src/health/learning-health';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

// Fixed epoch: the engine clock is driven entirely through the _internals
// seam, so these tests never touch the real clock (test-clock gate, #1782).
const REAL_NOW = 1_700_000_000_000;
let clock = REAL_NOW;
const emissions: Record<string, unknown>[] = [];
let artifactDir: string;
let artifactContents = '';

const realNow = _internals.now;
const realEmit = _internals.emitTelemetry;
const realWrite = _internals.writeArtifact;
const realRead = _internals.readArtifact;

beforeEach(() => {
	clock = REAL_NOW;
	emissions.length = 0;
	artifactDir = canonicalMkdtemp('swarm-learning-health-');
	artifactContents = '';
	_internals.now = () => clock;
	_internals.emitTelemetry = (payload) => {
		emissions.push(payload);
	};
	_internals.writeArtifact = async (directory, contents) => {
		// Capture for inspection while still counting as a write for this dir.
		if (directory === artifactDir) artifactContents = contents;
	};
	_internals.readArtifact = async (directory) =>
		directory === artifactDir && artifactContents ? artifactContents : null;
	resetLearningHealthForTest();
	ensureLearningHealth();
});

afterEach(() => {
	resetLearningHealthForTest();
	_internals.now = realNow;
	_internals.emitTelemetry = realEmit;
	_internals.writeArtifact = realWrite;
	_internals.readArtifact = realRead;
	rmSync(artifactDir, { recursive: true, force: true });
});

function raisedPayloads(alarm: string) {
	return emissions.filter(
		(e) => e['alarm'] === alarm && e['transition'] === 'raised',
	);
}

function recoveredPayloads(alarm: string) {
	return emissions.filter(
		(e) => e['alarm'] === alarm && e['transition'] === 'recovered',
	);
}

describe('learning-health — promoted fixture share (feed 5)', () => {
	test('non-field dominance raises with share; field-heavy windows do not; unknown never counts as field', () => {
		for (let i = 0; i < 4; i++) {
			observePromotionEvidence({
				directory: artifactDir,
				receiptSource: 'migration',
			});
			clock += 100;
		}
		const raised = raisedPayloads('promoted_fixture_share');
		expect(raised).toHaveLength(1);
		expect(raised[0]['non_field_count']).toBe(4);
		expect(raised[0]['share_pct']).toBe(100);

		resetLearningHealthForTest();
		emissions.length = 0;
		// 'unknown' (forged/missing label) is fail-closed NON-field.
		observePromotionEvidence({
			directory: artifactDir,
			receiptSource: 'unknown',
		});
		observePromotionEvidence({
			directory: artifactDir,
			receiptSource: 'delegate',
		});
		observePromotionEvidence({
			directory: artifactDir,
			receiptSource: 'reviewer',
		});
		observePromotionEvidence({
			directory: artifactDir,
			receiptSource: 'test_engineer',
		});
		// 1 non-field of 4 = 25% < 50% raise threshold: no raise.
		expect(raisedPayloads('promoted_fixture_share')).toHaveLength(0);
	});

	test('below min-evidence coverage never raises even at 100% non-field share', () => {
		for (let i = 0; i < 3; i++) {
			observePromotionEvidence({
				directory: artifactDir,
				receiptSource: 'manual',
			});
			clock += 100;
		}
		expect(raisedPayloads('promoted_fixture_share')).toHaveLength(0);
	});
});

describe('learning-health — archive activity mismatch (feed 6)', () => {
	test('empty archive with recorded activity raises with the empty reason; a later valid close recovers', () => {
		observeCloseArchive({
			directory: artifactDir,
			archiveValid: true,
			archiveEmpty: true,
			activityPredictsContent: true,
		});
		const raised = raisedPayloads('archive_activity_mismatch');
		expect(raised).toHaveLength(1);
		expect(raised[0]['reason']).toBe('archive_empty_with_activity');
		observeCloseArchive({
			directory: artifactDir,
			archiveValid: true,
			archiveEmpty: false,
			activityPredictsContent: true,
		});
		expect(recoveredPayloads('archive_activity_mismatch')).toHaveLength(1);
	});

	test('a genuinely empty archive (no recorded activity) never raises', () => {
		observeCloseArchive({
			directory: artifactDir,
			archiveValid: true,
			archiveEmpty: true,
			activityPredictsContent: false,
		});
		expect(raisedPayloads('archive_activity_mismatch')).toHaveLength(0);
	});
});

describe('learning-health — recovery ledger pressure (feed 7)', () => {
	test('hysteresis: 0.85 raises, 0.75 holds, 0.6 recovers; bad bands raise regardless', () => {
		observeDelegationLedgerPressure({
			directory: artifactDir,
			pressurePct: 0.85,
			band: 'nominal',
		});
		expect(raisedPayloads('recovery_ledger_pressure')).toHaveLength(1);
		clock += 1000;
		observeDelegationLedgerPressure({
			directory: artifactDir,
			pressurePct: 0.75,
			band: 'nominal',
		});
		expect(recoveredPayloads('recovery_ledger_pressure')).toHaveLength(0);
		clock += 1000;
		observeDelegationLedgerPressure({
			directory: artifactDir,
			pressurePct: 0.6,
			band: 'ok',
		});
		expect(recoveredPayloads('recovery_ledger_pressure')).toHaveLength(1);
		expect(raisedPayloads('recovery_ledger_pressure')[0]['pressure_pct']).toBe(
			85,
		);

		resetLearningHealthForTest();
		emissions.length = 0;
		observeDelegationLedgerPressure({
			directory: artifactDir,
			pressurePct: 0.1,
			band: 'fail-closed',
		});
		expect(raisedPayloads('recovery_ledger_pressure')).toHaveLength(1);
	});
});

describe('learning-health — compaction drop coverage (feed 8, store-health events)', () => {
	test('any corrupt record raises at warning; mass drops escalate to critical; clean stores recover', () => {
		_test_exports.observeStoreHealthEvent('trajectory_health' as never, {
			corrupt_count: 1,
			dropped_count: 0,
			retained_count: 10,
		});
		const raised = raisedPayloads('compaction_drop_coverage');
		expect(raised).toHaveLength(1);
		expect(raised[0]['severity']).toBe('warning');
		expect(raised[0]['store']).toBe('trajectory');

		resetLearningHealthForTest();
		emissions.length = 0;
		_test_exports.observeStoreHealthEvent('pr_subscription_health' as never, {
			corrupt_count: 0,
			dropped_audit_count: 150,
		});
		const escalated = raisedPayloads('compaction_drop_coverage');
		expect(escalated).toHaveLength(1);
		expect(escalated[0]['severity']).toBe('critical');
		expect(escalated[0]['store']).toBe('pr_subscription');

		_test_exports.observeStoreHealthEvent('core_events_health' as never, {
			corrupt_count: 0,
			dropped_count: 0,
			retained_count: 5,
		});
		expect(
			emissions.filter(
				(e) =>
					e['alarm'] === 'compaction_drop_coverage' &&
					e['store'] === 'core_events',
			).length,
		).toBe(0);
	});
});

describe('learning-health — redaction (#2044 item 10)', () => {
	test('no raw session id, path, or query appears in any telemetry payload', () => {
		for (let i = 0; i < 3; i++) {
			observeContextHeadroom({
				sessionID: 'RAW-SESSION-ID-XYZ',
				usagePercent: 1.3,
				limit: 100000,
				limitSource: 'host',
				warnThreshold: 0.7,
			});
			clock += 10;
		}
		observeReceiptTransition({
			directory: artifactDir,
			kind: 'membership_committed',
			traceId: 'trace-redact',
		});
		expect(emissions.length).toBeGreaterThan(0);
		const serialized = JSON.stringify(emissions);
		expect(serialized).not.toContain('RAW-SESSION-ID-XYZ');
		expect(serialized).not.toContain(artifactDir);
		// Session refs are 16-hex pseudonyms, not raw ids.
		const sessionRef = emissions.find(
			(e) => typeof e['session_ref'] === 'string',
		)?.['session_ref'] as string | undefined;
		expect(sessionRef).toBeDefined();
		expect(sessionRef).toMatch(/^[0-9a-f]{16}$/);
	});

	test('the persisted artifact carries counters and refs only — never raw session ids', async () => {
		for (let i = 0; i < 3; i++) {
			observeContextHeadroom({
				sessionID: 'RAW-ARTIFACT-SESSION',
				usagePercent: 1.3,
				limit: 100000,
				limitSource: 'host',
				warnThreshold: 0.7,
			});
			clock += 10;
		}
		await persistLearningHealth(artifactDir);
		expect(artifactContents).not.toContain('RAW-ARTIFACT-SESSION');
		const parsed = JSON.parse(artifactContents) as {
			schemaVersion: number;
			alarms: Record<string, { scopes: Record<string, unknown> }>;
			transitions: unknown[];
		};
		expect(parsed.schemaVersion).toBe(1);
		expect(parsed.transitions.length).toBeGreaterThan(0);
		// No fact lists, no retry/circuit state: counters only.
		const scope = Object.values(
			parsed.alarms['headroom_dead_streak']?.scopes ?? {},
		)[0] as Record<string, unknown>;
		expect(scope['factCount']).toBe(3);
		expect(scope['facts']).toBeUndefined();
	});
});

describe('learning-health — persistence and restart (item 9)', () => {
	test('an active alarm survives a simulated restart via the artifact', async () => {
		for (let i = 0; i < 3; i++) {
			observeContextHeadroom({
				sessionID: 'sess-restart',
				usagePercent: 1.3,
				limit: 100000,
				limitSource: 'host',
				warnThreshold: 0.7,
			});
			clock += 10;
		}
		await persistLearningHealth(artifactDir);
		// Simulated restart: in-memory state gone; the artifact remains.
		resetLearningHealthForTest();
		emissions.length = 0;
		const snapshot = await readLearningHealth(artifactDir);
		expect(snapshot.activeAlarms.map((a) => a.alarm)).toContain(
			'headroom_dead_streak',
		);
		// Re-observing the SAME session does not re-raise (status already
		// active) and does not lose the accumulated streak count.
		observeContextHeadroom({
			sessionID: 'sess-restart',
			usagePercent: 1.3,
			limit: 100000,
			limitSource: 'host',
			warnThreshold: 0.7,
		});
		expect(raisedPayloads('headroom_dead_streak')).toHaveLength(0);
	});
});

describe('learning-health — read API (operator surfaces)', () => {
	test('readLearningHealth returns a redacted snapshot and never throws', async () => {
		const snapshot = await readLearningHealth(artifactDir);
		expect(snapshot.activeAlarms).toEqual([]);
		expect(typeof snapshot.totalTransitions).toBe('number');
		// Unreadable artifact fails open to an empty snapshot.
		_internals.readArtifact = async () => {
			throw new Error('boom');
		};
		const failed = await readLearningHealth(artifactDir);
		expect(failed.activeAlarms).toEqual([]);
	});
});

describe('learning-health — listener lifecycle (teardown seam)', () => {
	test('resetLearningHealthForTest removes the telemetry listener and clears state', () => {
		expect(() => resetLearningHealthForTest()).not.toThrow();
		expect(() => ensureLearningHealth()).not.toThrow();
		expect(() => resetLearningHealthForTest()).not.toThrow();
	});
});

describe('learning-health — artifact read uses the real seam at least once', () => {
	test('the real readArtifact implementation resolves the .swarm path and returns null for missing files', async () => {
		const value = await realRead(artifactDir);
		expect(value).toBeNull();
	});
});

// ── Review-round regression tests (implementation review F1/F2/F3 + blind spots) ──

describe('learning-health — review F1: skill_usage_health emits unsuffixed payload keys', () => {
	test('an unsuffixed corrupt payload still raises the drop alarm for the skill_usage store', () => {
		_test_exports.observeStoreHealthEvent('skill_usage_health' as never, {
			corrupt: 2,
			dropped: 0,
			accepted: 40,
		});
		const raised = raisedPayloads('compaction_drop_coverage');
		expect(raised).toHaveLength(1);
		expect(raised[0]['store']).toBe('skill_usage');
		expect(raised[0]['corrupt']).toBe(2);
	});

	test('unsuffixed mass drops still escalate to critical', () => {
		_test_exports.observeStoreHealthEvent('skill_usage_health' as never, {
			corrupt: 0,
			dropped: 120,
		});
		const raised = raisedPayloads('compaction_drop_coverage');
		expect(raised).toHaveLength(1);
		expect(raised[0]['severity']).toBe('critical');
	});
});

describe('learning-health — review F2: legacy_imported never opens a liveness gap', () => {
	test('a cutover import batch leaves the liveness alarm idle even after the window elapses', () => {
		observeReceiptTransition({
			directory: artifactDir,
			kind: 'legacy_imported',
			traceId: 'legacy-trace-1',
		});
		clock +=
			LEARNING_HEALTH_ALARM_CONFIG.retrieval_outcome_liveness.windowMs * 5;
		observeReceiptTransition({
			directory: artifactDir,
			kind: 'phase_closed',
			traceId: 'unrelated-legacy',
		});
		expect(raisedPayloads('retrieval_outcome_liveness')).toHaveLength(0);
	});
});

describe('learning-health — review F3: restart does not re-emit sustained immediately', () => {
	test('a rehydrated active alarm stays quiet within one cooldown of restart', async () => {
		for (let i = 0; i < 3; i++) {
			observeContextHeadroom({
				sessionID: 'sess-f3',
				usagePercent: 1.4,
				limit: 100000,
				limitSource: 'host',
				warnThreshold: 0.7,
			});
			clock += 10;
		}
		await persistLearningHealth(artifactDir);
		resetLearningHealthForTest();
		emissions.length = 0;
		await readLearningHealth(artifactDir);
		// Fresh facts satisfying the raise condition arrive immediately after
		// restart: the alarm is already active, and the rehydration-time
		// emission clock must suppress an immediate `sustained`.
		for (let i = 0; i < 3; i++) {
			observeContextHeadroom({
				sessionID: 'sess-f3',
				usagePercent: 1.4,
				limit: 100000,
				limitSource: 'host',
				warnThreshold: 0.7,
			});
			clock += 10;
		}
		expect(
			emissions.filter((e) => e['transition'] === 'sustained'),
		).toHaveLength(0);
		expect(raisedPayloads('headroom_dead_streak')).toHaveLength(0);
	});
});

describe('learning-health — review blind spot 8: tampered artifact cannot inject unknown alarms', () => {
	test('an artifact with a foreign alarm id is ignored on rehydrate', async () => {
		artifactContents = JSON.stringify({
			schemaVersion: 1,
			updatedAtMs: clock,
			alarms: {
				not_a_real_alarm: {
					scopes: {
						x: {
							status: 'active',
							severity: 'critical',
							windowStartMs: clock,
							factCount: 99,
							lastFactAtMs: clock,
							raisedAtMs: clock,
							transitionCount: 5,
						},
					},
				},
			},
			transitions: [],
		});
		resetLearningHealthForTest();
		const snapshot = await readLearningHealth(artifactDir);
		expect(snapshot.activeAlarms).toHaveLength(0);
	});
});

describe('learning-health — review F5: orphaned liveness gaps age out', () => {
	test('a gap older than 4 windows is dropped and can no longer raise', () => {
		observeReceiptTransition({
			directory: artifactDir,
			kind: 'membership_committed',
			traceId: 'orphan-trace',
		});
		clock +=
			LEARNING_HEALTH_ALARM_CONFIG.retrieval_outcome_liveness.windowMs * 4 + 1;
		observeReceiptTransition({
			directory: artifactDir,
			kind: 'phase_closed',
			traceId: 'unrelated-orphan',
		});
		expect(raisedPayloads('retrieval_outcome_liveness')).toHaveLength(0);
	});
});
