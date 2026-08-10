/**
 * Tests for swarm.db archival via runArchiveStage using the in-process
 * VACUUM INTO snapshot engine (src/commands/archive-sqlite.ts), introduced by
 * issue #2030.
 *
 * The legacy `copySqliteSafe` (external sqlite3 CLI checkpoint + raw main-file
 * copy) is gone — it lost committed WAL rows when the CLI was absent (common on
 * Windows) and introduced a forbidden external dependency. The new engine
 * produces a transactionally-consistent single-file snapshot via the shared
 * sqlite-loader under both Bun and Node (focused engine tests live in
 * archive-sqlite.test.ts; these tests cover the runArchiveStage integration).
 *
 * The former `_internals.spawnSync envOverrides` describe block is removed:
 * env-merge behavior is now tested directly against mergeEnvForChild in
 * close-spawnsync-env.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CloseStageContext } from '../../../src/commands/close.js';
import { KnowledgeConfigSchema } from '../../../src/config/schema.js';
import { loadDatabaseCtor } from '../../../src/db/sqlite-loader.js';

let testDir: string;

beforeEach(() => {
	testDir = mkdtempSync(path.join(os.tmpdir(), 'close-sqlite-test-'));
	mkdirSync(path.join(testDir, '.swarm'), { recursive: true });
});

afterEach(async () => {
	try {
		rmSync(testDir, { recursive: true, force: true });
	} catch {}
	await mock.restore();
});

function makeCtx(): CloseStageContext {
	return {
		directory: testDir,
		swarmDir: path.join(testDir, '.swarm'),
		planData: { title: 'test', phases: [] },
		planExists: false,
		planAlreadyDone: false,
		config: KnowledgeConfigSchema.parse({}),
		projectName: 'test',
		warnings: [],
		closedPhases: [],
		closedTasks: [],
		sessionStart: undefined,
		isForced: false,
		runSkillReview: false,
		options: {},
		phases: [],
		inProgressPhases: [],
		curationSucceeded: false,
		curationResult: undefined,
		allLessons: [],
		explicitLessons: [],
		retroLessons: [],
		knowledgeSkillHint: '',
		skillReviewSummary: '',
		postMortemSummary: '',
		hivePromoted: 0,
		sessionKnowledgeCreated: 0,
		fallbackKnowledgeCreated: 0,
		originalStatuses: new Map(),
		guaranteeResult: { closedPhaseIds: [], closedTaskIds: [] },
		archiveResult: '',
		archivedFileCount: 0,
		archivedActiveStateFiles: new Set<string>(),
		archivedActiveStateDirs: new Set<string>(),
		archiveFailureReasons: new Map<string, string>(),
		archiveResults: [],
		archiveStageFailed: false,
		timestamp: '',
		archiveDir: '',
		archiveSuffix: '',
		args: [],
	};
}

/**
 * Create a real WAL-mode swarm.db with the given committed project_constraints
 * rows, so the snapshot engine has real committed data to capture.
 */
function createRealWalSource(committedRows: number): void {
	const Db = loadDatabaseCtor();
	const srcPath = path.join(testDir, '.swarm', 'swarm.db');
	const db = new Db(srcPath);
	db.run('PRAGMA journal_mode = WAL;');
	db.run('PRAGMA synchronous = NORMAL;');
	db.run('PRAGMA busy_timeout = 5000;');
	db.run(`CREATE TABLE project_constraints (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		constraint_type TEXT NOT NULL,
		content TEXT NOT NULL,
		created_at TEXT NOT NULL DEFAULT (datetime('now'))
	);`);
	db.run(`CREATE TABLE schema_migrations (
		version INTEGER PRIMARY KEY,
		name TEXT NOT NULL,
		applied_at TEXT NOT NULL DEFAULT (datetime('now'))
	);`);
	for (let i = 0; i < committedRows; i++) {
		db.run(
			'INSERT INTO project_constraints (constraint_type, content) VALUES (?, ?)',
			['type_a', `committed-row-${i}`],
		);
	}
	db.run('INSERT INTO schema_migrations (version, name) VALUES (?, ?)', [
		1,
		'create_project_constraints',
	]);
	db.close();
}

async function importClose() {
	const { _internals: ci } = await import('../../../src/commands/close.js');
	const realArchiveEvidence = ci.archiveEvidence;
	const realLoadPluginConfigWithMeta = ci.loadPluginConfigWithMeta;
	const realFlush = ci.flushAndDrainTelemetry;
	ci.loadPluginConfigWithMeta = () => ({
		config: {
			knowledge: { enabled: true, hive_enabled: false },
			curator: { enabled: false, postmortem_enabled: false },
			skill_improver: { enabled: false },
			evidence: {},
		},
		loadedFromFile: null,
	});
	ci.archiveEvidence = mock(async () => []);
	// No-op flush: these tests do not initialize the telemetry stream.
	ci.flushAndDrainTelemetry = async () => {};
	return {
		ci,
		restore() {
			ci.archiveEvidence = realArchiveEvidence;
			ci.loadPluginConfigWithMeta = realLoadPluginConfigWithMeta;
			ci.flushAndDrainTelemetry = realFlush;
		},
	};
}

describe('swarm.db archival via runArchiveStage (issue #2030 VACUUM INTO)', () => {
	it('live-WAL source → snapshot succeeds, added to archivedActiveStateFiles', async () => {
		createRealWalSource(5);
		const { ci, restore } = await importClose();
		try {
			const ctx = makeCtx();
			await ci.runArchiveStage(ctx);

			// swarm.db was successfully snapshotted → safe to clean.
			expect(ctx.archivedActiveStateFiles.has('swarm.db')).toBe(true);
			expect(ctx.warnings.some((w) => w.includes('swarm.db'))).toBe(false);

			// Structured result recorded truthfully.
			const dbResult = ctx.archiveResults.find(
				(r) => r.artifact === 'swarm.db',
			);
			expect(dbResult).toBeDefined();
			expect(dbResult!.attempt).toBe('succeeded');
			expect(dbResult!.validation).toBe('passed');
			expect(dbResult!.method).toBe('vacuum_into');
			expect(dbResult!.reason_code).toBe('ok');
			expect(dbResult!.row_counts?.project_constraints).toBe(5);

			// The archive bundle contains a single self-contained swarm.db.
			const archiveBase = path.join(testDir, '.swarm', 'archive');
			const bundle = existsSync(archiveBase)
				? require('node:fs').readdirSync(archiveBase)[0]
				: null;
			expect(bundle).toBeTruthy();
			const archivedDb = path.join(archiveBase, bundle, 'swarm.db');
			expect(existsSync(archivedDb)).toBe(true);
			// No sidecars archived.
			expect(existsSync(archivedDb + '-wal')).toBe(false);
			expect(existsSync(archivedDb + '-shm')).toBe(false);
		} finally {
			restore();
		}
	});

	it('source absent → silent skip, no warning, structured result is absent', async () => {
		// Do NOT create swarm.db.
		const { ci, restore } = await importClose();
		try {
			const ctx = makeCtx();
			await ci.runArchiveStage(ctx);

			expect(ctx.archivedActiveStateFiles.has('swarm.db')).toBe(false);
			// No warning about swarm.db (absent optional is silent).
			expect(ctx.warnings.some((w) => w.includes('swarm.db'))).toBe(false);

			const dbResult = ctx.archiveResults.find(
				(r) => r.artifact === 'swarm.db',
			);
			expect(dbResult).toBeDefined();
			expect(dbResult!.attempt).toBe('not_attempted');
			expect(dbResult!.source_disposition).toBe('absent');
			expect(dbResult!.reason_code).toBe('source_absent');
		} finally {
			restore();
		}
	});

	it('archive_valid=true and archive_empty=false when swarm.db has rows', async () => {
		createRealWalSource(3);
		const { ci, restore } = await importClose();
		try {
			const ctx = makeCtx();
			await ci.runArchiveStage(ctx);

			const dbResult = ctx.archiveResults.find(
				(r) => r.artifact === 'swarm.db',
			);
			// Prose derived from the same results array (no failure → "Archived N").
			expect(ctx.archiveResult).toContain('Archived');
			// The telemetry event would carry archive_valid=true, archive_empty=false.
			// We assert the derivation inputs here (the event emission itself is
			// covered in close-archive-result-event.test.ts).
			const anyFailed = ctx.archiveResults.some((r) => r.attempt === 'failed');
			expect(anyFailed).toBe(false); // archive_valid
			const sqliteSnapshots = ctx.archiveResults.filter(
				(r) => r.method === 'vacuum_into' && r.attempt === 'succeeded',
			);
			const archiveEmpty =
				sqliteSnapshots.length > 0 &&
				sqliteSnapshots.every(
					(r) =>
						(r.row_counts?.project_constraints ?? 0) === 0 &&
						(r.row_counts?.qa_gate_profile ?? 0) === 0,
				);
			expect(archiveEmpty).toBe(false);
			expect(dbResult!.row_counts!.project_constraints).toBe(3);
		} finally {
			restore();
		}
	});
});
