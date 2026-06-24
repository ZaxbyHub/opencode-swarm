import { describe, expect, test } from 'bun:test';
import { DEFAULT_DECAY_HALF_LIFE_DAYS } from '../../../src/memory/config';
import {
	computeDecayExpiry,
	isPastDecayHorizon,
} from '../../../src/memory/decay';

const DAY = 24 * 60 * 60 * 1000;

function rec(kind: string, createdDaysAgo: number, expiresAt?: string) {
	const created = new Date(Date.now() - createdDaysAgo * DAY).toISOString();
	return {
		kind: kind as never,
		createdAt: created,
		expiresAt,
	};
}

describe('computeDecayExpiry', () => {
	test('sets expiry at createdAt + half-life for a decaying kind (todo: 30d)', () => {
		const created = new Date('2026-01-01T00:00:00.000Z').toISOString();
		const next = computeDecayExpiry(
			{ kind: 'todo', createdAt: created },
			DEFAULT_DECAY_HALF_LIFE_DAYS,
		);
		expect(next).toBe(new Date('2026-01-31T00:00:00.000Z').toISOString());
	});

	test('no-decay kinds (half-life 0) return undefined', () => {
		for (const kind of [
			'project_fact',
			'architecture_decision',
			'repo_convention',
			'security_note',
			'user_preference',
		]) {
			expect(
				computeDecayExpiry(rec(kind, 400), DEFAULT_DECAY_HALF_LIFE_DAYS),
			).toBeUndefined();
		}
	});

	test('scratch is never re-decayed here', () => {
		expect(
			computeDecayExpiry(rec('scratch', 1), DEFAULT_DECAY_HALF_LIFE_DAYS),
		).toBeUndefined();
	});

	test('never shortens an existing earlier expiry', () => {
		const created = new Date('2026-01-01T00:00:00.000Z').toISOString();
		const earlier = new Date('2026-01-10T00:00:00.000Z').toISOString(); // before +30d
		expect(
			computeDecayExpiry(
				{ kind: 'todo', createdAt: created, expiresAt: earlier },
				DEFAULT_DECAY_HALF_LIFE_DAYS,
			),
		).toBeUndefined();
	});

	test('applies decay horizon when existing expiry is later than the horizon', () => {
		const created = new Date('2026-01-01T00:00:00.000Z').toISOString();
		const later = new Date('2027-01-01T00:00:00.000Z').toISOString();
		expect(
			computeDecayExpiry(
				{ kind: 'todo', createdAt: created, expiresAt: later },
				DEFAULT_DECAY_HALF_LIFE_DAYS,
			),
		).toBe(new Date('2026-01-31T00:00:00.000Z').toISOString());
	});

	test('no-op when expiry already equals the computed horizon', () => {
		const created = new Date('2026-01-01T00:00:00.000Z').toISOString();
		const horizon = new Date('2026-01-31T00:00:00.000Z').toISOString();
		expect(
			computeDecayExpiry(
				{ kind: 'todo', createdAt: created, expiresAt: horizon },
				DEFAULT_DECAY_HALF_LIFE_DAYS,
			),
		).toBeUndefined();
	});
});

describe('isPastDecayHorizon (upgrade-safety guard)', () => {
	const FUTURE = new Date('2099-01-01T00:00:00.000Z');
	const PAST = new Date('2000-01-01T00:00:00.000Z');

	test('returns true for a record older than its half-life (upgrade scenario)', () => {
		// Record created 2000-01-01; todo kind has 30d half-life; the natural
		// half-life date (2000-01-31) is well in the past. isPastDecayHorizon
		// returns true so applyDecay skips it.
		expect(
			isPastDecayHorizon(
				{ kind: 'todo', createdAt: PAST.toISOString() },
				DEFAULT_DECAY_HALF_LIFE_DAYS,
				FUTURE,
			),
		).toBe(true);
	});

	test('returns false for a record younger than its half-life', () => {
		// Record created 1 day ago; todo has 30d half-life; in the future.
		const recent = new Date(
			FUTURE.getTime() - 24 * 60 * 60 * 1000,
		).toISOString();
		expect(
			isPastDecayHorizon(
				{ kind: 'todo', createdAt: recent },
				DEFAULT_DECAY_HALF_LIFE_DAYS,
				FUTURE,
			),
		).toBe(false);
	});

	test('returns false for no-decay kinds (half-life 0)', () => {
		expect(
			isPastDecayHorizon(
				{ kind: 'project_fact', createdAt: PAST.toISOString() },
				DEFAULT_DECAY_HALF_LIFE_DAYS,
				FUTURE,
			),
		).toBe(false);
	});

	test('returns false for scratch kind', () => {
		expect(
			isPastDecayHorizon(
				{ kind: 'scratch', createdAt: PAST.toISOString() },
				DEFAULT_DECAY_HALF_LIFE_DAYS,
				FUTURE,
			),
		).toBe(false);
	});
});
