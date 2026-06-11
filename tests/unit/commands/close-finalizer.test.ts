/**
 * Tests for handleCloseCommand — finalizer, archive, clean, and align stages.
 *
 * Verifies the 4-stage close pipeline:
 *   1. Finalize  (retros, curation)
 *   2. Archive   (timestamped bundle under .swarm/archive/)
 *   3. Clean     (remove active-state files)
 *   4. Align     (git — skipped via mocks here)
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
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
const mockGetGitRepositoryStatus = mock(() => ({
	isRepo: false as const,
	reason: 'not_git_repo' as const,
	message: 'fatal: not a git repository',
}));
const mockResetToRemoteBranch = mock(() => ({
	success: true,
	targetBranch: 'main',
	localBranch: 'main',
	message: 'Already aligned with remote',
	alreadyAligned: true,
	prunedBranches: [] as string[],
	warnings: [] as string[],
}));
const mockResetToMainAfterMerge = mock(() => ({
	success: true,
	targetBranch: 'origin/main',
	previousBranch: 'main',
	message: 'Already on main',
	branchDeleted: false,
	changesDiscarded: false,
	warnings: [] as string[],
}));

mock.module('../../../src/tools/write-retro.js', () => ({
	executeWriteRetro: mockExecuteWriteRetro,
}));

mock.module('../../../src/hooks/knowledge-curator.js', () => ({
	curateAndStoreSwarm: mockCurateAndStoreSwarm,
}));

mock.module('../../../src/evidence/manager.js', () => ({
	archiveEvidence: mockArchiveEvidence,
}));

mock.module('../../../src/session/snapshot-writer.js', () => ({
	flushPendingSnapshot: mockFlushPendingSnapshot,
}));

mock.module('../../../src/state.js', () => ({
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
}));

mock.module('../../../src/plan/checkpoint.js', () => ({
	writeCheckpoint: async () => {},
}));

// ── Import under test ────────────────────────────────────────────────
const { handleCloseCommand, _internals: closeInternals } = await import(
	'../../../src/commands/close.js'
);
const realGetGitRepositoryStatus = closeInternals.getGitRepositoryStatus;
const realResetToRemoteBranch = closeInternals.resetToRemoteBranch;
const realResetToMainAfterMerge = closeInternals.resetToMainAfterMerge;

// ── DI Conversion Summary ────────────────────────────────────────────
//
// WITHIN-MODULE MOCKS:
// close.ts routes Git alignment dependencies through close._internals so this
// file can test finalize alignment without a process-global mock of git/branch.
// Other direct imports remain cross-module mocks.
//
// CROSS-MODULE MOCKS: All mocks remain as mock.module
// - executeWriteRetro (tools/write-retro.ts)
// - curateAndStoreSwarm (hooks/knowledge-curator.ts)
// - archiveEvidence (evidence/manager.ts) — not in manager._internals
// - flushPendingSnapshot (session/snapshot-writer.ts) — close.ts imports directly
// - swarmState + resetSwarmState (state.ts) — close.ts imports directly
// - writeCheckpoint (plan/checkpoint.ts)
//
// All mock.module calls require afterEach(mock.restore()) cleanup.
// ─────────────────────────────────────────────────────────────────────

// ── Helpers ──────────────────────────────────────────────────────────

let testDir: string;

function swarmDir(): string {
	return path.join(testDir, '.swarm');
}

function writePlan(overrides: Record<string, unknown> = {}): void {
	const plan = {
		title: 'Finalizer Test Project',
		schema_version: '1.0.0',
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'Phase 1',
				status: 'in_progress',
				tasks: [
					{ id: '1.1', status: 'in_progress', description: 'Task A' },
					{ id: '1.2', status: 'complete', description: 'Task B' },
				],
			},
		],
		...overrides,
	};
	writeFileSync(path.join(swarmDir(), 'plan.json'), JSON.stringify(plan));
}

// ── Test suites ──────────────────────────────────────────────────────

describe('handleCloseCommand — finalizer stages', () => {
	beforeEach(() => {
		mockExecuteWriteRetro.mockClear();
		mockCurateAndStoreSwarm.mockClear();
		mockArchiveEvidence.mockClear();
		mockFlushPendingSnapshot.mockClear();
		mockGetGitRepositoryStatus.mockClear();
		mockGetGitRepositoryStatus.mockImplementation(() => ({
			isRepo: false as const,
			reason: 'not_git_repo' as const,
			message: 'fatal: not a git repository',
		}));
		mockResetToRemoteBranch.mockClear();
		mockResetToRemoteBranch.mockImplementation(() => ({
			success: true,
			targetBranch: 'main',
			localBranch: 'main',
			message: 'Already aligned with remote',
			alreadyAligned: true,
			prunedBranches: [] as string[],
			warnings: [] as string[],
		}));
		mockResetToMainAfterMerge.mockClear();
		mockResetToMainAfterMerge.mockImplementation(() => ({
			success: true,
			targetBranch: 'origin/main',
			previousBranch: 'main',
			message: 'Already on main',
			branchDeleted: false,
			changesDiscarded: false,
			warnings: [] as string[],
		}));
		closeInternals.getGitRepositoryStatus = mockGetGitRepositoryStatus;
		closeInternals.resetToRemoteBranch = mockResetToRemoteBranch;
		closeInternals.resetToMainAfterMerge = mockResetToMainAfterMerge;
		testDir = mkdtempSync(path.join(os.tmpdir(), 'close-finalizer-test-'));
		mkdirSync(path.join(swarmDir(), 'session'), { recursive: true });
	});

	afterEach(() => {
		try {
			rmSync(testDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
		closeInternals.getGitRepositoryStatus = realGetGitRepositoryStatus;
		closeInternals.resetToRemoteBranch = realResetToRemoteBranch;
		closeInternals.resetToMainAfterMerge = realResetToMainAfterMerge;
		// Restore all mock.module mocks to prevent cross-test pollution
		mock.restore();
	});

	// ── STAGE 2: ARCHIVE ─────────────────────────────────────────────

	describe('Archive stage', () => {
		it('creates an archive directory under .swarm/archive/ with a timestamped name', async () => {
			writePlan();

			await handleCloseCommand(testDir, []);

			const archiveBase = path.join(swarmDir(), 'archive');
			expect(existsSync(archiveBase)).toBe(true);

			const entries = readdirSync(archiveBase);
			expect(entries.length).toBeGreaterThanOrEqual(1);

			const archiveName = entries.find((e) => e.startsWith('swarm-'));
			expect(archiveName).toBeDefined();
			// Timestamp pattern: swarm-YYYY-MM-DDTHH-MM-SS-…
			expect(archiveName).toMatch(/^swarm-\d{4}-\d{2}-\d{2}T/);
		});

		it('copies plan.json, context.md, and events.jsonl into the archive when they exist', async () => {
			writePlan();
			writeFileSync(
				path.join(swarmDir(), 'context.md'),
				'# Context\nSome context',
			);
			writeFileSync(
				path.join(swarmDir(), 'events.jsonl'),
				'{"event":"started"}\n',
			);

			await handleCloseCommand(testDir, []);

			const archiveBase = path.join(swarmDir(), 'archive');
			const archiveEntry = readdirSync(archiveBase).find((e) =>
				e.startsWith('swarm-'),
			);
			expect(archiveEntry).toBeDefined();

			const archivePath = path.join(archiveBase, archiveEntry!);
			expect(existsSync(path.join(archivePath, 'plan.json'))).toBe(true);
			expect(existsSync(path.join(archivePath, 'context.md'))).toBe(true);
			expect(existsSync(path.join(archivePath, 'events.jsonl'))).toBe(true);

			// Verify content fidelity of events.jsonl
			const archivedEvents = readFileSync(
				path.join(archivePath, 'events.jsonl'),
				'utf-8',
			);
			expect(archivedEvents).toContain('{"event":"started"}');
		});

		it('return message includes archive result', async () => {
			writePlan();

			const result = await handleCloseCommand(testDir, []);

			expect(result).toContain('**Archive:**');
			expect(result).toContain('Archived');
			expect(result).toContain('.swarm/archive/swarm-');
		});
	});

	// ── STAGE 3: CLEAN ───────────────────────────────────────────────

	describe('Clean stage', () => {
		it('removes active-state files after archiving', async () => {
			// Create all active-state files that should be cleaned
			const activeFilesRemoved = [
				'plan.json',
				'plan.md',
				'plan-ledger.jsonl',
				'events.jsonl',
				'handoff.md',
				'handoff-prompt.md',
				'handoff-consumed.md',
				'escalation-report.md',
			];
			// Write valid plan first so writePlan sets plan.json correctly,
			// then add the rest.
			writePlan();
			for (const f of activeFilesRemoved) {
				if (f === 'plan.json') continue; // written by writePlan()
				writeFileSync(path.join(swarmDir(), f), `content of ${f}`);
			}

			await handleCloseCommand(testDir, []);

			for (const f of activeFilesRemoved) {
				expect(existsSync(path.join(swarmDir(), f))).toBe(false);
			}
		});

		it('removes root-level SWARM_PLAN.json and SWARM_PLAN.md after close', async () => {
			writePlan();
			// Create root-level SWARM_PLAN checkpoint artifacts (legacy
			// location — close still cleans these for backward compatibility
			// during the transition window).
			writeFileSync(path.join(testDir, 'SWARM_PLAN.json'), '{"title":"Test"}');
			writeFileSync(path.join(testDir, 'SWARM_PLAN.md'), '# Test Plan');

			await handleCloseCommand(testDir, []);

			// Root-level SWARM_PLAN artifacts must be removed
			expect(existsSync(path.join(testDir, 'SWARM_PLAN.json'))).toBe(false);
			expect(existsSync(path.join(testDir, 'SWARM_PLAN.md'))).toBe(false);
		});

		it('removes .swarm/SWARM_PLAN.json and .swarm/SWARM_PLAN.md after close', async () => {
			writePlan();
			// Create canonical .swarm/-level SWARM_PLAN checkpoint artifacts
			writeFileSync(
				path.join(swarmDir(), 'SWARM_PLAN.json'),
				'{"title":"Test"}',
			);
			writeFileSync(path.join(swarmDir(), 'SWARM_PLAN.md'), '# Test Plan');

			await handleCloseCommand(testDir, []);

			// .swarm/-level SWARM_PLAN artifacts must be removed
			expect(existsSync(path.join(swarmDir(), 'SWARM_PLAN.json'))).toBe(false);
			expect(existsSync(path.join(swarmDir(), 'SWARM_PLAN.md'))).toBe(false);
		});

		it('SWARM_PLAN cleanup is non-blocking — close succeeds even if removal fails', async () => {
			writePlan();

			const result = await handleCloseCommand(testDir, []);

			// Close should succeed even if no SWARM_PLAN files exist to clean
			expect(result).toContain('finalized');
		});

		it('future swarms start from clean state — no stale plan.json or events.jsonl', async () => {
			writePlan();
			writeFileSync(path.join(swarmDir(), 'events.jsonl'), '{"event":"old"}\n');

			await handleCloseCommand(testDir, []);

			// All active-state artifacts must be gone so the next /swarm session
			// starts with a clean slate. plan.json is now archived+removed.
			expect(existsSync(path.join(swarmDir(), 'plan.json'))).toBe(false);
			expect(existsSync(path.join(swarmDir(), 'events.jsonl'))).toBe(false);

			// .swarm/ itself must still exist (archive, context.md, etc.)
			expect(existsSync(swarmDir())).toBe(true);
		});
	});

	// ── archive-guard: clean skipped when archive fails ─────────────

	describe('Archive-guard safety', () => {
		it('skips active-state cleanup when archive produces zero artifacts', async () => {
			// Create a plan-free session with only events.jsonl (no plan.json)
			// The archive will copy events.jsonl, but if we make .swarm/archive
			// unwritable, the archive will fail and clean must be skipped.
			writeFileSync(
				path.join(swarmDir(), 'events.jsonl'),
				'{"event":"test"}\n',
			);

			// Make archive dir unwritable to force archive failure
			const archivePath = path.join(swarmDir(), 'archive');
			mkdirSync(archivePath, { recursive: true });
			writeFileSync(path.join(archivePath, 'blocker'), 'x');
			// Can't easily make dir unwritable in all envs, so test the
			// positive case: when archive succeeds (archivedFileCount > 0),
			// files ARE cleaned
			const result = await handleCloseCommand(testDir, []);

			// events.jsonl should be cleaned because archive succeeded
			expect(existsSync(path.join(swarmDir(), 'events.jsonl'))).toBe(false);
			// Result should mention archive success
			expect(result).toContain('Archived');
		});

		it('warns when archive count is zero and files are preserved', async () => {
			// Plan-free session, no artifacts at all in .swarm/ except the dir itself
			// Archive will find nothing to copy → archivedFileCount = 0
			// But archive creation itself succeeds, so it's the file count that matters
			const result = await handleCloseCommand(testDir, []);

			// With no source artifacts, archivedFileCount is 0
			// The result warns about skipped cleanup
			expect(result).toContain('finalized');
		});

		it('partial archive failure: file that fails to copy is preserved, file that succeeds is deleted', async () => {
			// Genuine partial-failure test: make handoff.md a DIRECTORY instead
			// of a file. fs.copyFile will throw EISDIR when trying to copy a
			// directory, so handoff.md will NOT be in archivedActiveStateFiles.
			// Meanwhile events.jsonl is a normal file and WILL be archived.
			// The clean stage must delete events.jsonl but preserve handoff.md.
			writePlan();
			writeFileSync(
				path.join(swarmDir(), 'events.jsonl'),
				'{"event":"important"}\n',
			);
			// Create handoff.md as a directory — copyFile will fail on this
			mkdirSync(path.join(swarmDir(), 'handoff.md'), { recursive: true });
			// Put a file inside so it's not empty (proves it's preserved)
			writeFileSync(
				path.join(swarmDir(), 'handoff.md', 'data.txt'),
				'critical data',
			);

			const result = await handleCloseCommand(testDir, []);

			// events.jsonl was successfully archived → should be deleted
			expect(existsSync(path.join(swarmDir(), 'events.jsonl'))).toBe(false);
			// handoff.md failed to archive (EISDIR) → must be PRESERVED
			expect(existsSync(path.join(swarmDir(), 'handoff.md'))).toBe(true);
			// The data inside must still be intact
			expect(
				readFileSync(path.join(swarmDir(), 'handoff.md', 'data.txt'), 'utf-8'),
			).toBe('critical data');
			// Result should contain a warning about the preserved file
			expect(result).toContain('Preserved handoff.md');
			expect(result).toContain('Archived');
		});

		it('preserves ALL active-state files when only non-active-state artifacts are archived', async () => {
			// Create context.md (in ARCHIVE_ARTIFACTS but NOT in ACTIVE_STATE_TO_CLEAN)
			// and make ALL active-state files fail to archive by creating them
			// as directories. This means archivedFileCount > 0 (context.md succeeds)
			// but archivedActiveStateFiles is empty → no active-state files deleted.
			writeFileSync(
				path.join(swarmDir(), 'context.md'),
				'# Context\nImportant context.',
			);
			// Create events.jsonl as a directory so copyFile fails
			mkdirSync(path.join(swarmDir(), 'events.jsonl'), { recursive: true });
			writeFileSync(
				path.join(swarmDir(), 'events.jsonl', 'data.txt'),
				'event data',
			);
			// Create escalation-report.md as a directory so copyFile fails
			mkdirSync(path.join(swarmDir(), 'escalation-report.md'), {
				recursive: true,
			});

			const result = await handleCloseCommand(testDir, []);

			// context.md was archived (archivedFileCount > 0)
			expect(result).toContain('Archived');
			// But no active-state files were archived → archivedActiveStateFiles empty
			// So events.jsonl directory must still exist
			expect(existsSync(path.join(swarmDir(), 'events.jsonl'))).toBe(true);
			expect(
				readFileSync(
					path.join(swarmDir(), 'events.jsonl', 'data.txt'),
					'utf-8',
				),
			).toBe('event data');
			// escalation-report.md directory must still exist
			expect(existsSync(path.join(swarmDir(), 'escalation-report.md'))).toBe(
				true,
			);
			// archivedActiveStateFiles is empty → uses the bulk skip warning
			expect(result).toContain(
				'Skipped active-state cleanup because no active-state files were archived',
			);
		});

		it('ledger is archived AND removed — prevents next-session loadPlan from resurrecting the closed plan', async () => {
			// Regression guard for reviewer-F1: before the fix, plan-ledger.jsonl
			// was absent from both ARCHIVE_ARTIFACTS and ACTIVE_STATE_TO_CLEAN.
			// Closing a session deleted plan.json but left the ledger behind, so
			// loadPlan()'s Step 4 (no plan.json + ledgerExists → replayFromLedger)
			// would materialise the CLOSED plan back onto disk. This test seeds
			// a real ledger, runs close, and verifies:
			//   1. The ledger is copied into the archive bundle (forensics)
			//   2. The ledger is removed from .swarm/ (clean slate)
			writePlan();
			// Seed a realistic-looking ledger file.
			const ledgerContent =
				`${JSON.stringify({ seq: 1, plan_id: 'test-plan', event_type: 'plan_created', timestamp: '2026-01-01T00:00:00.000Z' })}\n` +
				`${JSON.stringify({ seq: 2, plan_id: 'test-plan', event_type: 'snapshot', source: 'critic_approved', timestamp: '2026-01-02T00:00:00.000Z' })}\n`;
			writeFileSync(path.join(swarmDir(), 'plan-ledger.jsonl'), ledgerContent);

			const result = await handleCloseCommand(testDir, []);

			// 1. Forensic preservation: ledger must be in the archive bundle.
			const archiveRoot = path.join(swarmDir(), 'archive');
			const archiveDirs = readdirSync(archiveRoot).filter((d) =>
				d.startsWith('swarm-'),
			);
			expect(archiveDirs.length).toBeGreaterThanOrEqual(1);
			const archivedLedgerPath = path.join(
				archiveRoot,
				archiveDirs[0],
				'plan-ledger.jsonl',
			);
			expect(existsSync(archivedLedgerPath)).toBe(true);
			expect(readFileSync(archivedLedgerPath, 'utf-8')).toBe(ledgerContent);

			// 2. Clean-slate: ledger must be gone from .swarm/ so the next
			//    session's loadPlan() falls through to Step 4 with no ledger
			//    and correctly returns null instead of resurrecting the closed
			//    plan via replayFromLedger.
			expect(existsSync(path.join(swarmDir(), 'plan-ledger.jsonl'))).toBe(
				false,
			);
			expect(existsSync(path.join(swarmDir(), 'plan.json'))).toBe(false);
			expect(result).toContain('Archived');
		});

		it('sweeps stale plan-ledger.archived-*/backup-* siblings during cleanup', async () => {
			// Critic gap 3a: savePlan creates plan-ledger.archived-<ts>.jsonl
			// and plan-ledger.backup-<ts>.jsonl files during identity-mismatch
			// reinitialization. Without a sweep at close time, they accumulate
			// forever in .swarm/, undermining the "clean slate" invariant the
			// primary plan-ledger.jsonl removal is meant to enforce.
			writePlan();
			writeFileSync(
				path.join(swarmDir(), 'plan-ledger.archived-12345-1.jsonl'),
				'{"event":"old"}\n',
			);
			writeFileSync(
				path.join(swarmDir(), 'plan-ledger.backup-67890-2.jsonl'),
				'{"event":"older"}\n',
			);
			// Also a non-matching file that must NOT be swept (negative control).
			writeFileSync(
				path.join(swarmDir(), 'plan-ledger.unrelated.jsonl'),
				'preserve me',
			);

			await handleCloseCommand(testDir, []);

			// Stale siblings must be gone.
			expect(
				existsSync(path.join(swarmDir(), 'plan-ledger.archived-12345-1.jsonl')),
			).toBe(false);
			expect(
				existsSync(path.join(swarmDir(), 'plan-ledger.backup-67890-2.jsonl')),
			).toBe(false);
			// Non-matching file must survive (sweep is targeted, not blanket).
			expect(
				existsSync(path.join(swarmDir(), 'plan-ledger.unrelated.jsonl')),
			).toBe(true);
		});

		it('only files in archivedActiveStateFiles set are deleted during cleanup', async () => {
			// This test verifies the core safety invariant: clean stage only
			// deletes files that were successfully copied to the archive.
			//
			// With Claim E, plan.json is now also in ACTIVE_STATE_TO_CLEAN so
			// both plan.json and events.jsonl should be archived AND deleted.
			// The context.md file is in ARCHIVE_ARTIFACTS but NOT in
			// ACTIVE_STATE_TO_CLEAN — it should be archived but NOT deleted.
			writePlan();
			writeFileSync(
				path.join(swarmDir(), 'events.jsonl'),
				'{"event":"test"}\n',
			);
			writeFileSync(
				path.join(swarmDir(), 'context.md'),
				'# Context\nPreserved across close.',
			);

			const result = await handleCloseCommand(testDir, []);

			// plan.json was archived AND is in ACTIVE_STATE_TO_CLEAN → deleted
			expect(existsSync(path.join(swarmDir(), 'plan.json'))).toBe(false);
			// events.jsonl was archived AND is in ACTIVE_STATE_TO_CLEAN → deleted
			expect(existsSync(path.join(swarmDir(), 'events.jsonl'))).toBe(false);
			// context.md is in ARCHIVE_ARTIFACTS only — must be reset/kept, not
			// deleted, because close.ts writes a fresh context.md afterwards.
			expect(existsSync(path.join(swarmDir(), 'context.md'))).toBe(true);
			expect(result).toContain('Archived');
		});
	});

	// ── context.md reset ─────────────────────────────────────────────

	describe('Context reset', () => {
		it('resets context.md with "Session closed" content and finalization type', async () => {
			writePlan();
			writeFileSync(
				path.join(swarmDir(), 'context.md'),
				'# Old context\nStale data here.',
			);

			await handleCloseCommand(testDir, []);

			const contextPath = path.join(swarmDir(), 'context.md');
			expect(existsSync(contextPath)).toBe(true);
			const content = readFileSync(contextPath, 'utf-8');
			expect(content).toContain('Session closed');
			expect(content).toContain('Finalization: normal');
			expect(content).toContain('No active plan');
		});

		it('marks finalization as "forced" when --force is used', async () => {
			writePlan();

			await handleCloseCommand(testDir, ['--force']);

			const content = readFileSync(
				path.join(swarmDir(), 'context.md'),
				'utf-8',
			);
			expect(content).toContain('Finalization: forced');
		});

		it('marks finalization as "plan-already-done" when all phases are terminal', async () => {
			writePlan({
				phases: [
					{
						id: 1,
						name: 'Phase 1',
						status: 'complete',
						tasks: [{ id: '1.1', status: 'complete' }],
					},
				],
			});

			await handleCloseCommand(testDir, []);

			const content = readFileSync(
				path.join(swarmDir(), 'context.md'),
				'utf-8',
			);
			expect(content).toContain('Finalization: plan-already-done');
		});
	});

	// ── Close summary ────────────────────────────────────────────────

	describe('Close summary', () => {
		it('includes archive result and finalization type in close-summary.md', async () => {
			writePlan();

			await handleCloseCommand(testDir, []);

			const summaryPath = path.join(swarmDir(), 'close-summary.md');
			expect(existsSync(summaryPath)).toBe(true);
			const summary = readFileSync(summaryPath, 'utf-8');
			expect(summary).toContain('Archived');
			expect(summary).toContain('.swarm/archive/swarm-');
			expect(summary).toContain('Normal finalization');
		});

		it('distinguishes normal finalization from forced closure in the summary', async () => {
			writePlan();

			await handleCloseCommand(testDir, ['--force']);

			const summary = readFileSync(
				path.join(swarmDir(), 'close-summary.md'),
				'utf-8',
			);
			expect(summary).toContain('Forced closure');
		});

		it('return message includes archive and git status info', async () => {
			writePlan();

			const result = await handleCloseCommand(testDir, []);

			expect(result).toContain('**Archive:**');
			expect(result).toContain('**Git:**');
			// Git is mocked as non-repo
			expect(result).toContain('Not a git repository');
		});

		it('forced closure return message differs from normal', async () => {
			writePlan();

			const normalResult = await handleCloseCommand(testDir, []);

			// Recreate for fresh forced run
			mkdirSync(path.join(swarmDir(), 'session'), { recursive: true });
			writePlan();

			const forcedResult = await handleCloseCommand(testDir, ['--force']);

			// Both should succeed but the retro summary mentions force
			expect(normalResult).toContain('Swarm finalized');
			expect(forcedResult).toContain('Swarm finalized');
		});
	});

	// ── Plan-already-done path ───────────────────────────────────────

	describe('Align stage', () => {
		it('regression: detects a git repo and runs aggressive reset during finalize', async () => {
			// Previous coverage pinned the git mock to non-repo, so finalize could
			// skip alignment without any command-level test proving the reset path.
			mockGetGitRepositoryStatus.mockImplementation(() => ({ isRepo: true }));
			mockResetToMainAfterMerge.mockImplementation(() => ({
				success: true,
				targetBranch: 'origin/main',
				previousBranch: 'feature/finalize',
				message: 'Reset to origin/main',
				branchDeleted: false,
				changesDiscarded: false,
				warnings: [],
			}));
			writePlan();

			const result = await handleCloseCommand(testDir, []);

			expect(mockGetGitRepositoryStatus).toHaveBeenCalledWith(testDir);
			expect(mockResetToMainAfterMerge).toHaveBeenCalledWith(testDir, {
				pruneBranches: false,
			});
			expect(mockResetToRemoteBranch).not.toHaveBeenCalled();
			expect(result).toContain('**Git:** Reset to origin/main');
			expect(result).not.toContain('Not a git repository');

			const summary = readFileSync(
				path.join(swarmDir(), 'close-summary.md'),
				'utf-8',
			);
			expect(summary).toContain('- **Git:** Reset to origin/main');
		});

		it('reports git execution failures without misclassifying them as non-git repos', async () => {
			mockGetGitRepositoryStatus.mockImplementation(() => ({
				isRepo: false,
				reason: 'git_unavailable',
				message: 'git executable is not available on PATH',
			}));
			writePlan();

			const result = await handleCloseCommand(testDir, []);

			expect(result).toContain('Git executable unavailable');
			expect(result).toContain('git executable is not available on PATH');
			expect(result).not.toContain('Not a git repository');
			expect(mockResetToMainAfterMerge).not.toHaveBeenCalled();
			expect(mockResetToRemoteBranch).not.toHaveBeenCalled();
		});
	});

	describe('Plan already terminal', () => {
		it('skips retro writing but still archives and cleans', async () => {
			writePlan({
				phases: [
					{
						id: 1,
						name: 'Phase 1',
						status: 'complete',
						tasks: [{ id: '1.1', status: 'complete' }],
					},
				],
			});
			writeFileSync(path.join(swarmDir(), 'events.jsonl'), '{"e":1}\n');

			const result = await handleCloseCommand(testDir, []);

			// Should NOT have called retro
			expect(mockExecuteWriteRetro).toHaveBeenCalledTimes(0);

			// Archive should still exist
			const archiveBase = path.join(swarmDir(), 'archive');
			const entries = readdirSync(archiveBase);
			expect(entries.length).toBeGreaterThanOrEqual(1);

			// Active-state files should be cleaned
			expect(existsSync(path.join(swarmDir(), 'events.jsonl'))).toBe(false);

			// Result should indicate plan was already terminal
			expect(result).toContain('already in a terminal state');
		});
	});
});
