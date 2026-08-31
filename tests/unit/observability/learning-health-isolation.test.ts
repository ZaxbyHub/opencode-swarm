/**
 * Learning-health (#2044) — final-critic round: project isolation, direct
 * store feed, persistence anchoring, and alias/invalid-override provenance.
 * Split from learning-health.test.ts for the FR-006 500-line cap.
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
	observeStoreHealth,
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
		if (directory.startsWith(artifactDir)) artifactContents = contents;
	};
	_internals.readArtifact = async (directory) =>
		directory.startsWith(artifactDir) && artifactContents
			? artifactContents
			: null;
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

describe('learning-health — directory-scoped headroom isolates identical session ids across projects', () => {
	test('the same session id under two projects raises only in its own project, and snapshots filter by directory', async () => {
		const dirA = path.join(artifactDir, 'project-a');
		const dirB = path.join(artifactDir, 'project-b');
		for (let i = 0; i < 3; i++) {
			observeContextHeadroom({
				sessionID: 'SAME-SESSION-ID',
				directory: dirA,
				usagePercent: 1.4,
				limit: 100000,
				limitSource: 'host',
				warnThreshold: 0.7,
			});
			clock += 10;
		}
		// Project B sees the same session id with healthy usage: no alarm.
		observeContextHeadroom({
			sessionID: 'SAME-SESSION-ID',
			directory: dirB,
			usagePercent: 0.3,
			limit: 100000,
			limitSource: 'host',
			warnThreshold: 0.7,
		});
		expect(raisedPayloads('headroom_dead_streak')).toHaveLength(1);
		const snapshotA = await readLearningHealth(dirA);
		expect(snapshotA.activeAlarms).toHaveLength(1);
		// Reading project B must NOT render project A's alarm.
		const snapshotB = await readLearningHealth(dirB);
		expect(snapshotB.activeAlarms).toHaveLength(0);
	});

	test('headroom facts persist under their owning project directory', async () => {
		const dir = path.join(artifactDir, 'project-persist');
		for (let i = 0; i < 3; i++) {
			observeContextHeadroom({
				sessionID: 'sess-persist',
				directory: dir,
				usagePercent: 1.4,
				limit: 100000,
				limitSource: 'host',
				warnThreshold: 0.7,
			});
			clock += 10;
		}
		expect(artifactContents).toContain('headroom_dead_streak');
		expect(artifactContents).not.toContain('sess-persist');
	});
});

describe('learning-health — direct store-health feed (#2044 critic finding 3)', () => {
	test('observeStoreHealth feeds the alarm from the FIRST store event, before any surface read', () => {
		observeStoreHealth({
			directory: artifactDir,
			kind: 'trajectory_health',
			payload: { corrupt_count: 1, dropped_count: 0 },
		});
		const raised = raisedPayloads('compaction_drop_coverage');
		expect(raised).toHaveLength(1);
		expect(raised[0]['store']).toBe('trajectory');
	});

	test('facts observed without a directory still persist under the most recent known directory', () => {
		observeContextHeadroom({
			sessionID: 'sess-anchor',
			directory: artifactDir,
			usagePercent: 0.3,
			limit: 100000,
			limitSource: 'host',
			warnThreshold: 0.7,
		});
		observeModelLimitResolution({
			modelID: 'fallback-model',
			providerID: 'p',
			resolution: 'static_default',
		});
		expect(raisedPayloads('model_limit_fallback')).toHaveLength(1);
		expect(artifactContents).toContain('model_limit_fallback');
	});
});

describe('learning-health — model-limit invalid overrides surface durably with alias provenance', () => {
	test('an invalidOverride fact raises with the closed reason and the override key class rides along', () => {
		observeModelLimitResolution({
			modelID: 'm1',
			providerID: 'p1',
			resolution: 'user_provider_model',
			aliasKeyClass: 'compound',
			invalidOverride: true,
		});
		const raised = raisedPayloads('model_limit_fallback');
		expect(raised).toHaveLength(1);
		expect(raised[0]['reason']).toBe('invalid_override_skipped');
		expect(raised[0]['role']).toBe('compound');
	});
});

describe('learning-health — model-limit fallback visibility (critic round 2)', () => {
	test('a fallback raised with a directory renders only in that project snapshot; without one it stays in the documented u/ namespace', async () => {
		const dirA = path.join(artifactDir, 'project-ml-a');
		observeModelLimitResolution({
			modelID: 'fb-model',
			providerID: 'fb-provider',
			resolution: 'static_default',
			directory: dirA,
		});
		const snapshotA = await readLearningHealth(dirA);
		expect(snapshotA.activeAlarms.map((a) => a.alarm)).toContain(
			'model_limit_fallback',
		);
		// Another project must NOT render project A's identity-scoped alarm.
		const snapshotB = await readLearningHealth(
			path.join(artifactDir, 'project-ml-b'),
		);
		expect(
			snapshotB.activeAlarms.filter((a) => a.alarm === 'model_limit_fallback'),
		).toHaveLength(0);
		// Directory-less observation: visible everywhere via the u/ namespace.
		resetLearningHealthForTest();
		emissions.length = 0;
		observeModelLimitResolution({
			modelID: 'fb-model-2',
			providerID: 'fb-provider',
			resolution: 'static_native',
		});
		const snapshotC = await readLearningHealth(
			path.join(artifactDir, 'project-ml-c'),
		);
		expect(snapshotC.activeAlarms.map((a) => a.alarm)).toContain(
			'model_limit_fallback',
		);
	});
});

// ── PR-feedback round: validation, negative paths, restart history ──

describe('learning-health — artifact field validation (PRR-005)', () => {
	test('hostile scope keys and severity values are rejected at rehydrate, never rendered', async () => {
		artifactContents = JSON.stringify({
			schemaVersion: 1,
			updatedAtMs: clock,
			alarms: {
				model_limit_fallback: {
					scopes: {
						'x/<img src=x onerror=alert(1)>': {
							status: 'active',
							severity: "critical'; DROP",
							windowStartMs: clock,
							factCount: 1,
							lastFactAtMs: clock,
							raisedAtMs: clock,
							transitionCount: 1,
						},
						'ok/ref-with-ansi-\u001b[31m': {
							status: 'active',
							severity: 'warning',
							windowStartMs: clock,
							factCount: 1,
							lastFactAtMs: clock,
							raisedAtMs: clock,
							transitionCount: 1,
						},
						'u/0123456789abcdef': {
							status: 'active',
							severity: 'critical',
							windowStartMs: clock,
							factCount: 1,
							lastFactAtMs: clock,
							raisedAtMs: clock,
							transitionCount: 1,
						},
					},
				},
			},
			transitions: [],
		});
		resetLearningHealthForTest();
		const snapshot = await readLearningHealth(artifactDir);
		// Only the well-formed key is adopted; both hostile keys are dropped.
		expect(snapshot.activeAlarms).toHaveLength(1);
		const rendered = JSON.stringify(snapshot.activeAlarms);
		expect(rendered).not.toContain('<img');
		expect(rendered).not.toContain('DROP');
		expect(rendered).not.toContain('\u001b');
	});
});

describe('learning-health — malformed-but-parseable artifact (PRR-011)', () => {
	test('wrong-typed scope fields are ignored without crashing', async () => {
		artifactContents = JSON.stringify({
			schemaVersion: 1,
			updatedAtMs: clock,
			alarms: {
				headroom_dead_streak: {
					scopes: {
						'u/bad': {
							status: 'active',
							severity: 'warning',
							windowStartMs: 'not-a-number',
							factCount: -5,
							lastFactAtMs: clock,
							raisedAtMs: clock,
							transitionCount: 1,
						},
					},
				},
			},
			transitions: 'not-an-array',
		});
		resetLearningHealthForTest();
		const snapshot = await readLearningHealth(artifactDir);
		expect(snapshot.activeAlarms).toHaveLength(0);
	});
});

describe('learning-health — negative paths (PRR-011)', () => {
	test('a throwing writeArtifact never escapes persistLearningHealth', async () => {
		const realWrite = _internals.writeArtifact;
		_internals.writeArtifact = async () => {
			throw new Error('disk full');
		};
		try {
			await persistLearningHealth(artifactDir);
			expect(true).toBe(true); // reached without throwing
		} finally {
			_internals.writeArtifact = realWrite;
		}
	});

	test('a throwing emitTelemetry never escapes an observation', () => {
		const realEmit = _internals.emitTelemetry;
		_internals.emitTelemetry = () => {
			throw new Error('telemetry stream broken');
		};
		try {
			expect(() =>
				observeCloseArchive({
					directory: artifactDir,
					archiveValid: true,
					archiveEmpty: true,
					activityPredictsContent: true,
				}),
			).not.toThrow();
		} finally {
			_internals.emitTelemetry = realEmit;
		}
	});
});

describe('learning-health — all six store kinds feed family 8 (PRR-011)', () => {
	test.each([
		['context_telemetry_health', 'context_telemetry'],
		['skill_usage_health', 'skill_usage'],
		['core_events_health', 'core_events'],
		['shell_audit_health', 'shell_audit'],
		['trajectory_health', 'trajectory'],
		['pr_subscription_health', 'pr_subscription'],
	])('%s maps to store %s and raises on corruption', (kind, store) => {
		resetLearningHealthForTest();
		emissions.length = 0;
		observeStoreHealth({
			directory: artifactDir,
			kind,
			payload: { corrupt_count: 1, dropped_count: 0 },
		});
		const raised = raisedPayloads('compaction_drop_coverage');
		expect(raised).toHaveLength(1);
		expect(raised[0]['store']).toBe(store);
	});
});

describe('learning-health — restart seeds the transition ring (PRR-012)', () => {
	test('transitions recorded before a restart remain in the count after it', async () => {
		observeCloseArchive({
			directory: artifactDir,
			archiveValid: true,
			archiveEmpty: true,
			activityPredictsContent: true,
		});
		await persistLearningHealth(artifactDir);
		const persisted = JSON.parse(artifactContents) as {
			transitions: unknown[];
		};
		expect(persisted.transitions.length).toBeGreaterThan(0);
		resetLearningHealthForTest();
		const snapshot = await readLearningHealth(artifactDir);
		expect(snapshot.totalTransitions).toBe(persisted.transitions.length);
	});
});
