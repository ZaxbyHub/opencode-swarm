import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import * as os from 'os';
import * as path from 'path';
import { computeMemoryContentHash, createMemoryId } from './schema';
import { SQLiteMemoryProvider } from './sqlite-provider';
import type {
	MemoryRecallUsageEvent,
	MemoryRecord,
	MemoryScopeRef,
} from './types';

function makeTmpDir(prefix = 'auto-compact-test-'): string {
	return mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeScope(
	type: MemoryScopeRef['type'],
	extra: Partial<MemoryScopeRef> = {},
): MemoryScopeRef {
	return { type, ...extra };
}

function makeRecord(opts: {
	kind?: 'scratch' | 'repo_convention';
	scope: MemoryScopeRef;
	text?: string;
	expiresAt?: string;
	deleted?: boolean;
	supersededBy?: string;
}): MemoryRecord {
	const now = new Date().toISOString();
	const text = opts.text ?? 'test memory text';
	const base = { scope: opts.scope, kind: opts.kind ?? 'scratch', text };
	const id = createMemoryId(base);
	const contentHash = computeMemoryContentHash(base);

	const stability: MemoryRecord['stability'] =
		opts.scope.type === 'run' || opts.scope.type === 'agent'
			? 'session'
			: 'durable';

	const source: MemoryRecord['source'] =
		stability === 'durable'
			? { type: 'file', filePath: '/test/fixture.ts' }
			: { type: 'manual' };

	const expiresAt =
		opts.kind === 'scratch' || !opts.kind
			? (opts.expiresAt ?? new Date(Date.now() + 86400000).toISOString())
			: opts.expiresAt;

	return {
		id,
		scope: opts.scope,
		kind: opts.kind ?? 'scratch',
		text,
		tags: [],
		confidence: 0.9,
		stability,
		source,
		createdAt: now,
		updatedAt: now,
		expiresAt,
		contentHash,
		supersededBy: opts.supersededBy,
		metadata: opts.deleted ? { deleted: true } : {},
	};
}

function makeRecallEvent(
	bundleId: string,
	memoryIds: string[],
	scope: MemoryScopeRef,
): MemoryRecallUsageEvent {
	return {
		bundleId,
		query: 'test query',
		scopes: [scope],
		memoryIds,
		scores: memoryIds.map(() => 0.9),
		tokenEstimate: 100,
		agentRole: 'coder',
		runId: 'test-run',
		timestamp: new Date().toISOString(),
	};
}

async function flushPromises(): Promise<void> {
	await Promise.resolve();
}

/**
 * Count compact_triggered events in the provider's SQLite DB.
 */
function countCompactEvents(provider: SQLiteMemoryProvider): number {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const db = (provider as any).db;
	if (!db) return 0;
	const row = db
		.query<{ cnt: number }, [string]>(
			'SELECT COUNT(*) as cnt FROM memory_events WHERE operation = ?',
		)
		.get('compact_triggered');
	return row?.cnt ?? 0;
}

describe('auto-compaction via recordRecallUsage', () => {
	const scratchDirs: string[] = [];

	afterEach(() => {
		for (const d of scratchDirs) {
			try {
				rmSync(d, { recursive: true, force: true });
			} catch {
				// Windows may briefly hold DB locks
			}
		}
		scratchDirs.length = 0;
	});

	test('SC-011: threshold=3, 2 calls → no compaction, 3rd call → compaction runs', async () => {
		const dir = makeTmpDir('sc011-');
		scratchDirs.push(dir);
		const provider = new SQLiteMemoryProvider(dir, {
			maintenance: { autoCompactEveryNRecalls: 3 },
		});
		await provider.initialize();

		const scope = makeScope('repository', { repoId: 'repo-a', repoRoot: dir });
		const record = makeRecord({ scope, kind: 'scratch' });
		await provider.upsert(record);

		// Two calls — no compaction
		await provider.recordRecallUsage(
			makeRecallEvent('bundle-1', [record.id], scope),
		);
		await provider.recordRecallUsage(
			makeRecallEvent('bundle-2', [record.id], scope),
		);
		expect(countCompactEvents(provider)).toBe(0);

		// Third call — MUST trigger compaction
		await provider.recordRecallUsage(
			makeRecallEvent('bundle-3', [record.id], scope),
		);
		await flushPromises();
		expect(countCompactEvents(provider)).toBe(1);

		provider.close();
	});

	test('SC-012 + SC-024: threshold=0 → never triggers even after 100 calls', async () => {
		const dir = makeTmpDir('sc012-');
		scratchDirs.push(dir);
		const provider = new SQLiteMemoryProvider(dir, {
			maintenance: { autoCompactEveryNRecalls: 0 },
		});
		await provider.initialize();

		const scope = makeScope('repository', { repoId: 'repo-b', repoRoot: dir });
		const record = makeRecord({ scope, kind: 'scratch' });
		await provider.upsert(record);

		for (let i = 0; i < 100; i++) {
			await provider.recordRecallUsage(
				makeRecallEvent(`bundle-${i}`, [record.id], scope),
			);
		}

		expect(countCompactEvents(provider)).toBe(0);
		provider.close();
	});

	test('SC-014: threshold=2, 4 calls → compaction runs exactly twice (at call 2 and call 4)', async () => {
		const dir = makeTmpDir('sc014-');
		scratchDirs.push(dir);
		const provider = new SQLiteMemoryProvider(dir, {
			maintenance: { autoCompactEveryNRecalls: 2 },
		});
		await provider.initialize();

		const scope = makeScope('repository', { repoId: 'repo-c', repoRoot: dir });
		const record = makeRecord({ scope, kind: 'scratch' });
		await provider.upsert(record);

		// Call 1 — no compaction
		await provider.recordRecallUsage(
			makeRecallEvent('bundle-1', [record.id], scope),
		);
		expect(countCompactEvents(provider)).toBe(0);

		// Call 2 — compaction #1
		await provider.recordRecallUsage(
			makeRecallEvent('bundle-2', [record.id], scope),
		);
		await flushPromises();
		expect(countCompactEvents(provider)).toBe(1);

		// Call 3 — no compaction (counter reset)
		await provider.recordRecallUsage(
			makeRecallEvent('bundle-3', [record.id], scope),
		);
		expect(countCompactEvents(provider)).toBe(1);

		// Call 4 — compaction #2
		await provider.recordRecallUsage(
			makeRecallEvent('bundle-4', [record.id], scope),
		);
		await flushPromises();
		expect(countCompactEvents(provider)).toBe(2);

		provider.close();
	});

	test('SC-023 + default: no autoCompactEveryNRecalls set → default 50 applies', async () => {
		const dir = makeTmpDir('sc023-');
		scratchDirs.push(dir);
		const provider = new SQLiteMemoryProvider(dir, {});
		await provider.initialize();

		const scope = makeScope('repository', { repoId: 'repo-d', repoRoot: dir });
		const record = makeRecord({ scope, kind: 'scratch' });
		await provider.upsert(record);

		// 49 calls — should NOT trigger
		for (let i = 0; i < 49; i++) {
			await provider.recordRecallUsage(
				makeRecallEvent(`bundle-${i}`, [record.id], scope),
			);
		}
		expect(countCompactEvents(provider)).toBe(0);

		// 50th call — MUST trigger compaction
		await provider.recordRecallUsage(
			makeRecallEvent('bundle-49', [record.id], scope),
		);
		await flushPromises();
		expect(countCompactEvents(provider)).toBe(1);

		provider.close();
	});

	test('SC-013: compact_triggered event is recorded with result metadata accessible via listRecallUsage', async () => {
		const dir = makeTmpDir('sc013-');
		scratchDirs.push(dir);
		const provider = new SQLiteMemoryProvider(dir, {
			maintenance: { autoCompactEveryNRecalls: 1 },
		});
		await provider.initialize();

		const scope = makeScope('repository', { repoId: 'repo-e', repoRoot: dir });
		const deletedRecord = makeRecord({ scope, kind: 'scratch', deleted: true });
		await provider.upsert(deletedRecord);

		// Trigger compaction on 1st call
		await provider.recordRecallUsage(
			makeRecallEvent('bundle-1', [deletedRecord.id], scope),
		);
		await flushPromises();

		// Verify a compact_triggered event was recorded by querying the DB directly
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const db = (provider as any).db;
		expect(db).not.toBeNull();

		const row = db!
			.query<{ event_json: string; reason: string }, [string]>(
				'SELECT event_json, reason FROM memory_events WHERE operation = ? LIMIT 1',
			)
			.get('compact_triggered');

		expect(row).not.toBeUndefined();
		// The event data is stored in the event_json column as a JSON string
		// (insertEvent stores stringified objects in event_json, not reason)
		const eventData = JSON.parse(row.event_json);
		expect(eventData.trigger).toBe('auto');
		expect(eventData.threshold).toBe(1);
		expect(typeof eventData.rowsInspected).toBe('number');
		expect(typeof eventData.rowsPurged).toBe('number');
		expect(typeof eventData.timestamp).toBe('string');

		provider.close();
	});
});
