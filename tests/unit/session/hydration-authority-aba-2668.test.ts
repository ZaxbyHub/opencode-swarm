/**
 * Issue #2668 — hydration authority ABA regression coverage.
 *
 * Numeric per-project generations are intentionally reusable after FIFO
 * eviction and reset. The process-monotonic authority epoch must still make
 * every old scope/token permanently stale.
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import {
	beginHydrationScope,
	captureCurrentHydrationAuthority,
	clearHydrationOwnershipState,
	currentHydrationGeneration,
	hydrationProjectKey,
	isHydrationAuthorityCurrent,
	isHydrationScopeCurrent,
	MAX_TRACKED_PROJECTS,
} from '../../../src/session/hydration-ownership';
import { rehydrateState } from '../../../src/session/snapshot-reader';
import type { SnapshotData } from '../../../src/session/snapshot-writer';
import {
	buildRehydrationCache,
	ensureAgentSession,
	rehydrateSessionFromDisk,
	resetSwarmState,
	startAgentSession,
	_internals as stateInternals,
	swarmState,
} from '../../../src/state';
import { writeApprovedPlan } from '../../helpers/approved-plan';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const tempDirs: string[] = [];

function makeProject(prefix: string): string {
	const directory = canonicalMkdtemp(`${prefix}-2668-`);
	tempDirs.push(directory);
	return directory;
}

function makeSnapshot(sessionId: string): SnapshotData {
	return {
		version: 3,
		writtenAt: 1,
		toolAggregates: {
			stale: {
				tool: 'stale',
				count: 1,
				successCount: 1,
				failureCount: 0,
				totalDuration: 1,
			},
		},
		activeAgent: { [sessionId]: 'coder' },
		delegationChains: {},
		agentSessions: {
			[sessionId]: {
				agentName: 'coder',
				lastToolCallTime: 1,
				lastAgentEventTime: 1,
				delegationActive: false,
			},
		},
	} as unknown as SnapshotData;
}

function deferred(): { promise: Promise<void>; release: () => void } {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

function floodProjectAuthorities(): void {
	for (let index = 0; index < MAX_TRACKED_PROJECTS; index += 1) {
		beginHydrationScope(makeProject(`aba-flood-${index}`));
	}
}

async function settlePendingRehydrations(): Promise<void> {
	await Promise.allSettled([...swarmState.pendingRehydrations]);
}

beforeEach(() => {
	resetSwarmState();
});

afterAll(() => {
	for (const directory of tempDirs) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe('process-monotonic hydration authority', () => {
	test('stale scope stays false after FIFO eviction and same-generation reinsertion', async () => {
		const directory = makeProject('aba-scope');
		const oldScope = beginHydrationScope(directory);
		const gate = deferred();
		swarmState.pendingRehydrations.add(gate.promise);

		const pending = rehydrateState(
			makeSnapshot('must-not-restore'),
			directory,
			oldScope,
		);
		floodProjectAuthorities();
		const newScope = beginHydrationScope(directory);

		expect(newScope.generation).toBe(oldScope.generation);
		expect(newScope.authorityEpoch).not.toBe(oldScope.authorityEpoch);
		expect(isHydrationScopeCurrent(oldScope)).toBe(false);
		expect(isHydrationScopeCurrent(newScope)).toBe(true);

		gate.release();
		const outcome = await pending;
		swarmState.pendingRehydrations.delete(gate.promise);
		expect(outcome).toEqual({ applied: false, reason: 'superseded' });
		expect(swarmState.agentSessions.has('must-not-restore')).toBe(false);
		expect(swarmState.toolAggregates.has('stale')).toBe(false);
	});

	test('clear and reset never let an old scope revive after reintroduction', async () => {
		const directory = makeProject('aba-clear');
		const oldScope = beginHydrationScope(directory);
		const gate = deferred();
		swarmState.pendingRehydrations.add(gate.promise);

		const pending = rehydrateState(
			makeSnapshot('must-not-restore-reset'),
			directory,
			oldScope,
		);
		clearHydrationOwnershipState();
		const newScope = beginHydrationScope(directory);

		expect(newScope.generation).toBe(oldScope.generation);
		expect(newScope.authorityEpoch).not.toBe(oldScope.authorityEpoch);
		expect(isHydrationScopeCurrent(oldScope)).toBe(false);

		gate.release();
		const outcome = await pending;
		swarmState.pendingRehydrations.delete(gate.promise);
		expect(outcome.applied).toBe(false);
		expect(swarmState.agentSessions.has('must-not-restore-reset')).toBe(false);
	});

	test('implicit rehydrate captures the exact authority across its await', async () => {
		const directory = makeProject('aba-implicit');
		beginHydrationScope(directory);
		const gate = deferred();
		swarmState.pendingRehydrations.add(gate.promise);

		const pending = rehydrateState(
			makeSnapshot('must-not-restore-implicit'),
			directory,
		);
		floodProjectAuthorities();
		const newAuthority = beginHydrationScope(directory);

		expect(currentHydrationGeneration(newAuthority.projectKey)).toBe(1);
		expect(isHydrationAuthorityCurrent(newAuthority)).toBe(true);

		gate.release();
		const outcome = await pending;
		swarmState.pendingRehydrations.delete(gate.promise);
		expect(outcome.applied).toBe(false);
		expect(swarmState.agentSessions.has('must-not-restore-implicit')).toBe(
			false,
		);
	});

	test('direct session rehydration cannot regain authority after eviction/reinsertion', async () => {
		const directory = makeProject('aba-direct');
		const originalRehydrate = stateInternals.rehydrateSessionFromDisk;
		const originalSubscriptions = stateInternals.rehydratePrSubscriptions;
		const gate = deferred();
		let shouldCommit: (() => boolean) | undefined;

		stateInternals.rehydrateSessionFromDisk = async (
			_directory,
			session,
			check,
		) => {
			shouldCommit = check;
			await gate.promise;
			if (check?.()) session.currentTaskId = 'must-not-be-revived';
		};
		stateInternals.rehydratePrSubscriptions = async () => new Map();

		try {
			startAgentSession('direct-aba', 'coder', undefined, directory);
			expect(shouldCommit).toBeDefined();
			const projectKey = hydrationProjectKey(directory);
			expect(currentHydrationGeneration(projectKey)).toBe(0);

			floodProjectAuthorities();
			const replacement = captureCurrentHydrationAuthority(projectKey);
			expect(currentHydrationGeneration(projectKey)).toBe(0);
			expect(shouldCommit?.()).toBe(false);
			expect(isHydrationAuthorityCurrent(replacement)).toBe(true);

			gate.release();
			await Promise.allSettled([...swarmState.pendingRehydrations]);
			expect(
				swarmState.agentSessions.get('direct-aba')?.currentTaskId,
			).toBeNull();
		} finally {
			gate.release();
			stateInternals.rehydrateSessionFromDisk = originalRehydrate;
			stateInternals.rehydratePrSubscriptions = originalSubscriptions;
		}
	});

	test('rehydration evicts a session from an older authority despite its larger stamp', async () => {
		const directory = makeProject('aba-session-stamp');
		// The live session is created under generation 1, so its recency stamp is
		// 2. Eviction/reinsertion resets the visible generation to 1; numeric-only
		// recency would incorrectly preserve this stale session.
		const firstScope = beginHydrationScope(directory);
		startAgentSession('stale-authority-session', 'coder', undefined, directory);
		await settlePendingRehydrations();
		const stale = swarmState.agentSessions.get('stale-authority-session');
		expect(stale?.hydrationStamp).toBe(firstScope.generation + 1);
		expect(stale?.hydrationAuthorityEpoch).toBe(firstScope.authorityEpoch);

		floodProjectAuthorities();
		const replacement = beginHydrationScope(directory);
		expect(replacement.generation).toBe(firstScope.generation);
		expect(replacement.authorityEpoch).not.toBe(firstScope.authorityEpoch);

		const outcome = await rehydrateState(
			makeSnapshot('fresh-authority-session'),
			directory,
			replacement,
		);
		expect(outcome).toEqual({ applied: true });
		expect(swarmState.agentSessions.has('stale-authority-session')).toBe(false);
		expect(swarmState.agentSessions.has('fresh-authority-session')).toBe(true);
	});

	test('ownership reset makes old session stamps stale after authority reintroduction', async () => {
		const directory = makeProject('aba-session-reset');
		const firstScope = beginHydrationScope(directory);
		startAgentSession('reset-stale-session', 'coder', undefined, directory);
		await settlePendingRehydrations();
		const stale = swarmState.agentSessions.get('reset-stale-session');
		expect(stale?.hydrationStamp).toBe(firstScope.generation + 1);

		// This reset intentionally leaves live sessions in place, modeling a
		// registry reset that races with a still-running session rehydration.
		clearHydrationOwnershipState();
		const replacement = beginHydrationScope(directory);
		expect(replacement.generation).toBe(firstScope.generation);
		expect(replacement.authorityEpoch).not.toBe(firstScope.authorityEpoch);

		const outcome = await rehydrateState(
			makeSnapshot('fresh-after-reset'),
			directory,
			replacement,
		);
		expect(outcome).toEqual({ applied: true });
		expect(swarmState.agentSessions.has('reset-stale-session')).toBe(false);
		expect(swarmState.agentSessions.has('fresh-after-reset')).toBe(true);
	});

	test('startAgentSession rejects an evicted cache but applies the current epoch cache', async () => {
		const directory = makeProject('aba-cache');
		await writeApprovedPlan(directory, [
			{ id: '1.1', files: ['src/cache.ts'], status: 'completed' },
		]);
		await buildRehydrationCache(directory);

		floodProjectAuthorities();
		const projectKey = hydrationProjectKey(directory);
		const replacement = captureCurrentHydrationAuthority(projectKey);
		startAgentSession('stale-cache-session', 'coder', undefined, directory);
		const staleSession = swarmState.agentSessions.get('stale-cache-session');
		expect(staleSession?.taskWorkflowStates.has('1.1')).toBe(false);

		await buildRehydrationCache(directory);
		startAgentSession('current-cache-session', 'coder', undefined, directory);
		const currentSession = swarmState.agentSessions.get(
			'current-cache-session',
		);
		expect(currentSession?.taskWorkflowStates.get('1.1')).toBe('complete');
		expect(replacement.authorityEpoch).toBe(
			currentSession?.hydrationAuthorityEpoch,
		);
		await settlePendingRehydrations();
	});

	test('a delayed cache build cannot publish after authority reintroduction', async () => {
		const directory = makeProject('aba-delayed-cache');
		await writeApprovedPlan(directory, [
			{ id: '1.1', files: ['src/cache.ts'], status: 'completed' },
		]);
		await buildRehydrationCache(directory);

		const delayedBuild = buildRehydrationCache(directory);
		floodProjectAuthorities();
		const replacement = captureCurrentHydrationAuthority(
			hydrationProjectKey(directory),
		);
		const result = await delayedBuild;

		expect(result).toEqual({ committed: false, reason: 'superseded' });
		expect(replacement.authorityEpoch).not.toBe(0);
	});

	describe('rehydration cache committed-result contract (GAP-001)', () => {
		test('public session rehydration does not apply a cache after authority supersedes its build', async () => {
			const directory = makeProject('aba-cache-committed-result');
			const session = ensureAgentSession('uncommitted-cache-session', 'coder');
			const originalAuthority = beginHydrationScope(directory);
			await writeApprovedPlan(directory, [
				{ id: '1.1', files: ['src/cache.ts'], status: 'completed' },
			]);
			expect((await buildRehydrationCache(directory)).committed).toBe(true);
			expect(session.taskWorkflowStates.has('1.1')).toBe(false);

			// The real builder captures the old authority before its async plan read.
			// Evict that authority before the post-read publication check; the public
			// rehydration path must honor committed:false instead of applying the old cache.
			const originalBuild = stateInternals.buildRehydrationCache;
			let buildResult: Awaited<
				ReturnType<typeof buildRehydrationCache>
			> | null = null;
			stateInternals.buildRehydrationCache = async (root, options) => {
				buildResult = await originalBuild(root, options);
				return buildResult;
			};
			try {
				const pending = rehydrateSessionFromDisk(
					directory,
					session,
					() => true,
				);
				floodProjectAuthorities();
				const replacement = beginHydrationScope(directory);
				expect(replacement.authorityEpoch).not.toBe(
					originalAuthority.authorityEpoch,
				);

				await pending;

				expect(buildResult).toEqual({
					committed: false,
					reason: 'superseded',
				});
				expect(session.taskWorkflowStates.has('1.1')).toBe(false);
			} finally {
				stateInternals.buildRehydrationCache = originalBuild;
			}
		});
	});

	test('aggregate ownership from an evicted epoch cannot delete new state', async () => {
		const directory = makeProject('aba-aggregates');
		const first = beginHydrationScope(directory);
		const initial = makeSnapshot('aggregate-old');
		const initialOutcome = await rehydrateState(initial, directory, first);
		expect(initialOutcome).toEqual({ applied: true });
		swarmState.toolAggregates.get('stale')!.count = 99;

		floodProjectAuthorities();
		const replacement = beginHydrationScope(directory);
		const next = makeSnapshot('aggregate-new');
		next.toolAggregates = {};
		const nextOutcome = await rehydrateState(next, directory, replacement);

		expect(nextOutcome).toEqual({ applied: true });
		expect(swarmState.toolAggregates.get('stale')?.count).toBe(99);
	});
});
