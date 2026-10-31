// #2958 (J18) sqlite arms of the divergence suite: schema matrix (current /
// pre-v12 matching pair / skew) and the memory_proposals unresolved arm.
// Split from memory-family-divergence.test.ts (FR-006 500-line cap).
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadDatabaseCtor } from '../../../src/db/sqlite-loader';
import {
	_internals,
	migrateMemoryFamily,
} from '../../../src/memory/memory-family-migration';
import type { VettedMemoryRoot } from '../../../src/memory/storage-root';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const T1 = '2026-09-20T00:00:00.000Z';
const T2 = '2026-09-22T00:00:00.000Z';

let tmpDir: string;

beforeEach(() => {
	tmpDir = canonicalMkdtemp('swarm-family-div-sqlite-');
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

function localRoot(directory: string): VettedMemoryRoot {
	return { kind: 'local', root: path.join(directory, '.swarm'), directory };
}

interface SeedItem {
	id: string;
	updatedAt: string;
	deleted?: 0 | 1;
	payload: string;
}

function buildItemsDb(dir: string, legacy: boolean, row: SeedItem): void {
	const storage = path.join(dir, '.swarm', 'memory');
	fs.mkdirSync(storage, { recursive: true });
	const Db = loadDatabaseCtor();
	const db = new Db(path.join(storage, 'memory.db'));
	try {
		// legacy = pre-v12 8-column shape; current adds the #1466 provenance
		// columns. Both carry updated_at and id PRIMARY KEY.
		const ddl =
			'id TEXT PRIMARY KEY, scope_key TEXT NOT NULL, kind TEXT NOT NULL, updated_at TEXT NOT NULL,' +
			' expires_at TEXT, superseded_by TEXT, deleted INTEGER NOT NULL DEFAULT 0, record_json TEXT NOT NULL' +
			(legacy
				? ''
				: ', source_task_id TEXT, agent_role TEXT, embedding_model_version TEXT, valid_from TEXT, supersedes_reason TEXT');
		db.run(`CREATE TABLE memory_items (${ddl});`);
		const vals = [
			row.id,
			'global',
			'fact',
			row.updatedAt,
			null,
			null,
			row.deleted ?? 0,
			row.payload,
		];
		if (!legacy) vals.push(null, null, null, row.updatedAt, null);
		db.run(
			`INSERT INTO memory_items VALUES (${vals.map(() => '?').join(', ')});`,
			vals,
		);
	} finally {
		db.close();
	}
}

/** Build a store whose memory.db carries a memory_proposals table with one row. */
function buildProposalsDb(
	dir: string,
	proposalId: string,
	status: string,
): void {
	const storage = path.join(dir, '.swarm', 'memory');
	fs.mkdirSync(storage, { recursive: true });
	const Db = loadDatabaseCtor();
	const db = new Db(path.join(storage, 'memory.db'));
	try {
		db.run(
			'CREATE TABLE memory_proposals (id TEXT PRIMARY KEY, status TEXT NOT NULL, created_at TEXT NOT NULL, proposal_json TEXT NOT NULL);',
		);
		db.run('INSERT INTO memory_proposals VALUES (?, ?, ?, ?);', [
			proposalId,
			status,
			T1,
			JSON.stringify({ id: proposalId, status }),
		]);
	} finally {
		db.close();
	}
}

interface DestRow {
	updated_at: string;
	record_json: string;
	deleted: number;
}

function readDestItem(dir: string): DestRow | undefined {
	const Db = loadDatabaseCtor();
	const db = new Db(path.join(dir, '.swarm', 'memory', 'memory.db'));
	try {
		return db
			.query<DestRow, [string]>(
				'SELECT updated_at, record_json, deleted FROM memory_items WHERE id = ?',
			)
			.get('M') as DestRow | undefined;
	} finally {
		db.close();
	}
}

describe('#2958 schema matrix (sqlite memory_items)', () => {
	test('matching pre-v12 pair keeps merging: newer row wins on shared columns', async () => {
		const destDir = path.join(tmpDir, 'dest');
		const srcDir = path.join(tmpDir, 'src');
		buildItemsDb(destDir, true, { id: 'M', updatedAt: T1, payload: 'v1' });
		buildItemsDb(srcDir, true, { id: 'M', updatedAt: T2, payload: 'v2' });
		await migrateMemoryFamily(localRoot(destDir), localRoot(srcDir));
		const row = readDestItem(destDir);
		expect(row?.updated_at).toBe(T2);
		expect(row?.record_json).toBe('v2');
	});

	test('current vs pre-v12 skew degrades per-table (failedTables path), merge still resolves', async () => {
		const destDir = path.join(tmpDir, 'dest');
		const srcDir = path.join(tmpDir, 'src');
		buildItemsDb(destDir, false, { id: 'M', updatedAt: T1, payload: 'v1' });
		buildItemsDb(srcDir, true, { id: 'M', updatedAt: T2, payload: 'v2' });
		// Column-count skew fails the shapesMatch gate, so memory_items falls
		// back to the positional INSERT OR IGNORE SELECT * — whose 8-vs-13
		// count mismatch throws into the per-table catch → failedTables
		// (today's degradation, unchanged).
		const result = await migrateMemoryFamily(
			localRoot(destDir),
			localRoot(srcDir),
		);
		const row = readDestItem(destDir);
		expect(row?.updated_at).toBe(T1); // destination untouched
		expect(
			result.perMember.find((m) => m.filename === 'memory.db'),
		).toBeDefined();
	});

	test('sqlite memory_proposals same-id collision: destination kept, id reported unresolved', async () => {
		const destDir = path.join(tmpDir, 'dest');
		const srcDir = path.join(tmpDir, 'src');
		// created_at is immutable at propose, so recency cannot resolve the
		// collision — the table keeps INSERT OR IGNORE and reports the id.
		buildProposalsDb(destDir, 'P1', 'pending');
		buildProposalsDb(srcDir, 'P1', 'applied');
		const result = await migrateMemoryFamily(
			localRoot(destDir),
			localRoot(srcDir),
		);
		const Db = loadDatabaseCtor();
		const db = new Db(path.join(destDir, '.swarm', 'memory', 'memory.db'));
		try {
			const kept = db
				.query<{ status: string }, []>(
					"SELECT status FROM memory_proposals WHERE id = 'P1'",
				)
				.get();
			expect(kept?.status).toBe('pending'); // destination version kept
		} finally {
			db.close();
		}
		const audit = result.audit.find((m) => m.filename === 'memory.db');
		expect(audit?.unresolvedCollisions).toContain('P1');
		expect(audit?.resurrectedIds).toHaveLength(0);
	});
});

describe('#2958 outcome-events control (fail-closed, unchanged)', () => {
	test('same-id different-payload outcome events still throw', () => {
		const dest = [
			{
				id: 'e1',
				memoryId: 'M',
				generation: 'g1',
				outcome: { outcome: 'useful', at: T1 },
				anchors: [],
			},
		];
		const src = [
			{
				id: 'e1',
				memoryId: 'M',
				generation: 'g1',
				outcome: { outcome: 'dead_end', at: T2 },
				anchors: [],
			},
		];
		expect(() => _internals.appendUnionOutcomeEvents(dest, src)).toThrow(
			/different payload|identity/i,
		);
	});
});
