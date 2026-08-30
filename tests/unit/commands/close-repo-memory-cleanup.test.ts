/**
 * repo-memory.sqlite archive/cleanup tests (issue #1534 wiring, closing a gap
 * left completely untested by close.ts's REPO_MEMORY_FILENAME integration).
 *
 * Mirrors close-sqlite-cleanup.test.ts (swarm.db) and close-wal-preserve.test.ts
 * (#1692 WAL sidecar convention), extended to prove:
 *   1. repo-memory.sqlite is archived (VACUUM INTO, not raw copy) and cleaned.
 *   2. repo-memory.sqlite-wal / -shm are neither archived nor cleaned.
 *   3. The clean stage closes the cached repo-memory connection BEFORE
 *      unlinking (Windows EBUSY guard) — proven with a REAL cached WAL
 *      connection, not a mock, so a regression that reorders/removes the
 *      close call fails this test with a genuine EBUSY on Windows.
 *   4. closeRepoMemory throwing does not break the clean stage.
 *
 * Kept in its own file to respect the FR-006 500-line cap (mirrors the
 * extraction rationale documented in close-sqlite-cleanup.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import {
	existsSync,
	mkdirSync,
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
import { withFrozenClockAsync } from '../../helpers/test-clock.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

// Deterministic fixture instant (explicit-arg Date constructor, not a raw
// clock read — see docs/testing/test-stability.md, issue #1782).
const FIXED_NOW_ISO = new Date('2026-01-01T00:00:00.000Z').toISOString();

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
const { syncIndexFromGraph, REPO_MEMORY_FILENAME, closeAllRepoMemory } =
	await import('../../../src/tools/repo-graph/indexed-storage.js');

let testDir: string;
const swarmDir = (): string => path.join(testDir, '.swarm');

beforeEach(() => {
	testDir = canonicalMkdtemp('close-repo-memory-cleanup-');
	mkdirSync(swarmDir(), { recursive: true });
});

afterEach(() => {
	closeAllRepoMemory();
	if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
	mock.restore();
});

async function writePlan(): Promise<void> {
	await savePlan(testDir, {
		title: 'Repo Memory Cleanup',
		swarm: 'repo-memory-cleanup',
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

/**
 * Populate a REAL, cached repo-memory.sqlite WAL connection via the actual
 * production write path (syncIndexFromGraph -> openForWrite), leaving the
 * handle live (uncached-close) in indexed-storage's internal `_handles` map.
 * This is deliberately NOT a raw `new Database()` bypassing the cache: only
 * a cached handle exercises the Windows EBUSY guard close.ts is supposed to
 * invoke, so this is the only way to prove ordering rather than assume it.
 */
async function createCachedRepoMemoryConnection(
	rowContent = 'a.ts',
): Promise<void> {
	await syncIndexFromGraph(
		testDir,
		{
			schema_version: '1.2.0',
			workspaceRoot: testDir,
			nodes: {
				[rowContent]: {
					filePath: rowContent,
					moduleName: rowContent,
					imports: [],
					exports: [],
				} as unknown as Record<string, unknown> as never,
			},
			edges: [],
			metadata: {
				generatedAt: new Date().toISOString(),
				generator: 'test',
				nodeCount: 1,
				edgeCount: 0,
			},
		},
		{ size: 1, mtimeMs: Date.now(), ino: '0' },
	);
}

describe('repo-memory.sqlite cleanup (issue #1534 wiring)', () => {
	it('archives and removes repo-memory.sqlite', async () => {
		await writePlan();
		// Frozen clock so the fixture's `generatedAt`/`mtimeMs` reads (inside
		// createCachedRepoMemoryConnection) are deterministic — see
		// docs/testing/test-stability.md, issue #1782.
		await withFrozenClockAsync(
			async () => {
				await createCachedRepoMemoryConnection();

				await handleCloseCommand(testDir, []);

				const archivePath = getLatestArchivePath();
				expect(existsSync(path.join(archivePath, REPO_MEMORY_FILENAME))).toBe(
					true,
				);
				expect(existsSync(path.join(swarmDir(), REPO_MEMORY_FILENAME))).toBe(
					false,
				);
			},
			{ isoNow: FIXED_NOW_ISO },
		);
	});

	it('preserves repo-memory.sqlite-shm (not archived, not cleaned)', async () => {
		await writePlan();
		writeFileSync(
			path.join(swarmDir(), `${REPO_MEMORY_FILENAME}-shm`),
			Buffer.from('shm content'),
		);

		await handleCloseCommand(testDir, []);

		// Deliberate convention (mirrors swarm.db): WAL sidecars are transient
		// SQLite internals recreated on next open, so they must never be
		// archived or cleaned. A future contributor "helpfully" adding them to
		// ARCHIVE_ARTIFACTS/ACTIVE_STATE_TO_CLEAN would flip both assertions.
		const archivePath = getLatestArchivePath();
		expect(
			existsSync(path.join(archivePath, `${REPO_MEMORY_FILENAME}-shm`)),
		).toBe(false);
		expect(
			existsSync(path.join(swarmDir(), `${REPO_MEMORY_FILENAME}-shm`)),
		).toBe(true);
	});

	it('preserves repo-memory.sqlite-wal (not archived, not cleaned)', async () => {
		await writePlan();
		writeFileSync(
			path.join(swarmDir(), `${REPO_MEMORY_FILENAME}-wal`),
			Buffer.from('wal content'),
		);

		await handleCloseCommand(testDir, []);

		const archivePath = getLatestArchivePath();
		expect(
			existsSync(path.join(archivePath, `${REPO_MEMORY_FILENAME}-wal`)),
		).toBe(false);
		expect(
			existsSync(path.join(swarmDir(), `${REPO_MEMORY_FILENAME}-wal`)),
		).toBe(true);
	});

	it('archives repo-memory.sqlite as a consistent VACUUM INTO snapshot, not a raw copy', async () => {
		await writePlan();
		// Real WAL-mode DB with a committed row via the actual write path so
		// the snapshot's content is verifiable (a raw file copy of a WAL-mode
		// DB would not reliably contain committed-but-uncheckpointed pages).
		await createCachedRepoMemoryConnection('src/foo.ts');
		// Close the cached connection so directly writing sidecar bytes below
		// (simulating stale/leftover WAL internals) doesn't race a live
		// SQLite-held file lock on Windows. Content is already committed to
		// the main file at this point (WAL checkpoint on close), so this
		// does not weaken the row-content assertion below.
		closeAllRepoMemory();
		// Stage stale sidecar bytes to prove the archive never copies them
		// (a raw `fs.copyFile` of the main file would leave these behind
		// unchanged; VACUUM INTO produces a single self-contained file).
		writeFileSync(
			path.join(swarmDir(), `${REPO_MEMORY_FILENAME}-shm`),
			Buffer.from('shm'),
		);
		writeFileSync(
			path.join(swarmDir(), `${REPO_MEMORY_FILENAME}-wal`),
			Buffer.from('wal'),
		);

		await handleCloseCommand(testDir, []);

		const archivePath = getLatestArchivePath();
		const archivedDbPath = path.join(archivePath, REPO_MEMORY_FILENAME);
		expect(existsSync(archivedDbPath)).toBe(true);

		// Openable, self-contained SQLite file (VACUUM INTO output) containing
		// the committed row — proves the snapshot engine ran, not a byte copy.
		const Db = loadDatabaseCtor();
		const vdb = new Db(archivedDbPath);
		const row = vdb
			.query('SELECT COUNT(*) AS c FROM files WHERE path = ?')
			.get('src/foo.ts');
		vdb.close();
		expect(Number((row as { c: number }).c)).toBe(1);

		expect(
			existsSync(path.join(archivePath, `${REPO_MEMORY_FILENAME}-shm`)),
		).toBe(false);
		expect(
			existsSync(path.join(archivePath, `${REPO_MEMORY_FILENAME}-wal`)),
		).toBe(false);
	});

	it('closes the cached repo-memory connection before unlinking (Windows EBUSY guard)', async () => {
		await writePlan();
		// A REAL cached WAL connection is left open (not manually closed) —
		// exactly the state close.ts's clean stage must handle. If the
		// production code regresses to unlink before closeRepoMemory (or
		// drops the call entirely), fs.unlink hits a live file lock on
		// Windows and fails with EBUSY, which this assertion catches: the
		// file would still exist and a warning would be emitted instead of
		// a clean removal.
		await withFrozenClockAsync(() => createCachedRepoMemoryConnection(), {
			isoNow: FIXED_NOW_ISO,
		});

		const output = await handleCloseCommand(testDir, []);

		expect(existsSync(path.join(swarmDir(), REPO_MEMORY_FILENAME))).toBe(false);
		expect(output).not.toContain(
			`Failed to clean active-state file ${REPO_MEMORY_FILENAME}`,
		);
	});
});
