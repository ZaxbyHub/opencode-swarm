/**
 * Epic v2 C0/C3 — plan key, task commit message, marker parsing,
 * root-timestamp cache, bounded scope resolution
 * (`src/epic/plan-key.ts`).
 *
 * Ledger reads go through the module's `_internals` DI seam (AGENTS.md #7);
 * every timestamp is a literal, so no clock is read.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type { Plan } from '../../../src/config/plan-schema';
import {
	_internals,
	_resetRootTimestampCacheForTest,
	_rootTimestampCacheSizeForTest,
	computePlanKey,
	formatEpicTaskCommitMessage,
	formatSwarmPlanTrailer,
	MAX_ROOT_TS_CACHE_ENTRIES,
	parseTaskMarkerLog,
	resolvePlanMarkerScope,
} from '../../../src/epic/plan-key';
import type { LedgerEvent } from '../../../src/plan/ledger';

const PLAN = {
	title: 'Plan Key Test',
	swarm: 'test-swarm',
} as unknown as Plan;

const originals = { ..._internals };
afterEach(() => {
	Object.assign(_internals, originals);
	_resetRootTimestampCacheForTest();
});

function events(...isoTimestamps: string[]): LedgerEvent[] {
	return isoTimestamps.map(
		(timestamp, i) => ({ seq: i + 1, timestamp }) as unknown as LedgerEvent,
	);
}

function identity(epoch: string) {
	return {
		planId: 'p',
		planIdentityHash: 'f'.repeat(64),
		planEpoch: epoch,
		rootEventHash: 'r',
		payloadHash: 'h',
		source: 'root' as const,
	};
}

describe('computePlanKey', () => {
	test('is sha256(identity|epoch) truncated to 16 hex chars', () => {
		const expected = createHash('sha256')
			.update('abc|epoch-1')
			.digest('hex')
			.slice(0, 16);
		expect(computePlanKey('abc', 'epoch-1')).toBe(expected);
		expect(computePlanKey('abc', null)).toBe(
			createHash('sha256').update('abc|').digest('hex').slice(0, 16),
		);
	});

	test('a new epoch (same title) yields a different key', () => {
		expect(computePlanKey('abc', 'e1')).not.toBe(computePlanKey('abc', 'e2'));
		expect(computePlanKey('abc', null)).not.toBe(computePlanKey('abc', 'e1'));
	});

	test('trailer line format', () => {
		expect(formatSwarmPlanTrailer('0123456789abcdef')).toBe(
			'Swarm-Plan: 0123456789abcdef',
		);
	});
});

describe('formatEpicTaskCommitMessage', () => {
	const KEY = 'feedfacecafebeef';

	test('subject `swarm(task <id>): …`, blank line, Swarm-Plan trailer', () => {
		expect(
			formatEpicTaskCommitMessage('2.1', KEY, 'implement Dataset').split('\n'),
		).toEqual(['swarm(task 2.1): implement Dataset', '', `Swarm-Plan: ${KEY}`]);
		expect(formatEpicTaskCommitMessage('3.4', KEY)).toBe(
			`swarm(task 3.4): completed\n\nSwarm-Plan: ${KEY}`,
		);
	});

	test('collapses whitespace, truncates long summaries, scrubs unsafe ids', () => {
		const [subject] = formatEpicTaskCommitMessage(
			'1.1',
			KEY,
			`first line\n\nsecond  ${'a'.repeat(200)}`,
		).split('\n');
		expect(subject.startsWith('swarm(task 1.1): first line second a')).toBe(
			true,
		);
		expect(subject.length).toBeLessThan(100);
		expect(subject.endsWith('...')).toBe(true);
		expect(formatEpicTaskCommitMessage('1.1)\nx', KEY, 's')).toStartWith(
			'swarm(task 1.1__x): s',
		);
	});
});

describe('parseTaskMarkerLog', () => {
	const A = 'a'.repeat(40);
	const B = 'b'.repeat(40);
	const C = 'c'.repeat(40);
	const D = 'd'.repeat(40);
	const out = [
		`${A}\x1fswarm(task 1.1): a\n\nSwarm-Plan: aaaa\n\n`,
		`${B}\x1fswarm(task 1.2): no trailer\n\n`,
		`${C}\x1fMerge squash\n\nswarm(task 9.9): quoted in body\n`,
		`${D}\x1fswarm(task 1.3): crlf\r\n\r\nSwarm-Plan: aaaa\r\n`,
	].join('\0');

	test('parses subject markers and trailers; ignores body-only quotes', () => {
		expect(parseTaskMarkerLog(out)).toEqual([
			{ sha: A, taskId: '1.1', planKey: 'aaaa' },
			{ sha: B, taskId: '1.2', planKey: null },
			{ sha: D, taskId: '1.3', planKey: 'aaaa' },
		]);
	});

	test('a body cannot forge a record: only NUL separates records (-z)', () => {
		const forged = `${A}\x1fdocs: notes\n\n\x1e${B}\x1fswarm(task 7.7): forged\n\nSwarm-Plan: aaaa\n`;
		expect(parseTaskMarkerLog(forged)).toEqual([]);
		expect(parseTaskMarkerLog('not-a-sha\x1fswarm(task 1.1): x\n')).toEqual([]);
	});
});

describe('resolvePlanMarkerScope', () => {
	test('planKey from ledger identity; root = earliest ledger event', async () => {
		_internals.readPlanEpochIdentity = async () => identity('e1');
		_internals.readLedgerEvents = async () =>
			events('2026-01-01T00:00:05.000Z', '2026-01-01T00:00:01.000Z');
		const scope = await resolvePlanMarkerScope('/d', PLAN);
		expect(scope.planKey).toBe(computePlanKey('f'.repeat(64), 'e1'));
		// 2026-01-01T00:00:01.000Z
		expect(scope.rootTimestampMs).toBe(1_767_225_601_000);
	});

	test('no ledger: identity-hash fallback, null epoch, unknown root', async () => {
		_internals.readPlanEpochIdentity = async () => null;
		_internals.readLedgerEvents = async () => [];
		const scope = await resolvePlanMarkerScope('/d', PLAN);
		expect(scope.rootTimestampMs).toBeNull();
		expect(scope.planKey).toHaveLength(16);
	});

	test('root timestamp is cached per (directory, planKey); null-epoch is not cached', async () => {
		let reads = 0;
		_internals.readPlanEpochIdentity = async () => identity('e1');
		_internals.readLedgerEvents = async () => {
			reads += 1;
			return events('2026-01-01T00:00:00.000Z');
		};
		await resolvePlanMarkerScope('/d', PLAN);
		await resolvePlanMarkerScope('/d', PLAN);
		expect(reads).toBe(1);
		_internals.readPlanEpochIdentity = async () => null;
		await resolvePlanMarkerScope('/d', PLAN);
		await resolvePlanMarkerScope('/d', PLAN);
		expect(reads).toBe(3);
	});

	test('cache is FIFO-bounded (invariant 8)', async () => {
		_internals.readLedgerEvents = async () =>
			events('2026-01-01T00:00:00.000Z');
		for (let i = 0; i < MAX_ROOT_TS_CACHE_ENTRIES + 5; i++) {
			_internals.readPlanEpochIdentity = async () => identity(`e${i}`);
			await resolvePlanMarkerScope(`/d${i}`, PLAN);
		}
		expect(_rootTimestampCacheSizeForTest()).toBe(MAX_ROOT_TS_CACHE_ENTRIES);
	});

	test('never-resolving ledger read is bounded and rejects (callers fail closed)', async () => {
		_internals.resolveTimeoutMs = 20;
		_internals.readPlanEpochIdentity = () => new Promise(() => {});
		await expect(resolvePlanMarkerScope('/d', PLAN)).rejects.toThrow(
			/timed out/,
		);
	});

	test('identity read error propagates', async () => {
		_internals.readPlanEpochIdentity = async () => {
			throw new Error('Conflicting plan epoch metadata');
		};
		await expect(resolvePlanMarkerScope('/d', PLAN)).rejects.toThrow(
			/Conflicting/,
		);
	});
});
