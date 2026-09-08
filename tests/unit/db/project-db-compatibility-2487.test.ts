/**
 * Issue #2487 acceptance check AC2.
 *
 * A newer swarm.db must be rejected before the current binary attempts a
 * migration, import, fallback, or write. This is deliberately an arm's-length
 * check: it exercises the exported migration boundary without using mocks.
 */
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { ProjectDbError } from '../../../src/db/db-errors.js';
import { runProjectMigrations } from '../../../src/db/project-db.js';

describe('issue #2487 — future schema compatibility', () => {
	test('AC2: future schema refuses before any migration mutation', () => {
		const db = new Database(':memory:');
		try {
			db.run(`CREATE TABLE schema_migrations (
				version INTEGER PRIMARY KEY,
				name TEXT NOT NULL,
				applied_at TEXT NOT NULL
			)`);
			db.run(
				'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
				[999, 'future-writer', '2026-09-07T00:00:00.000Z'],
			);
			const before = db
				.query<{ name: string }, []>(
					"SELECT name FROM sqlite_master WHERE type IN ('table', 'index', 'trigger') ORDER BY name",
				)
				.all();

			let caught: unknown;
			try {
				runProjectMigrations(db);
			} catch (error) {
				caught = error;
			}

			expect(caught).toBeInstanceOf(ProjectDbError);
			expect((caught as ProjectDbError).category).toBe('schema_incompatible');
			expect((caught as Error).message).toMatch(/newer|future|unsupported/i);
			expect(
				db
					.query<{ version: number; name: string }, []>(
						'SELECT version, name FROM schema_migrations ORDER BY version',
					)
					.all(),
			).toEqual([{ version: 999, name: 'future-writer' }]);
			expect(
				db
					.query<{ name: string }, []>(
						"SELECT name FROM sqlite_master WHERE type IN ('table', 'index', 'trigger') ORDER BY name",
					)
					.all(),
			).toEqual(before);
		} finally {
			db.close();
		}
	});
});
