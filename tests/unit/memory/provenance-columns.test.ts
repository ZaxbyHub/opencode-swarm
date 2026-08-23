import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadDatabaseCtor } from '../../../src/db/sqlite-loader';
import {
	DEFAULT_MEMORY_CONFIG,
	MemoryGateway,
	resolveSqliteDatabasePath,
	SQLiteMemoryProvider,
} from '../../../src/memory';
import { evictAndClose } from '../../../src/memory/provider-pool';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

let tmpDir: string;

beforeEach(async () => {
	tmpDir = canonicalMkdtemp('swarm-memory-prov-');
});

afterEach(async () => {
	evictAndClose(tmpDir);
	await fs.rm(tmpDir, { recursive: true, force: true });
});

function sqliteConfig() {
	return {
		...DEFAULT_MEMORY_CONFIG,
		enabled: true,
		provider: 'sqlite' as const,
	};
}

function openRaw() {
	const dbPath = resolveSqliteDatabasePath(tmpDir, sqliteConfig());
	return new (loadDatabaseCtor())(dbPath);
}

interface ProvenanceRow {
	id: string;
	source_task_id: string;
	agent_role: string;
	embedding_model_version: string;
	valid_from: string | null;
	supersedes_reason: string | null;
}

function readProvenance(id?: string): ProvenanceRow[] {
	const db = openRaw();
	try {
		return db
			.query<ProvenanceRow, [string | null]>(
				id === undefined
					? 'SELECT id, source_task_id, agent_role, embedding_model_version, valid_from, supersedes_reason FROM memory_items'
					: 'SELECT id, source_task_id, agent_role, embedding_model_version, valid_from, supersedes_reason FROM memory_items WHERE id = ?',
			)
			.all(...(id === undefined ? [] : [id]));
	} finally {
		db.close();
	}
}

describe('memory_items provenance columns (#1466 migration v12)', () => {
	test('columns exist with documented defaults after init on an empty table', async () => {
		const provider = new SQLiteMemoryProvider(tmpDir, sqliteConfig());
		try {
			await provider.initialize();
			const db = openRaw();
			const cols = db
				.query<{ name: string }, []>(
					"SELECT name FROM pragma_table_info('memory_items')",
				)
				.all()
				.map((c) => c.name);
			db.close();
			expect(cols).toContain('source_task_id');
			expect(cols).toContain('agent_role');
			expect(cols).toContain('embedding_model_version');
			expect(cols).toContain('valid_from');
			expect(cols).toContain('supersedes_reason');
		} finally {
			provider.close?.();
		}
	});

	test('new writes populate source_task_id from context unitId and agent_role from producerAgentRole', async () => {
		const gateway = new MemoryGateway(
			{
				directory: tmpDir,
				sessionID: 'session-a',
				agentRole: 'coder',
				unitId: '1.2',
			},
			{
				config: sqliteConfig(),
				now: () => new Date('2026-08-22T10:00:00.000Z'),
			},
		);
		const record = gateway.createRecord({
			kind: 'code_pattern',
			text: 'provenance probe record',
			source: { type: 'file', filePath: 'src/probe.ts' },
		});
		await gateway.upsertCurated(record);
		const rows = readProvenance();
		expect(rows).toHaveLength(1);
		expect(rows[0].source_task_id).toBe('1.2');
		expect(rows[0].agent_role).toBe('coder');
		expect(rows[0].valid_from).toBe(record.createdAt);
		// Embeddings are disabled in the default config → empty stamp.
		expect(rows[0].embedding_model_version).toBe('');
		await gateway.dispose();
	});

	test('PRR-006: record_json omits provenance keys (old strict-schema binary can still load it)', async () => {
		const gateway = new MemoryGateway(
			{
				directory: tmpDir,
				sessionID: 'session-a',
				agentRole: 'coder',
				unitId: '3.4',
			},
			{
				config: sqliteConfig(),
				now: () => new Date('2026-08-22T10:00:00.000Z'),
			},
		);
		const record = gateway.createRecord({
			kind: 'code_pattern',
			text: 'old binary compatibility probe',
			source: { type: 'file', filePath: 'src/probe.ts' },
		});
		await gateway.upsertCurated(record);
		await gateway.dispose();
		const db = openRaw();
		let storedJson = '';
		try {
			const row = db
				.query<{ record_json: string }, []>(
					'SELECT record_json FROM memory_items LIMIT 1',
				)
				.get();
			storedJson = row?.record_json ?? '';
		} finally {
			db.close();
		}
		expect(storedJson).not.toBe('');
		const parsed = JSON.parse(storedJson) as Record<string, unknown>;
		expect(parsed.sourceTaskId).toBeUndefined();
		expect(parsed.embeddingModelVersion).toBeUndefined();
		expect(parsed.validFrom).toBeUndefined();
		expect(parsed.supersedesReason).toBeUndefined();
		// The columns still carry the provenance (not lost by the strip).
		const rows = readProvenance();
		expect(rows[0].source_task_id).toBe('3.4');
		expect(rows[0].valid_from).toBe(record.createdAt);
	});

	test('PRR-020: re-upserting the same id preserves the original valid_from', async () => {
		const gateway = new MemoryGateway(
			{ directory: tmpDir, sessionID: 'session-a', agentRole: 'coder' },
			{
				config: sqliteConfig(),
				now: () => new Date('2026-08-22T10:00:00.000Z'),
			},
		);
		const record = gateway.createRecord({
			kind: 'code_pattern',
			text: 'valid_from preservation probe',
			source: { type: 'file', filePath: 'src/probe.ts' },
		});
		await gateway.upsertCurated(record);
		// Same content → same id; later clock → fresh validFrom candidate.
		const later = new MemoryGateway(
			{ directory: tmpDir, sessionID: 'session-b', agentRole: 'coder' },
			{
				config: sqliteConfig(),
				now: () => new Date('2026-09-01T10:00:00.000Z'),
			},
		);
		const refreshed = later.createRecord({
			kind: 'code_pattern',
			text: 'valid_from preservation probe',
			source: { type: 'file', filePath: 'src/probe.ts' },
		});
		expect(refreshed.id).toBe(record.id);
		await later.upsertCurated(refreshed);
		const rows = readProvenance();
		expect(rows).toHaveLength(1);
		// The FIRST authoritative timestamp survives the re-write.
		expect(rows[0].valid_from).toBe(record.validFrom);
		expect(new Date(rows[0].valid_from ?? '').getTime()).toBeLessThan(
			new Date(refreshed.validFrom ?? '').getTime(),
		);
		await gateway.dispose();
		await later.dispose();
	});

	// Final-critic fix (PR #2310 feedback): the reward-capture hot path
	// (recordOutcome → appendOutcome) parses the stored row and REWRITES it.
	// Without the column read-back merge, that rewrite reset source_task_id
	// to '' — the provenance this PR ships silently evaporated on the first
	// outcome. Pinned here end-to-end through the gateway.
	test('appendOutcome preserves source_task_id (final-critic: no column clobber)', async () => {
		const gateway = new MemoryGateway(
			{
				directory: tmpDir,
				sessionID: 'session-a',
				agentRole: 'coder',
				unitId: '5.6',
			},
			{
				config: sqliteConfig(),
				now: () => new Date('2026-08-22T10:00:00.000Z'),
			},
		);
		const record = gateway.createRecord({
			kind: 'code_pattern',
			text: 'outcome provenance preservation probe',
			source: { type: 'file', filePath: 'src/probe.ts' },
		});
		await gateway.upsertCurated(record);
		expect(readProvenance()[0].source_task_id).toBe('5.6');

		await gateway.recordOutcome({
			memoryId: record.id,
			outcome: 'useful',
		});
		const afterOutcome = readProvenance();
		expect(afterOutcome).toHaveLength(1);
		expect(afterOutcome[0].source_task_id).toBe('5.6');
		expect(afterOutcome[0].agent_role).toBe('coder');
		expect(afterOutcome[0].valid_from).toBe(record.createdAt);

		await gateway.recordOutcome({
			memoryId: record.id,
			outcome: 'corrected',
			correction: 'Adjusted after review.',
		});
		const afterCorrection = readProvenance();
		expect(afterCorrection[0].source_task_id).toBe('5.6');
		await gateway.dispose();
	});

	// Final-critic delta 2 (PR #2310): the get()→upsert() round-trip is the
	// reward-capture Q-update path — get() returns the stored (stripped)
	// record shape, so an unmerged upsert reset source_task_id to '' on
	// every council reward. upsert() now merges the existing row's
	// provenance columns (record-provided values win).
	test('get→upsert round-trip preserves provenance (reward-capture path)', async () => {
		const gateway = new MemoryGateway(
			{
				directory: tmpDir,
				sessionID: 'session-a',
				agentRole: 'coder',
				unitId: '9.10',
			},
			{
				config: sqliteConfig(),
				now: () => new Date('2026-08-22T10:00:00.000Z'),
			},
		);
		const record = gateway.createRecord({
			kind: 'code_pattern',
			text: 'roundtrip provenance probe',
			source: { type: 'file', filePath: 'src/probe.ts' },
		});
		await gateway.upsertCurated(record);
		expect(readProvenance()[0].source_task_id).toBe('9.10');

		// Simulate the reward-capture shape: read via get() (stripped
		// record_json → no provenance fields), spread-modify like setQValue,
		// upsert the result.
		const provider = new SQLiteMemoryProvider(tmpDir, sqliteConfig());
		try {
			await provider.initialize();
			const fetched = await provider.get(record.id);
			expect(fetched).not.toBeNull();
			expect((fetched as Record<string, unknown>).sourceTaskId).toBeUndefined();
			const qUpdated = {
				...fetched!,
				qValue: 0.9,
				updatedAt: '2026-08-23T10:00:00.000Z',
			};
			await provider.upsert(qUpdated);
			const after = readProvenance();
			expect(after[0].source_task_id).toBe('9.10');
			expect(after[0].agent_role).toBe('coder');
			expect(after[0].valid_from).toBe(record.createdAt);
		} finally {
			provider.close?.();
		}
		await gateway.dispose();
	});

	test('exportJsonl carries provenance (final-critic: no export strip)', async () => {
		const gateway = new MemoryGateway(
			{
				directory: tmpDir,
				sessionID: 'session-a',
				agentRole: 'coder',
				unitId: '7.8',
			},
			{
				config: sqliteConfig(),
				now: () => new Date('2026-08-22T10:00:00.000Z'),
			},
		);
		const record = gateway.createRecord({
			kind: 'code_pattern',
			text: 'export provenance probe',
			source: { type: 'file', filePath: 'src/probe.ts' },
		});
		await gateway.upsertCurated(record);
		const provider = new SQLiteMemoryProvider(tmpDir, sqliteConfig());
		try {
			const output = await provider.exportJsonl();
			const fs = await import('node:fs');
			const lines = fs
				.readFileSync(output.memoriesPath, 'utf-8')
				.trim()
				.split('\n')
				.filter(Boolean);
			expect(lines).toHaveLength(1);
			const exported = JSON.parse(lines[0]) as Record<string, unknown>;
			expect(exported.sourceTaskId).toBe('7.8');
			expect(exported.producerAgentRole).toBe('coder');
			expect(exported.validFrom).toBe(record.createdAt);
		} finally {
			provider.close?.();
		}
		await gateway.dispose();
	});

	test('re-initialize is idempotent and backfill markers persist', async () => {
		const provider = new SQLiteMemoryProvider(tmpDir, sqliteConfig());
		await provider.initialize();
		provider.close?.();
		const second = new SQLiteMemoryProvider(tmpDir, sqliteConfig());
		try {
			await second.initialize();
			const db = openRaw();
			const markers = db
				.query<{ key: string }, []>('SELECT key FROM _meta')
				.all()
				.map((m) => m.key);
			db.close();
			expect(markers).toContain('provenance_columns_backfilled');
			expect(markers).toContain('event_hash_chain_backfilled');
		} finally {
			second.close?.();
		}
	});
});
