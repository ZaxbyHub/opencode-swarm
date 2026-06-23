import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DEFAULT_MEMORY_CONFIG, type MemoryConfig } from './config';
import {
	computeMemoryContentHash,
	createMemoryId,
	type MemoryKind,
	type MemoryRecord,
	type MemoryScopeRef,
} from './schema';
import { SQLiteMemoryProvider } from './sqlite-provider';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(prefix = 'sqlite-query-plan-'): string {
	return mkdtempSync(path.join(os.tmpdir(), prefix));
}

const TEST_CONFIG: MemoryConfig = {
	...DEFAULT_MEMORY_CONFIG,
	provider: 'sqlite',
};

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
	metadata?: Record<string, unknown>;
}): MemoryRecord {
	const now = new Date().toISOString();
	const text = opts.text ?? 'query plan test record';
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
			: { type: 'manual' };

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
		metadata: opts.metadata ?? {},
	};
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('SQLiteMemoryProvider — EXPLAIN QUERY PLAN', () => {
	const scratchDirs: string[] = [];

	afterEach(() => {
		for (const d of scratchDirs) {
			try {
				rmSync(d, { recursive: true, force: true });
			} catch {
				// Best-effort; on Windows a locked DB file may prevent immediate deletion.
			}
		}
		scratchDirs.length = 0;
	});

	test('scope_key IN + kind = query uses idx_memory_items_scope_kind composite index', async () => {
		const dir = makeTmpDir('scope-kind-idx-');
		scratchDirs.push(dir);
		const provider = new SQLiteMemoryProvider(dir, TEST_CONFIG);
		await provider.initialize();

		// Insert a few records so the query planner has data to reason about.
		await provider.upsert(
			makeRecord({
				scope: makeScope('workspace', { workspaceId: 'test-project' }),
				kind: 'project_fact',
				text: 'index usage test record 1',
			}),
		);
		await provider.upsert(
			makeRecord({
				scope: makeScope('workspace', { workspaceId: 'test-project' }),
				kind: 'repo_convention',
				text: 'index usage test record 2',
			}),
		);
		await provider.upsert(
			makeRecord({
				scope: makeScope('workspace', { workspaceId: 'other-project' }),
				kind: 'project_fact',
				text: 'index usage test record 3',
			}),
		);

		// Run EXPLAIN QUERY PLAN on the same filtering query that list() builds
		// when both scopes and kinds are provided:
		//   SELECT id, record_json FROM memory_items
		//   WHERE scope_key IN (?, ?) AND kind = ?
		//   ORDER BY updated_at DESC
		const db = (
			provider as unknown as {
				db: {
					prepare: (sql: string) => {
						all: (...args: unknown[]) => Array<{ detail: string }>;
					};
				};
			}
		).db;
		const scopeKeys = ['test-project', 'other-project'];
		const placeholders = scopeKeys.map(() => '?').join(', ');
		const explainSql = `EXPLAIN QUERY PLAN
				SELECT id, record_json FROM memory_items
				WHERE scope_key IN (${placeholders}) AND kind = ?
				ORDER BY updated_at DESC`;

		const rows = db
			.prepare(explainSql)
			.all(...scopeKeys, 'project_fact') as Array<{ detail: string }>;

		// Assert the plan mentions idx_memory_items_scope_kind (composite index).
		const planDetails = rows.map((r) => r.detail).join(' ');
		expect(planDetails).toContain('idx_memory_items_scope_kind');
	});

	test('scope_key IN query alone also uses idx_memory_items_scope_kind', async () => {
		const dir = makeTmpDir('scope-only-idx-');
		scratchDirs.push(dir);
		const provider = new SQLiteMemoryProvider(dir, TEST_CONFIG);
		await provider.initialize();

		await provider.upsert(
			makeRecord({
				scope: makeScope('workspace', { workspaceId: 'scope-test' }),
				kind: 'project_fact',
				text: 'scope only test record',
			}),
		);

		const db = (
			provider as unknown as {
				db: {
					prepare: (sql: string) => {
						all: (...args: unknown[]) => Array<{ detail: string }>;
					};
				};
			}
		).db;
		const scopeKeys = ['scope-test'];
		const placeholders = scopeKeys.map(() => '?').join(', ');
		const explainSql = `EXPLAIN QUERY PLAN
				SELECT id, record_json FROM memory_items
				WHERE scope_key IN (${placeholders})
				ORDER BY updated_at DESC`;

		const rows = db.prepare(explainSql).all(...scopeKeys) as Array<{
			detail: string;
		}>;

		const planDetails = rows.map((r) => r.detail).join(' ');
		expect(planDetails).toContain('idx_memory_items_scope_kind');
	});

	test('kind = query without scope_key does NOT use idx_memory_items_scope_kind', async () => {
		const dir = makeTmpDir('kind-only-idx-');
		scratchDirs.push(dir);
		const provider = new SQLiteMemoryProvider(dir, TEST_CONFIG);
		await provider.initialize();

		await provider.upsert(
			makeRecord({
				scope: makeScope('workspace', { workspaceId: 'kind-test' }),
				kind: 'project_fact',
				text: 'kind only test record',
			}),
		);

		const db = (
			provider as unknown as {
				db: {
					prepare: (sql: string) => {
						all: (...args: unknown[]) => Array<{ detail: string }>;
					};
				};
			}
		).db;
		const explainSql = `EXPLAIN QUERY PLAN
				SELECT id, record_json FROM memory_items
				WHERE kind = ?
				ORDER BY updated_at DESC`;

		const rows = db.prepare(explainSql).all('project_fact') as Array<{
			detail: string;
		}>;

		const planDetails = rows.map((r) => r.detail).join(' ');
		// Without scope_key IN, the composite scope_kind index cannot be used.
		expect(planDetails).not.toContain('idx_memory_items_scope_kind');
	});
});
