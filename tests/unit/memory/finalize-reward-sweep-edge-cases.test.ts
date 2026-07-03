/**
 * B.6 — edge cases for `runFinalizeRewardSweep`.
 *
 * Coverage:
 *   1. Disjointness (same session): a memory recalled ONLY into a COMPLETED
 *      task is UNTOUCHED even when it shares a work session with a swept task
 *      — the unitId narrowing inside applyCouncilReward protects it.
 *   2. No-recall closed task → no-op (no reward events, no throw).
 *   3. no-runId skip: a bundle tagged with the taskId but with no runId does
 *      NOT invoke `applyCouncilReward` (the defensive skip path).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import {
	computeMemoryContentHash,
	createConfiguredMemoryProvider,
	createMemoryId,
	DEFAULT_MEMORY_CONFIG,
	type MemoryProvider,
} from '../../../src/memory';
import type { MemoryConfig } from '../../../src/memory/config';
import {
	_internals,
	runFinalizeRewardSweep,
} from '../../../src/memory/finalize-reward-sweep';
import { clearPool } from '../../../src/memory/provider-pool';
import { applyCouncilReward } from '../../../src/memory/reward-capture';
import {
	createSafeTestDir,
	safeRmRecursive,
} from '../../helpers/safe-test-dir';

const TS = '2026-06-01T00:00:00.000Z';
const REPO_ID = 'b6-sweep-repo';
const SCOPE = { type: 'repository' as const, repoId: REPO_ID };

const tempRoots: string[] = [];
const openProviders: MemoryProvider[] = [];

afterEach(async () => {
	for (const provider of openProviders.splice(0)) {
		try {
			await provider.close?.();
		} catch {
			// best-effort
		}
	}
	_internals.createConfiguredMemoryProvider = createConfiguredMemoryProvider;
	_internals.applyCouncilReward = applyCouncilReward;
	clearPool();
	for (const root of tempRoots.splice(0)) {
		try {
			safeRmRecursive(root);
		} catch {
			// best-effort
		}
	}
});

function track<T extends MemoryProvider>(provider: T): T {
	openProviders.push(provider);
	return provider;
}

function makeConfig(providerName: 'local-jsonl' | 'sqlite'): MemoryConfig {
	return {
		...DEFAULT_MEMORY_CONFIG,
		enabled: true,
		provider: providerName,
		qLearning: { ...DEFAULT_MEMORY_CONFIG.qLearning, explorationRate: 0 },
	};
}

function buildRecord(text: string, qValue: number) {
	const base = { scope: SCOPE, kind: 'code_pattern' as const, text };
	return {
		id: createMemoryId(base),
		...base,
		tags: [],
		confidence: 0.8,
		stability: 'durable',
		source: { type: 'manual' as const, ref: 'b6-sweep-fixture' },
		createdAt: TS,
		updatedAt: TS,
		contentHash: computeMemoryContentHash(base),
		metadata: { qValue },
	};
}

let sqliteAvailable = true;
try {
	await import('bun:sqlite');
} catch {
	sqliteAvailable = false;
}
const providersToRun: Array<'local-jsonl' | 'sqlite'> = ['local-jsonl'];
if (sqliteAvailable) providersToRun.push('sqlite');

describe('runFinalizeRewardSweep — disjointness and no-recall edge cases', () => {
	for (const providerName of providersToRun) {
		describe(`provider: ${providerName}`, () => {
			test(
				'disjointness: a memory recalled ONLY into a COMPLETED task is untouched ' +
					'even when it shares a work session with a swept task',
				async () => {
					const { dir } = createSafeTestDir(`b6-disjoint-${providerName}-`);
					tempRoots.push(dir);
					const config = makeConfig(providerName);
					const sharedRunId = 'session-shared';
					const memCompleted = buildRecord(
						'Convention for the completed task.',
						0.5,
					);
					const memFailed = buildRecord(
						'Convention for the terminated task.',
						0.5,
					);

					const seed = track(createConfiguredMemoryProvider(dir, config));
					await seed.upsert(memCompleted);
					await seed.upsert(memFailed);
					// Both bundles are in the SAME work session — the sweep of the failed
					// task lists this whole session and must exclude the completed task's
					// tagged bundle by unitId.
					await seed.recordRecallUsage?.({
						bundleId: 'bundle-done',
						query: 'q',
						scopes: [SCOPE],
						memoryIds: [memCompleted.id],
						scores: [0.9],
						tokenEstimate: 30,
						runId: sharedRunId,
						unitId: 'task-done',
						timestamp: TS,
					});
					await seed.recordRecallUsage?.({
						bundleId: 'bundle-fail',
						query: 'q',
						scopes: [SCOPE],
						memoryIds: [memFailed.id],
						scores: [0.9],
						tokenEstimate: 30,
						runId: sharedRunId,
						unitId: 'task-fail',
						timestamp: TS,
					});
					await seed.close?.();

					// Only the non-completed task is swept.
					const result = await runFinalizeRewardSweep({
						directory: dir,
						closedTaskIds: ['task-fail'],
						memoryConfig: config,
						timestamp: TS,
					});
					expect(result.memoriesRewarded).toBe(1);

					const read = track(createConfiguredMemoryProvider(dir, config));
					const failedAfter = await read.get(memFailed.id);
					const completedAfter = await read.get(memCompleted.id);
					// Failed-task memory moved down: 0.9*0.5 = 0.45.
					expect(failedAfter?.metadata.qValue).toBeCloseTo(0.45, 10);
					// Completed-task memory is UNTOUCHED.
					expect(completedAfter?.metadata.qValue).toBeCloseTo(0.5, 10);
					const completedEvents = await read.listRewardEvents?.({
						memoryId: memCompleted.id,
					});
					expect(completedEvents).toHaveLength(0);
				},
			);

			test('no-recall closed task → no-op (no reward events, no throw)', async () => {
				const { dir } = createSafeTestDir(`b6-norecall-${providerName}-`);
				tempRoots.push(dir);
				const config = makeConfig(providerName);
				const rec = buildRecord('A memory never recalled into the task.', 0.5);
				const seed = track(createConfiguredMemoryProvider(dir, config));
				await seed.upsert(rec); // seeded but no recall usage recorded
				await seed.close?.();

				const result = await runFinalizeRewardSweep({
					directory: dir,
					closedTaskIds: ['task-with-no-recall'],
					memoryConfig: config,
					timestamp: TS,
				});
				expect(result.swept).toBe(true);
				expect(result.tasksSwept).toBe(0);
				expect(result.memoriesRewarded).toBe(0);
				expect(result.runIdsProcessed).toBe(0);

				const read = track(createConfiguredMemoryProvider(dir, config));
				expect(
					await read.listRewardEvents?.({ memoryId: rec.id }),
				).toHaveLength(0);
				// q unchanged.
				expect((await read.get(rec.id))?.metadata.qValue).toBeCloseTo(0.5, 10);
			});
		});
	}
});

describe('runFinalizeRewardSweep — no-runId defensive skip', () => {
	test(
		'a bundle tagged with the taskId but no runId does NOT invoke ' +
			'applyCouncilReward; the memory is untouched',
		async () => {
			const originalApplyCouncilReward = _internals.applyCouncilReward;
			let applyCalls = 0;
			_internals.applyCouncilReward = (async (...args) => {
				applyCalls++;
				return originalApplyCouncilReward(...args);
			}) as typeof originalApplyCouncilReward;

			_internals.createConfiguredMemoryProvider = (() =>
				({
					listRecallUsage: async (filter?: { unitId?: string }) => {
						if (filter?.unitId !== 'task-no-runid') return [];
						// Tagged with the closed task's id but NO runId — the
						// defensive skip path (recall injector always records a
						// runId in practice; this pins the guard for when it doesn't).
						return [
							{
								bundleId: 'bundle-no-runid',
								query: 'q',
								scopes: [SCOPE],
								memoryIds: ['mem-would-be-rewarded'],
								scores: [0.9],
								tokenEstimate: 20,
								runId: undefined,
								unitId: 'task-no-runid',
								timestamp: TS,
							},
						];
					},
					get: async () => null,
					upsert: async () => {},
					close: () => {},
				}) as unknown as ReturnType<
					typeof createConfiguredMemoryProvider
				>) as typeof createConfiguredMemoryProvider;

			try {
				const result = await runFinalizeRewardSweep({
					directory: '/nonexistent',
					closedTaskIds: ['task-no-runid'],
					memoryConfig: { ...DEFAULT_MEMORY_CONFIG, enabled: true },
					timestamp: TS,
				});
				expect(result.swept).toBe(true);
				expect(result.tasksSwept).toBe(0);
				expect(result.memoriesRewarded).toBe(0);
				expect(result.runIdsProcessed).toBe(0);
				// The skip happens BEFORE any applyCouncilReward call.
				expect(applyCalls).toBe(0);
			} finally {
				_internals.applyCouncilReward = originalApplyCouncilReward;
			}
		},
	);
});
