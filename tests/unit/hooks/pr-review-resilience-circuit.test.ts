/**
 * Issue #2382 — pure state-machine transitions for the PR-review resilience
 * circuit (CLOSED → OPEN → exactly-one HALF_OPEN probe → CLOSED / re-OPEN).
 * Every contract below is a direct translation of the issue's "Required
 * design" bullet list; the gate wiring tests cover the durable side.
 */
import { describe, expect, test } from 'bun:test';
import {
	advancePrReviewCircuit,
	PR_REVIEW_CIRCUIT_CONTRIBUTOR_LIMIT,
	type PrReviewCircuitRecordV2,
	scanPrReviewCircuitEvidence,
} from '../../../src/hooks/pr-review-resilience-circuit.js';

const NOW = 1_756_000_000_000;
const OPEN_MS = 60_000;

function providerSignal(
	batchId: string,
	laneId: string,
	terminalAtMs = NOW - 1_000,
	providerClass = 'provider.rate_limit',
) {
	return {
		kind: 'provider_terminal' as const,
		providerClass,
		batchId,
		laneId,
		terminalAtMs,
	};
}

function closedRecord(
	overrides: Partial<PrReviewCircuitRecordV2> = {},
): PrReviewCircuitRecordV2 {
	return {
		version: 2,
		state: 'CLOSED',
		generation: 1,
		contributors: [],
		...overrides,
	};
}

function baseInput(overrides: Record<string, unknown> = {}) {
	return {
		nowMs: NOW,
		threshold: 2,
		openDurationMs: OPEN_MS,
		laneSignals: [] as Array<ReturnType<typeof providerSignal>>,
		...overrides,
	};
}

describe('CLOSED state (issue #2382 distinct-lane threshold)', () => {
	test('admits when no provider class reaches the threshold, and persists nothing', () => {
		const result = advancePrReviewCircuit(
			closedRecord(),
			baseInput({ laneSignals: [providerSignal('b1', 'l1')] }),
		);
		expect(result).toEqual({ action: 'admit', changed: false });
	});

	test('opens on two distinct lanes of one provider class, with interval and bounded evidence', () => {
		const result = advancePrReviewCircuit(
			closedRecord(),
			baseInput({
				laneSignals: [
					providerSignal('b1', 'l1', NOW - 2_000),
					providerSignal('b2', 'l2', NOW - 1_000),
				],
			}),
		);
		expect(result.action).toBe('block');
		if (result.action !== 'block' || !result.record) return;
		expect(result.record.state).toBe('OPEN');
		expect(result.record.providerClass).toBe('provider.rate_limit');
		expect(result.record.contributors).toHaveLength(2);
		expect(result.record.openedAt).toBe(new Date(NOW).toISOString());
		expect(result.record.openUntil).toBe(new Date(NOW + OPEN_MS).toISOString());
	});

	test('one consolidated lane owning six dimensions contributes ONE sample and cannot open the threshold of two', () => {
		// The lane is ONE (batchId, laneId) pair; repetition cannot inflate it.
		const result = advancePrReviewCircuit(
			closedRecord(),
			baseInput({
				laneSignals: [
					providerSignal('b1', 'consolidated', NOW - 3_000),
					providerSignal('b1', 'consolidated', NOW - 2_000),
					providerSignal('b1', 'consolidated', NOW - 1_000),
				],
			}),
		);
		expect(result).toEqual({ action: 'admit', changed: false });
	});

	test('repeated collection of one failed lane is idempotent (dedupe by generation/batchId/laneId)', () => {
		const evidence = scanPrReviewCircuitEvidence(
			[
				providerSignal('b1', 'l1', NOW - 3_000),
				providerSignal('b1', 'l1', NOW - 2_000),
				providerSignal('b1', 'l1', NOW - 1_000),
			],
			1,
			undefined,
		);
		expect(evidence.get('provider.rate_limit')).toHaveLength(1);
	});

	test('different provider classes do not correlate', () => {
		const result = advancePrReviewCircuit(
			closedRecord(),
			baseInput({
				laneSignals: [
					providerSignal('b1', 'l1', NOW - 2_000, 'provider.rate_limit'),
					providerSignal('b2', 'l2', NOW - 1_000, 'provider.auth'),
				],
			}),
		);
		expect(result).toEqual({ action: 'admit', changed: false });
	});

	test('evidence at or before the waterline cannot contribute', () => {
		const waterline = NOW - 1_500;
		const result = advancePrReviewCircuit(
			closedRecord({ evidenceWaterline: new Date(waterline).toISOString() }),
			baseInput({
				laneSignals: [
					providerSignal('b1', 'l1', waterline - 1),
					providerSignal('b2', 'l2', waterline - 1),
				],
			}),
		);
		expect(result).toEqual({ action: 'admit', changed: false });
	});

	test('a null current record behaves as CLOSED with no waterline and persists nothing when evidence is absent', () => {
		const result = advancePrReviewCircuit(null, baseInput());
		expect(result).toEqual({ action: 'admit', changed: false });
	});
});

describe('OPEN and HALF_OPEN (exactly-one probe, recovery lifecycle)', () => {
	function openRecord(): PrReviewCircuitRecordV2 {
		return {
			version: 2,
			state: 'OPEN',
			generation: 1,
			providerClass: 'provider.rate_limit',
			contributors: [
				{
					batchId: 'b1',
					laneId: 'l1',
					terminalAt: new Date(NOW - 2_000).toISOString(),
				},
				{
					batchId: 'b2',
					laneId: 'l2',
					terminalAt: new Date(NOW - 1_000).toISOString(),
				},
			],
			openedAt: new Date(NOW - 500).toISOString(),
			openUntil: new Date(NOW + OPEN_MS).toISOString(),
		};
	}

	test('blocks while the open interval has not elapsed', () => {
		const result = advancePrReviewCircuit(
			openRecord(),
			baseInput({ admission: { batchId: 'b3', laneId: 'l3' } }),
		);
		expect(result.action).toBe('block');
		if (result.action === 'block') {
			expect(result.reason).toBe('circuit_open');
			expect(result.changed).toBe(false);
		}
	});

	test('after expiry, exactly one admission becomes the HALF_OPEN probe', () => {
		const expired = {
			...openRecord(),
			openUntil: new Date(NOW - 1).toISOString(),
		};
		const first = advancePrReviewCircuit(
			expired,
			baseInput({ admission: { batchId: 'b3', laneId: 'l3' } }),
		);
		expect(first.action).toBe('admit_as_probe');
		if (first.action !== 'admit_as_probe' || !first.record) return;
		expect(first.record.state).toBe('HALF_OPEN');
		expect(first.record.probe).toEqual({
			batchId: 'b3',
			laneId: 'l3',
			admittedAt: new Date(NOW).toISOString(),
		});
		// A concurrent contender re-reads HALF_OPEN and is blocked — only one
		// probe exists.
		const second = advancePrReviewCircuit(
			first.record,
			baseInput({ admission: { batchId: 'b4', laneId: 'l4' } }),
		);
		expect(second.action).toBe('block');
		if (second.action === 'block')
			expect(second.reason).toBe('probe_in_flight');
		// The recorded probe itself re-admits idempotently (no double marking).
		const repeat = advancePrReviewCircuit(
			first.record,
			baseInput({ admission: { batchId: 'b3', laneId: 'l3' } }),
		);
		expect(repeat).toEqual({ action: 'admit_as_probe', changed: false });
		// Without an admission candidate (e.g. a non-dispatch caller) an expired
		// OPEN still blocks.
		const noAdmission = advancePrReviewCircuit(expired, baseInput());
		expect(noAdmission.action).toBe('block');
	});

	test('probe typed provider failure reopens with a new interval and appends the contributor', () => {
		const halfOpen: PrReviewCircuitRecordV2 = {
			...openRecord(),
			openUntil: new Date(NOW - 1).toISOString(),
			state: 'HALF_OPEN',
			probe: {
				batchId: 'b3',
				laneId: 'l3',
				admittedAt: new Date(NOW - 500).toISOString(),
			},
		};
		const result = advancePrReviewCircuit(
			halfOpen,
			baseInput({
				probeObservation: {
					terminalStatus: 'error',
					signal: providerSignal('b3', 'l3', NOW, 'provider.auth'),
					terminalAtMs: NOW,
				},
			}),
		);
		expect(result.action).toBe('block');
		if (result.action !== 'block' || !result.record) return;
		expect(result.record.state).toBe('OPEN');
		expect(result.record.probe).toBeUndefined();
		expect(result.record.openUntil).toBe(new Date(NOW + OPEN_MS).toISOString());
		expect(
			result.record.contributors.some(
				(entry) => entry.batchId === 'b3' && entry.laneId === 'l3',
			),
		).toBe(true);
		// The original evidence is retained.
		expect(result.record.contributors.length).toBe(3);
	});

	test('probe typed success closes, clears evidence through the waterline, and increments generation', () => {
		const halfOpen: PrReviewCircuitRecordV2 = {
			...openRecord(),
			openUntil: new Date(NOW - 1).toISOString(),
			state: 'HALF_OPEN',
			probe: {
				batchId: 'b3',
				laneId: 'l3',
				admittedAt: new Date(NOW - 500).toISOString(),
			},
		};
		const probeTerminalMs = NOW - 100;
		const result = advancePrReviewCircuit(
			halfOpen,
			baseInput({
				probeObservation: {
					terminalStatus: 'completed',
					signal: null,
					terminalAtMs: probeTerminalMs,
				},
			}),
		);
		expect(result.action).toBe('admit');
		if (result.action !== 'admit' || !result.record) return;
		expect(result.record.state).toBe('CLOSED');
		expect(result.record.generation).toBe(2);
		expect(result.record.contributors).toHaveLength(0);
		expect(result.record.evidenceWaterline).toBe(
			new Date(probeTerminalMs).toISOString(),
		);
		expect(result.record.probe).toBeUndefined();
		expect(result.record.providerClass).toBeUndefined();
		// The cleared evidence can never reopen the fresh generation.
		const after = advancePrReviewCircuit(
			result.record,
			baseInput({
				laneSignals: [
					providerSignal('b1', 'l1', NOW - 2_000),
					providerSignal('b2', 'l2', NOW - 1_000),
				],
			}),
		);
		expect(after).toEqual({ action: 'admit', changed: false });
	});

	test('an ignored probe outcome changes no circuit state beyond the recovery cooldown restart', () => {
		const halfOpen: PrReviewCircuitRecordV2 = {
			...openRecord(),
			openUntil: new Date(NOW - 1).toISOString(),
			state: 'HALF_OPEN',
			probe: {
				batchId: 'b3',
				laneId: 'l3',
				admittedAt: new Date(NOW - 500).toISOString(),
			},
		};
		const result = advancePrReviewCircuit(
			halfOpen,
			baseInput({
				probeObservation: {
					terminalStatus: 'cancelled',
					signal: { kind: 'ignored', reason: 'cancellation' },
					terminalAtMs: NOW,
				},
			}),
		);
		expect(result.action).toBe('block');
		if (result.action !== 'block' || !result.record) return;
		// Still OPEN, same generation, same evidence — the ignored outcome never
		// opened, reopened, or closed anything. The cooldown restarted so the
		// next probe is only eligible after a full interval.
		expect(result.record.state).toBe('OPEN');
		expect(result.record.generation).toBe(1);
		expect(result.record.contributors).toEqual(halfOpen.contributors);
		expect(result.record.evidenceWaterline).toBeUndefined();
		expect(result.record.probe).toBeUndefined();
		expect(result.record.openUntil).toBe(new Date(NOW + OPEN_MS).toISOString());
	});

	test('an in-flight probe blocks new admissions', () => {
		const halfOpen: PrReviewCircuitRecordV2 = {
			...openRecord(),
			state: 'HALF_OPEN',
			probe: {
				batchId: 'b3',
				laneId: 'l3',
				admittedAt: new Date(NOW - 500).toISOString(),
			},
		};
		const result = advancePrReviewCircuit(
			halfOpen,
			baseInput({ admission: { batchId: 'b9', laneId: 'l9' } }),
		);
		expect(result.action).toBe('block');
		if (result.action === 'block')
			expect(result.reason).toBe('probe_in_flight');
	});
});

describe('bounds and eviction', () => {
	test('the contributor ledger evicts deterministically at the bound', () => {
		const contributors = Array.from(
			{ length: PR_REVIEW_CIRCUIT_CONTRIBUTOR_LIMIT },
			(_, index) => ({
				batchId: `batch-${index}`,
				laneId: `lane-${index}`,
				terminalAt: new Date(NOW - 10_000 + index).toISOString(),
			}),
		);
		const halfOpen: PrReviewCircuitRecordV2 = {
			version: 2,
			state: 'HALF_OPEN',
			generation: 1,
			providerClass: 'provider.rate_limit',
			contributors,
			openedAt: new Date(NOW - 20_000).toISOString(),
			openUntil: new Date(NOW - 1).toISOString(),
			probe: {
				batchId: 'probe-batch',
				laneId: 'probe-lane',
				admittedAt: new Date(NOW - 500).toISOString(),
			},
		};
		const result = advancePrReviewCircuit(
			halfOpen,
			baseInput({
				probeObservation: {
					terminalStatus: 'error',
					signal: providerSignal('probe-batch', 'probe-lane', NOW),
					terminalAtMs: NOW,
				},
			}),
		);
		expect(result.action).toBe('block');
		if (result.action !== 'block' || !result.record) return;
		expect(result.record.contributors).toHaveLength(
			PR_REVIEW_CIRCUIT_CONTRIBUTOR_LIMIT,
		);
		// Deterministic FIFO eviction: the oldest contributor is gone, the
		// appended probe contributor is present.
		expect(
			result.record.contributors.some(
				(entry) => entry.batchId === 'batch-0' && entry.laneId === 'lane-0',
			),
		).toBe(false);
		expect(result.record.contributors.at(-1)).toEqual({
			batchId: 'probe-batch',
			laneId: 'probe-lane',
			terminalAt: new Date(NOW).toISOString(),
		});
	});
});
