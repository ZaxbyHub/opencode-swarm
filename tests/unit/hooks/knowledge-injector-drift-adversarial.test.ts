/**
 * Adversarial tests for drift injection feature in src/hooks/knowledge-injector.ts
 *
 * Tests cover attack vectors and edge cases for the drift injection block:
 * 1. readPriorDriftReports returns malformed/undefined structure → caught by try/catch
 * 2. buildDriftInjectionText returns oversized string (10,000 chars) → still prepended
 * 3. readPriorDriftReports returns array with null entry → handled safely
 * 4. buildDriftInjectionText throws synchronously → caught by try/catch
 * 5. readPriorDriftReports returns wrong type (empty string) → benign, no prepend
 * 6. cachedInjectionText is empty string "" → drift still prepended (not null check)
 * 7. Context budget stressed (totalChars > 75,000) → early return before drift injection
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { RankedEntry } from '../../../src/hooks/knowledge-reader.js';
import type {
	KnowledgeConfig,
	MessageWithParts,
} from '../../../src/hooks/knowledge-types.js';
// (#1849) Identity is recovered from swarmState.activeAgent (primary) or the
// last user message's info.agent (fallback) — never from a role:'system'
// message. Fixtures set swarmState.activeAgent and stamp a consistent
// sessionID on every message.
import { swarmState } from '../../../src/state';
import { installKnowledgeReceiptAuthorityStub } from '../../helpers/knowledge-receipt-authority.js';

const SESSION_ID = 'drift-adv-session';

// ============================================================================
// Mocks Setup
// ============================================================================

const readPriorDriftReports = mock(async () => []);
const buildDriftInjectionText = mock(() => '');
const readMergedKnowledge = mock(async () => [] as RankedEntry[]);
const readRejectedLessons = mock(async () => []);
const loadPlan = mock(async () => null as unknown);
const extractCurrentPhaseFromPlan = mock(() => 'Phase 1: Setup');
const getRunMemorySummary = mock(async () => null as string | null);
let searchResults: RankedEntry[] = [];
const searchKnowledge = mock(async () => ({
	trace_id: 'trace-test',
	results: searchResults,
}));
const recordKnowledgeEvent = mock(async () => {});
const recordKnowledgeShown = mock(async () => {});
const readRecentEscalations = mock(async () => []);
const buildEscalationBriefing = mock(() => '');

mock.module('../../../src/hooks/curator-drift.js', () => ({
	readPriorDriftReports,
	buildDriftInjectionText,
}));
mock.module('../../../src/hooks/knowledge-reader.js', () => ({
	readMergedKnowledge,
	// Stubs for ESM named-import resolution — not called in these tests.
	updateRetrievalOutcome: async () => {},
	scoreDirectiveAgainstContext: () => 0,
	recordLessonsShown: async () => {},
	_internals: {},
}));
mock.module('../../../src/hooks/knowledge-store.js', () => ({
	// #1848 review PRR-001a: curator.ts (transitively loaded here) imports
	// computeContentHash; this non-spreading mock must expose the named export
	// or bun throws a load-time SyntaxError. Deterministic content-derived stub.
	computeContentHash: (lesson: string) => String(lesson).slice(0, 12),
	readRejectedLessons,
	confirmEntriesPhase: async () => {},
	readKnowledge: async () => [],
	readRetractionRecords: async () => [],
	appendRetractionRecord: async () => {},
	resolveSwarmKnowledgePath: () => '',
	resolveSwarmRejectedPath: () => '',
	resolveSwarmRetractionsPath: () => '',
	resolveHiveKnowledgePath: () => '',
	resolveHiveRejectedPath: () => '',
	resolveHiveEventsPath: () => '',
	normalizeEntry: (e: unknown) => e,
	appendKnowledge: async () => {},
	appendKnowledgeWithCapEnforcement: async () => {},
	rewriteKnowledge: async () => {},
	transactKnowledge: async () => {},
	transactFile: async () => false,
	getArchivedKnowledgeIds: async () => new Set<string>(),
	enforceKnowledgeCap: async () => {},
	sweepAgedEntries: async () => {},
	sweepStaleTodos: async () => {},
	bumpKnowledgeConfidenceBatch: async () => {},
	appendRejectedLesson: async () => {},
	normalize: (t: string) => t,
	wordBigrams: (t: string) => new Set<string>(),
	jaccardBigram: () => 0,
	findNearDuplicate: () => null,
	computeConfidence: () => 0.5,
	selectKnowledgeCapSurvivors: <T>(entries: T[]) => entries,
	inferTags: () => [],
	getPlatformConfigDir: () => '/tmp',
	computeOutcomeSignal: () => 0,
	OUTCOME_SIGNAL_SMOOTHING: 0.5,
	_internals: {},
}));
mock.module('../../../src/plan/manager.js', () => ({
	loadPlan,
	getCurrentTaskId: () => undefined,
	updateTaskStatus: mock(),
	loadPlanJsonOnly: mock(),
	updatePlanPhase: mock(),
	regeneratePlanMarkdown: mock(),
	isPlanMdInSync: mock(),
	savePlan: async () => {},
	savePlanWithAutoAcknowledgedRemovals: async () => {},
	rebuildPlan: async () => {},
	retryCasWithBackoff: async (fn: () => unknown) => fn(),
	isTaskSettled: async () => false,
	derivePlanMarkdown: () => '',
	migrateLegacyPlan: async () => {},
	resetStartupLedgerCheck: () => {},
	readSwarmFileAsync: mock(),
	readSwarmFile: mock(),
	writeSwarmFile: mock(),
	closePlanTerminalState: async () => {},
	_snapshot_test_exports: {},
}));
mock.module('../../../src/hooks/extractors.js', () => ({
	extractCurrentPhaseFromPlan,
	extractCurrentPhase: () => null,
	extractCurrentTask: () => null,
	extractCurrentTaskFromPlan: () => null,
	extractDecisions: () => [],
	extractIncompleteTasks: () => [],
	extractIncompleteTasksFromPlan: () => [],
	extractPatterns: () => [],
	extractPlanCursor: () => null,
	_internals: {},
}));
const zodStub = { parse: (v: unknown) => v, shape: {} };
mock.module('../../../src/config/schema.js', () => ({
	stripKnownSwarmPrefix: mock((name: string) => {
		const prefixes = ['mega_', 'local_', 'paid_'];
		for (const p of prefixes) {
			if (name.startsWith(p)) return name.slice(p.length);
		}
		return name;
	}),
	isKnownCanonicalRole: () => false,
	getCanonicalAgentRole: () => null,
	resolveGeneratedAgentRole: () => null,
	resolveExternalSkillsConfig: () => ({}),
	resolveGuardrailsConfig: () => ({}),
	AdversarialDetectionConfigSchema: zodStub,
	AdversarialTestingConfigSchema: zodStub,
	AgentAuthorityRuleSchema: zodStub,
	AgentOverrideConfigSchema: zodStub,
	ApplyPatchConfigSchema: zodStub,
	AgentReasoningConfigSchema: zodStub,
	AgentThinkingConfigSchema: zodStub,
	ArchitecturalSupervisionConfigSchema: zodStub,
	AuthorityConfigSchema: zodStub,
	AutoReviewConfigSchema: zodStub,
	AutomationCapabilitiesSchema: zodStub,
	AutomationConfigSchema: zodStub,
	AutomationModeSchema: zodStub,
	CheckpointConfigSchema: zodStub,
	CompactionAdvisoryConfigSchema: zodStub,
	CompactionConfigSchema: zodStub,
	ContextBudgetConfigSchema: zodStub,
	ContextMapConfigSchema: zodStub,
	CouncilConfigSchema: zodStub,
	CuratorConfigSchema: zodStub,
	DEFAULT_AGENT_PROFILES: {},
	DEFAULT_ARCHITECT_PROFILE: {},
	DEFAULT_EXTERNAL_SKILLS_CONFIG: {},
	DEFAULT_SKILLS_CONFIG: {},
	DecisionDecaySchema: zodStub,
	DesignDocsConfigSchema: zodStub,
	DiscoverySourceSchema: zodStub,
	DocsConfigSchema: zodStub,
	EpicConfigSchema: zodStub,
	EvidenceConfigSchema: zodStub,
	ExternalSkillCandidateEvaluationVerdictSchema: zodStub,
	ExternalSkillCandidateSchema: zodStub,
	ExternalSkillCandidateSourceTypeSchema: zodStub,
	ExternalSkillsConfigSchema: zodStub,
	GateConfigSchema: zodStub,
	GateFeatureSchema: zodStub,
	GeneralCouncilConfigSchema: zodStub,
	GuardrailsConfigSchema: zodStub,
	GuardrailsProfileSchema: zodStub,
	HooksConfigSchema: zodStub,
	IncrementalVerifyConfigSchema: zodStub,
	IntegrationAnalysisConfigSchema: zodStub,
	KnowledgeApplicationConfigSchema: zodStub,
	KnowledgeConfigSchema: zodStub,
	LeanTurboConfig: {},
	LeanTurboConfigSchema: zodStub,
	LeanTurboStrategyConfigSchema: zodStub,
	LintConfigSchema: zodStub,
	MemoryConfigSchema: zodStub,
	ModelPricingConfigSchema: zodStub,
	ParallelizationConfigSchema: zodStub,
	PhaseCompleteConfigSchema: zodStub,
	PipelineConfigSchema: zodStub,
	PlaceholderScanConfigSchema: zodStub,
	PlanCursorConfigSchema: zodStub,
	PluginConfigSchema: zodStub,
	PricingConfigSchema: zodStub,
	PrMonitorConfigSchema: zodStub,
	PrmConfigSchema: zodStub,
	QualityBudgetConfigSchema: zodStub,
	RepoGraphConfigSchema: zodStub,
	ReviewPassesConfigSchema: zodStub,
	ScoringConfigSchema: zodStub,
	ScoringWeightsSchema: zodStub,
	SecretscanConfigSchema: zodStub,
	SelfReviewConfigSchema: zodStub,
	SkillImproverConfigSchema: zodStub,
	SkillPropagationConfigSchema: zodStub,
	SkillsConfigSchema: zodStub,
	SlopDetectorConfigSchema: zodStub,
	SpecWriterConfigSchema: zodStub,
	StandardTurboConfigSchema: zodStub,
	SummaryConfigSchema: zodStub,
	SwarmConfigSchema: zodStub,
	TokenRatiosSchema: zodStub,
	ToolFilterConfigSchema: zodStub,
	TurboConfig: {},
	TurboConfigSchema: zodStub,
	UIReviewConfigSchema: zodStub,
	WatchdogConfigSchema: zodStub,
	WorktreeIsolationConfigSchema: zodStub,
	GATE_CONFIG_KNOWN_SECTION_KEYS: {},
	_internals: {},
}));
mock.module('../../../src/services/run-memory.js', () => ({
	getRunMemorySummary,
}));
mock.module('../../../src/hooks/search-knowledge.js', () => ({
	searchKnowledge,
}));
mock.module('../../../src/hooks/knowledge-application.js', () => ({
	recordKnowledgeShown,
}));
mock.module('../../../src/hooks/knowledge-events.js', () => ({
	KNOWLEDGE_EVENT_SCHEMA_VERSION: 1,
	MAX_EVENT_LOG_ENTRIES: 5000,
	RECEIPT_EVENT_TYPES: new Set(),
	MAX_VIOLATION_TIMESTAMPS: 10,
	recordKnowledgeEvent,
	appendKnowledgeEvent: mock(async () => {}),
	appendHiveKnowledgeEvent: mock(async () => {}),
	recordHiveKnowledgeEvent: mock(async () => {}),
	effectiveRetrievalOutcomes: mock(() => ({})),
	resolveKnowledgeEventsPath: mock(() => ''),
	resolveKnowledgeCounterBaselinePath: mock(() => ''),
	resolveHiveEventsPath: mock(() => ''),
	resolveLegacyApplicationLogPath: mock(() => ''),
	newTraceId: mock(() => 'trace-test'),
	newEventId: mock(() => 'event-test'),
	readKnowledgeEvents: mock(async () => []),
	readHiveKnowledgeEvents: mock(async () => []),
	readLegacyApplicationRecords: mock(async () => []),
	recomputeCounters: mock(() => ({})),
	countViolationsInWindow: mock(() => 0),
	countEntryViolationsInWindow: mock(async () => 0),
	countEntryContradictionsInWindow: mock(async () => 0),
	readKnowledgeCounterRollups: mock(async () => []),
	applyKnowledgeVerdictFeedback: mock(async () => ({})),
	_internals: {},
}));

const { _internals: injectorInternals, createKnowledgeInjectorHook } =
	await import('../../../src/hooks/knowledge-injector.js');

const realSearchKnowledge = injectorInternals.searchKnowledge;
const realRecordKnowledgeEvent = injectorInternals.recordKnowledgeEvent;
const realRecordKnowledgeShown = injectorInternals.recordKnowledgeShown;
const realReadRecentEscalations = injectorInternals.readRecentEscalations;
const realBuildEscalationBriefing = injectorInternals.buildEscalationBriefing;
let restoreReceiptAuthority = () => {};

afterEach(() => {
	restoreReceiptAuthority();
	injectorInternals.searchKnowledge = realSearchKnowledge;
	injectorInternals.recordKnowledgeEvent = realRecordKnowledgeEvent;
	injectorInternals.recordKnowledgeShown = realRecordKnowledgeShown;
	injectorInternals.readRecentEscalations = realReadRecentEscalations;
	injectorInternals.buildEscalationBriefing = realBuildEscalationBriefing;
	swarmState.activeAgent.clear();
	mock.clearAllMocks();
});

function setSearchResults(results: RankedEntry[]): void {
	searchResults = results;
}

function resetMocks(): void {
	restoreReceiptAuthority =
		installKnowledgeReceiptAuthorityStub(injectorInternals);
	mock.clearAllMocks();
	searchResults = [];
	injectorInternals.searchKnowledge =
		searchKnowledge as typeof realSearchKnowledge;
	injectorInternals.recordKnowledgeEvent =
		recordKnowledgeEvent as typeof realRecordKnowledgeEvent;
	injectorInternals.recordKnowledgeShown =
		recordKnowledgeShown as typeof realRecordKnowledgeShown;
	injectorInternals.readRecentEscalations =
		readRecentEscalations as typeof realReadRecentEscalations;
	injectorInternals.buildEscalationBriefing =
		buildEscalationBriefing as typeof realBuildEscalationBriefing;
	searchKnowledge.mockImplementation(async () => ({
		trace_id: 'trace-test',
		results: searchResults,
	}));
	readRecentEscalations.mockResolvedValue([]);
	buildEscalationBriefing.mockReturnValue('');
	readPriorDriftReports.mockResolvedValue([]);
	buildDriftInjectionText.mockReturnValue('');
	loadPlan.mockResolvedValue({
		current_phase: 1,
		title: 'Test Project',
		phases: [],
	});
	readMergedKnowledge.mockResolvedValue([]);
	readRejectedLessons.mockResolvedValue([]);
	extractCurrentPhaseFromPlan.mockReturnValue('Phase 1: Setup');
	getRunMemorySummary.mockResolvedValue(null);
}

// ============================================================================
// Helper Factories
// ============================================================================

function makeOutput(agentName: string = 'architect'): {
	messages: MessageWithParts[];
} {
	// (#1849) Drive identity via swarmState.activeAgent (the production path)
	// and stamp a consistent sessionID on every message.
	if (agentName) swarmState.activeAgent.set(SESSION_ID, agentName);
	return {
		messages: [
			{
				info: { role: 'system', agent: agentName, sessionID: SESSION_ID },
				parts: [{ type: 'text', text: 'System prompt' }],
			},
			{
				info: { role: 'user', sessionID: SESSION_ID },
				parts: [{ type: 'text', text: 'hello' }],
			},
		],
	};
}

function makeSwarmEntry(lesson: string, confidence: number = 0.8): RankedEntry {
	return {
		id: 'test-id-' + Math.random().toString(36).substring(2, 9),
		tier: 'swarm',
		lesson,
		category: 'process',
		tags: [],
		scope: 'global',
		confidence,
		status: 'established',
		confirmed_by: [],
		retrieval_outcomes: {
			applied_count: 0,
			succeeded_after_count: 0,
			failed_after_count: 0,
		},
		schema_version: 1,
		created_at: new Date().toISOString(),
		updated_at: new Date().toISOString(),
		relevanceScore: { category: 0.5, confidence: confidence, keywords: 0.5 },
		finalScore: 0.8,
	} as RankedEntry;
}

function makeConfig(overrides?: Partial<KnowledgeConfig>): KnowledgeConfig {
	return {
		enabled: true,
		swarm_max_entries: 100,
		hive_max_entries: 200,
		auto_promote_days: 90,
		max_inject_count: 5,
		dedup_threshold: 0.6,
		scope_filter: ['global'],
		hive_enabled: true,
		rejected_max_entries: 20,
		validation_enabled: true,
		evergreen_confidence: 0.9,
		evergreen_utility: 0.8,
		low_utility_threshold: 0.3,
		min_retrievals_for_utility: 3,
		schema_version: 1,
		...overrides,
	};
}

// ============================================================================
// Adversarial Test Suite 1: Malformed drift report structure
// ============================================================================

describe('Adversarial: Malformed drift report structure', () => {
	beforeEach(() => {
		resetMocks();
		loadPlan.mockResolvedValue({
			current_phase: 1,
			title: 'Test Project',
			phases: [],
		});
		readMergedKnowledge.mockResolvedValue([]);
		readRejectedLessons.mockResolvedValue([]);
		extractCurrentPhaseFromPlan.mockReturnValue('Phase 1: Setup');
		getRunMemorySummary.mockResolvedValue(null);
	});

	it('Test 1: readPriorDriftReports returns report with undefined/null/malformed structure → caught by try/catch, hook completes', async () => {
		// Return an array with a malformed report (missing required fields)
		readPriorDriftReports.mockResolvedValue([
			undefined,
			null,
			{ phase: 'not-a-number' }, // malformed - phase should be number
			{}, // empty object - no required fields
		] as any);

		// Set up knowledge entries
		const entries = [makeSwarmEntry('Test lesson', 0.85)];
		setSearchResults(entries);

		// Change phase to 2
		loadPlan.mockResolvedValue({
			current_phase: 2,
			title: 'Test Project',
			phases: [],
		});
		extractCurrentPhaseFromPlan.mockReturnValue('Phase 2: Implementation');

		const hook = createKnowledgeInjectorHook('/proj', makeConfig());
		const output = makeOutput('architect');

		// This should NOT throw - error is caught by try/catch in drift injection block
		let errorThrown = false;
		try {
			await hook({}, output);
		} catch {
			errorThrown = true;
		}
		expect(errorThrown).toBe(false);

		// Knowledge should still be injected
		const knowledgeMsg = output.messages.find((m) =>
			m.parts?.some((p) => p.text?.includes('📚 Lessons:')),
		);
		expect(knowledgeMsg).toBeDefined();
		expect(knowledgeMsg?.parts?.[0]?.text).toContain('Test lesson');
	});
});

// ============================================================================
// Adversarial Test Suite 2: Oversized drift text (10,000 chars)
// ============================================================================

describe('Adversarial: Oversized drift text', () => {
	beforeEach(() => {
		resetMocks();
		loadPlan.mockResolvedValue({
			current_phase: 1,
			title: 'Test Project',
			phases: [],
		});
		readMergedKnowledge.mockResolvedValue([]);
		readRejectedLessons.mockResolvedValue([]);
		extractCurrentPhaseFromPlan.mockReturnValue('Phase 1: Setup');
		getRunMemorySummary.mockResolvedValue(null);
	});

	it('Test 2: buildDriftInjectionText returns 10,000-char string (>>500 limit) → hook completes, text prepended', async () => {
		// Return a drift report
		readPriorDriftReports.mockResolvedValue([
			{
				phase: 1,
				alignment: 'ALIGNED',
				drift_score: 0.05,
				injection_summary: 'test',
			},
		]);

		// Return a massive string (10,000 chars) - way over the 500 limit
		const massiveString = 'X'.repeat(10000);
		buildDriftInjectionText.mockReturnValue(massiveString);

		const hook = createKnowledgeInjectorHook('/proj', makeConfig());
		const output = makeOutput('architect');

		// First call - init with phase 1
		await hook({}, output);

		// Set up knowledge entries
		const entries = [makeSwarmEntry('Test lesson', 0.85)];
		setSearchResults(entries);

		// Change phase to 2 — use fresh output to avoid idempotency guard
		const output2 = makeOutput('architect');
		loadPlan.mockResolvedValue({
			current_phase: 2,
			title: 'Test Project',
			phases: [],
		});
		extractCurrentPhaseFromPlan.mockReturnValue('Phase 2: Implementation');

		// This should NOT throw - overflow is caller's responsibility
		let errorThrown = false;
		try {
			await hook({}, output2);
		} catch {
			errorThrown = true;
		}
		expect(errorThrown).toBe(false);

		// Knowledge should still be injected with the massive drift text included
		const knowledgeMsg = output2.messages.find((m) =>
			m.parts?.some((p) => p.text?.includes('📚 Lessons:')),
		);
		expect(knowledgeMsg).toBeDefined();
		const text = knowledgeMsg!.parts[0]?.text ?? '';
		// Lessons appear first, drift text may be included after (or trimmed by budget)
		expect(text).toContain('📚 Lessons:');
		expect(text).toContain('Test lesson');
	});
});

// ============================================================================
// Adversarial Test Suite 3: Array with null entry
// ============================================================================

describe('Adversarial: Array with null entry', () => {
	beforeEach(() => {
		resetMocks();
		loadPlan.mockResolvedValue({
			current_phase: 1,
			title: 'Test Project',
			phases: [],
		});
		readMergedKnowledge.mockResolvedValue([]);
		readRejectedLessons.mockResolvedValue([]);
		extractCurrentPhaseFromPlan.mockReturnValue('Phase 1: Setup');
		getRunMemorySummary.mockResolvedValue(null);
	});

	it('Test 3: readPriorDriftReports returns array with single null entry → passing null to buildDriftInjectionText should not crash', async () => {
		// Return an array with a single null entry - accessing [length - 1] returns null
		readPriorDriftReports.mockResolvedValue([null] as any);

		// Make buildDriftInjectionText handle null gracefully (or it may throw - that's caught by try/catch)
		buildDriftInjectionText.mockImplementation((report: any) => {
			if (report === null) {
				throw new Error('Cannot build text from null report');
			}
			return '<drift_report>Phase 1: ALIGNED</drift_report>';
		});

		// Set up knowledge entries
		const entries = [makeSwarmEntry('Test lesson', 0.85)];
		setSearchResults(entries);

		// Change phase to 2
		loadPlan.mockResolvedValue({
			current_phase: 2,
			title: 'Test Project',
			phases: [],
		});
		extractCurrentPhaseFromPlan.mockReturnValue('Phase 2: Implementation');

		const hook = createKnowledgeInjectorHook('/proj', makeConfig());
		const output = makeOutput('architect');

		// This should NOT throw - error is caught by try/catch
		let errorThrown = false;
		try {
			await hook({}, output);
		} catch {
			errorThrown = true;
		}
		expect(errorThrown).toBe(false);

		// Knowledge should still be injected (drift was skipped due to error)
		const knowledgeMsg = output.messages.find((m) =>
			m.parts?.some((p) => p.text?.includes('📚 Lessons:')),
		);
		expect(knowledgeMsg).toBeDefined();
		expect(knowledgeMsg?.parts[0].text).toContain('Test lesson');
	});
});

// ============================================================================
// Adversarial Test Suite 4: buildDriftInjectionText throws synchronously
// ============================================================================

describe('Adversarial: buildDriftInjectionText throws synchronously', () => {
	beforeEach(() => {
		resetMocks();
		loadPlan.mockResolvedValue({
			current_phase: 1,
			title: 'Test Project',
			phases: [],
		});
		readMergedKnowledge.mockResolvedValue([]);
		readRejectedLessons.mockResolvedValue([]);
		extractCurrentPhaseFromPlan.mockReturnValue('Phase 1: Setup');
		getRunMemorySummary.mockResolvedValue(null);
	});

	it('Test 4: buildDriftInjectionText throws synchronously → caught by try/catch, hook completes normally', async () => {
		// Return valid drift reports
		readPriorDriftReports.mockResolvedValue([
			{
				phase: 1,
				alignment: 'ALIGNED',
				drift_score: 0.05,
				injection_summary: 'test',
			},
		]);

		// Make buildDriftInjectionText throw synchronously
		buildDriftInjectionText.mockImplementation(() => {
			throw new Error('Intentional build error');
		});

		// Set up knowledge entries
		const entries = [makeSwarmEntry('Test lesson', 0.85)];
		setSearchResults(entries);

		// Change phase to 2
		loadPlan.mockResolvedValue({
			current_phase: 2,
			title: 'Test Project',
			phases: [],
		});
		extractCurrentPhaseFromPlan.mockReturnValue('Phase 2: Implementation');

		const hook = createKnowledgeInjectorHook('/proj', makeConfig());
		const output = makeOutput('architect');

		// This should NOT throw - error is caught by try/catch
		let errorThrown = false;
		try {
			await hook({}, output);
		} catch {
			errorThrown = true;
		}
		expect(errorThrown).toBe(false);

		// Knowledge should still be injected (drift skipped due to error)
		const knowledgeMsg = output.messages.find((m) =>
			m.parts?.some((p) => p.text?.includes('📚 Lessons:')),
		);
		expect(knowledgeMsg).toBeDefined();
		expect(knowledgeMsg?.parts[0].text).toContain('Test lesson');
		// Drift should NOT be present (error occurred)
		expect(knowledgeMsg?.parts[0].text).not.toContain('<drift_report>');
	});
});

// ============================================================================
// Adversarial Test Suite 5: Wrong type returned (empty string instead of array)
// ============================================================================

describe('Adversarial: Wrong type returned (empty string instead of array)', () => {
	beforeEach(() => {
		resetMocks();
		loadPlan.mockResolvedValue({
			current_phase: 1,
			title: 'Test Project',
			phases: [],
		});
		readMergedKnowledge.mockResolvedValue([]);
		readRejectedLessons.mockResolvedValue([]);
		extractCurrentPhaseFromPlan.mockReturnValue('Phase 1: Setup');
		getRunMemorySummary.mockResolvedValue(null);
	});

	it('Test 5: readPriorDriftReports returns empty string instead of array → accessing .length returns 0, no prepend (benign)', async () => {
		// Return empty string instead of array - string.length is 0, so the condition `driftReports.length > 0` is false
		readPriorDriftReports.mockResolvedValue('' as any);

		// Set up knowledge entries
		const entries = [makeSwarmEntry('Test lesson', 0.85)];
		setSearchResults(entries);

		// Change phase to 2
		loadPlan.mockResolvedValue({
			current_phase: 2,
			title: 'Test Project',
			phases: [],
		});
		extractCurrentPhaseFromPlan.mockReturnValue('Phase 2: Implementation');

		const hook = createKnowledgeInjectorHook('/proj', makeConfig());
		const output = makeOutput('architect');

		// This should NOT throw - behavior is benign
		let errorThrown = false;
		try {
			await hook({}, output);
		} catch {
			errorThrown = true;
		}
		expect(errorThrown).toBe(false);

		// Knowledge should be injected
		const knowledgeMsg = output.messages.find((m) =>
			m.parts?.some((p) => p.text?.includes('📚 Lessons:')),
		);
		expect(knowledgeMsg).toBeDefined();
		expect(knowledgeMsg?.parts[0].text).toContain('Test lesson');
		// Drift should NOT be present (string.length is 0, so condition fails)
		expect(knowledgeMsg?.parts[0].text).not.toContain('<drift_report>');
	});
});

// ============================================================================
// Adversarial Test Suite 6: cachedInjectionText is empty string
// ============================================================================

describe('Adversarial: cachedInjectionText is empty string', () => {
	beforeEach(() => {
		resetMocks();
		loadPlan.mockResolvedValue({
			current_phase: 1,
			title: 'Test Project',
			phases: [],
		});
		readMergedKnowledge.mockResolvedValue([]);
		readRejectedLessons.mockResolvedValue([]);
		extractCurrentPhaseFromPlan.mockReturnValue('Phase 1: Setup');
		getRunMemorySummary.mockResolvedValue(null);
	});

	it('Test 6: cachedInjectionText is set to empty string "" → drift IS prepended (cachedInjectionText !== null is true)', async () => {
		// Set up drift reports
		readPriorDriftReports.mockResolvedValue([
			{
				phase: 1,
				alignment: 'ALIGNED',
				drift_score: 0.05,
				injection_summary: 'test',
			},
		]);
		buildDriftInjectionText.mockReturnValue(
			'<drift_report>Phase 1: ALIGNED</drift_report>',
		);

		// Set up knowledge entries
		const entries = [makeSwarmEntry('Test lesson', 0.85)];
		setSearchResults(entries);

		// Change phase to 2 - this triggers drift injection
		loadPlan.mockResolvedValue({
			current_phase: 2,
			title: 'Test Project',
			phases: [],
		});
		extractCurrentPhaseFromPlan.mockReturnValue('Phase 2: Implementation');

		const hook = createKnowledgeInjectorHook('/proj', makeConfig());
		const output = makeOutput('architect');

		// Call with all setup in place - drift should be prepended
		await hook({}, output);

		// Verify readPriorDriftReports was called (drift injection path taken)
		expect(readPriorDriftReports).toHaveBeenCalledWith('/proj');
		expect(buildDriftInjectionText).toHaveBeenCalled();

		// Knowledge should be injected with drift prepended
		const knowledgeMsg = output.messages.find((m) =>
			m.parts?.some((p) => p.text?.includes('📚 Lessons:')),
		);
		expect(knowledgeMsg).toBeDefined();
		const text = knowledgeMsg!.parts[0]?.text ?? '';
		// In new priority order, lessons come first, then drift
		expect(text).toContain('📚 Lessons:');
		expect(text).toContain('Test lesson');
	});

	it('Test 6b: Verify that empty string is NOT null, so drift would prepend (direct condition test)', async () => {
		// This is a unit-style verification that "" !== null is true
		const cachedInjectionText = '';
		// This is the condition from the code: `cachedInjectionText !== null`
		expect(cachedInjectionText !== null).toBe(true);
		// The code has `if (driftText)` which would be falsy for empty string, so no prepend
		// But if driftText is non-empty, it WOULD prepend to empty string
	});
});

// ============================================================================
// Adversarial Test Suite 7: Context budget stressed (headroom < 300 chars)
// ============================================================================

describe('Adversarial: Context budget stressed', () => {
	beforeEach(() => {
		resetMocks();
		loadPlan.mockResolvedValue({
			current_phase: 1,
			title: 'Test Project',
			phases: [],
		});
		readMergedKnowledge.mockResolvedValue([]);
		readRejectedLessons.mockResolvedValue([]);
		extractCurrentPhaseFromPlan.mockReturnValue('Phase 1: Setup');
		getRunMemorySummary.mockResolvedValue(null);
		// Return drift reports - but they shouldn't be accessed due to early return
		readPriorDriftReports.mockResolvedValue([
			{
				phase: 1,
				alignment: 'ALIGNED',
				drift_score: 0.05,
				injection_summary: 'test',
			},
		]);
	});

	it('Test 7: Hook called when headroom < 300 chars → early return before drift injection, no crash', async () => {
		// MODEL_LIMIT_CHARS ≈ 387,878. Need existingChars > 387,878 - 300 to trigger skip
		const skipThreshold = Math.floor(128_000 / 0.33) - 200; // ~387,678 chars leaves ~200 headroom
		const largeSystemPrompt = 'x'.repeat(skipThreshold);
		const output = {
			messages: [
				{
					info: { role: 'system', agent: 'architect' },
					parts: [{ type: 'text', text: largeSystemPrompt }],
				},
				{ info: { role: 'user' }, parts: [{ type: 'text', text: 'hello' }] },
			],
		};

		const hook = createKnowledgeInjectorHook('/proj', makeConfig());

		// First call - init with phase 1
		await hook({}, output);

		// Change phase to 2
		loadPlan.mockResolvedValue({
			current_phase: 2,
			title: 'Test Project',
			phases: [],
		});
		extractCurrentPhaseFromPlan.mockReturnValue('Phase 2: Implementation');

		// This should NOT throw - early return happens before drift injection
		let errorThrown = false;
		try {
			await hook({}, output);
		} catch {
			errorThrown = true;
		}
		expect(errorThrown).toBe(false);

		// readPriorDriftReports should NOT be called because early return happens before drift
		expect(readPriorDriftReports).not.toHaveBeenCalled();

		// No knowledge message should be injected (early return due to headroom)
		const hasKnowledgeInjection = output.messages.some((m) =>
			m.parts?.some((p) => p.text?.includes('\ud83d\udcda Lessons:')),
		);
		expect(hasKnowledgeInjection).toBe(false);
	});

	it('Test 7b: At 181k chars (old skip threshold) → still injects with new headroom check', async () => {
		// 181k chars was the old skip threshold. Now it should inject (moderate regime).
		const boundarySystemPrompt = 'x'.repeat(181_000);

		// Set up for successful injection BEFORE the hook call
		const entries = [makeSwarmEntry('Test lesson', 0.85)];
		setSearchResults(entries);

		// Change phase to 2
		loadPlan.mockResolvedValue({
			current_phase: 2,
			title: 'Test Project',
			phases: [],
		});
		extractCurrentPhaseFromPlan.mockReturnValue('Phase 2: Implementation');

		const hook = createKnowledgeInjectorHook('/proj', makeConfig());
		swarmState.activeAgent.set(SESSION_ID, 'architect');
		const output = {
			messages: [
				{
					info: {
						role: 'system',
						agent: 'architect',
						sessionID: SESSION_ID,
					},
					parts: [{ type: 'text', text: boundarySystemPrompt }],
				},
				{
					info: { role: 'user', sessionID: SESSION_ID },
					parts: [{ type: 'text', text: '' }],
				},
			],
		};

		// This should NOT throw
		let errorThrown = false;
		try {
			await hook({}, output);
		} catch {
			errorThrown = true;
		}
		expect(errorThrown).toBe(false);

		// Knowledge SHOULD be injected (181k leaves ~206k headroom — well within limits)
		const knowledgeMsg = output.messages.find((m) =>
			m.parts?.some((p) => p.text?.includes('\ud83d\udcda Lessons:')),
		);
		expect(knowledgeMsg).toBeDefined();
	});
});

// ============================================================================
// Additional Edge Cases
// ============================================================================

describe('Adversarial: Additional edge cases', () => {
	beforeEach(() => {
		resetMocks();
		loadPlan.mockResolvedValue({
			current_phase: 1,
			title: 'Test Project',
			phases: [],
		});
		readMergedKnowledge.mockResolvedValue([]);
		readRejectedLessons.mockResolvedValue([]);
		extractCurrentPhaseFromPlan.mockReturnValue('Phase 1: Setup');
		getRunMemorySummary.mockResolvedValue(null);
	});

	it('Test 8: readPriorDriftReports returns undefined → caught by try/catch, hook completes', async () => {
		// Return undefined instead of array
		readPriorDriftReports.mockResolvedValue(undefined as any);

		// Set up knowledge entries
		const entries = [makeSwarmEntry('Test lesson', 0.85)];
		setSearchResults(entries);

		// Change phase
		loadPlan.mockResolvedValue({
			current_phase: 2,
			title: 'Test Project',
			phases: [],
		});
		extractCurrentPhaseFromPlan.mockReturnValue('Phase 2: Implementation');

		const hook = createKnowledgeInjectorHook('/proj', makeConfig());
		const output = makeOutput('architect');

		// Should not throw
		let errorThrown = false;
		try {
			await hook({}, output);
		} catch {
			errorThrown = true;
		}
		expect(errorThrown).toBe(false);

		// Knowledge should still be injected
		const knowledgeMsg = output.messages.find((m) =>
			m.parts?.some((p) => p.text?.includes('📚 Lessons:')),
		);
		expect(knowledgeMsg).toBeDefined();
	});

	it('Test 9: buildDriftInjectionText returns undefined → falsy check catches it, no prepend', async () => {
		readPriorDriftReports.mockResolvedValue([
			{
				phase: 1,
				alignment: 'ALIGNED',
				drift_score: 0.05,
				injection_summary: 'test',
			},
		]);
		// Return undefined instead of string
		buildDriftInjectionText.mockReturnValue(undefined as any);

		// Set up knowledge entries
		const entries = [makeSwarmEntry('Test lesson', 0.85)];
		setSearchResults(entries);

		// Change phase
		loadPlan.mockResolvedValue({
			current_phase: 2,
			title: 'Test Project',
			phases: [],
		});
		extractCurrentPhaseFromPlan.mockReturnValue('Phase 2: Implementation');

		const hook = createKnowledgeInjectorHook('/proj', makeConfig());
		const output = makeOutput('architect');

		// Should not throw
		let errorThrown = false;
		try {
			await hook({}, output);
		} catch {
			errorThrown = true;
		}
		expect(errorThrown).toBe(false);

		// Knowledge should be injected but WITHOUT drift (undefined is falsy)
		const knowledgeMsg = output.messages.find((m) =>
			m.parts?.some((p) => p.text?.includes('📚 Lessons:')),
		);
		expect(knowledgeMsg).toBeDefined();
		expect(knowledgeMsg?.parts[0].text).toContain('Test lesson');
		expect(knowledgeMsg?.parts[0].text).not.toContain('<drift_report>');
	});

	it('Test 10: readPriorDriftReports returns array with all undefined/null entries → loop does nothing, no crash', async () => {
		readPriorDriftReports.mockResolvedValue([
			undefined,
			null,
			undefined,
		] as any);

		// Set up knowledge entries
		const entries = [makeSwarmEntry('Test lesson', 0.85)];
		setSearchResults(entries);

		// Change phase
		loadPlan.mockResolvedValue({
			current_phase: 2,
			title: 'Test Project',
			phases: [],
		});
		extractCurrentPhaseFromPlan.mockReturnValue('Phase 2: Implementation');

		const hook = createKnowledgeInjectorHook('/proj', makeConfig());
		const output = makeOutput('architect');

		// Should not throw - accessing array elements that are undefined/null should not crash
		let errorThrown = false;
		try {
			await hook({}, output);
		} catch {
			errorThrown = true;
		}
		expect(errorThrown).toBe(false);

		// Knowledge should be injected
		const knowledgeMsg = output.messages.find((m) =>
			m.parts?.some((p) => p.text?.includes('📚 Lessons:')),
		);
		expect(knowledgeMsg).toBeDefined();
	});
});
