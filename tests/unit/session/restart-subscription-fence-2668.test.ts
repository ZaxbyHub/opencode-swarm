/**
 * Issue #2668 — the follow-on PR-subscription read must share the session
 * refresh fence with plan/evidence rehydration.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { beginHydrationScope } from '../../../src/session/hydration-ownership';
import {
	type PrSubscriptionState,
	resetSwarmState,
	startAgentSession,
	_internals as stateInternals,
	swarmState,
} from '../../../src/state';
import { safeRmRecursive } from '../../helpers/safe-test-dir';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const tempDirs: string[] = [];
const originalRehydrateSessionFromDisk =
	stateInternals.rehydrateSessionFromDisk;
const originalRehydratePrSubscriptions =
	stateInternals.rehydratePrSubscriptions;

function deferred<T>(): {
	promise: Promise<T>;
	resolve: (value: T) => void;
} {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

function makeProject(): string {
	const directory = canonicalMkdtemp('swarm-2668-subscriptions-');
	tempDirs.push(directory);
	mkdirSync(path.join(directory, '.swarm'), { recursive: true });
	return directory;
}

function makeSubscriptions(status: string): Map<string, PrSubscriptionState> {
	return new Map([
		[
			'owner/repo::1',
			{
				prNumber: 1,
				repoFullName: 'owner/repo',
				prUrl: 'https://github.com/owner/repo/pull/1',
				lastKnownStatus: status,
				lastPollTime: 1,
				errorCount: 0,
				isWatching: true,
			},
		],
	]);
}

async function settlePendingRehydration(): Promise<void> {
	await Promise.allSettled([...swarmState.pendingRehydrations]);
}

beforeEach(() => {
	stateInternals.rehydrateSessionFromDisk = originalRehydrateSessionFromDisk;
	stateInternals.rehydratePrSubscriptions = originalRehydratePrSubscriptions;
	resetSwarmState();
});

afterEach(() => {
	stateInternals.rehydrateSessionFromDisk = originalRehydrateSessionFromDisk;
	stateInternals.rehydratePrSubscriptions = originalRehydratePrSubscriptions;
	resetSwarmState();
	for (const directory of tempDirs.splice(0)) {
		safeRmRecursive(directory);
	}
});

describe('session PR-subscription refresh fence (#2668)', () => {
	test('does not start a stale subscription read after a newer hydration begins', async () => {
		const directory = makeProject();
		const sessionID = 'subscription-before-read';
		const refreshStarted = deferred<void>();
		const releaseRefresh = deferred<void>();
		let subscriptionReadStarted = false;

		stateInternals.rehydrateSessionFromDisk = async () => {
			refreshStarted.resolve();
			await releaseRefresh.promise;
		};
		stateInternals.rehydratePrSubscriptions = async () => {
			subscriptionReadStarted = true;
			return makeSubscriptions('stale');
		};

		startAgentSession(sessionID, 'coder', undefined, directory);
		const liveSession = swarmState.agentSessions.get(sessionID);
		expect(liveSession).toBeDefined();
		await refreshStarted.promise;

		beginHydrationScope(directory);
		releaseRefresh.resolve();
		await settlePendingRehydration();

		expect(subscriptionReadStarted).toBe(false);
		expect(liveSession?.prSubscriptions).toEqual(new Map());
	});

	test('does not assign a delayed stale result to the exact live session', async () => {
		const directory = makeProject();
		const sessionID = 'subscription-after-await';
		const subscriptionReadStarted = deferred<void>();
		const releaseSubscriptionRead =
			deferred<Map<string, PrSubscriptionState>>();
		const staleSubscriptions = makeSubscriptions('stale');

		stateInternals.rehydrateSessionFromDisk = async () => {};
		stateInternals.rehydratePrSubscriptions = async () => {
			subscriptionReadStarted.resolve();
			return releaseSubscriptionRead.promise;
		};

		startAgentSession(sessionID, 'coder', undefined, directory);
		const liveSession = swarmState.agentSessions.get(sessionID);
		expect(liveSession).toBeDefined();
		await subscriptionReadStarted.promise;

		beginHydrationScope(directory);
		releaseSubscriptionRead.resolve(staleSubscriptions);
		await settlePendingRehydration();

		expect(swarmState.agentSessions.get(sessionID)).toBe(liveSession);
		expect(liveSession?.prSubscriptions).toEqual(new Map());
		expect(liveSession?.prSubscriptions).not.toBe(staleSubscriptions);
	});
});
