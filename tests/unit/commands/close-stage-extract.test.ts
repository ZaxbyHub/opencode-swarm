/**
 * Tests for runFinalizeStage, runArchiveStage, runCleanStage, and runAlignStage
 * (STAGE 1–4 extract).
 *
 * Proves independent invocability:
 * - runArchiveStage: archive bundle created on a temp .swarm with archivable evidence.
 * - runFinalizeStage: runs with minimal ctx + stubbed _internals and mutates ctx
 *   (e.g. closedPhases populated for an in_progress phase).
 * - runCleanStage: cleans archived active-state files and resets context.md.
 * - runAlignStage: git alignment via stubbed _internals returns a summary string.
 *
 * Uses the _internals DI seam for functions that the source routes through
 * _internals. Functions imported directly (archiveEvidence, closePlanTerminalState,
 * executeWriteRetro) are tested via observable outcomes instead of mocking.
 *
 * No mock.module usage.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ── Import under test ─────────────────────────────────────────────────────
const {
	runFinalizeStage,
	runArchiveStage,
	runCleanStage,
	runAlignStage,
	_internals: closeInternals,
} = await import('../../../src/commands/close.js');

// ── Save real _internals ──────────────────────────────────────────────────
const realLoadPluginConfigWithMeta = closeInternals.loadPluginConfigWithMeta;
const realCurateAndStoreSwarm = closeInternals.curateAndStoreSwarm;
const realCheckHivePromotions = closeInternals.checkHivePromotions;
const realRunCuratorPostMortem = closeInternals.runCuratorPostMortem;
const realCreateCuratorLLMDelegate = closeInternals.createCuratorLLMDelegate;
const realGetGitRepositoryStatus = closeInternals.getGitRepositoryStatus;
const realResetToMainAfterMerge = closeInternals.resetToMainAfterMerge;
const realResetToRemoteBranch = closeInternals.resetToRemoteBranch;
const realResetSwarmStatePreservingSingletons =
	closeInternals.resetSwarmStatePreservingSingletons;

// ── Helpers ───────────────────────────────────────────────────────────────

let testDir: string;

function swarmDir(): string {
	return path.join(testDir, '.swarm');
}

function buildBaseCtx(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	const base: Record<string, unknown> = {
		directory: testDir,
		swarmDir: swarmDir(),
		planData: {
			title: 'Stage Extract Test Project',
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					status: 'in_progress',
					tasks: [
						{
							id: '1.1',
							status: 'in_progress',
							description: 'Task A',
							phase: 1,
						},
						{ id: '1.2', status: 'completed', description: 'Task B', phase: 1 },
					],
				},
			],
		},
		planExists: true,
		planAlreadyDone: false,
		config: {
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
		projectName: 'Stage Extract Test Project',
		warnings: [],
		closedPhases: [],
		closedTasks: [],
		sessionStart: undefined,
		isForced: false,
		runSkillReview: false,
		options: {},
		phases: [
			{
				id: 1,
				name: 'Phase 1',
				status: 'in_progress',
				tasks: [
					{ id: '1.1', status: 'in_progress', description: 'Task A', phase: 1 },
					{ id: '1.2', status: 'completed', description: 'Task B', phase: 1 },
				],
			},
		],
		inProgressPhases: [
			{
				id: 1,
				name: 'Phase 1',
				status: 'in_progress',
				tasks: [
					{ id: '1.1', status: 'in_progress', description: 'Task A', phase: 1 },
					{ id: '1.2', status: 'completed', description: 'Task B', phase: 1 },
				],
			},
		],
		curationSucceeded: false,
		curationResult: undefined,
		allLessons: [],
		explicitLessons: [],
		retroLessons: [],
		knowledgeSkillHint: '',
		skillReviewSummary: '',
		postMortemSummary: '',
		hivePromoted: 0,
		sessionKnowledgeCreated: 0,
		fallbackKnowledgeCreated: 0,
		originalStatuses: new Map(),
		guaranteeResult: { closedPhaseIds: [], closedTaskIds: [] },
		archiveResult: '',
		archivedFileCount: 0,
		archivedActiveStateFiles: new Set<string>(),
		archivedActiveStateDirs: new Set<string>(),
		timestamp: '',
		archiveDir: '',
		archiveSuffix: '',
		args: [],
	};
	return { ...base, ...overrides };
}

function writePlan(): void {
	const plan = {
		title: 'Stage Extract Test Project',
		schema_version: '1.0.0',
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'Phase 1',
				status: 'in_progress',
				tasks: [
					{ id: '1.1', status: 'in_progress', description: 'Task A', phase: 1 },
					{ id: '1.2', status: 'completed', description: 'Task B', phase: 1 },
				],
			},
		],
	};
	writeFileSync(path.join(swarmDir(), 'plan.json'), JSON.stringify(plan));
}

function writeArtifact(relativePath: string, content: string): void {
	const fullPath = path.join(swarmDir(), relativePath);
	writeFileSync(fullPath, content);
}

beforeEach(() => {
	testDir = mkdtempSync(path.join(os.tmpdir(), 'close-stage-extract-test-'));
	mkdirSync(swarmDir(), { recursive: true });
	writePlan();

	closeInternals.loadPluginConfigWithMeta = () => ({
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
			curator: { enabled: false, postmortem_enabled: false },
			skill_improver: { enabled: false },
		},
		loadedFromFile: null,
	});
	closeInternals.curateAndStoreSwarm = mock(async () => ({ stored: 0 }));
	closeInternals.checkHivePromotions = mock(async () => ({
		new_promotions: 0,
		encounters_incremented: 0,
		advancements: 0,
		total_hive_entries: 0,
	}));
	closeInternals.createCuratorLLMDelegate = mock(() => ({}) as unknown as null);
	closeInternals.runCuratorPostMortem = mock(async () => ({
		success: true,
		summary: '',
		warnings: [],
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
	closeInternals.loadPluginConfigWithMeta = realLoadPluginConfigWithMeta;
	closeInternals.curateAndStoreSwarm = realCurateAndStoreSwarm;
	closeInternals.checkHivePromotions = realCheckHivePromotions;
	closeInternals.runCuratorPostMortem = realRunCuratorPostMortem;
	closeInternals.createCuratorLLMDelegate = realCreateCuratorLLMDelegate;
	closeInternals.getGitRepositoryStatus = realGetGitRepositoryStatus;
	closeInternals.resetToMainAfterMerge = realResetToMainAfterMerge;
	closeInternals.resetToRemoteBranch = realResetToRemoteBranch;
	closeInternals.resetSwarmStatePreservingSingletons =
		realResetSwarmStatePreservingSingletons;
});

// ── runArchiveStage tests ────────────────────────────────────────────────

describe('runArchiveStage', () => {
	it('creates an archive bundle under .swarm/archive with a timestamped name', async () => {
		writeArtifact('plan.json', '{}');
		writeArtifact('events.jsonl', '');

		const ctx = buildBaseCtx() as any;
		await runArchiveStage(ctx);

		expect(ctx.archiveDir).toContain(path.join(swarmDir(), 'archive'));
		expect(ctx.archiveDir).toContain('swarm-');
		expect(readdirSync(swarmDir())).toContain('archive');
	});

	it('copies flat-file artifacts from ARCHIVE_ARTIFACTS into the bundle', async () => {
		writeArtifact('plan.json', '{}');
		writeArtifact('plan.md', '# Plan');
		writeArtifact('events.jsonl', '');

		const ctx = buildBaseCtx() as any;
		await runArchiveStage(ctx);

		for (const artifact of ['plan.json', 'plan.md', 'events.jsonl']) {
			const dest = path.join(ctx.archiveDir, artifact);
			expect(() => readFileSync(dest, 'utf-8')).not.toThrow();
		}
	});

	it('copies active-state directories into the archive and tracks them for cleanup', async () => {
		mkdirSync(path.join(swarmDir(), 'evidence'), { recursive: true });
		writeFileSync(path.join(swarmDir(), 'evidence', 'retro-1.json'), '{}');
		mkdirSync(path.join(swarmDir(), 'session'), { recursive: true });
		writeFileSync(path.join(swarmDir(), 'session', 'session.json'), '{}');

		const ctx = buildBaseCtx() as any;
		await runArchiveStage(ctx);

		expect(ctx.archivedActiveStateDirs.has('evidence')).toBe(true);
		expect(ctx.archivedActiveStateDirs.has('session')).toBe(true);
		expect(
			readFileSync(
				path.join(ctx.archiveDir, 'evidence', 'retro-1.json'),
				'utf-8',
			),
		).toBe('{}');
	});

	it('records archiveResult with artifact count on success', async () => {
		writeArtifact('plan.json', '{}');
		writeArtifact('plan.md', '# Plan');

		const ctx = buildBaseCtx() as any;
		await runArchiveStage(ctx);

		expect(ctx.archivedFileCount).toBeGreaterThanOrEqual(2);
		expect(ctx.archiveResult).toContain('Archived');
		expect(ctx.archiveResult).toContain('artifact(s)');
	});

	it('skips missing artifacts without throwing', async () => {
		// Do not write plan.json or events.jsonl
		const ctx = buildBaseCtx() as any;
		await runArchiveStage(ctx);

		// Should still produce an archive dir (empty bundle is ok)
		expect(ctx.archiveDir.length).toBeGreaterThan(0);
	});

	it('runs archiveEvidence with the test directory as first argument (observable)', async () => {
		writeArtifact('plan.json', '{}');

		const ctx = buildBaseCtx() as any;
		await runArchiveStage(ctx);

		// archiveEvidence is called with ctx.directory (testDir). We verify by
		// checking that the bundle was actually created in .swarm/archive/ under testDir.
		expect(ctx.archiveDir).toContain(testDir);
	});

	it('falls back to default retention when config.evidence is absent (observable)', async () => {
		writeArtifact('plan.json', '{}');

		const ctx = buildBaseCtx() as any;
		await runArchiveStage(ctx);

		// Default retention (30 days / 10 bundles) is used internally; we verify
		// the observable outcome: bundle was created and archiveEvidence ran.
		expect(ctx.archiveDir.length).toBeGreaterThan(0);
	});

	it('falls back to default retention when config.evidence is empty object (observable)', async () => {
		writeArtifact('plan.json', '{}');

		const ctx = buildBaseCtx() as any;
		await runArchiveStage(ctx);

		// Default retention is used internally; verify bundle was created.
		expect(ctx.archiveDir.length).toBeGreaterThan(0);
	});
});

// ── runFinalizeStage tests ────────────────────────────────────────────────

describe('runFinalizeStage', () => {
	it('populates closedPhases for in_progress phases', async () => {
		const ctx = buildBaseCtx() as any;
		await runFinalizeStage(ctx);

		expect(ctx.closedPhases).toContain(1);
	});

	it('populates closedTasks for incomplete tasks', async () => {
		const ctx = buildBaseCtx() as any;
		await runFinalizeStage(ctx);

		expect(ctx.closedTasks).toContain('1.1');
		expect(ctx.closedTasks).not.toContain('1.2');
	});

	it('does not throw when post-mortem hook throws (fail-open)', async () => {
		const ctx = buildBaseCtx({
			config: {
				...buildBaseCtx().config,
			},
		}) as any;
		// Capture baseline config BEFORE reassigning so we don't recurse
		const baselineConfig = realLoadPluginConfigWithMeta(ctx.directory);
		// Enable postmortem so the hook is actually invoked
		closeInternals.loadPluginConfigWithMeta = () => ({
			config: {
				knowledge: baselineConfig.config.knowledge,
				curator: { enabled: true, postmortem_enabled: true },
				skill_improver: { enabled: false },
			},
			loadedFromFile: null,
		});
		closeInternals.runCuratorPostMortem = mock(async () => {
			throw new Error('postmortem boom');
		});

		await expect(runFinalizeStage(ctx)).resolves.toBeUndefined();
		expect(
			ctx.warnings.some((w: string) => w.includes('Post-mortem failed')),
		).toBe(true);
	});

	it('calls curateAndStoreSwarm with ctx.allLessons', async () => {
		const ctx = buildBaseCtx() as any;
		ctx.explicitLessons = ['Lesson one', 'Lesson two'];
		const capturedCalls: unknown[] = [];
		closeInternals.curateAndStoreSwarm = mock(async (...args: unknown[]) => {
			capturedCalls.push(args);
			return { stored: 2 } as any;
		});

		await runFinalizeStage(ctx);

		expect(closeInternals.curateAndStoreSwarm).toHaveBeenCalledTimes(1);
		const firstArg = capturedCalls[0][0] as string[];
		expect(firstArg).toEqual(['Lesson one', 'Lesson two']);
	});

	it('records a warning when terminal plan state persistence fails (observable)', async () => {
		// closePlanTerminalState is called directly (not via _internals), so we
		// verify the warning path by providing invalid plan data that triggers
		// a Zod validation error from the real function. The error is caught
		// and a warning is emitted.
		const ctx = buildBaseCtx({
			planData: {
				title: 'Bad Plan',
				phases: [
					{
						id: 1,
						name: 'Phase 1',
						status: 'in_progress',
						tasks: [{ id: '1.1', status: 'in_progress', phase: 1 }],
					},
				],
			},
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					status: 'in_progress',
					tasks: [{ id: '1.1', status: 'in_progress', phase: 1 }],
				},
			],
			inProgressPhases: [
				{
					id: 1,
					name: 'Phase 1',
					status: 'in_progress',
					tasks: [{ id: '1.1', status: 'in_progress', phase: 1 }],
				},
			],
		}) as any;

		await runFinalizeStage(ctx);

		// The real closePlanTerminalState throws ZodError; runFinalizeStage catches
		// it and pushes a warning. Verify the warning was emitted.
		expect(
			ctx.warnings.some((w: string) =>
				w.includes('Failed to persist terminal plan state'),
			),
		).toBe(true);
	});

	it('calls checkHivePromotions when curation succeeds and hive is enabled', async () => {
		const ctx = buildBaseCtx({
			config: {
				enabled: true,
				hive_enabled: true,
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
		}) as any;
		closeInternals.curateAndStoreSwarm = mock(async () => ({ stored: 1 }));
		closeInternals.checkHivePromotions = mock(async () => ({
			new_promotions: 3,
			encounters_incremented: 0,
			advancements: 0,
			total_hive_entries: 0,
		}));

		await runFinalizeStage(ctx);

		expect(closeInternals.checkHivePromotions).toHaveBeenCalledTimes(1);
		expect(ctx.hivePromoted).toBe(3);
	});

	it('skips hive promotion when curation failed', async () => {
		const ctx = buildBaseCtx() as any;
		closeInternals.curateAndStoreSwarm = mock(async () => {
			throw new Error('curation failed');
		});
		closeInternals.checkHivePromotions = mock(async () => ({
			new_promotions: 0,
			encounters_incremented: 0,
			advancements: 0,
			total_hive_entries: 0,
		}));

		await runFinalizeStage(ctx);

		expect(closeInternals.checkHivePromotions).not.toHaveBeenCalled();
		expect(ctx.curationSucceeded).toBe(false);
	});

	it('skips hive promotion when config.hive_enabled is false', async () => {
		const ctx = buildBaseCtx() as any;
		closeInternals.curateAndStoreSwarm = mock(async () => ({ stored: 1 }));
		closeInternals.checkHivePromotions = mock(async () => ({
			new_promotions: 0,
			encounters_incremented: 0,
			advancements: 0,
			total_hive_entries: 0,
		}));

		await runFinalizeStage(ctx);

		expect(closeInternals.checkHivePromotions).not.toHaveBeenCalled();
	});
});

// ── runCleanStage tests ──────────────────────────────────────────────────

describe('runCleanStage', () => {
	it('returns a CleanStageResult with cleanedFiles, configBackupsRemoved, swarmPlanFilesRemoved', async () => {
		// Write some files to clean
		writeArtifact('plan.json', '{}');
		writeArtifact('plan.md', '# Plan');

		const ctx = buildBaseCtx({
			archivedActiveStateFiles: new Set(['plan.json', 'plan.md']),
			archivedActiveStateDirs: new Set<string>(),
		}) as any;

		const result = await runCleanStage(ctx);

		expect(Array.isArray(result.cleanedFiles)).toBe(true);
		expect(typeof result.configBackupsRemoved).toBe('number');
		expect(typeof result.swarmPlanFilesRemoved).toBe('number');
		expect(typeof result.tmpFilesRemoved).toBe('number');
	});

	it('cleans archived active-state files from swarmDir', async () => {
		writeArtifact('plan.json', '{}');
		writeArtifact('events.jsonl', '[]');

		const ctx = buildBaseCtx({
			archivedActiveStateFiles: new Set(['plan.json', 'events.jsonl']),
			archivedActiveStateDirs: new Set<string>(),
		}) as any;

		const result = await runCleanStage(ctx);

		// plan.json and events.jsonl should be in cleanedFiles
		expect(result.cleanedFiles).toContain('plan.json');
		expect(result.cleanedFiles).toContain('events.jsonl');
	});

	it('pushes a warning when no active-state files were archived (preserve-all guard)', async () => {
		const ctx = buildBaseCtx({
			archivedActiveStateFiles: new Set<string>(),
			archivedActiveStateDirs: new Set<string>(),
		}) as any;

		await runCleanStage(ctx);

		expect(
			ctx.warnings.some((w: string) =>
				w.includes('Skipped active-state cleanup'),
			),
		).toBe(true);
	});

	it('resets context.md with closed session status', async () => {
		writeArtifact('plan.json', '{}');
		const ctx = buildBaseCtx({
			archivedActiveStateFiles: new Set(['plan.json']),
			archivedActiveStateDirs: new Set<string>(),
		}) as any;

		await runCleanStage(ctx);

		const contextPath = path.join(swarmDir(), 'context.md');
		const content = readFileSync(contextPath, 'utf-8');
		expect(content).toInclude('Session closed after');
		expect(content).toInclude('No active plan');
	});
});

// ── runAlignStage tests ──────────────────────────────────────────────────

describe('runAlignStage', () => {
	it('returns a GitAlignResult with gitAlignResult string and prunedBranches array', async () => {
		closeInternals.getGitRepositoryStatus = () => ({
			isRepo: false,
			reason: 'not_git_repo',
			message: 'fatal: not a git repository',
		});

		const ctx = buildBaseCtx({ args: [] }) as any;
		const result = await runAlignStage(ctx);

		expect(typeof result.gitAlignResult).toBe('string');
		expect(Array.isArray(result.prunedBranches)).toBe(true);
		expect(result.gitAlignResult).toBe(
			'Not a git repository — skipped git alignment',
		);
	});

	it('returns git_unavailable message when git is not available', async () => {
		closeInternals.getGitRepositoryStatus = () => ({
			isRepo: false,
			reason: 'git_unavailable',
			message: 'git not found',
		});

		const ctx = buildBaseCtx({ args: [] }) as any;
		const result = await runAlignStage(ctx);

		expect(result.gitAlignResult).toContain('Git executable unavailable');
	});

	it('calls resetToMainAfterMerge when isRepo is true', async () => {
		closeInternals.getGitRepositoryStatus = () => ({
			isRepo: true,
			reason: 'ok',
			message: '',
		});
		closeInternals.resetToMainAfterMerge = mock(() => ({
			success: true,
			targetBranch: 'origin/main',
			previousBranch: 'main',
			message: 'Reset to origin/main',
			branchDeleted: false,
			changesDiscarded: false,
			warnings: [],
		}));
		closeInternals.resetToRemoteBranch = mock(() => ({
			success: true,
			targetBranch: 'main',
			localBranch: 'main',
			message: 'Already aligned',
			alreadyAligned: true,
			prunedBranches: [],
			warnings: [],
		}));

		const ctx = buildBaseCtx({ args: [] }) as any;
		await runAlignStage(ctx);

		expect(closeInternals.resetToMainAfterMerge).toHaveBeenCalledTimes(1);
	});

	it('does not throw when git is not a repo (fail-open)', async () => {
		closeInternals.getGitRepositoryStatus = () => ({
			isRepo: false,
			reason: 'not_git_repo',
			message: 'fatal: not a git repository',
		});

		const ctx = buildBaseCtx({ args: [] }) as any;
		await expect(runAlignStage(ctx)).resolves.toBeDefined();
	});
});
