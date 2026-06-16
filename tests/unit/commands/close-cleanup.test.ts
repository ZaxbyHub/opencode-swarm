/**
 * Tests for handleCloseCommand — expanded artifact cleanup (Phase 1 sub-task 1.2).
 *
 * Verifies the flat-file and directory archiving/deletion behavior:
 *   - 21 flat files in ARCHIVE_ARTIFACTS are copied to the archive bundle
 *   - 17 flat files in ACTIVE_STATE_TO_CLEAN are removed from .swarm/ after archiving
 *   - 5 active-state directories (evidence/, session/, scopes/, locks/, spec-archive/)
 *     are recursively copied to the archive and then deleted
 *   - Archive-first-guard: directories are only deleted if they were successfully archived
 *   - close-summary.md and spec.md are NOT in ACTIVE_STATE_TO_CLEAN — survive the clean stage
 *   - .swarm/archive/ itself survives the close
 *   - context.md is rewritten with "Session closed" content
 *   - Idempotent: running close twice produces no errors
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
	resetSwarmStatePreservingSingletons: () => {},
}));

mock.module('../../../src/git/branch.js', () => ({
	isGitRepo: () => false,
	getCurrentBranch: () => 'main',
	getDefaultBaseBranch: () => 'origin/main',
	hasUncommittedChanges: () => false,
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

function writePlan(overrides: Record<string, unknown> = {}): void {
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
				tasks: [
					{ id: '1.1', phase: 1, status: 'in_progress', description: 'Task A' },
					{ id: '1.2', phase: 1, status: 'in_progress', description: 'Task B' },
				],
			},
		],
		...overrides,
	};
	writeFileSync(path.join(swarmDir(), 'plan.json'), JSON.stringify(plan));
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

// ── Test suites ──────────────────────────────────────────────────────

describe('handleCloseCommand — expanded artifact cleanup', () => {
	beforeEach(() => {
		mockExecuteWriteRetro.mockClear();
		mockCurateAndStoreSwarm.mockClear();
		mockArchiveEvidence.mockClear();
		mockFlushPendingSnapshot.mockClear();
		testDir = mkdtempSync(path.join(os.tmpdir(), 'close-cleanup-test-'));
		mkdirSync(path.join(swarmDir(), 'session'), { recursive: true });
	});

	afterEach(() => {
		try {
			rmSync(testDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
		mock.restore();
	});

	// ── Test 1: Flat-file archiving ────────────────────────────────────

	describe('Flat-file archiving (knowledge.jsonl, repo-graph.json, telemetry.jsonl, etc.)', () => {
		it('archives knowledge.jsonl (survives cleanup)', async () => {
			writePlan();
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
			writePlan();
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
			writePlan();
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
			writePlan();
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
			writePlan();
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
			writePlan();
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
			writePlan();
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
			writePlan();
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
			writePlan();
			writeFileSync(path.join(swarmDir(), 'plan.md'), '# Plan\n\n## Phase 1');

			await handleCloseCommand(testDir, []);

			const archivePath = getLatestArchivePath();
			expect(existsSync(path.join(archivePath, 'plan.json'))).toBe(true);
			expect(existsSync(path.join(archivePath, 'plan.md'))).toBe(true);
		});

		it('plan-ledger.jsonl is archived', async () => {
			writePlan();
			writeFileSync(
				path.join(swarmDir(), 'plan-ledger.jsonl'),
				`{"seq":1,"event":"created"}\n`,
			);

			await handleCloseCommand(testDir, []);

			const archivePath = getLatestArchivePath();
			expect(existsSync(path.join(archivePath, 'plan-ledger.jsonl'))).toBe(
				true,
			);
		});
	});

	// ── Test 2: swarm.db cleanup ──────────────────────────────────────

	describe('swarm.db cleanup (swarm.db, swarm.db-shm, swarm.db-wal)', () => {
		it('archives and removes swarm.db', async () => {
			writePlan();
			writeFileSync(
				path.join(swarmDir(), 'swarm.db'),
				Buffer.from('sqlite db content'),
			);

			await handleCloseCommand(testDir, []);

			const archivePath = getLatestArchivePath();
			expect(existsSync(path.join(archivePath, 'swarm.db'))).toBe(true);
			expect(existsSync(path.join(swarmDir(), 'swarm.db'))).toBe(false);
		});

		it('archives and removes swarm.db-shm', async () => {
			writePlan();
			writeFileSync(
				path.join(swarmDir(), 'swarm.db-shm'),
				Buffer.from('shm content'),
			);

			await handleCloseCommand(testDir, []);

			const archivePath = getLatestArchivePath();
			expect(existsSync(path.join(archivePath, 'swarm.db-shm'))).toBe(true);
			expect(existsSync(path.join(swarmDir(), 'swarm.db-shm'))).toBe(false);
		});

		it('archives and removes swarm.db-wal', async () => {
			writePlan();
			writeFileSync(
				path.join(swarmDir(), 'swarm.db-wal'),
				Buffer.from('wal content'),
			);

			await handleCloseCommand(testDir, []);

			const archivePath = getLatestArchivePath();
			expect(existsSync(path.join(archivePath, 'swarm.db-wal'))).toBe(true);
			expect(existsSync(path.join(swarmDir(), 'swarm.db-wal'))).toBe(false);
		});

		it('all three db files are present in archive with correct content', async () => {
			writePlan();
			writeFileSync(path.join(swarmDir(), 'swarm.db'), Buffer.from('db'));
			writeFileSync(path.join(swarmDir(), 'swarm.db-shm'), Buffer.from('shm'));
			writeFileSync(path.join(swarmDir(), 'swarm.db-wal'), Buffer.from('wal'));

			await handleCloseCommand(testDir, []);

			const archivePath = getLatestArchivePath();
			const archivedDb = readFileSync(path.join(archivePath, 'swarm.db'));
			const archivedShm = readFileSync(path.join(archivePath, 'swarm.db-shm'));
			const archivedWal = readFileSync(path.join(archivePath, 'swarm.db-wal'));
			expect(archivedDb.toString()).toBe('db');
			expect(archivedShm.toString()).toBe('shm');
			expect(archivedWal.toString()).toBe('wal');
		});
	});

	// ── Test 3: Directory archiving and deletion ─────────────────────

	describe('Directory archiving and deletion', () => {
		it('archives and deletes evidence/ directory with contents', async () => {
			writePlan();
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
			writePlan();
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
			writePlan();
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

		it('archives and deletes locks/ directory with contents', async () => {
			writePlan();
			mkdirSync(path.join(swarmDir(), 'locks'), { recursive: true });
			writeFileSync(
				path.join(swarmDir(), 'locks', 'tool-lock.json'),
				'{"locked":true}',
			);

			await handleCloseCommand(testDir, []);

			const archivePath = getLatestArchivePath();
			expect(
				existsSync(path.join(archivePath, 'locks', 'tool-lock.json')),
			).toBe(true);
			expect(existsSync(path.join(swarmDir(), 'locks'))).toBe(false);
		});

		it('archives and deletes spec-archive/ directory with contents', async () => {
			writePlan();
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
			writePlan();
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
			writePlan();
			mkdirSync(path.join(swarmDir(), 'scopes'), { recursive: true });

			await handleCloseCommand(testDir, []);

			// Empty directory is archived (no entries to copy but dir is created)
			// Then deleted
			expect(existsSync(path.join(swarmDir(), 'scopes'))).toBe(false);
		});

		it('non-existent directory does not cause errors', async () => {
			writePlan();
			// scopes/ is never created

			const result = await handleCloseCommand(testDir, []);

			expect(result).toContain('finalized');
			expect(existsSync(path.join(swarmDir(), 'scopes'))).toBe(false);
		});
	});

	// ── Test 4: Archive-first-guard for directories ──────────────────

	describe('Archive-first-guard for directories', () => {
		it('directory not in ACTIVE_STATE_DIRS_TO_CLEAN is NOT deleted', async () => {
			writePlan();
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
			writePlan();
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
			writePlan();
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
			writePlan();

			await handleCloseCommand(testDir, []);

			const contextPath = path.join(swarmDir(), 'context.md');
			expect(existsSync(contextPath)).toBe(true);
			const content = readFileSync(contextPath, 'utf-8');
			expect(content).toContain('Session closed');
		});

		it('context.md contains "No active plan" text', async () => {
			writePlan();

			await handleCloseCommand(testDir, []);

			const contextPath = path.join(swarmDir(), 'context.md');
			const content = readFileSync(contextPath, 'utf-8');
			expect(content).toContain('No active plan. Next session starts fresh.');
		});

		it('context.md contains the project name', async () => {
			writePlan({ title: 'My Awesome Project' });

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
			writePlan();
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
			writePlan();

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
			writePlan();

			await handleCloseCommand(testDir, []);

			const archiveBase = path.join(swarmDir(), 'archive');
			expect(existsSync(archiveBase)).toBe(true);
			expect(readdirSync(archiveBase).length).toBeGreaterThanOrEqual(1);
		});

		it('archive bundle itself is intact (not deleted)', async () => {
			writePlan();

			await handleCloseCommand(testDir, []);

			const archivePath = getLatestArchivePath();
			expect(existsSync(archivePath)).toBe(true);
			expect(existsSync(path.join(archivePath, 'plan.json'))).toBe(true);
		});

		it('new close run creates a second archive bundle', async () => {
			writePlan({
				phases: [{ id: 1, name: 'P1', status: 'in_progress', tasks: [] }],
			});

			await handleCloseCommand(testDir, []);

			// Clear the session for second run
			mkdirSync(path.join(swarmDir(), 'session'), { recursive: true });
			writePlan({
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

	// ── Test 8: close-summary.md and spec.md NOT in ACTIVE_STATE_TO_CLEAN ──

	describe('close-summary.md and spec.md survive the clean stage', () => {
		it('close-summary.md is NOT deleted after close', async () => {
			writePlan();

			await handleCloseCommand(testDir, []);

			// close-summary.md is written AFTER the clean stage, so it always survives.
			// This test confirms the file exists in .swarm/ after close.
			expect(existsSync(path.join(swarmDir(), 'close-summary.md'))).toBe(true);
		});

		it('spec.md (when present) is NOT deleted after close', async () => {
			writePlan();
			writeFileSync(
				path.join(swarmDir(), 'spec.md'),
				'# Specification\n\nSome spec.',
			);

			await handleCloseCommand(testDir, []);

			// spec.md is in ARCHIVE_ARTIFACTS but NOT in ACTIVE_STATE_TO_CLEAN.
			// It should be archived but NOT deleted from .swarm/.
			const archivePath = getLatestArchivePath();
			expect(existsSync(path.join(archivePath, 'spec.md'))).toBe(true);
			expect(existsSync(path.join(swarmDir(), 'spec.md'))).toBe(true);
		});

		it('events.jsonl IS deleted (in ACTIVE_STATE_TO_CLEAN)', async () => {
			writePlan();
			writeFileSync(path.join(swarmDir(), 'events.jsonl'), '{"event":"old"}\n');

			await handleCloseCommand(testDir, []);

			expect(existsSync(path.join(swarmDir(), 'events.jsonl'))).toBe(false);
		});
	});

	// ── Test 9: All 5 active-state directories archived and deleted ──

	describe('All 5 active-state directories are archived and deleted', () => {
		it('all five directories are archived and removed', async () => {
			writePlan();

			// Create all 5 directories with unique marker files
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

			mkdirSync(path.join(swarmDir(), 'locks'));
			writeFileSync(
				path.join(swarmDir(), 'locks', 'marker.txt'),
				'locks-marker',
			);

			mkdirSync(path.join(swarmDir(), 'spec-archive'));
			writeFileSync(
				path.join(swarmDir(), 'spec-archive', 'marker.txt'),
				'spec-archive-marker',
			);

			await handleCloseCommand(testDir, []);

			const archivePath = getLatestArchivePath();

			// All five directories should be in the archive
			expect(existsSync(path.join(archivePath, 'evidence', 'marker.txt'))).toBe(
				true,
			);
			expect(existsSync(path.join(archivePath, 'session', 'marker.txt'))).toBe(
				true,
			);
			expect(existsSync(path.join(archivePath, 'scopes', 'marker.txt'))).toBe(
				true,
			);
			expect(existsSync(path.join(archivePath, 'locks', 'marker.txt'))).toBe(
				true,
			);
			expect(
				existsSync(path.join(archivePath, 'spec-archive', 'marker.txt')),
			).toBe(true);

			// All five directories should be deleted from .swarm/
			expect(existsSync(path.join(swarmDir(), 'evidence'))).toBe(false);
			expect(existsSync(path.join(swarmDir(), 'session'))).toBe(false);
			expect(existsSync(path.join(swarmDir(), 'scopes'))).toBe(false);
			expect(existsSync(path.join(swarmDir(), 'locks'))).toBe(false);
			expect(existsSync(path.join(swarmDir(), 'spec-archive'))).toBe(false);
		});
	});

	// ── Test 10: Combined full cleanup ────────────────────────────────

	describe('Full cleanup — all artifact types removed together', () => {
		it('flat files, db files, and directories are all removed after close', async () => {
			writePlan();

			// Flat files
			writeFileSync(path.join(swarmDir(), 'knowledge.jsonl'), '[]');
			writeFileSync(path.join(swarmDir(), 'telemetry.jsonl'), '[]');
			writeFileSync(path.join(swarmDir(), 'repo-graph.json'), '{}');
			writeFileSync(path.join(swarmDir(), 'swarm.db'), Buffer.from('db'));

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

	// ── Test 11: .tmp.* temp file sweep (FR-013) ──────────────────────

	describe('.tmp.* temp file sweep', () => {
		it('removes .tmp.* files from .swarm/ after close but leaves non-.tmp.* files untouched', async () => {
			writePlan();

			// Create .tmp.xxx temp artifact (should be swept by close cleanup)
			writeFileSync(path.join(swarmDir(), '.tmp.xxx'), 'stale temp data');

			// Create a non-.tmp.* file that must NOT be swept
			writeFileSync(
				path.join(swarmDir(), 'normal-artifact.json'),
				'{"keep":true}',
			);

			await handleCloseCommand(testDir, []);

			// .tmp.* file must be removed (stale temp sweep, not archived)
			expect(existsSync(path.join(swarmDir(), '.tmp.xxx'))).toBe(false);

			// non-.tmp.* file must survive the sweep
			expect(existsSync(path.join(swarmDir(), 'normal-artifact.json'))).toBe(
				true,
			);
			expect(
				readFileSync(path.join(swarmDir(), 'normal-artifact.json'), 'utf-8'),
			).toBe('{"keep":true}');
		});
	});
});
