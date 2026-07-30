/**
 * Tests for the shared advisory-queue push helper (issue #1976).
 *
 * Covers: empty-skip, default full-message dedupe, caller-supplied dedupeKey
 * dedupe, distinct-content passthrough, length cap (keep-latest), and the
 * in-queue dedupe scope (within-turn only — the drain clears each turn).
 */

import { describe, expect, test } from 'bun:test';
import type { AgentSessionState } from '../../../src/state';
import {
	MAX_PENDING_ADVISORIES,
	pushAdvisory,
} from '../../../src/utils/advisory-queue';

function makeSession(): Pick<AgentSessionState, 'pendingAdvisoryMessages'> {
	return { pendingAdvisoryMessages: [] };
}

describe('pushAdvisory', () => {
	describe('empty / whitespace handling', () => {
		test('skips empty string and returns false', () => {
			const session = makeSession();
			expect(pushAdvisory(session, '')).toBe(false);
			expect(session.pendingAdvisoryMessages).toEqual([]);
		});

		test('skips whitespace-only string and returns false', () => {
			const session = makeSession();
			expect(pushAdvisory(session, '   \n\t  ')).toBe(false);
			expect(session.pendingAdvisoryMessages).toEqual([]);
		});

		test('skips nullish message defensively', () => {
			const session = makeSession();
			expect(pushAdvisory(session, undefined as unknown as string)).toBe(false);
			expect(session.pendingAdvisoryMessages).toEqual([]);
		});
	});

	describe('default full-message dedupe', () => {
		test('enqueues a fresh message and returns true', () => {
			const session = makeSession();
			expect(pushAdvisory(session, 'WARNING: something happened')).toBe(true);
			expect(session.pendingAdvisoryMessages).toEqual([
				'WARNING: something happened',
			]);
		});

		test('suppresses a byte-identical duplicate', () => {
			const session = makeSession();
			pushAdvisory(session, 'WARNING: something happened');
			expect(pushAdvisory(session, 'WARNING: something happened')).toBe(false);
			expect(session.pendingAdvisoryMessages).toHaveLength(1);
		});

		test('suppresses a near-identical duplicate differing only by whitespace/case', () => {
			const session = makeSession();
			pushAdvisory(session, 'WARNING:  something   happened');
			expect(pushAdvisory(session, 'warning: something happened\n')).toBe(
				false,
			);
			expect(session.pendingAdvisoryMessages).toHaveLength(1);
		});

		test('enqueues genuinely distinct messages', () => {
			const session = makeSession();
			pushAdvisory(session, 'WARNING: thing A');
			expect(pushAdvisory(session, 'WARNING: thing B')).toBe(true);
			expect(session.pendingAdvisoryMessages).toHaveLength(2);
		});

		test('initializes an undefined queue lazily', () => {
			const session: Pick<AgentSessionState, 'pendingAdvisoryMessages'> = {};
			expect(pushAdvisory(session, 'hello')).toBe(true);
			expect(session.pendingAdvisoryMessages).toEqual(['hello']);
		});
	});

	describe('caller-supplied dedupeKey', () => {
		test('dedupes by key when message embeds volatile fields', () => {
			// Simulates the PRM case: same pattern, different step range in the
			// rendered text, but the stable identity is the pattern+level.
			// By convention (cf. council-advisory.ts `[council:...]` and
			// pr-event-subscribers.ts `[pr-monitor:...]`) the dedupeKey tag is
			// embedded in the message so `m.includes(key)` can match it
			// despite the volatile body.
			const session = makeSession();
			pushAdvisory(
				session,
				'[prm:ping_pong:1] TRAJECTORY ALERT: at steps 1-3',
				{ dedupeKey: 'prm:ping_pong:1' },
			);
			expect(
				pushAdvisory(
					session,
					'[prm:ping_pong:1] TRAJECTORY ALERT: at steps 4-6',
					{ dedupeKey: 'prm:ping_pong:1' },
				),
			).toBe(false);
			expect(session.pendingAdvisoryMessages).toHaveLength(1);
		});

		test('does NOT collapse distinct escalation levels sharing a pattern', () => {
			const session = makeSession();
			pushAdvisory(session, '[prm:ping_pong:1] TRAJECTORY ALERT: L1 guidance', {
				dedupeKey: 'prm:ping_pong:1',
			});
			expect(
				pushAdvisory(
					session,
					'[prm:ping_pong:2] TRAJECTORY ALERT: L2 stronger',
					{ dedupeKey: 'prm:ping_pong:2' },
				),
			).toBe(true);
			expect(session.pendingAdvisoryMessages).toHaveLength(2);
		});

		test('with a key, enqueues identical text that has a distinct key (escalation survives)', () => {
			// When a dedupeKey is supplied it is the AUTHORITATIVE identity.
			// Identical message text with a DIFFERENT key still enqueues — this
			// is what lets PRM escalation (levels share message body but differ
			// by key) survive dedupe.
			const session = makeSession();
			pushAdvisory(session, '[k:1] body', { dedupeKey: 'k:1' });
			expect(pushAdvisory(session, '[k:2] body', { dedupeKey: 'k:2' })).toBe(
				true,
			);
			expect(session.pendingAdvisoryMessages).toHaveLength(2);
		});
	});

	describe('length cap (keep-latest)', () => {
		test('drops the oldest entry when the cap is exceeded', () => {
			const session = makeSession();
			const cap = 3;
			pushAdvisory(session, 'm1', { maxPending: cap });
			pushAdvisory(session, 'm2', { maxPending: cap });
			pushAdvisory(session, 'm3', { maxPending: cap });
			// Queue full; pushing m4 evicts m1 (oldest, front).
			expect(pushAdvisory(session, 'm4', { maxPending: cap })).toBe(true);
			expect(session.pendingAdvisoryMessages).toEqual(['m2', 'm3', 'm4']);
		});

		test('default cap matches MAX_PENDING_ADVISORIES', () => {
			expect(MAX_PENDING_ADVISORIES).toBe(25);
			const session = makeSession();
			for (let i = 0; i < MAX_PENDING_ADVISORIES; i++) {
				pushAdvisory(session, `msg ${i}`);
			}
			expect(session.pendingAdvisoryMessages).toHaveLength(
				MAX_PENDING_ADVISORIES,
			);
			// One more evicts the oldest.
			pushAdvisory(session, 'msg overflow');
			expect(session.pendingAdvisoryMessages).toHaveLength(
				MAX_PENDING_ADVISORIES,
			);
			expect(session.pendingAdvisoryMessages[0]).toBe('msg 1');
			expect(session.pendingAdvisoryMessages.at(-1)).toBe('msg overflow');
		});

		test('clamps maxPending: 0 to 1 (no infinite loop, keeps latest)', () => {
			// Guards against the maxPending<=0 infinite-loop failure mode: the
			// cap is clamped to >= 1 so shift()-on-empty can't hang.
			const session = makeSession();
			expect(pushAdvisory(session, 'only one', { maxPending: 0 })).toBe(true);
			expect(session.pendingAdvisoryMessages).toEqual(['only one']);
			// A second distinct message evicts the first (cap clamped to 1).
			expect(pushAdvisory(session, 'second', { maxPending: 0 })).toBe(true);
			expect(session.pendingAdvisoryMessages).toEqual(['second']);
		});
	});

	describe('dedupe scope (within-turn only)', () => {
		test('after the drain clears the queue, the same message can re-enqueue', () => {
			// Documents the within-turn scope: the drain sets
			// pendingAdvisoryMessages = [] each turn, so this helper cannot
			// provide cross-turn dedupe. Cross-turn repeaters carry their own
			// session-scoped state.
			const session = makeSession();
			pushAdvisory(session, 'repeating advisory');
			expect(pushAdvisory(session, 'repeating advisory')).toBe(false);
			// Simulate drain clearing the queue.
			session.pendingAdvisoryMessages = [];
			expect(pushAdvisory(session, 'repeating advisory')).toBe(true);
		});
	});
});
