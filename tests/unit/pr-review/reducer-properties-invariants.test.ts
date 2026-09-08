import { describe, expect, test } from 'bun:test';
import { PR_REVIEW_CIRCUIT_CONTRIBUTOR_LIMIT } from '../../../src/pr-review/circuit.js';
import { reducePrReviewEvent } from '../../../src/pr-review/reducer.js';
import type {
	PrReviewEvent,
	PrReviewWorkflowState,
} from '../../../src/pr-review/types.js';

/** Deterministic PRNG (mulberry32) so sequence failures reproduce exactly. */
function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const POLICY = {
	enabled: true,
	canaryProbeMs: 300_000,
	statusProbeTimeoutMs: 2_000,
	correlatedFailureThreshold: 2,
	maxRetryAttemptsAfterInitial: 2,
	circuitOpenDurationMs: 60_000,
};

const DIAGNOSTICS = [
	'busy',
	'retry',
	'idle_unknown',
	'host_unavailable',
	'probe_error',
	'wait_expired',
] as const;

function generatorEvent(rand: () => number, step: number): PrReviewEvent {
	const pick = <T>(items: readonly T[]): T =>
		items[Math.floor(rand() * items.length)]!;
	const batch = `b${1 + Math.floor(rand() * 3)}`;
	const lane = `l${1 + Math.floor(rand() * 3)}`;
	switch (Math.floor(rand() * 6)) {
		case 0:
			return {
				type: 'base_admission_rolled_back',
				batchId: batch,
				batchDelegationRecordsExist: rand() < 0.5,
			};
		case 1:
			return {
				type: 'collection_observed',
				diagnostic: pick(DIAGNOSTICS),
				pendingLaneIds: [lane],
			};
		case 2:
			return {
				type: 'lane_structured_result_submitted',
				batchId: batch,
				laneId: lane,
				generation: rand() < 0.8 ? 1 : 0,
				semanticEnvelopeDigest: `d${Math.floor(rand() * 3)}`,
				outcome: pick(['CLEAN', 'FINDINGS', 'INCOMPLETE'] as const),
				existingReceiptDigest:
					rand() < 0.5 ? `d${Math.floor(rand() * 3)}` : undefined,
			};
		case 3:
			return {
				type: 'circuit_advance_requested',
				nowMs: step * 10_000,
				laneSignals: [
					{
						kind: 'provider_terminal',
						providerClass: 'anthropic',
						batchId: batch,
						laneId: lane,
						terminalAtMs: step * 10_000,
					},
				],
				policy: POLICY,
			};
		case 4:
			return {
				type: 'circuit_probe_settled',
				outcome: pick([
					{ result: 'typed_success' },
					{ result: 'provider_failure', providerClass: 'anthropic' },
					{ result: 'ignored' },
					{ result: 'rolled_back_admission' },
				] as const),
				nowMs: step * 10_000,
				policy: POLICY,
			};
		default:
			return {
				type: 'resilience_config_changed',
				enabled: rand() < 0.5,
				nowMs: step * 10_000,
			};
	}
}

interface SequenceObservation {
	appliedCount: number;
	rejectedCount: number;
}

function runSequence(seed: number, length: number): SequenceObservation {
	const rand = mulberry32(seed);
	let state: PrReviewWorkflowState = {
		sessionID: 'ses_props',
		workflowInstanceId: 'wfi_props',
		revision: 1,
		prHeadSha: 'head',
		prReviewResilience: { policy: POLICY, attempts: [] },
	};
	const observation: SequenceObservation = {
		appliedCount: 0,
		rejectedCount: 0,
	};
	for (let step = 0; step < length; step++) {
		const event = generatorEvent(rand, step);
		const before = JSON.stringify(state);
		const result = reducePrReviewEvent(state, event);
		if (result.status === 'rejected') {
			// Invariant: a rejected transition NEVER mutates state.
			expect(JSON.stringify(result.state)).toBe(before);
			observation.rejectedCount += 1;
			continue;
		}
		observation.appliedCount += 1;
		if (event.type === 'collection_observed') {
			// Observation events report only a bounded diagnostic.
			expect(JSON.stringify(result.state)).toBe(before);
		}
		const circuit = result.state.prReviewResilience?.circuit;
		if (circuit && 'version' in circuit) {
			expect(circuit.contributors.length).toBeLessThanOrEqual(
				PR_REVIEW_CIRCUIT_CONTRIBUTOR_LIMIT,
			);
			if (circuit.state === 'HALF_OPEN') {
				expect(circuit.probe).toBeDefined();
			}
		}
		expect(
			(result.state.prReviewBaseDispatches ?? []).length,
		).toBeLessThanOrEqual(128);
		state = result.state;
	}
	return observation;
}

describe('reducer sequence invariants (issue #2512 retained-event model)', () => {
	test('100 seeded sequences preserve every invariant at every step', () => {
		let totalApplied = 0;
		let totalRejected = 0;
		for (let seed = 1; seed <= 100; seed++) {
			const observation = runSequence(seed, 40);
			totalApplied += observation.appliedCount;
			totalRejected += observation.rejectedCount;
		}
		// The corpus must exercise both outcomes, not vacuously pass.
		expect(totalApplied).toBeGreaterThan(0);
		expect(totalRejected).toBeGreaterThan(0);
	});

	test('observer diagnostics never terminate lanes across an adversarial sequence', () => {
		let state: PrReviewWorkflowState = {
			sessionID: 'ses_observer',
			revision: 1,
			prReviewResilience: { policy: POLICY, attempts: [] },
		};
		for (const diagnostic of DIAGNOSTICS) {
			const before = JSON.stringify(state);
			const result = reducePrReviewEvent(state, {
				type: 'collection_observed',
				diagnostic,
				pendingLaneIds: ['l1'],
			});
			expect(result.status).toBe('applied');
			if (result.status !== 'applied') continue;
			expect(JSON.stringify(result.state)).toBe(before);
			expect(
				result.effects.every((effect) => effect.kind === 'emit_diagnostic'),
			).toBe(true);
			state = result.state;
		}
	});

	test('duplicate identical submissions settle exactly once (replay, not new transition)', () => {
		const state: PrReviewWorkflowState = {
			sessionID: 'ses_once',
			revision: 2,
		};
		const submission = {
			type: 'lane_structured_result_submitted',
			batchId: 'b1',
			laneId: 'l1',
			generation: 2,
			semanticEnvelopeDigest: 'd1',
			outcome: 'CLEAN',
		} as const;
		const first = reducePrReviewEvent(state, submission);
		expect(first.status).toBe('applied');
		if (first.status === 'applied') {
			expect(first.effects[0]?.replay).toBeUndefined();
		}
		const replay = reducePrReviewEvent(state, {
			...submission,
			existingReceiptDigest: 'd1',
		});
		expect(replay.status).toBe('applied');
		if (replay.status === 'applied') {
			expect(replay.effects[0]).toMatchObject({ replay: true });
		}
	});
});
