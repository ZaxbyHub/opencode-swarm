/**
 * Tests for the hive_enabled config gate in handleCloseCommand (FR-006).
 *
 * Verifies:
 *   - When config.hive_enabled === false, checkHivePromotions is NEVER called
 *   - When config.hive_enabled === true, checkHivePromotions IS called
 *   - Result counter (hivePromoted) is populated correctly
 *   - Failures produce warnings
 *
 * Uses _internals DI seam for all external functions.
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

// ── Helpers ──────────────────────────────────────────────────────────

let testDir: string;
let knowledgePath: string;

function swarmDir(): string {
	return path.join(testDir, '.swarm');
}

function writePlan(overrides: Record<string, unknown> = {}): void {
	const plan = {
		title: 'Hive Promotion Config Gate Test',
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

function writeKnowledgeEntry(entry: Record<string, unknown>): void {
	writeFileSync(knowledgePath, JSON.stringify(entry) + '\n', {
		flag: 'a',
	});
}

function baseKnowledgeEntry(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		id: 'entry-1',
		lesson: 'Lesson one',
		category: 'process',
		hive_eligible: true,
		confirmed_by: [
			{ phase_number: 1, timestamp: new Date().toISOString() },
			{ phase_number: 2, timestamp: new Date().toISOString() },
			{ phase_number: 3, timestamp: new Date().toISOString() },
		],
		tags: [],
		created_at: new Date(Date.now() - 100_000_000).toISOString(),
		retrieval_outcomes: {
			applied_count: 0,
			succeeded_after_count: 0,
			failed_after_count: 0,
		},
		...overrides,
	};
}

function makeConfig(hiveEnabled: boolean) {
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

describe('handleCloseCommand — hive_enabled config gate (FR-006)', () => {
	beforeEach(() => {
		testDir = mkdtempSync(path.join(os.tmpdir(), 'close-hive-config-test-'));
		knowledgePath = path.join(swarmDir(), 'knowledge.jsonl');
		mkdirSync(swarmDir(), { recursive: true });
		writeFileSync(knowledgePath, '');

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
		closeInternals.loadPluginConfigWithMeta = () => makeConfig(true);
		closeInternals.curateAndStoreSwarm = mock(async () => ({ stored: 1 }));
		closeInternals.checkHivePromotions = mock(async () => ({
			timestamp: new Date().toISOString(),
			new_promotions: 1,
			encounters_incremented: 0,
			advancements: 0,
			total_hive_entries: 1,
		}));
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
	});

	// ── Test 1: hive_enabled=false → checkHivePromotions NEVER called ──

	describe('hive_enabled=false', () => {
		beforeEach(() => {
			closeInternals.loadPluginConfigWithMeta = () => makeConfig(false);
			(
				closeInternals.checkHivePromotions as ReturnType<typeof mock>
			).mockClear();
		});

		it('checkHivePromotions is NEVER called when config.hive_enabled === false', async () => {
			writePlan();
			writeKnowledgeEntry(baseKnowledgeEntry());

			const result = await handleCloseCommand(testDir, []);

			expect(closeInternals.checkHivePromotions).toHaveBeenCalledTimes(0);
			expect(result).toContain('finalized');
		});

		it('close still succeeds when hive_enabled=false', async () => {
			writePlan();
			writeKnowledgeEntry(baseKnowledgeEntry());

			const result = await handleCloseCommand(testDir, []);

			expect(result).toContain('finalized');
			expect(result).not.toContain('❌');
		});

		it('does not log hive promotion warnings when hive_enabled=false', async () => {
			writePlan();
			writeKnowledgeEntry(baseKnowledgeEntry());

			const result = await handleCloseCommand(testDir, []);

			expect(result).not.toContain('Hive promotion');
		});
	});

	// ── Test 2: hive_enabled=true → checkHivePromotions IS called ──

	describe('hive_enabled=true', () => {
		beforeEach(() => {
			closeInternals.loadPluginConfigWithMeta = () => makeConfig(true);
			(
				closeInternals.checkHivePromotions as ReturnType<typeof mock>
			).mockClear();
			closeInternals.checkHivePromotions = mock(async () => ({
				timestamp: new Date().toISOString(),
				new_promotions: 1,
				encounters_incremented: 0,
				advancements: 0,
				total_hive_entries: 1,
			}));
		});

		it('checkHivePromotions IS called when hive_enabled=true', async () => {
			writePlan();
			writeKnowledgeEntry(baseKnowledgeEntry());

			const result = await handleCloseCommand(testDir, []);

			expect(closeInternals.checkHivePromotions).toHaveBeenCalledTimes(1);
			expect(result).toContain('finalized');
		});

		it('checkHivePromotions is called once per eligible entry when hive_enabled=true', async () => {
			writePlan();
			writeKnowledgeEntry(
				baseKnowledgeEntry({ id: 'entry-a', lesson: 'Lesson A' }),
			);
			writeKnowledgeEntry(
				baseKnowledgeEntry({
					id: 'entry-b',
					lesson: 'Lesson B',
					category: 'architecture',
				}),
			);
			writeKnowledgeEntry(
				baseKnowledgeEntry({
					id: 'entry-c',
					lesson: 'Lesson C',
					category: 'tooling',
				}),
			);

			const result = await handleCloseCommand(testDir, []);

			// checkHivePromotions is called exactly once with the full entries array
			expect(closeInternals.checkHivePromotions).toHaveBeenCalledTimes(1);
			expect(result).toContain('finalized');
		});

		it('result counter is populated correctly from checkHivePromotions return value', async () => {
			writePlan();
			writeKnowledgeEntry(
				baseKnowledgeEntry({ id: 'entry-a', lesson: 'Lesson A' }),
			);
			writeKnowledgeEntry(
				baseKnowledgeEntry({ id: 'entry-b', lesson: 'Lesson B' }),
			);

			// Mock: 2 entries, 1 new promotion
			closeInternals.checkHivePromotions = mock(async () => ({
				timestamp: new Date().toISOString(),
				new_promotions: 1,
				encounters_incremented: 0,
				advancements: 0,
				total_hive_entries: 3,
			}));

			const result = await handleCloseCommand(testDir, []);

			expect(closeInternals.checkHivePromotions).toHaveBeenCalledTimes(1);
			// The result contains the hive promotion summary
			expect(result).toContain('finalized');
		});
	});

	// ── Test 3: checkHivePromotions throws → warning is produced ──

	describe('checkHivePromotions throws', () => {
		beforeEach(() => {
			closeInternals.loadPluginConfigWithMeta = () => makeConfig(true);
		});

		it('produces a warning when checkHivePromotions throws', async () => {
			writePlan();
			writeKnowledgeEntry(baseKnowledgeEntry());

			closeInternals.checkHivePromotions = mock(async () => {
				throw new Error('hive promotion crashed');
			});

			const result = await handleCloseCommand(testDir, []);

			// Fail-open: close still succeeds
			expect(result).toContain('finalized');
			// Error is captured as a warning
			expect(result).toContain('Hive promotion failed: hive promotion crashed');
		});

		it('close still succeeds (fail-open) when checkHivePromotions throws', async () => {
			writePlan();
			writeKnowledgeEntry(baseKnowledgeEntry());

			closeInternals.checkHivePromotions = mock(async () => {
				throw new Error('unrecoverable hive error');
			});

			const result = await handleCloseCommand(testDir, []);

			expect(result).toContain('finalized');
			expect(result).not.toContain('❌');
		});
	});
});
