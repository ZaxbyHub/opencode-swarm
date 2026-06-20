/**
 * Tests for handleCloseCommand — planData snapshot/restore (FR-014/SC-013).
 *
 * Verifies that when closePlanTerminalState fails, in-memory planData is
 * restored to its pre-mutation snapshot (no silent divergence from on-disk)
 * and fail-open is preserved.
 *
 * Uses _internals DI seam for closePlanTerminalState stubbing (no mock.module).
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import * as fsSync from 'node:fs';
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
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
const realClosePlanTerminalState = closeInternals.closePlanTerminalState;

// ── Helpers ──────────────────────────────────────────────────────────────

let testDir: string;

function swarmDir(): string {
	return path.join(testDir, '.swarm');
}

function writePlan(overrides: Record<string, unknown> = {}): void {
	const plan = {
		title: 'Snapshot Test Project',
		swarm: 'test-swarm',
		schema_version: '1.0.0',
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'Phase 1',
				status: 'in_progress',
				tasks: [
					{ id: '1.1', phase: 1, status: 'in_progress', description: 'Task A' },
					{ id: '1.2', phase: 1, status: 'completed', description: 'Task B' },
				],
			},
		],
		...overrides,
	};
	writeFileSync(path.join(swarmDir(), 'plan.json'), JSON.stringify(plan));
}

function writePendingPlan(): void {
	const plan = {
		title: 'Snapshot Test Project',
		swarm: 'test-swarm',
		schema_version: '1.0.0',
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'Phase 1',
				status: 'pending',
				tasks: [
					{ id: '1.1', phase: 1, status: 'pending', description: 'Task A' },
					{ id: '1.2', phase: 1, status: 'pending', description: 'Task B' },
				],
			},
		],
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
				targets: ['skills', 'knowledge'],
				write_mode: 'proposal',
				require_user_approval: true,
				quota_window: 'utc',
				allow_deterministic_fallback: true,
			},
		},
		loadedFromFile: null,
	};
}

beforeEach(() => {
	testDir = mkdtempSync(path.join(os.tmpdir(), 'close-snapshot-test-'));
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

	// Default: closePlanTerminalState is a no-op (success path). Tests that
	// need failure override this in the test body.
	closeInternals.closePlanTerminalState = mock(async () => {});
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
	closeInternals.closePlanTerminalState = realClosePlanTerminalState;
});

// ── Test: success path ────────────────────────────────────────────────────

describe('planData snapshot — success path', () => {
	it('returns normal close output when closePlanTerminalState succeeds', async () => {
		writePlan();
		const result = await handleCloseCommand(testDir, []);

		expect(result).toContain('finalized');
		expect(result).not.toContain('❌');
	});
});

// ── Test: failure path — snapshot restore + fail-open ─────────────────────

describe('planData snapshot — failure path (FR-014/SC-013)', () => {
	it('restores planData on closePlanTerminalState failure and emits warning', async () => {
		writePlan();

		const persistError = new Error('disk full during terminal write');
		closeInternals.closePlanTerminalState = mock(async () => {
			throw persistError;
		});

		const result = await handleCloseCommand(testDir, []);

		// Fail-open preserved: handleCloseCommand succeeds despite the throw
		expect(result).toContain('finalized');
		expect(result).not.toContain('❌');

		// Warning emitted
		expect(result).toContain('Failed to persist terminal plan state');

		// plan.json on disk is unchanged (write never happened — the failure
		// happens before any terminal-state write). The close command archives
		// plan.json during cleanup, so we check the archived copy to verify the
		// original on-disk state was preserved.
		const archiveParent = path.join(swarmDir(), 'archive');
		const archiveSubdirs = fsSync
			.readdirSync(archiveParent)
			.filter((f) =>
				fsSync.statSync(path.join(archiveParent, f)).isDirectory(),
			);
		expect(archiveSubdirs.length).toBeGreaterThan(0);
		const archivedPlanPath = path.join(
			archiveParent,
			archiveSubdirs[0]!,
			'plan.json',
		);
		const diskPlan = JSON.parse(
			readFileSync(archivedPlanPath, 'utf-8'),
		) as Record<string, unknown>;

		// Phase should still be in_progress (original pre-mutation state)
		const phase = (diskPlan.phases as Array<Record<string, unknown>>)[0];
		expect(phase.status).toBe('in_progress');
		expect((phase.tasks as Array<Record<string, unknown>>)[0].status).toBe(
			'in_progress',
		);
	});

	it('summary reflects rollback (not mutation) after failed terminal write', async () => {
		writePendingPlan();

		const persistError = new Error('terminal write failed');
		closeInternals.closePlanTerminalState = mock(async () => {
			throw persistError;
		});

		const result = await handleCloseCommand(testDir, []);

		// Fail-open preserved
		expect(result).toContain('finalized');

		// Warning emitted
		expect(result).toContain('Failed to persist terminal plan state');

		// SC-013 rollback assertion: after closePlanTerminalState throws,
		// ctx.closedPhases/closedTasks must be rolled back to pre-mutation
		// lengths so the summary does NOT falsely claim closures occurred.
		// With 'pending' plan: retro adds nothing (not in_progress), so
		// guaranteeAllPlansComplete adds Phase 1, then rollback restores
		// closedPhases to 0. Summary shows "0 phase(s) closed" (rolled back).
		// Without rollback it would show "1 phase(s) closed" (bug: mutation
		// persisted in memory despite on-disk failure).
		expect(result).not.toContain('1 phase(s) closed');
		expect(result).toContain('0 phase(s) closed');
	});
});
