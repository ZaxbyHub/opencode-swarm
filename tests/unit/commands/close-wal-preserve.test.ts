/**
 * #1692 regression, updated by #2483: the clean stage must NOT emit the
 * misleading "Preserved <file> because it was not successfully archived"
 * warning for the SQLite WAL sidecars. Those files are not members of
 * ARCHIVE_ARTIFACTS / ACTIVE_STATE_TO_CLEAN, so the clean-stage
 * archive-first loop never considers them and the warning has no path to
 * fire. #2483 deliberately reverses #1692's preserve decision: immediately
 * after the swarm.db unlink, removeSqliteSidecarsAfterClose removes the
 * sidecar paths (post-unlink they are meaningless for future opens; live
 * processes keep their open fds, so deleting the PATH cannot corrupt them;
 * EBUSY is skipped fail-open).
 *
 * Kept in its own file (rather than close-cleanup.test.ts) to respect the
 * FR-006 500-line cap on that already-large suite.
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
import {
	closeAllProjectDbs,
	closeProjectDb,
} from '../../../src/db/project-db.js';
import { loadDatabaseCtor } from '../../../src/db/sqlite-loader.js';
import * as actualEvidenceManager from '../../../src/evidence/manager.js';
import * as actualKnowledgeCurator from '../../../src/hooks/knowledge-curator.js';
import { savePlan } from '../../../src/plan/manager.js';
import * as actualState from '../../../src/state.js';

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

const { handleCloseCommand, removeSqliteSidecarsAfterClose } = await import(
	'../../../src/commands/close.js'
);

let testDir: string;
const swarmDir = (): string => path.join(testDir, '.swarm');

beforeEach(() => {
	testDir = mkdtempSync(path.join(os.tmpdir(), 'close-wal-'));
	mkdirSync(swarmDir(), { recursive: true });
});

afterEach(() => {
	closeAllProjectDbs();
	if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
	mock.restore();
});

/** Create a minimal valid WAL-mode swarm.db so the clean stage reaches its unlink. */
function writeRealSwarmDb(): void {
	closeProjectDb(testDir);
	const Db = loadDatabaseCtor();
	const db = new Db(path.join(swarmDir(), 'swarm.db'));
	db.run('PRAGMA journal_mode = WAL;');
	db.run(
		'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT);',
	);
	db.run(
		'INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (?, ?)',
		[1, 'init'],
	);
	db.close();
}

// The plan is written through savePlan (plan.json + ledger) so terminal plan
// reconciliation succeeds and the close pipeline actually reaches its archive
// and clean stages — a bare plan.json aborts early with
// CLOSE_TERMINAL_PLAN_MISSING and would make every assertion below vacuous.
async function writePlan(): Promise<void> {
	await savePlan(testDir, {
		title: 'WAL Test',
		swarm: 'wal-test',
		schema_version: '1.0.0',
		current_phase: 1,
		phases: [{ id: 1, name: 'P1', status: 'complete', tasks: [] }],
	});
}

describe('WAL sidecars: no misleading warning, removed after the swarm.db unlink (#1692 → #2483)', () => {
	it('finalize with sidecars present emits no "not successfully archived" warning and removes the sidecar paths', () => {
		return run(true);
	});

	it('finalize with no sidecars present emits no "not successfully archived" warning', () => {
		return run(false);
	});

	async function run(withSidecars: boolean): Promise<void> {
		await writePlan();
		// A real active-state file so the archive-first clean loop actually runs,
		// plus a real swarm.db so the loop reaches (and unlinks) it — the
		// sidecar removal is tied to that unlink (#2483).
		writeFileSync(path.join(swarmDir(), 'events.jsonl'), '{"e":1}\n');
		writeRealSwarmDb();
		if (withSidecars) {
			writeFileSync(path.join(swarmDir(), 'swarm.db-shm'), 'shm');
			writeFileSync(path.join(swarmDir(), 'swarm.db-wal'), 'wal');
		}

		const output = await handleCloseCommand(testDir, []);

		// Anti-vacuous anchor: the close pipeline must have completed.
		expect(output).toContain('finalized');
		expect(output).not.toContain('because it was not successfully archived');
		expect(output).not.toContain('Preserved swarm.db-shm');
		expect(output).not.toContain('Preserved swarm.db-wal');
		expect(existsSync(path.join(swarmDir(), 'swarm.db'))).toBe(false);

		// #2483 (reversing #1692): once swarm.db is unlinked the sidecar paths
		// are meaningless for future opens — they are removed, never "preserved".
		if (withSidecars) {
			expect(existsSync(path.join(swarmDir(), 'swarm.db-shm'))).toBe(false);
			expect(existsSync(path.join(swarmDir(), 'swarm.db-wal'))).toBe(false);
		}
	}

	it('exports removeSqliteSidecarsAfterClose and removes both sidecar paths (ENOENT fail-open)', () => {
		expect(typeof removeSqliteSidecarsAfterClose).toBe('function');
		writeFileSync(path.join(swarmDir(), 'swarm.db-shm'), 'shm');
		writeFileSync(path.join(swarmDir(), 'swarm.db-wal'), 'wal');

		removeSqliteSidecarsAfterClose(swarmDir());

		expect(existsSync(path.join(swarmDir(), 'swarm.db-shm'))).toBe(false);
		expect(existsSync(path.join(swarmDir(), 'swarm.db-wal'))).toBe(false);
		// Missing sidecars are silent (per-file ENOENT fail-open).
		removeSqliteSidecarsAfterClose(swarmDir());
	});
});
