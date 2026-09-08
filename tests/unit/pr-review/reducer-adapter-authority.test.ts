import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { reducePrReviewEvent } from '../../../src/pr-review/reducer.js';
import type { PrReviewWorkflowState } from '../../../src/pr-review/types.js';

/**
 * Issue #2512 adapter-authority spec: every declared PrReviewEvent member has
 * a production dispatch site, the wired adapters apply the reducer's returned
 * state, stale results never clear current state, and exact replays are
 * idempotent. This file is the CI guardrail for the wire-or-retire census —
 * declaring a new union member without a production construction site fails
 * the source scan below.
 */

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
const SRC_ROOT = join(REPO_ROOT, 'src');

function listTsFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			out.push(...listTsFiles(full));
		} else if (entry.endsWith('.ts')) {
			out.push(full);
		}
	}
	return out;
}

/** The declared event discriminants from the closed union in types.ts. */
function declaredEventTypes(): string[] {
	const text = readFileSync(join(SRC_ROOT, 'pr-review', 'types.ts'), 'utf-8');
	const start = text.indexOf('export type PrReviewEvent =');
	const end = text.indexOf('\nexport ', start + 1);
	const body = text.slice(start, end > start ? end : undefined);
	return [...body.matchAll(/type: '([a-z0-9_]+)'/g)].map((m) => m[1]!);
}

const GATE = readFileSync(
	join(SRC_ROOT, 'hooks', 'pr-workflow-gate.ts'),
	'utf-8',
);
const DISPATCH_LANES = readFileSync(
	join(SRC_ROOT, 'tools', 'dispatch-lanes.ts'),
	'utf-8',
);

const BASE: PrReviewWorkflowState = {
	sessionID: 'ses_adapter_1',
	workflowInstanceId: 'wfi_adapter',
	revision: 4,
	prHeadSha: 'abc123def',
};

function productionConstructionCount(event: string): number {
	let count = 0;
	for (const file of listTsFiles(SRC_ROOT)) {
		if (file.replace(/\\/g, '/').endsWith('pr-review/types.ts')) continue;
		if (file.replace(/\\/g, '/').endsWith('pr-review/reducer.ts')) continue;
		const text = readFileSync(file, 'utf-8');
		for (const _match of text.matchAll(new RegExp(`type: '${event}'`, 'g'))) {
			count += 1;
		}
	}
	return count;
}

describe('registered-path: every declared event dispatches', () => {
	test('every declared PrReviewEvent member has a production construction site', () => {
		const events = declaredEventTypes();
		expect(events.length).toBeGreaterThanOrEqual(10);
		const unwired: string[] = [];
		for (const event of events) {
			if (productionConstructionCount(event) === 0) unwired.push(event);
		}
		expect(unwired).toEqual([]);
	});

	test('the issue #2512 wiring points dispatch through reducePrReviewEvent', () => {
		expect(GATE).toContain("type: 'base_admission_requested'");
		expect(GATE).toContain("type: 'coverage_finalization_requested'");
		expect(GATE).toContain("type: 'critic_result_recorded'");
		expect(GATE).toContain("type: 'armed_recovery_requested'");
		expect(GATE).toContain("type: 'lane_structured_result_submitted'");
		expect(GATE).toContain("type: 'circuit_advance_requested'");
		expect(GATE).toContain("type: 'resilience_config_changed'");
		expect(GATE).toContain("type: 'base_admission_rolled_back'");
		expect(GATE).toContain("type: 'circuit_probe_settled'");
		expect(DISPATCH_LANES).toContain("type: 'collection_observed'");
	});
});

describe('adapter applies returned state and effects', () => {
	test('admission dispatch writes the batch ledger the adapter persists', () => {
		const result = reducePrReviewEvent(BASE, {
			type: 'base_admission_requested',
			batchId: 'batch-wired',
			lanes: [{ laneId: 'lane-1', workflowLane: 'tests' }],
			depthTier: 'L',
			maxBatches: 128,
			validatedAt: '2026-09-07T00:00:00.000Z',
		});
		expect(result.status).toBe('applied');
		if (result.status !== 'applied') return;
		expect(result.state.prReviewBaseDispatches?.at(-1)?.batchId).toBe(
			'batch-wired',
		);
		expect(result.state.prReviewBaseDispatch?.batchId).toBe('batch-wired');
		// The gate executes this effect via its persistence CAS write
		// (writeStateWhileLocked) — the integration coverage is
		// pr-workflow-gate-base-coverage.test.ts.
		expect(result.effects).toEqual([{ kind: 'persist_state' }]);
	});

	test('armed-recovery dispatch produces the exact cancellation record the executor persists', () => {
		const result = reducePrReviewEvent(BASE, {
			type: 'armed_recovery_requested',
			binding: {
				sessionID: BASE.sessionID,
				workflowInstanceId: BASE.workflowInstanceId,
				prHeadSha: BASE.prHeadSha!,
				revisionDigest: 'digest-1',
				generation: BASE.revision,
			},
			dimensionsToCancel: ['tests'],
			nowIso: '2026-09-07T00:00:00.000Z',
			reason: 'superseded window',
		});
		expect(result.status).toBe('applied');
		if (result.status !== 'applied') return;
		expect(result.state.prReviewDimensionCancellations?.tests).toEqual({
			reason: 'superseded window',
			cancelledAt: '2026-09-07T00:00:00.000Z',
			source: 'armed_recovery',
		});
		// Integration coverage of the persisted record through the real
		// executor (unchanged by the wiring): pr-workflow-armed-recovery.test.ts.
		expect(result.effects).toEqual([{ kind: 'persist_state' }]);
	});

	test('coverage-finalization dispatch returns the state the completion path persists', () => {
		const result = reducePrReviewEvent(BASE, {
			type: 'coverage_finalization_requested',
			settlement: {
				kind: 'PARTIAL',
				coveredDimensions: ['tests'],
				unresolvedDimensions: [
					{ dimension: 'security', terminalState: 'FAILED', reasonKind: 'x' },
				],
				liveDimensions: [],
			},
			requestedVerdict: 'REQUEST_CHANGES',
		});
		expect(result.status).toBe('applied');
		if (result.status !== 'applied') return;
		expect(result.state).toBe(BASE);
		expect(result.effects).toEqual([{ kind: 'persist_state' }]);
	});
});

describe('stale results cannot clear current state', () => {
	test('a stale-generation structured result is rejected without mutation', () => {
		const state: PrReviewWorkflowState = {
			...BASE,
			prReviewDimensionCancellations: {
				tests: {
					reason: 'kept',
					cancelledAt: 't',
					source: 'armed_recovery',
				},
			},
		};
		const result = reducePrReviewEvent(state, {
			type: 'lane_structured_result_submitted',
			batchId: 'b',
			laneId: 'l',
			generation: BASE.revision - 3,
			semanticEnvelopeDigest: 'd',
			outcome: 'CLEAN',
		});
		expect(result.status).toBe('rejected');
		if (result.status !== 'rejected') return;
		// The rejected transition returns the SAME state object — the existing
		// cancellations survive untouched.
		expect(result.state).toBe(state);
	});

	test('a stale-binding armed recovery cannot rewrite current cancellations', () => {
		const state: PrReviewWorkflowState = {
			...BASE,
			prReviewDimensionCancellations: {
				tests: {
					reason: 'kept',
					cancelledAt: 't',
					source: 'armed_recovery',
				},
			},
		};
		const result = reducePrReviewEvent(state, {
			type: 'armed_recovery_requested',
			binding: {
				sessionID: BASE.sessionID,
				workflowInstanceId: BASE.workflowInstanceId,
				prHeadSha: BASE.prHeadSha!,
				generation: BASE.revision - 1,
			},
			dimensionsToCancel: ['tests'],
			nowIso: 'later',
			reason: 'stale attempt',
		});
		expect(result.status).toBe('rejected');
		if (result.status !== 'rejected') return;
		expect(result.state).toBe(state);
		expect(result.state.prReviewDimensionCancellations?.tests?.reason).toBe(
			'kept',
		);
	});

	test('a live-lane finalization is rejected without any state change', () => {
		const result = reducePrReviewEvent(BASE, {
			type: 'coverage_finalization_requested',
			settlement: {
				kind: 'PARTIAL',
				coveredDimensions: ['tests'],
				unresolvedDimensions: [],
				liveDimensions: ['security'],
			},
			requestedVerdict: 'INCOMPLETE',
		});
		expect(result.status).toBe('rejected');
		if (result.status !== 'rejected') return;
		expect(result.rejection.code).toBe('live_lane_blocks_coverage');
		expect(result.state).toBe(BASE);
	});
});

describe('exact replay is idempotent', () => {
	test('an identical structured-result replay settles exactly once (replay effect, no new transition)', () => {
		const first = reducePrReviewEvent(BASE, {
			type: 'lane_structured_result_submitted',
			batchId: 'b-replay',
			laneId: 'l-replay',
			generation: BASE.revision,
			semanticEnvelopeDigest: 'd-replay',
			outcome: 'CLEAN',
		});
		expect(first.status).toBe('applied');
		if (first.status !== 'applied') return;
		expect(first.effects[0]?.replay).toBeUndefined();
		const replay = reducePrReviewEvent(BASE, {
			type: 'lane_structured_result_submitted',
			batchId: 'b-replay',
			laneId: 'l-replay',
			generation: BASE.revision,
			semanticEnvelopeDigest: 'd-replay',
			outcome: 'CLEAN',
			existingReceiptDigest: 'd-replay',
		});
		expect(replay.status).toBe('applied');
		if (replay.status !== 'applied') return;
		expect(replay.effects[0]).toMatchObject({
			replay: true,
			status: 'completed',
		});
	});

	test('an identical armed-recovery re-dispatch writes identical cancellations', () => {
		const dispatch = (state: PrReviewWorkflowState) =>
			reducePrReviewEvent(state, {
				type: 'armed_recovery_requested',
				binding: {
					sessionID: BASE.sessionID,
					workflowInstanceId: BASE.workflowInstanceId,
					prHeadSha: BASE.prHeadSha!,
					generation: state.revision,
				},
				dimensionsToCancel: ['tests'],
				nowIso: '2026-09-07T00:00:00.000Z',
				reason: 'idempotent',
			});
		const first = dispatch(BASE);
		expect(first.status).toBe('applied');
		if (first.status !== 'applied') return;
		const second = dispatch(first.state);
		expect(second.status).toBe('applied');
		if (second.status !== 'applied') return;
		expect(second.state.prReviewDimensionCancellations).toEqual(
			first.state.prReviewDimensionCancellations,
		);
	});

	test('a conflicting replay is rejected, not silently applied', () => {
		const result = reducePrReviewEvent(BASE, {
			type: 'lane_structured_result_submitted',
			batchId: 'b-conflict',
			laneId: 'l-conflict',
			generation: BASE.revision,
			semanticEnvelopeDigest: 'd-new',
			outcome: 'CLEAN',
			existingReceiptDigest: 'd-old',
		});
		expect(result.status).toBe('rejected');
		if (result.status !== 'rejected') return;
		expect(result.rejection.code).toBe('duplicate_conflicting_result');
	});
});
