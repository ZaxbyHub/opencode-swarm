import { afterEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { DURABILITY_CLASSES } from '../../../src/db/durability';
import { closeProjectDb, getProjectDb } from '../../../src/db/project-db';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const roots: string[] = [];

afterEach(() => {
	while (roots.length > 0) {
		const directory = roots.pop()!;
		closeProjectDb(directory);
		rmSync(directory, { recursive: true, force: true });
	}
});

describe('plan-ledger SQLite migrations', () => {
	test('creates the additive event, state, and import schema', () => {
		const directory = canonicalMkdtemp('plan-ledger-migration-');
		roots.push(directory);
		const db = getProjectDb(directory);
		const tables = db
			.query<{ name: string }, []>(
				"SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'plan_ledger%' ORDER BY name",
			)
			.all()
			.map((row) => row.name);
		expect(tables).toEqual([
			'plan_ledger_event',
			'plan_ledger_import',
			'plan_ledger_state',
		]);

		const columns = (table: string): string[] =>
			db
				.query<{ name: string }, []>(`PRAGMA table_info("${table}")`)
				.all()
				.map((row) => row.name);
		expect(columns('plan_ledger_event')).toEqual(
			expect.arrayContaining([
				'canonical_event',
				'event_hash',
				'root_event_hash',
				'plan_epoch',
				'seq',
				'event_type',
				'plan_id',
				'plan_hash_before',
				'plan_hash_after',
			]),
		);
		expect(columns('plan_ledger_state')).toEqual(
			expect.arrayContaining([
				'id',
				'authority_mode',
				'shadow_started_version',
				'parity_status',
				'file_replay_hash',
				'sqlite_replay_hash',
				'terminal_projection_hash',
				'last_seq',
				'terminal_projection',
				'terminal_metadata',
			]),
		);
		expect(columns('plan_ledger_import')).toEqual(
			expect.arrayContaining([
				'source',
				'source_hash',
				'archive_path',
				'archive_hash',
				'archive_size',
				'archive_created_at',
			]),
		);
	});

	test('classifies all plan-ledger tables as FULL durability', () => {
		expect(DURABILITY_CLASSES.plan_ledger_event).toBe('full');
		expect(DURABILITY_CLASSES.plan_ledger_state).toBe('full');
		expect(DURABILITY_CLASSES.plan_ledger_import).toBe('full');
	});
});
