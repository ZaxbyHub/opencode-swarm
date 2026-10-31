// #2958 (J18): divergence + tombstone semantics — recency newer-wins on both
// providers, proposal review ordering, resurrection audit, unresolved
// collisions, multi-row history, schema matrix, outcome-events control.
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
const T3 = '2026-09-24T00:00:00.000Z';

let tmpDir: string;

beforeEach(() => {
	tmpDir = canonicalMkdtemp('swarm-family-divergence-');
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

function localRoot(directory: string): VettedMemoryRoot {
	return { kind: 'local', root: path.join(directory, '.swarm'), directory };
}

function writeJsonl(dir: string, filename: string, rows: unknown[]): void {
	const storage = path.join(dir, '.swarm', 'memory');
	fs.mkdirSync(storage, { recursive: true });
	const lines = rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
	fs.writeFileSync(path.join(storage, filename), lines, 'utf-8');
}

function readJsonlRows(
	dir: string,
	filename: string,
): Record<string, unknown>[] {
	const p = path.join(dir, '.swarm', 'memory', filename);
	return fs
		.readFileSync(p, 'utf-8')
		.split('\n')
		.filter((l) => l.trim())
		.map((l) => JSON.parse(l) as Record<string, unknown>);
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

/** Collect every id in any resurrectedIds array anywhere in the result. */
function collectResurrected(value: unknown, out: Set<string>): void {
	if (Array.isArray(value)) {
		for (const item of value) collectResurrected(item, out);
	} else if (value !== null && typeof value === 'object') {
		for (const [key, child] of Object.entries(
			value as Record<string, unknown>,
		)) {
			if (key === 'resurrectedIds' && Array.isArray(child)) {
				for (const id of child) if (typeof id === 'string') out.add(id);
			} else collectResurrected(child, out);
		}
	}
}

describe('#2958 sqlite divergence', () => {
	test('source-newer row wins: destination serves v2 at T2 (audit reproduction flipped)', async () => {
		const destDir = path.join(tmpDir, 'dest');
		const srcDir = path.join(tmpDir, 'src');
		buildItemsDb(destDir, false, { id: 'M', updatedAt: T1, payload: 'v1' });
		buildItemsDb(srcDir, false, { id: 'M', updatedAt: T2, payload: 'v2' });
		await migrateMemoryFamily(localRoot(destDir), localRoot(srcDir));
		const row = readDestItem(destDir);
		expect(row?.updated_at).toBe(T2);
		expect(row?.record_json).toBe('v2');
	});

	test('destination-newer mirror: unchanged (no data movement)', async () => {
		const destDir = path.join(tmpDir, 'dest');
		const srcDir = path.join(tmpDir, 'src');
		buildItemsDb(destDir, false, { id: 'M', updatedAt: T2, payload: 'v2' });
		buildItemsDb(srcDir, false, { id: 'M', updatedAt: T1, payload: 'v1' });
		const result = await migrateMemoryFamily(
			localRoot(destDir),
			localRoot(srcDir),
		);
		const row = readDestItem(destDir);
		expect(row?.updated_at).toBe(T2);
		expect(row?.record_json).toBe('v2');
		// Destination-newer keep-rows are not supersessions.
		const dbAudit = result.audit.find((m) => m.filename === 'memory.db');
		expect(dbAudit?.resurrectedIds ?? []).toHaveLength(0);
		expect(dbAudit?.supersededCount ?? 0).toBe(0);
	});
});

describe('#2958 jsonl divergence', () => {
	test('source-newer memories row wins via append (last row serves v2)', async () => {
		const destDir = path.join(tmpDir, 'dest');
		const srcDir = path.join(tmpDir, 'src');
		writeJsonl(destDir, 'memories.jsonl', [
			{ id: 'M', text: 'v1', updatedAt: T1 },
		]);
		writeJsonl(srcDir, 'memories.jsonl', [
			{ id: 'M', text: 'v2', updatedAt: T2 },
			{ id: 'N', text: 'new', updatedAt: T2 },
		]);
		const result = await migrateMemoryFamily(
			localRoot(destDir),
			localRoot(srcDir),
		);
		const rows = readJsonlRows(destDir, 'memories.jsonl');
		const mRows = rows.filter((r) => r.id === 'M');
		expect(mRows[mRows.length - 1]?.text).toBe('v2');
		expect(rows.some((r) => r.id === 'N')).toBe(true);
		const audit = result.audit.find((m) => m.filename === 'memories.jsonl');
		expect(audit?.supersededCount).toBe(1);
		expect(audit?.unresolvedCollisions).toHaveLength(0);
	});

	test('destination-newer mirror keeps v2 (skip, no unresolved)', async () => {
		const destDir = path.join(tmpDir, 'dest');
		const srcDir = path.join(tmpDir, 'src');
		writeJsonl(destDir, 'memories.jsonl', [
			{ id: 'M', text: 'v2', updatedAt: T2 },
		]);
		writeJsonl(srcDir, 'memories.jsonl', [
			{ id: 'M', text: 'v1', updatedAt: T1 },
		]);
		const result = await migrateMemoryFamily(
			localRoot(destDir),
			localRoot(srcDir),
		);
		const rows = readJsonlRows(destDir, 'memories.jsonl');
		expect(rows).toHaveLength(1);
		expect(rows[0]?.text).toBe('v2');
		const audit = result.audit.find((m) => m.filename === 'memories.jsonl');
		expect(audit?.unresolvedCollisions ?? []).toHaveLength(0);
		expect(audit?.supersededCount ?? 0).toBe(0);
	});
});

describe('#2958 proposals ordering (reviewed outranks unreviewed)', () => {
	const reviewed = (id: string, at: string, status = 'applied') => ({
		id,
		operation: 'upsert',
		status,
		proposedBy: 'curator',
		createdAt: T1,
		...(at ? { reviewedAt: at } : {}),
	});

	test('source reviewed supersedes destination pending (either direction of payload)', async () => {
		const destDir = path.join(tmpDir, 'dest');
		const srcDir = path.join(tmpDir, 'src');
		writeJsonl(destDir, 'proposals.jsonl', [reviewed('P', '')]); // pending: no reviewedAt
		writeJsonl(srcDir, 'proposals.jsonl', [reviewed('P', T2)]);
		const result = await migrateMemoryFamily(
			localRoot(destDir),
			localRoot(srcDir),
		);
		const rows = readJsonlRows(destDir, 'proposals.jsonl');
		expect(rows[rows.length - 1]?.reviewedAt).toBe(T2);
		const audit = result.audit.find((m) => m.filename === 'proposals.jsonl');
		expect(audit?.supersededCount).toBe(1);
		expect(audit?.unresolvedCollisions).toHaveLength(0);
	});

	test('destination reviewed keeps over source pending', async () => {
		const destDir = path.join(tmpDir, 'dest');
		const srcDir = path.join(tmpDir, 'src');
		writeJsonl(destDir, 'proposals.jsonl', [reviewed('P', T1)]);
		writeJsonl(srcDir, 'proposals.jsonl', [reviewed('P', '')]);
		const result = await migrateMemoryFamily(
			localRoot(destDir),
			localRoot(srcDir),
		);
		const rows = readJsonlRows(destDir, 'proposals.jsonl');
		expect(rows).toHaveLength(1);
		expect(rows[0]?.reviewedAt).toBe(T1);
		const audit = result.audit.find((m) => m.filename === 'proposals.jsonl');
		expect(audit?.unresolvedCollisions ?? []).toHaveLength(0);
	});

	test('both reviewed: newer reviewedAt wins both directions', async () => {
		for (const [newerInSource] of [[true], [false]] as const) {
			const destDir = path.join(tmpDir, `d-${String(newerInSource)}`);
			const srcDir = path.join(tmpDir, `s-${String(newerInSource)}`);
			writeJsonl(destDir, 'proposals.jsonl', [
				reviewed('P', newerInSource ? T1 : T3),
			]);
			writeJsonl(srcDir, 'proposals.jsonl', [
				reviewed('P', newerInSource ? T3 : T1),
			]);
			await migrateMemoryFamily(localRoot(destDir), localRoot(srcDir));
			const rows = readJsonlRows(destDir, 'proposals.jsonl');
			expect(rows[rows.length - 1]?.reviewedAt).toBe(T3);
		}
	});

	test('both pending: unresolved reported, destination kept', async () => {
		const destDir = path.join(tmpDir, 'dest');
		const srcDir = path.join(tmpDir, 'src');
		writeJsonl(destDir, 'proposals.jsonl', [
			{ ...reviewed('P', ''), status: 'pending', x: 1 },
		]);
		writeJsonl(srcDir, 'proposals.jsonl', [
			{ ...reviewed('P', ''), status: 'pending', x: 2 },
		]);
		const result = await migrateMemoryFamily(
			localRoot(destDir),
			localRoot(srcDir),
		);
		const rows = readJsonlRows(destDir, 'proposals.jsonl');
		expect(rows).toHaveLength(1);
		expect(rows[0]?.x).toBe(1);
		const audit = result.audit.find((m) => m.filename === 'proposals.jsonl');
		expect(audit?.unresolvedCollisions).toContain('P');
	});
});

describe('#2958 tombstone audit', () => {
	test('sqlite: dest tombstone @T1 resurrected by live source @T2 — reported AND flipped live', async () => {
		const destDir = path.join(tmpDir, 'dest');
		const srcDir = path.join(tmpDir, 'src');
		buildItemsDb(destDir, false, {
			id: 'M',
			updatedAt: T1,
			deleted: 1,
			payload: 'tomb-old',
		});
		buildItemsDb(srcDir, false, {
			id: 'M',
			updatedAt: T2,
			deleted: 0,
			payload: 'live-new',
		});
		const result: unknown = await migrateMemoryFamily(
			localRoot(destDir),
			localRoot(srcDir),
		);
		const resurrected = new Set<string>();
		collectResurrected(result, resurrected);
		expect(resurrected.has('M')).toBe(true);
		// Resurrections are counted solely via resurrectedIds (#3520 critic
		// round 2, sqlite-side pin mirroring the JSONL one).
		expect(
			(result as { audit?: Array<{ supersededCount: number }> }).audit?.find(
				(m) => m.filename === 'memory.db',
			)?.supersededCount,
		).toBe(0);
		const row = readDestItem(destDir);
		expect(row?.deleted).toBe(0);
		expect(row?.updated_at).toBe(T2);
	});

	test('sqlite: newer dest tombstone @T3 suppresses live source @T2', async () => {
		const destDir = path.join(tmpDir, 'dest');
		const srcDir = path.join(tmpDir, 'src');
		buildItemsDb(destDir, false, {
			id: 'M',
			updatedAt: T3,
			deleted: 1,
			payload: 'tomb-new',
		});
		buildItemsDb(srcDir, false, {
			id: 'M',
			updatedAt: T2,
			deleted: 0,
			payload: 'live-old',
		});
		const result = await migrateMemoryFamily(
			localRoot(destDir),
			localRoot(srcDir),
		);
		const resurrected = new Set<string>();
		collectResurrected(result, resurrected);
		expect(resurrected.has('M')).toBe(false);
		const row = readDestItem(destDir);
		expect(row?.deleted).toBe(1);
		expect(row?.updated_at).toBe(T3);
		// PRR-009: the suppression is a supersession — pin the sqlite counter
		// (deleting the suppression arm must fail here).
		const dbAudit = result.audit.find((m) => m.filename === 'memory.db');
		expect(dbAudit?.supersededCount).toBe(1);
	});

	test('jsonl: dest tombstone resurrected by newer live row — reported; newer tombstone suppresses', async () => {
		const dirA = path.join(tmpDir, 'a');
		writeJsonl(dirA, 'memories.jsonl', [
			{ id: 'M', text: 'gone', updatedAt: T1, metadata: { deleted: true } },
		]);
		const srcA = path.join(tmpDir, 'sa');
		writeJsonl(srcA, 'memories.jsonl', [
			{ id: 'M', text: 'back', updatedAt: T2 },
		]);
		const resultA = await migrateMemoryFamily(localRoot(dirA), localRoot(srcA));
		const auditA = resultA.audit.find((m) => m.filename === 'memories.jsonl');
		expect(auditA?.resurrectedIds).toContain('M');
		const rowsA = readJsonlRows(dirA, 'memories.jsonl');
		expect(rowsA[rowsA.length - 1]?.metadata).toBeUndefined();

		const dirB = path.join(tmpDir, 'b');
		writeJsonl(dirB, 'memories.jsonl', [
			{ id: 'M', text: 'gone', updatedAt: T3, metadata: { deleted: true } },
		]);
		const srcB = path.join(tmpDir, 'sb');
		writeJsonl(srcB, 'memories.jsonl', [
			{ id: 'M', text: 'older', updatedAt: T2 },
		]);
		const resultB = await migrateMemoryFamily(localRoot(dirB), localRoot(srcB));
		const auditB = resultB.audit.find((m) => m.filename === 'memories.jsonl');
		expect(auditB?.resurrectedIds ?? []).toHaveLength(0);
		expect(auditB?.supersededCount).toBe(1); // suppression counts as a supersession
		const rowsB = readJsonlRows(dirB, 'memories.jsonl');
		expect(rowsB).toHaveLength(1);
	});
});

describe('#2958 unresolved collisions and retries', () => {
	test('memories rows without a recency signal: destination kept, id reported', async () => {
		const destDir = path.join(tmpDir, 'dest');
		const srcDir = path.join(tmpDir, 'src');
		writeJsonl(destDir, 'memories.jsonl', [{ id: 'M', text: 'old' }]);
		writeJsonl(srcDir, 'memories.jsonl', [{ id: 'M', text: 'new' }]);
		const result = await migrateMemoryFamily(
			localRoot(destDir),
			localRoot(srcDir),
		);
		const rows = readJsonlRows(destDir, 'memories.jsonl');
		expect(rows).toHaveLength(1);
		expect(rows[0]?.text).toBe('old');
		const audit = result.audit.find((m) => m.filename === 'memories.jsonl');
		expect(audit?.unresolvedCollisions).toContain('M');
	});

	test('exact-retry dedup stays benign (no unresolved entries)', () => {
		const dest = [{ id: 'a', text: 'first', updatedAt: T1 }];
		const src = [
			{ id: 'a', text: 'first', updatedAt: T1 },
			{ id: 'b', text: 'second', updatedAt: T2 },
		];
		const r = _internals.appendUnionById(dest, src);
		expect(r.added).toBe(1);
		expect(r.skipped).toBe(1);
		expect(r.superseded).toBe(0);
		expect(r.unresolvedCollisions).toHaveLength(0);
		expect(r.resurrectedIds).toHaveLength(0);
	});

	test('multi-row source history resolves against the merge state (newest wins last)', () => {
		const dest = [{ id: 'M', text: 'v1', updatedAt: T1 }];
		const src = [
			{ id: 'M', text: 'v2', updatedAt: T2 },
			{ id: 'M', text: 'v3', updatedAt: T3 },
		];
		const r = _internals.appendUnionById(dest, src);
		expect(r.superseded).toBe(2);
		const mRows = r.merged.filter((x) => (x as { id: string }).id === 'M');
		expect(mRows[mRows.length - 1]).toEqual({
			id: 'M',
			text: 'v3',
			updatedAt: T3,
		});
	});

	test('consolidation rows (no id) byte-dedup benignly and never report', () => {
		const row = { phaseNumber: 1, startedAt: T1, completedAt: T1 };
		const r = _internals.appendUnionById([row], [row, { phaseNumber: 2 }], {
			memberFilename: 'consolidation-log.jsonl',
		});
		expect(r.added).toBe(1);
		expect(r.skipped).toBe(1);
		expect(r.unresolvedCollisions).toHaveLength(0);
	});
});
