/**
 * repo-memory.sqlite clean-stage resilience (issue #1534 wiring).
 *
 * close.ts documents `closeRepoMemory` as best-effort ("never throws into
 * the clean stage") but the call is wrapped in a bare try/catch with no
 * regression coverage. This file mocks indexed-storage's `closeRepoMemory`
 * to throw and proves `/swarm close` still completes and still removes the
 * active-state file via the subsequent `fs.unlink` — i.e. the throw is
 * genuinely swallowed, not merely undetected because the mock was never
 * exercised.
 *
 * Isolated in its own file (rather than close-repo-memory-cleanup.test.ts)
 * because close.ts's clean-stage call to `closeRepoMemory` goes through the
 * file-scoped `_internals` DI seam (see `close.ts:_internals`), which this
 * test replaces directly rather than mocking the indexed-storage module —
 * incompatible with the other file's non-throwing real usage of the same
 * module.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import * as actualEvidenceManager from '../../../src/evidence/manager.js';
import * as actualKnowledgeCurator from '../../../src/hooks/knowledge-curator.js';
import { savePlan } from '../../../src/plan/manager.js';
import * as actualState from '../../../src/state.js';
import * as actualIndexedStorage from '../../../src/tools/repo-graph/indexed-storage.js';
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

const { handleCloseCommand, _internals: closeInternals } = await import(
	'../../../src/commands/close.js'
);
const { REPO_MEMORY_FILENAME } = actualIndexedStorage;

// Throw-on-call spy installed via close.ts's `_internals` DI seam (see
// `close.ts:_internals`) rather than `mock.module`-ing indexed-storage,
// which would leak the throwing replacement across other test files sharing
// Bun's test-runner process (this repo's mock.module convention).
const closeRepoMemorySpy = mock(() => {
	throw new Error('simulated closeRepoMemory failure');
});
const originalCloseRepoMemory = closeInternals.closeRepoMemory;

let testDir: string;
const swarmDir = (): string => path.join(testDir, '.swarm');

beforeEach(() => {
	testDir = canonicalMkdtemp('close-repo-memory-throws-');
	mkdirSync(swarmDir(), { recursive: true });
	closeRepoMemorySpy.mockClear();
	closeInternals.closeRepoMemory = closeRepoMemorySpy;
});

afterEach(() => {
	closeInternals.closeRepoMemory = originalCloseRepoMemory;
	// closeRepoMemory is mocked to throw in this file, so the real cached
	// WAL connection from syncIndexFromGraph is deliberately left open by
	// close.ts's best-effort catch. Close it directly (bypassing the mock)
	// so temp-dir teardown does not itself hit EBUSY on Windows.
	actualIndexedStorage.closeAllRepoMemory();
	if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
});

async function writePlan(): Promise<void> {
	await savePlan(testDir, {
		title: 'Repo Memory Close Throws',
		swarm: 'repo-memory-close-throws',
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

describe('repo-memory.sqlite clean stage survives closeRepoMemory throwing', () => {
	it('does not throw out of handleCloseCommand, still unlinks the file, and the throwing mock was actually exercised', async () => {
		await writePlan();
		const { promises: fsp } = await import('node:fs');
		// Frozen clock so the fixture's timestamp fields and the assertions
		// below are deterministic (see docs/testing/test-stability.md, issue
		// #1782) — this test writes `new Date().toISOString()` /
		// `Date.now()` reads and checks downstream archive artifacts.
		await withFrozenClockAsync(
			async () => {
				// Use the real production write path so the store has the schema
				// archiveSqliteSnapshot's validation expects (schema_migrations etc.)
				// and archiving actually succeeds — the closeRepoMemory call only
				// fires for artifacts that were successfully archived.
				await actualIndexedStorage.syncIndexFromGraph(
					testDir,
					{
						schema_version: '1.2.0',
						workspaceRoot: testDir,
						nodes: {},
						edges: [],
						metadata: {
							generatedAt: new Date().toISOString(),
							generator: 'test',
							nodeCount: 0,
							edgeCount: 0,
						},
					},
					{ size: 1, mtimeMs: Date.now(), ino: '0' },
				);

				let output: string | undefined;
				let thrown: unknown;
				try {
					output = await handleCloseCommand(testDir, []);
				} catch (err) {
					thrown = err;
				}

				// Positive control: the throwing mock must have actually fired for
				// this test to mean anything. If the mock was never called (e.g. a
				// future refactor drops the closeRepoMemory call entirely), this
				// assertion catches it — a green run on the assertions below alone
				// would otherwise be silently vacuous.
				expect(closeRepoMemorySpy).toHaveBeenCalled();

				// close must not propagate the throw (best-effort contract).
				expect(thrown).toBeUndefined();
				expect(typeof output).toBe('string');

				// The archive stage (which runs before closeRepoMemory and does not
				// depend on it) still succeeds and produces a real snapshot — the
				// throw does not corrupt or skip archiving.
				const archivePath = getLatestArchivePath();
				expect(existsSync(path.join(archivePath, REPO_MEMORY_FILENAME))).toBe(
					true,
				);

				// The clean stage's own attempt to unlink surfaces truthfully as a
				// warning rather than crashing: because the connection genuinely
				// could not be closed (closeRepoMemory threw instead of releasing
				// its lock), the OS-level unlink legitimately fails with EBUSY on
				// Windows, which locks open file handles. That is the expected,
				// non-crashing degraded outcome — not a silent success — so the
				// warning is pinned explicitly there. POSIX unlink(2) does not
				// honor an open-handle lock, so on Linux/macOS the same stage
				// silently succeeds: no warning, and the store file is really
				// gone once the fixture's connection closes.
				if (process.platform === 'win32') {
					expect(output).toContain(
						`Failed to clean active-state file ${REPO_MEMORY_FILENAME}`,
					);
				} else {
					expect(output).not.toContain(
						`Failed to clean active-state file ${REPO_MEMORY_FILENAME}`,
					);
					expect(existsSync(path.join(swarmDir(), REPO_MEMORY_FILENAME))).toBe(
						false,
					);
				}
				await fsp.access(archivePath).catch(() => {
					throw new Error('archive dir missing');
				});
			},
			{ isoNow: FIXED_NOW_ISO },
		);
	});
});
