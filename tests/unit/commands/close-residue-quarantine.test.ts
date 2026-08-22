/**
 * Issue #2035 / PR-feedback PRR-003: the close-time atomic-write residue
 * behavior, split out of close-cleanup.test.ts to honor the FR-006 500-line
 * ratchet (that file was already over cap; adding this suite grew it).
 *
 * Covers: handleCloseCommand's clean stage quarantines stale legacy-prefix
 * residue into a manifest-backed batch while preserving fresh residue and
 * non-residue files, plus the CleanStageResult residue field shape.
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
	utimesSync,
	writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadDatabaseCtor } from '../../../src/db/sqlite-loader.js';
// Static imports (hoisted, resolve to the real modules) so the mocks below can
// spread the real exports and only override what this suite needs.
import * as actualEvidenceManager from '../../../src/evidence/manager.js';
import * as actualKnowledgeCurator from '../../../src/hooks/knowledge-curator.js';
import { initLedger } from '../../../src/plan/ledger.js';
import { derivePlanId } from '../../../src/plan/utils.js';
import * as actualState from '../../../src/state.js';
import { withFrozenClock } from '../../helpers/test-clock';

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
		detectDefaultBaseBranch: () => null,
	},
}));

mock.module('../../../src/plan/checkpoint.js', () => ({
	writeCheckpoint: async () => {},
}));

const { handleCloseCommand, runCleanStage } = await import(
	'../../../src/commands/close.js'
);

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
		title: 'Residue Cleanup Test Project',
		schema_version: '1.0.0',
		swarm: 'lowtier',
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'Phase 1',
				status: 'in_progress',
				tasks: [makeTask('1.1', 'Task A')],
			},
		],
		...overrides,
	};
	writeFileSync(path.join(swarmDir(), 'plan.json'), JSON.stringify(plan));
	await initLedger(testDir, derivePlanId(plan), undefined, plan);
}

const realSpawnSync = childProcess.spawnSync;

describe('handleCloseCommand — atomic-write residue handling (issue #2035)', () => {
	let spawnSyncSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		testDir = mkdtempSync(path.join(os.tmpdir(), 'close-residue-test-'));
		spawnSyncSpy = spyOn(childProcess, 'spawnSync').mockImplementation(((
			...args: unknown[]
		) =>
			(realSpawnSync as unknown as (...a: unknown[]) => unknown)(
				...args,
			)) as never);
		void loadDatabaseCtor;
		mkdirSync(swarmDir(), { recursive: true });
	});

	afterEach(() => {
		mock.restore();
		spawnSyncSpy.mockRestore();
		try {
			rmSync(testDir, { recursive: true, force: true });
		} catch {
			// best-effort cleanup
		}
	});

	it('quarantines stale .tmp.* residue (recoverable move) but leaves non-residue files untouched', async () => {
		const { _internals: swarmResidueInternals } = await import(
			'../../../src/services/swarm-residue.js'
		);
		const realQueryTracked = swarmResidueInternals.queryTracked;
		swarmResidueInternals.queryTracked = () => ({ tracked: new Set() });
		try {
			await writePlan();

			// Stale legacy-prefix residue (old enough to pass the 30m gate).
			const staleResidue = path.join(swarmDir(), '.tmp.xxx');
			writeFileSync(staleResidue, 'stale temp data');
			const twoHoursAgo = withFrozenClock(
				() => new Date(Date.now() - 2 * 60 * 60 * 1000),
				// anchor the frozen instant to the real clock so the relative
				// fixture stays on the stale side of the window
				{ fixedNow: Date.now() },
			);
			utimesSync(staleResidue, twoHoursAgo, twoHoursAgo);

			// Fresh residue (recent — must be PRESERVED in place).
			writeFileSync(path.join(swarmDir(), '.tmp.recent'), 'fresh temp');

			// A non-residue file that must never be touched.
			writeFileSync(
				path.join(swarmDir(), 'normal-artifact.json'),
				'{"keep":true}',
			);

			await handleCloseCommand(testDir, []);

			// Stale .tmp.* file is gone from its original location — moved
			// (NOT deleted) into a manifest-backed quarantine batch.
			expect(existsSync(staleResidue)).toBe(false);
			const quarantineRoot = path.join(swarmDir(), 'quarantine');
			const batches = existsSync(quarantineRoot)
				? readdirSync(quarantineRoot)
				: [];
			expect(batches.length).toBe(1);
			const batchDir = path.join(quarantineRoot, batches[0]!);
			expect(existsSync(path.join(batchDir, '.tmp.xxx'))).toBe(true);
			expect(readFileSync(path.join(batchDir, '.tmp.xxx'), 'utf-8')).toBe(
				'stale temp data',
			);
			const manifest = JSON.parse(
				readFileSync(path.join(batchDir, 'manifest.json'), 'utf-8'),
			) as {
				schema_version: number;
				entries: Array<{ original_rel_path: string; sha256: string }>;
			};
			expect(manifest.schema_version).toBe(1);
			expect(
				manifest.entries.some((e) => e.original_rel_path === '.tmp.xxx'),
			).toBe(true);

			// Fresh residue is PRESERVED in place (recent — may be an active
			// writer's temp).
			expect(existsSync(path.join(swarmDir(), '.tmp.recent'))).toBe(true);

			// Non-residue file survives untouched.
			expect(existsSync(path.join(swarmDir(), 'normal-artifact.json'))).toBe(
				true,
			);
			expect(
				readFileSync(path.join(swarmDir(), 'normal-artifact.json'), 'utf-8'),
			).toBe('{"keep":true}');
		} finally {
			swarmResidueInternals.queryTracked = realQueryTracked;
		}
	});

	it('CleanStageResult carries the residue fields with numeric shape', async () => {
		const { _internals: swarmResidueInternals } = await import(
			'../../../src/services/swarm-residue.js'
		);
		const realQueryTracked = swarmResidueInternals.queryTracked;
		swarmResidueInternals.queryTracked = () => ({ tracked: new Set() });
		try {
			await writePlan();
			const result = await handleCloseCommand(testDir, []);
			expect(typeof result).toBe('string');
			// Shape contract for the renamed clean-stage result fields
			// (covers residuePreserved alongside residueQuarantined; the
			// collapsed single assertion in close-stage-extract covers only
			// the latter).
			const cleanShape = await runCleanShape();
			expect(cleanShape.residueQuarantined).toBe(0);
			expect(cleanShape.residuePreserved).toBe(0);
		} finally {
			swarmResidueInternals.queryTracked = realQueryTracked;
		}
	});
});

async function runCleanShape(): Promise<{
	residueQuarantined: number;
	residuePreserved: number;
}> {
	// runCleanStage on an already-closed (empty) tree: returns the shape with
	// zero residue counts without touching anything meaningful.
	const ctx = {
		directory: testDir,
		swarmDir: swarmDir(),
		warnings: [] as string[],
		archivedActiveStateFiles: new Set<string>(),
		archivedActiveStateDirs: new Set<string>(),
		archiveFailureReasons: new Map(),
		projectName: 'shape',
		isForced: false,
		planAlreadyDone: true,
	} as unknown as Parameters<typeof runCleanStage>[0];
	return runCleanStage(ctx);
}
