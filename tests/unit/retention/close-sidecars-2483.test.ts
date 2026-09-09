/**
 * Issue #2483 close-lifecycle artifacts: array memberships (repo-graph
 * fingerprint in BOTH archive+clean arrays; runs/epic dirs; epic-state.json /
 * turbo-state.json in both), removeSqliteSidecarsAfterClose behavior on a
 * temp dir (removal, missing-dir no-throw, read-only fail-open skip), and the
 * preserved VACUUM INTO archive for a real swarm.db. Harness mirrors
 * tests/unit/commands/close-sqlite-cleanup.test.ts (issue #2030).
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import {
	chmodSync,
	existsSync,
	mkdirSync,
	type PathLike,
	readdirSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { closeProjectDb } from '../../../src/db/project-db.js';
import { loadDatabaseCtor } from '../../../src/db/sqlite-loader.js';
import { savePlan } from '../../../src/plan/manager.js';
import { installCloseCommandMocks } from '../../helpers/close-command-mocks';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

installCloseCommandMocks();

const {
	handleCloseCommand,
	removeSqliteSidecarsAfterClose,
	ARCHIVE_ARTIFACTS,
	ACTIVE_STATE_TO_CLEAN,
	ACTIVE_STATE_DIRS_TO_CLEAN,
	_internals,
} = await import('../../../src/commands/close.js');

let testDir: string;
const swarmDir = (): string => path.join(testDir, '.swarm');

beforeEach(() => {
	testDir = canonicalMkdtemp('close-sidecars-2483-');
	mkdirSync(swarmDir(), { recursive: true });
});

afterEach(() => {
	closeProjectDb(testDir);
	if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
	mock.restore();
});

describe('close array memberships (#2483: fingerprint, epic state, runs)', () => {
	it('repo-graph.fingerprint.json is in BOTH ARCHIVE_ARTIFACTS and ACTIVE_STATE_TO_CLEAN (with its sibling repo-graph.json)', () => {
		expect(ARCHIVE_ARTIFACTS).toContain('repo-graph.fingerprint.json');
		expect(ACTIVE_STATE_TO_CLEAN).toContain('repo-graph.fingerprint.json');
		expect(ARCHIVE_ARTIFACTS).toContain('repo-graph.json');
		expect(ACTIVE_STATE_TO_CLEAN).toContain('repo-graph.json');
	});

	it('runs and epic are in ACTIVE_STATE_DIRS_TO_CLEAN; recovery stays out (the sweep owns it)', () => {
		expect(ACTIVE_STATE_DIRS_TO_CLEAN).toContain('runs');
		expect(ACTIVE_STATE_DIRS_TO_CLEAN).toContain('epic');
		// Fix-plan R6: recovery/ is sweep-owned, deliberately NOT a close
		// artifact — close must not delete recoverable lane state.
		expect(ACTIVE_STATE_DIRS_TO_CLEAN).not.toContain('recovery');
		expect(ARCHIVE_ARTIFACTS).not.toContain('recovery');
		expect(ACTIVE_STATE_TO_CLEAN).not.toContain('recovery');
	});

	it('epic-state.json and turbo-state.json are in BOTH arrays', () => {
		expect(ARCHIVE_ARTIFACTS).toContain('epic-state.json');
		expect(ACTIVE_STATE_TO_CLEAN).toContain('epic-state.json');
		expect(ARCHIVE_ARTIFACTS).toContain('turbo-state.json');
		expect(ACTIVE_STATE_TO_CLEAN).toContain('turbo-state.json');
	});

	it('swarm.db-wal / swarm.db-shm stay OUT of both arrays (sidecars are removed post-unlink instead)', () => {
		expect(ARCHIVE_ARTIFACTS).not.toContain('swarm.db-wal');
		expect(ARCHIVE_ARTIFACTS).not.toContain('swarm.db-shm');
		expect(ACTIVE_STATE_TO_CLEAN).not.toContain('swarm.db-wal');
		expect(ACTIVE_STATE_TO_CLEAN).not.toContain('swarm.db-shm');
	});
});

describe('removeSqliteSidecarsAfterClose', () => {
	it('removes both sidecar files from an existing .swarm dir', () => {
		writeFileSync(path.join(swarmDir(), 'swarm.db-wal'), 'wal');
		writeFileSync(path.join(swarmDir(), 'swarm.db-shm'), 'shm');
		removeSqliteSidecarsAfterClose(swarmDir());
		expect(existsSync(path.join(swarmDir(), 'swarm.db-wal'))).toBe(false);
		expect(existsSync(path.join(swarmDir(), 'swarm.db-shm'))).toBe(false);
	});

	it('does not throw when the directory is missing (per-file ENOENT fail-open)', () => {
		const missing = path.join(testDir, 'absent-swarm');
		expect(() => removeSqliteSidecarsAfterClose(missing)).not.toThrow();
	});

	it('EBUSY on one sidecar is skipped silently and the sibling is still removed (_internals seam, review FB-7)', () => {
		const walPath = path.join(swarmDir(), 'swarm.db-wal');
		const shmPath = path.join(swarmDir(), 'swarm.db-shm');
		writeFileSync(walPath, 'busy-wal');
		writeFileSync(shmPath, 'plain-shm');
		const realUnlinkSidecarSync = _internals.unlinkSidecarSync;
		const attempted: string[] = [];
		_internals.unlinkSidecarSync = (p: PathLike) => {
			attempted.push(String(p));
			if (String(p).endsWith('swarm.db-wal')) {
				const err = new Error('file in use') as NodeJS.ErrnoException & Error;
				err.code = 'EBUSY';
				throw err;
			}
			return realUnlinkSidecarSync(p);
		};
		try {
			expect(() => removeSqliteSidecarsAfterClose(swarmDir())).not.toThrow();
			// The EBUSY sidecar survives (fail-open skip); the loop still
			// reaches the sibling and removes it.
			expect(existsSync(walPath)).toBe(true);
			expect(existsSync(shmPath)).toBe(false);
			expect(attempted).toEqual([walPath, shmPath]);
		} finally {
			_internals.unlinkSidecarSync = realUnlinkSidecarSync;
		}
	});

	it('read-only sidecar never aborts the helper: no throw, the writable sibling is still removed (per-file fail-open)', () => {
		const walPath = path.join(swarmDir(), 'swarm.db-wal');
		const shmPath = path.join(swarmDir(), 'swarm.db-shm');
		writeFileSync(walPath, 'locked-wal');
		writeFileSync(shmPath, 'plain-shm');
		chmodSync(walPath, 0o444);
		try {
			// Fail-open contract: an unlink failure (EPERM on hosts that refuse
			// read-only deletion, EBUSY on Windows open-handle collisions) is
			// logged and skipped per-file — the call itself never throws and
			// the OTHER sidecar is still processed. The pinned Bun toolchain
			// unlinks read-only files on Windows too, so the read-only wal is
			// expected to be gone on every CI platform.
			expect(() => removeSqliteSidecarsAfterClose(swarmDir())).not.toThrow();
			expect(existsSync(shmPath)).toBe(false);
			expect(existsSync(walPath)).toBe(false);
		} finally {
			try {
				chmodSync(walPath, 0o666);
			} catch {
				/* file may already be gone */
			}
		}
	});
});

describe('VACUUM INTO archive still produced for a real swarm.db', () => {
	it('close archives a transactionally consistent snapshot with committed rows; live sidecars removed after the unlink', async () => {
		await savePlan(testDir, {
			title: 'Sidecars 2483',
			swarm: 'sidecars-2483',
			schema_version: '1.0.0',
			current_phase: 1,
			phases: [{ id: 1, name: 'P1', status: 'complete', tasks: [] }],
		});
		const Db = loadDatabaseCtor();
		closeProjectDb(testDir);
		const db = new Db(path.join(swarmDir(), 'swarm.db'));
		db.run('PRAGMA journal_mode = WAL;');
		db.run(
			'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL);',
		);
		db.run(
			'CREATE TABLE IF NOT EXISTS project_constraints (id INTEGER PRIMARY KEY AUTOINCREMENT, constraint_type TEXT NOT NULL, content TEXT NOT NULL);',
		);
		db.run(
			'INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (?, ?)',
			[1, 'init'],
		);
		db.run(
			'INSERT INTO project_constraints (constraint_type, content) VALUES (?, ?)',
			['regression', 'committed-row'],
		);
		db.close();
		writeFileSync(path.join(swarmDir(), 'swarm.db-shm'), Buffer.from('shm'));
		writeFileSync(path.join(swarmDir(), 'swarm.db-wal'), Buffer.from('wal'));

		const output = await handleCloseCommand(testDir, []);
		expect(output).toContain('finalized');

		const archiveBase = path.join(swarmDir(), 'archive');
		const entries = readdirSync(archiveBase).filter((e) =>
			e.startsWith('swarm-'),
		);
		expect(entries.length).toBeGreaterThanOrEqual(1);
		entries.sort();
		const archivePath = path.join(archiveBase, entries[entries.length - 1]!);

		const archivedDbPath = path.join(archivePath, 'swarm.db');
		expect(existsSync(archivedDbPath)).toBe(true);
		const Vdb = new Db(archivedDbPath);
		const row = Vdb.query(
			'SELECT COUNT(*) AS c FROM project_constraints WHERE content = ?',
		).get('committed-row');
		Vdb.close();
		expect(Number((row as { c: number }).c)).toBe(1);
		// Sidecar paths are never archived and are gone from the live dir
		// after the swarm.db unlink (#2483, reversing #1692).
		expect(existsSync(path.join(archivePath, 'swarm.db-shm'))).toBe(false);
		expect(existsSync(path.join(archivePath, 'swarm.db-wal'))).toBe(false);
		expect(existsSync(path.join(swarmDir(), 'swarm.db'))).toBe(false);
		expect(existsSync(path.join(swarmDir(), 'swarm.db-shm'))).toBe(false);
		expect(existsSync(path.join(swarmDir(), 'swarm.db-wal'))).toBe(false);
	}, 60_000);
});
