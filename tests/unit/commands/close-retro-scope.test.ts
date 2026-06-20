/**
 * Tests for handleCloseCommand retro-lesson dedup (FR-015).
 *
 * Verifies that retro lessons already committed in the knowledge store are
 * excluded from re-curation at close time, while new lessons still pass
 * through. Fail-open is preserved when the knowledge store is unreadable.
 *
 * Uses _internals DI seam (no mock.module).
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

// ── Helpers ──────────────────────────────────────────────────────────────

let testDir: string;

function swarmDir(): string {
	return path.join(testDir, '.swarm');
}

function writePlan(overrides: Record<string, unknown> = {}): void {
	const plan = {
		title: 'Retro Scope Test Project',
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

function writeRetroEvidence(
	lessons_learned: string[],
	retroName = 'retro-1',
): void {
	const evidenceDir = path.join(swarmDir(), 'evidence', retroName);
	mkdirSync(evidenceDir, { recursive: true });
	const evidence = {
		phase: 1,
		lessons_learned,
	};
	writeFileSync(
		path.join(evidenceDir, 'evidence.json'),
		JSON.stringify(evidence),
	);
}

function writeKnowledgeEntry(lesson: string): void {
	const entry = {
		id: '00000000-0000-0000-0000-000000000001',
		tier: 'swarm',
		lesson,
		category: 'process',
		tags: [],
		scope: 'global',
		confidence: 0.9,
		status: 'established',
		confirmed_by: [],
		retrieval_outcomes: {
			applied_count: 0,
			succeeded_after_count: 0,
			failed_after_count: 0,
			shown_count: 0,
			acknowledged_count: 0,
			applied_explicit_count: 0,
			ignored_count: 0,
			violated_count: 0,
			contradicted_count: 0,
			succeeded_after_shown_count: 0,
			failed_after_shown_count: 0,
		},
		schema_version: 2,
		created_at: new Date().toISOString(),
		updated_at: new Date().toISOString(),
		project_name: 'Retro Scope Test Project',
	};
	writeFileSync(
		path.join(swarmDir(), 'knowledge.jsonl'),
		JSON.stringify(entry) + '\n',
	);
}

function makeCapturingCurateMock() {
	let capturedLessons: string[] | undefined;
	const capture = mock(async (lessons: string[]) => {
		capturedLessons = lessons;
		return { stored: lessons.length };
	});
	return {
		capture,
		getCaptured: () => capturedLessons,
	};
}

beforeEach(() => {
	testDir = mkdtempSync(path.join(os.tmpdir(), 'close-retro-scope-test-'));
	mkdirSync(swarmDir(), { recursive: true });

	// Default mocks: lock acquired, config loads, hive disabled, no git repo
	const mockRelease = mock(async () => {});
	closeInternals.acquireFinalizeLock = mock(async () => ({
		acquired: true,
		release: mockRelease,
	}));

	closeInternals.loadPluginConfigWithMeta = () => makeConfig();
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

// ── Tests ────────────────────────────────────────────────────────────────

describe('handleCloseCommand — retro-lesson dedup (FR-015)', () => {
	it('dedupes retro lessons already committed in the knowledge store', async () => {
		writePlan();
		writeKnowledgeEntry('Already committed lesson');
		writeRetroEvidence([
			'Already committed lesson',
			'New lesson from this session',
		]);

		const { capture, getCaptured } = makeCapturingCurateMock();
		closeInternals.curateAndStoreSwarm = capture;

		await handleCloseCommand(testDir, []);

		const lessons = getCaptured();
		expect(lessons).toBeDefined();
		expect(lessons).toContain('New lesson from this session');
		expect(lessons).not.toContain('Already committed lesson');
	});

	it('passes through all retro lessons when knowledge.jsonl is absent (fail-open)', async () => {
		writePlan();
		writeRetroEvidence([
			'Already committed lesson',
			'New lesson from this session',
		]);
		// knowledge.jsonl intentionally absent

		const { capture, getCaptured } = makeCapturingCurateMock();
		closeInternals.curateAndStoreSwarm = capture;

		await handleCloseCommand(testDir, []);

		const lessons = getCaptured();
		expect(lessons).toBeDefined();
		expect(lessons).toContain('Already committed lesson');
		expect(lessons).toContain('New lesson from this session');
	});

	it('dedupes case-insensitively against the knowledge store', async () => {
		writePlan();
		writeKnowledgeEntry('Already committed lesson');
		writeRetroEvidence([
			'ALREADY COMMITTED LESSON',
			'New lesson from this session',
		]);

		const { capture, getCaptured } = makeCapturingCurateMock();
		closeInternals.curateAndStoreSwarm = capture;

		await handleCloseCommand(testDir, []);

		const lessons = getCaptured();
		expect(lessons).toBeDefined();
		expect(lessons).toContain('New lesson from this session');
		expect(lessons).not.toContain('ALREADY COMMITTED LESSON');
	});
});
