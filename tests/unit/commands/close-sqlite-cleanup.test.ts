/**
 * swarm.db archive/cleanup tests (issue #2030).
 *
 * Extracted from close-cleanup.test.ts to respect the FR-006 ratchet: that file
 * is over the 500-line cap, so the swarm.db-specific cleanup behavior (real
 * WAL-mode DB creation, VACUUM INTO snapshot verification, WAL/SHM sidecar
 * preservation) lives here.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { loadDatabaseCtor } from '../../../src/db/sqlite-loader.js';
import * as actualEvidenceManager from '../../../src/evidence/manager.js';
import * as actualKnowledgeCurator from '../../../src/hooks/knowledge-curator.js';
import { savePlan } from '../../../src/plan/manager.js';
import * as actualState from '../../../src/state.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const realSnapshotWriter = await import(
	'../../../src/session/snapshot-writer.js'
);

mock.module('../../../src/tools/write-retro.js', () => ({
	executeWriteRetro: mock(async () =>
		JSON.stringify({ success: true, phase: 1, task_id: 'r', message: 'ok' }),
	),
}));
mock.module('../../../src/hooks/knowledge-curator.js', () => ({
	...actualKnowledgeCurator,
	curateAndStoreSwarm: mock(async () => {}),
}));
mock.module('../../../src/evidence/manager.js', () => ({
	...actualEvidenceManager,
	archiveEvidence: mock(async () => {}),
}));
mock.module('../../../src/session/snapshot-writer.js', () => ({
	...realSnapshotWriter,
	flushPendingSnapshot: mock(async () => {}),
}));
mock.module('../../../src/state.js', () => ({
	...actualState,
	swarmState: {
		activeToolCalls: new Map(),
		toolAggregates: new Map(),
		activeAgent: new Map(),
		delegationChains: new Map(),
		pendingEvents: 0,
		lastBudgetPct: 0,
		agentSessions: new Map(),
		pendingRehydrations: new Set(),
	},
	endAgentSession: () => {},
	resetSwarmState: () => {},
	resetSwarmStatePreservingSingletons: () => {},
	hasActiveFullAuto: () => false,
}));
mock.module('../../../src/git/branch.js', () => ({
	isGitRepo: () => false,
	getCurrentBranch: () => 'main',
	getDefaultBaseBranch: () => 'origin/main',
	hasUncommittedChanges: () => false,
	getGitRepositoryStatus: () => ({ isRepo: false }),
	resetToRemoteBranch: () => ({
		success: true,
		targetBranch: 'main',
		message: 'Already aligned with remote',
		alreadyAligned: true,
		prunedBranches: [],
		warnings: [],
	}),
	resetToMainAfterMerge: () => ({
		success: true,
		targetBranch: 'origin/main',
		message: 'Already on main',
		warnings: [],
	}),
	_internals: {
		gitExec: () => '',
		getGitRepositoryStatus: () => ({ isRepo: false }),
	},
}));
mock.module('../../../src/plan/checkpoint.js', () => ({
	writeCheckpoint: async () => {},
}));

const { handleCloseCommand } = await import('../../../src/commands/close.js');

let testDir: string;
const swarmDir = (): string => path.join(testDir, '.swarm');

beforeEach(() => {
	testDir = canonicalMkdtemp('close-sqlite-cleanup-');
	mkdirSync(swarmDir(), { recursive: true });
});

afterEach(() => {
	if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
	mock.restore();
});

async function writePlan(): Promise<void> {
	await savePlan(testDir, {
		title: 'SQLite Cleanup',
		swarm: 'sqlite-cleanup',
		schema_version: '1.0.0',
		current_phase: 1,
		phases: [{ id: 1, name: 'P1', status: 'complete', tasks: [] }],
	});
}

function getLatestArchivePath(): string {
	const archiveBase = path.join(swarmDir(), 'archive');
	const entries = readdirSync(archiveBase).filter((e) =>
		e.startsWith('swarm-'),
	);
	expect(entries.length).toBeGreaterThanOrEqual(1);
	entries.sort();
	return path.join(archiveBase, entries[entries.length - 1]!);
}

/** Create a minimal valid WAL-mode swarm.db for the VACUUM INTO engine. */
function writeRealSwarmDb(): void {
	const Db = loadDatabaseCtor();
	const db = new Db(path.join(swarmDir(), 'swarm.db'));
	db.run('PRAGMA journal_mode = WAL;');
	db.run(
		'CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT);',
	);
	db.run('INSERT INTO schema_migrations (version, name) VALUES (?, ?)', [
		1,
		'init',
	]);
	db.close();
}

describe('swarm.db cleanup (swarm.db, swarm.db-shm, swarm.db-wal)', () => {
	it('archives and removes swarm.db', async () => {
		await writePlan();
		writeRealSwarmDb();

		await handleCloseCommand(testDir, []);

		const archivePath = getLatestArchivePath();
		expect(existsSync(path.join(archivePath, 'swarm.db'))).toBe(true);
		expect(existsSync(path.join(swarmDir(), 'swarm.db'))).toBe(false);
	});

	it('preserves swarm.db-shm (not archived, not cleaned)', async () => {
		await writePlan();
		writeFileSync(
			path.join(swarmDir(), 'swarm.db-shm'),
			Buffer.from('shm content'),
		);

		await handleCloseCommand(testDir, []);

		// WAL sidecar files are transient SQLite internals: SQLite recreates
		// them on next open. They are deliberately skipped during archiving
		// and never listed in close's clean arrays. NOTE (#2480): close now
		// closes the canonical WAL connection with a TRUNCATE checkpoint, and
		// SQLite itself removes -shm/-wal on the LAST clean connection close —
		// so absence in .swarm/ is ALSO correct; only ARCHIVING them (or close
		// unlinking them by name) would violate this contract.
		const archivePath = getLatestArchivePath();
		expect(existsSync(path.join(archivePath, 'swarm.db-shm'))).toBe(false);
	});

	it('preserves swarm.db-wal (not archived, not cleaned)', async () => {
		await writePlan();
		writeFileSync(
			path.join(swarmDir(), 'swarm.db-wal'),
			Buffer.from('wal content'),
		);

		await handleCloseCommand(testDir, []);

		// Same #2480 note as the -shm case: SQLite may remove the sidecars on
		// the last clean connection close; close itself must never archive or
		// unlink them by name.
		const archivePath = getLatestArchivePath();
		expect(existsSync(path.join(archivePath, 'swarm.db-wal'))).toBe(false);
	});

	it('swarm.db is archived with correct content; -shm/-wal sidecars are not archived', async () => {
		await writePlan();
		// Real WAL-mode DB with a committed row so the VACUUM INTO snapshot
		// has verifiable content (issue #2030: the archive must contain
		// committed rows, not a stale main-file shell).
		const Db = loadDatabaseCtor();
		const srcPath = path.join(swarmDir(), 'swarm.db');
		const db = new Db(srcPath);
		db.run('PRAGMA journal_mode = WAL;');
		db.run(
			'CREATE TABLE project_constraints (id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL);',
		);
		db.run(
			'CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL);',
		);
		db.run('INSERT INTO schema_migrations (version, name) VALUES (?, ?)', [
			1,
			'init',
		]);
		db.run('INSERT INTO project_constraints (content) VALUES (?)', [
			'committed-row',
		]);
		db.close();
		// Stage stale sidecar files (these are NOT real SQLite sidecars;
		// they verify the archive never copies sidecars even when present).
		writeFileSync(path.join(swarmDir(), 'swarm.db-shm'), Buffer.from('shm'));
		writeFileSync(path.join(swarmDir(), 'swarm.db-wal'), Buffer.from('wal'));

		await handleCloseCommand(testDir, []);

		const archivePath = getLatestArchivePath();
		// The archived DB is a real, openable SQLite snapshot containing
		// the committed row (transactionally consistent — issue #2030).
		const archivedDbPath = path.join(archivePath, 'swarm.db');
		expect(existsSync(archivedDbPath)).toBe(true);
		const Vdb = new Db(archivedDbPath);
		const row = Vdb.query(
			'SELECT COUNT(*) AS c FROM project_constraints WHERE content = ?',
		).get('committed-row');
		Vdb.close();
		expect(Number((row as { c: number }).c)).toBe(1);
		// WAL sidecar files are transient SQLite internals and are
		// deliberately excluded from archiving (see the two tests above).
		expect(existsSync(path.join(archivePath, 'swarm.db-shm'))).toBe(false);
		expect(existsSync(path.join(archivePath, 'swarm.db-wal'))).toBe(false);
	});
});
