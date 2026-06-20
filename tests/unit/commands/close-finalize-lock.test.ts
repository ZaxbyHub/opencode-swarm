/**
 * Tests for handleCloseCommand — finalize lock (FR-012).
 *
 * Uses _internals DI seam. No mock.module usage.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ── Import under test ────────────────────────────────────────────────
const { handleCloseCommand, _internals: closeInternals } = await import(
	'../../../src/commands/close.js'
);

// ── Save real _internals ─────────────────────────────────────────────
const realAcquireFinalizeLock = closeInternals.acquireFinalizeLock;
const realLoadPluginConfigWithMeta = closeInternals.loadPluginConfigWithMeta;
const realCurateAndStoreSwarm = closeInternals.curateAndStoreSwarm;
const realCheckHivePromotions = closeInternals.checkHivePromotions;
const realGetGitRepositoryStatus = closeInternals.getGitRepositoryStatus;
const realResetToMainAfterMerge = closeInternals.resetToMainAfterMerge;
const realResetToRemoteBranch = closeInternals.resetToRemoteBranch;
const realResetSwarmStatePreservingSingletons =
	closeInternals.resetSwarmStatePreservingSingletons;

// ── Helpers ──────────────────────────────────────────────────────────

let testDir: string;

function swarmDir(): string {
	return path.join(testDir, '.swarm');
}

function writePlan(overrides: Record<string, unknown> = {}): void {
	const plan = {
		title: 'Finalize Lock Test Project',
		schema_version: '1.0.0',
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'Phase 1',
				status: 'in_progress',
				tasks: [{ id: '1.1', status: 'in_progress', description: 'Task A' }],
			},
		],
		...overrides,
	};
	writeFileSync(path.join(swarmDir(), 'plan.json'), JSON.stringify(plan));
}

function makeConfig(): Record<string, unknown> {
	return {
		config: {
			knowledge: {
				enabled: true,
				hive_enabled: false,
				auto_promote_days: 90,
				swarm_max_entries: 100,
				hive_max_entries: 200,
				max_inject_count: 5,
				delegate_max_inject_count: 8,
				inject_char_budget: 2000,
				max_lesson_display_chars: 120,
				dedup_threshold: 0.6,
				scope_filter: ['global'],
				rejected_max_entries: 20,
				validation_enabled: true,
				evergreen_confidence: 0.9,
				evergreen_utility: 0.8,
				low_utility_threshold: 0.3,
				min_retrievals_for_utility: 3,
				schema_version: 1,
				directive_min_confidence: 0.75,
				same_project_weight: 1.0,
				cross_project_weight: 0.5,
				min_encounter_score: 0.1,
				initial_encounter_score: 1.0,
				encounter_increment: 0.1,
				max_encounter_score: 10.0,
				default_max_phases: 10,
				todo_max_phases: 3,
				sweep_enabled: true,
				enrichment: { max_calls_per_day: 10, quota_window: 'utc' },
			},
			curator: { enabled: true, postmortem_enabled: false },
			skill_improver: {
				enabled: false,
				max_calls_per_day: 10,
				trigger: 'manual',
				targets: ['skills', 'spec', 'architect_prompt', 'knowledge'],
				write_mode: 'proposal',
				require_user_approval: true,
				quota_window: 'utc',
				allow_deterministic_fallback: true,
			},
		},
		loadedFromFile: null,
	};
}

// ── Test suites ──────────────────────────────────────────────────────

describe('handleCloseCommand — finalize lock (FR-012)', () => {
	beforeEach(() => {
		testDir = mkdtempSync(path.join(os.tmpdir(), 'close-finalize-lock-test-'));
		mkdirSync(swarmDir(), { recursive: true });

		// Default mocks: lock acquired successfully
		const mockRelease = mock(async () => {});
		closeInternals.acquireFinalizeLock = mock(async () => ({
			acquired: true,
			release: mockRelease,
		}));

		closeInternals.loadPluginConfigWithMeta = () => makeConfig();
		closeInternals.curateAndStoreSwarm = mock(async () => ({ stored: 0 }));
		closeInternals.checkHivePromotions = mock(async () => ({
			new_promotions: 0,
			encounters_incremented: 0,
			advancements: 0,
			total_hive_entries: 0,
		}));
		closeInternals.getGitRepositoryStatus = () => ({
			isRepo: false,
			reason: 'not_git_repo',
			message: 'fatal: not a git repository',
		});
		closeInternals.resetToMainAfterMerge = () => ({
			success: true,
			targetBranch: 'origin/main',
			previousBranch: 'main',
			message: 'Already on main',
			branchDeleted: false,
			warnings: [],
		});
		closeInternals.resetToRemoteBranch = () => ({
			success: true,
			targetBranch: 'main',
			localBranch: 'main',
			message: 'Already aligned with remote',
			alreadyAligned: true,
			prunedBranches: [],
			warnings: [],
		});
		closeInternals.resetSwarmStatePreservingSingletons = () => {};
	});

	afterEach(() => {
		try {
			rmSync(testDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
		closeInternals.acquireFinalizeLock = realAcquireFinalizeLock;
		closeInternals.loadPluginConfigWithMeta = realLoadPluginConfigWithMeta;
		closeInternals.curateAndStoreSwarm = realCurateAndStoreSwarm;
		closeInternals.checkHivePromotions = realCheckHivePromotions;
		closeInternals.getGitRepositoryStatus = realGetGitRepositoryStatus;
		closeInternals.resetToMainAfterMerge = realResetToMainAfterMerge;
		closeInternals.resetToRemoteBranch = realResetToRemoteBranch;
		closeInternals.resetSwarmStatePreservingSingletons =
			realResetSwarmStatePreservingSingletons;
	});

	// ── Test: lock contention ─────────────────────────────────────────

	describe('Lock contention', () => {
		it('returns error string when lock is not acquired', async () => {
			closeInternals.acquireFinalizeLock = mock(async () => ({
				acquired: false,
			}));

			const result = await handleCloseCommand(testDir, []);

			expect(result).toContain('❌');
			expect(result).toContain('Another /swarm finalize is already running');
			expect(result).toContain('wait for the lock to expire');
		});

		it('does not proceed to write plan state when lock is not acquired', async () => {
			closeInternals.acquireFinalizeLock = mock(async () => ({
				acquired: false,
			}));
			writePlan();

			const result = await handleCloseCommand(testDir, []);

			// The error path returns early — plan.json should still exist (not archived)
			const planPath = path.join(swarmDir(), 'plan.json');
			expect(() => {
				// If plan.json was removed, this will throw ENOENT
				// If it still exists, we got the original plan back
			}).not.toThrow();
			// Verify it's still there
			const { existsSync } = await import('node:fs');
			expect(existsSync(planPath)).toBe(true);
		});
	});

	// ── Test: lock release on success ─────────────────────────────────

	describe('Lock release on success', () => {
		it('calls release() exactly once on successful finalize', async () => {
			writePlan();
			const mockRelease = mock(async () => {});

			closeInternals.acquireFinalizeLock = mock(async () => ({
				acquired: true,
				release: mockRelease,
			}));

			await handleCloseCommand(testDir, []);

			expect(mockRelease).toHaveBeenCalledTimes(1);
		});

		it('proceeds with normal finalize output when lock is acquired', async () => {
			writePlan();
			const mockRelease = mock(async () => {});

			closeInternals.acquireFinalizeLock = mock(async () => ({
				acquired: true,
				release: mockRelease,
			}));

			const result = await handleCloseCommand(testDir, []);

			expect(result).toContain('finalized');
			expect(result).not.toContain('❌');
		});
	});

	// ── Test: lock release on error path ──────────────────────────────

	describe('Lock release on error path', () => {
		it('calls release() even when downstream finalize fails', async () => {
			writePlan();
			const mockRelease = mock(async () => {});

			closeInternals.acquireFinalizeLock = mock(async () => ({
				acquired: true,
				release: mockRelease,
			}));

			// Force a downstream failure by making loadPluginConfigWithMeta throw
			closeInternals.loadPluginConfigWithMeta = () => {
				throw new Error('Config load failed');
			};

			// The error should propagate out of handleCloseCommand
			await expect(handleCloseCommand(testDir, [])).rejects.toThrow(
				'Config load failed',
			);

			// release() must still have been called exactly once
			expect(mockRelease).toHaveBeenCalledTimes(1);
		});
	});

	// ── Test: locks dir excluded from active-state cleanup ─────────────

	describe('Active-state cleanup excludes locks', () => {
		it('does not include "locks" in ACTIVE_STATE_DIRS_TO_CLEAN', () => {
			expect(closeInternals.ACTIVE_STATE_DIRS_TO_CLEAN).not.toContain('locks');
		});
	});
});
