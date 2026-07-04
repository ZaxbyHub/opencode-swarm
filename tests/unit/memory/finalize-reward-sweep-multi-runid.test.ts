/**
 * B.6 — multi-runId and negative propagation tests for `runFinalizeRewardSweep`.
 *
 * Coverage:
 *   1. Multi-runId: a memory recalled into the same closed task across two
 *      work sessions gets one 0.0 step PER runId (documented behavior).
 *   2. Blast-radius pin: an UNTAGGED bundle sharing a runId with a taskId-tagged
 *      bundle is ALSO penalized (accepted run_id-fallback behavior).
 *   3. Negative propagation: a Jaccard-related, recently-retrieved sibling of a
 *      swept memory receives a bounded downward propagated step; an unrelated
 *      memory does not.
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
	FINALIZE_NEGATIVE_TERMINAL_REWARD,
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

// 20 base tokens shared by the "source" text; candidates share a controlled
// prefix of these to produce a KNOWN, orderable Jaccard overlap (mirrors
// tests/unit/memory/reward-capture-propagation.test.ts).
const BASE_TOKENS = Array.from({ length: 20 }, (_, i) => `base${i}`);

/** Text sharing the first `sharedCount` base tokens + `uniqueCount` unique. */
function overlapText(
	sharedCount: number,
	uniqueTag: string,
	uniqueCount: number,
): string {
	const shared = BASE_TOKENS.slice(0, sharedCount);
	const unique = Array.from(
		{ length: uniqueCount },
		(_, i) => `${uniqueTag}uq${i}`,
	);
	return [...shared, ...unique].join(' ');
}

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

describe('runFinalizeRewardSweep — multi-runId and blast-radius pin', () => {
	for (const providerName of providersToRun) {
		describe(`provider: ${providerName}`, () => {
			test(
				'multi-runId: a memory recalled into the same closed task across two ' +
					'work sessions gets one 0.0 step PER runId (documented behavior)',
				async () => {
					const { dir } = createSafeTestDir(`b6-multirun-${providerName}-`);
					tempRoots.push(dir);
					const config = makeConfig(providerName);
					const rec = buildRecord('Recalled into the same task twice.', 0.5);
					const taskId = 'task-fail';
					const seed = track(createConfiguredMemoryProvider(dir, config));
					await seed.upsert(rec);
					await seed.recordRecallUsage?.({
						bundleId: 'bundle-r1',
						query: 'q',
						scopes: [SCOPE],
						memoryIds: [rec.id],
						scores: [0.9],
						tokenEstimate: 20,
						runId: 'run-1',
						unitId: taskId,
						timestamp: TS,
					});
					await seed.recordRecallUsage?.({
						bundleId: 'bundle-r2',
						query: 'q',
						scopes: [SCOPE],
						memoryIds: [rec.id],
						scores: [0.9],
						tokenEstimate: 20,
						runId: 'run-2',
						unitId: taskId,
						timestamp: '2026-06-01T00:00:01.000Z',
					});
					await seed.close?.();

					const result = await runFinalizeRewardSweep({
						directory: dir,
						closedTaskIds: [taskId],
						memoryConfig: config,
						timestamp: TS,
					});
					// One applyCouncilReward call per discovered runId.
					expect(result.runIdsProcessed).toBe(2);
					expect(result.memoriesRewarded).toBe(2);
					expect(result.tasksSwept).toBe(1);

					const read = track(createConfiguredMemoryProvider(dir, config));
					// Two 0.0 steps: 0.5 → 0.45 → 0.405.
					expect((await read.get(rec.id))?.metadata.qValue).toBeCloseTo(
						0.405,
						10,
					);
					expect(
						await read.listRewardEvents?.({ memoryId: rec.id }),
					).toHaveLength(2);
				},
			);

			test(
				'blast-radius pin: an UNTAGGED bundle sharing a runId with a ' +
					'taskId-tagged bundle is ALSO penalized (accepted run_id-fallback behavior)',
				async () => {
					const { dir } = createSafeTestDir(`b6-blastradius-${providerName}-`);
					tempRoots.push(dir);
					const config = makeConfig(providerName);
					const taskId = 'task-fail';
					const sharedRunId = 'shared-run';
					const tagged = buildRecord('Tagged to the failed task.', 0.5);
					const untagged = buildRecord('Untagged bundle in the same run.', 0.5);
					const seed = track(createConfiguredMemoryProvider(dir, config));
					await seed.upsert(tagged);
					await seed.upsert(untagged);
					await seed.recordRecallUsage?.({
						bundleId: 'bundle-tagged',
						query: 'q',
						scopes: [SCOPE],
						memoryIds: [tagged.id],
						scores: [0.9],
						tokenEstimate: 20,
						runId: sharedRunId,
						unitId: taskId,
						timestamp: TS,
					});
					await seed.recordRecallUsage?.({
						bundleId: 'bundle-untagged',
						query: 'q',
						scopes: [SCOPE],
						memoryIds: [untagged.id],
						scores: [0.8],
						tokenEstimate: 20,
						runId: sharedRunId,
						// unitId intentionally omitted — an untagged bundle in the SAME
						// runId as the tagged bundle. This documents the accepted
						// multiplicity source #2 from the module header: the run_id
						// fallback inside applyCouncilReward keeps this bundle too.
						timestamp: TS,
					});
					await seed.close?.();

					const result = await runFinalizeRewardSweep({
						directory: dir,
						closedTaskIds: [taskId],
						memoryConfig: config,
						timestamp: TS,
					});
					expect(result.runIdsProcessed).toBe(1);
					expect(result.memoriesRewarded).toBe(2);

					const read = track(createConfiguredMemoryProvider(dir, config));
					const taggedAfter = await read.get(tagged.id);
					const untaggedAfter = await read.get(untagged.id);
					// Both moved down by one 0.0 EMA step: 0.9*0.5 = 0.45.
					expect(taggedAfter?.metadata.qValue).toBeCloseTo(0.45, 10);
					expect(untaggedAfter?.metadata.qValue).toBeCloseTo(0.45, 10);
					const untaggedEvents = await read.listRewardEvents?.({
						memoryId: untagged.id,
					});
					expect(untaggedEvents).toHaveLength(1);
					expect(untaggedEvents?.[0]).toMatchObject({
						unitId: taskId,
						reward: FINALIZE_NEGATIVE_TERMINAL_REWARD,
						verdict: 'session_terminated',
					});
				},
			);
		});
	}
});

describe('runFinalizeRewardSweep — negative propagation (Jaccard-related sibling)', () => {
	for (const providerName of providersToRun) {
		describe(`provider: ${providerName}`, () => {
			test(
				'a Jaccard-related, recently-retrieved sibling of a swept memory ' +
					'receives a bounded downward propagated step; an unrelated memory does not',
				async () => {
					const { dir } = createSafeTestDir(`b6-negprop-${providerName}-`);
					tempRoots.push(dir);
					const config = makeConfig(providerName);
					const taskId = 'task-fail';
					const runId = 'run-negprop';
					// direct: all 20 base tokens, directly swept.
					const direct = buildRecord(overlapText(20, 'src', 0), 0.5);
					// sibling: 19/20 base tokens shared -> Jaccard 19/21 ≈ 0.905 (≥0.70
					// default threshold) and retrieved in a DIFFERENT session (not
					// directly rewarded), so it is a propagation TARGET only.
					const sibling = buildRecord(overlapText(19, 'rel', 1), 0.5);
					// unrelated: zero base-token overlap -> below the relatedness bar.
					const unrelated = buildRecord(overlapText(0, 'unrel', 20), 0.5);
					const seed = track(createConfiguredMemoryProvider(dir, config));
					for (const rec of [direct, sibling, unrelated]) {
						await seed.upsert(rec);
					}
					await seed.recordRecallUsage?.({
						bundleId: 'bundle-direct',
						query: 'q',
						scopes: [SCOPE],
						memoryIds: [direct.id],
						scores: [0.9],
						tokenEstimate: 20,
						runId,
						unitId: taskId,
						timestamp: TS,
					});
					// Recorded under a DIFFERENT session so it is never a direct target
					// of this task's sweep, only a propagation candidate (recency is a
					// cross-session signal per the reward-capture module header).
					await seed.recordRecallUsage?.({
						bundleId: 'bundle-sibling',
						query: 'q',
						scopes: [SCOPE],
						memoryIds: [sibling.id],
						scores: [0.8],
						tokenEstimate: 20,
						runId: 'unrelated-session',
						timestamp: '2026-06-20T00:00:00.000Z', // within the 30-day window (recent, cross-session)
					});
					await seed.recordRecallUsage?.({
						bundleId: 'bundle-unrelated',
						query: 'q',
						scopes: [SCOPE],
						memoryIds: [unrelated.id],
						scores: [0.8],
						tokenEstimate: 20,
						runId: 'unrelated-session',
						timestamp: '2026-06-20T00:00:00.000Z',
					});
					await seed.close?.();

					await runFinalizeRewardSweep({
						directory: dir,
						closedTaskIds: [taskId],
						memoryConfig: config,
						timestamp: TS,
					});

					const read = track(createConfiguredMemoryProvider(dir, config));
					// Direct: one 0.0 EMA step, 0.9*0.5 = 0.45.
					expect((await read.get(direct.id))?.metadata.qValue).toBeCloseTo(
						0.45,
						10,
					);
					// Sibling: propagated step = applyEmaUpdate(0.5, 0, eta*fraction) =
					// applyEmaUpdate(0.5, 0, 0.1*0.3=0.03) = 0.97*0.5 = 0.485 (bounded,
					// strictly smaller shift than the direct step).
					const siblingAfter = await read.get(sibling.id);
					expect(siblingAfter?.metadata.qValue).toBeCloseTo(0.485, 10);
					const siblingEvents = await read.listRewardEvents?.({
						memoryId: sibling.id,
					});
					expect(siblingEvents).toHaveLength(1);
					expect(siblingEvents?.[0]?.verdict).toBe(
						'session_terminated_PROPAGATED',
					);
					// Unrelated: below the relatedness bar — UNTOUCHED.
					expect((await read.get(unrelated.id))?.metadata.qValue).toBeCloseTo(
						0.5,
						10,
					);
					expect(
						await read.listRewardEvents?.({ memoryId: unrelated.id }),
					).toEqual([]);
				},
			);
		});
	}
});
