/**
 * Council observability emissions (issue #2046 item 9) — emission paths.
 *
 * Drives the REAL `runCouncilAttempt` / `recordUnscopedCouncilAttempt` with a
 * real telemetry stream (`initTelemetry` on a temp project root) and captures
 * emissions through `addTelemetryListener` — no mock.module, no emit stubbing.
 * This file covers the emission matrix: accepted attempts, transitions, every
 * early-return path, all three levels, and the unscoped stream. Recovery,
 * envelope correlation, privacy key-sets, and the uncertainty path live in
 * `council-observability-contract.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	_internals,
	councilRoundStatePaths,
	recordUnscopedCouncilAttempt,
} from '../../../src/council/council-round-state.js';
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
	FINAL_SCOPE,
	OTHER_IDENTITY,
	PHASE_SCOPE,
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

// Guard against future _internals stubs leaking across tests (sibling council
// test files use the same snapshot/restore pattern).
const internalsOriginals = { ..._internals };

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
	Object.assign(_internals, internalsOriginals);
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

		const [received, finalized, transition] = events;

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

	test('stale clientRound mismatches emit identically at phase and final scopes', async () => {
		// The mismatch check precedes any scope-specific handling, so the same
		// two-event no-transition sequence must hold for every level.
		for (const scope of [PHASE_SCOPE, FINAL_SCOPE]) {
			captured.length = 0;
			const result = await attempt(async () => evaluation('close'), {
				scope,
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
			expect(events.some((e) => e.event === 'council_round_transition')).toBe(
				false,
			);
		}
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
		// Target the pending-state write by its content signature, not its call
		// position: only the pending snapshot carries a "pending" key, so the
		// test proves WHICH durable write failed regardless of call ordering.
		const originalAtomicWrite = _internals.atomicWrite;
		let writes = 0;
		let pendingWriteThrew = false;
		_internals.atomicWrite = async (path: string, content: string) => {
			writes++;
			if (content.includes('"pending"')) {
				pendingWriteThrew = path.includes('round-state');
				throw new Error('pending write boom');
			}
		};
		let result: string;
		try {
			result = await attempt(async () =>
				evaluation('close', { verdict: 'APPROVE', quorumSize: 1 }),
			);
		} finally {
			_internals.atomicWrite = originalAtomicWrite;
		}
		expect(pendingWriteThrew).toBe(true);
		expect(writes).toBeGreaterThanOrEqual(2);
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
