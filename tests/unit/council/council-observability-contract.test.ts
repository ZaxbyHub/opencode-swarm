/**
 * Council observability emissions (issue #2046 item 9) — contract coherence.
 *
 * Companion to `council-observability.test.ts` (emission matrix). Covers the
 * recovery path's exact event sequences, envelope correlation wiring with
 * zero relationship violations, the pseudonymous key-set discipline for ALL
 * three council kinds, the forbidden-round-identity axis on the unscoped
 * kind, the round-state uncertainty path, and the never-breaks-council-flow
 * guarantee under degraded telemetry.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
	councilRoundStatePaths,
	recordUnscopedCouncilAttempt,
} from '../../../src/council/council-round-state.js';
import { CATALOG_KINDS } from '../../../src/observability/catalog.js';
import { KNOWN_TELEMETRY_KEYS } from '../../../src/observability/legacy.js';
import { createObservation } from '../../../src/observability/observe.js';
import { validateEventRelationships } from '../../../src/observability/relationships.js';
import {
	addTelemetryListener,
	initTelemetry,
	removeTelemetryListener,
	resetTelemetryForTesting,
	type TelemetryListener,
} from '../../../src/telemetry.js';
import {
	type CapturedEvent,
	councilEventsOf,
	evaluation,
	attempt as runAttempt,
	TASK_SCOPE,
} from './council-observability-helpers.js';

let directory: string;
let captured: CapturedEvent[];
let listener: TelemetryListener;

function councilEvents(): CapturedEvent[] {
	return councilEventsOf(captured);
}

function attempt(
	evaluate: Parameters<typeof runAttempt>[1],
	overrides: Parameters<typeof runAttempt>[2] = {},
): Promise<string> {
	return runAttempt(directory, evaluate, overrides);
}

beforeEach(() => {
	directory = realpathSync(mkdtempSync(join(tmpdir(), 'council-obs-c-')));
	initTelemetry(directory);
	captured = [];
	listener = (event, data) => {
		captured.push({ event, data: data as Record<string, unknown> });
	};
	addTelemetryListener(listener);
});

afterEach(() => {
	removeTelemetryListener(listener);
	resetTelemetryForTesting();
	try {
		rmSync(directory, { recursive: true, force: true });
	} catch {
		// best-effort cleanup
	}
});

describe('recovery path', () => {
	test('recovered attempt emits stage recovered and its pending transition', async () => {
		// Attempt 1: pending state is written for an ADVANCE outcome, then the
		// evidence commit throws, so no finalized record exists and the outer
		// catch records an unscoped persistence failure. (A close-pending would
		// close the scope on recovery; advance keeps it open for attempt 2.)
		const first = await attempt(async () =>
			evaluation('advance', {
				disposition: 'blocking_concerns_unresolved',
				gateEffect: 'blocked',
				evidence: {
					reference: '.swarm/council/evidence/recovery-test.json',
					commit: async () => {
						throw new Error('commit boom');
					},
				},
			}),
		);
		expect(JSON.parse(first).reason).toBe(
			'council_round_state_persistence_failed',
		);
		// Pin attempt 1's exact emissions (issue #2046 review follow-up): the
		// accepted submission, then the outer-catch unscoped persistence
		// failure — and never a transition, because no projection advanced.
		expect(councilEvents().map((e) => e.event)).toEqual([
			'council_attempt',
			'council_attempt_unscoped',
		]);
		expect((councilEvents()[0]?.data as Record<string, unknown>).stage).toBe(
			'received',
		);
		expect(
			(councilEvents()[1]?.data as Record<string, unknown>).disposition,
		).toBe('council_round_state_persistence_failed');
		captured.length = 0;

		// Attempt 2: the probe confirms the evidence actually committed, so the
		// pending advance is recovered (round 1 → 2) and the fresh attempt on
		// round 2 can close cleanly.
		const second = await attempt(async () => evaluation('close'), {
			probePendingEvidence: async () => true,
		});
		expect(JSON.parse(second).success).toBe(true);

		const events = councilEvents();
		expect(events.map((e) => e.event)).toEqual([
			'council_attempt',
			'council_round_transition',
			'council_attempt',
			'council_attempt',
			'council_round_transition',
		]);
		const [recovered, recoveredTransition] = events;
		expect(recovered.data.stage).toBe('recovered');
		expect(recovered.data.disposition).toBe('pending_evidence_recovered');
		expect(recovered.data.transition).toBe('advance');
		expect(recovered.data.gateEffect).toBe('blocked');
		expect(recoveredTransition.data.transition).toBe('advance');
		expect(recoveredTransition.data.round).toBe(1);
		expect(recoveredTransition.data.nextRound).toBe(2);
		expect(recoveredTransition.data.roundStatus).toBe('open');
	});
});

describe('correlation wiring and contract coherence', () => {
	test('createObservation extracts councilRoundId + lifecycle join fields with zero violations', async () => {
		await attempt(async () => evaluation('close'));
		const payload = councilEvents()[0]?.data as Record<string, unknown>;
		const event = createObservation('council_attempt', payload);
		expect(event.workflow.councilRoundId).toBe(payload.councilRoundId);
		expect(event.workflow.hostSessionId).toBe('sess-observability-1');
		expect(event.workflow.taskId).toBe('1.1');
		expect(validateEventRelationships(event)).toEqual({ ok: true });

		const transitionPayload = councilEvents()[2]?.data as Record<
			string,
			unknown
		>;
		const transitionEvent = createObservation(
			'council_round_transition',
			transitionPayload,
		);
		expect(transitionEvent.workflow.councilRoundId).toBe(
			transitionPayload.councilRoundId,
		);
		expect(validateEventRelationships(transitionEvent)).toEqual({ ok: true });
	});

	test('unscoped observation passes relationship validation without round identity', async () => {
		await recordUnscopedCouncilAttempt(
			directory,
			'phase',
			'invalid_working_directory',
			{},
			[],
			undefined,
		);
		const payload = councilEvents()[0]?.data as Record<string, unknown>;
		expect(payload.sessionId).toBeUndefined();
		const event = createObservation('council_attempt_unscoped', payload);
		expect(event.workflow.councilRoundId).toBeUndefined();
		expect(validateEventRelationships(event)).toEqual({ ok: true });
	});

	test('a forged councilRoundId on the unscoped kind violates the forbidden axis', () => {
		// PR #2466 review follow-up: pre-validation failures genuinely have no
		// round identity, so the catalog FORBIDS the axis — a present one was
		// manufactured upstream and must be flagged, never silently joined.
		const event = createObservation('council_attempt_unscoped', {
			level: 'task',
			disposition: 'invalid_arguments',
			fingerprint: 'f'.repeat(64),
			attemptId: '1e2d3c4b-5a69-4877-9665-443322110ff0',
			councilRoundId: 'task-forged',
		});
		const verdict = validateEventRelationships(event);
		expect(verdict.ok).toBe(false);
		if (!verdict.ok) {
			expect(verdict.violations).toContain(
				'forbidden_workflow_id_present:councilRoundId',
			);
		}
	});

	test('payload keys stay within catalogued key sets for every council kind', async () => {
		await attempt(async () =>
			evaluation('close', {
				evidence: {
					reference: '.swarm/council/evidence/privacy-test.json',
					commit: async () => {},
				},
			}),
		);
		await recordUnscopedCouncilAttempt(
			directory,
			'task',
			'invalid_arguments',
			{},
			[],
			'sess-observability-1',
		);
		for (const entry of councilEvents()) {
			const allowed = new Set(KNOWN_TELEMETRY_KEYS[entry.event] ?? []);
			expect(allowed.size).toBeGreaterThan(0);
			for (const key of Object.keys(entry.data)) {
				expect(allowed.has(key)).toBe(true);
			}
			// Pseudonymous discipline holds for EVERY kind: no paths, no member
			// names, no raw request content.
			expect(entry.data.evidenceRef).toBeUndefined();
			expect(entry.data.members).toBeUndefined();
			expect(entry.data.request).toBeUndefined();
			expect(entry.data.working_directory).toBeUndefined();
		}
	});

	test('every captured council kind is catalogued', async () => {
		await attempt(async () => evaluation('close'));
		for (const entry of captured) {
			expect(CATALOG_KINDS.includes(entry.event as never)).toBe(true);
		}
	});
});

describe('round-state uncertainty path', () => {
	test('corrupt round state surfaces council_round_state_uncertain unscoped emission', async () => {
		// A corrupt state file makes loadState throw
		// CouncilRoundStateUncertainError, exercising the OTHER branch of the
		// outer-catch ternary (the persistence-failed branch is covered by the
		// pending-state-write test in council-observability.test.ts).
		const statePath = councilRoundStatePaths(directory, TASK_SCOPE).state;
		mkdirSync(dirname(statePath), { recursive: true });
		writeFileSync(statePath, 'not-json', 'utf8');

		const result = await attempt(async () => evaluation('close'));
		expect(JSON.parse(result).reason).toBe('council_round_state_uncertain');

		const events = councilEvents();
		const unscoped = events.find((e) => e.event === 'council_attempt_unscoped');
		expect(unscoped).toBeDefined();
		expect((unscoped?.data as Record<string, unknown>).disposition).toBe(
			'council_round_state_uncertain',
		);
		expect(events.some((e) => e.event === 'council_round_transition')).toBe(
			false,
		);
		// No scoped attempt event: the failure happened before any scoped
		// audit append for this submission.
		expect(
			events.some(
				(e) =>
					e.event === 'council_attempt' &&
					(e.data as Record<string, unknown>).stage === 'received',
			),
		).toBe(false);
	});
});

describe('observability cannot break the council flow', () => {
	test('council attempts complete normally when telemetry is not initialized', async () => {
		// Degrade telemetry BEFORE the attempt: with the stream closed, emit()
		// short-circuits — proving the council flow never depends on
		// observability succeeding (or running at all).
		removeTelemetryListener(listener);
		resetTelemetryForTesting();
		const result = await attempt(async () => evaluation('close'));
		expect(JSON.parse(result).success).toBe(true);
		expect(
			existsSync(councilRoundStatePaths(directory, TASK_SCOPE).audit),
		).toBe(true);
		expect(captured.length).toBe(0);
	});
});
