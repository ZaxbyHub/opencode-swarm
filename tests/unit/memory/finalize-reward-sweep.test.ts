/**
 * B.6 — deterministic negative-terminal reward sweep at finalize.
 *
 * Unit tests for `runFinalizeRewardSweep` (the extracted, testable sweep) plus
 * a structural insertion-point assertion against `src/commands/close.ts`.
 *
 * Coverage (see task B.6 spec, FR-001 negative / FR-006 / SC-007):
 *   1. SC-007 end-to-end (both providers): a memory recalled into a
 *      non-completed task earns a 0.0 EMA step (q moves DOWNWARD), a reward
 *      event with reward 0.0 is appended, and once q crosses
 *      suppressionThreshold the memory is EXCLUDED from a subsequent default
 *      recall (with a positive control: it IS recalled before the sweep).
 *   2. Disjointness (same session): a memory recalled ONLY into a COMPLETED
 *      task is UNTOUCHED even when it shares a work session with a swept task
 *      — the unitId narrowing inside applyCouncilReward protects it.
 *   3. No-recall closed task → no-op (no reward events, no throw).
 *   4. Multi-runId: a memory recalled into the SAME closed task across two
 *      work sessions gets one 0.0 step PER runId (documented behavior).
 *   5. Memory disabled → complete no-op (provider never created).
 *   6. Non-blocking: a provider that throws does NOT propagate out of the sweep.
 *   7. Structural ordering: the sweep is invoked AFTER runFinalizeStage
 *      (closedTaskIds populated) and BEFORE runAlignStage (destructive git).
 *   8. Blast-radius pin (accepted behavior, module-header multiplicity #2): a
 *      runId shared by a taskId-tagged bundle AND an untagged bundle penalizes
 *      the untagged bundle's memory too, via the B.2 run_id fallback.
 *   9. Negative propagation: a Jaccard-related, recently-retrieved sibling of a
 *      swept memory receives a bounded downward propagated step; an unrelated
 *      memory does not.
 *  10. No-runId skip: a bundle tagged with the taskId but with no runId does
 *      NOT invoke `applyCouncilReward` (the defensive skip path).
 *  11. verdictLabel: sweep events are labeled `'session_terminated'`, not the
 *      shared reward path's misleading default `'APPROVE'`.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
	computeMemoryContentHash,
	createConfiguredMemoryProvider,
	createMemoryId,
	DEFAULT_MEMORY_CONFIG,
	type MemoryProvider,
	type MemoryRecord,
	type RecallRequest,
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
// Text carries the 4 query tokens verbatim so it scores well above minScore.
const QUERY = 'database connection pool timeout';
const RECALLABLE_TEXT =
	'The database connection pool timeout retry uses exponential backoff.';

// eta 0.1 (default), suppressionThreshold 0.15 (default). A seed q of 0.16 is
// ABOVE the threshold (recallable) but a single 0.0 EMA step lands at
// 0.9*0.16 = 0.144 < 0.15 (suppressed). This pins SC-007 arithmetic exactly.
const SEED_Q_JUST_ABOVE = 0.16;
const EXPECTED_Q_AFTER = 0.144;

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
	// Restore DI seams in case a test overrode them.
	_internals.createConfiguredMemoryProvider = createConfiguredMemoryProvider;
	_internals.applyCouncilReward = applyCouncilReward;
	// Release sqlite pool handles BEFORE removing temp dirs (Windows EBUSY guard).
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
		// C.1 (FR-014/SC-016) adds a bounded, probabilistic active-exploration
		// layer (explorationRate, default 0.05) on top of A.6 suppression,
		// drawn from real `Math.random` in production `provider.recall()`
		// calls. This suite asserts exact suppression/reward-sweep outcomes
		// (e.g. "suppressed record NOT in a later recall"), so exploration
		// must be pinned off here — otherwise a real-random draw could
		// resurface a suppressed memory and flake this suite (~5% per assertion).
		qLearning: { ...DEFAULT_MEMORY_CONFIG.qLearning, explorationRate: 0 },
	};
}

function buildRecord(text: string, qValue: number): MemoryRecord {
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

function recallRequest(): RecallRequest {
	return {
		query: QUERY,
		mode: 'manual',
		scopes: [SCOPE],
		maxItems: 5,
		tokenBudget: 2000,
		minScore: 0,
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

describe('runFinalizeRewardSweep — real providers (FR-001 negative / FR-006 / SC-007)', () => {
	for (const providerName of providersToRun) {
		describe(`provider: ${providerName}`, () => {
			test('SC-007: negative reward drives q down, appends a 0.0 reward event, and suppresses the memory from a later default recall', async () => {
				const { dir } = createSafeTestDir(`b6-sc007-${providerName}-`);
				tempRoots.push(dir);
				const config = makeConfig(providerName);
				const rec = buildRecord(RECALLABLE_TEXT, SEED_Q_JUST_ABOVE);
				const taskId = 'task-terminated';
				const runId = 'work-session-1';

				// Seed: record + a recall bundle attributing it to the closed task.
				const seed = track(createConfiguredMemoryProvider(dir, config));
				await seed.upsert(rec);
				await seed.recordRecallUsage?.({
					bundleId: 'bundle-1',
					query: QUERY,
					scopes: [SCOPE],
					memoryIds: [rec.id],
					scores: [0.9],
					tokenEstimate: 50,
					runId,
					unitId: taskId,
					timestamp: TS,
				});

				// Positive control: BEFORE the sweep the memory is recallable
				// (q 0.16 >= 0.15). Without this the post-sweep exclusion is vacuous.
				const before = await seed.recall(recallRequest());
				expect(before.map((i) => i.record.id)).toContain(rec.id);
				await seed.close?.();

				const result = await runFinalizeRewardSweep({
					directory: dir,
					closedTaskIds: [taskId],
					memoryConfig: config,
					timestamp: TS,
				});
				expect(result.swept).toBe(true);
				expect(result.tasksSwept).toBe(1);
				expect(result.memoriesRewarded).toBe(1);
				expect(result.runIdsProcessed).toBe(1);

				// Fresh provider re-reads persisted state (local-jsonl reloads its
				// in-memory map from file; sqlite reads the DB).
				const read = track(createConfiguredMemoryProvider(dir, config));
				const after = await read.get(rec.id);
				expect(after?.metadata.qValue).toBeCloseTo(EXPECTED_Q_AFTER, 10);

				const events = await read.listRewardEvents?.({ memoryId: rec.id });
				expect(events).toHaveLength(1);
				expect(events?.[0]).toMatchObject({
					memoryId: rec.id,
					unitId: taskId,
					reward: FINALIZE_NEGATIVE_TERMINAL_REWARD,
					qBefore: SEED_Q_JUST_ABOVE,
					// verdictLabel threading (Fix 2): the sweep's true reason, not
					// the misleading hardcoded 'APPROVE' default.
					verdict: 'session_terminated',
				});
				expect(events?.[0]?.qAfter).toBeCloseTo(EXPECTED_Q_AFTER, 10);

				// FR-006: q now below suppressionThreshold → excluded from recall.
				const afterRecall = await read.recall(recallRequest());
				expect(afterRecall.map((i) => i.record.id)).not.toContain(rec.id);
			});

			test('disjointness: a memory recalled ONLY into a COMPLETED task is untouched even when it shares a work session with a swept task', async () => {
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
			});

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

			test('multi-runId: a memory recalled into the same closed task across two work sessions gets one 0.0 step PER runId (documented behavior)', async () => {
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
			});

			test('blast-radius pin: an UNTAGGED bundle sharing a runId with a taskId-tagged bundle is ALSO penalized (accepted run_id-fallback behavior)', async () => {
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
			});

			test('negative propagation: a Jaccard-related, recently-retrieved sibling of a swept memory receives a bounded downward propagated step; an unrelated memory does not', async () => {
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
					timestamp: '2026-05-25T00:00:00.000Z', // within the 30-day window
				});
				await seed.recordRecallUsage?.({
					bundleId: 'bundle-unrelated',
					query: 'q',
					scopes: [SCOPE],
					memoryIds: [unrelated.id],
					scores: [0.8],
					tokenEstimate: 20,
					runId: 'unrelated-session',
					timestamp: '2026-05-25T00:00:00.000Z',
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
			});
		});
	}
});

describe('runFinalizeRewardSweep — control paths', () => {
	test('memory disabled → complete no-op, provider is never created', async () => {
		let created = 0;
		_internals.createConfiguredMemoryProvider = (() => {
			created++;
			throw new Error('provider must not be created when memory is disabled');
		}) as typeof createConfiguredMemoryProvider;

		const undefinedResult = await runFinalizeRewardSweep({
			directory: '/nonexistent',
			closedTaskIds: ['t1'],
			memoryConfig: undefined,
		});
		expect(undefinedResult).toEqual({
			swept: false,
			tasksSwept: 0,
			memoriesRewarded: 0,
			runIdsProcessed: 0,
		});

		const disabledResult = await runFinalizeRewardSweep({
			directory: '/nonexistent',
			closedTaskIds: ['t1'],
			memoryConfig: { ...DEFAULT_MEMORY_CONFIG, enabled: false },
		});
		expect(disabledResult.swept).toBe(false);
		expect(created).toBe(0);
	});

	test('all-empty closedTaskIds → no-op, provider is never created', async () => {
		let created = 0;
		_internals.createConfiguredMemoryProvider = (() => {
			created++;
			throw new Error('provider must not be created with no valid task ids');
		}) as typeof createConfiguredMemoryProvider;

		const result = await runFinalizeRewardSweep({
			directory: '/nonexistent',
			closedTaskIds: ['', ''],
			memoryConfig: { ...DEFAULT_MEMORY_CONFIG, enabled: true },
		});
		expect(result.swept).toBe(false);
		expect(created).toBe(0);
	});

	test('non-blocking: a provider whose listRecallUsage throws does NOT propagate out of the sweep', async () => {
		_internals.createConfiguredMemoryProvider = (() =>
			({
				listRecallUsage: async () => {
					throw new Error('boom');
				},
				close: () => {},
			}) as unknown as ReturnType<
				typeof createConfiguredMemoryProvider
			>) as typeof createConfiguredMemoryProvider;

		const result = await runFinalizeRewardSweep({
			directory: '/nonexistent',
			closedTaskIds: ['task-fail'],
			memoryConfig: { ...DEFAULT_MEMORY_CONFIG, enabled: true },
			timestamp: TS,
		});
		// swept flips true before the loop; the throw is swallowed; no reward.
		expect(result.swept).toBe(true);
		expect(result.tasksSwept).toBe(0);
		expect(result.memoriesRewarded).toBe(0);
	});

	test('non-blocking: a provider-factory that throws does NOT propagate out of the sweep', async () => {
		_internals.createConfiguredMemoryProvider = (() => {
			throw new Error('factory boom');
		}) as typeof createConfiguredMemoryProvider;

		const result = await runFinalizeRewardSweep({
			directory: '/nonexistent',
			closedTaskIds: ['task-fail'],
			memoryConfig: { ...DEFAULT_MEMORY_CONFIG, enabled: true },
			timestamp: TS,
		});
		expect(result.swept).toBe(false);
		expect(result.memoriesRewarded).toBe(0);
	});

	test('no-runId skip: a bundle tagged with the taskId but no runId does NOT invoke applyCouncilReward; the memory is untouched', async () => {
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
	});
});

describe('close.ts insertion point (persistence ordering)', () => {
	test('the sweep is invoked AFTER runFinalizeStage and BEFORE runAlignStage', async () => {
		const closePath = path.resolve(
			import.meta.dir,
			'../../../src/commands/close.ts',
		);
		const source = await fs.readFile(closePath, 'utf-8');
		const finalizeIdx = source.indexOf('await runFinalizeStage(ctx)');
		const sweepIdx = source.indexOf('_internals.runFinalizeRewardSweep({');
		const alignIdx = source.indexOf('await runAlignStage(ctx)');
		expect(finalizeIdx).toBeGreaterThan(-1);
		expect(sweepIdx).toBeGreaterThan(-1);
		expect(alignIdx).toBeGreaterThan(-1);
		// closedTaskIds is populated in runFinalizeStage; the destructive git
		// reset lives in runAlignStage. The sweep must sit strictly between them.
		expect(sweepIdx).toBeGreaterThan(finalizeIdx);
		expect(sweepIdx).toBeLessThan(alignIdx);
	});
});
