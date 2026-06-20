/**
 * FR-005 Diagnostic Test — close.ts post-mortem error catch.
 *
 * Verifies that when runCuratorPostMortem throws inside handleCloseCommand,
 * the error message is captured in the warnings output and the command
 * still succeeds (fail-open semantics preserved).
 *
 * Uses _internals DI seam from close.ts.
 * No mock.module usage — follows the pattern in close-postmortem-integration.test.ts.
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
		title: 'Post-Mortem Diagnostic Test',
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

describe('handleCloseCommand — post-mortem diagnostic catch (FR-005)', () => {
	beforeEach(() => {
		testDir = mkdtempSync(path.join(os.tmpdir(), 'close-pm-diagnostic-test-'));
		mkdirSync(swarmDir(), { recursive: true });
		writePlan();

		// Stub all non-postmortem internals to isolate the error path
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
			// ignore cleanup errors
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

	// ── Verification 1: Error instance — message is extracted ─────────

	it('when runCuratorPostMortem throws an Error, warnings contain "Post-mortem failed: <message>"', async () => {
		const errorMessage = 'post-mortem provider crashed';
		closeInternals.runCuratorPostMortem = mock(async () => {
			throw new Error(errorMessage);
		});

		const result = await handleCloseCommand(testDir, []);

		// Fail-open: close must still succeed
		expect(result).toContain('finalized');
		// The diagnostic catch must have captured the error message
		expect(result).toContain(`Post-mortem failed: ${errorMessage}`);
	});

	// ── Verification 2: Non-Error thrown — stringified ──────────────

	it('when runCuratorPostMortem throws a non-Error string, warnings contain "Post-mortem failed: <string>"', async () => {
		// String thrown (e.g., a module that throws a plain string)
		closeInternals.runCuratorPostMortem = mock(async () => {
			throw 'plain string error from post-mortem';
		});

		const result = await handleCloseCommand(testDir, []);

		// Fail-open: close must still succeed
		expect(result).toContain('finalized');
		// The non-Error must be stringified
		expect(result).toContain(
			'Post-mortem failed: plain string error from post-mortem',
		);
	});

	// ── Verification 3: null thrown ──────────────────────────────────

	it('when runCuratorPostMortem throws null, warnings contain "Post-mortem failed: null"', async () => {
		closeInternals.runCuratorPostMortem = mock(async () => {
			// eslint-disable-next-line no-throw-literal
			throw null;
		});

		const result = await handleCloseCommand(testDir, []);

		// Fail-open: close must still succeed
		expect(result).toContain('finalized');
		// null becomes the string "null"
		expect(result).toContain('Post-mortem failed: null');
	});

	// ── Verification 4: undefined thrown ────────────────────────────

	it('when runCuratorPostMortem throws undefined, warnings contain "Post-mortem failed: undefined"', async () => {
		closeInternals.runCuratorPostMortem = mock(async () => {
			throw undefined;
		});

		const result = await handleCloseCommand(testDir, []);

		// Fail-open: close must still succeed
		expect(result).toContain('finalized');
		expect(result).toContain('Post-mortem failed: undefined');
	});

	// ── Verification 5: plain object thrown ──────────────────────────

	it('when runCuratorPostMortem throws a plain object, warnings contain "[object Object]"', async () => {
		const thrown = { code: 'PM_FAIL', reason: 'network timeout' };
		closeInternals.runCuratorPostMortem = mock(async () => {
			throw thrown;
		});

		const result = await handleCloseCommand(testDir, []);

		// Fail-open: close must still succeed
		expect(result).toContain('finalized');
		// Plain object stringifies to "[object Object]"
		expect(result).toContain('Post-mortem failed: [object Object]');
	});

	// ── Verification 6: fail-open preserved — close succeeds ────────

	it('close succeeds (fail-open) even when post-mortem throws', async () => {
		closeInternals.runCuratorPostMortem = mock(async () => {
			throw new Error('irreversible catastrophe');
		});

		const result = await handleCloseCommand(testDir, []);

		// The command must not throw — fail-open means post-mortem never blocks finalize
		expect(result).toContain('finalized');
		// Archive stage must still have run (proves we passed finalize and entered archive)
		expect(result).toContain('**Archive:**');
		expect(result).toContain('Archived');
	});

	// ── Verification 7: successful post-mortem — no warning added ──

	it('when post-mortem succeeds, no "Post-mortem failed" warning is added', async () => {
		closeInternals.runCuratorPostMortem = mock(async () => ({
			success: true,
			planId: 'test-plan',
			reportPath: '.swarm/post-mortem/report.md',
			summary: 'Post-mortem summary text',
			warnings: [],
		}));

		const result = await handleCloseCommand(testDir, []);

		expect(result).toContain('finalized');
		// No error warning when post-mortem succeeds
		expect(result).not.toContain('Post-mortem failed:');
		// Post-mortem output is included in the summary
		expect(result).toContain('**Post-Mortem:**');
	});
});
