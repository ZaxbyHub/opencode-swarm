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
