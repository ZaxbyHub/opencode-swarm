/**
 * #1692 regression: the clean stage must NOT emit the misleading
 * "Preserved <file> because it was not successfully archived" warning for the
 * SQLite WAL sidecars. Those files are no longer members of ARCHIVE_ARTIFACTS /
 * ACTIVE_STATE_TO_CLEAN, so the clean-stage archive-first loop never considers
 * them and the warning has no path to fire.
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
import * as actualEvidenceManager from '../../../src/evidence/manager.js';
import * as actualKnowledgeCurator from '../../../src/hooks/knowledge-curator.js';
import * as actualState from '../../../src/state.js';

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

let testDir: string;
const swarmDir = (): string => path.join(testDir, '.swarm');

beforeEach(() => {
	testDir = mkdtempSync(path.join(os.tmpdir(), 'close-wal-'));
	mkdirSync(swarmDir(), { recursive: true });
});

afterEach(() => {
	if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
	mock.restore();
});

describe('WAL sidecars produce no misleading "Preserved" warning (#1692)', () => {
	it('finalize with sidecars present emits no "not successfully archived" warning', () => {
		return run(true);
	});

	it('finalize with no sidecars present emits no "not successfully archived" warning', () => {
		return run(false);
	});

	async function run(withSidecars: boolean): Promise<void> {
		writeFileSync(
			path.join(swarmDir(), 'plan.json'),
			JSON.stringify({
				title: 'WAL Test',
				phases: [{ id: 1, name: 'P1', status: 'complete', tasks: [] }],
			}),
		);
		// A real active-state file so the archive-first clean loop actually runs.
		writeFileSync(path.join(swarmDir(), 'events.jsonl'), '{"e":1}\n');
		if (withSidecars) {
			writeFileSync(path.join(swarmDir(), 'swarm.db-shm'), 'shm');
			writeFileSync(path.join(swarmDir(), 'swarm.db-wal'), 'wal');
		}

		const output = await handleCloseCommand(testDir, []);

		expect(output).not.toContain('because it was not successfully archived');
		expect(output).not.toContain('Preserved swarm.db-shm');
		expect(output).not.toContain('Preserved swarm.db-wal');

		// Sidecars, when present, are left in place (never cleaned).
		if (withSidecars) {
			expect(existsSync(path.join(swarmDir(), 'swarm.db-shm'))).toBe(true);
			expect(existsSync(path.join(swarmDir(), 'swarm.db-wal'))).toBe(true);
		}
	}
});
