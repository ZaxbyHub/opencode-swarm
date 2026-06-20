/**
 * Tests for handleCloseCommand — archive retention config (FR-016).
 *
 * Verifies that archive retention (maxAgeDays, maxBundles) is read from
 * project config (config.evidence.max_age_days / config.evidence.max_bundles)
 * instead of hardcoded defaults, defaulting to 30 days / 10 bundles when absent
 * (backward compat).
 *
 * Uses _internals DI seam for archiveEvidence stubbing (no mock.module).
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ── Import under test ─────────────────────────────────────────────────────
const { handleCloseCommand, _internals: closeInternals } = await import(
	'../../../src/commands/close.js'
);

// ── Save real _internals ──────────────────────────────────────────────────
const realAcquireFinalizeLock = closeInternals.acquireFinalizeLock;
const realLoadPluginConfigWithMeta = closeInternals.loadPluginConfigWithMeta;
const realCurateAndStoreSwarm = closeInternals.curateAndStoreSwarm;
const realCheckHivePromotions = closeInternals.checkHivePromotions;
const realGetGitRepositoryStatus = closeInternals.getGitRepositoryStatus;
const realResetToMainAfterMerge = closeInternals.resetToMainAfterMerge;
const realResetToRemoteBranch = closeInternals.resetToRemoteBranch;
const realResetSwarmStatePreservingSingletons =
	closeInternals.resetSwarmStatePreservingSingletons;
const realArchiveEvidence = closeInternals.archiveEvidence;

// ── Helpers ──────────────────────────────────────────────────────────────

let testDir: string;

function swarmDir(): string {
	return path.join(testDir, '.swarm');
}

function writePlan(overrides: Record<string, unknown> = {}): void {
	const plan = {
		title: 'Archive Config Test Project',
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

function makeConfig(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
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
				targets: ['skills', 'knowledge'],
				write_mode: 'proposal',
				require_user_approval: true,
				quota_window: 'utc',
				allow_deterministic_fallback: true,
			},
			...overrides,
		},
		loadedFromFile: null,
	};
}

beforeEach(() => {
	testDir = mkdtempSync(path.join(os.tmpdir(), 'close-archive-config-test-'));
	mkdirSync(swarmDir(), { recursive: true });

	// Default mocks: lock acquired, config loads, hive disabled, no git repo
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
	closeInternals.archiveEvidence = mock(async () => []);
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
	closeInternals.archiveEvidence = realArchiveEvidence;
});

// ── Tests ────────────────────────────────────────────────────────────────

describe('handleCloseCommand — archive retention config (FR-016)', () => {
	it('reads max_age_days and max_bundles from config.evidence (override)', async () => {
		writePlan();
		let captured: [number, number] | undefined;
		closeInternals.loadPluginConfigWithMeta = () =>
			makeConfig({
				evidence: { max_age_days: 60, max_bundles: 25 },
			});

		closeInternals.archiveEvidence = mock(
			async (_dir: string, age: number, bundles: number) => {
				captured = [age, bundles];
				return [];
			},
		);

		await handleCloseCommand(testDir, []);

		expect(captured).toBeDefined();
		expect(captured![0]).toBe(60);
		expect(captured![1]).toBe(25);
	});

	it('defaults to 30 days / 10 bundles when config.evidence is absent', async () => {
		writePlan();
		let captured: [number, number] | undefined;
		closeInternals.loadPluginConfigWithMeta = () => makeConfig();
		closeInternals.archiveEvidence = mock(
			async (_dir: string, age: number, bundles: number) => {
				captured = [age, bundles];
				return [];
			},
		);

		await handleCloseCommand(testDir, []);

		expect(captured).toBeDefined();
		expect(captured![0]).toBe(30);
		expect(captured![1]).toBe(10);
	});

	it('defaults to 30 days / 10 bundles when config.evidence is empty object', async () => {
		writePlan();
		let captured: [number, number] | undefined;
		closeInternals.loadPluginConfigWithMeta = () =>
			makeConfig({ evidence: {} });
		closeInternals.archiveEvidence = mock(
			async (_dir: string, age: number, bundles: number) => {
				captured = [age, bundles];
				return [];
			},
		);

		await handleCloseCommand(testDir, []);

		expect(captured).toBeDefined();
		expect(captured![0]).toBe(30);
		expect(captured![1]).toBe(10);
	});

	it('passes the test directory as the first argument to archiveEvidence', async () => {
		writePlan();
		let capturedDir: string | undefined;
		closeInternals.loadPluginConfigWithMeta = () =>
			makeConfig({
				evidence: { max_age_days: 60, max_bundles: 25 },
			});
		closeInternals.archiveEvidence = mock(async (dir: string) => {
			capturedDir = dir;
			return [];
		});

		await handleCloseCommand(testDir, []);

		expect(capturedDir).toBe(testDir);
	});
});
