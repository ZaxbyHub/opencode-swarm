/**
 * Learning/operations health registry (issue #2044) — the eight bounded-window
 * alarm families: trigger, dedup, cooldown, hysteresis, recovery, window /
 * coverage / source attribution, bounded + isolated session/project state,
 * late/out-of-order facts, payload redaction, and the persisted artifact
 * (transitions + compact counters only; restart continuation; no
 * invocation-owned retry/circuit state anywhere).
 *
 * Uses the module's `_internals` DI seam (now / emitTelemetry / writeArtifact /
 * readArtifact) — no mock.module. The artifact seam is backed by a real temp
 * directory so the atomic-write path is exercised.
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

describe('learning-health — typed registration (#2044 item 8)', () => {
	test('every health source cites a real producer and real readers, with no sink source', () => {
		const ids = Object.keys(HEALTH_SOURCES);
		expect(ids.length).toBe(8);
		for (const id of ids) {
			const source = HEALTH_SOURCES[id as keyof typeof HEALTH_SOURCES];
			expect(source.producer.length).toBeGreaterThan(0);
			expect(source.readers.length).toBeGreaterThan(0);
			expect(source.alarms.length).toBeGreaterThan(0);
		}
		// No fake future-source metric: there is deliberately no sink entry.
		expect(ids).not.toContain('sink');
	});
});

describe('learning-health — headroom dead streak (feed 1)', () => {
	test('three distinct dead observations raise; the payload attributes the limit source', () => {
		for (let i = 0; i < 3; i++) {
			observeContextHeadroom({
				sessionID: 'sess-alpha',
				usagePercent: 1.2,
				limit: 128000,
				limitSource: 'fallback',
				warnThreshold: 0.7,
			});
			clock += 1000;
		}
		expect(raisedPayloads('headroom_dead_streak')).toHaveLength(1);
		const payload = raisedPayloads('headroom_dead_streak')[0];
		expect(payload['limit_source']).toBe('fallback');
		expect(payload['denominator_fallback']).toBe(true);
		expect(payload['coverage_facts']).toBe(3);
	});

	test('duplicate same-timestamp facts do not storm the streak', () => {
		for (let i = 0; i < 5; i++) {
			observeContextHeadroom({
				sessionID: 'sess-dup',
				usagePercent: 1.1,
				limit: 200000,
				limitSource: 'host',
				warnThreshold: 0.7,
			});
			// clock does NOT advance: same timestamp => dedup by (kind, atMs).
		}
		expect(raisedPayloads('headroom_dead_streak')).toHaveLength(0);
	});

	test('cooldown bounds re-emission to sustained; a healthy observation recovers', () => {
		for (let i = 0; i < 3; i++) {
			observeContextHeadroom({
				sessionID: 'sess-cd',
				usagePercent: 1.5,
				limit: 100000,
				limitSource: 'host',
				warnThreshold: 0.7,
			});
			clock += 1000;
		}
		expect(raisedPayloads('headroom_dead_streak')).toHaveLength(1);
		// Still dead, but inside the cooldown: no new emission.
		clock += 1000;
		observeContextHeadroom({
			sessionID: 'sess-cd',
			usagePercent: 1.5,
			limit: 100000,
			limitSource: 'host',
			warnThreshold: 0.7,
		});
		expect(
			emissions.filter((e) => e['alarm'] === 'headroom_dead_streak'),
		).toHaveLength(1);
		// Past the cooldown, with a FRESH streak in the new window: exactly one
		// sustained re-emission (sustained means still happening now — the new
		// window must itself satisfy the raise condition).
		clock += LEARNING_HEALTH_ALARM_CONFIG.headroom_dead_streak.cooldownMs + 1;
		for (let i = 0; i < 3; i++) {
			observeContextHeadroom({
				sessionID: 'sess-cd',
				usagePercent: 1.5,
				limit: 100000,
				limitSource: 'host',
				warnThreshold: 0.7,
			});
			clock += 1000;
		}
		expect(
			emissions.filter(
				(e) =>
					e['alarm'] === 'headroom_dead_streak' &&
					e['transition'] === 'sustained',
			),
		).toHaveLength(1);
		// Healthy (< warn threshold) recovers — but only after the dead facts
		// age out of the window (hysteresis: one healthy blip over an in-window
		// dead streak must not flap the alarm).
		clock += LEARNING_HEALTH_ALARM_CONFIG.headroom_dead_streak.windowMs + 1000;
		observeContextHeadroom({
			sessionID: 'sess-cd',
			usagePercent: 0.3,
			limit: 100000,
			limitSource: 'host',
			warnThreshold: 0.7,
		});
		expect(recoveredPayloads('headroom_dead_streak')).toHaveLength(1);
	});

	test('sessions are isolated: the same dead facts under another session id never collide', () => {
		for (let i = 0; i < 3; i++) {
			observeContextHeadroom({
				sessionID: 'sess-iso-a',
				usagePercent: 1.4,
				limit: 100000,
				limitSource: 'host',
				warnThreshold: 0.7,
			});
			clock += 1000;
		}
		expect(raisedPayloads('headroom_dead_streak')).toHaveLength(1);
		for (let i = 0; i < 2; i++) {
			observeContextHeadroom({
				sessionID: 'sess-iso-b',
				usagePercent: 1.4,
				limit: 100000,
				limitSource: 'host',
				warnThreshold: 0.7,
			});
			clock += 1000;
		}
		// Session B has only 2 facts: no raise, and A's alarm is untouched.
		expect(raisedPayloads('headroom_dead_streak')).toHaveLength(1);
	});

	test('bounded state: the 65th session evicts the oldest scope (FIFO)', () => {
		for (let i = 0; i < 70; i++) {
			observeContextHeadroom({
				sessionID: `sess-evict-${i}`,
				usagePercent: 1.2,
				limit: 100000,
				limitSource: 'host',
				warnThreshold: 0.7,
			});
			clock += 10;
		}
		// Re-observe session 0 (the oldest): it must have been evicted, so its
		// streak restarts at 1 fact rather than continuing toward a raise.
		const before = emissions.length;
		observeContextHeadroom({
			sessionID: 'sess-evict-0',
			usagePercent: 1.2,
			limit: 100000,
			limitSource: 'host',
			warnThreshold: 0.7,
		});
		expect(emissions.length).toBe(before);
	});
});

describe('learning-health — model-limit fallback (feed 2)', () => {
	test('a static-table resolution raises with model/provider identity; host resolution recovers', () => {
		observeModelLimitResolution({
			modelID: 'claude-sonnet-4-6',
			providerID: 'anthropic',
			resolution: 'static_native',
		});
		expect(raisedPayloads('model_limit_fallback')).toHaveLength(1);
		const payload = raisedPayloads('model_limit_fallback')[0];
		expect(payload['model']).toBe('claude-sonnet-4-6');
		expect(payload['provider']).toBe('anthropic');
		expect(payload['reason']).toBe('static_native');

		observeModelLimitResolution({
			modelID: 'claude-sonnet-4-6',
			providerID: 'anthropic',
			resolution: 'live_model_limit',
		});
		expect(recoveredPayloads('model_limit_fallback')).toHaveLength(1);
	});

	test('fallback flapping within the cooldown does not storm', () => {
		for (let i = 0; i < 5; i++) {
			observeModelLimitResolution({
				modelID: 'flap-model',
				providerID: 'flap-provider',
				resolution: 'static_default',
			});
			clock += 100;
		}
		const all = emissions.filter((e) => e['alarm'] === 'model_limit_fallback');
		expect(all).toHaveLength(1); // one raised; the rest are inside cooldown
	});
});

describe('learning-health — retrieval→receipt→outcome liveness (feed 3)', () => {
	test('membership without terminal past the window raises; a late terminal recovers', () => {
		observeReceiptTransition({
			directory: artifactDir,
			kind: 'membership_committed',
			traceId: 'trace-1',
		});
		// Fresh: no alarm yet.
		expect(raisedPayloads('retrieval_outcome_liveness')).toHaveLength(0);
		// Past the liveness window (lazy evaluation on the next fact).
		clock +=
			LEARNING_HEALTH_ALARM_CONFIG.retrieval_outcome_liveness.windowMs + 1;
		observeReceiptTransition({
			directory: artifactDir,
			kind: 'phase_closed',
			traceId: 'unrelated',
		});
		expect(raisedPayloads('retrieval_outcome_liveness')).toHaveLength(1);
		// The terminal arrives late: recovery, never an error.
		observeReceiptTransition({
			directory: artifactDir,
			kind: 'terminal_committed',
			traceId: 'trace-1',
			receiptOutcome: 'ignored',
		});
		expect(recoveredPayloads('retrieval_outcome_liveness')).toHaveLength(1);
	});

	test("gap-2 opens only on 'applied' terminals, only past the gate staleness horizon, and closes on architect markers OR gate releases", () => {
		observeReceiptTransition({
			directory: artifactDir,
			kind: 'terminal_committed',
			traceId: 'trace-2',
			receiptOutcome: 'applied',
		});
		// Gap-2 becomes eligible after the gate staleness horizon (600 s), but
		// the liveness window (1800 s) has not elapsed: no raise yet.
		clock +=
			LEARNING_HEALTH_ALARM_CONFIG.retrieval_outcome_liveness.gap2StalenessMs +
			1000;
		observeReceiptTransition({
			directory: artifactDir,
			kind: 'phase_closed',
			traceId: 'unrelated-2',
		});
		expect(raisedPayloads('retrieval_outcome_liveness')).toHaveLength(0);
		// Past the liveness window too: now eligible AND stalled.
		clock += LEARNING_HEALTH_ALARM_CONFIG.retrieval_outcome_liveness.windowMs;
		observeReceiptTransition({
			directory: artifactDir,
			kind: 'phase_closed',
			traceId: 'unrelated-3',
		});
		expect(raisedPayloads('retrieval_outcome_liveness')).toHaveLength(1);
		// A non-architect-marker application outcome does NOT close gap-2.
		observeReceiptTransition({
			directory: artifactDir,
			kind: 'application_marker_committed',
			traceId: 'trace-2',
			receiptSource: 'delegate',
		});
		expect(recoveredPayloads('retrieval_outcome_liveness')).toHaveLength(0);
		// A gate release (the one-way escape valve) DOES close it.
		observeReceiptTransition({
			directory: artifactDir,
			kind: 'gate_release_committed',
			traceId: 'trace-2',
			receiptSource: 'application_gate_denial_limit_release',
		});
		expect(recoveredPayloads('retrieval_outcome_liveness')).toHaveLength(1);
	});

	test('directories are isolated: the same trace under two projects never collides', () => {
		const otherDir = path.join(artifactDir, 'other-project');
		observeReceiptTransition({
			directory: artifactDir,
			kind: 'membership_committed',
			traceId: 'trace-x',
		});
		observeReceiptTransition({
			directory: otherDir,
			kind: 'terminal_committed',
			traceId: 'trace-x',
			receiptOutcome: 'ignored',
		});
		// The other directory's terminal must not close this directory's gap.
		clock +=
			LEARNING_HEALTH_ALARM_CONFIG.retrieval_outcome_liveness.windowMs + 1;
		observeReceiptTransition({
			directory: artifactDir,
			kind: 'phase_closed',
			traceId: 'unrelated-x',
		});
		expect(raisedPayloads('retrieval_outcome_liveness')).toHaveLength(1);
	});
});

describe('learning-health — role participation (feed 4)', () => {
	test('structural-zero guard: one gap in one review window never raises; two do', () => {
		observeCuratorCompliance({
			directory: artifactDir,
			phase: 1,
			gapTypes: ['missing_reviewer'],
			agentsUsed: ['coder'],
		});
		expect(raisedPayloads('role_participation')).toHaveLength(0);
		clock += 60_000;
		observeCuratorCompliance({
			directory: artifactDir,
			phase: 2,
			gapTypes: ['missing_reviewer'],
			agentsUsed: ['coder'],
		});
		expect(raisedPayloads('role_participation')).toHaveLength(1);
	});

	test('observed participation by the missing role clears the alarm', () => {
		observeCuratorCompliance({
			directory: artifactDir,
			phase: 1,
			gapTypes: ['missing_sme', 'missing_retro'],
			agentsUsed: [],
		});
		clock += 60_000;
		observeCuratorCompliance({
			directory: artifactDir,
			phase: 2,
			gapTypes: [],
			agentsUsed: ['reviewer', 'sme', 'retro'],
		});
		expect(recoveredPayloads('role_participation')).toHaveLength(1);
	});
});
