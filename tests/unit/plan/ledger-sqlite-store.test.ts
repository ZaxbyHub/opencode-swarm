import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { closeProjectDb } from '../../../src/db/project-db';
import { loadDatabaseCtor } from '../../../src/db/sqlite-loader';
import {
	appendSqliteLedger,
	clearSqliteLedger,
	cutoverSqliteLedger,
	getPlanLedgerState,
	getPlanLedgerStateReadOnly,
	hasSqliteLedger,
	importSqliteLedger,
	readSqliteLedgerEvents,
	readSqliteLedgerEventsReadOnly,
	recordSqliteLedgerParity,
	replaceSqliteLedger,
	SqliteLedgerImportError,
	SqliteLedgerStaleWriterError,
} from '../../../src/plan/ledger-sqlite';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const roots: string[] = [];

afterEach(() => {
	while (roots.length > 0) {
		const directory = roots.pop()!;
		closeProjectDb(directory);
		rmSync(directory, { recursive: true, force: true });
	}
});

function event(seq: number, title = `event-${seq}`): string {
	return JSON.stringify({
		seq,
		timestamp: `2026-01-01T00:00:0${seq}.000Z`,
		plan_id: 'plan-2484',
		event_type: seq === 1 ? 'plan_created' : 'task_updated',
		source: 'test',
		plan_hash_before: seq === 1 ? '' : `before-${seq}`,
		plan_hash_after: `after-${seq}`,
		schema_version: '1.1.0',
		payload: { title },
	});
}

describe('SQLite plan-ledger store', () => {
	test('imports exact canonical bytes, metadata, state, and archive metadata', () => {
		const directory = canonicalMkdtemp('ledger-sqlite-import-');
		roots.push(directory);
		const first = event(1, 'replacement � character');
		const second = event(2);
		const result = importSqliteLedger(directory, {
			canonicalEvents: [first, second],
			source: 'plan-ledger.jsonl',
			sourceHash: 'source-hash',
			archivePath: '.swarm/plan-ledger.migration-archive.source-hash.jsonl',
			archiveHash: 'archive-hash',
			archiveSize: 123,
			archiveCreatedAt: '2026-01-01T00:00:00.000Z',
			mode: 'file_shadow',
			version: '7.99.0',
			state: {
				authorityMode: 'file_shadow',
				shadowStartedVersion: '7.99.0',
				parityStatus: 'pending',
			},
		});
		expect(result.events).toHaveLength(2);
		expect(new TextDecoder().decode(result.events[0]!.canonicalEvent)).toBe(
			first,
		);
		expect(result.events[0]!.eventHash).toMatch(/^[a-f0-9]{64}$/);
		expect(result.events[0]!.event).toEqual(
			expect.objectContaining({ seq: 1 }),
		);
		expect(result.state?.authorityMode).toBe('file_shadow');
		expect(result.state?.lastSeq).toBe(2);
		expect(result.import?.sourceHash).toBe('source-hash');
		expect(result.import?.archivePath).toContain('migration-archive');
		expect(hasSqliteLedger(directory)).toBe(true);

		const repeated = importSqliteLedger(directory, {
			canonicalEvents: [first, second],
			source: 'plan-ledger.jsonl',
			sourceHash: 'source-hash',
			mode: 'file_shadow',
		});
		expect(repeated.events).toHaveLength(2);
	});

	test('appends event and terminal state in one FULL transaction', () => {
		const directory = canonicalMkdtemp('ledger-sqlite-append-');
		roots.push(directory);
		importSqliteLedger(directory, {
			canonicalEvents: [event(1)],
			state: { authorityMode: 'sqlite', parityStatus: 'pending' },
		});
		const projection = new TextEncoder().encode('{"title":"terminal"}');
		const appended = appendSqliteLedger(directory, {
			canonicalEvent: event(2),
			state: {
				lastSeq: 2,
				terminalProjection: projection,
				terminalPlanHash: 'after-2',
			},
			expectedSeq: 1,
		});
		expect(appended.seq).toBe(2);
		const state = getPlanLedgerState(directory);
		expect(state?.lastSeq).toBe(2);
		expect(state?.terminalPlanHash).toBe('after-2');
		expect(state?.terminalProjection).toEqual(projection);
	});

	test('rejects caller metadata that disagrees with canonical event bytes atomically', () => {
		const directory = canonicalMkdtemp('ledger-sqlite-metadata-');
		roots.push(directory);
		expect(() =>
			importSqliteLedger(directory, {
				canonicalEvents: [
					{
						canonicalEvent: event(1),
						metadata: { eventType: 'task_updated' },
					},
				],
			}),
		).toThrow(SqliteLedgerImportError);
		expect(hasSqliteLedger(directory)).toBe(false);
		expect(getPlanLedgerState(directory)).toBeNull();
	});

	test('records structured parity and performs guarded cutover', () => {
		const directory = canonicalMkdtemp('ledger-sqlite-cutover-');
		roots.push(directory);
		importSqliteLedger(directory, {
			canonicalEvents: [event(1)],
			version: '1.0.0',
			state: { authorityMode: 'file_shadow', shadowStartedVersion: '1.0.0' },
		});
		recordSqliteLedgerParity(directory, {
			fileReplayHash: 'a'.repeat(64),
			sqliteReplayHash: 'a'.repeat(64),
			terminalProjectionHash: 'b'.repeat(64),
		});
		const state = cutoverSqliteLedger(directory, {
			expectedShadowStartedVersion: '1.0.0',
			version: '2.0.0',
		});
		expect(state.authorityMode).toBe('sqlite');
		expect(state.parityStatus).toBe('clean');
	});

	test('rejects stale CAS and supports atomic replacement/clear', () => {
		const directory = canonicalMkdtemp('ledger-sqlite-reset-');
		roots.push(directory);
		importSqliteLedger(directory, { canonicalEvents: [event(1)] });
		expect(() =>
			appendSqliteLedger(directory, {
				canonicalEvent: event(2),
				expectedSeq: 0,
			}),
		).toThrow(SqliteLedgerStaleWriterError);
		replaceSqliteLedger(directory, {
			canonicalEvents: [event(1, 'replacement')],
			state: { authorityMode: 'sqlite' },
		});
		expect(readSqliteLedgerEvents(directory).events).toHaveLength(1);
		clearSqliteLedger(directory);
		expect(hasSqliteLedger(directory)).toBe(false);
		expect(getPlanLedgerState(directory)).toBeNull();
	});

	test('read-only state probe fails safe on a half-migrated database', () => {
		const directory = canonicalMkdtemp('ledger-sqlite-half-migrated-');
		roots.push(directory);
		const swarmDir = path.join(directory, '.swarm');
		mkdirSync(swarmDir, { recursive: true });
		const Db = loadDatabaseCtor();
		const db = new Db(path.join(swarmDir, 'swarm.db'));
		db.run(
			'CREATE TABLE plan_ledger_event (seq INTEGER PRIMARY KEY, canonical_event BLOB NOT NULL);',
		);
		db.close();

		expect(getPlanLedgerStateReadOnly(directory)).toBeNull();
	});

	test('read-only state probe hides SQLite authority while reset marker exists', () => {
		const directory = canonicalMkdtemp('ledger-sqlite-reset-marker-');
		roots.push(directory);
		importSqliteLedger(directory, {
			canonicalEvents: [event(1)],
			state: { authorityMode: 'sqlite' },
		});
		writeFileSync(
			path.join(directory, '.swarm', 'plan-ledger.resetting'),
			'resetting\n',
		);

		expect(getPlanLedgerStateReadOnly(directory)).toBeNull();
		expect(readSqliteLedgerEventsReadOnly(directory).events).toHaveLength(0);
	});
});
