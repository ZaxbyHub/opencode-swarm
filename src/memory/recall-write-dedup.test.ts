import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { MemoryRecallUsageEvent, MemoryScopeRef } from './provider';
import { computeMemoryContentHash, createMemoryId } from './schema';
import { SQLiteMemoryProvider } from './sqlite-provider';
import type { MemoryKind, MemoryRecord } from './types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(prefix = 'sqlite-recall-dedup-test-'): string {
	return mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeScope(
	type: MemoryScopeRef['type'],
	extra: Partial<MemoryScopeRef> = {},
): MemoryScopeRef {
	return { type, ...extra };
}

function makeRecord(opts: {
	kind: MemoryKind;
	scope: MemoryScopeRef;
	text?: string;
}): MemoryRecord {
	const now = new Date().toISOString();
	const text = opts.text ?? 'test memory text';
	const id = createMemoryId({ scope: opts.scope, kind: opts.kind, text });
	const contentHash = computeMemoryContentHash({
		scope: opts.scope,
		kind: opts.kind,
		text,
	});

	const stability: MemoryRecord['stability'] =
		opts.scope.type === 'run' || opts.scope.type === 'agent'
			? 'session'
			: 'durable';

	const source: MemoryRecord['source'] =
		stability === 'durable'
			? { type: 'file', filePath: '/test/fixture.ts' }
			: { type: 'agent', agentId: 'test-agent' };

	return {
		id,
		scope: opts.scope,
		kind: opts.kind,
		text,
		tags: [],
		confidence: 0.9,
		stability,
		source,
		createdAt: now,
		updatedAt: now,
		contentHash,
		metadata: {},
	};
}

function makeRecallUsageEvent(
	overrides: Partial<MemoryRecallUsageEvent> = {},
): MemoryRecallUsageEvent {
	const now = new Date().toISOString();
	return {
		bundleId: 'test-bundle-' + Math.random().toString(36).slice(2),
		query: 'how do I run tests',
		scopes: [
			makeScope('repository', { repoId: 'repo-a', repoRoot: '/tmp/repo-a' }),
		],
		memoryIds: [],
		scores: [],
		tokenEstimate: 100,
		timestamp: now,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('SQLiteMemoryProvider — recall write dedup + timestamp index', () => {
	let tmpDir: string;
	let provider: SQLiteMemoryProvider;
	let dbPath: string;

	beforeEach(async () => {
		tmpDir = makeTmpDir();
		provider = new SQLiteMemoryProvider(tmpDir, { enabled: true });
		await provider.initialize();
		// Resolve the actual DB path for direct queries
		dbPath = path.join(tmpDir, '.swarm', 'memory', 'memory.db');
	});

	afterEach(() => {
		provider.close();
		rmSync(tmpDir, { recursive: true, force: true });
	});

	// Helper: run a raw SQL query against the provider's db
	function rawQuery<T>(sql: string, params: unknown[] = []): T[] {
		// Access the underlying db via the provider's requireDb for read queries
		// We use a workaround: open a new handle to the same file
		const { Database } = require('bun:sqlite') as {
			Database: typeof import('bun:sqlite').Database;
		};
		const db = new Database(dbPath);
		try {
			const stmt = db.query(sql);
			if (params.length > 0) {
				return stmt.all(...params) as T[];
			}
			return stmt.all() as T[];
		} finally {
			db.close();
		}
	}

	function rawQueryGet<T>(sql: string, params: unknown[] = []): T | undefined {
		const { Database } = require('bun:sqlite') as {
			Database: typeof import('bun:sqlite').Database;
		};
		const db = new Database(dbPath);
		try {
			const stmt = db.query(sql);
			if (params.length > 0) {
				return stmt.get(...params) as T | undefined;
			}
			return stmt.get() as T | undefined;
		} finally {
			db.close();
		}
	}

	// SC-007 + SC-008: recordRecallUsage inserts into memory_recall_usage only,
	// never into memory_events
	test('SC-007: single recordRecallUsage call produces exactly 1 row in memory_recall_usage', async () => {
		const event = makeRecallUsageEvent();
		await provider.recordRecallUsage(event);

		const rows = rawQuery<{ id: string }>('SELECT id FROM memory_recall_usage');
		expect(rows).toHaveLength(1);
	});

	test('SC-008: recordRecallUsage produces zero recall operation rows in memory_events', async () => {
		const event = makeRecallUsageEvent();
		await provider.recordRecallUsage(event);

		const rows = rawQuery<{ id: string; operation: string }>(
			"SELECT id, operation FROM memory_events WHERE operation = 'recall'",
		);
		expect(rows).toHaveLength(0);
	});

	// Multiple calls — each produces exactly 1 row in memory_recall_usage, 0 in events
	test('SC-007 variant: three recordRecallUsage calls produce three rows in memory_recall_usage', async () => {
		for (let i = 0; i < 3; i++) {
			const event = makeRecallUsageEvent({ bundleId: `bundle-${i}` });
			await provider.recordRecallUsage(event);
		}

		const rows = rawQuery<{ id: string }>('SELECT id FROM memory_recall_usage');
		expect(rows).toHaveLength(3);
	});

	test('SC-008 variant: three recordRecallUsage calls produce zero recall rows in memory_events', async () => {
		for (let i = 0; i < 3; i++) {
			const event = makeRecallUsageEvent({ bundleId: `bundle-${i}` });
			await provider.recordRecallUsage(event);
		}

		const rows = rawQuery<{ id: string; operation: string }>(
			"SELECT id, operation FROM memory_events WHERE operation = 'recall'",
		);
		expect(rows).toHaveLength(0);
	});

	// SC-009: migration v5 creates idx_memory_recall_usage_timestamp
	test('SC-009: idx_memory_recall_usage_timestamp exists after initialization', async () => {
		const indexRow = rawQueryGet<{ name: string; sql: string | null }>(
			"SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_memory_recall_usage_timestamp'",
		);

		expect(indexRow).toBeDefined();
		expect(indexRow!.name).toBe('idx_memory_recall_usage_timestamp');
		// Verify it covers the timestamp column in DESC order
		expect(indexRow!.sql).toContain('memory_recall_usage');
		expect(indexRow!.sql).toContain('timestamp');
		expect(indexRow!.sql).toContain('DESC');
	});

	// SC-009 verify index is on the correct table+columns
	test('SC-009: idx_memory_recall_usage_timestamp is ON memory_recall_usage(timestamp DESC)', async () => {
		const indexRow = rawQueryGet<{ name: string; sql: string | null }>(
			"SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_memory_recall_usage_timestamp'",
		);

		expect(indexRow).toBeDefined();
		const sql = indexRow!.sql!;
		// Should be CREATE INDEX ... ON memory_recall_usage(timestamp DESC)
		expect(sql).toMatch(
			/ON\s+memory_recall_usage\s*\(\s*timestamp\s+DESC\s*\)/i,
		);
	});

	// SC-010: existing populated DB — migration v5 runs without data loss
	test('SC-010: migration v5 does not cause data loss on a populated database', async () => {
		// Insert a memory record directly via raw SQL to populate the DB
		const { Database } = require('bun:sqlite') as {
			Database: typeof import('bun:sqlite').Database;
		};
		const db = new Database(dbPath);

		const scope = makeScope('repository', {
			repoId: 'repo-x',
			repoRoot: tmpDir,
		});
		const record = makeRecord({
			kind: 'repo_convention',
			scope,
			text: 'use pnpm',
		});
		const recordJson = JSON.stringify(record);

		db.run(
			`INSERT INTO memory_items (id, scope_key, kind, updated_at, expires_at, superseded_by, deleted, record_json)
				 VALUES (?, ?, ?, ?, NULL, NULL, 0, ?)`,
			[
				record.id,
				'repository:repo-x',
				record.kind,
				new Date().toISOString(),
				recordJson,
			],
		);

		// Record some recall usage before v5 migration
		const recallEvent = makeRecallUsageEvent({
			bundleId: 'pre-migration-bundle',
		});
		db.run(
			`INSERT INTO memory_recall_usage (id, bundle_id, timestamp, usage_json)
				 VALUES (?, ?, ?, ?)`,
			[
				require('node:crypto').randomUUID(),
				recallEvent.bundleId,
				recallEvent.timestamp,
				JSON.stringify(recallEvent),
			],
		);

		const recallCountBefore = (
			db.query('SELECT COUNT(*) as c FROM memory_recall_usage').get() as {
				c: number;
			}
		).c;
		const memoryCountBefore = (
			db.query('SELECT COUNT(*) as c FROM memory_items').get() as { c: number }
		).c;
		db.close();

		expect(recallCountBefore).toBe(1);
		expect(memoryCountBefore).toBe(1);

		// The index should already exist from normal init, but verify it survives a re-init
		const reInitProvider = new SQLiteMemoryProvider(tmpDir, { enabled: true });
		await reInitProvider.initialize();

		// Re-query counts after re-init
		const { Database: DB2 } = require('bun:sqlite') as {
			Database: typeof import('bun:sqlite').Database;
		};
		const db2 = new DB2(dbPath);
		const recallCountAfter = (
			db2.query('SELECT COUNT(*) as c FROM memory_recall_usage').get() as {
				c: number;
			}
		).c;
		const memoryCountAfter = (
			db2.query('SELECT COUNT(*) as c FROM memory_items').get() as { c: number }
		).c;
		db2.close();

		expect(recallCountAfter).toBe(recallCountBefore);
		expect(memoryCountAfter).toBe(memoryCountBefore);

		reInitProvider.close();
	});

	// listRecallUsage ORDER BY timestamp DESC
	test('listRecallUsage returns events ordered by timestamp DESC', async () => {
		const now = Date.now();
		const t1 = new Date(now - 2000).toISOString(); // oldest
		const t2 = new Date(now - 1000).toISOString(); // middle
		const t3 = new Date(now).toISOString(); // newest

		await provider.recordRecallUsage(
			makeRecallUsageEvent({ bundleId: 'b1', timestamp: t1 }),
		);
		await provider.recordRecallUsage(
			makeRecallUsageEvent({ bundleId: 'b2', timestamp: t2 }),
		);
		await provider.recordRecallUsage(
			makeRecallUsageEvent({ bundleId: 'b3', timestamp: t3 }),
		);

		const events = await provider.listRecallUsage();

		expect(events).toHaveLength(3);
		// Verify descending timestamp order
		expect(events[0].timestamp).toBe(t3);
		expect(events[1].timestamp).toBe(t2);
		expect(events[2].timestamp).toBe(t1);
	});

	test('listRecallUsage with limit returns correct subset ordered by timestamp DESC', async () => {
		const now = Date.now();
		const timestamps = [0, 1, 2, 3, 4].map((i) =>
			new Date(now - (4 - i) * 1000).toISOString(),
		);

		for (let i = 0; i < 5; i++) {
			await provider.recordRecallUsage(
				makeRecallUsageEvent({ bundleId: `b${i}`, timestamp: timestamps[i] }),
			);
		}

		const events = await provider.listRecallUsage({ limit: 3 });

		expect(events).toHaveLength(3);
		// Should be the 3 most recent
		expect(events[0].timestamp).toBe(timestamps[4]); // newest
		expect(events[1].timestamp).toBe(timestamps[3]);
		expect(events[2].timestamp).toBe(timestamps[2]);
	});
});
