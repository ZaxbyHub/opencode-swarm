/**
 * FR-001 Integration Test — close.ts post-mortem integration.
 *
 * Verifies that handleCloseCommand correctly integrates the post-mortem
 * workflow:
 *   - When curator.postmortem_enabled=true, _internals.runCuratorPostMortem IS called
 *     and the postMortemSummary appears in the close output
 *   - When curator.postmortem_enabled=false, runCuratorPostMortem is NOT called
 *   - When the post-mortem throws, the diagnostic warning appears in output (FR-005)
 *
 * Uses _internals DI seam from close.ts and post-mortem.ts.
 * No mock.module usage.
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

const realGetGitRepositoryStatus = closeInternals.getGitRepositoryStatus;
const realResetToMainAfterMerge = closeInternals.resetToMainAfterMerge;
const realResetToRemoteBranch = closeInternals.resetToRemoteBranch;
const realResetSwarmStatePreservingSingletons =
	closeInternals.resetSwarmStatePreservingSingletons;
const realLoadPluginConfigWithMeta = closeInternals.loadPluginConfigWithMeta;
const realCurateAndStoreSwarm = closeInternals.curateAndStoreSwarm;
const realCheckHivePromotions = closeInternals.checkHivePromotions;
const realRunCuratorPostMortem = closeInternals.runCuratorPostMortem;
const realCreateCuratorLLMDelegate = closeInternals.createCuratorLLMDelegate;

// ── Helpers ──────────────────────────────────────────────────────────

let testDir: string;

function swarmDir(): string {
	return path.join(testDir, '.swarm');
}

function writePlan(overrides: Record<string, unknown> = {}): void {
	const plan = {
		title: 'Post-Mortem Integration Test',
		schema_version: '1.0.0',
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'Phase 1',
				status: 'complete',
				tasks: [{ id: '1.1', status: 'complete', description: 'Task A' }],
			},
		],
		...overrides,
	};
	writeFileSync(path.join(swarmDir(), 'plan.json'), JSON.stringify(plan));
}

function makeConfig(
	postmortemEnabled: boolean,
	hiveEnabled = false,
): Record<string, unknown> {
	return {
		config: {
			knowledge: {
				enabled: true,
				hive_enabled: hiveEnabled,
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
			curator: {
				enabled: true,
				postmortem_enabled: postmortemEnabled,
			},
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

describe('handleCloseCommand — post-mortem integration (FR-001)', () => {
	beforeEach(() => {
		testDir = mkdtempSync(
			path.join(os.tmpdir(), 'close-postmortem-integ-test-'),
		);
		mkdirSync(swarmDir(), { recursive: true });
		writePlan();

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
		closeInternals.curateAndStoreSwarm = mock(async () => ({ stored: 0 }));
		closeInternals.checkHivePromotions = mock(async () => ({
			timestamp: new Date().toISOString(),
			new_promotions: 0,
			encounters_incremented: 0,
			advancements: 0,
			total_hive_entries: 0,
		}));
		closeInternals.createCuratorLLMDelegate = mock(
			() => async () => 'mocked LLM',
		);
	});

	afterEach(() => {
		try {
			rmSync(testDir, { recursive: true, force: true });
		} catch {
			// ignore
		}
		closeInternals.getGitRepositoryStatus = realGetGitRepositoryStatus;
		closeInternals.resetToMainAfterMerge = realResetToMainAfterMerge;
		closeInternals.resetToRemoteBranch = realResetToRemoteBranch;
		closeInternals.resetSwarmStatePreservingSingletons =
			realResetSwarmStatePreservingSingletons;
		closeInternals.loadPluginConfigWithMeta = realLoadPluginConfigWithMeta;
		closeInternals.curateAndStoreSwarm = realCurateAndStoreSwarm;
		closeInternals.checkHivePromotions = realCheckHivePromotions;
		closeInternals.runCuratorPostMortem = realRunCuratorPostMortem;
		closeInternals.createCuratorLLMDelegate = realCreateCuratorLLMDelegate;
	});

	// ── Test 1: postmortem_enabled=true → runCuratorPostMortem IS called ─────

	describe('postmortem_enabled=true', () => {
		beforeEach(() => {
			closeInternals.loadPluginConfigWithMeta = () => makeConfig(true);
			closeInternals.runCuratorPostMortem = mock(async () => ({
				success: true,
				planId: 'test-plan',
				reportPath: null,
				summary: 'Post-mortem summary for integration test.',
				warnings: [],
			}));
		});

		it('calls runCuratorPostMortem when postmortem_enabled=true', async () => {
			const result = await handleCloseCommand(testDir, []);

			expect(closeInternals.runCuratorPostMortem).toHaveBeenCalledTimes(1);
			expect(result).toContain('finalized');
		});

		it('includes postMortemSummary in close output when postmortem succeeds', async () => {
			closeInternals.runCuratorPostMortem = mock(async () => ({
				success: true,
				planId: 'test-plan',
				reportPath: null,
				summary: 'Post-mortem summary for integration test.',
				warnings: [],
			}));

			const result = await handleCloseCommand(testDir, []);

			expect(result).toContain('**Post-Mortem:**');
			expect(result).toContain('Post-mortem summary for integration test.');
		});
	});

	// ── Test 2: postmortem_enabled=false → runCuratorPostMortem NOT called ─────

	describe('postmortem_enabled=false', () => {
		beforeEach(() => {
			closeInternals.loadPluginConfigWithMeta = () => makeConfig(false);
			closeInternals.runCuratorPostMortem = mock(async () => ({
				success: true,
				planId: 'test-plan',
				reportPath: null,
				summary: 'Should not appear.',
				warnings: [],
			}));
		});

		it('does NOT call runCuratorPostMortem when postmortem_enabled=false', async () => {
			const result = await handleCloseCommand(testDir, []);

			expect(closeInternals.runCuratorPostMortem).not.toHaveBeenCalled();
			expect(result).not.toContain('**Post-Mortem:**');
			expect(result).toContain('finalized');
		});
	});

	// ── Test 3: post-mortem throws → diagnostic warning appears (FR-005) ─────

	describe('post-mortem throws → diagnostic warning', () => {
		beforeEach(() => {
			closeInternals.loadPluginConfigWithMeta = () => makeConfig(true);
			closeInternals.runCuratorPostMortem = mock(async () => {
				throw new Error('Simulated post-mortem failure');
			});
		});

		it('includes Post-mortem failed diagnostic warning when runCuratorPostMortem throws', async () => {
			const result = await handleCloseCommand(testDir, []);

			expect(result).toContain('Post-mortem failed:');
			expect(result).toContain('Simulated post-mortem failure');
			expect(result).toContain('finalized'); // still succeeds (fail-open)
		});

		it('does not include Post-Mortem section when post-mortem throws', async () => {
			const result = await handleCloseCommand(testDir, []);

			expect(result).not.toContain('**Post-Mortem:**');
		});
	});
});
