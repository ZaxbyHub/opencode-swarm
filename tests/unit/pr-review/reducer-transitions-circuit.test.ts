import { describe, expect, test } from 'bun:test';
import { reducePrReviewEvent } from '../../../src/pr-review/reducer.js';
import type {
	PrReviewWorkflowState,
	PrReviewEvent,
} from '../../../src/pr-review/types.js';
import type { PrReviewResiliencePolicyRecord } from '../../../src/pr-review/circuit.js';

const POLICY: PrReviewResiliencePolicyRecord = {
	enabled: true,
	canaryProbeMs: 300_000,
	statusProbeTimeoutMs: 2_000,
	correlatedFailureThreshold: 2,
	maxRetryAttemptsAfterInitial: 2,
	circuitOpenDurationMs: 60_000,
};

function providerTerminal(
	batchId: string,
	laneId: string,
	terminalAtMs = 1_000,
) {
	return {
		kind: 'provider_terminal' as const,
		providerClass: 'anthropic',
		batchId,
		laneId,
		terminalAtMs,
	};
}

describe('reducer: circuit advance (delegates to the pure machine)', () => {
	test('two distinct terminal provider lanes OPEN the circuit and block dispatch', () => {
		const state: PrReviewWorkflowState = {
			sessionID: 's',
			revision: 1,
			prReviewResilience: { policy: POLICY, attempts: [] },
		};
		const result = reducePrReviewEvent(state, {
			type: 'circuit_advance_requested',
			nowMs: 5_000,
			laneSignals: [providerTerminal('b1', 'l1'), providerTerminal('b2', 'l2')],
			policy: POLICY,
		});
		expect(result.status).toBe('applied');
		if (result.status !== 'applied') return;
		const circuit = result.state.prReviewResilience?.circuit;
		expect(circuit && 'version' in circuit ? circuit.state : null).toBe('OPEN');
		expect(result.effects).toContainEqual({
			kind: 'block_dispatch',
			reason: 'circuit_open',
		});
		expect(result.effects).toContainEqual({ kind: 'persist_state' });
	});

	test('one failed lane owning six dimensions contributes ONE sample (threshold 2 not met)', () => {
		const state: PrReviewWorkflowState = {
			sessionID: 's',
			revision: 1,
			prReviewResilience: { policy: POLICY, attempts: [] },
		};
		const result = reducePrReviewEvent(state, {
			type: 'circuit_advance_requested',
			nowMs: 5_000,
			laneSignals: [providerTerminal('b1', 'l1')],
			policy: POLICY,
		});
		expect(result.status).toBe('applied');
		if (result.status !== 'applied') return;
		expect(result.effects).not.toContainEqual({
			kind: 'block_dispatch',
			reason: 'circuit_open',
		});
	});

	test('repeated observation of one failed lane is idempotent (one sample)', () => {
		const state: PrReviewWorkflowState = {
			sessionID: 's',
			revision: 1,
			prReviewResilience: { policy: POLICY, attempts: [] },
		};
		const signals = [
			providerTerminal('b1', 'l1', 1_000),
			providerTerminal('b1', 'l1', 2_000),
			providerTerminal('b1', 'l1', 3_000),
		];
		const result = reducePrReviewEvent(state, {
			type: 'circuit_advance_requested',
			nowMs: 5_000,
			laneSignals: signals,
			policy: POLICY,
		});
		expect(result.status).toBe('applied');
		if (result.status !== 'applied') return;
		expect(result.effects).not.toContainEqual({
			kind: 'block_dispatch',
			reason: 'circuit_open',
		});
	});

	test('ignored signals never open the circuit', () => {
		const state: PrReviewWorkflowState = {
			sessionID: 's',
			revision: 1,
			prReviewResilience: { policy: POLICY, attempts: [] },
		};
		const result = reducePrReviewEvent(state, {
			type: 'circuit_advance_requested',
			nowMs: 5_000,
			laneSignals: [
				{ kind: 'ignored', reason: 'observer_deadline' },
				{ kind: 'ignored', reason: 'parser' },
				{ kind: 'ignored', reason: 'stale_observation' },
				{ kind: 'ignored', reason: 'cancellation' },
			],
			policy: POLICY,
		});
		expect(result.status).toBe('applied');
		if (result.status !== 'applied') return;
		expect(result.effects).not.toContainEqual({
			kind: 'block_dispatch',
			reason: 'circuit_open',
		});
	});

	test('an expired OPEN circuit admits exactly one HALF_OPEN probe', () => {
		const state: PrReviewWorkflowState = {
			sessionID: 's',
			revision: 1,
			prReviewResilience: {
				policy: POLICY,
				attempts: [],
				circuit: {
					version: 2,
					state: 'OPEN',
					generation: 1,
					contributors: [],
					openedAt: '2026-09-01T00:00:00.000Z',
					openUntil: '2026-09-01T00:01:00.000Z',
				},
			},
		};
		const advance: PrReviewEvent = {
			type: 'circuit_advance_requested',
			nowMs: Date.parse('2026-09-01T00:02:00.000Z'),
			laneSignals: [],
			policy: POLICY,
			admission: { batchId: 'b-probe', laneId: 'l-probe' },
		};
		const result = reducePrReviewEvent(state, advance);
		expect(result.status).toBe('applied');
		if (result.status !== 'applied') return;
		const circuit = result.state.prReviewResilience?.circuit;
		expect(
			circuit && 'version' in circuit && circuit.state === 'HALF_OPEN'
				? circuit.probe
				: null,
		).toMatchObject({ batchId: 'b-probe', laneId: 'l-probe' });
		// mark-on-success: the probe record persists WITH the admission write.
		expect(result.effects).not.toContainEqual({ kind: 'persist_state' });
	});
});

describe('reducer: resilience config transitions (live disable / clean re-enable)', () => {
	test('live disable marks the persisted policy disabled with an audit event', () => {
		const state: PrReviewWorkflowState = {
			sessionID: 's',
			revision: 1,
			prReviewResilience: {
				policy: { ...POLICY, enabled: true },
				attempts: [],
			},
		};
		const result = reducePrReviewEvent(state, {
			type: 'resilience_config_changed',
			enabled: false,
			nowMs: 1_000,
		});
		expect(result.status).toBe('applied');
		if (result.status !== 'applied') return;
		expect(result.state.prReviewResilience?.policy.enabled).toBe(false);
		expect(result.effects).toContainEqual({
			kind: 'append_audit_event',
			code: 'resilience_disabled',
		});
	});

	test('disable is idempotent (already disabled = no new write)', () => {
		const state: PrReviewWorkflowState = {
			sessionID: 's',
			revision: 1,
			prReviewResilience: {
				policy: { ...POLICY, enabled: false },
				attempts: [],
			},
		};
		const result = reducePrReviewEvent(state, {
			type: 'resilience_config_changed',
			enabled: false,
			nowMs: 1_000,
		});
		expect(result.status).toBe('applied');
		if (result.status !== 'applied') return;
		expect(result.effects).toEqual([]);
	});

	test('re-enable resets to a fresh waterlined CLOSED generation (evidence cannot resurrect)', () => {
		const state: PrReviewWorkflowState = {
			sessionID: 's',
			revision: 1,
			prReviewResilience: {
				policy: { ...POLICY, enabled: false },
				attempts: [{ attempt: 0 }],
				circuit: {
					version: 2,
					state: 'OPEN',
					generation: 3,
					contributors: [
						{
							batchId: 'b1',
							laneId: 'l1',
							terminalAt: '2026-09-01T00:00:00.000Z',
						},
					],
					openedAt: '2026-09-01T00:00:00.000Z',
				},
			},
		};
		const result = reducePrReviewEvent(state, {
			type: 'resilience_config_changed',
			enabled: true,
			policy: { enabled: true, correlated_failure_threshold: 2 },
			nowMs: 10_000,
		});
		expect(result.status).toBe('applied');
		if (result.status !== 'applied') return;
		const resilience = result.state.prReviewResilience;
		const circuit = resilience?.circuit;
		expect(circuit && 'version' in circuit ? circuit : null).toMatchObject({
			state: 'CLOSED',
			generation: 4,
			contributors: [],
		});
		expect(
			circuit && 'version' in circuit ? circuit.evidenceWaterline : null,
		).toBe('1970-01-01T00:00:10.000Z');
		expect(resilience?.attempts).toEqual([]);
		expect(result.effects).toContainEqual({
			kind: 'clear_resilience_evidence',
		});
	});
});

describe('reducer: probe settlement', () => {
	test('a rolled-back admission ends the probe lifecycle OPEN with a restarted cooldown', () => {
		const state: PrReviewWorkflowState = {
			sessionID: 's',
			revision: 1,
			prReviewResilience: {
				policy: POLICY,
				attempts: [],
				circuit: {
					version: 2,
					state: 'HALF_OPEN',
					generation: 2,
					contributors: [],
					probe: {
						batchId: 'b-probe',
						laneId: 'l-probe',
						admittedAt: '2026-09-01T00:00:00.000Z',
					},
				},
			},
		};
		const result = reducePrReviewEvent(state, {
			type: 'circuit_probe_settled',
			outcome: { result: 'rolled_back_admission' },
			nowMs: Date.parse('2026-09-01T00:00:30.000Z'),
			policy: POLICY,
		});
		expect(result.status).toBe('applied');
		if (result.status !== 'applied') return;
		const circuit = result.state.prReviewResilience?.circuit;
		expect(circuit && 'version' in circuit ? circuit : null).toMatchObject({
			state: 'OPEN',
			generation: 2,
			openUntil: '2026-09-01T00:01:30.000Z',
		});
	});
});
