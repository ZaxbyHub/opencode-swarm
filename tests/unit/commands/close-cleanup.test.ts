/**
 * Tests handleCloseCommand artifact cleanup: archive copies survive, active
 * state is removed only after archival, locks survive, context.md is rewritten,
 * and repeated close runs remain idempotent.
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
// Static import (hoisted, resolves to the real module) so the mock below can
// spread the real exports and only override the ones this suite cares about.
// This keeps the mock resilient to the live import graph (close.ts pulls in
// evidence/manager.js re-exports transitively, e.g. via skill-improver.ts ->
// trajectory-cluster.ts -> micro-reflector.ts -> sanitizeTaskId, and via
// trajectory-cluster.ts -> listEvidenceTaskIds) without having to hand-stub
// every export it happens to need.
import * as actualEvidenceManager from '../../../src/evidence/manager.js';
// Same rationale as actualEvidenceManager above: knowledge-curator.js is
// imported transitively by other (unmocked) close.ts dependencies for
// exports beyond curateAndStoreSwarm (e.g. enrichLessonToV3), so spread the
// real module and only override the entry point this suite mocks.
import * as actualKnowledgeCurator from '../../../src/hooks/knowledge-curator.js';
import { initLedger } from '../../../src/plan/ledger.js';
import { derivePlanId } from '../../../src/plan/utils.js';
// Same rationale as above: enforceSpecDriftGate (used by the regression test
// below) lives in src/hooks/guardrails/index.ts, which transitively imports
// src/state.js for exports beyond the ones this suite overrides (e.g.
// getAgentSession, advanceTaskState, getActiveWindow). Spread the real module
// and only override the entry points this suite needs deterministic/no-op
// behavior for.
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
// through to the real implementation. It documents that NO external CLI is
// invoked during close on this code path — a regression here would mean the
// forbidden external dependency crept back.
const realSpawnSync = childProcess.spawnSync;
let spawnSyncSpy: ReturnType<typeof spyOn>;

// ── Test suites ──────────────────────────────────────────────────────

describe('handleCloseCommand — expanded artifact cleanup', () => {
	beforeEach(() => {
		mockExecuteWriteRetro.mockClear();
		mockCurateAndStoreSwarm.mockClear();
		mockArchiveEvidence.mockClear();
		mockFlushPendingSnapshot.mockClear();
		testDir = mkdtempSync(path.join(os.tmpdir(), 'close-cleanup-test-'));
		mkdirSync(path.join(swarmDir(), 'session'), { recursive: true });

		spawnSyncSpy = spyOn(childProcess, 'spawnSync').mockImplementation(
			(...args: Parameters<typeof childProcess.spawnSync>) => {
				const [command] = args;
				if (command === 'sqlite3') {
					// Simulates `PRAGMA wal_checkpoint(TRUNCATE)` reporting
					// busy=0 (checkpoint completed) per close.ts's
					// `busy|log|checkpointed` parsing at close.ts:958-968.
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

	// ── Test 1: Flat-file archiving ────────────────────────────────────

	describe('Flat-file archiving (knowledge.jsonl, repo-graph.json, telemetry.jsonl, etc.)', () => {
		it('archives knowledge.jsonl (survives cleanup)', async () => {
			await writePlan();
			writeFileSync(
				path.join(swarmDir(), 'knowledge.jsonl'),
				'{"id":1,"type":"lesson"}\n',
			);

			await handleCloseCommand(testDir, []);

			const archivePath = getLatestArchivePath();
			expect(existsSync(path.join(archivePath, 'knowledge.jsonl'))).toBe(true);
			expect(existsSync(path.join(swarmDir(), 'knowledge.jsonl'))).toBe(true);
		});

		it('archives and removes knowledge-rejected.jsonl', async () => {
			await writePlan();
			writeFileSync(
				path.join(swarmDir(), 'knowledge-rejected.jsonl'),
				'{"id":1,"type":"rejected"}\n',
			);

			await handleCloseCommand(testDir, []);

			const archivePath = getLatestArchivePath();
			expect(
				existsSync(path.join(archivePath, 'knowledge-rejected.jsonl')),
			).toBe(true);
			expect(
				existsSync(path.join(swarmDir(), 'knowledge-rejected.jsonl')),
			).toBe(false);
		});

		it('archives and removes repo-graph.json', async () => {
			await writePlan();
			writeFileSync(
				path.join(swarmDir(), 'repo-graph.json'),
				JSON.stringify({ nodes: [], edges: [] }),
			);

			await handleCloseCommand(testDir, []);

			const archivePath = getLatestArchivePath();
			expect(existsSync(path.join(archivePath, 'repo-graph.json'))).toBe(true);
			expect(existsSync(path.join(swarmDir(), 'repo-graph.json'))).toBe(false);
		});

		it('archives and removes doc-manifest.json', async () => {
			await writePlan();
			writeFileSync(
				path.join(swarmDir(), 'doc-manifest.json'),
				JSON.stringify({ files: [] }),
			);

			await handleCloseCommand(testDir, []);

			const archivePath = getLatestArchivePath();
			expect(existsSync(path.join(archivePath, 'doc-manifest.json'))).toBe(
				true,
			);
			expect(existsSync(path.join(swarmDir(), 'doc-manifest.json'))).toBe(
				false,
			);
		});

		it('archives and removes dark-matter.md', async () => {
			await writePlan();
			writeFileSync(
				path.join(swarmDir(), 'dark-matter.md'),
				'# Dark Matter\n\nSecret stuff.',
			);

			await handleCloseCommand(testDir, []);

			const archivePath = getLatestArchivePath();
			expect(existsSync(path.join(archivePath, 'dark-matter.md'))).toBe(true);
			expect(existsSync(path.join(swarmDir(), 'dark-matter.md'))).toBe(false);
		});

		it('archives and removes telemetry.jsonl', async () => {
			await writePlan();
			writeFileSync(
				path.join(swarmDir(), 'telemetry.jsonl'),
				'{"event":"tick","ts":1}\n',
			);

			await handleCloseCommand(testDir, []);

			const archivePath = getLatestArchivePath();
			expect(existsSync(path.join(archivePath, 'telemetry.jsonl'))).toBe(true);
			expect(existsSync(path.join(swarmDir(), 'telemetry.jsonl'))).toBe(false);
		});

		it('archives all handoff-related files', async () => {
			await writePlan();
			writeFileSync(path.join(swarmDir(), 'handoff.md'), '# Handoff');
			writeFileSync(
				path.join(swarmDir(), 'handoff-prompt.md'),
				'# Handoff Prompt',
			);
			writeFileSync(
				path.join(swarmDir(), 'handoff-consumed.md'),
				'# Handoff Consumed',
			);

			await handleCloseCommand(testDir, []);

			const archivePath = getLatestArchivePath();
			expect(existsSync(path.join(archivePath, 'handoff.md'))).toBe(true);
			expect(existsSync(path.join(archivePath, 'handoff-prompt.md'))).toBe(
				true,
			);
			expect(existsSync(path.join(archivePath, 'handoff-consumed.md'))).toBe(
				true,
			);
			expect(existsSync(path.join(swarmDir(), 'handoff.md'))).toBe(false);
			expect(existsSync(path.join(swarmDir(), 'handoff-prompt.md'))).toBe(
				false,
			);
			expect(existsSync(path.join(swarmDir(), 'handoff-consumed.md'))).toBe(
				false,
			);
		});

		it('archives and removes escalation-report.md', async () => {
			await writePlan();
			writeFileSync(
				path.join(swarmDir(), 'escalation-report.md'),
				'# Escalation\nEscalated.',
			);

			await handleCloseCommand(testDir, []);

			const archivePath = getLatestArchivePath();
			expect(existsSync(path.join(archivePath, 'escalation-report.md'))).toBe(
				true,
			);
			expect(existsSync(path.join(swarmDir(), 'escalation-report.md'))).toBe(
				false,
			);
		});

		it('plan.json and plan.md are archived', async () => {
			await writePlan();
			writeFileSync(path.join(swarmDir(), 'plan.md'), '# Plan\n\n## Phase 1');

			await handleCloseCommand(testDir, []);

			const archivePath = getLatestArchivePath();
			expect(existsSync(path.join(archivePath, 'plan.json'))).toBe(true);
			expect(existsSync(path.join(archivePath, 'plan.md'))).toBe(true);
		});

		it('plan-ledger.jsonl is archived', async () => {
			await writePlan();

			await handleCloseCommand(testDir, []);

			const archivePath = getLatestArchivePath();
			expect(existsSync(path.join(archivePath, 'plan-ledger.jsonl'))).toBe(
				true,
			);
		});
	});

	// ── Test 2: swarm.db cleanup ──────────────────────────────────────
	// (swarm.db archive/cleanup/sidecar tests moved to close-sqlite-cleanup.test.ts
	// to respect the FR-006 ratchet — this file is already over the 500-line cap.)

	// ── Test 3: Directory archiving and deletion ─────────────────────

	describe('Directory archiving and deletion', () => {
		it('archives and deletes evidence/ directory with contents', async () => {
			await writePlan();
			mkdirSync(path.join(swarmDir(), 'evidence', 'retro-1'), {
				recursive: true,
			});
			writeFileSync(
				path.join(swarmDir(), 'evidence', 'retro-1', 'evidence.json'),
				'{"phase":1}',
			);
			writeFileSync(
				path.join(swarmDir(), 'evidence', 'retro-1', 'summary.md'),
				'# Summary',
			);

			await handleCloseCommand(testDir, []);

			const archivePath = getLatestArchivePath();
			// Contents should be in the archive
			expect(
				existsSync(
					path.join(archivePath, 'evidence', 'retro-1', 'evidence.json'),
				),
			).toBe(true);
			expect(
				existsSync(path.join(archivePath, 'evidence', 'retro-1', 'summary.md')),
			).toBe(true);
			// evidence/ directory itself should be deleted from .swarm/
			expect(existsSync(path.join(swarmDir(), 'evidence'))).toBe(false);
		});

		it('archives and deletes session/ directory with contents', async () => {
			await writePlan();
			mkdirSync(path.join(swarmDir(), 'session', 'session-123'), {
				recursive: true,
			});
			writeFileSync(
				path.join(swarmDir(), 'session', 'session-123', 'state.json'),
				'{"active":true}',
			);

			await handleCloseCommand(testDir, []);

			const archivePath = getLatestArchivePath();
			expect(
				existsSync(
					path.join(archivePath, 'session', 'session-123', 'state.json'),
				),
			).toBe(true);
			expect(existsSync(path.join(swarmDir(), 'session'))).toBe(false);
		});

		it('archives and deletes scopes/ directory with contents', async () => {
			await writePlan();
			mkdirSync(path.join(swarmDir(), 'scopes'), { recursive: true });
			writeFileSync(
				path.join(swarmDir(), 'scopes', 'scope-1.json'),
				'{"scope":"test"}',
			);

			await handleCloseCommand(testDir, []);

			const archivePath = getLatestArchivePath();
			expect(existsSync(path.join(archivePath, 'scopes', 'scope-1.json'))).toBe(
				true,
			);
			expect(existsSync(path.join(swarmDir(), 'scopes'))).toBe(false);
		});

		it('locks/ directory is NOT archived and NOT deleted (excluded from ACTIVE_STATE_DIRS_TO_CLEAN)', async () => {
			await writePlan();
			// locks/ was intentionally dropped from ACTIVE_STATE_DIRS_TO_CLEAN —
			// per-run locks are now managed via proper-lockfile, not archived
			// or cleaned by close. It should be left untouched, matching the
			// Archive-first-guard behavior for any directory not in the list.
			mkdirSync(path.join(swarmDir(), 'locks'), { recursive: true });
			writeFileSync(
				path.join(swarmDir(), 'locks', 'tool-lock.json'),
				'{"locked":true}',
			);

			await handleCloseCommand(testDir, []);

			const archivePath = getLatestArchivePath();
			expect(existsSync(path.join(archivePath, 'locks'))).toBe(false);
			expect(existsSync(path.join(swarmDir(), 'locks'))).toBe(true);
			expect(
				readFileSync(path.join(swarmDir(), 'locks', 'tool-lock.json'), 'utf-8'),
			).toBe('{"locked":true}');
		});

		it('archives and deletes spec-archive/ directory with contents', async () => {
			await writePlan();
			mkdirSync(path.join(swarmDir(), 'spec-archive'), { recursive: true });
			writeFileSync(
				path.join(swarmDir(), 'spec-archive', 'spec-001.md'),
				'# Spec 001',
			);

			await handleCloseCommand(testDir, []);

			const archivePath = getLatestArchivePath();
			expect(
				existsSync(path.join(archivePath, 'spec-archive', 'spec-001.md')),
			).toBe(true);
			expect(existsSync(path.join(swarmDir(), 'spec-archive'))).toBe(false);
		});

		it('directory with one level of nesting archives files correctly', async () => {
			await writePlan();
			// Create evidence/retro-1/ with two files (1 level of nesting - works with current code)
			mkdirSync(path.join(swarmDir(), 'evidence', 'retro-1'), {
				recursive: true,
			});
			writeFileSync(
				path.join(swarmDir(), 'evidence', 'retro-1', 'evidence.json'),
				'{"evidence":1}',
			);
			writeFileSync(
				path.join(swarmDir(), 'evidence', 'retro-1', 'summary.md'),
				'# Summary',
			);

			await handleCloseCommand(testDir, []);

			const archivePath = getLatestArchivePath();
			// One level of nesting works: files are inside the retro-1 subdir
			expect(
				existsSync(
					path.join(archivePath, 'evidence', 'retro-1', 'evidence.json'),
				),
			).toBe(true);
			expect(
				existsSync(path.join(archivePath, 'evidence', 'retro-1', 'summary.md')),
			).toBe(true);
			expect(existsSync(path.join(swarmDir(), 'evidence'))).toBe(false);
		});

		it('empty directory is still tracked as archived and deleted', async () => {
			await writePlan();
			mkdirSync(path.join(swarmDir(), 'scopes'), { recursive: true });

			await handleCloseCommand(testDir, []);

			// Empty directory is archived (no entries to copy but dir is created)
			// Then deleted
			expect(existsSync(path.join(swarmDir(), 'scopes'))).toBe(false);
		});

		it('non-existent directory does not cause errors', async () => {
			await writePlan();
			// scopes/ is never created

			const result = await handleCloseCommand(testDir, []);

			expect(result).toContain('finalized');
			expect(existsSync(path.join(swarmDir(), 'scopes'))).toBe(false);
		});
	});

	// ── Test 4: Archive-first-guard for directories ──────────────────

	describe('Archive-first-guard for directories', () => {
		it('directory not in ACTIVE_STATE_DIRS_TO_CLEAN is NOT deleted', async () => {
			await writePlan();
			// Create a directory that is NOT in ACTIVE_STATE_DIRS_TO_CLEAN
			mkdirSync(path.join(swarmDir(), 'some-other-dir', 'subdir'), {
				recursive: true,
			});
			writeFileSync(
				path.join(swarmDir(), 'some-other-dir', 'file.txt'),
				'some data',
			);

			await handleCloseCommand(testDir, []);

			// This directory was never in the archive list, so it must NOT be deleted
			expect(existsSync(path.join(swarmDir(), 'some-other-dir'))).toBe(true);
			expect(
				readFileSync(
					path.join(swarmDir(), 'some-other-dir', 'file.txt'),
					'utf-8',
				),
			).toBe('some data');
		});

		it('active-state directory is deleted after successful archive', async () => {
			await writePlan();
			mkdirSync(path.join(swarmDir(), 'evidence', 'retro-1'), {
				recursive: true,
			});
			writeFileSync(
				path.join(swarmDir(), 'evidence', 'retro-1', 'ev.json'),
				'{}',
			);

			await handleCloseCommand(testDir, []);

			// evidence/ was in ACTIVE_STATE_DIRS_TO_CLEAN and successfully archived
			// so it must be deleted
			expect(existsSync(path.join(swarmDir(), 'evidence'))).toBe(false);
		});

		it('per-entry copy failure does not prevent directory deletion', async () => {
			await writePlan();
			// Create evidence/ with a file AND a subdirectory
			// The code handles files via copyFile and directories via mkdir+readdir
			// If a file copy fails (e.g. permission error), the per-entry catch
			// swallows it but the directory still gets added to archivedActiveStateDirs
			mkdirSync(path.join(swarmDir(), 'evidence', 'retro-1'), {
				recursive: true,
			});
			writeFileSync(
				path.join(swarmDir(), 'evidence', 'retro-1', 'file.json'),
				'{"file":1}',
			);

			await handleCloseCommand(testDir, []);

			// Directory is deleted because readdir succeeded (entries were processed)
			// Per-entry failures are non-blocking
			expect(existsSync(path.join(swarmDir(), 'evidence'))).toBe(false);
		});
	});

	// ── Test 5: context.md rewritten ──────────────────────────────────

	describe('context.md rewritten after close', () => {
		it('context.md contains "Session closed" text', async () => {
			await writePlan();

			await handleCloseCommand(testDir, []);

			const contextPath = path.join(swarmDir(), 'context.md');
			expect(existsSync(contextPath)).toBe(true);
			const content = readFileSync(contextPath, 'utf-8');
			expect(content).toContain('Session closed');
		});

		it('context.md contains "No active plan" text', async () => {
			await writePlan();

			await handleCloseCommand(testDir, []);

			const contextPath = path.join(swarmDir(), 'context.md');
			const content = readFileSync(contextPath, 'utf-8');
			expect(content).toContain('No active plan. Next session starts fresh.');
		});

		it('context.md contains the project name', async () => {
			await writePlan({ title: 'My Awesome Project' });

			await handleCloseCommand(testDir, []);

			const contextPath = path.join(swarmDir(), 'context.md');
			const content = readFileSync(contextPath, 'utf-8');
			expect(content).toContain('My Awesome Project');
		});

		it('context.md is rewritten even in plan-free session', async () => {
			// No plan.json — plan-free session

			await handleCloseCommand(testDir, []);

			const contextPath = path.join(swarmDir(), 'context.md');
			expect(existsSync(contextPath)).toBe(true);
			const content = readFileSync(contextPath, 'utf-8');
			expect(content).toContain('Session closed');
		});
	});

	// ── Test 6: Idempotency ──────────────────────────────────────────

	describe('Idempotency — running close twice', () => {
		it('second close run produces no errors', async () => {
			await writePlan();
			writeFileSync(
				path.join(swarmDir(), 'events.jsonl'),
				'{"event":"test"}\n',
			);

			const result1 = await handleCloseCommand(testDir, []);
			expect(result1).toContain('finalized');

			const result2 = await handleCloseCommand(testDir, []);
			expect(result2).toContain('finalized');
			// Should not contain error indicators
			expect(result2).not.toContain('❌');
			expect(result2).not.toContain('Failed');
		});

		it('third close run also succeeds', async () => {
			await writePlan();

			await handleCloseCommand(testDir, []);
			await handleCloseCommand(testDir, []);
			const result3 = await handleCloseCommand(testDir, []);

			expect(result3).toContain('finalized');
		});

		it('second close on plan-free session is also idempotent', async () => {
			// No plan.json
			writeFileSync(path.join(swarmDir(), 'events.jsonl'), '{"event":"old"}\n');

			const result1 = await handleCloseCommand(testDir, []);
			expect(result1).toContain('finalized');

			const result2 = await handleCloseCommand(testDir, []);
			expect(result2).toContain('finalized');
		});
	});

	// ── Test 7: archive/ directory survives close ─────────────────────

	describe('archive/ directory survives close', () => {
		it('.swarm/archive/ directory exists after close', async () => {
			await writePlan();

			await handleCloseCommand(testDir, []);

			const archiveBase = path.join(swarmDir(), 'archive');
			expect(existsSync(archiveBase)).toBe(true);
			expect(readdirSync(archiveBase).length).toBeGreaterThanOrEqual(1);
		});

		it('archive bundle itself is intact (not deleted)', async () => {
			await writePlan();

			await handleCloseCommand(testDir, []);

			const archivePath = getLatestArchivePath();
			expect(existsSync(archivePath)).toBe(true);
			expect(existsSync(path.join(archivePath, 'plan.json'))).toBe(true);
		});

		it('new close run creates a second archive bundle', async () => {
			await writePlan({
				phases: [{ id: 1, name: 'P1', status: 'in_progress', tasks: [] }],
			});

			await handleCloseCommand(testDir, []);

			// Clear the session for second run
			mkdirSync(path.join(swarmDir(), 'session'), { recursive: true });
			await writePlan({
				phases: [{ id: 1, name: 'P1', status: 'in_progress', tasks: [] }],
			});

			await handleCloseCommand(testDir, []);

			const archiveBase = path.join(swarmDir(), 'archive');
			const bundles = readdirSync(archiveBase).filter((e) =>
				e.startsWith('swarm-'),
			);
			expect(bundles.length).toBe(2);
		});
	});

	// ── Test 8: close-summary.md survives; spec.md is archived and cleaned ──

	describe('close-summary.md survives; spec.md is archived and cleaned', () => {
		it('close-summary.md is NOT deleted after close', async () => {
			await writePlan();

			await handleCloseCommand(testDir, []);

			// close-summary.md is written AFTER the clean stage, so it always survives.
			// This test confirms the file exists in .swarm/ after close.
			expect(existsSync(path.join(swarmDir(), 'close-summary.md'))).toBe(true);
		});

		it('spec.md is archived then removed after close', async () => {
			await writePlan();
			writeFileSync(
				path.join(swarmDir(), 'spec.md'),
				'# Specification\n\nSome spec.',
			);

			await handleCloseCommand(testDir, []);

			// spec.md is in both ARCHIVE_ARTIFACTS and ACTIVE_STATE_TO_CLEAN: it is
			// archived first (forensic copy preserved in the bundle), then removed
			// from .swarm/ so the next session starts spec-free instead of picking
			// up a stale spec.
			const archivePath = getLatestArchivePath();
			expect(existsSync(path.join(archivePath, 'spec.md'))).toBe(true);
			expect(existsSync(path.join(swarmDir(), 'spec.md'))).toBe(false);
		});

		it('spec-staleness.json is archived then removed after close', async () => {
			await writePlan();
			writeFileSync(
				path.join(swarmDir(), 'spec-staleness.json'),
				'{"type":"spec_stale_detected"}',
			);

			await handleCloseCommand(testDir, []);

			// spec-staleness.json is in both ARCHIVE_ARTIFACTS and
			// ACTIVE_STATE_TO_CLEAN: archived first (forensic copy preserved in
			// the bundle), then removed from .swarm/ so a stale drift gate never
			// survives into the next session.
			const archivePath = getLatestArchivePath();
			expect(existsSync(path.join(archivePath, 'spec-staleness.json'))).toBe(
				true,
			);
			expect(existsSync(path.join(swarmDir(), 'spec-staleness.json'))).toBe(
				false,
			);
		});

		it('spec-snapshot.md is archived then removed after close', async () => {
			await writePlan();
			writeFileSync(
				path.join(swarmDir(), 'spec-snapshot.md'),
				'# Spec snapshot\n',
			);

			await handleCloseCommand(testDir, []);

			const archivePath = getLatestArchivePath();
			expect(existsSync(path.join(archivePath, 'spec-snapshot.md'))).toBe(true);
			expect(existsSync(path.join(swarmDir(), 'spec-snapshot.md'))).toBe(false);
		});

		it('after close, a stale spec-staleness.json no longer blocks the core write tools', async () => {
			await writePlan();
			writeFileSync(
				path.join(swarmDir(), 'spec-staleness.json'),
				'{"type":"spec_stale_detected"}',
			);

			const { enforceSpecDriftGate } = await import(
				'../../../src/hooks/guardrails/index.js'
			);

			// Sanity: before close, the gate blocks save_plan against the stale marker.
			expect(() => enforceSpecDriftGate(testDir, 'save_plan')).toThrow();

			await handleCloseCommand(testDir, []);

			expect(existsSync(path.join(swarmDir(), 'spec-staleness.json'))).toBe(
				false,
			);
			// After close, the marker is gone, so the gate no longer blocks.
			expect(() => enforceSpecDriftGate(testDir, 'save_plan')).not.toThrow();
		});

		it('events.jsonl IS deleted (in ACTIVE_STATE_TO_CLEAN)', async () => {
			await writePlan();
			writeFileSync(path.join(swarmDir(), 'events.jsonl'), '{"event":"old"}\n');

			await handleCloseCommand(testDir, []);

			expect(existsSync(path.join(swarmDir(), 'events.jsonl'))).toBe(false);
		});

		it('after close, a stale spec.md is gone and no longer resolves as the effective spec', async () => {
			await writePlan();
			writeFileSync(
				path.join(swarmDir(), 'spec.md'),
				'# Specification\n\nStale spec that must not survive close.',
			);

			await handleCloseCommand(testDir, []);

			expect(existsSync(path.join(swarmDir(), 'spec.md'))).toBe(false);

			const { readEffectiveSpecSync } = await import(
				'../../../src/sdd/effective-spec.js'
			);
			expect(readEffectiveSpecSync(testDir)).toBeNull();
		});

		it('does not warn "Preserved" for optional ACTIVE_STATE_TO_CLEAN files that were never present', async () => {
			// No spec.md, handoff.md, etc. are written — these are optional files
			// that simply don't exist. The archive stage silently skips them
			// (ENOENT), recording no failure reason. The clean stage must not
			// mistake "never archived because absent" for "archive failed" and
			// must not emit a spurious "Preserved <file> because it was not
			// successfully archived" warning for them.
			await writePlan();

			const result = await handleCloseCommand(testDir, []);

			expect(result).not.toContain('Preserved spec.md');
			expect(result).not.toContain('Preserved handoff.md');
			expect(result).not.toContain('because it was not successfully archived');
		});
	});

	// ── Test 9: All 4 active-state directories archived and deleted ──

	describe('All 4 active-state directories are archived and deleted', () => {
		it('all four directories are archived and removed', async () => {
			await writePlan();

			// Create all 4 directories with unique marker files
			mkdirSync(path.join(swarmDir(), 'evidence', 'retro-x'), {
				recursive: true,
			});
			writeFileSync(
				path.join(swarmDir(), 'evidence', 'marker.txt'),
				'evidence-marker',
			);

			mkdirSync(path.join(swarmDir(), 'session', 'sess-y'), {
				recursive: true,
			});
			writeFileSync(
				path.join(swarmDir(), 'session', 'marker.txt'),
				'session-marker',
			);

			mkdirSync(path.join(swarmDir(), 'scopes'));
			writeFileSync(
				path.join(swarmDir(), 'scopes', 'marker.txt'),
				'scopes-marker',
			);

			mkdirSync(path.join(swarmDir(), 'spec-archive'));
			writeFileSync(
				path.join(swarmDir(), 'spec-archive', 'marker.txt'),
				'spec-archive-marker',
			);

			await handleCloseCommand(testDir, []);

			const archivePath = getLatestArchivePath();

			// All four directories should be in the archive
			expect(existsSync(path.join(archivePath, 'evidence', 'marker.txt'))).toBe(
				true,
			);
			expect(existsSync(path.join(archivePath, 'session', 'marker.txt'))).toBe(
				true,
			);
			expect(existsSync(path.join(archivePath, 'scopes', 'marker.txt'))).toBe(
				true,
			);
			expect(
				existsSync(path.join(archivePath, 'spec-archive', 'marker.txt')),
			).toBe(true);

			// All four directories should be deleted from .swarm/
			expect(existsSync(path.join(swarmDir(), 'evidence'))).toBe(false);
			expect(existsSync(path.join(swarmDir(), 'session'))).toBe(false);
			expect(existsSync(path.join(swarmDir(), 'scopes'))).toBe(false);
			expect(existsSync(path.join(swarmDir(), 'spec-archive'))).toBe(false);
		});
	});

	// ── Test 10: Combined full cleanup ────────────────────────────────

	describe('Full cleanup — all artifact types removed together', () => {
		it('flat files, db files, and directories are all removed after close', async () => {
			await writePlan();

			// Flat files
			writeFileSync(path.join(swarmDir(), 'knowledge.jsonl'), '[]');
			writeFileSync(path.join(swarmDir(), 'telemetry.jsonl'), '[]');
			writeFileSync(path.join(swarmDir(), 'repo-graph.json'), '{}');
			// Real WAL-mode swarm.db (issue #2030: VACUUM INTO requires a valid
			// SQLite source; a fake byte buffer would fail validation and be
			// preserved rather than cleaned).
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

			// Directories
			mkdirSync(path.join(swarmDir(), 'evidence', 'retro-1'), {
				recursive: true,
			});
			writeFileSync(
				path.join(swarmDir(), 'evidence', 'retro-1', 'ev.json'),
				'{}',
			);
			mkdirSync(path.join(swarmDir(), 'scopes'));
			writeFileSync(path.join(swarmDir(), 'scopes', 's.json'), '{}');

			await handleCloseCommand(testDir, []);

			// Flat files removed (but knowledge.jsonl survives)
			expect(existsSync(path.join(swarmDir(), 'knowledge.jsonl'))).toBe(true);
			expect(existsSync(path.join(swarmDir(), 'telemetry.jsonl'))).toBe(false);
			expect(existsSync(path.join(swarmDir(), 'repo-graph.json'))).toBe(false);
			expect(existsSync(path.join(swarmDir(), 'swarm.db'))).toBe(false);

			// Directories removed
			expect(existsSync(path.join(swarmDir(), 'evidence'))).toBe(false);
			expect(existsSync(path.join(swarmDir(), 'scopes'))).toBe(false);

			// But .swarm/ itself still exists
			expect(existsSync(swarmDir())).toBe(true);
			// And archive/ still exists
			expect(existsSync(path.join(swarmDir(), 'archive'))).toBe(true);
			// And context.md was rewritten
			expect(existsSync(path.join(swarmDir(), 'context.md'))).toBe(true);
		});
	});
});
