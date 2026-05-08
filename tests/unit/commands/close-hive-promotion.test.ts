/**
 * Tests for handleCloseCommand — hive promotion feature.
 *
 * Verifies:
 *   - Hive promotion succeeds for multiple lessons
 *   - Individual promotion failures are non-blocking
 *   - Empty knowledge.jsonl skips promotion gracefully
 *   - Failed curation guards against promotion attempts
 *   - Overall promotion failure is non-blocking
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
const mockPromoteToHive = mock(
	async (_dir: string, _lesson: string, _category: string) => {},
);
const mockReadKnowledge = mock(async (_path: string) => [
	{ id: 'entry-1', lesson: 'Lesson one', category: 'process' },
]);
const mockResolveSwarmKnowledgePath = mock((_dir: string) =>
	path.join(_dir, '.swarm', 'knowledge.jsonl'),
);

mock.module('../../../src/tools/write-retro.js', () => ({
	executeWriteRetro: mockExecuteWriteRetro,
}));

mock.module('../../../src/hooks/knowledge-curator.js', () => ({
	curateAndStoreSwarm: mockCurateAndStoreSwarm,
}));

mock.module('../../../src/hooks/hive-promoter.js', () => ({
	promoteToHive: mockPromoteToHive,
}));

mock.module('../../../src/hooks/knowledge-store.js', () => ({
	readKnowledge: mockReadKnowledge,
	resolveSwarmKnowledgePath: mockResolveSwarmKnowledgePath,
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

function setupSwarmDir(): void {
	rmSync(swarmDir(), { recursive: true, force: true });
	mkdtempSync(path.join(os.tmpdir(), 'close-hive-promotion-test-'));
}

function writePlan(overrides: Record<string, unknown> = {}): void {
	const plan = {
		title: 'Hive Promotion Test Project',
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

describe('handleCloseCommand — hive promotion', () => {
	beforeEach(() => {
		mockExecuteWriteRetro.mockClear();
		mockCurateAndStoreSwarm.mockClear();
		mockCurateAndStoreSwarm.mockImplementation(async () => {});
		mockArchiveEvidence.mockClear();
		mockFlushPendingSnapshot.mockClear();
		mockPromoteToHive.mockClear();
		mockPromoteToHive.mockImplementation(
			async (_dir: string, _lesson: string, _category: string) => {},
		);
		mockReadKnowledge.mockClear();
		mockReadKnowledge.mockImplementation(async () => [
			{ id: 'entry-1', lesson: 'Lesson one', category: 'process' },
		]);
		mockResolveSwarmKnowledgePath.mockClear();
		mockResolveSwarmKnowledgePath.mockImplementation((_dir: string) =>
			path.join(_dir, '.swarm', 'knowledge.jsonl'),
		);
		testDir = mkdtempSync(path.join(os.tmpdir(), 'close-hive-promotion-test-'));
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

	// ── Test 1: Hive promotion succeeds for multiple lessons ──────────

	describe('Hive promotion succeeds for multiple lessons', () => {
		it('promotes all lessons when curation succeeds', async () => {
			writePlan();

			// Override mock to return 3 entries
			mockReadKnowledge.mockImplementation(async () => [
				{ id: 'entry-1', lesson: 'Lesson one', category: 'process' },
				{ id: 'entry-2', lesson: 'Lesson two', category: 'architecture' },
				{ id: 'entry-3', lesson: 'Lesson three', category: 'tooling' },
			]);

			const result = await handleCloseCommand(testDir, []);

			expect(mockPromoteToHive).toHaveBeenCalledTimes(3);
			// Result should contain promotion summary (exact string depends on close.ts implementation)
			expect(result).toContain('finalized');
		});

		it('close still succeeds after promoting multiple lessons', async () => {
			writePlan();

			mockReadKnowledge.mockImplementation(async () => [
				{ id: 'entry-1', lesson: 'Lesson one', category: 'process' },
				{ id: 'entry-2', lesson: 'Lesson two', category: 'architecture' },
			]);

			const result = await handleCloseCommand(testDir, []);

			expect(result).toContain('finalized');
			expect(result).not.toContain('❌');
		});
	});

	// ── Test 2: Hive promotion non-blocking on individual failure ──────

	describe('Hive promotion non-blocking on individual failure', () => {
		it('continues promoting remaining lessons when one fails', async () => {
			writePlan();

			mockReadKnowledge.mockImplementation(async () => [
				{ id: 'entry-1', lesson: 'Lesson one', category: 'process' },
				{ id: 'entry-2', lesson: 'Lesson two', category: 'architecture' },
				{ id: 'entry-3', lesson: 'Lesson three', category: 'tooling' },
			]);

			// Make the second promotion fail
			let callCount = 0;
			mockPromoteToHive.mockImplementation(
				async (_dir: string, _lesson: string, _category: string) => {
					callCount++;
					if (callCount === 2) {
						throw new Error('Simulated promotion failure for entry 2');
					}
				},
			);

			const result = await handleCloseCommand(testDir, []);

			// All 3 lessons were attempted
			expect(mockPromoteToHive).toHaveBeenCalledTimes(3);
			// Close still succeeds
			expect(result).toContain('finalized');
			expect(result).not.toContain('❌');
		});

		it('logs warning for failed individual promotion', async () => {
			writePlan();

			mockReadKnowledge.mockImplementation(async () => [
				{ id: 'entry-1', lesson: 'Lesson one', category: 'process' },
				{ id: 'entry-2', lesson: 'Lesson two', category: 'architecture' },
			]);

			mockPromoteToHive.mockImplementation(async () => {
				throw new Error('Promotion service unavailable');
			});

			const result = await handleCloseCommand(testDir, []);

			// Both lessons were attempted
			expect(mockPromoteToHive).toHaveBeenCalledTimes(2);
			// Warning should mention the failure
			expect(result).toContain('Hive promotion skipped');
		});
	});

	// ── Test 3: Hive promotion skipped when no knowledge.jsonl ────────

	describe('Hive promotion skipped when no knowledge.jsonl', () => {
		it('skips promotion when readKnowledge returns empty array', async () => {
			writePlan();

			mockReadKnowledge.mockImplementation(async () => []);

			const result = await handleCloseCommand(testDir, []);

			expect(mockPromoteToHive).toHaveBeenCalledTimes(0);
			// Empty array means no entries to promote, no warning expected
			expect(result).not.toContain('Promoted');
		});

		it('logs warning when knowledge file read fails', async () => {
			writePlan();

			const error = new Error('ENOENT: file not found');
			(error as NodeJS.ErrnoException).code = 'ENOENT';
			mockReadKnowledge.mockImplementation(async () => {
				throw error;
			});

			const result = await handleCloseCommand(testDir, []);

			expect(mockPromoteToHive).toHaveBeenCalledTimes(0);
			// When readKnowledge throws, outer catch logs "Hive promotion failed"
			expect(result).toContain('Hive promotion failed');
		});
	});

	// ── Test 4: Hive promotion skipped when curation fails ────────────

	describe('Hive promotion skipped when curation fails', () => {
		it('logs warning when curation fails but close still succeeds', async () => {
			writePlan();

			mockCurateAndStoreSwarm.mockImplementation(async () => {
				throw new Error('Curation service unavailable');
			});

			const result = await handleCloseCommand(testDir, []);

			// promoteToHive should never be called because curationSucceeded is false
			expect(mockPromoteToHive).toHaveBeenCalledTimes(0);
			// Close still succeeds
			expect(result).toContain('finalized');
			// Warning about curation failure
			expect(result).toContain('Lessons curation failed');
		});

		it('close succeeds even when curation fails', async () => {
			writePlan();

			mockCurateAndStoreSwarm.mockImplementation(async () => {
				throw new Error('Simulated curation failure');
			});

			const result = await handleCloseCommand(testDir, []);

			expect(result).toContain('finalized');
			expect(result).not.toContain('❌');
		});
	});

	// ── Test 5: Overall hive promotion failure non-blocking ───────────

	describe('Overall hive promotion failure non-blocking', () => {
		it('logs warning but still succeeds when readKnowledge throws', async () => {
			writePlan();

			mockReadKnowledge.mockImplementation(async () => {
				throw new Error('Knowledge store corrupted');
			});

			const result = await handleCloseCommand(testDir, []);

			expect(mockPromoteToHive).toHaveBeenCalledTimes(0);
			expect(result).toContain('Hive promotion failed');
			expect(result).toContain('Knowledge store corrupted');
			expect(result).toContain('finalized');
			expect(result).not.toContain('❌');
		});

		it('logs warning but close still succeeds when resolveSwarmKnowledgePath throws', async () => {
			writePlan();

			mockResolveSwarmKnowledgePath.mockImplementation(() => {
				throw new Error('Path resolution failed');
			});

			const result = await handleCloseCommand(testDir, []);

			expect(result).toContain('Hive promotion failed');
			expect(result).toContain('Path resolution failed');
			expect(result).toContain('finalized');
			expect(result).not.toContain('❌');
		});
	});
});
