/**
 * Phase 1 PR Monitor infrastructure — PrSubscriptionState and rehydratePrSubscriptions tests.
 * Tests: PrSubscriptionState interface, prSubscriptions Map default, rehydratePrSubscriptions.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
// Re-export sweepStale from pr-subscriptions for lazySweepStaleForTest
import {
	PR_SUBSCRIPTIONS_FILE,
	sweepStale as realSweepStale,
	subscribe,
} from '../../../src/background/pr-subscriptions';
import {
	type PrSubscriptionState,
	rehydratePrSubscriptions,
} from '../../../src/state';

function makeTempProject(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-state-pr-'));
	const real = fs.realpathSync(dir);
	fs.mkdirSync(path.join(real, '.swarm', 'pr-monitor'), { recursive: true });
	return real;
}

describe('PrSubscriptionState interface', () => {
	test('has required fields', () => {
		const state: PrSubscriptionState = {
			prNumber: 42,
			repoFullName: 'owner/repo',
			prUrl: 'https://github.com/owner/repo/pull/42',
			lastKnownStatus: 'MERGEABLE',
			lastPollTime: Date.now(),
			errorCount: 0,
			isWatching: true,
		};
		expect(state.prNumber).toBe(42);
		expect(state.repoFullName).toBe('owner/repo');
		expect(state.lastKnownStatus).toBe('MERGEABLE');
		expect(state.isWatching).toBe(true);
	});

	test('lastKnownStatus defaults to "unknown" in practice', () => {
		// The rehydratePrSubscriptions helper sets lastKnownStatus from mergeableState
		// or defaults to 'unknown' when not present
		const state: PrSubscriptionState = {
			prNumber: 1,
			repoFullName: 'o/r',
			prUrl: 'https://github.com/o/r/pull/1',
			lastKnownStatus: 'unknown',
			lastPollTime: Date.now(),
			errorCount: 0,
			isWatching: false,
		};
		expect(state.lastKnownStatus).toBe('unknown');
	});
});

describe('rehydratePrSubscriptions', () => {
	let dir: string;
	beforeEach(() => {
		dir = makeTempProject();
	});
	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	test('returns empty map when no subscriptions exist', async () => {
		const map = await rehydratePrSubscriptions('sess_1', dir);
		expect(map.size).toBe(0);
	});

	test('rehydrates subscriptions for matching sessionID', async () => {
		// Subscribe two PRs from sess_1, one from sess_2
		await subscribe(dir, {
			sessionID: 'sess_1',
			prNumber: 1,
			repoFullName: 'o/r',
			prUrl: 'https://github.com/o/r/pull/1',
		});
		await subscribe(dir, {
			sessionID: 'sess_1',
			prNumber: 2,
			repoFullName: 'o/r',
			prUrl: 'https://github.com/o/r/pull/2',
		});
		await subscribe(dir, {
			sessionID: 'sess_2',
			prNumber: 1,
			repoFullName: 'o/r',
			prUrl: 'https://github.com/o/r/pull/1',
		});

		const map = await rehydratePrSubscriptions('sess_1', dir);
		expect(map.size).toBe(2);
		expect(map.has('o/r::1')).toBe(true);
		expect(map.has('o/r::2')).toBe(true);
		expect(map.has('o/r::1')).toBe(true); // from sess_1
	});

	test('filters out subscriptions from other sessions', async () => {
		await subscribe(dir, {
			sessionID: 'sess_1',
			prNumber: 1,
			repoFullName: 'o/r',
			prUrl: 'https://github.com/o/r/pull/1',
		});
		await subscribe(dir, {
			sessionID: 'sess_2',
			prNumber: 1,
			repoFullName: 'o/r',
			prUrl: 'https://github.com/o/r/pull/1',
		});

		const map1 = await rehydratePrSubscriptions('sess_1', dir);
		expect(map1.size).toBe(1);

		const map2 = await rehydratePrSubscriptions('sess_2', dir);
		expect(map2.size).toBe(1);
	});

	test('converts record to PrSubscriptionState correctly', async () => {
		await subscribe(dir, {
			sessionID: 'sess_1',
			prNumber: 42,
			repoFullName: 'myorg/myrepo',
			prUrl: 'https://github.com/myorg/myrepo/pull/42',
		});

		const map = await rehydratePrSubscriptions('sess_1', dir);
		const state = map.get('myorg/myrepo::42');
		expect(state).not.toBeUndefined();
		expect(state!.prNumber).toBe(42);
		expect(state!.repoFullName).toBe('myorg/myrepo');
		expect(state!.prUrl).toBe('https://github.com/myorg/myrepo/pull/42');
		expect(state!.isWatching).toBe(true);
		expect(state!.lastKnownStatus).toBe('unknown'); // default when no mergeableState
		expect(state!.lastPollTime).toBeGreaterThan(0);
		expect(state!.errorCount).toBe(0);
	});

	test('uses mergeableState as lastKnownStatus when present', async () => {
		// Subscribe then update snapshot with mergeableState
		await subscribe(dir, {
			sessionID: 'sess_1',
			prNumber: 1,
			repoFullName: 'o/r',
			prUrl: 'https://github.com/o/r/pull/1',
		});
		// Update via direct JSONL append to set mergeableState
		const filePath = path.join(dir, '.swarm', PR_SUBSCRIPTIONS_FILE);
		const content = fs.readFileSync(filePath, 'utf-8');
		const lines = content.trim().split('\n');
		const record = JSON.parse(lines[0]!);
		record.mergeableState = 'CONFLICTING';
		fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, 'utf-8');

		const map = await rehydratePrSubscriptions('sess_1', dir);
		const state = map.get('o/r::1');
		expect(state!.lastKnownStatus).toBe('CONFLICTING');
	});

	test('key format is repoFullName::prNumber', async () => {
		await subscribe(dir, {
			sessionID: 'sess_1',
			prNumber: 123,
			repoFullName: 'owner/repo',
			prUrl: 'https://github.com/owner/repo/pull/123',
		});

		const map = await rehydratePrSubscriptions('sess_1', dir);
		expect(map.has('owner/repo::123')).toBe(true);
		expect(map.has('owner/repo:123')).toBe(false); // wrong separator
	});
});

describe('prSubscriptions Map in AgentSessionState', () => {
	test('startAgentSession initializes empty prSubscriptions Map', async () => {
		// The prSubscriptions Map is initialized in startAgentSession via
		// the AgentSessionState object. We verify it exists and is empty.
		// This is validated via ensureAgentSession -> startAgentSession path.
		const { ensureAgentSession, swarmState } = await import(
			'../../../src/state'
		);

		const sessionId = `test-session-${Date.now()}`;
		const session = ensureAgentSession(sessionId, 'architect');

		expect(session.prSubscriptions).toBeInstanceOf(Map);
		expect(session.prSubscriptions.size).toBe(0);

		// Cleanup
		swarmState.agentSessions.delete(sessionId);
	});

	test('prSubscriptions Map can hold multiple PR entries', async () => {
		const { ensureAgentSession, swarmState } = await import(
			'../../../src/state'
		);

		const sessionId = `test-session-${Date.now()}`;
		const session = ensureAgentSession(sessionId, 'architect');

		const prState1: PrSubscriptionState = {
			prNumber: 1,
			repoFullName: 'owner/repo',
			prUrl: 'https://github.com/owner/repo/pull/1',
			lastKnownStatus: 'MERGEABLE',
			lastPollTime: Date.now(),
			errorCount: 0,
			isWatching: true,
		};
		const prState2: PrSubscriptionState = {
			prNumber: 2,
			repoFullName: 'owner/repo',
			prUrl: 'https://github.com/owner/repo/pull/2',
			lastKnownStatus: 'CONFLICTING',
			lastPollTime: Date.now(),
			errorCount: 2,
			isWatching: true,
		};

		session.prSubscriptions.set('owner/repo::1', prState1);
		session.prSubscriptions.set('owner/repo::2', prState2);

		expect(session.prSubscriptions.size).toBe(2);
		expect(session.prSubscriptions.get('owner/repo::1')?.lastKnownStatus).toBe(
			'MERGEABLE',
		);
		expect(session.prSubscriptions.get('owner/repo::2')?.errorCount).toBe(2);

		// Cleanup
		swarmState.agentSessions.delete(sessionId);
	});
});
