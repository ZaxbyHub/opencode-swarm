/**
 * Focused coverage for archiving and removing all active-state directories.
 * This suite keeps its own mocks so it can run independently of close-cleanup.test.ts.
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
	rmSync,
	writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as actualEvidenceManager from '../../../src/evidence/manager.js';
import * as actualKnowledgeCurator from '../../../src/hooks/knowledge-curator.js';
import { initLedger } from '../../../src/plan/ledger.js';
import { derivePlanId } from '../../../src/plan/utils.js';
import * as actualState from '../../../src/state.js';
import { runConfirmedClose } from './close-confirmation-test-helpers.js';

const mockExecuteWriteRetro = mock(async () =>
	JSON.stringify({ success: true, phase: 1, task_id: 'retro-1', message: 'Done' }),
);
const mockCurateAndStoreSwarm = mock(async () => {});
const mockArchiveEvidence = mock(async () => {});
const mockFlushPendingSnapshot = mock(async () => {});
const mockCheckHivePromotions = mock(async () => ({
	timestamp: new Date().toISOString(),
	new_promotions: 0,
	encounters_incremented: 0,
	advancements: 0,
	total_hive_entries: 0,
}));
const mockRunCuratorPostMortem = mock(async () => ({
	success: true,
	planId: null,
	reportPath: null,
	summary: null,
	warnings: [],
}));

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
	SNAPSHOT_PROJECTION_FILE: 'session/state.sqlite-projection.json',
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
mock.module('../../../src/plan/checkpoint.js', () => ({ writeCheckpoint: async () => {} }));

const {
	handleCloseCommand: rawHandleCloseCommand,
	_internals: closeInternals,
} = await import('../../../src/commands/close.js');
const handleCloseCommand = (
	directory: string,
	args: string[],
	options?: Parameters<typeof rawHandleCloseCommand>[2],
) => runConfirmedClose(rawHandleCloseCommand, directory, args, options);
const realCloseInternals = {
	curateAndStoreSwarm: closeInternals.curateAndStoreSwarm,
	checkHivePromotions: closeInternals.checkHivePromotions,
	runCuratorPostMortem: closeInternals.runCuratorPostMortem,
};

let testDir: string;
const swarmDir = () => path.join(testDir, '.swarm');
const makeTask = (id: string) => ({
	id,
	phase: 1,
	status: 'in_progress',
	size: 'small',
	description: `Task ${id}`,
	depends: [],
	files_touched: [],
});
async function writePlan(): Promise<void> {
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
				tasks: [makeTask('1.1'), makeTask('1.2')],
			},
		],
	};
	writeFileSync(path.join(swarmDir(), 'plan.json'), JSON.stringify(plan));
	await initLedger(testDir, derivePlanId(plan), undefined, plan);
}
function getLatestArchivePath(): string {
	const archiveBase = path.join(swarmDir(), 'archive');
	const entries = readdirSync(archiveBase).filter((entry) => entry.startsWith('swarm-'));
	expect(entries.length).toBeGreaterThanOrEqual(1);
	entries.sort();
	return path.join(archiveBase, entries[entries.length - 1]);
}

const realSpawnSync = childProcess.spawnSync;
let spawnSyncSpy: ReturnType<typeof spyOn>;

describe('active-state directory cleanup', () => {
	beforeEach(() => {
		mockExecuteWriteRetro.mockClear();
		mockCurateAndStoreSwarm.mockClear();
		mockCheckHivePromotions.mockClear();
		mockRunCuratorPostMortem.mockClear();
		mockArchiveEvidence.mockClear();
		mockFlushPendingSnapshot.mockClear();
		closeInternals.curateAndStoreSwarm = mockCurateAndStoreSwarm;
		closeInternals.checkHivePromotions = mockCheckHivePromotions;
		closeInternals.runCuratorPostMortem = mockRunCuratorPostMortem;
		testDir = mkdtempSync(path.join(os.tmpdir(), 'close-cleanup-active-state-'));
		mkdirSync(path.join(swarmDir(), 'session'), { recursive: true });
		spawnSyncSpy = spyOn(childProcess, 'spawnSync').mockImplementation((...args) => {
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
		});
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
		spawnSyncSpy.mockRestore();
		closeInternals.curateAndStoreSwarm = realCloseInternals.curateAndStoreSwarm;
		closeInternals.checkHivePromotions = realCloseInternals.checkHivePromotions;
		closeInternals.runCuratorPostMortem = realCloseInternals.runCuratorPostMortem;
		mock.restore();
	});

	it('archives and removes all four active-state directories', async () => {
		await writePlan();
		mkdirSync(path.join(swarmDir(), 'evidence', 'retro-x'), { recursive: true });
		writeFileSync(path.join(swarmDir(), 'evidence', 'marker.txt'), 'evidence-marker');
		mkdirSync(path.join(swarmDir(), 'session', 'sess-y'), { recursive: true });
		writeFileSync(path.join(swarmDir(), 'session', 'marker.txt'), 'session-marker');
		mkdirSync(path.join(swarmDir(), 'scopes'));
		writeFileSync(path.join(swarmDir(), 'scopes', 'marker.txt'), 'scopes-marker');
		mkdirSync(path.join(swarmDir(), 'spec-archive'));
		writeFileSync(path.join(swarmDir(), 'spec-archive', 'marker.txt'), 'spec-archive-marker');

		await handleCloseCommand(testDir, []);
		const archivePath = getLatestArchivePath();
		for (const directory of ['evidence', 'session', 'scopes', 'spec-archive']) {
			expect(existsSync(path.join(archivePath, directory, 'marker.txt'))).toBe(true);
			expect(existsSync(path.join(swarmDir(), directory))).toBe(false);
		}
	});
});
