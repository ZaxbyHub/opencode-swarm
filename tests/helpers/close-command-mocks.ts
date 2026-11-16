/**
 * Shared mock preamble for driving the full `/swarm close` pipeline in unit
 * tests without network/git/curator side effects (the exact mock set used by
 * tests/unit/commands/close-wal-preserve.test.ts and
 * close-sqlite-cleanup.test.ts). Call `installCloseCommandMocks()` at the top
 * level of the test file BEFORE dynamically importing
 * `src/commands/close.js`, so the close pipeline sees the mocks.
 *
 * mock.module keys on the resolved module identity, so the relative
 * specifiers below (from tests/helpers/) patch the same modules a test file
 * under tests/unit/ refers to with deeper relative paths.
 */

import { mock } from 'bun:test';
import * as actualGitStatusRead from '../../src/commands/git-status-read.js';
import * as actualEvidenceManager from '../../src/evidence/manager.js';
import * as actualKnowledgeCurator from '../../src/hooks/knowledge-curator.js';
import * as actualState from '../../src/state.js';

const realSnapshotWriter = await import('../../src/session/snapshot-writer.js');

/**
 * #3427: the close align stage reads repository status through the async
 * detailed reader (wired into the close internals seam), so a branch-module
 * mock alone no longer covers the probe. This installs a `git-status-read`
 * module mock that SPREADS the real module (orchestrator's `readGitStatusAsync`
 * and dry-run's `readGitRepositoryStatusAsync` keep their real implementations)
 * and overrides ONLY `readGitRepositoryStatusDetailedAsync` to a non-repo
 * result — the async twin of the `getGitRepositoryStatus: () => ({ isRepo: false })`
 * convention the branch mocks below already carry.
 */
export function mockGitStatusReadNonRepo(): void {
	mock.module('../../src/commands/git-status-read.js', () => ({
		...actualGitStatusRead,
		// Contract-shaped (GitRepositoryStatus requires reason/message on the
		// false arm) so the align stage's reason dispatch stays exercisable.
		readGitRepositoryStatusDetailedAsync: async () => ({
			isRepo: false,
			reason: 'not_git_repo',
			message: 'rev-parse failed (close-command mock)',
		}),
	}));
}

export function installCloseCommandMocks(): void {
	// #3427: cover the align stage's async repository probe (see above).
	mockGitStatusReadNonRepo();
	mock.module('../../src/tools/write-retro.js', () => ({
		executeWriteRetro: mock(async () =>
			JSON.stringify({ success: true, phase: 1, task_id: 'r', message: 'ok' }),
		),
	}));
	mock.module('../../src/hooks/knowledge-curator.js', () => ({
		...actualKnowledgeCurator,
		curateAndStoreSwarm: mock(async () => {}),
	}));
	mock.module('../../src/evidence/manager.js', () => ({
		...actualEvidenceManager,
		archiveEvidence: mock(async () => {}),
	}));
	mock.module('../../src/session/snapshot-writer.js', () => ({
		...realSnapshotWriter,
		flushPendingSnapshot: mock(async () => {}),
	}));
	mock.module('../../src/state.js', () => ({
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
	mock.module('../../src/git/branch.js', () => ({
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
	mock.module('../../src/plan/checkpoint.js', () => ({
		writeCheckpoint: async () => {},
	}));
}
