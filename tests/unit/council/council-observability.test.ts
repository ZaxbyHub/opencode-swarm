/**
 * Council observability emissions (issue #2046 item 9).
 *
 * Drives the REAL `runCouncilAttempt` / `recordUnscopedCouncilAttempt` with a
 * real telemetry stream (`initTelemetry` on a temp project root) and captures
 * emissions through `addTelemetryListener` — no mock.module, no emit stubbing.
 * Asserts: every attempt path emits (including early returns and recovery),
 * accepted projections emit transitions while 'stay' outcomes never do,
 * payloads stay pseudonymous (bounded key set, no paths/names), and the
 * envelope correlation wiring (`councilRoundId` extraction, lifecycle join
 * fields) holds with zero relationship violations.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	_internals,
	type CouncilAttemptEvaluation,
	councilRoundStatePaths,
	recordUnscopedCouncilAttempt,
	runCouncilAttempt,
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

const IDENTITY = 'c'.repeat(64);
const OTHER_IDENTITY = 'd'.repeat(64);

const TASK_SCOPE = {
	kind: 'task' as const,
	taskId: '1.1',
	identityDigest: IDENTITY,
};
const PHASE_SCOPE = {
	kind: 'phase' as const,
	phaseNumber: 2,
	identityDigest: IDENTITY,
};
const FINAL_SCOPE = { kind: 'final' as const, identityDigest: IDENTITY };

let directory: string;
let captured: Array<{ event: string; data: Record<string, unknown> }>;
let listener: TelemetryListener;

function councilEvents(): Array<{
	event: string;
	data: Record<string, unknown>;
}> {
	return captured.filter((entry) => entry.event.startsWith('council_'));
}

function evaluation(
	transition: 'stay' | 'advance' | 'close',
	extra: Partial<CouncilAttemptEvaluation> = {},
): CouncilAttemptEvaluation {
	return {
		disposition: `evaluated_approve`,
		response: { success: true },
		transition,
		gateEffect: transition === 'close' ? 'allowed' : 'none',
		...extra,
	};
}

function attempt(
	evaluate: (round: number) => Promise<CouncilAttemptEvaluation>,
	overrides: Partial<Parameters<typeof runCouncilAttempt>[0]> = {},
): Promise<string> {
	return runCouncilAttempt({
		directory,
		scope: TASK_SCOPE,
		maxRounds: 3,
		sessionID: 'sess-observability-1',
		request: { taskId: '1.1', verdicts: [{ member: 'critic' }] },
		verdictCount: 1,
		members: ['critic'],
		evaluate,
		...overrides,
	});
}

beforeEach(() => {
	directory = realpathSync(mkdtempSync(join(tmpdir(), 'council-obs-')));
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

describe('council_attempt — accepted task attempt', () => {
	test('emits received + finalized attempt events and one close transition', async () => {
		const result = await attempt(async () =>
			evaluation('close', { verdict: 'APPROVE', quorumSize: 3 }),
		);
		expect(JSON.parse(result).success).toBe(true);

		const events = councilEvents();
		expect(events.length).toBe(3);
		expect(events.map((e) => e.event)).toEqual([
			'council_attempt',
			'council_attempt',
			'council_round_transition',
		]);

		const [received, finalized, transition] = events as Array<{
			event: string;
			data: Record<string, unknown>;
		}>;

		expect(received.data.stage).toBe('received');
		expect(received.data.disposition).toBe('received');
		expect(received.data.level).toBe('task');
		expect(received.data.taskId).toBe('1.1');
		expect(received.data.sessionId).toBe('sess-observability-1');
		expect(typeof received.data.councilRoundId).toBe('string');
		expect(String(received.data.councilRoundId).startsWith('task-')).toBe(true);
		expect(received.data.authoritativeRound).toBe(1);
		expect(received.data.memberCount).toBe(1);
		expect(received.data.verdictCount).toBe(1);

		expect(finalized.data.stage).toBe('finalized');
		expect(finalized.data.disposition).toBe('evaluated_approve');
		expect(finalized.data.transition).toBe('close');
		expect(finalized.data.gateEffect).toBe('allowed');
		expect(finalized.data.verdict).toBe('APPROVE');
		expect(finalized.data.quorumSize).toBe(3);
		expect(finalized.data.attemptId).toBe(received.data.attemptId);

		expect(transition.data.transition).toBe('close');
		expect(transition.data.gateEffect).toBe('allowed');
		expect(transition.data.round).toBe(1);
		expect(transition.data.nextRound).toBe(1);
		expect(transition.data.roundStatus).toBe('closed');
		expect(transition.data.maxRoundsExhausted).toBe(false);
		expect(transition.data.councilRoundId).toBe(received.data.councilRoundId);

		// The durable audit carries the same attempt lifecycle.
		const audit = readFileSync(
			councilRoundStatePaths(directory, TASK_SCOPE).audit,
			'utf8',
		)
			.split('\n')
			.filter(Boolean)
			.map((line) => JSON.parse(line) as { event: string });
		expect(audit.map((r) => r.event)).toEqual(['received', 'finalized']);
	});

	test('a blocked advance (blocking concerns) emits an advance transition with gateEffect blocked', async () => {
		await attempt(async () =>
			evaluation('advance', {
				disposition: 'blocking_concerns_unresolved',
				gateEffect: 'blocked',
			}),
		);
		const events = councilEvents();
		expect(events.map((e) => e.event)).toEqual([
			'council_attempt',
			'council_attempt',
			'council_round_transition',
		]);
		const transition = events[2]?.data as Record<string, unknown>;
		expect(transition.transition).toBe('advance');
		expect(transition.gateEffect).toBe('blocked');
		expect(transition.nextRound).toBe(2);
		expect(transition.roundStatus).toBe('open');
	});

	test('advance at the max-rounds ceiling emits a transition with maxRoundsExhausted=true', async () => {
		// maxRounds=1: the first advance cannot increment the round, so the
		// projection flips maxRoundsExhausted instead (transitionState ceiling).
		const result = await attempt(
			async () => evaluation('advance', { gateEffect: 'blocked' }),
			{ maxRounds: 1 },
		);
		expect(JSON.parse(result).maxRoundsExhausted).toBe(true);
		const transition = councilEvents()[2]?.data as Record<string, unknown>;
		expect(transition.transition).toBe('advance');
		expect(transition.nextRound).toBe(1);
		expect(transition.roundStatus).toBe('open');
		expect(transition.maxRoundsExhausted).toBe(true);
	});
});

describe('council_attempt — early-return paths still observed, never transitioned', () => {
	test('stale clientRound: finalized council_round_mismatch, no transition event', async () => {
		// Round 1 closed; a later submission claiming round 7 is stale.
		await attempt(async () => evaluation('close'));
		captured.length = 0;
		const result = await attempt(async () => evaluation('close'), {
			clientRound: 7,
		});
		expect(JSON.parse(result).reason).toBe('council_round_mismatch');

		const events = councilEvents();
		expect(events.map((e) => e.event)).toEqual([
			'council_attempt',
			'council_attempt',
		]);
		const finalized = events[1]?.data as Record<string, unknown>;
		expect(finalized.stage).toBe('finalized');
		expect(finalized.disposition).toBe('council_round_mismatch');
		expect(finalized.clientRound).toBe(7);
		expect(finalized.transition).toBe('stay');
	});

	test('duplicate on a closed scope: finalized duplicate_submission, no transition event', async () => {
		const request = { taskId: '1.1', verdicts: [{ member: 'critic' }] };
		await attempt(async () => evaluation('close'), { request });
		captured.length = 0;
		const result = await attempt(async () => evaluation('close'), { request });
		expect(JSON.parse(result).reason).toBe('duplicate_submission');

		const events = councilEvents();
		expect(events.map((e) => e.event)).toEqual([
			'council_attempt',
			'council_attempt',
		]);
		expect((events[1]?.data as Record<string, unknown>).disposition).toBe(
			'duplicate_submission',
		);
	});

	test('pending-state-write failure: finalized council_pending_state_write_failed observed, no transition', async () => {
		// Fresh directory, so atomicWrite call #1 is the initial state write in
		// loadState and call #2 is the pending-state write we force to fail.
		const originalAtomicWrite = _internals.atomicWrite;
		let calls = 0;
		_internals.atomicWrite = async () => {
			calls++;
			if (calls === 2) throw new Error('pending write boom');
		};
		let result: string;
		try {
			result = await attempt(async () =>
				evaluation('close', { verdict: 'APPROVE', quorumSize: 1 }),
			);
		} finally {
			_internals.atomicWrite = originalAtomicWrite;
		}
		expect(calls).toBeGreaterThanOrEqual(2);
		expect(JSON.parse(result as string).reason).toBe(
			'council_round_state_persistence_failed',
		);

		const events = councilEvents();
		expect(events.map((e) => e.event)).toEqual([
			'council_attempt',
			'council_attempt',
			'council_attempt_unscoped',
		]);
		const finalized = events[1]?.data as Record<string, unknown>;
		expect(finalized.stage).toBe('finalized');
		expect(finalized.disposition).toBe('council_pending_state_write_failed');
		expect(finalized.transition).toBe('stay');
		expect(events.some((e) => e.event === 'council_round_transition')).toBe(
			false,
		);
		const unscoped = events[2]?.data as Record<string, unknown>;
		expect(unscoped.disposition).toBe('council_round_state_persistence_failed');
	});
});

describe('all three levels emit with correct join fields', () => {
	test('phase level carries phase (→ phaseId) and a phase- token', async () => {
		await attempt(async () => evaluation('close'), { scope: PHASE_SCOPE });
		const events = councilEvents();
		expect(events.length).toBe(3);
		const attemptEvent = events[0]?.data as Record<string, unknown>;
		expect(attemptEvent.level).toBe('phase');
		expect(attemptEvent.phase).toBe(2);
		expect(attemptEvent.taskId).toBeUndefined();
		expect(String(attemptEvent.councilRoundId).startsWith('phase-')).toBe(true);
	});

	test('final level carries no taskId/phase and a final- token', async () => {
		await attempt(async () => evaluation('close'), { scope: FINAL_SCOPE });
		const attemptEvent = councilEvents()[0]?.data as Record<string, unknown>;
		expect(attemptEvent.level).toBe('final');
		expect(attemptEvent.taskId).toBeUndefined();
		expect(attemptEvent.phase).toBeUndefined();
		expect(String(attemptEvent.councilRoundId).startsWith('final-')).toBe(true);
	});

	test('plan drift (new identityDigest) derives a NEW councilRoundId — server-authoritative', async () => {
		await attempt(async () => evaluation('close'));
		const firstRoundId = councilEvents()[0]?.data.councilRoundId;
		captured.length = 0;
		await attempt(async () => evaluation('close'), {
			scope: { kind: 'task', taskId: '1.1', identityDigest: OTHER_IDENTITY },
		});
		const secondRoundId = councilEvents()[0]?.data.councilRoundId;
		expect(secondRoundId).toBeDefined();
		expect(firstRoundId).toBeDefined();
		expect(secondRoundId).not.toBe(firstRoundId);
	});
});

describe('council_attempt_unscoped', () => {
	test('pre-validation failure emits level/disposition/fingerprint without round identity', async () => {
		const result = await recordUnscopedCouncilAttempt(
			directory,
			'task',
			'invalid_arguments',
			{ taskId: 7 },
			[{ path: ['taskId'], code: 'invalid_type' }],
			'sess-observability-1',
		);
		expect(result).toBeNull();

		const events = councilEvents();
		expect(events.length).toBe(1);
		const payload = events[0]?.data as Record<string, unknown>;
		expect(events[0]?.event).toBe('council_attempt_unscoped');
		expect(payload.level).toBe('task');
		expect(payload.disposition).toBe('invalid_arguments');
		expect(typeof payload.fingerprint).toBe('string');
		expect(typeof payload.attemptId).toBe('string');
		expect(payload.councilRoundId).toBeUndefined();
		expect(payload.sessionId).toBe('sess-observability-1');
	});
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
		// The failed durability attempt emits no scoped transition.
		expect(
			councilEvents().some((e) => e.event === 'council_round_transition'),
		).toBe(false);
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
		const [recovered, recoveredTransition] = events as Array<{
			event: string;
			data: Record<string, unknown>;
		}>;
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

	test('payload keys stay within the catalogued pseudonymous key set', async () => {
		await attempt(async () =>
			evaluation('close', {
				evidence: {
					reference: '.swarm/council/evidence/privacy-test.json',
					commit: async () => {},
				},
			}),
		);
		const allowed = new Set(KNOWN_TELEMETRY_KEYS.council_attempt);
		for (const entry of councilEvents()) {
			if (entry.event !== 'council_attempt') continue;
			for (const key of Object.keys(entry.data)) {
				expect(allowed.has(key)).toBe(true);
			}
			// Pseudonymous discipline: no paths, no member names, no raw request.
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

describe('observability cannot break the council flow', () => {
	test('council attempts complete normally when telemetry is not initialized', async () => {
		removeTelemetryListener(listener);
		resetTelemetryForTesting();
		const result = await attempt(async () => evaluation('close'));
		expect(JSON.parse(result).success).toBe(true);
		expect(
			existsSync(councilRoundStatePaths(directory, TASK_SCOPE).audit),
		).toBe(true);
		// With the stream closed mid-flight, emit returns early: no listener
		// ran, and nothing threw into the council flow.
		expect(captured.length).toBe(0);
	});
});
