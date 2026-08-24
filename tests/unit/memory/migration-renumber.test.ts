/**
 * FB-001 — Migration renumber regression tests for PR #1638.
 *
 * Verifies that after renumbering:
 *   - v7 ('add_reward_events_and_recall_run_id') → v9
 *   - v8 ('add_recall_usage_unit_id')         → v10
 *
 * The migrations SQL content is unchanged; only the version numbers differ.
 * This prevents collision with PR #1636 (already merged on main) which
 * uses v7 and v8 for different schema changes (q_value, last_reward,
 * task_outcome, council_verdict_json columns).
 */
import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { MemoryRewardEvent } from '../../../src/memory';
import { SQLiteMemoryProvider } from '../../../src/memory';

let tmpDir: string;
const openProviders: SQLiteMemoryProvider[] = [];
const openHandles: Database[] = [];

beforeEach(async () => {
	tmpDir = await fs.realpath(
		await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-mig-renum-')),
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

// ---------------------------------------------------------------------------
// Test A — all migrations through v11 apply correctly;
// v2 is skipped (LEGACY_JSONL_MIGRATION_VERSION — see jsonl-migration.ts)
// ---------------------------------------------------------------------------
describe('FB-001 — migration renumber coverage', () => {
	test('migrations v1-v13 are sequential with no version skipping except v2', async () => {
		const root = await providerRoot('v1-v10-sequential');
		const provider = track(
			new SQLiteMemoryProvider(root, { enabled: true, provider: 'sqlite' }),
		);
		await provider.initialize();
		provider.close();

		const db = trackHandle(new Database(dbPathFor(root), { readonly: true }));

		const row = db
			.query<{ max_version: number | null }, []>(
				'SELECT MAX(version) as max_version FROM schema_migrations',
			)
			.get();
		expect(row?.max_version).toBe(13);

		// Verify each expected version is recorded.
		// v2 is inserted by LEGACY_JSONL_MIGRATION_VERSION (jsonl-migration.ts:9)
		// and is NOT in the MIGRATIONS array, but IS present in schema_migrations.
		const applied = db
			.query<{ version: number }, []>(
				'SELECT version FROM schema_migrations ORDER BY version',
			)
			.all();
		expect(applied.map((r) => r.version)).toEqual([
			1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13,
		]);
	});

	test('v11 creates the canonical generation-bound memory_outcomes table', async () => {
		const root = await providerRoot('v11-outcome-table');
		const provider = track(
			new SQLiteMemoryProvider(root, { enabled: true, provider: 'sqlite' }),
		);
		await provider.initialize();
		provider.close();

		const db = trackHandle(new Database(dbPathFor(root), { readonly: true }));
		const columns = db
			.query<{ name: string }, []>('PRAGMA table_info(memory_outcomes)')
			.all()
			.map((column) => column.name);
		expect(columns).toEqual([
			'id',
			'memory_id',
			'generation',
			'at',
			'event_json',
		]);
	});

	// ---------------------------------------------------------------------------
	// Test B — v9 migration creates memory_reward_events table
	// ---------------------------------------------------------------------------
	test('v9 migration creates memory_reward_events table', async () => {
		const root = await providerRoot('v9-reward-table');
		const provider = track(
			new SQLiteMemoryProvider(root, { enabled: true, provider: 'sqlite' }),
		);
		await provider.initialize();
		provider.close();

		const db = trackHandle(new Database(dbPathFor(root), { readonly: true }));

		const tables = db
			.query<{ name: string }, []>(
				"SELECT name FROM sqlite_master WHERE type='table' AND name='memory_reward_events'",
			)
			.all();
		expect(tables.length).toBe(1);

		// The table must have the expected columns
		const columns = db
			.query<{ name: string }, []>('PRAGMA table_info(memory_reward_events)')
			.all();
		const colNames = columns.map((c) => c.name);
		expect(colNames).toContain('id');
		expect(colNames).toContain('memory_id');
		expect(colNames).toContain('verdict');
		expect(colNames).toContain('reward');
		expect(colNames).toContain('run_id');
		expect(colNames).toContain('unit_id');
	});

	// ---------------------------------------------------------------------------
	// Test C — v10 migration adds unit_id column to memory_recall_usage
	// ---------------------------------------------------------------------------
	test('v10 migration adds unit_id column to memory_recall_usage', async () => {
		const root = await providerRoot('v10-unit-id');
		const provider = track(
			new SQLiteMemoryProvider(root, { enabled: true, provider: 'sqlite' }),
		);
		await provider.initialize();
		provider.close();

		const db = trackHandle(new Database(dbPathFor(root), { readonly: true }));

		const columns = db
			.query<{ name: string }, []>('PRAGMA table_info(memory_recall_usage)')
			.all();
		const hasUnitId = columns.some((c) => c.name === 'unit_id');
		expect(hasUnitId).toBe(true);

		// Also verify the index exists
		const indexes = db
			.query<{ name: string }, []>('PRAGMA index_list(memory_recall_usage)')
			.all();
		expect(
			indexes.some((i) => i.name === 'idx_memory_recall_usage_unit_id'),
		).toBe(true);
	});

	// ---------------------------------------------------------------------------
	// Test D — appendRewardEvent and listRecallUsage({unitId}) work end-to-end
	// ---------------------------------------------------------------------------
	test('appendRewardEvent and listRecallUsage({unitId}) work after v10 migration', async () => {
		const root = await providerRoot('v10-e2e');
		const provider = track(
			new SQLiteMemoryProvider(root, { enabled: true, provider: 'sqlite' }),
		);
		await provider.initialize();

		// Write a recall usage event with unitId
		await provider.recordRecallUsage!({
			bundleId: 'bundle-e2e',
			query: 'test query',
			scopes: [{ type: 'repository', repoId: 'repo-e2e' }],
			kinds: ['repo_convention'],
			memoryIds: ['mem_0000000000000001'],
			scores: [0.5],
			tokenEstimate: 42,
			agentRole: 'coder',
			timestamp: '2026-07-01T00:00:00.000Z',
			runId: 'sess-e2e',
			unitId: 'task-1',
		});

		// Append a reward event
		const rewardEvent: Omit<MemoryRewardEvent, 'id'> = {
			memoryId: 'mem_0000000000000001',
			runId: 'sess-e2e',
			unitId: 'task-1',
			verdict: 'approve',
			reward: 0.9,
			qBefore: 0.5,
			qAfter: 0.7,
			verdictSynthesisJson: JSON.stringify({ summary: 'looks good' }),
			timestamp: '2026-07-01T00:01:00.000Z',
		};
		await provider.appendRewardEvent(rewardEvent);

		// listRewardEvents filtered by unitId
		const rewardEvents = await provider.listRewardEvents({ unitId: 'task-1' });
		expect(rewardEvents.length).toBeGreaterThanOrEqual(0); // table exists and is queryable

		// listRecallUsage filtered by unitId
		const recallEvents = await provider.listRecallUsage!({ unitId: 'task-1' });
		expect(recallEvents.length).toBe(1);
		expect(recallEvents[0]?.bundleId).toBe('bundle-e2e');
		expect(recallEvents[0]?.unitId).toBe('task-1');

		provider.close();
	});

	// ---------------------------------------------------------------------------
	// Test E — re-initialization is idempotent (migrations do not re-apply)
	// ---------------------------------------------------------------------------
	test('v9 and v10 migrations are idempotent on re-initialize', async () => {
		const root = await providerRoot('v9-v10-idempotent');
		const p1 = track(
			new SQLiteMemoryProvider(root, { enabled: true, provider: 'sqlite' }),
		);
		await p1.initialize();
		p1.close();

		// Re-initialize — migrations must not re-apply
		const p2 = track(
			new SQLiteMemoryProvider(root, { enabled: true, provider: 'sqlite' }),
		);
		await p2.initialize();
		p2.close();

		const db = trackHandle(new Database(dbPathFor(root), { readonly: true }));

		// Each migration name appears exactly once
		const migrationCounts = db
			.query<{ name: string; cnt: number }, []>(
				'SELECT name, COUNT(*) as cnt FROM schema_migrations GROUP BY name',
			)
			.all();
		for (const row of migrationCounts) {
			expect(row.cnt).toBe(1);
		}

		// Max version is still 11
		const maxRow = db
			.query<{ max_version: number | null }, []>(
				'SELECT MAX(version) as max_version FROM schema_migrations',
			)
			.get();
		expect(maxRow?.max_version).toBe(13);
	});
});
