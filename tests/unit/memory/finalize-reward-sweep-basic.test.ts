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
 *   2. Control paths: memory disabled → complete no-op (provider never created),
 *      all-empty closedTaskIds → no-op, non-blocking error isolation for both
 *      listRecallUsage throws and factory throws.
 *   3. Close.ts insertion point: sweep is invoked AFTER runFinalizeStage
 *      (closedTaskIds populated) and BEFORE runAlignStage (destructive git).
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

describe('runFinalizeRewardSweep — SC-007 end-to-end (FR-001 negative / FR-006 / SC-007)', () => {
	for (const providerName of providersToRun) {
		describe(`provider: ${providerName}`, () => {
			test(
				'SC-007: negative reward drives q down, appends a 0.0 reward event, ' +
					'and suppresses the memory from a later default recall',
				async () => {
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
				},
			);
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
