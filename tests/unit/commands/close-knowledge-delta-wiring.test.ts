/**
 * Tests for knowledge-delta wiring in runFinalizeStage.
 *
 * Proves that runFinalizeStage passes the correct lessonsStored,
 * knowledgeCreated, and dedupDropCount values into the
 * runAbortableReflection call (SessionReflectionInput).
 *
 * Split from close-stage-extract.test.ts to stay under the FR-006 500-line cap.
 *
 * Uses the _internals DI seam for runAbortableReflection and curateAndStoreSwarm.
 * No mock.module usage.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ── Import under test ─────────────────────────────────────────────────────
const { runFinalizeStage, _internals: closeInternals } = await import(
	'../../../src/commands/close.js'
);

// ── Drain-summary accumulator (module-level state — import once) ───────
const { stashDrainSummary, resetDrainCounters } = await import(
	'../../../src/learning/drain-summary-accumulator.js'
);

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
const realRunAbortableReflection = closeInternals.runAbortableReflection;

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
			title: 'Knowledge Delta Wiring Test Project',
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
		projectName: 'Knowledge Delta Wiring Test Project',
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
		title: 'Knowledge Delta Wiring Test Project',
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

beforeEach(() => {
	testDir = mkdtempSync(path.join(os.tmpdir(), 'close-kdelta-wiring-'));
	mkdirSync(swarmDir(), { recursive: true });
	writePlan();

	// Seed knowledge.jsonl with one existing lesson so dedup tests can be
	// falsifiable (matching retro lessons are dropped, producing dedupDropCount>0).
	const knowledgePath = path.join(swarmDir(), 'knowledge.jsonl');
	writeFileSync(
		knowledgePath,
		JSON.stringify({
			id: 'seed-existing-001',
			lesson: 'always validate inputs',
			category: 'architecture',
			status: 'established',
			confidence: 0.8,
			created_at: '2026-01-01T00:00:00.000Z',
		}) + '\n',
	);

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
	closeInternals.runAbortableReflection = mock(async () => ({
		timestamp: new Date().toISOString(),
		totalToolCalls: 0,
		totalToolFailures: 0,
		toolProblems: [],
		agentDispatches: [],
		gateFailures: [],
		lessonsFromRetros: [],
		errorTaxonomy: {},
		lessonsStored: 0,
		knowledgeCreated: 0,
		dedupDropCount: 0,
		summary: '',
	}));
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
	closeInternals.runAbortableReflection = realRunAbortableReflection;
});

// ── Knowledge-delta wiring tests ─────────────────────────────────────────

describe('runFinalizeStage knowledge-delta wiring', () => {
	it('wires knowledge-delta fields into session reflection input', async () => {
		const capturedInput: Array<Record<string, unknown>> = [];
		closeInternals.curateAndStoreSwarm = mock(async () => ({
			stored: 5,
			reinforced: 0,
			skipped: 0,
			rejected: 0,
			quarantined: 0,
		}));
		closeInternals.runAbortableReflection = mock(
			async (input: Record<string, unknown>) => {
				capturedInput.push(input);
				return {
					timestamp: new Date().toISOString(),
					totalToolCalls: 0,
					totalToolFailures: 0,
					toolProblems: [],
					agentDispatches: [],
					gateFailures: [],
					lessonsFromRetros: [],
					errorTaxonomy: {},
					lessonsStored: 0,
					knowledgeCreated: 0,
					dedupDropCount: 0,
					summary: '',
				};
			},
		);

		// Seed retroLessons with one lesson matching the knowledge.jsonl seed
		// ("always validate inputs") and one non-matching lesson so dedup is
		// falsifiable: computeDedupDropCount returns 1, not a trivial 0.
		const ctx = buildBaseCtx({
			retroLessons: ['always validate inputs', 'prefer early returns'],
		}) as any;

		await runFinalizeStage(ctx);

		expect(closeInternals.runAbortableReflection).toHaveBeenCalledTimes(1);
		const input = capturedInput[0];
		// lessonsStored comes from ctx.curationResult?.stored (the curation return)
		expect(input.lessonsStored).toBe(5);
		// knowledgeCreated falls back to curationResult.stored when readKnowledge
		// has no entries created after sessionStart (sessionStart is undefined
		// in this test, so it falls back to curationResult.stored).
		expect(input.knowledgeCreated).toBe(5);
		// dedupDropCount: "always validate inputs" exists in knowledge.jsonl (seeded
		// in beforeEach), so computeDedupDropCount drops 1 lesson. A broken dedup
		// wiring would return 0, making this assertion fail.
		expect(input.dedupDropCount).toBe(1);
	});

	it('wires drain counts (admitted/reinforced/rejected) into session reflection input', async () => {
		const sessionID = 'test-drain-session';

		// Stash a DrainSummary so the accumulator has nonzero counters.
		stashDrainSummary(sessionID, {
			attempted: 6,
			admitted: 3,
			reinforced: 2,
			rejected: 1,
			deferred: 0,
			failed: 0,
			retries: 0,
		});

		const capturedInput: Array<Record<string, unknown>> = [];
		closeInternals.runAbortableReflection = mock(
			async (input: Record<string, unknown>) => {
				capturedInput.push(input);
				return {
					timestamp: new Date().toISOString(),
					totalToolCalls: 0,
					totalToolFailures: 0,
					toolProblems: [],
					agentDispatches: [],
					gateFailures: [],
					lessonsFromRetros: [],
					errorTaxonomy: {},
					lessonsStored: 0,
					knowledgeCreated: 0,
					dedupDropCount: 0,
					summary: '',
				};
			},
		);

		const ctx = buildBaseCtx({
			options: { sessionID },
		}) as any;

		await runFinalizeStage(ctx);

		expect(closeInternals.runAbortableReflection).toHaveBeenCalledTimes(1);
		const input = capturedInput[0];

		// These assertions are falsifiable: if the getDrainCounters wiring at
		// close.ts L829-845 is removed, all three drain fields will be 0.
		expect(input.drainAdmitted).toBe(3);
		expect(input.drainReinforced).toBe(2);
		expect(input.drainRejected).toBe(1);

		// Cleanup: remove the session from the accumulator to avoid leaking
		// module-level state into other tests.
		resetDrainCounters(sessionID);
	});

	it('persists action menu via persistActionMenu when assembledMenu is non-empty', async () => {
		const sessionID = 'test-persist-session';
		const menuItems = [
			{
				number: 1,
				description: 'Review auth patterns',
				targetTool: 'sme',
				data: { category: 'security' },
			},
			{
				number: 2,
				description: 'Add integration test',
				targetTool: 'test_engineer',
				data: { file: 'src/auth.ts' },
			},
		];

		closeInternals.runAbortableReflection = mock(async () => ({
			data: {
				timestamp: new Date().toISOString(),
				totalToolCalls: 0,
				totalToolFailures: 0,
				toolProblems: [],
				agentDispatches: [],
				gateFailures: [],
				lessonsFromRetros: [],
				errorTaxonomy: {},
				lessonsStored: 0,
				knowledgeCreated: 0,
				dedupDropCount: 0,
				drainAdmitted: 0,
				drainReinforced: 0,
				drainRejected: 0,
				skillViolationSignals: [],
				nearDuplicateCandidates: [],
				draftedIssueCandidates: [],
				assembledMenu: menuItems,
			},
			architectReport: '',
			source: 'deterministic' as const,
		}));

		const ctx = buildBaseCtx({
			options: { sessionID },
		}) as any;

		await runFinalizeStage(ctx);

		const menuFilePath = path.join(
			swarmDir(),
			'memory',
			`action-menu-${sessionID}.json`,
		);
		expect(existsSync(menuFilePath)).toBe(true);

		const content = JSON.parse(readFileSync(menuFilePath, 'utf-8'));
		expect(content.sessionId).toBe(sessionID);
		expect(content.items).toHaveLength(2);
		expect(content.items[0].description).toBe('Review auth patterns');
		expect(content.items[1].description).toBe('Add integration test');
	});
});
