/**
 * Tests that close-summary.md is refreshed into the archive bundle instead of
 * preserving stale previous-session content.
 */
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	spyOn,
} from 'bun:test';
import * as childProcess from 'node:child_process';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadDatabaseCtor } from '../../../src/db/sqlite-loader.js';
import * as actualEvidenceManager from '../../../src/evidence/manager.js';
import * as actualKnowledgeCurator from '../../../src/hooks/knowledge-curator.js';
import { initLedger } from '../../../src/plan/ledger.js';
import { derivePlanId } from '../../../src/plan/utils.js';
import * as actualState from '../../../src/state.js';

// ── Mocks (must precede the dynamic import) ──────────────────────────

const mockExecuteWriteRetro = mock(async (_args: unknown, _directory: string) =>
	JSON.stringify({
		success: true,
		phase: 1,
		task_id: 'retro-1',
		message: 'Done',
	}),
);

const mockCurateAndStoreSwarm = mock(async () => {});
const mockArchiveEvidence = mock(async () => {});
const mockFlushPendingSnapshot = mock(async () => {});

mock.module('../../../src/tools/write-retro.js', () => ({
	executeWriteRetro: mockExecuteWriteRetro,
}));

mock.module('../../../src/hooks/knowledge-curator.js', () => ({
	...actualKnowledgeCurator,
	curateAndStoreSwarm: mockCurateAndStoreSwarm,
}));

mock.module('../../../src/evidence/manager.js', () => ({
	...actualEvidenceManager,
	archiveEvidence: mockArchiveEvidence,
}));

mock.module('../../../src/session/snapshot-writer.js', () => ({
	flushPendingSnapshot: mockFlushPendingSnapshot,
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
	// No sessions are ever populated in the mock swarmState above, so no
	// session can have fullAutoMode enabled — false is the only consistent
	// answer for this mock's shape.
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
		localBranch: 'main',
		message: 'Already aligned with remote',
		alreadyAligned: true,
		prunedBranches: [],
		warnings: [],
	}),
	resetToMainAfterMerge: () => ({
		success: true,
		targetBranch: 'origin/main',
		previousBranch: 'main',
		message: 'Already on main',
		branchDeleted: false,
		warnings: [],
	}),
	_internals: {
		gitExec: () => '',
		detectDefaultRemoteBranch: () => null,
		getDefaultBaseBranch: () => 'origin/main',
		getGitRepositoryStatus: () => ({ isRepo: false }),
		resetToRemoteBranch: () => ({
			success: true,
			targetBranch: 'main',
			localBranch: 'main',
			message: 'Already aligned with remote',
			alreadyAligned: true,
			prunedBranches: [],
			warnings: [],
		}),
		resetToMainAfterMerge: () => ({
			success: true,
			targetBranch: 'origin/main',
			previousBranch: 'main',
			message: 'Already on main',
			branchDeleted: false,
			warnings: [],
		}),
	},
}));

mock.module('../../../src/plan/checkpoint.js', () => ({
	writeCheckpoint: async () => {},
}));

// ── Import under test ────────────────────────────────────────────────
const { handleCloseCommand } = await import('../../../src/commands/close.js');

// ── Helpers ──────────────────────────────────────────────────────────

let testDir: string;

function swarmDir(): string {
	return path.join(testDir, '.swarm');
}

const makeTask = (id: string, description: string) => ({
	id,
	phase: 1,
	status: 'in_progress',
	size: 'small',
	description,
	depends: [],
	files_touched: [],
});

async function writePlan(
	overrides: Record<string, unknown> = {},
): Promise<void> {
	const plan = {
		title: 'Cleanup Test Project',
		schema_version: '1.0.0',
		swarm: 'lowtier',
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'Phase 1',
				status: 'in_progress',
				tasks: [makeTask('1.1', 'Task A'), makeTask('1.2', 'Task B')],
			},
		],
		...overrides,
	};
	writeFileSync(path.join(swarmDir(), 'plan.json'), JSON.stringify(plan));
	await initLedger(testDir, derivePlanId(plan), undefined, plan);
}

function getLatestArchivePath(): string {
	const archiveBase = path.join(swarmDir(), 'archive');
	const entries = readdirSync(archiveBase).filter((e) =>
		e.startsWith('swarm-'),
	);
	expect(entries.length).toBeGreaterThanOrEqual(1);
	entries.sort();
	return path.join(archiveBase, entries[entries.length - 1]);
}

// Issue #2030 removed close.ts's external `sqlite3` CLI spawn entirely (the
// snapshot engine is now in-process VACUUM INTO via src/db/sqlite-loader.ts).
// The spy below is retained as a harmless vestige: it still intercepts any
// sqlite3 spawn (there are none on this path now) and passes everything else
// through to the real implementation.
const realSpawnSync = childProcess.spawnSync;
let spawnSyncSpy: ReturnType<typeof spyOn>;

describe('handleCloseCommand — close-summary refresh', () => {
	beforeEach(() => {
		mockExecuteWriteRetro.mockClear();
		mockCurateAndStoreSwarm.mockClear();
		mockArchiveEvidence.mockClear();
		mockFlushPendingSnapshot.mockClear();
		testDir = mkdtempSync(path.join(os.tmpdir(), 'close-summary-test-'));
		mkdirSync(path.join(swarmDir(), 'session'), { recursive: true });

		spawnSyncSpy = spyOn(childProcess, 'spawnSync').mockImplementation(
			(...args: Parameters<typeof childProcess.spawnSync>) => {
				const [command] = args;
				if (command === 'sqlite3') {
					return {
						status: 0,
						stdout: '0|0|0\n',
						stderr: '',
						error: undefined,
						pid: 0,
						output: [],
						signal: null,
					} as ReturnType<typeof childProcess.spawnSync>;
				}
				return realSpawnSync(...args);
			},
		);
	});

	afterEach(() => {
		try {
			rmSync(testDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
		spawnSyncSpy.mockRestore();
		mock.restore();
	});

	it('refreshes close-summary.md before archiving so stale content does not survive', async () => {
		writeFileSync(
			path.join(swarmDir(), 'close-summary.md'),
			'# stale previous-session summary',
		);
		await writePlan();

		await handleCloseCommand(testDir, []);

		const summaryPath = path.join(swarmDir(), 'close-summary.md');
		expect(existsSync(summaryPath)).toBe(true);
		const summary = readFileSync(summaryPath, 'utf-8');
		expect(summary).toContain('Archived');
		expect(summary).toContain('.swarm/archive/swarm-');
		expect(summary).toContain('Normal finalization');

		const archivePath = getLatestArchivePath();
		const archivedSummary = readFileSync(
			path.join(archivePath, 'close-summary.md'),
			'utf-8',
		);
		expect(archivedSummary).toBe(summary);
		expect(archivedSummary).not.toContain('stale previous-session');
	});
});
