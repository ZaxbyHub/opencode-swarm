import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { MemoryRecallUsageEvent } from '../../../src/memory';
import { SQLiteMemoryProvider } from '../../../src/memory';

// ---------------------------------------------------------------------------
// B.1 (migration v8 — add_recall_usage_unit_id) coverage.
//
// unit_id is an ADDITIVE join key added ALONGSIDE run_id. These tests pin the
// SQLite-specific mechanics not covered by the cross-provider join test:
//   - migration v8 applies exactly once and does not regress the max version
//   - the unit_id column + index exist post-migration
//   - recordRecallUsage binds unit_id at write time (queryable immediately)
//   - listRecallUsage({ unitId }) filters on the COLUMN; { runId, unitId } ANDs
//   - a row written with NO unitId persists unit_id = NULL (graceful degrade)
//     and is unreachable by any unitId filter yet still found by runId
//   - unlike run_id, there is NO backfill: a raw pre-existing row stays NULL
// ---------------------------------------------------------------------------

let tmpDir: string;
const openProviders: SQLiteMemoryProvider[] = [];
const openHandles: Database[] = [];

beforeEach(async () => {
	tmpDir = await fs.realpath(
		await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-memory-unit-id-')),
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
		scopes: [{ type: 'repository', repoId: 'repo-unit-id' }],
		kinds: ['repo_convention'],
		memoryIds: ['mem_0000000000000001'],
		scores: [0.5],
		tokenEstimate: 42,
		agentRole: 'coder',
		timestamp: '2026-01-01T00:00:00.000Z',
		...overrides,
	};
}

function readUnitId(db: Database, bundleId: string): string | null {
	const row = db
		.query<{ unit_id: string | null }, [string]>(
			'SELECT unit_id FROM memory_recall_usage WHERE bundle_id = ?',
		)
		.get(bundleId);
	return row?.unit_id ?? null;
}

// ---------------------------------------------------------------------------
// 1. Migration v8 applies, is idempotent, and adds the column + index
// ---------------------------------------------------------------------------
describe('migration v8 — add_recall_usage_unit_id', () => {
	test('applies exactly once, advances max version to 8, and adds unit_id column + index', async () => {
		const root = await providerRoot('migration-v8');
		const provider = track(
			new SQLiteMemoryProvider(root, { enabled: true, provider: 'sqlite' }),
		);
		await provider.initialize();
		provider.close();

		// Re-init to prove the migration does not re-apply.
		const provider2 = track(
			new SQLiteMemoryProvider(root, { enabled: true, provider: 'sqlite' }),
		);
		await provider2.initialize();
		provider2.close();

		const verify = trackHandle(
			new Database(dbPathFor(root), { readonly: true }),
		);

		const migrationCount = verify
			.query<{ cnt: number }, []>(
				"SELECT COUNT(*) as cnt FROM schema_migrations WHERE name = 'add_recall_usage_unit_id'",
			)
			.get();
		expect(migrationCount?.cnt).toBe(1);

		const maxVersion = verify
			.query<{ version: number }, []>(
				'SELECT MAX(version) as version FROM schema_migrations',
			)
			.get();
		expect(maxVersion?.version).toBe(8);

		const columns = verify
			.query<{ name: string }, []>('PRAGMA table_info(memory_recall_usage)')
			.all();
		expect(columns.some((c) => c.name === 'unit_id')).toBe(true);
		// run_id must remain intact (additive, not replacing).
		expect(columns.some((c) => c.name === 'run_id')).toBe(true);

		const indexes = verify
			.query<{ name: string }, []>('PRAGMA index_list(memory_recall_usage)')
			.all();
		expect(
			indexes.some((i) => i.name === 'idx_memory_recall_usage_unit_id'),
		).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// 2. Write-side — recordRecallUsage binds unit_id at write time
// ---------------------------------------------------------------------------
describe('recordRecallUsage — populates unit_id column at write time', () => {
	test('a freshly recorded event with a unitId is queryable by unitId and carries the column', async () => {
		const root = await providerRoot('write-side-unit-id');
		const provider = track(
			new SQLiteMemoryProvider(root, { enabled: true, provider: 'sqlite' }),
		);
		await provider.initialize();

		await provider.recordRecallUsage!(
			makeUsageEvent({
				bundleId: 'bundle_u1',
				runId: 'subagent-sess',
				unitId: '1.1',
				memoryIds: ['mem_0000000000000005'],
			}),
		);

		const byUnit = await provider.listRecallUsage!({ unitId: '1.1' });
		expect(byUnit).toHaveLength(1);
		expect(byUnit[0]?.bundleId).toBe('bundle_u1');
		expect(byUnit[0]?.unitId).toBe('1.1');

		provider.close();
		const verify = trackHandle(
			new Database(dbPathFor(root), { readonly: true }),
		);
		expect(readUnitId(verify, 'bundle_u1')).toBe('1.1');
	});
});

// ---------------------------------------------------------------------------
// 3. Graceful degrade — a row with no unitId persists NULL and is run_id-only
// ---------------------------------------------------------------------------
describe('recordRecallUsage — absent unitId degrades to NULL (session-scoped)', () => {
	test('an event with runId but no unitId records unit_id NULL, found by runId, invisible to any unitId filter', async () => {
		const root = await providerRoot('degrade-null-unit-id');
		const provider = track(
			new SQLiteMemoryProvider(root, { enabled: true, provider: 'sqlite' }),
		);
		await provider.initialize();

		const event = makeUsageEvent({
			bundleId: 'bundle_no_unit',
			runId: 'sess-x',
			memoryIds: ['mem_0000000000000006'],
		});
		expect(event.unitId).toBeUndefined();
		await provider.recordRecallUsage!(event);

		// Still discoverable by the legacy run_id path (behavior unchanged).
		const byRun = await provider.listRecallUsage!({ runId: 'sess-x' });
		expect(byRun.map((r) => r.bundleId)).toEqual(['bundle_no_unit']);

		// Not returned by a unitId filter — a NULL unit_id never matches.
		const byUnit = await provider.listRecallUsage!({ unitId: '1.1' });
		expect(byUnit).toHaveLength(0);

		provider.close();
		const verify = trackHandle(
			new Database(dbPathFor(root), { readonly: true }),
		);
		expect(readUnitId(verify, 'bundle_no_unit')).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// 4. No backfill — a raw pre-existing NULL unit_id row is NOT repaired
// ---------------------------------------------------------------------------
describe('unit_id has no backfill (unlike run_id)', () => {
	test('a raw row whose usage_json embeds a unitId still keeps unit_id NULL on re-init', async () => {
		const root = await providerRoot('no-backfill');
		const provider = track(
			new SQLiteMemoryProvider(root, { enabled: true, provider: 'sqlite' }),
		);
		await provider.initialize();
		provider.close();

		const dbPath = dbPathFor(root);
		const raw = trackHandle(new Database(dbPath));
		// usage_json carries a unitId, but the unit_id COLUMN is left NULL —
		// the shape a hypothetical backfill would target. There is intentionally
		// no such backfill, so it must remain NULL.
		const embedded = makeUsageEvent({
			bundleId: 'bundle_raw_unit',
			runId: 'sess-raw',
			unitId: '9.9',
		});
		raw.run(
			`INSERT INTO memory_recall_usage (
				id, bundle_id, timestamp, usage_json, run_id, unit_id
			) VALUES (?, ?, ?, ?, ?, NULL)`,
			[
				'raw-unit-row',
				'bundle_raw_unit',
				'2026-01-01T00:00:00.000Z',
				JSON.stringify(embedded),
				'sess-raw',
			],
		);
		expect(readUnitId(raw, 'bundle_raw_unit')).toBeNull();
		raw.close();
		openHandles.splice(openHandles.indexOf(raw), 1);

		const provider2 = track(
			new SQLiteMemoryProvider(root, { enabled: true, provider: 'sqlite' }),
		);
		await provider2.initialize();
		// The unitId filter operates on the COLUMN, so the embedded-only value is
		// unreachable — proving no backfill promoted usage_json → column.
		const byUnit = await provider2.listRecallUsage!({ unitId: '9.9' });
		expect(byUnit).toHaveLength(0);
		provider2.close();

		const verify = trackHandle(new Database(dbPath, { readonly: true }));
		expect(readUnitId(verify, 'bundle_raw_unit')).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// 5. Filter matrix — unitId alone, and runId + unitId AND semantics
// ---------------------------------------------------------------------------
describe('listRecallUsage — unitId + runId filter matrix', () => {
	async function seed(provider: SQLiteMemoryProvider): Promise<void> {
		// Same unit "1.1" recalled under TWO different sessions — the exact
		// cross-session shape B.1 exists to join. Distinct timestamps for
		// deterministic DESC ordering.
		await provider.recordRecallUsage!(
			makeUsageEvent({
				bundleId: 'u11-sessA',
				runId: 'sessA',
				unitId: '1.1',
				timestamp: '2026-01-01T00:00:00.000Z',
			}),
		);
		await provider.recordRecallUsage!(
			makeUsageEvent({
				bundleId: 'u11-sessB',
				runId: 'sessB',
				unitId: '1.1',
				timestamp: '2026-01-02T00:00:00.000Z',
			}),
		);
		await provider.recordRecallUsage!(
			makeUsageEvent({
				bundleId: 'u22-sessA',
				runId: 'sessA',
				unitId: '2.2',
				timestamp: '2026-01-03T00:00:00.000Z',
			}),
		);
	}

	test('unitId alone returns every session that recalled that unit, ordered DESC', async () => {
		const root = await providerRoot('matrix-unit-only');
		const provider = track(
			new SQLiteMemoryProvider(root, { enabled: true, provider: 'sqlite' }),
		);
		await provider.initialize();
		await seed(provider);

		const results = await provider.listRecallUsage!({ unitId: '1.1' });
		// Both sessions, independent of runId — the session-mismatch guard.
		expect(results.map((r) => r.bundleId)).toEqual(['u11-sessB', 'u11-sessA']);
	});

	test('runId + unitId ANDs (both predicates must hold)', async () => {
		const root = await providerRoot('matrix-and');
		const provider = track(
			new SQLiteMemoryProvider(root, { enabled: true, provider: 'sqlite' }),
		);
		await provider.initialize();
		await seed(provider);

		// Row that satisfies both.
		const both = await provider.listRecallUsage!({
			runId: 'sessA',
			unitId: '1.1',
		});
		expect(both.map((r) => r.bundleId)).toEqual(['u11-sessA']);

		// unitId matches but runId does not → excluded (proves AND, not OR).
		const mismatch = await provider.listRecallUsage!({
			runId: 'sessB',
			unitId: '2.2',
		});
		expect(mismatch).toHaveLength(0);
	});
});
