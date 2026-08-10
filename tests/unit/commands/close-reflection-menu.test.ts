/**
 * Issue #2077 — handleCloseCommand action-menu wiring.
 *
 * Verifies AC-3 (finalize output ends with a numbered action menu) and
 * AC-4 (under full-auto the menu is reported-only, no prompt) at the
 * command level — i.e. that close.ts actually renders the signals block
 * and the menu into the return string, not just that buildActionMenu
 * works in isolation.
 *
 * Uses _internals DI seam. No mock.module usage.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

// ── Import under test ────────────────────────────────────────────────
const { handleCloseCommand, _internals: closeInternals } = await import(
	'../../../src/commands/close.js'
);
// Import the reflection _internals so we can inject the gather fns.
const { _internals: reflectionInternals } = await import(
	'../../../src/services/session-reflection.js'
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
const realDetectFullAuto = closeInternals.detectFullAuto;
const realGatherSkillViolations = reflectionInternals.gatherSkillViolations;
const realGatherContradictionCandidates =
	reflectionInternals.gatherContradictionCandidates;
const realGatherRealtimeAdmissionCounts =
	reflectionInternals.gatherRealtimeAdmissionCounts;

let testDir: string;

function swarmDir(): string {
	return path.join(testDir, '.swarm');
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

function installDefaultMocks(): void {
	const mockRelease = mock(async () => {});
	closeInternals.acquireFinalizeLock = mock(async () => ({
		acquired: true,
		release: mockRelease,
	}));
	closeInternals.loadPluginConfigWithMeta = () => makeConfig();
	closeInternals.curateAndStoreSwarm = mock(async () => ({
		stored: 0,
		reinforced: 0,
		skipped: 0,
		rejected: 0,
		quarantined: 0,
	}));
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
	// Default: not full-auto.
	closeInternals.detectFullAuto = () => false;
	// Default gatherers: empty (clean session).
	reflectionInternals.gatherSkillViolations = () => [];
	reflectionInternals.gatherContradictionCandidates = async () => [];
	reflectionInternals.gatherRealtimeAdmissionCounts = async () => undefined;
}

function restoreInternals(): void {
	closeInternals.acquireFinalizeLock = realAcquireFinalizeLock;
	closeInternals.loadPluginConfigWithMeta = realLoadPluginConfigWithMeta;
	closeInternals.curateAndStoreSwarm = realCurateAndStoreSwarm;
	closeInternals.checkHivePromotions = realCheckHivePromotions;
	closeInternals.getGitRepositoryStatus = realGetGitRepositoryStatus;
	closeInternals.resetToMainAfterMerge = realResetToMainAfterMerge;
	closeInternals.resetToRemoteBranch = realResetToRemoteBranch;
	closeInternals.resetSwarmStatePreservingSingletons =
		realResetSwarmStatePreservingSingletons;
	closeInternals.detectFullAuto = realDetectFullAuto;
	reflectionInternals.gatherSkillViolations = realGatherSkillViolations;
	reflectionInternals.gatherContradictionCandidates =
		realGatherContradictionCandidates;
	reflectionInternals.gatherRealtimeAdmissionCounts =
		realGatherRealtimeAdmissionCounts;
}

describe('handleCloseCommand — session-reflection action menu (#2077)', () => {
	beforeEach(() => {
		testDir = canonicalMkdtemp('close-reflection-menu-');
		mkdirSync(swarmDir(), { recursive: true });
		installDefaultMocks();
	});

	afterEach(() => {
		try {
			rmSync(testDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
		restoreInternals();
	});

	it('surfaces the Knowledge Delta signals block even in a clean session (NOOP line)', async () => {
		const result = await handleCloseCommand(testDir, []);
		// The signals block renders unconditionally — the "0 captured; 0 deduped"
		// line must appear even when nothing happened (issue #2077 signal class 4).
		expect(result).toContain('## Session Signals');
		expect(result).toContain('Knowledge Delta');
	});

	it('renders a numbered action menu when proposals exist (AC-3)', async () => {
		// Inject a contradiction candidate so buildActionProposals produces a
		// supersede proposal, which surfaces as a numbered menu item.
		reflectionInternals.gatherContradictionCandidates = async () => [
			{
				newLesson: 'always lock the file before writing data to it',
				newEntryId: 'n1',
				conflictsWithId: 'o1',
				conflictsWithLesson: 'never lock the file before writing data',
				similarity: 0.5,
			},
		];
		const result = await handleCloseCommand(testDir, []);
		expect(result).toContain('**Proposed actions**');
		expect(result).toContain('[1]');
		expect(result).toContain('SUPERSEDE');
		expect(result).toContain('/swarm curate');
		// Not full-auto → the reply prompt is present.
		expect(result).toContain('reply with numbers');
	});

	it('suppresses the reply prompt under full-auto (AC-4)', async () => {
		closeInternals.detectFullAuto = () => true;
		reflectionInternals.gatherContradictionCandidates = async () => [
			{
				newLesson: 'always lock the file before writing data to it',
				newEntryId: 'n1',
				conflictsWithId: 'o1',
				conflictsWithLesson: 'never lock the file before writing data',
				similarity: 0.5,
			},
		];
		// sessionID must be passed via the options parameter (3rd arg) so
		// ctx.fullAuto is computed (it is guarded by options.sessionID).
		const result = await handleCloseCommand(testDir, [], {
			sessionID: 's1',
		});
		expect(result).toContain('**Proposed actions**');
		// Full-auto → reported-only, NO "reply with numbers" prompt.
		expect(result).not.toContain('reply with numbers');
		expect(result.toLowerCase()).toContain('reported-only');
	});

	it('does not render a menu when there are no proposals', async () => {
		// Clean session, no gate failures, no tool problems, no contradictions.
		const result = await handleCloseCommand(testDir, []);
		expect(result).not.toContain('**Proposed actions**');
	});
});
