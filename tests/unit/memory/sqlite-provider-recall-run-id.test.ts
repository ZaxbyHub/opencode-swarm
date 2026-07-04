import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { MemoryRecallUsageEvent } from '../../../src/memory';
import { SQLiteMemoryProvider } from '../../../src/memory';

// ---------------------------------------------------------------------------
// Regression coverage for A.2 (migration v7 — add_reward_events_and_recall_run_id).
//
// These tests exercise the BEHAVIORAL surface introduced by v7 that is not
// covered by the schema-existence checks in sqlite-provider-vec.test.ts:
//   - backfillRecallRunIds() one-time backfill of pre-existing NULL run_id rows
//   - graceful skip of unparseable / runId-less rows during backfill
//   - idempotency of the backfill guard across re-init
//   - write-side run_id population via recordRecallUsage
//   - listRecallUsage({ runId }) filter matrix (with limit + ordering)
// ---------------------------------------------------------------------------

let tmpDir: string;
const openProviders: SQLiteMemoryProvider[] = [];
const openHandles: Database[] = [];

beforeEach(async () => {
	tmpDir = await fs.realpath(
		await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-memory-run-id-')),
	);
	openProviders.length = 0;
	openHandles.length = 0;
});

afterEach(async () => {
	for (const handle of openHandles.splice(0)) {
		try {
			handle.close();
		} catch {
			// already closed
		}
	}
	for (const provider of openProviders.splice(0)) {
		try {
			provider.close();
		} catch {
			// already closed
		}
	}
	await fs.rm(tmpDir, { recursive: true, force: true });
});

function track(provider: SQLiteMemoryProvider): SQLiteMemoryProvider {
	openProviders.push(provider);
	return provider;
}

function trackHandle(db: Database): Database {
	openHandles.push(db);
	return db;
}

async function providerRoot(name: string): Promise<string> {
	const root = path.join(tmpDir, name);
	await fs.mkdir(root, { recursive: true });
	return root;
}

function dbPathFor(root: string): string {
	return path.join(root, '.swarm', 'memory', 'memory.db');
}

function makeUsageEvent(
	overrides: Partial<MemoryRecallUsageEvent> = {},
): MemoryRecallUsageEvent {
	return {
		bundleId: 'bundle_default',
		query: 'default query',
		scopes: [{ type: 'repository', repoId: 'repo-run-id' }],
		kinds: ['repo_convention'],
		memoryIds: ['mem_0000000000000001'],
		scores: [0.5],
		tokenEstimate: 42,
		agentRole: 'coder',
		timestamp: '2026-01-01T00:00:00.000Z',
		...overrides,
	};
}

/**
 * Directly inserts a row into memory_recall_usage bypassing recordRecallUsage,
 * simulating a pre-v7 row whose run_id column was never populated at write
 * time (the exact shape backfillRecallRunIds() is meant to repair).
 */
function insertRawUsageRow(
	db: Database,
	id: string,
	usageJson: string,
	bundleId = 'bundle_raw',
	timestamp = '2026-01-01T00:00:00.000Z',
): void {
	db.run(
		`INSERT INTO memory_recall_usage (
			id, bundle_id, timestamp, usage_json, run_id
		) VALUES (?, ?, ?, ?, NULL)`,
		[id, bundleId, timestamp, usageJson],
	);
}

function resetBackfillGuard(db: Database): void {
	db.run("DELETE FROM _meta WHERE key = 'recall_run_id_backfilled'");
}

function readRunId(db: Database, id: string): string | null {
	const row = db
		.query<{ run_id: string | null }, [string]>(
			'SELECT run_id FROM memory_recall_usage WHERE id = ?',
		)
		.get(id);
	return row?.run_id ?? null;
}

// ---------------------------------------------------------------------------
// 1. Backfill of pre-existing NULL-run_id rows (critical path)
// ---------------------------------------------------------------------------
describe('backfillRecallRunIds — backfills pre-existing NULL run_id rows', () => {
	test('a NULL run_id row with runId embedded in usage_json is backfilled on next init', async () => {
		const root = await providerRoot('backfill-basic');
		const provider = track(
			new SQLiteMemoryProvider(root, { enabled: true, provider: 'sqlite' }),
		);
		await provider.initialize();
		provider.close();

		const dbPath = dbPathFor(root);
		const raw = trackHandle(new Database(dbPath));
		const rowId = 'raw-row-1';
		const usageEvent = makeUsageEvent({
			bundleId: 'bundle_backfilled',
			runId: 'sess-backfilled',
			memoryIds: ['mem_0000000000000002'],
		});
		insertRawUsageRow(
			raw,
			rowId,
			JSON.stringify(usageEvent),
			'bundle_backfilled',
		);

		// Falsifiability: prove the row genuinely starts NULL before backfill runs.
		expect(readRunId(raw, rowId)).toBeNull();

		resetBackfillGuard(raw);
		raw.close();
		openHandles.splice(openHandles.indexOf(raw), 1);

		const provider2 = track(
			new SQLiteMemoryProvider(root, { enabled: true, provider: 'sqlite' }),
		);
		await provider2.initialize();

		const results = await provider2.listRecallUsage!({
			runId: 'sess-backfilled',
		});
		expect(results).toHaveLength(1);
		expect(results[0]?.bundleId).toBe('bundle_backfilled');

		provider2.close();

		// Direct column check confirms the backfill wrote the column (not just
		// that usage_json happened to already contain the runId — the filter
		// operates on the run_id COLUMN, not on parsed JSON).
		const verify = trackHandle(new Database(dbPath, { readonly: true }));
		expect(readRunId(verify, rowId)).toBe('sess-backfilled');
	});
});

// ---------------------------------------------------------------------------
// 2. Unparseable / runId-less rows are skipped, not fatal
// ---------------------------------------------------------------------------
describe('backfillRecallRunIds — tolerates unparseable and runId-less rows', () => {
	test('malformed JSON and missing-runId rows do not throw and remain NULL', async () => {
		const root = await providerRoot('backfill-tolerant');
		const provider = track(
			new SQLiteMemoryProvider(root, { enabled: true, provider: 'sqlite' }),
		);
		await provider.initialize();
		provider.close();

		const dbPath = dbPathFor(root);
		const raw = trackHandle(new Database(dbPath));
		insertRawUsageRow(raw, 'bad-json-row', '{not json', 'bundle_bad_json');
		const noRunIdEvent = makeUsageEvent({
			bundleId: 'bundle_no_run_id',
			memoryIds: ['mem_0000000000000003'],
		});
		// makeUsageEvent has no runId by default — confirm that explicitly.
		expect(noRunIdEvent.runId).toBeUndefined();
		insertRawUsageRow(
			raw,
			'no-run-id-row',
			JSON.stringify(noRunIdEvent),
			'bundle_no_run_id',
		);
		resetBackfillGuard(raw);
		raw.close();
		openHandles.splice(openHandles.indexOf(raw), 1);

		const provider2 = track(
			new SQLiteMemoryProvider(root, { enabled: true, provider: 'sqlite' }),
		);
		// Must not throw despite one row containing invalid JSON.
		await expect(provider2.initialize()).resolves.toBeUndefined();
		provider2.close();

		const verify = trackHandle(new Database(dbPath, { readonly: true }));
		expect(readRunId(verify, 'bad-json-row')).toBeNull();
		expect(readRunId(verify, 'no-run-id-row')).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// 3. Idempotency of the backfill guard
// ---------------------------------------------------------------------------
describe('backfillRecallRunIds — one-time guard prevents re-scan', () => {
	test('a NULL run_id row inserted after the guard is stamped is NOT backfilled on re-init', async () => {
		const root = await providerRoot('backfill-idempotent');
		const provider = track(
			new SQLiteMemoryProvider(root, { enabled: true, provider: 'sqlite' }),
		);
		// First init: table is empty, backfill scans 0 rows and stamps the guard to '1'.
		await provider.initialize();
		provider.close();

		const dbPath = dbPathFor(root);
		const raw = trackHandle(new Database(dbPath));
		// Confirm the guard really is stamped before we proceed — otherwise this
		// test would pass vacuously regardless of guard behavior.
		const guardRow = raw
			.query<{ value: string }, []>(
				"SELECT value FROM _meta WHERE key = 'recall_run_id_backfilled'",
			)
			.get();
		expect(guardRow?.value).toBe('1');

		const lateEvent = makeUsageEvent({
			bundleId: 'bundle_late',
			runId: 'sess-late',
			memoryIds: ['mem_0000000000000004'],
		});
		// Insert WITHOUT resetting the guard — this simulates a NULL row that
		// appears after backfill already completed once (should never happen in
		// practice since recordRecallUsage always sets run_id, but proves the
		// guard, not luck, is what prevents re-scanning).
		insertRawUsageRow(
			raw,
			'late-row',
			JSON.stringify(lateEvent),
			'bundle_late',
		);
		expect(readRunId(raw, 'late-row')).toBeNull();
		raw.close();
		openHandles.splice(openHandles.indexOf(raw), 1);

		const provider2 = track(
			new SQLiteMemoryProvider(root, { enabled: true, provider: 'sqlite' }),
		);
		await expect(provider2.initialize()).resolves.toBeUndefined();
		provider2.close();

		const verify = trackHandle(new Database(dbPath, { readonly: true }));
		// Guard prevented the scan — the late row must remain NULL even though
		// its usage_json contains a perfectly parseable runId.
		expect(readRunId(verify, 'late-row')).toBeNull();

		// Schema version must not regress or re-apply migration 7 on re-init.
		const migrationCount = verify
			.query<{ cnt: number }, []>(
				"SELECT COUNT(*) as cnt FROM schema_migrations WHERE name = 'add_reward_events_and_recall_run_id'",
			)
			.get();
		expect(migrationCount?.cnt).toBe(1);
		const maxVersion = verify
			.query<{ version: number }, []>(
				'SELECT MAX(version) as version FROM schema_migrations',
			)
			.get();
		// Highest applied migration. Advances as additive migrations are added
		// (v8 add_recall_usage_unit_id — B.1). The invariant under test is that
		// migration 7 is applied exactly once (asserted above), not that 7 is the
		// terminal version.
		expect(maxVersion?.version).toBe(8);
	});
});

// ---------------------------------------------------------------------------
// 4. Write-side — recordRecallUsage populates run_id immediately
// ---------------------------------------------------------------------------
describe('recordRecallUsage — populates run_id column at write time', () => {
	test('a freshly recorded event with a runId is immediately queryable by runId (no backfill needed)', async () => {
		const root = await providerRoot('write-side-run-id');
		const provider = track(
			new SQLiteMemoryProvider(root, { enabled: true, provider: 'sqlite' }),
		);
		await provider.initialize();

		await provider.recordRecallUsage!(
			makeUsageEvent({
				bundleId: 'bundle_w1',
				runId: 'w1',
				memoryIds: ['mem_0000000000000005'],
			}),
		);

		const results = await provider.listRecallUsage!({ runId: 'w1' });
		expect(results).toHaveLength(1);
		expect(results[0]?.bundleId).toBe('bundle_w1');

		// Direct column check — the guard/backfill path is entirely bypassed
		// because recordRecallUsage binds run_id on INSERT.
		provider.close();
		const verify = trackHandle(
			new Database(dbPathFor(root), { readonly: true }),
		);
		const row = verify
			.query<{ run_id: string | null }, []>(
				"SELECT run_id FROM memory_recall_usage WHERE bundle_id = 'bundle_w1'",
			)
			.get();
		expect(row?.run_id).toBe('w1');
	});
});

// ---------------------------------------------------------------------------
// 5. listRecallUsage({ runId, limit }) filter matrix
// ---------------------------------------------------------------------------
describe('listRecallUsage — runId + limit filter matrix', () => {
	async function seedThreeEvents(
		provider: SQLiteMemoryProvider,
	): Promise<void> {
		// Distinct timestamps so DESC ordering is unambiguous.
		await provider.recordRecallUsage!(
			makeUsageEvent({
				bundleId: 'bundle-a1',
				runId: 'a',
				timestamp: '2026-01-01T00:00:00.000Z',
			}),
		);
		await provider.recordRecallUsage!(
			makeUsageEvent({
				bundleId: 'bundle-b1',
				runId: 'b',
				timestamp: '2026-01-02T00:00:00.000Z',
			}),
		);
		await provider.recordRecallUsage!(
			makeUsageEvent({
				bundleId: 'bundle-a2',
				runId: 'a',
				timestamp: '2026-01-03T00:00:00.000Z',
			}),
		);
	}

	test('runId alone returns only matching-run rows, ordered timestamp DESC', async () => {
		const root = await providerRoot('filter-matrix-runid-only');
		const provider = track(
			new SQLiteMemoryProvider(root, { enabled: true, provider: 'sqlite' }),
		);
		await provider.initialize();
		await seedThreeEvents(provider);

		const results = await provider.listRecallUsage!({ runId: 'a' });
		expect(results.map((r) => r.bundleId)).toEqual(['bundle-a2', 'bundle-a1']);
	});

	test('runId + limit narrows to the most recent N matching rows', async () => {
		const root = await providerRoot('filter-matrix-runid-limit');
		const provider = track(
			new SQLiteMemoryProvider(root, { enabled: true, provider: 'sqlite' }),
		);
		await provider.initialize();
		await seedThreeEvents(provider);

		const limited = await provider.listRecallUsage!({ runId: 'a', limit: 1 });
		expect(limited.map((r) => r.bundleId)).toEqual(['bundle-a2']);

		// limit=0 is clamped to a minimum of 1 (Math.max(1, Math.trunc(limit)))
		// — documents the actual, slightly surprising, contract rather than
		// assuming 0 means "unbounded" or "empty".
		const zeroLimited = await provider.listRecallUsage!({
			runId: 'a',
			limit: 0,
		});
		expect(zeroLimited.map((r) => r.bundleId)).toEqual(['bundle-a2']);
	});

	test('limit alone (no runId) returns the most recent N rows across all runs', async () => {
		const root = await providerRoot('filter-matrix-limit-only');
		const provider = track(
			new SQLiteMemoryProvider(root, { enabled: true, provider: 'sqlite' }),
		);
		await provider.initialize();
		await seedThreeEvents(provider);

		const results = await provider.listRecallUsage!({ limit: 2 });
		expect(results.map((r) => r.bundleId)).toEqual(['bundle-a2', 'bundle-b1']);
	});

	test('no filter returns all rows ordered timestamp DESC', async () => {
		const root = await providerRoot('filter-matrix-none');
		const provider = track(
			new SQLiteMemoryProvider(root, { enabled: true, provider: 'sqlite' }),
		);
		await provider.initialize();
		await seedThreeEvents(provider);

		const results = await provider.listRecallUsage!({});
		expect(results.map((r) => r.bundleId)).toEqual([
			'bundle-a2',
			'bundle-b1',
			'bundle-a1',
		]);
	});
});
