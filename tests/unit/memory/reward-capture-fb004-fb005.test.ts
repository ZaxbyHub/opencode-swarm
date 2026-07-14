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
import { freezeClock } from '../../helpers/test-clock.js';

type Provider = {
	close?: () => void;
};

let tmpDir: string;
let openProviders: Provider[];
let restoreClock: (() => void) | undefined;

beforeEach(async () => {
	// Freeze Date.now deterministically. The FB-005 block builds recall-event
	// timestamps from explicit fixed dates (`new Date('2026-06-15...')`), which
	// are unaffected; this pins any incidental now-reads so time-sensitive
	// assertions never flake (invariant 7 / test-clock).
	restoreClock = freezeClock({ fixedNow: 1_781_740_800_000 });
	tmpDir = await fs.realpath(
		await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-fb-fix-')),
	);
	openProviders = [];
});

afterEach(async () => {
	for (const p of openProviders.splice(0)) p.close?.();
	await fs.rm(tmpDir, { recursive: true, force: true });
	restoreClock?.();
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

// -----------------------------------------------------------------------
// M2 — withTransaction is async-safe (real BEGIN/COMMIT/ROLLBACK atomicity)
// -----------------------------------------------------------------------

describe('M2 — withTransaction async-safe atomicity', () => {
	test('rolls back an awaited write when the async callback throws', async () => {
		const root = await providerRoot('m2-rollback');
		const provider = track(
			new SQLiteMemoryProvider(root, { enabled: true, provider: 'sqlite' }),
		) as any;
		await provider.initialize();
		const db = provider.requireDb();
		db.run('CREATE TABLE IF NOT EXISTS m2_scratch (id TEXT PRIMARY KEY)');

		await expect(
			provider.withTransaction(async () => {
				db.run("INSERT INTO m2_scratch (id) VALUES ('rollback-me')");
				// Async boundary: with the old sync db.transaction() impl this INSERT
				// would have COMMITTED before the throw was ever observed, so the row
				// would persist. The manual BEGIN/COMMIT/ROLLBACK must revert it.
				await Promise.resolve();
				throw new Error('m2-boom');
			}),
		).rejects.toThrow('m2-boom');

		const count = db.query('SELECT COUNT(*) AS c FROM m2_scratch').get()
			.c as number;
		expect(count).toBe(0);
		// Transaction was fully unwound (no dangling open transaction).
		expect(db.inTransaction).toBe(false);
	});

	test('commits an awaited write when the async callback resolves', async () => {
		const root = await providerRoot('m2-commit');
		const provider = track(
			new SQLiteMemoryProvider(root, { enabled: true, provider: 'sqlite' }),
		) as any;
		await provider.initialize();
		const db = provider.requireDb();
		db.run('CREATE TABLE IF NOT EXISTS m2_scratch (id TEXT PRIMARY KEY)');

		const returned = await provider.withTransaction(async () => {
			db.run("INSERT INTO m2_scratch (id) VALUES ('commit-me')");
			await Promise.resolve();
			return 'ok';
		});

		expect(returned).toBe('ok');
		const count = db.query('SELECT COUNT(*) AS c FROM m2_scratch').get()
			.c as number;
		expect(count).toBe(1);
		expect(db.inTransaction).toBe(false);
	});
});

// -----------------------------------------------------------------------
// M14 — SQLite handle is closed and nulled when init fails after open
// -----------------------------------------------------------------------

describe('M14 — init-failure closes and nulls the db handle', () => {
	test('closes the opened handle and nulls this.db when a post-open step throws, and retry re-opens without leaking', async () => {
		const root = await providerRoot('m14-init-throw');
		const provider = track(
			new SQLiteMemoryProvider(root, { enabled: true, provider: 'sqlite' }),
		) as any;

		// Force a post-open init step (runMigrations) to throw, capturing the
		// exact native handle doInitialize opened and spying its close() so we can
		// prove the leaked handle was actually closed (not just nulled).
		let openedHandle: unknown = null;
		let closedHandle: unknown = null;
		provider.runMigrations = function (this: any) {
			const db = this.db;
			openedHandle = db;
			const origClose = db.close.bind(db);
			db.close = () => {
				closedHandle = db;
				return origClose();
			};
			throw new Error('m14-migration-boom');
		};

		await expect(provider.initialize()).rejects.toThrow('m14-migration-boom');

		// The just-opened native handle was closed (no leak) and this.db nulled.
		expect(openedHandle).not.toBeNull();
		expect(closedHandle).toBe(openedHandle);
		expect(provider.db).toBeNull();
		expect(provider.ftsAvailable).toBe(false);

		// Retry with the real runMigrations restored: must open a FRESH handle and
		// succeed — proving the earlier failure did not leave a leaked/leftover
		// handle and did not double-open.
		delete provider.runMigrations; // fall back to the prototype implementation
		await provider.initialize();
		expect(provider.db).not.toBeNull();
		expect(provider.db).not.toBe(openedHandle);

		// Provider is fully usable after recovery.
		const mem = makeRecord('Recovered after init failure.');
		await provider.upsert(mem);
		expect((await provider.get(mem.id))?.id).toBe(mem.id);
	});

	test('resets initialized when a throw occurs AFTER initialized=true, so retry re-opens (no permanent wedge)', async () => {
		const root = await providerRoot('m14-post-init-throw');
		const provider = track(
			new SQLiteMemoryProvider(root, { enabled: true, provider: 'sqlite' }),
		) as any;

		// Force the post-`initialized = true` telemetry path to throw: make
		// loadMemories report an invalid row (so the `invalid_load` event fires)
		// and make event() throw at that point. This reproduces a SQLITE_BUSY/IOERR
		// on the telemetry insert that runs AFTER this.initialized = true.
		provider.loadMemories = () => ({ records: [], invalidCount: 1 });
		provider.event = async () => {
			throw new Error('m14-post-init-boom');
		};

		await expect(provider.initialize()).rejects.toThrow('m14-post-init-boom');

		// The handle is closed/nulled AND initialized is reset — otherwise the
		// `if (this.initialized) return;` short-circuit would wedge the provider.
		expect(provider.db).toBeNull();
		expect(provider.initialized).toBe(false);

		// Retry with the real implementations restored: must re-open and succeed.
		delete provider.loadMemories;
		delete provider.event;
		await provider.initialize();
		expect(provider.db).not.toBeNull();

		const mem = makeRecord('Recovered after post-init failure.');
		await provider.upsert(mem);
		expect((await provider.get(mem.id))?.id).toBe(mem.id);
	});
});
