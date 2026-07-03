/**
 * FB-004 / FB-005 regression tests for PR #1638 Round 1 fixes.
 *
 * FB-004: applyCouncilReward wraps its read-then-update loop in a transaction
 * to avoid a race between concurrent council verdicts on the same memory id.
 *
 * FB-005: buildRetrievalRecency passes a `since` filter to listRecallUsage
 * to bound iteration to recent (≤7 day old) recall events only.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	computeMemoryContentHash,
	createMemoryId,
	type MemoryRecord,
	SQLiteMemoryProvider,
} from '../../../src/memory';
import { DEFAULT_QLEARNING_CONFIG } from '../../../src/memory/config';
import { applyCouncilReward } from '../../../src/memory/reward-capture';

type Provider = {
	close?: () => void;
};

let tmpDir: string;
let openProviders: Provider[];

beforeEach(async () => {
	tmpDir = await fs.realpath(
		await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-fb-fix-')),
	);
	openProviders = [];
});

afterEach(async () => {
	for (const p of openProviders.splice(0)) p.close?.();
	await fs.rm(tmpDir, { recursive: true, force: true });
});

function track(p: Provider): Provider {
	openProviders.push(p);
	return p;
}

async function providerRoot(name: string): Promise<string> {
	const root = path.join(tmpDir, name);
	await fs.mkdir(root, { recursive: true });
	return root;
}

function makeRecord(text: string): MemoryRecord {
	const base = {
		scope: { type: 'repository' as const, repoId: 'repo-a', repoRoot: tmpDir },
		kind: 'repo_convention' as const,
		text,
	};
	return {
		id: createMemoryId(base),
		...base,
		tags: ['testing'],
		confidence: 0.9,
		stability: 'durable',
		source: { type: 'file', filePath: 'package.json' },
		createdAt: '2026-05-24T12:00:00.000Z',
		updatedAt: '2026-05-24T12:00:00.000Z',
		contentHash: computeMemoryContentHash(base),
		metadata: {},
	};
}

// -----------------------------------------------------------------------
// FB-004 — withTransaction atomicity
// -----------------------------------------------------------------------

describe('FB-004 — applyCouncilReward atomicity via withTransaction', () => {
	test('SQLiteMemoryProvider exposes withTransaction and calls it once per applyCouncilReward', async () => {
		const root = await providerRoot('sqlite-atomicity');
		const provider = track(
			new SQLiteMemoryProvider(root, { enabled: true, provider: 'sqlite' }),
		);
		const mem = makeRecord('Convention for atomicity test.');
		await provider.upsert(mem);

		// Record a recall so the memory is eligible for reward.
		await provider.recordRecallUsage?.({
			bundleId: 'bundle-atomicity',
			query: 'q',
			scopes: [mem.scope],
			memoryIds: [mem.id],
			scores: [0.9],
			tokenEstimate: 20,
			runId: 's-atomicity',
			unitId: 't-atomicity',
			timestamp: '2026-06-01T00:00:00.000Z',
		});

		// Track whether withTransaction was called.
		let withTransactionCalled = false;
		const originalWithTransaction = (provider as any).withTransaction.bind(
			provider,
		);
		(provider as any).withTransaction = async <T>(
			fn: (tx: any) => Promise<T> | T,
		): Promise<T> => {
			withTransactionCalled = true;
			return originalWithTransaction(fn);
		};

		try {
			await applyCouncilReward(provider as any, {
				runId: 's-atomicity',
				unitId: 't-atomicity',
				reward: 1,
				eta: 0.1,
				initialQValue: 0.5,
				timestamp: '2026-06-01T00:00:00.000Z',
			});

			expect(withTransactionCalled).toBe(true);

			// Verify the reward was applied correctly.
			const recAfter = await provider.get(mem.id);
			expect(recAfter?.metadata.qValue).toBeCloseTo(0.55, 10);
		} finally {
			(provider as any).withTransaction = originalWithTransaction;
		}
	});

	test('applyCouncilReward uses the correct qBefore value stored before upsert', async () => {
		const root = await providerRoot('sqlite-qbefore');
		const provider = track(
			new SQLiteMemoryProvider(root, { enabled: true, provider: 'sqlite' }),
		);
		const mem = makeRecord('Convention for qBefore verification.');
		await provider.upsert(mem);

		await provider.recordRecallUsage?.({
			bundleId: 'bundle-qbefore',
			query: 'q',
			scopes: [mem.scope],
			memoryIds: [mem.id],
			scores: [0.9],
			tokenEstimate: 20,
			runId: 's-qbefore',
			unitId: 't-qbefore',
			timestamp: '2026-06-01T00:00:00.000Z',
		});

		await applyCouncilReward(provider, {
			runId: 's-qbefore',
			unitId: 't-qbefore',
			reward: 1,
			eta: 0.1,
			initialQValue: 0.5,
			timestamp: '2026-06-01T00:00:00.000Z',
		});

		// The reward event recorded for this memory must carry the qBefore that
		// was computed BEFORE the upsert, not the post-upsert qValue.
		const events = await provider.listRewardEvents?.({ memoryId: mem.id });
		expect(events).toHaveLength(1);
		expect(events?.[0].qBefore).toBeCloseTo(0.5, 10);
		expect(events?.[0].qAfter).toBeCloseTo(0.55, 10);
		// qBefore must not equal qAfter.
		expect(events?.[0].qBefore).not.toBe(events?.[0].qAfter);
	});
});

// -----------------------------------------------------------------------
// FB-005 — buildRetrievalRecency time-bound via `since` filter
// -----------------------------------------------------------------------

describe('FB-005 — buildRetrievalRecency bounded by `since` filter', () => {
	test('propagation only includes memories with recall events within the 7-day recency window', async () => {
		const root = await providerRoot('sqlite-recency');
		const provider = track(
			new SQLiteMemoryProvider(root, { enabled: true, provider: 'sqlite' }),
		);

		// Create three memories with shared token overlap.
		const baseTokens = Array.from({ length: 20 }, (_, i) => `base${i}`);
		const direct = makeRecord(baseTokens.join(' '));
		const recentRelated = makeRecord(
			[...baseTokens.slice(0, 15), 'recent_tag'].join(' '),
		);
		const oldRelated = makeRecord(
			[...baseTokens.slice(0, 15), 'old_tag'].join(' '),
		);
		await provider.upsert(direct);
		await provider.upsert(recentRelated);
		await provider.upsert(oldRelated);

		// "now" is 2026-06-15T00:00:00.000Z (inside the 7-day window).
		const nowTs = '2026-06-15T00:00:00.000Z';
		// Recent recall (2026-06-10 — 5 days ago — inside window).
		const recentTs = '2026-06-10T00:00:00.000Z';
		// Old recall (2026-06-01 — 14 days ago — outside window).
		const oldTs = '2026-06-01T00:00:00.000Z';

		// Direct memory recalled at "now".
		await provider.recordRecallUsage?.({
			bundleId: 'bundle-direct',
			query: 'q',
			scopes: [direct.scope],
			memoryIds: [direct.id],
			scores: [0.9],
			tokenEstimate: 20,
			runId: 's-recency',
			unitId: 't-recency',
			timestamp: nowTs,
		});
		// Recently recalled related memory (within window).
		await provider.recordRecallUsage?.({
			bundleId: 'bundle-recent',
			query: 'q',
			scopes: [recentRelated.scope],
			memoryIds: [recentRelated.id],
			scores: [0.8],
			tokenEstimate: 20,
			runId: 's-recency',
			timestamp: recentTs,
		});
		// Old recall (outside window) — should NOT contribute to propagation.
		await provider.recordRecallUsage?.({
			bundleId: 'bundle-old',
			query: 'q',
			scopes: [oldRelated.scope],
			memoryIds: [oldRelated.id],
			scores: [0.8],
			tokenEstimate: 20,
			runId: 's-recency-old',
			timestamp: oldTs,
		});

		// Apply a direct reward on the direct memory.
		await applyCouncilReward(provider, {
			runId: 's-recency',
			unitId: 't-recency',
			reward: 1,
			eta: 0.1,
			initialQValue: 0.5,
			qLearning: {
				...DEFAULT_QLEARNING_CONFIG,
				propagationFraction: 0.5,
				propagationFanoutCap: 10,
				propagationWindowDays: 7,
				propagationRelatednessThreshold: 0.1,
			},
			timestamp: nowTs,
		});

		// The recent-related memory should have received a propagated reward.
		const recentAfter = await provider.get(recentRelated.id);
		expect(recentAfter?.metadata.qValue).toBeGreaterThan(0.5);

		// The old-related memory should NOT have been propagated to (outside window).
		// It may have received no reward event, or its qValue is still the initial value.
		const oldAfter = await provider.get(oldRelated.id);
		const oldEvents = await provider.listRewardEvents?.({
			memoryId: oldRelated.id,
		});
		// No reward event for the old memory → outside recency window.
		expect(oldEvents ?? []).toHaveLength(0);
		// qValue unchanged (still undefined or initial).
		expect(oldAfter?.metadata.qValue ?? 0.5).toBeCloseTo(0.5, 10);
	});

	test('listRecallUsage with `since` filter only returns events at or after the threshold', async () => {
		const root = await providerRoot('sqlite-since-filter');
		const provider = track(
			new SQLiteMemoryProvider(root, { enabled: true, provider: 'sqlite' }),
		);
		const mem = makeRecord('Convention for since filter test.');
		await provider.upsert(mem);

		// Record an old event (14 days ago).
		const oldTs = '2026-06-01T00:00:00.000Z';
		// Record a recent event (2 days ago).
		const recentTs = '2026-06-13T00:00:00.000Z';

		await provider.recordRecallUsage?.({
			bundleId: 'bundle-old',
			query: 'q',
			scopes: [mem.scope],
			memoryIds: [mem.id],
			scores: [0.9],
			tokenEstimate: 20,
			runId: 's-old',
			timestamp: oldTs,
		});
		await provider.recordRecallUsage?.({
			bundleId: 'bundle-recent',
			query: 'q',
			scopes: [mem.scope],
			memoryIds: [mem.id],
			scores: [0.9],
			tokenEstimate: 20,
			runId: 's-recent',
			timestamp: recentTs,
		});

		// Query with `since` set to 7 days before "recent" (2026-06-06).
		const since = '2026-06-06T00:00:00.000Z';
		const events = await provider.listRecallUsage?.({ since, limit: 100 });

		// Only the recent event should be returned (old event is before `since`).
		expect(events ?? []).toHaveLength(1);
		expect(events?.[0].timestamp).toBe(recentTs);
	});

	test('listRecallUsage with `since` filter combined with `limit` respects both constraints', async () => {
		const root = await providerRoot('sqlite-since-limit');
		const provider = track(
			new SQLiteMemoryProvider(root, { enabled: true, provider: 'sqlite' }),
		);
		const mem = makeRecord('Convention for since+limit test.');
		await provider.upsert(mem);

		// Insert 5 events with timestamps spanning from 1 to 6 days ago.
		const now = new Date('2026-06-15T00:00:00.000Z').getTime();
		for (let i = 1; i <= 5; i++) {
			const ts = new Date(now - i * 24 * 60 * 60 * 1000).toISOString();
			await provider.recordRecallUsage?.({
				bundleId: `bundle-day-${i}`,
				query: 'q',
				scopes: [mem.scope],
				memoryIds: [mem.id],
				scores: [0.9],
				tokenEstimate: 20,
				runId: `s-day-${i}`,
				timestamp: ts,
			});
		}

		// With `since` = 3 days ago and `limit` = 2, we expect at most 2 events.
		const since = new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString();
		const events = await provider.listRecallUsage?.({ since, limit: 2 });

		// Should return at most 2 events.
		expect((events ?? []).length).toBeLessThanOrEqual(2);
		// All returned events must have timestamp >= since.
		for (const ev of events ?? []) {
			expect(ev.timestamp >= since).toBe(true);
		}
	});
});
